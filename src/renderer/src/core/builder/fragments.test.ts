import { describe, it, expect } from 'vitest'
import { emptyMolecule, addAtom, addFragment, toStructure, type BuilderMolecule } from './molecule'
import { relax } from './relax'
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

  it('gives cyclopropane two distinct H on every ring carbon (no overlap)', () => {
    // Regression: the two geminal hydrogens of the planar CH₂ were placed in the
    // same outward direction and landed on the exact same point — a degenerate
    // overlap relaxation could not split (the H–C–H angle spring vanishes at zero
    // separation and geminal pairs are excluded from clash). Each ring carbon
    // then appeared to have only one H.
    const mol = emptyMolecule()
    addFragment(mol, null, frag('cyclopropane'))
    expect(counts(mol)).toEqual({ C: 3, H: 6 })
    relax(mol, 600)
    const s = toStructure(mol)
    // No two atoms coincide (a real C–H bond is ~1.09 Å; H···H is larger still).
    let minPair = Infinity
    for (let i = 0; i < s.atoms.length; i++) {
      for (let j = i + 1; j < s.atoms.length; j++) {
        const a = s.atoms[i]
        const b = s.atoms[j]
        minPair = Math.min(minPair, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z))
      }
    }
    expect(minPair).toBeGreaterThan(0.7)
    // Every ring carbon carries exactly two hydrogens (cyclopropane is C₃H₆).
    for (const c of s.atoms.filter((a) => a.element === 'C')) {
      const h = c.bonds.filter((n) => s.atoms[n - 1].element === 'H').length
      expect(h).toBe(2)
    }
  })

  it('carboxyl carries one C=O and one O–H', () => {
    const mol = emptyMolecule()
    addFragment(mol, null, frag('carboxyl'))
    // Formic acid HCOOH: 1 C, 2 O, 2 H (one on C, one on the hydroxyl O).
    expect(counts(mol)).toEqual({ C: 1, O: 2, H: 2 })
  })
})
