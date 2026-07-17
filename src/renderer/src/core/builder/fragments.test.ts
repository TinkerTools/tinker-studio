import { describe, it, expect } from 'vitest'
import {
  emptyMolecule,
  addAtom,
  addFragment,
  fuseRing,
  findBond,
  replaceAtomWithElement,
  toStructure,
  type BuilderMolecule
} from './molecule'
import { relax } from './relax'
import { FRAGMENTS } from './fragments'

const frag = (id: string) => FRAGMENTS.find((f) => f.id === id)!

function counts(mol: BuilderMolecule): Record<string, number> {
  const c: Record<string, number> = {}
  for (const a of mol.atoms) c[a.element] = (c[a.element] ?? 0) + 1
  return c
}

/** Count hydrogens bonded to the heavy atom with the given id. */
function hCount(mol: BuilderMolecule, id: number): number {
  return mol.bonds
    .filter((b) => b.a === id || b.b === id)
    .map((b) => (b.a === id ? b.b : b.a))
    .filter((n) => mol.atoms.find((a) => a.id === n)?.element === 'H').length
}

/** Number of double bonds among the heavy-atom skeleton. */
function doubleBondCount(mol: BuilderMolecule): number {
  return mol.bonds.filter((b) => b.order === 2).length
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

  describe('ring fusion', () => {
    /** The two atom ids of the first bond of the given order, or the first bond. */
    function anEdge(mol: BuilderMolecule, order = 1): [number, number] {
      const b = mol.bonds.find(
        (bd) =>
          bd.order === order &&
          mol.atoms.find((a) => a.id === bd.a)?.element !== 'H' &&
          mol.atoms.find((a) => a.id === bd.b)?.element !== 'H'
      )!
      return [b.a, b.b]
    }

    it('fuses benzene onto benzene to give naphthalene (C10H8)', () => {
      const mol = emptyMolecule()
      addFragment(mol, null, frag('benzene')) // C6H6
      const [a, b] = anEdge(mol, 2) // fuse across a ring double bond
      const newId = fuseRing(mol, a, b, frag('benzene'))
      expect(newId).not.toBeNull()
      // Naphthalene: 10 C, 8 H (the two shared bridgeheads lost their H).
      expect(counts(mol)).toEqual({ C: 10, H: 8 })
      // The bridgeheads are bare ring junctions (no hydrogen), the peripheral C keep one.
      expect(hCount(mol, a)).toBe(0)
      expect(hCount(mol, b)).toBe(0)
      // A valid Kekulé naphthalene has five C=C double bonds; every carbon has one.
      expect(doubleBondCount(mol)).toBe(5)
      for (const c of mol.atoms.filter((at) => at.element === 'C')) {
        const doublesAtC = mol.bonds.filter(
          (bd) => bd.order === 2 && (bd.a === c.id || bd.b === c.id)
        ).length
        expect(doublesAtC).toBe(1)
      }
      // Relaxes without blowing up (finite coordinates).
      relax(mol, 400)
      expect(mol.atoms.every((at) => Number.isFinite(at.x + at.y + at.z))).toBe(true)
    })

    it('the choice of shared edge (single vs double) still yields naphthalene', () => {
      const single = emptyMolecule()
      addFragment(single, null, frag('benzene'))
      const [a1, b1] = anEdge(single, 1) // fuse across a ring single bond
      expect(fuseRing(single, a1, b1, frag('benzene'))).not.toBeNull()
      expect(counts(single)).toEqual({ C: 10, H: 8 })
      expect(doubleBondCount(single)).toBe(5)
    })

    it('fuses cyclohexane onto cyclohexane to give decalin (C10H18)', () => {
      const mol = emptyMolecule()
      addFragment(mol, null, frag('cyclohexane')) // C6H12
      const [a, b] = anEdge(mol, 1)
      expect(fuseRing(mol, a, b, frag('cyclohexane'))).not.toBeNull()
      // Decalin C10H18: bridgeheads are CH methines, all bonds single.
      expect(counts(mol)).toEqual({ C: 10, H: 18 })
      expect(hCount(mol, a)).toBe(1)
      expect(hCount(mol, b)).toBe(1)
      expect(doubleBondCount(mol)).toBe(0)
    })

    it('post-fusion retype turns naphthalene into quinoline (N for a ring CH)', () => {
      // The recommended route to heteroaromatic fusions: build naphthalene, then
      // retype a ring carbon to nitrogen. A ring CH (one double, one single, one H)
      // becomes a bare pyridine-type N (no N–H) since N's valence is 3.
      const mol = emptyMolecule()
      addFragment(mol, null, frag('benzene'))
      const [a, b] = anEdge(mol, 2)
      fuseRing(mol, a, b, frag('benzene'))
      // Pick a peripheral ring carbon that still carries a hydrogen.
      const ch = mol.atoms.find((at) => at.element === 'C' && hCount(mol, at.id) === 1)!
      replaceAtomWithElement(mol, ch.id, 'N')
      expect(counts(mol)).toEqual({ C: 9, N: 1, H: 7 }) // quinoline C9H7N
      expect(hCount(mol, ch.id)).toBe(0) // ring N has no hydrogen
    })

    it('refuses to fuse across a non-bonded pair or through a heterocycle template', () => {
      const mol = emptyMolecule()
      addFragment(mol, null, frag('benzene'))
      const carbons = mol.atoms.filter((at) => at.element === 'C')
      // Two ring carbons that are para (not bonded) → no shared edge.
      const cA = carbons[0].id
      const cPara = carbons[3].id
      expect(findBond(mol, cA, cPara)).toBeUndefined()
      expect(fuseRing(mol, cA, cPara, frag('benzene'))).toBeNull()
      // Pyridine has no fuseEdge → not fusable (heteroatom position set by retyping).
      const [a, b] = anEdge(mol, 2)
      expect(fuseRing(mol, a, b, frag('pyridine'))).toBeNull()
      expect(counts(mol)).toEqual({ C: 6, H: 6 }) // unchanged
    })
  })
})
