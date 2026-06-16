import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Structure } from '../core/types'
import { elementInfo } from '../core/elements'

/**
 * The Three.js viewport core. Intentionally "ours": no molecular viewer library,
 * just our own scene on top of Three.js / WebGL so every aspect of the rendering
 * is customizable.
 *
 * Atoms and bonds are drawn with InstancedMesh (one draw call each), which scales
 * comfortably to large systems. This is the ball-and-stick representation; GPU
 * impostor spheres/cylinders and post-processing (SSAO, outlines) are the next
 * rendering upgrade and will slot in behind this same interface.
 */

const BALL_SCALE = 0.4 // fraction of covalent radius used for ball-and-stick atoms
const MIN_ATOM_RADIUS = 0.25
const BOND_RADIUS = 0.12

export interface SceneHandle {
  setStructure(structure: Structure | null): void
  dispose(): void
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

  let molecule: THREE.Group | null = null

  function clearMolecule(): void {
    if (!molecule) return
    scene.remove(molecule)
    disposeGroup(molecule)
    molecule = null
  }

  function setStructure(structure: Structure | null): void {
    clearMolecule()
    if (!structure || structure.atoms.length === 0) return
    molecule = buildMolecule(structure)
    scene.add(molecule)
    frameCamera(structure, camera, controls)
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
    setStructure,
    dispose(): void {
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      controls.dispose()
      clearMolecule()
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

function buildMolecule(structure: Structure): THREE.Group {
  const group = new THREE.Group()
  const dummy = new THREE.Object3D()
  const color = new THREE.Color()

  // Atoms — instanced CPK-colored spheres.
  const sphereGeom = new THREE.SphereGeometry(1, 24, 24)
  const atomMaterial = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.0 })
  const atomMesh = new THREE.InstancedMesh(sphereGeom, atomMaterial, structure.atoms.length)
  structure.atoms.forEach((atom, i) => {
    const info = elementInfo(atom.element)
    const radius = Math.max(info.covalentRadius * BALL_SCALE, MIN_ATOM_RADIUS)
    dummy.position.set(atom.x, atom.y, atom.z)
    dummy.quaternion.identity()
    dummy.scale.setScalar(radius)
    dummy.updateMatrix()
    atomMesh.setMatrixAt(i, dummy.matrix)
    atomMesh.setColorAt(i, color.set(info.color))
  })
  atomMesh.instanceMatrix.needsUpdate = true
  if (atomMesh.instanceColor) atomMesh.instanceColor.needsUpdate = true
  group.add(atomMesh)

  // Bonds — instanced unit cylinders oriented along each bond.
  if (structure.bonds.length > 0) {
    const cylinderGeom = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true)
    const bondMaterial = new THREE.MeshStandardMaterial({
      color: 0x8b93a6,
      roughness: 0.5,
      metalness: 0.0
    })
    const bondMesh = new THREE.InstancedMesh(cylinderGeom, bondMaterial, structure.bonds.length)
    const start = new THREE.Vector3()
    const end = new THREE.Vector3()
    const direction = new THREE.Vector3()
    const up = new THREE.Vector3(0, 1, 0)

    structure.bonds.forEach((bond, i) => {
      const a = structure.atoms[bond.a - 1]
      const b = structure.atoms[bond.b - 1]
      start.set(a.x, a.y, a.z)
      end.set(b.x, b.y, b.z)
      direction.subVectors(end, start)
      const length = direction.length() || 1e-6
      dummy.position.copy(start).addScaledVector(direction, 0.5)
      dummy.quaternion.setFromUnitVectors(up, direction.clone().normalize())
      dummy.scale.set(BOND_RADIUS, length, BOND_RADIUS)
      dummy.updateMatrix()
      bondMesh.setMatrixAt(i, dummy.matrix)
    })
    bondMesh.instanceMatrix.needsUpdate = true
    group.add(bondMesh)
  }

  return group
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
    const mesh = object as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    const material = mesh.material
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else if (material) material.dispose()
  })
}
