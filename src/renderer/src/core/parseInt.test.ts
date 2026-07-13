import { describe, it, expect } from 'vitest'
import { parseTinkerInt } from './parseInt'
import type { AtomRecord } from './types'

// Real Tinker internal-coordinate file (N-methylacetamide).
const NMA = `    12  N-MethylAcetamide
     1  C     133
     2  C     127     1   1.51532
     3  N     129     2   1.35002     1  115.9627
     4  C     131     3   1.44084     2  121.4486     1 -180.0000     0
     5  O     128     2   1.23159     1  121.2687     3  122.7686     1
     6  H     134     1   1.11181     2  112.6054     3    0.0004     0
     7  H     134     1   1.11221     2  110.0102     6  107.9954     1
     8  H     134     1   1.11221     2  110.0103     6  107.9953    -1
     9  H     130     3   1.02840     2  121.8768     4  116.6746    -1
    10  H     132     4   1.11260     3  111.1006     2 -180.0000     0
    11  H     132     4   1.11276     3  111.5164    10  107.2890     1
    12  H     132     4   1.11276     3  111.5164    10  107.2890    -1
`

function dist(a: AtomRecord, b: AtomRecord): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function angleDeg(a: AtomRecord, vertex: AtomRecord, c: AtomRecord): number {
  const v1 = [a.x - vertex.x, a.y - vertex.y, a.z - vertex.z]
  const v2 = [c.x - vertex.x, c.y - vertex.y, c.z - vertex.z]
  const dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]
  const m1 = Math.hypot(v1[0], v1[1], v1[2])
  const m2 = Math.hypot(v2[0], v2[1], v2[2])
  return (Math.acos(dot / (m1 * m2)) * 180) / Math.PI
}

describe('parseTinkerInt', () => {
  it('parses header, atoms, types, and elements', () => {
    const s = parseTinkerInt(NMA)
    expect(s.title).toBe('N-MethylAcetamide')
    expect(s.atoms).toHaveLength(12)
    expect(s.atoms[0]).toMatchObject({ index: 1, name: 'C', element: 'C', type: 133 })
    expect(s.atoms[2].element).toBe('N')
    expect(s.atoms[4].element).toBe('O')
  })

  it('reconstructs z-matrix bond lengths and angles as Cartesian geometry', () => {
    const s = parseTinkerInt(NMA)
    const [a1, a2, a3] = s.atoms
    // First atom at the origin.
    expect(dist(a1, { x: 0, y: 0, z: 0 } as AtomRecord)).toBeCloseTo(0)
    // Bond lengths are preserved from the z-matrix.
    expect(dist(a1, a2)).toBeCloseTo(1.51532, 4)
    expect(dist(a2, a3)).toBeCloseTo(1.35002, 4)
    // The C-C-N angle is reproduced.
    expect(angleDeg(a1, a2, a3)).toBeCloseTo(115.9627, 2)
  })

  it('builds z-matrix bonds (11 bonds for a 12-atom tree)', () => {
    const s = parseTinkerInt(NMA)
    expect(s.bonds).toHaveLength(11)
    expect(s.bonds).toContainEqual({ a: 1, b: 2 })
    expect(s.bonds).toContainEqual({ a: 2, b: 3 })
  })
})
