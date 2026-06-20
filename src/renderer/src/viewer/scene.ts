import * as THREE from 'three'
import { TrackballControls } from 'three/addons/controls/TrackballControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { OUTLINE_SHADER, AO_SHADER } from './postShaders'
import type { Structure } from '../core/types'
import { applyTransform, type Transform } from '../core/transform'
import { elementInfo } from '../core/elements'
import { type RenderOptions, type Representation, type ColorMode } from './renderOptions'
import {
  createImpostorSpheres,
  updateImpostorLighting,
  updateImpostorFinish,
  updateImpostorOrtho,
  updateImpostorFog
} from './impostorSpheres'

/**
 * The Three.js viewport core. Renders one or more systems at once (setScene),
 * supports CPU ray-sphere picking, highlight markers, and labels. Atoms are GPU
 * impostor spheres; bonds are instanced cylinders or lines. Color schemes,
 * hidden hydrogens, and restrict-to-selection are applied here.
 */

export interface Renderable {
  id: string
  structure: Structure
  /** Trajectory frame coordinates (numAtoms*3), or null for the base structure. */
  coords: Float32Array | null
  /** Selected atom indices (for restrict-to-selection). */
  selected?: Set<number>
  /** Rigid-body placement of this system in the scene. */
  transform?: Transform
  /** Per-atom representation overrides (atom index -> representation). */
  repByAtom?: Record<number, Representation>
  /** Per-atom color-mode overrides (atom index -> color mode). */
  colorByAtom?: Record<number, ColorMode>
  /**
   * Bond orders keyed by "a-b" (1-based atom indices, a < b). Only the molecule
   * builder sets this; when present, double/triple bonds render as parallel
   * cylinders. The extra cylinders are drawn but not tracked for in-place updates,
   * so a Renderable carrying bond orders must be redrawn via a full rebuild (the
   * builder always is) rather than the trajectory/transform update path.
   */
  bondOrders?: Record<string, number>
}

export interface ManipTarget {
  systemId: string
  mode: 'translate' | 'rotate'
}

export interface PickResult {
  systemId: string
  atomIndex: number // 0-based index into structure.atoms
  name: string
  element: string
  position: [number, number, number]
}

export interface HighlightItem {
  position: [number, number, number]
  label?: string
}

export interface SceneHandle {
  setScene(renderables: Renderable[], options: RenderOptions): void
  pick(clientX: number, clientY: number): PickResult | null
  setHighlights(items: HighlightItem[]): void
  /** Show a move/rotate gizmo on a system's group, or null to hide it. */
  setManipulation(
    target: ManipTarget | null,
    onChange: ((systemId: string, transform: Transform) => void) | null
  ): void
  /** Set the camera field of view (degrees), holding the subject's apparent size. */
  setFov(fov: number): void
  /** Set the viewport background color. */
  setBackground(color: number): void
  /** Render the background as a vertical gradient (vs flat). */
  setBackgroundGradient(on: boolean): void
  /** Set lighting contrast (0..1): directional-vs-ambient balance. */
  setContrast(contrast: number): void
  /** Set surface finish (0..1): matte → glossy. */
  setFinish(glossiness: number): void
  /** Toggle antialiasing (SMAA). */
  setAntialias(on: boolean): void
  /** Set selection-highlight color + atom-label color/size. */
  setHighlightStyle(color: number, labelColor: number, labelScale: number): void
  /** Set depth-cueing (fog) amount, 0..1 (0 = off). */
  setFog(amount: number): void
  /** Toggle orthographic projection. */
  setOrthographic(on: boolean): void
  /** Toggle the silhouette outline post-pass. */
  setOutline(on: boolean): void
  /** Toggle screen-space ambient occlusion. */
  setAmbientOcclusion(on: boolean): void
  /** Re-frame the camera to fit the current scene. */
  recenter(): void
  /** Update one system's coordinates in place (trajectory frame); no rebuild. */
  updateSystem(systemId: string, coords: Float32Array | null, transform?: Transform): void
  /** Enable/disable the camera trackball (e.g. while dragging atoms). */
  setControlsEnabled(enabled: boolean): void
  /**
   * World point where the ray through a screen pixel meets the camera-facing plane
   * through `anchor`. Used to drag atoms in the screen plane.
   */
  dragPlanePoint(clientX: number, clientY: number, anchor: [number, number, number]): [number, number, number]
  dispose(): void
}

type Vec3 = [number, number, number]

interface WorldBond {
  wa: Vec3
  wb: Vec3
  radius: number
  ca: number
  cb: number
}

// Per-system slot bookkeeping in the merged meshes, for in-place updates.
interface BuiltSystem {
  atomStart: number
  atomSlots: number[] // atom index per atom slot, in order
  cylStart: number // first cylinder bond (each is 2 instances)
  cylBonds: Array<{ a: number; b: number; radius: number }>
  lineStart: number // first line bond (each is 2 vertices)
  lineBonds: Array<{ a: number; b: number }>
}

interface RepSpec {
  atomRadius: (vdw: number) => number
  bond: 'cylinder' | 'line' | 'none'
  bondRadius: number
}

interface Pickable {
  systemId: string
  atomIndex: number
  name: string
  element: string
  // World-space center (transform applied) — used for ray testing.
  x: number
  y: number
  z: number
  // Base (untransformed) atom coords — returned to callers.
  bx: number
  by: number
  bz: number
  radius: number
}

function repSpec(rep: Representation): RepSpec {
  switch (rep) {
    case 'spacefill':
      return { atomRadius: (vdw) => vdw, bond: 'none', bondRadius: 0 }
    case 'sticks':
      // The cap sphere must be a touch larger than the bond cylinder. If they
      // were exactly equal their surfaces would be tangent along the whole
      // joint, and since the spheres are GPU impostors (writing gl_FragDepth)
      // while the bonds are real cylinder meshes, the depth buffer fights along
      // that ring — the moiré "wave" at the caps. A slightly larger sphere
      // subsumes the cylinder end and reads as a clean rounded joint.
      return { atomRadius: () => 0.2, bond: 'cylinder', bondRadius: 0.18 }
    case 'wireframe':
      // No atom spheres in wireframe — just the bond lines.
      return { atomRadius: () => 0, bond: 'line', bondRadius: 0 }
    case 'ball-and-stick':
    case 'tube': // tube falls back to ball-and-stick until the backbone tracer lands
    default:
      return { atomRadius: (vdw) => Math.max(vdw * 0.3, 0.25), bond: 'cylinder', bondRadius: 0.1 }
  }
}

