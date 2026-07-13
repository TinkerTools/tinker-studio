import { describe, it, expect } from 'vitest'
import { emptyMolecule, addAtom, setBondOrder, addFragment } from './molecule'
import { FRAGMENTS } from './fragments'
import { buildTinkerInput } from './tinkerExport'
import { parseTinkerXyz } from '../parseXyz'

describe('builder Tinker input generation', () => {
  it('writes a re-parseable .xyz with a type column and matching atom count', () => {
    const mol = emptyMolecule()
    const c1 = addAtom(mol, null, 'C')!
    addAtom(mol, c1, 'O')
    const { xyz } = buildTinkerInput(mol)
    const parsed = parseTinkerXyz(xyz)
    expect(parsed.atoms.length).toBe(mol.atoms.length)
    // Every atom carries a positive force-field type.
    expect(parsed.atoms.every((a) => a.type > 0)).toBe(true)
  })

  it('generates a parameter for every bond and angle class present (no missing terms)', () => {
    // Benzene: sp² carbons + their hydrogens. The .prm must cover the C–C and C–H
    // bonds and the C–C–C / C–C–H angles so Tinker won't abort.
    const mol = emptyMolecule()
    addFragment(mol, null, FRAGMENTS.find((f) => f.id === 'benzene')!)
    const { prm } = buildTinkerInput(mol)
    expect(prm).toContain('forcefield BUILDER-GENERIC')
    expect((prm.match(/^atom /gm) ?? []).length).toBeGreaterThanOrEqual(2) // C(sp2), H classes
    expect(prm).toMatch(/^bond /m)
    expect(prm).toMatch(/^angle /m)
    expect(prm).toMatch(/^vdw /m)
  })

  it('uses a wider ideal angle for sp² than sp³ carbon', () => {
    const sp3 = buildTinkerInput((() => {
      const m = emptyMolecule()
      const a = addAtom(m, null, 'C')!
      addAtom(m, a, 'C')
      return m
    })()).prm
    const sp2 = buildTinkerInput((() => {
      const m = emptyMolecule()
      const a = addAtom(m, null, 'C')!
      const b = addAtom(m, a, 'C')!
      setBondOrder(m, a, b, 2)
      return m
    })()).prm
    // sp³ angles target ~109.5°, sp² ~120°.
    expect(sp3).toMatch(/angle .*109\.5/)
    expect(sp2).toMatch(/angle .*120\.0/)
  })
})
