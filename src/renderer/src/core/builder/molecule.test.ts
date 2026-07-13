import { describe, it, expect } from 'vitest'
import {
  emptyMolecule,
  addAtom,
  bondAtoms,
  setBondOrder,
  deleteAtom,
  replaceAtomWithElement,
  replaceAtomWithFragment,
  toStructure,
  findBond,
  type BuilderMolecule
} from './molecule'
import { FRAGMENTS } from './fragments'

/** Count hydrogens bonded to the heavy atom with the given id. */
function hCount(mol: BuilderMolecule, id: number): number {
  return mol.bonds
    .filter((b) => b.a === id || b.b === id)
    .map((b) => (b.a === id ? b.b : b.a))
    .filter((n) => mol.atoms.find((a) => a.id === n)?.element === 'H').length
}

/** Ids of hydrogens bonded to the given atom. */
function hydrogensOf(mol: BuilderMolecule, id: number): number[] {
  return mol.bonds
    .filter((b) => b.a === id || b.b === id)
    .map((b) => (b.a === id ? b.b : b.a))
    .filter((n) => mol.atoms.find((a) => a.id === n)?.element === 'H')
}

function counts(mol: BuilderMolecule): Record<string, number> {
  const c: Record<string, number> = {}
  for (const a of mol.atoms) c[a.element] = (c[a.element] ?? 0) + 1
  return c
}
const frag = (id: string) => FRAGMENTS.find((f) => f.id === id)!

