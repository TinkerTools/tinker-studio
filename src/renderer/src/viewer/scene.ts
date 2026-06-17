import * as THREE from 'three'
import { TrackballControls } from 'three/addons/controls/TrackballControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import type { Structure } from '../core/types'
import { elementInfo } from '../core/elements'
import { type RenderOptions, type Representation } from './renderOptions'
import { createImpostorSpheres } from './impostorSpheres'

/**
 * The Three.js viewport core. Renders one or more systems at once (setScene),
 * supports CPU ray-sphere picking of atoms, and highlight markers. Atoms are GPU
 * impostor spheres; bonds are instanced cylinders or lines.
 */

export interface Renderable {
  id: string
  structure: Structure
  /** Trajectory frame coordinates (numAtoms*3), or null for the base structure. */
  coords: Float32Array | null
}

export interface PickResult {
  systemId: string
  atomIndex: number // 0-based index into structure.atoms
  name: string
  element: string
  position: [number, number, number]
}

export interface SceneHandle {
  setScene(renderables: Renderable[], options: RenderOptions): void
  pick(clientX: number, clientY: number): PickResult | null
  setHighlights(points: Array<[number, number, number]>): void
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
  x: number
  y: number
  z: number
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
    default:
      return { atomRadius: (vdw) => Math.max(vdw * 0.3, 0.25), bond: 'cylinder', bondRadius: 0.1 }
  }
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
  let highlightGroup: THREE.Group | null = null
  let pickables: Pickable[] = []
  let lastKey = ''
  const raycaster = new THREE.Raycaster()

  function clearGroups(): void {
    for (const g of groups) {
      scene.remove(g)
      disposeGroup(g)
    }
    groups = []
  }

  function setScene(renderables: Renderable[], options: RenderOptions): void {
    clearGroups()
    pickables = []
    const spec = repSpec(options.representation)
    for (const r of renderables) {
      const group = buildMolecule(r.structure, options, r.coords, spec)
      scene.add(group)
      groups.push(group)
      r.structure.atoms.forEach((atom, i) => {
        const [x, y, z] = atomPos(r.structure, r.coords, i)
        pickables.push({
          systemId: r.id,
          atomIndex: i,
          name: atom.name,
          element: atom.element,
          x,
          y,
          z,
          radius: Math.max(spec.atomRadius(elementInfo(atom.element).vdwRadius), 0.4)
        })
      })
    }
    const key = renderables.map((r) => r.id).join(',')
    if (key !== lastKey) {
      frameCameraToRenderables(renderables, camera, controls)
      lastKey = key
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
      position: [best.x, best.y, best.z]
    }
  }

  function setHighlights(points: Array<[number, number, number]>): void {
    if (highlightGroup) {
      scene.remove(highlightGroup)
      disposeGroup(highlightGroup)
      highlightGroup = null
    }
    if (points.length === 0) return
    const group = new THREE.Group()
    const geometry = new THREE.SphereGeometry(1, 16, 16)
    const material = new THREE.MeshBasicMaterial({
      color: 0xffd400,
      transparent: true,
      opacity: 0.5,
      depthTest: false
    })
    for (const [x, y, z] of points) {
      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.set(x, y, z)
      mesh.scale.setScalar(0.55)
      mesh.renderOrder = 999
      group.add(mesh)
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
    dispose(): void {
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      controls.dispose()
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
  options: RenderOptions,
  coords: Float32Array | null,
  spec: RepSpec
): THREE.Group {
  const group = new THREE.Group()

  const atomColors = structure.atoms.map((atom) =>
    options.colorMode === 'uniform' ? options.uniformColor : elementInfo(atom.element).color
  )

  group.add(buildAtoms(structure, atomColors, spec, coords))

  if (structure.bonds.length > 0) {
    if (spec.bond === 'cylinder') {
      group.add(buildCylinderBonds(structure, atomColors, spec.bondRadius, coords))
    } else if (spec.bond === 'line') {
      group.add(buildLineBonds(structure, atomColors, coords))
    }
  }

  return group
}

function buildAtoms(
  structure: Structure,
  atomColors: number[],
  spec: RepSpec,
  coords: Float32Array | null
): THREE.Mesh {
  const n = structure.atoms.length
  const centers = new Float32Array(n * 3)
  const radii = new Float32Array(n)
  const colors = new Float32Array(n * 3)
  const color = new THREE.Color()

  structure.atoms.forEach((atom, i) => {
    const [x, y, z] = atomPos(structure, coords, i)
    centers[i * 3] = x
    centers[i * 3 + 1] = y
    centers[i * 3 + 2] = z
    radii[i] = spec.atomRadius(elementInfo(atom.element).vdwRadius)
    color.set(atomColors[i])
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b
  })

  return createImpostorSpheres({ centers, radii, colors, count: n })
}

function buildCylinderBonds(
  structure: Structure,
  atomColors: number[],
  radius: number,
  coords: Float32Array | null
): THREE.InstancedMesh {
  const geometry = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true)
  const material = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.0 })
  const mesh = new THREE.InstancedMesh(geometry, material, structure.bonds.length * 2)

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

  structure.bonds.forEach((bond, k) => {
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
  atomColors: number[],
  coords: Float32Array | null
): THREE.LineSegments {
  const positions = new Float32Array(structure.bonds.length * 6)
  const colors = new Float32Array(structure.bonds.length * 6)
  const color = new THREE.Color()

  structure.bonds.forEach((bond, k) => {
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

function frameCameraToRenderables(
  renderables: Renderable[],
  camera: THREE.PerspectiveCamera,
  controls: TrackballControls
): void {
  const box = new THREE.Box3()
  const point = new THREE.Vector3()
  for (const r of renderables) {
    r.structure.atoms.forEach((_atom, i) => {
      const [x, y, z] = atomPos(r.structure, r.coords, i)
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
    const obj = object as THREE.Mesh | THREE.LineSegments
    if (obj.geometry) obj.geometry.dispose()
    const material = obj.material
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else if (material) material.dispose()
  })
}