// Per-atom rep spec. 'tube' is a whole-structure representation, so an atom
// tagged tube in a mixed scene falls back to ball-and-stick.
function atomRepSpec(rep: Representation): RepSpec {
  return repSpec(rep === 'tube' ? 'ball-and-stick' : rep)
}

// Distinct cycling palette for residue / chain coloring; stable per key.
const PALETTE = [
  0x4e79a7, 0xf28e2b, 0xe15759, 0x76b7b2, 0x59a14f, 0xedc948, 0xb07aa1, 0xff9da7,
  0x9c755f, 0xbab0ac, 0x86bcb6, 0xd37295, 0xfabfd2, 0xb6992d, 0x499894, 0xd7b5a6
]
const paletteCache = new Map<string, number>()
function paletteColor(key: string): number {
  let c = paletteCache.get(key)
  if (c === undefined) {
    c = PALETTE[paletteCache.size % PALETTE.length]
    paletteCache.set(key, c)
  }
  return c
}

type AtomRecord = Structure['atoms'][number]

function colorForAtom(a: AtomRecord, mode: ColorMode, options: RenderOptions): number {
  switch (mode) {
    case 'uniform':
      return options.uniformColor
    case 'residue':
      return a.residueSeq !== undefined
        ? paletteColor(`${a.chain ?? ''}:${a.residueSeq}`)
        : elementInfo(a.element).color
    case 'chain':
      return a.chain ? paletteColor(`chain:${a.chain}`) : elementInfo(a.element).color
    case 'charge':
      return a.charge !== undefined ? chargeColor(a.charge) : 0x808080
    default:
      return elementInfo(a.element).color
  }
}

// Per-atom color: the atom's color-mode override (if any) else the global mode.
function computeAtomColors(
  structure: Structure,
  options: RenderOptions,
  colorByAtom?: Record<number, ColorMode>
): number[] {
  return structure.atoms.map((a, i) => colorForAtom(a, colorByAtom?.[i] ?? options.colorMode, options))
}

// Diverging blue (negative) → white (0) → red (positive), clamped to ±1.
const CHARGE_BLUE = new THREE.Color(0x3b6fe0)
const CHARGE_WHITE = new THREE.Color(0xf2f2f2)
const CHARGE_RED = new THREE.Color(0xe0403b)
function chargeColor(q: number): number {
  const t = Math.max(-1, Math.min(1, q))
  const c = new THREE.Color()
  if (t < 0) c.lerpColors(CHARGE_WHITE, CHARGE_BLUE, -t)
  else c.lerpColors(CHARGE_WHITE, CHARGE_RED, t)
  return c.getHex()
}

function computeVisibility(structure: Structure, options: RenderOptions, selected?: Set<number>): boolean[] {
  const restrict = options.restrictToSelection && selected !== undefined && selected.size > 0
  return structure.atoms.map((a, i) => {
    if (!options.showHydrogens && a.element === 'H') return false
    if (restrict && !selected!.has(i)) return false
    return true
  })
}

