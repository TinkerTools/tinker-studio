import { describe, it, expect } from 'vitest'
import { writeTinkerXyz } from './writeXyz'
import { parseTinkerXyz } from './parseXyz'

const ETHANOL = `     9  Ethanol
     1  C     -1.745979    1.106694    1.225781    49     2     3     4     5
     2  H     -1.675959    0.626158    2.226893    50     1
     3  H     -0.836580    1.733422    1.088667    50     1
     4  H     -2.624230    1.789704    1.242336    50     1
     5  C     -1.874638    0.067519    0.109528    47     1     6     7     8
     6  H     -2.785744   -0.555578    0.253129    48     5
     7  H     -1.962493    0.576760   -0.876039    48     5
     8  O     -0.720620   -0.754349    0.101531    45     5     9
     9  H     -0.857171   -1.462041    0.717328    46     8
`

describe('writeTinkerXyz', () => {
  it('round-trips a structure (parse → write → parse)', () => {
    const original = parseTinkerXyz(ETHANOL)
    const reparsed = parseTinkerXyz(writeTinkerXyz(original))

    expect(reparsed.title).toBe('Ethanol')
    expect(reparsed.atoms).toHaveLength(original.atoms.length)
    expect(reparsed.bonds).toHaveLength(original.bonds.length)

    reparsed.atoms.forEach((a, i) => {
      expect(a.element).toBe(original.atoms[i].element)
      expect(a.type).toBe(original.atoms[i].type)
      expect(a.x).toBeCloseTo(original.atoms[i].x, 5)
      expect(a.z).toBeCloseTo(original.atoms[i].z, 5)
    })
    expect(reparsed.bonds).toContainEqual({ a: 1, b: 5 })
    expect(reparsed.bonds).toContainEqual({ a: 8, b: 9 })
  })
})
