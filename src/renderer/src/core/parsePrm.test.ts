import { describe, it, expect } from 'vitest'
import { parsePrm, applyForceField } from './parsePrm'
import type { Structure } from './types'

const FIXED_CHARGE_PRM = `
# comment line
atom          1    1    CT    "RCH3 Alkane"                  6    12.000    4
atom          5    5    HC    "Alkane H-C"                   1     1.008    1
charge        1              -0.1800
charge        5               0.0600
`

const AMOEBA_PRM = `
atom          1    1    N     "Glycine N"                    7    14.007    3
multipole     1    2    4              -0.22483
                                        0.12482    0.00000    0.32382
`

describe('parsePrm', () => {
  it('reads atom (element) and charge records', () => {
    const ff = parsePrm(FIXED_CHARGE_PRM)
    expect(ff.elementForType.get(1)).toBe('C')
    expect(ff.elementForType.get(5)).toBe('H')
    expect(ff.chargeForType.get(1)).toBeCloseTo(-0.18)
    expect(ff.chargeForType.get(5)).toBeCloseTo(0.06)
  })

  it('uses the multipole monopole as the charge for AMOEBA force fields', () => {
    const ff = parsePrm(AMOEBA_PRM)
    expect(ff.elementForType.get(1)).toBe('N')
    expect(ff.chargeForType.get(1)).toBeCloseTo(-0.22483)
  })

  it('applies a force field to a structure (element + charge from type)', () => {
    const structure: Structure = {
      title: 't',
      atoms: [
        { index: 1, name: 'CT', element: 'X', x: 0, y: 0, z: 0, type: 1, bonds: [] },
        { index: 2, name: 'HC', element: 'X', x: 1, y: 0, z: 0, type: 5, bonds: [] }
      ],
      bonds: []
    }
    const out = applyForceField(structure, parsePrm(FIXED_CHARGE_PRM))
    expect(out.atoms.map((a) => a.element)).toEqual(['C', 'H'])
    expect(out.atoms[0].charge).toBeCloseTo(-0.18)
  })
})