export function createScene(container: HTMLElement): SceneHandle {
  const pixelRatio = Math.min(window.devicePixelRatio, 2)
  const renderer = new THREE.WebGLRenderer({ antialias: false })
  renderer.setPixelRatio(pixelRatio)
  renderer.setSize(container.clientWidth, container.clientHeight)
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x12141a)
  const camera = new THREE.PerspectiveCamera(50, aspectOf(container), 0.1, 5000)
  camera.position.set(0, 0, 30)

  const controls = new TrackballControls(camera, renderer.domElement)
  controls.rotateSpeed = 3.0
  controls.zoomSpeed = 1.2
  controls.panSpeed = 0.8
  controls.staticMoving = false
  controls.dynamicDampingFactor = 0.15

  let ambientIntensity = 0.55
  const ambient = new THREE.AmbientLight(0xffffff, ambientIntensity)
  scene.add(ambient)
  // Camera-attached "headlights": the lights (and their targets) are children of
  // the camera, so they orbit with it — the side facing the viewer is always lit
  // and rotating never reveals a dark, shadowed backside. The camera itself must
  // be in the scene graph for its child lights to take effect.
  scene.add(camera)
  const key = new THREE.DirectionalLight(0xffffff, 1.3)
  key.position.set(0.3, 0.4, 1) // camera space: front, slightly up/right of the lens
  camera.add(key)
  camera.add(key.target) // target at the camera origin → light direction fixed in view space
  const fill = new THREE.DirectionalLight(0x9bb0ff, 0.35)
  fill.position.set(-0.4, -0.3, 0.8) // a softer fill from the lower-left, still frontal
  camera.add(fill)
  camera.add(fill.target)

  // Lighting contrast (0..1): shift the balance between the directional headlights
  // and the ambient fill. Low = flat/evenly lit; high = strong shading, dim back.
  // The default (0.5) reproduces the original fixed light balance.
  function setContrast(c: number): void {
    const t = Math.min(1, Math.max(0, c))
    const lerp = (a: number, b: number): number => a + (b - a) * t
    ambientIntensity = lerp(0.85, 0.2)
    ambient.intensity = ambientIntensity
    key.intensity = lerp(0.6, 1.9)
    fill.intensity = lerp(0.15, 0.5)
    // The impostor uniforms are refreshed from these every frame (see tick).
  }

  // With camera-attached lights the view-space light directions are constant, so
  // the impostor shader (which shades in view space) just mirrors them — matching
  // the cylinders' headlight exactly. Only the colors/intensities are re-read.
  const _keyView = new THREE.Vector3(0.3, 0.4, 1).normalize()
  const _fillView = new THREE.Vector3(-0.4, -0.3, 0.8).normalize()
  const _keyCol = new THREE.Color()
  const _fillCol = new THREE.Color()
  function syncImpostorLighting(): void {
    _keyCol.copy(key.color).multiplyScalar(key.intensity)
    _fillCol.copy(fill.color).multiplyScalar(fill.intensity)
    updateImpostorLighting(_keyView, _keyCol, _fillView, _fillCol, ambientIntensity)
  }

  // Orthographic rendering uses a second camera synced to the perspective one
  // (which still owns the lights / controls / picking). Only the *render* camera
  // is swapped, and the impostor shader is told which ray model to use.
  const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000)
  let renderCamera: THREE.Camera = camera
  let orthographic = false
  function syncOrthoCamera(): void {
    orthoCamera.position.copy(camera.position)
    orthoCamera.quaternion.copy(camera.quaternion)
    const dist = camera.position.distanceTo(controls.target)
    const size = dist * Math.tan((camera.fov * Math.PI) / 360)
    const aspect = aspectOf(container)
    orthoCamera.left = -size * aspect
    orthoCamera.right = size * aspect
    orthoCamera.top = size
    orthoCamera.bottom = -size
    orthoCamera.near = camera.near
    orthoCamera.far = camera.far
    orthoCamera.updateProjectionMatrix()
  }

  // Depth pre-pass target: when outline/AO are on, the scene is rendered once to
  // capture true depth (the impostors write gl_FragDepth), which the post shaders
  // read. three's own SSAO/Outline passes can't do this — they re-render with
  // override materials and would see the impostors' flat billboards.
  const depthRT = new THREE.WebGLRenderTarget(1, 1, {
    depthTexture: new THREE.DepthTexture(1, 1),
    depthBuffer: true
  })

  const composer = new EffectComposer(renderer)
  const renderPass = new RenderPass(scene, camera)
  composer.addPass(renderPass)
  const aoPass = new ShaderPass(AO_SHADER)
  aoPass.enabled = false
  composer.addPass(aoPass)
  const outlinePass = new ShaderPass(OUTLINE_SHADER)
  outlinePass.enabled = false
  composer.addPass(outlinePass)
  const smaaPass = new SMAAPass()
  composer.addPass(smaaPass)
  composer.addPass(new OutputPass())
  composer.setPixelRatio(pixelRatio)
  composer.setSize(container.clientWidth, container.clientHeight)
  depthRT.setSize(container.clientWidth * pixelRatio, container.clientHeight * pixelRatio)

  // Depth cueing (fog). 0 = off; near/far recomputed each frame from the camera
  // distance so it tracks zoom. Cylinders use scene.fog; impostors mirror it.
  let fogAmount = 0
  const fog = new THREE.Fog(0x12141a, 1, 1000)
  const _fogColor = new THREE.Color()
  function setFog(amount: number): void {
    fogAmount = Math.min(1, Math.max(0, amount))
    if (fogAmount <= 0) {
      scene.fog = null
      updateImpostorFog(0, 1, 1000, _fogColor.set(bgColor))
    }
  }
  function setOrthographic(on: boolean): void {
    orthographic = on
    renderCamera = on ? orthoCamera : camera
    renderPass.camera = renderCamera
    if (on) syncOrthoCamera()
    updateImpostorOrtho(on)
  }
  function setOutline(on: boolean): void {
    outlinePass.enabled = on
  }
  function setAmbientOcclusion(on: boolean): void {
    aoPass.enabled = on
  }

  // Appearance state adjustable live from the Graphics settings.
  let highlightColor = 0xffd400
  let labelColor = 0xffe066
  let labelScale = 1
  let lastHighlightItems: HighlightItem[] = []
  let bgColor = 0x12141a
  let bgGradient = false
  let bgTexture: THREE.Texture | null = null

  // Surface finish: matte (low gloss) → glossy (tight, bright highlight + lower
  // roughness). 0.5 reproduces the original 0.4-roughness / 0.1-spec look.
  function applyFinish(glossiness: number): void {
    const g = Math.min(1, Math.max(0, glossiness))
    updateImpostorFinish(0.04 + g * 0.12, 8 + g * 44)
    const roughness = 0.7 - 0.6 * g
    for (const grp of groups) {
      grp.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined
        if (m && m.isMeshStandardMaterial) m.roughness = roughness
      })
    }
  }

  function applyBackground(): void {
    bgTexture?.dispose()
    if (bgGradient) {
      bgTexture = makeGradientTexture(bgColor)
      scene.background = bgTexture
    } else {
      bgTexture = null
      scene.background = new THREE.Color(bgColor)
    }
  }

  // All visible systems are rendered as ONE merged set of meshes (impostor atoms,
  // instanced cylinder bonds, line bonds). Rendering each system as its own
  // impostor mesh balloons GPU memory and stalls on macOS; one merged mesh that
  // we update in place avoids both that and per-frame rebuild churn.
  let groups: THREE.Group[] = []
  let highlightGroup: THREE.Group | null = null
  let pickables: Pickable[] = []
  let lastKey = ''
  let lastRenderables: Renderable[] = []
  const raycaster = new THREE.Raycaster()

  let atomMesh: THREE.Mesh | null = null
  let atomCenters: Float32Array | null = null
  let cylMesh: THREE.InstancedMesh | null = null
  let lineMesh: THREE.LineSegments | null = null
  const builtById = new Map<string, BuiltSystem>()

  // Move/rotate gizmo. It drives a proxy object (not a render group); dragging it
  // updates the active system's atoms/bonds in place and persists on drag-end.
  let manipTarget: ManipTarget | null = null
  let manipCallback: ((systemId: string, transform: Transform) => void) | null = null
  const gizmoProxy = new THREE.Object3D()
  scene.add(gizmoProxy)
  const gizmo = new TransformControls(camera, renderer.domElement)
  gizmo.setSize(0.9)
  const gizmoHelper = gizmo.getHelper()
  scene.add(gizmoHelper)

  function proxyTransform(): Transform {
    return {
      position: [gizmoProxy.position.x, gizmoProxy.position.y, gizmoProxy.position.z],
      quaternion: [
        gizmoProxy.quaternion.x,
        gizmoProxy.quaternion.y,
        gizmoProxy.quaternion.z,
        gizmoProxy.quaternion.w
      ]
    }
  }

  gizmo.addEventListener('objectChange', () => {
    if (!manipTarget) return
    const r = lastRenderables.find((x) => x.id === manipTarget!.systemId)
    if (r) updateSystem(manipTarget.systemId, r.coords, proxyTransform())
  })
  gizmo.addEventListener('dragging-changed', (e) => {
    controls.enabled = !e.value
    if (!e.value && manipTarget && manipCallback) manipCallback(manipTarget.systemId, proxyTransform())
  })

  function applyManipulation(): void {
    if (!manipTarget) {
      gizmo.detach()
      return
    }
    const t = lastRenderables.find((x) => x.id === manipTarget!.systemId)?.transform
    gizmoProxy.position.set(t ? t.position[0] : 0, t ? t.position[1] : 0, t ? t.position[2] : 0)
    gizmoProxy.quaternion.set(
      t ? t.quaternion[0] : 0,
      t ? t.quaternion[1] : 0,
      t ? t.quaternion[2] : 0,
      t ? t.quaternion[3] : 1
    )
    gizmo.setMode(manipTarget.mode)
    gizmo.attach(gizmoProxy)
  }

  function clearGroups(): void {
    gizmo.detach()
    for (const g of groups) {
      scene.remove(g)
      disposeGroup(g)
    }
    groups = []
    builtById.clear()
    atomMesh = null
    atomCenters = null
    cylMesh = null
    lineMesh = null
  }

  function setScene(renderables: Renderable[], options: RenderOptions): void {
    clearGroups()
    pickables = []
    lastRenderables = renderables
    bgColor = options.backgroundColor
    bgGradient = options.backgroundGradient
    applyBackground()
    const merged = new THREE.Group()

    // World-space accumulators for the single merged meshes.
    const centers: number[] = []
    const radii: number[] = []
    const cols: number[] = []
    const cyl: WorldBond[] = []
    // Extra parallel cylinders for double/triple bonds (builder only). Kept out of
    // `cyl`/`built.cylBonds` so per-system bond indices stay contiguous for the
    // in-place update path; appended at the tail when the mesh is built.
    const cylExtra: WorldBond[] = []
    const lin: WorldBond[] = []
    const col = new THREE.Color()

    for (const r of renderables) {
      const reps = r.structure.atoms.map((_a, i) => r.repByAtom?.[i] ?? options.representation)
      const colors = computeAtomColors(r.structure, options, r.colorByAtom)
      const visible = computeVisibility(r.structure, options, r.selected)

      // Tube is a whole-structure representation — its own group, coords baked.
      if (options.representation === 'tube' && reps.every((x) => x === 'tube')) {
        const tube = buildBackboneTube(r.structure, r.coords, r.transform)
        if (tube) {
          merged.add(tube)
          continue
        }
      }

      const built: BuiltSystem = {
        atomStart: centers.length / 3,
        atomSlots: [],
        cylStart: cyl.length,
        cylBonds: [],
        lineStart: lin.length,
        lineBonds: []
      }

      for (let i = 0; i < r.structure.atoms.length; i++) {
        if (!visible[i]) continue
        const atom = r.structure.atoms[i]
        const base = atomPos(r.structure, r.coords, i)
        const w = r.transform ? applyTransform(base, r.transform) : base
        const radius =
          atomRepSpec(reps[i]).atomRadius(elementInfo(atom.element).vdwRadius) * options.ballScale
        built.atomSlots.push(i)
        centers.push(w[0], w[1], w[2])
        radii.push(radius)
        col.set(colors[i])
        cols.push(col.r, col.g, col.b)
        // Pickables are pushed in the same order as atom slots (1:1 with centers).
        pickables.push({
          systemId: r.id,
          atomIndex: i,
          name: atom.name,
          element: atom.element,
          x: w[0],
          y: w[1],
          z: w[2],
          bx: base[0],
          by: base[1],
          bz: base[2],
          radius: Math.max(radius, 0.4)
        })
      }

      for (const b of r.structure.bonds) {
        if (!visible[b.a - 1] || !visible[b.b - 1]) continue
        const sa = atomRepSpec(reps[b.a - 1])
        const sb = atomRepSpec(reps[b.b - 1])
        const baseA = atomPos(r.structure, r.coords, b.a - 1)
        const baseB = atomPos(r.structure, r.coords, b.b - 1)
        const wa = r.transform ? applyTransform(baseA, r.transform) : baseA
        const wb = r.transform ? applyTransform(baseB, r.transform) : baseB
        const ca = colors[b.a - 1]
        const cb = colors[b.b - 1]
        if (sa.bond === 'cylinder' || sb.bond === 'cylinder') {
          const radius =
            Math.min(
              sa.bond === 'cylinder' ? sa.bondRadius : Infinity,
              sb.bond === 'cylinder' ? sb.bondRadius : Infinity
            ) * options.bondScale
          const order = r.bondOrders?.[`${b.a}-${b.b}`] ?? 1
          if (order > 1) {
            // Draw the bond as `order` thinner parallel cylinders. The first is
            // registered for completeness; the rest are tail extras.
            const parallels = multiBondCylinders(wa, wb, radius, order, ca, cb)
            built.cylBonds.push({ a: b.a - 1, b: b.b - 1, radius: parallels[0].radius })
            cyl.push(parallels[0])
            for (let p = 1; p < parallels.length; p++) cylExtra.push(parallels[p])
          } else {
            built.cylBonds.push({ a: b.a - 1, b: b.b - 1, radius })
            cyl.push({ wa, wb, radius, ca, cb })
          }
        } else if (sa.bond === 'line' || sb.bond === 'line') {
          built.lineBonds.push({ a: b.a - 1, b: b.b - 1 })
          lin.push({ wa, wb, radius: 0, ca, cb })
        }
      }

      builtById.set(r.id, built)
    }

    if (centers.length > 0) {
      atomCenters = Float32Array.from(centers)
      atomMesh = createImpostorSpheres({
        centers: atomCenters,
        radii: Float32Array.from(radii),
        colors: Float32Array.from(cols),
        count: centers.length / 3
      })
      merged.add(atomMesh)
    }
    if (cyl.length > 0 || cylExtra.length > 0) {
      cylMesh = buildCylinderBonds(cyl.concat(cylExtra))
      merged.add(cylMesh)
    }
    if (lin.length > 0) {
      lineMesh = buildLineBonds(lin)
      merged.add(lineMesh)
    }
    if (options.showBox) {
      for (const r of renderables) {
        if (!r.structure.box) continue
        const box = buildBox(r.structure.box)
        if (r.transform) {
          box.position.set(...r.transform.position)
          box.quaternion.set(...r.transform.quaternion)
        }
        merged.add(box)
      }
    }

    scene.add(merged)
    groups.push(merged)
    applyFinish(options.glossiness)
    applyManipulation()
    const k = renderables.map((r) => r.id).join(',')
    if (k !== lastKey) {
      frameCameraToRenderables(renderables, camera, controls)
      lastKey = k
    }
  }

  // In-place coordinate update for one system (trajectory frame or gizmo drag):
  // rewrite its atom positions, bond instances, and pickables without rebuilding.
  function updateSystem(
    systemId: string,
    coords: Float32Array | null,
    transform?: Transform
  ): void {
    const built = builtById.get(systemId)
    const r = lastRenderables.find((x) => x.id === systemId)
    if (!built || !r || !atomMesh || !atomCenters) return
    const atoms = r.structure.atoms

    // Base (untransformed) coordinates of atom i, written into `out` — no alloc.
    const baseInto = (out: Vec3, i: number): void => {
      if (coords) {
        out[0] = coords[i * 3]
        out[1] = coords[i * 3 + 1]
        out[2] = coords[i * 3 + 2]
      } else {
        out[0] = atoms[i].x
        out[1] = atoms[i].y
        out[2] = atoms[i].z
      }
    }
    // World coordinates (base + rigid transform) of atom i, written into `out`.
    // The quaternion rotation is inlined so we never allocate a result array.
    const worldInto = (out: Vec3, i: number): void => {
      baseInto(out, i)
      if (!transform) return
      const x = out[0]
      const y = out[1]
      const z = out[2]
      const qx = transform.quaternion[0]
      const qy = transform.quaternion[1]
      const qz = transform.quaternion[2]
      const qw = transform.quaternion[3]
      const tx = 2 * (qy * z - qz * y)
      const ty = 2 * (qz * x - qx * z)
      const tz = 2 * (qx * y - qy * x)
      out[0] = x + qw * tx + (qy * tz - qz * ty) + transform.position[0]
      out[1] = y + qw * ty + (qz * tx - qx * tz) + transform.position[1]
      out[2] = z + qw * tz + (qx * ty - qy * tx) + transform.position[2]
    }

    for (let j = 0; j < built.atomSlots.length; j++) {
      const atomIndex = built.atomSlots[j]
      const slot = built.atomStart + j
      worldInto(_waScratch, atomIndex)
      atomCenters[slot * 3] = _waScratch[0]
      atomCenters[slot * 3 + 1] = _waScratch[1]
      atomCenters[slot * 3 + 2] = _waScratch[2]
      const pk = pickables[slot]
      pk.x = _waScratch[0]
      pk.y = _waScratch[1]
      pk.z = _waScratch[2]
      baseInto(_wbScratch, atomIndex)
      pk.bx = _wbScratch[0]
      pk.by = _wbScratch[1]
      pk.bz = _wbScratch[2]
    }
    ;(atomMesh.geometry.getAttribute('aCenter') as THREE.BufferAttribute).needsUpdate = true

    if (cylMesh && built.cylBonds.length > 0) {
      for (let k = 0; k < built.cylBonds.length; k++) {
        const bd = built.cylBonds[k]
        worldInto(_waScratch, bd.a)
        worldInto(_wbScratch, bd.b)
        placeBondCylinders(cylMesh, built.cylStart + k, _waScratch, _wbScratch, bd.radius)
      }
      cylMesh.instanceMatrix.needsUpdate = true
    }

    if (lineMesh && built.lineBonds.length > 0) {
      const pos = lineMesh.geometry.getAttribute('position') as THREE.BufferAttribute
      const arr = pos.array as Float32Array
      for (let k = 0; k < built.lineBonds.length; k++) {
        const bd = built.lineBonds[k]
        worldInto(_waScratch, bd.a)
        worldInto(_wbScratch, bd.b)
        const mx = (_waScratch[0] + _wbScratch[0]) / 2
        const my = (_waScratch[1] + _wbScratch[1]) / 2
        const mz = (_waScratch[2] + _wbScratch[2]) / 2
        const base = (built.lineStart + k) * 12
        arr[base] = _waScratch[0]
        arr[base + 1] = _waScratch[1]
        arr[base + 2] = _waScratch[2]
        arr[base + 3] = mx
        arr[base + 4] = my
        arr[base + 5] = mz
        arr[base + 6] = mx
        arr[base + 7] = my
        arr[base + 8] = mz
        arr[base + 9] = _wbScratch[0]
        arr[base + 10] = _wbScratch[1]
        arr[base + 11] = _wbScratch[2]
      }
      pos.needsUpdate = true
    }

    // Keep the stored renderable in sync so recenter / gizmo use fresh positions.
    r.coords = coords
    if (transform) r.transform = transform
  }

  function pick(clientX: number, clientY: number): PickResult | null {
    const rect = renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    )
    raycaster.setFromCamera(ndc, renderCamera)
    const ray = raycaster.ray
    const oc = new THREE.Vector3()
    const center = new THREE.Vector3()
    let best: Pickable | null = null
    let bestT = Infinity
    for (const p of pickables) {
      oc.subVectors(ray.origin, center.set(p.x, p.y, p.z))
      const b = oc.dot(ray.direction)
      const c = oc.dot(oc) - p.radius * p.radius
      const disc = b * b - c
      if (disc < 0) continue
      const t = -b - Math.sqrt(disc)
      if (t > 0 && t < bestT) {
        bestT = t
        best = p
      }
    }
    if (!best) return null
    return {
      systemId: best.systemId,
      atomIndex: best.atomIndex,
      name: best.name,
      element: best.element,
      position: [best.bx, best.by, best.bz]
    }
  }

  function setHighlights(items: HighlightItem[]): void {
    lastHighlightItems = items
    if (highlightGroup) {
      scene.remove(highlightGroup)
      disposeGroup(highlightGroup)
      highlightGroup = null
    }
    if (items.length === 0) return
    const group = new THREE.Group()
    const geometry = new THREE.SphereGeometry(1, 16, 16)
    const material = new THREE.MeshBasicMaterial({
      color: highlightColor,
      transparent: true,
      opacity: 0.5,
      depthTest: false
    })
    for (const it of items) {
      const [x, y, z] = it.position
      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.set(x, y, z)
      mesh.scale.setScalar(0.55)
      mesh.renderOrder = 999
      group.add(mesh)
      if (it.label) {
        const sprite = makeLabelSprite(it.label, labelScale, labelColor)
        sprite.position.set(x, y, z)
        group.add(sprite)
      }
    }
    scene.add(group)
    highlightGroup = group
  }

  const resize = (): void => {
    const w = container.clientWidth
    const h = container.clientHeight
    if (w === 0 || h === 0) return
    renderer.setSize(w, h)
    composer.setSize(w, h)
    depthRT.setSize(w * pixelRatio, h * pixelRatio)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    controls.handleResize()
  }
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(container)

  let raf = 0
  const tick = (): void => {
    controls.update()
    camera.updateMatrixWorld()
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
    if (orthographic) syncOrthoCamera()
    syncImpostorLighting()
    // Depth cueing: track the camera distance so fog density feels consistent.
    if (fogAmount > 0) {
      const dist = camera.position.distanceTo(controls.target)
      const near = dist * (2.0 - 1.6 * fogAmount)
      const far = dist * (6.0 - 4.9 * fogAmount)
      _fogColor.set(bgColor)
      fog.near = near
      fog.far = far
      fog.color.copy(_fogColor)
      scene.fog = fog
      updateImpostorFog(fogAmount, near, far, _fogColor)
    }
    // Depth pre-pass: render once to capture true depth for the outline / AO
    // shaders (only when at least one is enabled).
    if (aoPass.enabled || outlinePass.enabled) {
      renderer.setRenderTarget(depthRT)
      renderer.render(scene, renderCamera)
      renderer.setRenderTarget(null)
      const rc = renderCamera as THREE.PerspectiveCamera
      for (const p of [aoPass, outlinePass]) {
        if (!p.enabled) continue
        p.uniforms.tDepth.value = depthRT.depthTexture
        p.uniforms.cameraNear.value = rc.near
        p.uniforms.cameraFar.value = rc.far
        ;(p.uniforms.resolution.value as THREE.Vector2).set(depthRT.width, depthRT.height)
      }
    }
    composer.render()
    raf = requestAnimationFrame(tick)
  }
  tick()

  function setControlsEnabled(enabled: boolean): void {
    controls.enabled = enabled
  }

  // Intersect the ray through a screen pixel with the plane through `anchor` whose
  // normal is the camera's view direction — i.e. drag atoms parallel to the screen.
  function dragPlanePoint(clientX: number, clientY: number, anchor: Vec3): Vec3 {
    const rect = renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    )
    raycaster.setFromCamera(ndc, renderCamera)
    const ray = raycaster.ray
    const normal = new THREE.Vector3()
    renderCamera.getWorldDirection(normal)
    const anchorV = new THREE.Vector3(anchor[0], anchor[1], anchor[2])
    const denom = ray.direction.dot(normal)
    if (Math.abs(denom) < 1e-6) return anchor
    const t = anchorV.sub(ray.origin).dot(normal) / denom
    const hit = ray.origin.clone().addScaledVector(ray.direction, t)
    return [hit.x, hit.y, hit.z]
  }

  return {
    setScene,
    pick,
    setHighlights,
    setControlsEnabled,
    dragPlanePoint,
    setManipulation(target, onChange): void {
      manipTarget = target
      manipCallback = onChange
      if (!target) controls.enabled = true
      applyManipulation()
    },
    setFov(fov): void {
      if (!Number.isFinite(fov) || fov <= 0 || fov === camera.fov) return
      // Move the camera along its view direction so the subject keeps the same
      // on-screen size: dist * tan(fov/2) is held constant.
      const dir = new THREE.Vector3().subVectors(camera.position, controls.target)
      const dist = dir.length() || 1
      const k = dist * Math.tan((camera.fov * Math.PI) / 360)
      const newDist = k / Math.tan((fov * Math.PI) / 360)
      camera.fov = fov
      camera.position.copy(controls.target).addScaledVector(dir.normalize(), newDist)
      camera.near = Math.max(newDist / 100, 0.01)
      camera.far = newDist * 100
      camera.updateProjectionMatrix()
      controls.update()
    },
    recenter(): void {
      frameCameraToRenderables(lastRenderables, camera, controls)
    },
    setBackground(color): void {
      bgColor = color
      applyBackground()
    },
    setBackgroundGradient(on): void {
      bgGradient = on
      applyBackground()
    },
    setContrast,
    setFinish(glossiness): void {
      applyFinish(glossiness)
    },
    setAntialias(on): void {
      smaaPass.enabled = on
    },
    setHighlightStyle(color, lblColor, lblScale): void {
      highlightColor = color
      labelColor = lblColor
      labelScale = lblScale
      if (lastHighlightItems.length) setHighlights(lastHighlightItems)
    },
    setFog,
    setOrthographic,
    setOutline,
    setAmbientOcclusion,
    updateSystem,
    dispose(): void {
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      controls.dispose()
      gizmo.detach()
      scene.remove(gizmoHelper)
      gizmo.dispose()
      clearGroups()
      if (highlightGroup) disposeGroup(highlightGroup)
      bgTexture?.dispose()
      depthRT.dispose()
      composer.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement)
      }
    }
  }
}

