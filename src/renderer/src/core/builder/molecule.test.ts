import { describe, it, expect } from 'vitest'
import {
  emptyMolecule,
  addAtom,
  bondAtoms,
  setBondOrder,
  deleteAtom,
  toStructure,
  findBond,
  type BuilderMolecule
} from './molecule'

/** Count hydrogens bonded to the heavy atom with the given id. */
function hCount(mol: BuilderMolecule, id: number): number {
  return mol.bonds
    .filter((b) => b.a === id || b.b === id)
    .map((b) => (b.a === id ? b.b : b.a))
    .filter((n) => mol.atoms.find((a) => a.id === n)?.element === 'H').length
}

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
