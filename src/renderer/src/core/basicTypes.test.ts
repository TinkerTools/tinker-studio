import { describe, it, expect } from 'vitest'
import { basicAtomType, withBasicTypes, isUntyped } from './basicTypes'
import { parseTinkerXyz } from './parseXyz'

describe('basic.prm atom typing (10·Z + neighbors)', () => {
  it('matches the documented examples', () => {
    expect(basicAtomType('C', 4)).toBe(64) // tetravalent carbon
    expect(basicAtomType('C', 3)).toBe(63) // aromatic carbon
    expect(basicAtomType('H', 1)).toBe(11) // monovalent hydrogen
    expect(basicAtomType('O', 2)).toBe(82) // divalent oxygen
    expect(basicAtomType('N', 3)).toBe(73) // trivalent nitrogen
    expect(basicAtomType('Xx', 1)).toBe(0) // unknown element
  })

  it('types a whole structure from connectivity (methane → C 64, H 11)', () => {
    // Methane as a Tinker .xyz (types start at 0, i.e. untyped).
    const methane = [
      '    5  methane',
      '    1  C    0.000000    0.000000    0.000000    0    2    3    4    5',
      '    2  H    0.629000    0.629000    0.629000    0    1',
      '    3  H   -0.629000   -0.629000    0.629000    0    1',
      '    4  H   -0.629000    0.629000   -0.629000    0    1',
      '    5  H    0.629000   -0.629000   -0.629000    0    1'
    ].join('\n')
    const s = parseTinkerXyz(methane)
    expect(isUntyped(s)).toBe(true)

    const typed = withBasicTypes(s)
    expect(isUntyped(typed)).toBe(false)
    expect(typed.atoms[0].type).toBe(64) // carbon, 4 neighbors
    expect(typed.atoms.slice(1).every((a) => a.type === 11)).toBe(true) // hydrogens
    // Original structure is untouched (pure function).
    expect(isUntyped(s)).toBe(true)
  })
})