function aspectOf(el: HTMLElement): number {
  return el.clientHeight > 0 ? el.clientWidth / el.clientHeight : 1
}

function atomPos(structure: Structure, coords: Float32Array | null, i: number): [number, number, number] {
  if (coords) return [coords[i * 3], coords[i * 3 + 1], coords[i * 3 + 2]]
  const a = structure.atoms[i]
  return [a.x, a.y, a.z]
}

// A smooth tube through the backbone (CA atoms) of each chain — a simple protein
// cartoon stand-in. Returns null if there is no protein backbone. The transform
// (if any) is baked into the curve points, since tubes aren't in a merged mesh.
function buildBackboneTube(
  structure: Structure,
  coords: Float32Array | null,
  transform?: Transform
): THREE.Group | null {
  // Trace the protein backbone (alpha carbons, "CA") or the nucleic-acid backbone
  // (phosphates, "P") per chain — whichever the chain has.
  type Pt = { seq: number; pos: THREE.Vector3 }
  const byChain = new Map<string, { ca: Pt[]; p: Pt[] }>()
  structure.atoms.forEach((a, i) => {
    const isCA = a.name === 'CA'
    const isP = a.name === 'P'
    if (!isCA && !isP) return
    const base = atomPos(structure, coords, i)
    const [x, y, z] = transform ? applyTransform(base, transform) : base
    const chain = a.chain ?? ''
    const entry = byChain.get(chain) ?? { ca: [], p: [] }
    entry[isCA ? 'ca' : 'p'].push({ seq: a.residueSeq ?? i, pos: new THREE.Vector3(x, y, z) })
    byChain.set(chain, entry)
  })
  if (byChain.size === 0) return null

  const group = new THREE.Group()
  for (const [chain, { ca, p }] of byChain) {
    const pts = ca.length >= 2 ? ca : p
    if (pts.length < 2) continue
    pts.sort((u, v) => u.seq - v.seq)
    const curve = new THREE.CatmullRomCurve3(pts.map((c) => c.pos))
    const geometry = new THREE.TubeGeometry(curve, Math.max(pts.length * 4, 8), 0.35, 10, false)
    const material = new THREE.MeshStandardMaterial({
      color: paletteColor(`chain:${chain}`),
      roughness: 0.4,
      metalness: 0.0
    })
    group.add(new THREE.Mesh(geometry, material))
  }
  return group.children.length ? group : null
}

