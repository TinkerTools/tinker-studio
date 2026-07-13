import { describe, it, expect } from 'vitest'
import { emptyMolecule, addAtom, bondAtoms, setBondOrder, type BuilderMolecule } from './molecule'
import { relax } from './relax'

function dist(mol: BuilderMolecule, i: number, j: number): number {
  const a = mol.atoms.find((x) => x.id === i)!
  const b = mol.atoms.find((x) => x.id === j)!
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function angleDeg(mol: BuilderMolecule, i: number, c: number, j: number): number {
  const a = mol.atoms.find((x) => x.id === i)!
  const b = mol.atoms.find((x) => x.id === c)!
  const d = mol.atoms.find((x) => x.id === j)!
  const u = [a.x - b.x, a.y - b.y, a.z - b.z]
  const v = [d.x - b.x, d.y - b.y, d.z - b.z]
  const cos =
    (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) /
    (Math.hypot(...u) * Math.hypot(...v))
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
}

describe('builder geometry relaxation', () => {
  it('relaxes methane toward tetrahedral H–C–H angles', () => {
    const mol = emptyMolecule()
    const c = addAtom(mol, null, 'C')!
    relax(mol, 400)
    const hs = mol.bonds.filter((b) => b.a === c || b.b === c).map((b) => (b.a === c ? b.b : b.a))
    expect(hs.length).toBe(4)
    // Average of all H–C–H angles should be near 109.5°.
    let sum = 0
    let count = 0
    for (let i = 0; i < hs.length; i++) {
      for (let j = i + 1; j < hs.length; j++) {
        sum += angleDeg(mol, hs[i], c, hs[j])
        count += 1
      }
    }
    expect(sum / count).toBeGreaterThan(104)
    expect(sum / count).toBeLessThan(115)
  })

  it('relaxes bond lengths near the ideal C–C single bond (~1.5 Å)', () => {
    const mol = emptyMolecule()
    const c1 = addAtom(mol, null, 'C')!
    const c2 = addAtom(mol, c1, 'C')!
    relax(mol, 400)
    expect(dist(mol, c1, c2)).toBeGreaterThan(1.4)
    expect(dist(mol, c1, c2)).toBeLessThan(1.65)
  })

  it('makes ethene roughly planar with ~120° angles', () => {
    const mol = emptyMolecule()
    const c1 = addAtom(mol, null, 'C')!
    const c2 = addAtom(mol, c1, 'C')!
    setBondOrder(mol, c1, c2, 2)
    relax(mol, 600)
    // An H–C=C angle should be near 120°.
    const h1 = mol.bonds
      .filter((b) => (b.a === c1 || b.b === c1))
      .map((b) => (b.a === c1 ? b.b : b.a))
      .find((id) => mol.atoms.find((a) => a.id === id)?.element === 'H')!
    const a = angleDeg(mol, h1, c1, c2)
    expect(a).toBeGreaterThan(112)
    expect(a).toBeLessThan(128)
  })

  it('grows a carbon chain without coincident atoms (placement jitter)', () => {
    // Regression: geminal hydrogens once landed on the exact same point (raw bond
    // averaging + 1-3 clash exclusion), which relaxation could not separate.
    const mol = emptyMolecule()
    let prev: number | null = null
    for (let nC = 1; nC <= 3; nC++) {
      prev = addAtom(mol, prev, 'C')!
      relax(mol)
      let minD = Infinity
      for (let i = 0; i < mol.atoms.length; i++) {
        for (let j = i + 1; j < mol.atoms.length; j++) {
          const a = mol.atoms[i]
          const b = mol.atoms[j]
          minD = Math.min(minD, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z))
        }
      }
      // No two atoms should be closer than a fraction of a bond length.
      expect(minD).toBeGreaterThan(0.8)
    }
    // Propane: methyl carbons keep 3 H, the middle carbon 2 H.
    const hOf = (id: number): number =>
      mol.bonds
        .filter((b) => b.a === id || b.b === id)
        .map((b) => (b.a === id ? b.b : b.a))
        .filter((nb) => mol.atoms.find((a) => a.id === nb)?.element === 'H').length
    const carbons = mol.atoms.filter((a) => a.element === 'C').map((a) => a.id)
    expect(carbons.map(hOf).sort()).toEqual([2, 3, 3])
  })

  it('flattens benzene to roughly planar (sp²–sp² torsion term)', () => {
    const mol = emptyMolecule()
    const ids: number[] = []
    let prev: number | null = null
    for (let i = 0; i < 6; i++) {
      prev = addAtom(mol, prev, 'C')!
      ids.push(prev)
    }
    bondAtoms(mol, ids[0], ids[5])
    for (let i = 0; i < 6; i += 2) setBondOrder(mol, ids[i], ids[(i + 1) % 6], 2)
    relax(mol, 1500)

    // Fit a plane through the first three ring carbons; the rest should lie close
    // to it. The lightweight engine flattens the ring substantially (from ~1.8 Å
    // out-of-plane unconstrained) but not perfectly — exact geometry is the job of
    // the optional post-load Tinker minimize.
    const p = (id: number): number[] => {
      const a = mol.atoms.find((x) => x.id === id)!
      return [a.x, a.y, a.z]
    }
    const [a, b, c] = [p(ids[0]), p(ids[1]), p(ids[2])]
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const nrm = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0]
    ]
    const nlen = Math.hypot(...nrm)
    for (const id of ids.slice(3)) {
      const q = p(id)
      const dplane =
        Math.abs(
          nrm[0] * (q[0] - a[0]) + nrm[1] * (q[1] - a[1]) + nrm[2] * (q[2] - a[2])
        ) / nlen
      expect(dplane).toBeLessThan(0.4)
    }
  })

  it('closes a 6-membered ring with normal C–C bond lengths', () => {
    // Build a 6-carbon chain, then bond the ends to close a cyclohexane-like ring.
    const mol = emptyMolecule()
    const ids: number[] = []
    let prev: number | null = null
    for (let i = 0; i < 6; i++) {
      prev = addAtom(mol, prev, 'C')!
      ids.push(prev)
    }
    bondAtoms(mol, ids[0], ids[5])
    relax(mol, 1200)
    // Every ring bond (including the closing one) sits at a normal C–C length.
    const ringBonds: Array<[number, number]> = ids.map((id, k) => [id, ids[(k + 1) % 6]])
    for (const [i, j] of ringBonds) {
      expect(dist(mol, i, j)).toBeGreaterThan(1.4)
      expect(dist(mol, i, j)).toBeLessThan(1.7)
    }
  })
})
