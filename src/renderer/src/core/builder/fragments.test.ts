import { describe, it, expect } from 'vitest'
import { emptyMolecule, addAtom, addFragment, type BuilderMolecule } from './molecule'
import { FRAGMENTS } from './fragments'

const frag = (id: string) => FRAGMENTS.find((f) => f.id === id)!

function counts(mol: BuilderMolecule): Record<string, number> {
  const c: Record<string, number> = {}
  for (const a of mol.atoms) c[a.element] = (c[a.element] ?? 0) + 1
  return c
}

describe('builder fragments', () => {
  it('inserts benzene as C6H6 (one H per ring carbon)', () => {
    const mol = emptyMolecule()
    addFragment(mol, null, frag('benzene'))
    expect(counts(mol)).toEqual({ C: 6, H: 6 })
    // Pre-built planar coordinates: all ring carbons share z = 0.
    expect(mol.atoms.filter((a) => a.element === 'C').every((a) => Math.abs(a.z) < 1e-9)).toBe(true)
  })

  it('inserts heterocycles with correct heteroatom hydrogens', () => {
    // Pyridine: ring N has no H. Furan: ring O has no H. Pyrrole: ring N keeps 1 H.
    const py = emptyMolecule()
    addFragment(py, null, frag('pyridine'))
    expect(counts(py)).toEqual({ N: 1, C: 5, H: 5 })

    const fu = emptyMolecule()
    addFragment(fu, null, frag('furan'))
    expect(counts(fu)).toEqual({ O: 1, C: 4, H: 4 })

    const pyr = emptyMolecule()
    addFragment(pyr, null, frag('pyrrole'))
    expect(counts(pyr)).toEqual({ N: 1, C: 4, H: 5 }) // 4 C–H + 1 N–H
  })

  it('attaches benzene to a carbon as a phenyl substituent', () => {
    // Methane carbon, then attach benzene → toluene (C7H8).
    const mol = emptyMolecule()
    const c = addAtom(mol, null, 'C')!
    const attachId = addFragment(mol, c, frag('benzene'))
    expect(counts(mol)).toEqual({ C: 7, H: 8 })
    // The attach carbon is bonded to the methyl carbon and lost one of its H.
    const bondedToMethyl = mol.bonds.some(
      (b) => (b.a === c && b.b === attachId) || (b.a === attachId && b.b === c)
    )
    expect(bondedToMethyl).toBe(true)
  })

  it('carboxyl carries one C=O and one O–H', () => {
    const mol = emptyMolecule()
    addFragment(mol, null, frag('carboxyl'))
    // Formic acid HCOOH: 1 C, 2 O, 2 H (one on C, one on the hydroxyl O).
    expect(counts(mol)).toEqual({ C: 1, O: 2, H: 2 })
  })
})