// Shared scratch for placing cylinder instance matrices (single-threaded).
const _dummy = new THREE.Object3D()
const _dir = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
// Reused world/midpoint vectors so the per-frame update allocates nothing — at
// ~120k bonds+atoms per frame, allocating tuples here forced V8 to grow its heap
// into the gigabytes (committed, never released) during trajectory playback.
const _midScratch: Vec3 = [0, 0, 0]
const _waScratch: Vec3 = [0, 0, 0]
const _wbScratch: Vec3 = [0, 0, 0]

function placeCylinder(mesh: THREE.InstancedMesh, slot: number, from: Vec3, to: Vec3, radius: number): void {
  _dir.set(to[0] - from[0], to[1] - from[1], to[2] - from[2])
  const length = _dir.length() || 1e-6
  _dummy.position.set(from[0] + _dir.x * 0.5, from[1] + _dir.y * 0.5, from[2] + _dir.z * 0.5)
  _dummy.quaternion.setFromUnitVectors(_up, _dir.normalize())
  _dummy.scale.set(radius, length, radius)
  _dummy.updateMatrix()
  mesh.setMatrixAt(slot, _dummy.matrix)
}

// Each bond is two half-cylinders (slots bondSlot*2 and +1) meeting at the
// midpoint, so each half takes the color of its own atom.
function placeBondCylinders(
  mesh: THREE.InstancedMesh,
  bondSlot: number,
  wa: Vec3,
  wb: Vec3,
  radius: number
): void {
  _midScratch[0] = (wa[0] + wb[0]) / 2
  _midScratch[1] = (wa[1] + wb[1]) / 2
  _midScratch[2] = (wa[2] + wb[2]) / 2
  placeCylinder(mesh, bondSlot * 2, wa, _midScratch, radius)
  placeCylinder(mesh, bondSlot * 2 + 1, wb, _midScratch, radius)
}