describe('builder molecule valence filling', () => {
  it('seeds a carbon as methane (4 H)', () => {
    const mol = emptyMolecule()
    const c = addAtom(mol, null, 'C')!
    expect(mol.atoms.length).toBe(5) // C + 4 H
    expect(hCount(mol, c)).toBe(4)
  })

  it('fills nitrogen with 3 H and oxygen with 2 H', () => {
    const mol = emptyMolecule()
    const n = addAtom(mol, null, 'N')!
    expect(hCount(mol, n)).toBe(3)
    const mol2 = emptyMolecule()
    const o = addAtom(mol2, null, 'O')!
    expect(hCount(mol2, o)).toBe(2)
  })

  it('bonding two carbons gives ethane (each CH3)', () => {
    const mol = emptyMolecule()
    const c1 = addAtom(mol, null, 'C')!
    const c2 = addAtom(mol, c1, 'C')!
    expect(hCount(mol, c1)).toBe(3)
    expect(hCount(mol, c2)).toBe(3)
  })

  it('a double bond drops one H on each carbon (ethene)', () => {
    const mol = emptyMolecule()
    const c1 = addAtom(mol, null, 'C')!
    const c2 = addAtom(mol, c1, 'C')!
    setBondOrder(mol, c1, c2, 2)
    expect(hCount(mol, c1)).toBe(2)
    expect(hCount(mol, c2)).toBe(2)
  })

  it('a triple bond drops two H on each carbon (acetylene)', () => {
    const mol = emptyMolecule()
    const c1 = addAtom(mol, null, 'C')!
    const c2 = addAtom(mol, c1, 'C')!
    setBondOrder(mol, c1, c2, 3)
    expect(hCount(mol, c1)).toBe(1)
    expect(hCount(mol, c2)).toBe(1)
  })

  it('manual H removal sticks across later edits', () => {
    const mol = emptyMolecule()
    const c = addAtom(mol, null, 'C')!
    const anH = mol.bonds
      .map((b) => (b.a === c ? b.b : b.a))
      .find((id) => mol.atoms.find((a) => a.id === id)?.element === 'H')!
    deleteAtom(mol, anH)
    expect(hCount(mol, c)).toBe(3)
    // An unrelated reconcile-triggering edit must not bring the H back.
    const c2 = addAtom(mol, c, 'C')!
    expect(hCount(mol, c)).toBe(2) // 3 − 1 for the new C bond
    expect(c2).toBeGreaterThan(0)
  })

  it('closing a ring frees no extra H but adds the bond', () => {
    // Build a 3-carbon chain, then bond the ends into a ring.
    const mol = emptyMolecule()
    const c1 = addAtom(mol, null, 'C')!
    const c2 = addAtom(mol, c1, 'C')!
    const c3 = addAtom(mol, c2, 'C')!
    expect(hCount(mol, c1)).toBe(3)
    const ok = bondAtoms(mol, c1, c3)
    expect(ok).toBe(true)
    expect(findBond(mol, c1, c3)).toBeTruthy()
    // c1 and c3 each gained a heavy bond, so each loses one H (3 → 2).
    expect(hCount(mol, c1)).toBe(2)
    expect(hCount(mol, c3)).toBe(2)
  })

  it('refuses to bond hydrogens or duplicate a bond', () => {
    const mol = emptyMolecule()
    const c1 = addAtom(mol, null, 'C')!
    const c2 = addAtom(mol, c1, 'C')!
    expect(bondAtoms(mol, c1, c2)).toBe(false) // already bonded
    expect(bondAtoms(mol, c1, c1)).toBe(false) // self
  })

  describe('Spartan-style click-to-replace', () => {
    it('promotes a clicked hydrogen to a heavy atom, growing the molecule (methane → ethane)', () => {
      const mol = emptyMolecule()
      const c = addAtom(mol, null, 'C')! // methane: C + 4 H
      const h = hydrogensOf(mol, c)[0]
      const changed = replaceAtomWithElement(mol, h, 'C')
      expect(changed).toBe(true)
      // The former hydrogen is now a carbon with its own 3 H; the parent keeps 3 H.
      expect(mol.atoms.find((a) => a.id === h)!.element).toBe('C')
      expect(hCount(mol, h)).toBe(3)
      expect(hCount(mol, c)).toBe(3)
      expect(counts(mol)).toEqual({ C: 2, H: 6 }) // ethane
    })

    it('retypes a heavy atom in place, refilling hydrogens to the new valence', () => {
      const mol = emptyMolecule()
      const c = addAtom(mol, null, 'C')! // CH4
      expect(replaceAtomWithElement(mol, c, 'N')).toBe(true)
      expect(counts(mol)).toEqual({ N: 1, H: 3 }) // ammonia
      expect(replaceAtomWithElement(mol, c, 'O')).toBe(true)
      expect(counts(mol)).toEqual({ O: 1, H: 2 }) // water
    })

    it('keeps a retyped atom bonded to its heavy neighbour (ethane C → N gives an amine)', () => {
      const mol = emptyMolecule()
      const c1 = addAtom(mol, null, 'C')!
      const c2 = addAtom(mol, c1, 'C')! // ethane
      replaceAtomWithElement(mol, c2, 'N')
      expect(findBond(mol, c1, c2)).toBeTruthy() // still bonded
      expect(hCount(mol, c2)).toBe(2) // N with one heavy bond → 2 H (methylamine N)
      expect(counts(mol)).toEqual({ C: 1, N: 1, H: 5 })
    })

    it('replacing with H caps the position (terminal carbon → hydrogen)', () => {
      const mol = emptyMolecule()
      const c1 = addAtom(mol, null, 'C')!
      const c2 = addAtom(mol, c1, 'C')! // ethane
      expect(replaceAtomWithElement(mol, c2, 'H')).toBe(true)
      expect(counts(mol)).toEqual({ C: 1, H: 4 }) // back to methane
    })

    it('is a no-op when the atom already is that element', () => {
      const mol = emptyMolecule()
      const c = addAtom(mol, null, 'C')!
      expect(replaceAtomWithElement(mol, c, 'C')).toBe(false)
      expect(counts(mol)).toEqual({ C: 1, H: 4 })
    })

    it('grows a fragment off a clicked hydrogen (methane + benzene → toluene)', () => {
      const mol = emptyMolecule()
      const c = addAtom(mol, null, 'C')! // CH4
      const h = hydrogensOf(mol, c)[0]
      const attach = replaceAtomWithFragment(mol, h, frag('benzene'))
      expect(attach).not.toBeNull()
      expect(counts(mol)).toEqual({ C: 7, H: 8 }) // toluene C7H8
      expect(findBond(mol, c, attach!)).toBeTruthy() // methyl bonded to the ring
    })

    it('swaps a terminal heavy atom for a fragment (ethane methyl → cyclohexane)', () => {
      const mol = emptyMolecule()
      const c1 = addAtom(mol, null, 'C')!
      const c2 = addAtom(mol, c1, 'C')! // ethane
      const attach = replaceAtomWithFragment(mol, c2, frag('cyclohexane'))
      expect(attach).not.toBeNull()
      // Methylcyclohexane: 7 C, 14 H.
      expect(counts(mol)).toEqual({ C: 7, H: 14 })
      expect(findBond(mol, c1, attach!)).toBeTruthy()
    })

    it('bonds two atoms at a chosen order, dropping hydrogens to fit (double → ethene)', () => {
      // Two separate methanes; bonding them as a double bond forms ethene, and each
      // carbon must shed two hydrogens (CH4 → CH2) to make room for the C=C.
      const mol = emptyMolecule()
      const c1 = addAtom(mol, null, 'C')!
      addAtom(mol, null, 'C') // second, unbonded methane
      const c2 = mol.atoms.find((a) => a.element === 'C' && a.id !== c1)!.id
      expect(bondAtoms(mol, c1, c2, 2)).toBe(true)
      expect(hCount(mol, c1)).toBe(2)
      expect(hCount(mol, c2)).toBe(2)
      expect(counts(mol)).toEqual({ C: 2, H: 4 }) // ethene C2H4
    })

    it('re-orders an existing bond, adding hydrogens back (double → single)', () => {
      const mol = emptyMolecule()
      const c1 = addAtom(mol, null, 'C')!
      const c2 = addAtom(mol, c1, 'C')!
      setBondOrder(mol, c1, c2, 2) // ethene
      expect(counts(mol)).toEqual({ C: 2, H: 4 })
      setBondOrder(mol, c1, c2, 1) // back to ethane: each C regains one H
      expect(hCount(mol, c1)).toBe(3)
      expect(hCount(mol, c2)).toBe(3)
      expect(counts(mol)).toEqual({ C: 2, H: 6 })
    })

    it('refuses to graft a fragment onto a bridging atom (2+ heavy neighbours)', () => {
      const mol = emptyMolecule()
      const c1 = addAtom(mol, null, 'C')!
      const c2 = addAtom(mol, c1, 'C')!
      addAtom(mol, c2, 'C') // propane; c2 now bridges c1 and c3
      const before = counts(mol)
      expect(replaceAtomWithFragment(mol, c2, frag('benzene'))).toBeNull()
      expect(counts(mol)).toEqual(before) // unchanged
    })
  })

  it('exports orderless connectivity to a Structure', () => {
    const mol = emptyMolecule()
    const c1 = addAtom(mol, null, 'C')!
    addAtom(mol, c1, 'O')
    const s = toStructure(mol)
    expect(s.atoms.length).toBe(mol.atoms.length)
    // Every atom index is 1-based and sequential.
    expect(s.atoms.map((a) => a.index)).toEqual(s.atoms.map((_, i) => i + 1))
    // Bonds reference valid indices with a < b.
    for (const b of s.bonds) {
      expect(b.a).toBeLessThan(b.b)
      expect(b.a).toBeGreaterThanOrEqual(1)
      expect(b.b).toBeLessThanOrEqual(s.atoms.length)
    }
  })
})
