import type { AtomRecord, BondRecord } from './types'
import { elementInfo } from './elements'

/**
 * Distance-based bond perception for formats without explicit connectivity
 * (e.g. PDB). Two atoms are bonded when their separation is below the sum of
 * their covalent radii plus a tolerance. A uniform spatial grid keeps this near
 * O(n) so it scales to proteins.
 */

const TOLERANCE = 0.45 // Å added to the summed covalent radii
const MIN_DISTANCE_SQ = 0.16 // (0.4 Å)^2 — reject coincident/overlapping atoms

export function perceiveBonds(atoms: AtomRecord[]): BondRecord[] {
  const n = atoms.length
  if (n < 2) return []

  const radii = atoms.map((a) => elementInfo(a.element).covalentRadius)
  const maxRadius = radii.reduce((m, r) => Math.max(m, r), 0)
  const cellSize = maxRadius * 2 + TOLERANCE // longest possible bond

  const grid = new Map<string, number[]>()
  const cellOf = (v: number): number => Math.floor(v / cellSize)
  const keyOf = (ix: number, iy: number, iz: number): string => `${ix},${iy},${iz}`

  atoms.forEach((a, i) => {
    const k = keyOf(cellOf(a.x), cellOf(a.y), cellOf(a.z))
    const bucket = grid.get(k)
    if (bucket) bucket.push(i)
    else grid.set(k, [i])
  })

  const bonds: BondRecord[] = []
  const seen = new Set<string>()

  for (let i = 0; i < n; i++) {
    const a = atoms[i]
    const cx = cellOf(a.x)
    const cy = cellOf(a.y)
    const cz = cellOf(a.z)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = grid.get(keyOf(cx + dx, cy + dy, cz + dz))
          if (!bucket) continue
          for (const j of bucket) {
            if (j <= i) continue
            const b = atoms[j]
            // Don't bond two hydrogens to each other.
            if (a.element === 'H' && b.element === 'H') continue
            const ex = a.x - b.x
            const ey = a.y - b.y
            const ez = a.z - b.z
            const distSq = ex * ex + ey * ey + ez * ez
            const cutoff = radii[i] + radii[j] + TOLERANCE
            if (distSq > MIN_DISTANCE_SQ && distSq < cutoff * cutoff) {
              const lo = Math.min(a.index, b.index)
              const hi = Math.max(a.index, b.index)
              const key = `${lo}-${hi}`
              if (!seen.has(key)) {
                seen.add(key)
                bonds.push({ a: lo, b: hi })
              }
            }
          }
        }
      }
    }
  }

  return bonds
}