/**
 * Split a double/triple bond into `order` thinner parallel cylinders, offset
 * perpendicular to the bond by a stable axis (the bond direction crossed with a
 * world axis). Used by the builder to make multiple bonds visible.
 */
function multiBondCylinders(
  wa: Vec3,
  wb: Vec3,
  radius: number,
  order: number,
  ca: number,
  cb: number
): WorldBond[] {
  const dx = wb[0] - wa[0]
  const dy = wb[1] - wa[1]
  const dz = wb[2] - wa[2]
  const len = Math.hypot(dx, dy, dz) || 1
  const ux = dx / len
  const uy = dy / len
  const uz = dz / len
  // A reference axis not parallel to the bond, then perp = bond × ref (normalized).
  const ref: Vec3 = Math.abs(uy) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  let px = uy * ref[2] - uz * ref[1]
  let py = uz * ref[0] - ux * ref[2]
  let pz = ux * ref[1] - uy * ref[0]
  const plen = Math.hypot(px, py, pz) || 1
  px /= plen
  py /= plen
  pz /= plen

  const thin = radius * (order === 2 ? 0.55 : 0.45)
  const gap = radius * 1.3 // spacing between parallel cylinders
  // Offsets centered on zero: e.g. order 2 -> [-0.5, +0.5]·gap; order 3 -> [-1,0,+1]·gap.
  const offsets: number[] = []
  for (let i = 0; i < order; i++) offsets.push((i - (order - 1) / 2) * gap)

  return offsets.map((o) => ({
    wa: [wa[0] + px * o, wa[1] + py * o, wa[2] + pz * o] as Vec3,
    wb: [wb[0] + px * o, wb[1] + py * o, wb[2] + pz * o] as Vec3,
    radius: thin,
    ca,
    cb
  }))
}

