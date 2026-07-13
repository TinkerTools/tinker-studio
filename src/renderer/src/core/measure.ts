/**
 * Geometric measurements between picked atom positions: distance (2 atoms),
 * angle (3, at the middle atom), and dihedral/torsion (4).
 */

export type Vec3 = [number, number, number]

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
]
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2])

/** Distance between two atoms (Å). */
export function distance(a: Vec3, b: Vec3): number {
  return len(sub(b, a))
}

/** Angle a–b–c at the middle atom b, in degrees. */
export function angle(a: Vec3, b: Vec3, c: Vec3): number {
  const u = sub(a, b)
  const v = sub(c, b)
  const cosine = dot(u, v) / (len(u) * len(v) || 1)
  return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI
}

/** Dihedral/torsion angle a–b–c–d, in degrees (−180, 180]. */
export function dihedral(a: Vec3, b: Vec3, c: Vec3, d: Vec3): number {
  const b1 = sub(b, a)
  const b2 = sub(c, b)
  const b3 = sub(d, c)
  const n1 = cross(b1, b2)
  const n2 = cross(b2, b3)
  const b2len = len(b2) || 1e-9
  const m1 = cross(n1, [b2[0] / b2len, b2[1] / b2len, b2[2] / b2len])
  const x = dot(n1, n2)
  const y = dot(m1, n2)
  return (Math.atan2(y, x) * 180) / Math.PI
}
