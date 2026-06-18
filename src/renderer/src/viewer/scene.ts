import * as THREE from 'three'
import { TrackballControls } from 'three/addons/controls/TrackballControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import type { Structure } from '../core/types'
import { applyTransform, type Transform } from '../core/transform'
import { elementInfo } from '../core/elements'
import { type RenderOptions, type Representation, type ColorMode } from './renderOptions'
import { createImpostorSpheres } from './impostorSpheres'

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
  /** Re-frame the camera to fit the current scene. */
  recenter(): void
  /** Update one system's coordinates in place (trajectory frame); no rebuild. */
  updateSystem(systemId: string, coords: Float32Array | null, transform?: Transform): void
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
      return { atomRadius: () => 0.18, bond: 'cylinder', bondRadius: 0.18 }
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

  scene.add(new THREE.AmbientLight(0xffffff, 0.55))
  const key = new THREE.DirectionalLight(0xffffff, 1.3)
  key.position.set(5, 10, 7)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0x9bb0ff, 0.35)
  fill.position.set(-6, -3, -4)
  scene.add(fill)

  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  composer.addPass(new SMAAPass())
  composer.addPass(new OutputPass())
  composer.setPixelRatio(pixelRatio)
  composer.setSize(container.clientWidth, container.clientHeight)

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
    ;(scene.background as THREE.Color).set(options.backgroundColor)
    const merged = new THREE.Group()

    // World-space accumulators for the single merged meshes.
    const centers: number[] = []
    const radii: number[] = []
    const cols: number[] = []
    const cyl: WorldBond[] = []
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
          built.cylBonds.push({ a: b.a - 1, b: b.b - 1, radius })
          cyl.push({ wa, wb, radius, ca, cb })
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
    if (cyl.length > 0) {
      cylMesh = buildCylinderBonds(cyl)
      merged.add(cylMesh)
    }
    if (lin.length > 0) {
      lineMesh = buildLineBonds(lin)
      merged.add(lineMesh)
    }

    scene.add(merged)
    groups.push(merged)
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

    const baseOf = (i: number): [number, number, number] =>
      coords ? [coords[i * 3], coords[i * 3 + 1], coords[i * 3 + 2]] : [atoms[i].x, atoms[i].y, atoms[i].z]
    const worldOf = (i: number): [number, number, number] => {
      const b = baseOf(i)
      return transform ? applyTransform(b, transform) : b
    }

    built.atomSlots.forEach((atomIndex, j) => {
      const slot = built.atomStart + j
      const w = worldOf(atomIndex)
      atomCenters![slot * 3] = w[0]
      atomCenters![slot * 3 + 1] = w[1]
      atomCenters![slot * 3 + 2] = w[2]
      const pk = pickables[slot]
      pk.x = w[0]
      pk.y = w[1]
      pk.z = w[2]
      const base = baseOf(atomIndex)
      pk.bx = base[0]
      pk.by = base[1]
      pk.bz = base[2]
    })
    ;(atomMesh.geometry.getAttribute('aCenter') as THREE.BufferAttribute).needsUpdate = true

    if (cylMesh && built.cylBonds.length > 0) {
      built.cylBonds.forEach((bd, k) => {
        placeBondCylinders(cylMesh!, built.cylStart + k, worldOf(bd.a), worldOf(bd.b), bd.radius)
      })
      cylMesh.instanceMatrix.needsUpdate = true
    }

    if (lineMesh && built.lineBonds.length > 0) {
      const pos = lineMesh.geometry.getAttribute('position') as THREE.BufferAttribute
      const arr = pos.array as Float32Array
      built.lineBonds.forEach((bd, k) => {
        const wa = worldOf(bd.a)
        const wb = worldOf(bd.b)
        const m: Vec3 = [(wa[0] + wb[0]) / 2, (wa[1] + wb[1]) / 2, (wa[2] + wb[2]) / 2]
        arr.set([...wa, ...m, ...m, ...wb], (built.lineStart + k) * 12)
      })
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
    raycaster.setFromCamera(ndc, camera)
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
    if (highlightGroup) {
      scene.remove(highlightGroup)
      disposeGroup(highlightGroup)
      highlightGroup = null
    }
    if (items.length === 0) return
    const group = new THREE.Group()
    const geometry = new THREE.SphereGeometry(1, 16, 16)
    const material = new THREE.MeshBasicMaterial({
      color: 0xffd400,
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
        const sprite = makeLabelSprite(it.label)
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
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    controls.handleResize()
  }
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(container)

  let raf = 0
  const tick = (): void => {
    controls.update()
    composer.render()
    raf = requestAnimationFrame(tick)
  }
  tick()

  return {
    setScene,
    pick,
    setHighlights,
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
      ;(scene.background as THREE.Color).set(color)
    },
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
  const byChain = new Map<string, Array<{ seq: number; pos: THREE.Vector3 }>>()
  structure.atoms.forEach((a, i) => {
    if (a.name !== 'CA') return
    const base = atomPos(structure, coords, i)
    const [x, y, z] = transform ? applyTransform(base, transform) : base
    const chain = a.chain ?? ''
    const list = byChain.get(chain) ?? []
    list.push({ seq: a.residueSeq ?? i, pos: new THREE.Vector3(x, y, z) })
    byChain.set(chain, list)
  })
  if (byChain.size === 0) return null

  const group = new THREE.Group()
  for (const [chain, cas] of byChain) {
    if (cas.length < 2) continue
    cas.sort((p, q) => p.seq - q.seq)
    const curve = new THREE.CatmullRomCurve3(cas.map((c) => c.pos))
    const geometry = new THREE.TubeGeometry(curve, Math.max(cas.length * 4, 8), 0.35, 10, false)
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
  const mid: Vec3 = [(wa[0] + wb[0]) / 2, (wa[1] + wb[1]) / 2, (wa[2] + wb[2]) / 2]
  placeCylinder(mesh, bondSlot * 2, wa, mid, radius)
  placeCylinder(mesh, bondSlot * 2 + 1, wb, mid, radius)
}

function buildCylinderBonds(drawn: WorldBond[]): THREE.InstancedMesh {
  const geometry = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true)
  const material = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.0 })
  const mesh = new THREE.InstancedMesh(geometry, material, drawn.length * 2)
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
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const material = new THREE.LineBasicMaterial({ vertexColors: true })
  return new THREE.LineSegments(geometry, material)
}

function makeLabelSprite(text: string): THREE.Sprite {
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
  ctx.fillStyle = '#ffe066'
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
  const h = 0.05
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
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else if (material) material.dispose()
  })
}