function buildCylinderBonds(drawn: WorldBond[]): THREE.InstancedMesh {
  const geometry = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true)
  const material = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.0 })
  const mesh = new THREE.InstancedMesh(geometry, material, drawn.length * 2)
  // The matrices are rewritten every frame during playback — see the aCenter
  // note in impostorSpheres.ts. Mark dynamic so the driver reuses one buffer
  // instead of orphaning (and pooling) a new one per update.
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  const color = new THREE.Color()
  drawn.forEach((b, k) => {
    placeBondCylinders(mesh, k, b.wa, b.wb, b.radius)
    mesh.setColorAt(k * 2, color.set(b.ca))
    mesh.setColorAt(k * 2 + 1, color.set(b.cb))
  })
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  return mesh
}

// Each bond is two line segments meeting at the midpoint, each a solid color
// (no gradient) so it reads like the half-cylinder bonds. 12 floats per bond.
function buildLineBonds(drawn: WorldBond[]): THREE.LineSegments {
  const positions = new Float32Array(drawn.length * 12)
  const colors = new Float32Array(drawn.length * 12)
  const color = new THREE.Color()
  drawn.forEach((b, k) => {
    const m: Vec3 = [(b.wa[0] + b.wb[0]) / 2, (b.wa[1] + b.wb[1]) / 2, (b.wa[2] + b.wb[2]) / 2]
    positions.set([...b.wa, ...m, ...m, ...b.wb], k * 12)
    color.set(b.ca)
    const ca = [color.r, color.g, color.b]
    color.set(b.cb)
    const cb = [color.r, color.g, color.b]
    colors.set([...ca, ...ca, ...cb, ...cb], k * 12)
  })
  const geometry = new THREE.BufferGeometry()
  // position is rewritten every frame during playback — mark dynamic to avoid
  // the driver buffer-orphaning growth (see the aCenter note in impostorSpheres).
  const pos = new THREE.BufferAttribute(positions, 3)
  pos.setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute('position', pos)
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const material = new THREE.LineBasicMaterial({ vertexColors: true })
  return new THREE.LineSegments(geometry, material)
}

