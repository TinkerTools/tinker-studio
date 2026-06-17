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
import { type RenderOptions, type Representation } from './renderOptions'
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
  dispose(): void
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
      return { atomRadius: () => 0.2, bond: 'cylinder', bondRadius: 0.2 }
    case 'wireframe':
      return { atomRadius: () => 0.12, bond: 'line', bondRadius: 0 }
    case 'ball-and-stick':
    case 'tube': // tube falls back to ball-and-stick until the backbone tracer lands
    default:
      return { atomRadius: (vdw) => Math.max(vdw * 0.3, 0.25), bond: 'cylinder', bondRadius: 0.1 }
  }
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

function computeAtomColors(structure: Structure, options: RenderOptions): number[] {
  switch (options.colorMode) {
    case 'uniform':
      return structure.atoms.map(() => options.uniformColor)
    case 'residue':
      return structure.atoms.map((a) =>
        a.residueSeq !== undefined ? paletteColor(`${a.chain ?? ''}:${a.residueSeq}`) : elementInfo(a.element).color
      )
    case 'chain':
      return structure.atoms.map((a) =>
        a.chain ? paletteColor(`chain:${a.chain}`) : elementInfo(a.element).color
      )
    case 'charge':
      return structure.atoms.map((a) => (a.charge !== undefined ? chargeColor(a.charge) : 0x808080))
    default:
      return structure.atoms.map((a) => elementInfo(a.element).color)
  }
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

  let groups: THREE.Group[] = []
  const groupById = new Map<string, THREE.Group>()
  let highlightGroup: THREE.Group | null = null
  let pickables: Pickable[] = []
  let lastKey = ''
  const raycaster = new THREE.Raycaster()

  // Interactive move/rotate gizmo. Attached to the active system's group while in
  // move mode; persists the resulting transform back to React on drag-end.
  let manipTarget: ManipTarget | null = null
  let manipCallback: ((systemId: string, transform: Transform) => void) | null = null
  const gizmo = new TransformControls(camera, renderer.domElement)
  gizmo.setSize(0.9)
  const gizmoHelper = gizmo.getHelper()
  scene.add(gizmoHelper)
  gizmo.addEventListener('dragging-changed', (e) => {
    // Suspend camera trackball while a handle is being dragged.
    controls.enabled = !e.value
    if (!e.value && manipTarget && manipCallback) {
      const obj = gizmo.object
      if (obj) {
        manipCallback(manipTarget.systemId, {
          position: [obj.position.x, obj.position.y, obj.position.z],
          quaternion: [obj.quaternion.x, obj.quaternion.y, obj.quaternion.z, obj.quaternion.w]
        })
      }
    }
  })

  function applyManipulation(): void {
    if (!manipTarget) {
      gizmo.detach()
      return
    }
    gizmo.setMode(manipTarget.mode)
    const group = groupById.get(manipTarget.systemId)
    if (group) gizmo.attach(group)
    else gizmo.detach()
  }

  function clearGroups(): void {
    gizmo.detach()
    for (const g of groups) {
      scene.remove(g)
      disposeGroup(g)
    }
    groups = []
    groupById.clear()
  }

  function setScene(renderables: Renderable[], options: RenderOptions): void {
    clearGroups()
    pickables = []
    const spec = repSpec(options.representation)
    for (const r of renderables) {
      const colors = computeAtomColors(r.structure, options)
      const visible = computeVisibility(r.structure, options, r.selected)
      const group = buildMolecule(r.structure, r.coords, spec, colors, visible, options.representation)
      if (r.transform) {
        group.position.set(...r.transform.position)
        group.quaternion.set(...r.transform.quaternion)
      }
      scene.add(group)
      groups.push(group)
      groupById.set(r.id, group)
      r.structure.atoms.forEach((atom, i) => {
        if (!visible[i]) return
        // Base coords (in the system's own frame) are returned by picks; world
        // coords (transform applied) are what the camera ray actually tests.
        const base = atomPos(r.structure, r.coords, i)
        const [x, y, z] = r.transform ? applyTransform(base, r.transform) : base
        pickables.push({
          systemId: r.id,
          atomIndex: i,
          name: atom.name,
          element: atom.element,
          x,
          y,
          z,
          bx: base[0],
          by: base[1],
          bz: base[2],
          radius: Math.max(spec.atomRadius(elementInfo(atom.element).vdwRadius), 0.4)
        })
      })
    }
    applyManipulation()
    const k = renderables.map((r) => r.id).join(',')
    if (k !== lastKey) {
      frameCameraToRenderables(renderables, camera, controls)
      lastKey = k
    }
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

function buildMolecule(
  structure: Structure,
  coords: Float32Array | null,
  spec: RepSpec,
  atomColors: number[],
  visible: boolean[],
  representation: Representation
): THREE.Group {
  const group = new THREE.Group()

  if (representation === 'tube') {
    const tube = buildBackboneTube(structure, coords)
    if (tube) {
      group.add(tube)
      return group
    }
    // No protein backbone (no CA atoms) — fall through to ball-and-stick.
  }

  group.add(buildAtoms(structure, coords, spec, atomColors, visible))
  if (structure.bonds.length > 0) {
    if (spec.bond === 'cylinder') {
      group.add(buildCylinderBonds(structure, coords, spec.bondRadius, atomColors, visible))
    } else if (spec.bond === 'line') {
      group.add(buildLineBonds(structure, coords, atomColors, visible))
    }
  }
  return group
}

// A smooth tube through the backbone (CA atoms) of each chain — a simple protein
// cartoon stand-in. Returns null if there is no protein backbone.
function buildBackboneTube(structure: Structure, coords: Float32Array | null): THREE.Group | null {
  const byChain = new Map<string, Array<{ seq: number; pos: THREE.Vector3 }>>()
  structure.atoms.forEach((a, i) => {
    if (a.name !== 'CA') return
    const [x, y, z] = atomPos(structure, coords, i)
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

function buildAtoms(
  structure: Structure,
  coords: Float32Array | null,
  spec: RepSpec,
  atomColors: number[],
  visible: boolean[]
): THREE.Mesh {
  const shown: number[] = []
  for (let i = 0; i < structure.atoms.length; i++) if (visible[i]) shown.push(i)

  const centers = new Float32Array(shown.length * 3)
  const radii = new Float32Array(shown.length)
  const colors = new Float32Array(shown.length * 3)
  const color = new THREE.Color()

  shown.forEach((atomIndex, k) => {
    const atom = structure.atoms[atomIndex]
    const [x, y, z] = atomPos(structure, coords, atomIndex)
    centers[k * 3] = x
    centers[k * 3 + 1] = y
    centers[k * 3 + 2] = z
    radii[k] = spec.atomRadius(elementInfo(atom.element).vdwRadius)
    color.set(atomColors[atomIndex])
    colors[k * 3] = color.r
    colors[k * 3 + 1] = color.g
    colors[k * 3 + 2] = color.b
  })

  return createImpostorSpheres({ centers, radii, colors, count: shown.length })
}

// Each bond is two half-cylinders so it takes the color of the nearer atom.
function buildCylinderBonds(
  structure: Structure,
  coords: Float32Array | null,
  radius: number,
  atomColors: number[],
  visible: boolean[]
): THREE.InstancedMesh {
  const drawn = structure.bonds.filter((b) => visible[b.a - 1] && visible[b.b - 1])
  const geometry = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true)
  const material = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.0 })
  const mesh = new THREE.InstancedMesh(geometry, material, drawn.length * 2)

  const dummy = new THREE.Object3D()
  const color = new THREE.Color()
  const start = new THREE.Vector3()
  const end = new THREE.Vector3()
  const mid = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)

  const placeHalf = (slot: number, from: THREE.Vector3, to: THREE.Vector3, colorHex: number): void => {
    const dir = new THREE.Vector3().subVectors(to, from)
    const length = dir.length() || 1e-6
    dummy.position.copy(from).addScaledVector(dir, 0.5)
    dummy.quaternion.setFromUnitVectors(up, dir.normalize())
    dummy.scale.set(radius, length, radius)
    dummy.updateMatrix()
    mesh.setMatrixAt(slot, dummy.matrix)
    mesh.setColorAt(slot, color.set(colorHex))
  }

  drawn.forEach((bond, k) => {
    const [ax, ay, az] = atomPos(structure, coords, bond.a - 1)
    const [bx, by, bz] = atomPos(structure, coords, bond.b - 1)
    start.set(ax, ay, az)
    end.set(bx, by, bz)
    mid.addVectors(start, end).multiplyScalar(0.5)
    placeHalf(k * 2, start, mid, atomColors[bond.a - 1])
    placeHalf(k * 2 + 1, end, mid, atomColors[bond.b - 1])
  })

  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  return mesh
}

function buildLineBonds(
  structure: Structure,
  coords: Float32Array | null,
  atomColors: number[],
  visible: boolean[]
): THREE.LineSegments {
  const drawn = structure.bonds.filter((b) => visible[b.a - 1] && visible[b.b - 1])
  const positions = new Float32Array(drawn.length * 6)
  const colors = new Float32Array(drawn.length * 6)
  const color = new THREE.Color()

  drawn.forEach((bond, k) => {
    const [ax, ay, az] = atomPos(structure, coords, bond.a - 1)
    const [bx, by, bz] = atomPos(structure, coords, bond.b - 1)
    positions.set([ax, ay, az, bx, by, bz], k * 6)
    color.set(atomColors[bond.a - 1])
    colors.set([color.r, color.g, color.b], k * 6)
    color.set(atomColors[bond.b - 1])
    colors.set([color.r, color.g, color.b], k * 6 + 3)
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
