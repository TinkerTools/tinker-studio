import { describe, it, expect } from 'vitest'
import { parseSdf } from './parseSdf'

// Minimal V2000 molfile for water (the shape PubChem/NCI return).
const WATER_SDF = `water
  -TEST-

  3  2  0  0  0  0  0  0  0  0999 V2000
    0.0000    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0
    0.7570    0.5860    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
   -0.7570    0.5860    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0  0  0  0
  1  3  1  0  0  0  0
M  END
`

describe('parseSdf', () => {
  it('reads title, atoms (element + coords), and explicit bonds', () => {
    const s = parseSdf(WATER_SDF)
    expect(s.title).toBe('water')
    expect(s.atoms).toHaveLength(3)
    expect(s.atoms.map((a) => a.element)).toEqual(['O', 'H', 'H'])
    expect(s.atoms[1].x).toBeCloseTo(0.757)
    expect(s.bonds).toHaveLength(2)
    expect(s.bonds).toContainEqual({ a: 1, b: 2 })
    expect(s.bonds).toContainEqual({ a: 1, b: 3 })
  })

  it('throws when there is no valid atom count (e.g. no 3D record)', () => {
    expect(() => parseSdf('not\na\nmolfile')).toThrow()
  })
})
