import { describe, it, expect } from 'vitest'
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

describe('parseTinkerXyz', () => {
  it('parses ethanol: header, atoms, types, elements, connectivity', () => {
    const s = parseTinkerXyz(ETHANOL)
    expect(s.title).toBe('Ethanol')
    expect(s.atoms).toHaveLength(9)

    expect(s.atoms[0]).toMatchObject({ index: 1, name: 'C', element: 'C', type: 49 })
    expect(s.atoms[0].x).toBeCloseTo(-1.745979)
    expect(s.atoms[7].element).toBe('O')

    // Ethanol has 8 unique bonds (3x C-H, C-C, 2x C-H, C-O, O-H).
    expect(s.bonds).toHaveLength(8)
    expect(s.bonds).toContainEqual({ a: 1, b: 5 }) // C-C
    expect(s.bonds).toContainEqual({ a: 8, b: 9 }) // O-H
  })

  it('skips leading blank lines and keeps a multi-word title', () => {
    const s = parseTinkerXyz('\n\n  2  my molecule\n 1 C 0 0 0 1 2\n 2 O 1 0 0 2 1\n')
    expect(s.title).toBe('my molecule')
    expect(s.atoms).toHaveLength(2)
    expect(s.bonds).toHaveLength(1)
  })

  it('detects and stores a periodic box line', () => {
    const s = parseTinkerXyz('2 box\n18.6 18.6 18.6 90 90 90\n1 O 0 0 0 1 2\n2 H 1 0 0 2 1\n')
    expect(s.box).toEqual([18.6, 18.6, 18.6, 90, 90, 90])
    expect(s.atoms).toHaveLength(2)
  })

  it('remaps non-sequential atom indices and their bonds', () => {
    const s = parseTinkerXyz('2 renumber\n5 C 0 0 0 1 9\n9 O 1 0 0 2 5\n')
    expect(s.atoms.map((a) => a.index)).toEqual([1, 2])
    expect(s.bonds).toEqual([{ a: 1, b: 2 }])
  })

  it('throws on an invalid header', () => {
    expect(() => parseTinkerXyz('not a number\n')).toThrow()
  })
})
