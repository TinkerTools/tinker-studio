import type { Structure } from './types'

/** A rigid-body transform applied to a system: rotate (quaternion) then translate. */
export interface Transform {
  position: [number, number, number]
  /** Rotation quaternion [x, y, z, w]. */
  quaternion: [number, number, number, number]
}

export const IDENTITY_TRANSFORM: Transform = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }

export function isIdentityTransform(t?: Transform): boolean {
  if (!t) return true
  const [px, py, pz] = t.position
  const [qx, qy, qz, qw] = t.quaternion
  return px === 0 && py === 0 && pz === 0 && qx === 0 && qy === 0 && qz === 0 && qw === 1
}

/** Rotate a vector by a quaternion (x, y, z, w). */
function rotate(v: [number, number, number], q: [number, number, number, number]): [number, number, number] {
  const [x, y, z] = v
  const [qx, qy, qz, qw] = q
  const tx = 2 * (qy * z - qz * y)
  const ty = 2 * (qz * x - qx * z)
  const tz = 2 * (qx * y - qy * x)
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx)
  ]
}

/** Apply a transform (rotate then translate) to a point. */
export function applyTransform(p: [number, number, number], t: Transform): [number, number, number] {
  const r = rotate(p, t.quaternion)
  return [r[0] + t.position[0], r[1] + t.position[1], r[2] + t.position[2]]
}

/** Bake a transform into a structure's atom coordinates, returning a new structure. */
export function bakeTransform(structure: Structure, t?: Transform): Structure {
  if (isIdentityTransform(t)) return structure
  const tf = t as Transform
  return {
    ...structure,
    atoms: structure.atoms.map((a) => {
      const [x, y, z] = applyTransform([a.x, a.y, a.z], tf)
      return { ...a, x, y, z }
    })
  }
}
