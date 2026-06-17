import * as THREE from 'three'
import { TrackballControls } from 'three/addons/controls/TrackballControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import type { Structure } from '../core/types'
import { elementInfo } from '../core/elements'
import { DEFAULT_RENDER_OPTIONS, type RenderOptions, type Representation } from './renderOptions'
import { createImpostorSpheres } from './impostorSpheres'

/**
 * The Three.js viewport core. Atoms are GPU impostor spheres; bonds are
 * instanced cylinders or lines. Geometry is built from a Structure, optionally
 * overriding atom positions with a trajectory frame's coordinates (setFrame).
 */

export interface SceneHandle {
  setStructure(structure: Structure | null): void
  setOptions(options: RenderOptions): void
  /** Override atom positions with a trajectory frame (numAtoms*3), or null to reset. */
  setFrame(coords: Float32Array | null): void
  dispose(): void
}

interface RepSpec {
  atomRadius: (vdw: number) => number
  bond: 'cylinder' | 'line' | 'none'
  bondRadius: number
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

  // Trackball (not orbit) controls so the molecule tumbles freely in any
  // direction — orbit controls lock at the poles.
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

  let structure: Structure | null = null
  let options: RenderOptions = DEFAULT_RENDER_OPTIONS
  let frameCoords: Float32Array | null = null
  let molecule: THREE.Group | null = null

  function rebuild(): void {
    if (molecule) {
      scene.remove(molecule)
      disposeGroup(molecule)
      molecule = null
    }
    if (!structure || structure.atoms.length === 0) return
    molecule = buildMolecule(structure, options, frameCoords)
    scene.add(molecule)
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
    setStructure(next: Structure | null): void {
      structure = next
      frameCoords = null
      rebuild()
      if (structure) frameCamera(structure, camera, controls)
    },
    setOptions(next: RenderOptions): void {
      options = next
      rebuild()
    },
    setFrame(coords: Float32Array | null): void {
      frameCoords = coords
      rebuild()
    },
    dispose(): void {
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      controls.dispose()
      if (molecule) disposeGroup(molecule)
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

/** Position of atom i (0-based), from a trajectory frame if given, else the structure. */
function atomPos(structure: Structure, coords: Float32Array | null, i: number): [number, number, number] {
  if (coords) return [coords[i * 3], coords[i * 3 + 1], coords[i * 3 + 2]]
  const a = structure.atoms[i]
  return [a.x, a.y, a.z]
}

function buildMolecule(
  structure: Structure,
  options: RenderOptions,
  coords: Float32Array | null
): THREE.Group {
  const group = new THREE.Group()
  const spec = repSpec(options.representation)

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

// Each bond is two half-cylinders so it takes the color of the nearer atom.
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

function frameCamera(
  structure: Structure,
  camera: THREE.PerspectiveCamera,
  controls: TrackballControls
): void {
  const box = new THREE.Box3()
  const point = new THREE.Vector3()
  for (const atom of structure.atoms) {
    box.expandByPoint(point.set(atom.x, atom.y, atom.z))
  }
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