/** Wireframe of a Tinker periodic box (a,b,c,α,β,γ), centered at the origin. */
function buildBox(box: [number, number, number, number, number, number]): THREE.LineSegments {
  const [a, b, c, alpha, beta, gamma] = box
  const deg = Math.PI / 180
  const ca = Math.cos(alpha * deg)
  const cb = Math.cos(beta * deg)
  const cg = Math.cos(gamma * deg)
  const sg = Math.sin(gamma * deg) || 1
  // Lattice vectors from the cell parameters (standard crystallographic convention).
  const va = new THREE.Vector3(a, 0, 0)
  const vb = new THREE.Vector3(b * cg, b * sg, 0)
  const cx = c * cb
  const cy = (c * (ca - cb * cg)) / sg
  const vc = new THREE.Vector3(cx, cy, Math.sqrt(Math.max(c * c - cx * cx - cy * cy, 0)))
  const corners: THREE.Vector3[] = []
  for (let k = 0; k < 2; k++)
    for (let j = 0; j < 2; j++)
      for (let i = 0; i < 2; i++) {
        corners.push(
          new THREE.Vector3()
            .addScaledVector(va, i - 0.5)
            .addScaledVector(vb, j - 0.5)
            .addScaledVector(vc, k - 0.5)
        )
      }
  // 12 edges by corner index (index = i + 2j + 4k).
  const edges = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7]
  ]
  const pos: number[] = []
  for (const [s, e] of edges) {
    pos.push(corners[s].x, corners[s].y, corners[s].z, corners[e].x, corners[e].y, corners[e].z)
  }
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  const mat = new THREE.LineBasicMaterial({ color: 0x6b7280, transparent: true, opacity: 0.6 })
  return new THREE.LineSegments(geom, mat)
}

/** A 2×256 vertical gradient (darkened top → slightly lightened bottom) of `color`. */
function makeGradientTexture(color: number): THREE.Texture {
  const c = new THREE.Color(color)
  const top = c.clone().multiplyScalar(0.55)
  const bottom = c.clone().lerp(new THREE.Color(0xffffff), 0.08)
  const canvas = document.createElement('canvas')
  canvas.width = 2
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createLinearGradient(0, 0, 0, 256)
  grad.addColorStop(0, `#${top.getHexString()}`)
  grad.addColorStop(1, `#${bottom.getHexString()}`)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 2, 256)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function makeLabelSprite(text: string, scale: number, color: number): THREE.Sprite {
  const fontPx = 56
  const pad = 10
  const measureCtx = document.createElement('canvas').getContext('2d')!
  measureCtx.font = `${fontPx}px sans-serif`
  const textWidth = Math.ceil(measureCtx.measureText(text).width)

  const canvas = document.createElement('canvas')
  canvas.width = textWidth + pad * 2
  canvas.height = fontPx + pad * 2
  const ctx = canvas.getContext('2d')!
  ctx.font = `${fontPx}px sans-serif`
  ctx.fillStyle = 'rgba(10,12,18,0.72)'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#' + (color & 0xffffff).toString(16).padStart(6, '0')
  ctx.textBaseline = 'middle'
  ctx.fillText(text, pad, canvas.height / 2)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({
    map: texture,
    depthTest: false,
    transparent: true,
    sizeAttenuation: false
  })
  const sprite = new THREE.Sprite(material)
  const h = 0.05 * scale
  sprite.scale.set((canvas.width / canvas.height) * h, h, 1)
  sprite.renderOrder = 1001
  return sprite
}

function frameCameraToRenderables(
  renderables: Renderable[],
  camera: THREE.PerspectiveCamera,
  controls: TrackballControls
): void {
  const box = new THREE.Box3()
  const point = new THREE.Vector3()
  for (const r of renderables) {
    r.structure.atoms.forEach((_atom, i) => {
      const base = atomPos(r.structure, r.coords, i)
      const [x, y, z] = r.transform ? applyTransform(base, r.transform) : base
      box.expandByPoint(point.set(x, y, z))
    })
  }
  if (box.isEmpty()) return

  const center = box.getCenter(new THREE.Vector3())
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1)
  const fov = (camera.fov * Math.PI) / 180
  const distance = (radius / Math.sin(fov / 2)) * 1.25

  controls.target.copy(center)
  const viewDir = new THREE.Vector3(0.35, 0.25, 1).normalize()
  camera.position.copy(center).addScaledVector(viewDir, distance)
  camera.near = Math.max(distance / 100, 0.01)
  camera.far = distance * 100
  camera.updateProjectionMatrix()
  controls.update()
}

function disposeGroup(group: THREE.Group): void {
  group.traverse((object) => {
    const o = object as THREE.Mesh & { isSprite?: boolean; material?: THREE.Material | THREE.Material[] }
    if (o.isSprite) {
      const m = o.material as THREE.SpriteMaterial | undefined
      m?.map?.dispose()
      m?.dispose()
      return
    }
    if (o.geometry) o.geometry.dispose()
    const material = o.material
    // The impostor ShaderMaterial is shared across all atom meshes — never dispose it.
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else if (material && !(material as THREE.ShaderMaterial).isShaderMaterial) material.dispose()
  })
}
