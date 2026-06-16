import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Structure } from '../core/types'
import { elementInfo } from '../core/elements'
import { DEFAULT_RENDER_OPTIONS, type RenderOptions, type Representation } from './renderOptions'

/**
 * The Three.js viewport core. Intentionally "ours": no molecular viewer library,
 * just our own scene on top of Three.js / WebGL so every aspect of the rendering
 * is customizable.
 *
 * Atoms and bonds are drawn with InstancedMesh (one draw call each), which scales
 * to large systems. Representation and color come from RenderOptions. GPU impostor
 * spheres/cylinders and post-processing (SSAO, outlines) are the next rendering
 * upgrade and will slot in behind this same interface.
 */

export interface SceneHandle {
  setStructure(structure: Structure | null): void
  setOptions(options: RenderOptions): void
  dispose(): void
}

interface RepSpec {
  /** Sphere radius for an atom given its van der Waals radius. */
  atomRadius: (vdw: number) => number
  bond: 'cylinder' | 'line' | 'none'
  bondRadius: number
  sphereDetail: number
}

function repSpec(rep: Representation): RepSpec {
  switch (rep) {
    case 'spacefill':
      return { atomRadius: (vdw) => vdw, bond: 'none', bondRadius: 0, sphereDetail: 32 }
    case 'sticks':
      return { atomRadius: () => 0.2, bond: 'cylinder', bondRadius: 0.2, sphereDetail: 16 }
    case 'wireframe':
      return { atomRadius: () => 0.12, bond: 'line', bondRadius: 0, sphereDetail: 12 }
    case 'ball-and-stick':
    default:
      return {
        atomRadius: (vdw) => Math.max(vdw * 0.3, 0.25),
        bond: 'cylinder',
        bondRadius: 0.1,
        sphereDetail: 20
      }
  }
}

export function createScene(container: HTMLElement): SceneHandle {
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(container.clientWidth, container.clientHeight)
  renderer.setClearColor(0x12141a, 1)
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, aspectOf(container), 0.1, 5000)
  camera.position.set(0, 0, 30)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08

  scene.add(new THREE.AmbientLight(0xffffff, 0.55))
  const key = new THREE.DirectionalLight(0xffffff, 1.3)
  key.position.set(5, 10, 7)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0x9bb0ff, 0.35)
  fill.position.set(-6, -3, -4)
  scene.add(fill)

  let structure: Structure | null = null
  let options: RenderOptions = DEFAULT_RENDER_OPTIONS
  let molecule: THREE.Group | null = null

  function rebuild(): void {
    if (molecule) {
      scene.remove(molecule)
      disposeGroup(molecule)
      molecule = null
    }
    if (!structure || structure.atoms.length === 0) return
    molecule = buildMolecule(structure, options)
    scene.add(molecule)
  }

  const resize = (): void => {
    const w = container.clientWidth
    const h = container.clientHeight
    if (w === 0 || h === 0) return
    renderer.setSize(w, h)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(container)

  let raf = 0
  const tick = (): void => {
    controls.update()
    renderer.render(scene, camera)
    raf = requestAnimationFrame(tick)
  }
  tick()

  return {
    setStructure(next: Structure | null): void {
      structure = next
      rebuild()
      if (structure) frameCamera(structure, camera, controls)
    },
    setOptions(next: RenderOptions): void {
      options = next
      rebuild()
    },
    dispose(): void {
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      controls.dispose()
      if (molecule) disposeGroup(molecule)
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

function buildMolecule(structure: Structure, options: RenderOptions): THREE.Group {
  const group = new THREE.Group()
  const spec = repSpec(options.representation)

  // Resolve a color (as a 0xRRGGBB number) for each atom.
  const atomColors = structure.atoms.map((atom) =>
    options.colorMode === 'uniform' ? options.uniformColor : elementInfo(atom.element).color
  )

  group.add(buildAtoms(structure, atomColors, spec))

  if (structure.bonds.length > 0) {
    if (spec.bond === 'cylinder') {
      group.add(buildCylinderBonds(structure, atomColors, spec.bondRadius))
    } else if (spec.bond === 'line') {
      group.add(buildLineBonds(structure, atomColors))
    }
  }

  return group
}

function buildAtoms(structure: Structure, atomColors: number[], spec: RepSpec): THREE.InstancedMesh {
  const geometry = new THREE.SphereGeometry(1, spec.sphereDetail, spec.sphereDetail)
  const material = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.0 })
  const mesh = new THREE.InstancedMesh(geometry, material, structure.atoms.length)
  const dummy = new THREE.Object3D()
  const color = new THREE.Color()

  structure.atoms.forEach((atom, i) => {
    const radius = spec.atomRadius(elementInfo(atom.element).vdwRadius)
    dummy.position.set(atom.x, atom.y, atom.z)
    dummy.quaternion.identity()
    dummy.scale.setScalar(radius)
    dummy.updateMatrix()
    mesh.setMatrixAt(i, dummy.matrix)
    mesh.setColorAt(i, color.set(atomColors[i]))
  })
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  return mesh
}

// Each bond is drawn as two half-cylinders so it takes the color of the nearer
// atom (the classic CPK split bond).
function buildCylinderBonds(
  structure: Structure,
  atomColors: number[],
  radius: number
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
    const a = structure.atoms[bond.a - 1]
    const b = structure.atoms[bond.b - 1]
    start.set(a.x, a.y, a.z)
    end.set(b.x, b.y, b.z)
    mid.addVectors(start, end).multiplyScalar(0.5)
    placeHalf(k * 2, start, mid, atomColors[bond.a - 1])
    placeHalf(k * 2 + 1, end, mid, atomColors[bond.b - 1])
  })

  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  return mesh
}

function buildLineBonds(structure: Structure, atomColors: number[]): THREE.LineSegments {
  const positions = new Float32Array(structure.bonds.length * 6)
  const colors = new Float32Array(structure.bonds.length * 6)
  const color = new THREE.Color()

  structure.bonds.forEach((bond, k) => {
    const a = structure.atoms[bond.a - 1]
    const b = structure.atoms[bond.b - 1]
    positions.set([a.x, a.y, a.z, b.x, b.y, b.z], k * 6)
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
  controls: OrbitControls
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
