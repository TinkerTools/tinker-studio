/**
 * Generate the input files for an optional Tinker `minimize` run on a built
 * molecule. Built molecules have no force-field atom types, so we synthesize a
 * **naive generic force field on the fly** that exactly covers the atom
 * classes / bonds / angles present, guaranteeing Tinker won't abort on a missing
 * parameter. Atom classes are element + hybridization (from the builder's bond
 * orders), giving roughly correct ideal angles. Bond/angle/vdw constants are
 * generic placeholders and torsions are zeroed — this is a quick geometry clean-up,
 * not an accurate force field. For real energetics the user attaches their own
 * `.key`/`.prm` in the main UI after the molecule loads.
 *
 * NOTE: written to Tinker's documented format but not verified against a live
 * Tinker install in this environment.
 */

import type { BuilderMolecule } from './molecule'
import { elementInfo } from '../elements'
import { idealAngleDeg, idealBondLength } from './valence'

const ATOMIC_NUMBER: Record<string, number> = {
  H: 1, C: 6, N: 7, O: 8, F: 9, P: 15, S: 16, Cl: 17, Br: 35, I: 53
}
const MASS: Record<string, number> = {
  H: 1.008, C: 12.011, N: 14.007, O: 15.999, F: 18.998, P: 30.974, S: 32.06,
  Cl: 35.45, Br: 79.904, I: 126.904
}

interface ClassDef {
  id: number
  element: string
  maxOrder: number // 1 sp3, 2 sp2, 3 sp — drives the ideal angle
}

export interface TinkerInput {
  xyz: string
  prm: string
  key: string
}

/** Max bond order incident on each atom id (sp³/sp²/sp discriminator). */
function maxOrders(mol: BuilderMolecule): Map<number, number> {
  const m = new Map<number, number>()
  for (const a of mol.atoms) m.set(a.id, 1)
  for (const b of mol.bonds) {
    m.set(b.a, Math.max(m.get(b.a) ?? 1, b.order))
    m.set(b.b, Math.max(m.get(b.b) ?? 1, b.order))
  }
  return m
}

/**
 * Build the .xyz / .prm / .key for a Tinker minimize. Atom order matches
 * `mol.atoms`, so minimized coordinates map straight back by index.
 */
export function buildTinkerInput(mol: BuilderMolecule): TinkerInput {
  const order = maxOrders(mol)
  const idIndex = new Map<number, number>()
  mol.atoms.forEach((a, i) => idIndex.set(a.id, i + 1))

  // Assign a class/type per (element, maxOrder). Type id == class id.
  const classes: ClassDef[] = []
  const classKey = new Map<string, number>()
  const typeOf = new Map<number, number>()
  for (const a of mol.atoms) {
    const mo = order.get(a.id) ?? 1
    const key = `${a.element}_${mo}`
    let id = classKey.get(key)
    if (id == null) {
      id = classes.length + 1
      classKey.set(key, id)
      classes.push({ id, element: a.element, maxOrder: mo })
    }
    typeOf.set(a.id, id)
  }

  // --- .xyz (Tinker free format: index name x y z type bondedPartners…) -----
  const partners: number[][] = mol.atoms.map(() => [])
  for (const b of mol.bonds) {
    const ia = idIndex.get(b.a)!
    const ib = idIndex.get(b.b)!
    partners[ia - 1].push(ib)
    partners[ib - 1].push(ia)
  }
  const xyzLines = [`${String(mol.atoms.length).padStart(6)}  Built molecule`]
  mol.atoms.forEach((a, i) => {
    const bonds = partners[i].sort((x, y) => x - y).map((p) => String(p).padStart(6)).join('')
    xyzLines.push(
      `${String(i + 1).padStart(6)} ${a.element.padEnd(3)} ` +
        `${a.x.toFixed(6).padStart(11)} ${a.y.toFixed(6).padStart(11)} ${a.z.toFixed(6).padStart(11)} ` +
        `${String(typeOf.get(a.id)).padStart(5)}${bonds}`
    )
  })

  // --- .prm: only the classes / bonds / angles / torsions that appear --------
  const prm: string[] = [
    'forcefield BUILDER-GENERIC',
    'vdwtype LENNARD-JONES',
    'radiusrule ARITHMETIC',
    'radiustype R-MIN',
    'radiussize RADIUS',
    'epsilonrule GEOMETRIC',
    'bondunit 1.0',
    'angleunit 1.0',
    'torsionunit 1.0',
    ''
  ]
  for (const c of classes) {
    const z = ATOMIC_NUMBER[c.element] ?? 6
    const mass = MASS[c.element] ?? 12.011
    const valence = c.element === 'H' ? 1 : 4
    prm.push(`atom ${c.id} ${c.id} ${c.element} "${c.element} class ${c.id}" ${z} ${mass.toFixed(3)} ${valence}`)
  }
  prm.push('')
  for (const c of classes) {
    const vdw = elementInfo(c.element).vdwRadius
    prm.push(`vdw ${c.id} ${vdw.toFixed(3)} 0.100`)
  }
  prm.push('')

  // Bond parameters: one per class pair; length = mean ideal length over the bonds
  // of that pair (so an aromatic single/double mix collapses to a sensible mean).
  const bondAcc = new Map<string, { sum: number; n: number; ca: number; cb: number }>()
  for (const b of mol.bonds) {
    const ca = typeOf.get(b.a)!
    const cb = typeOf.get(b.b)!
    const lo = Math.min(ca, cb)
    const hi = Math.max(ca, cb)
    const key = `${lo}-${hi}`
    const ea = mol.atoms.find((a) => a.id === b.a)!.element
    const eb = mol.atoms.find((a) => a.id === b.b)!.element
    const r0 = idealBondLength(ea, eb, b.order)
    const acc = bondAcc.get(key) ?? { sum: 0, n: 0, ca: lo, cb: hi }
    acc.sum += r0
    acc.n += 1
    bondAcc.set(key, acc)
  }
  for (const acc of bondAcc.values()) {
    prm.push(`bond ${acc.ca} ${acc.cb} 300.0 ${(acc.sum / acc.n).toFixed(4)}`)
  }
  prm.push('')

  // Angle parameters: one per class triple (central class sets the ideal angle).
  const neighbors = new Map<number, number[]>()
  for (const a of mol.atoms) neighbors.set(a.id, [])
  for (const b of mol.bonds) {
    neighbors.get(b.a)!.push(b.b)
    neighbors.get(b.b)!.push(b.a)
  }
  const angleSeen = new Set<string>()
  for (const a of mol.atoms) {
    const nb = neighbors.get(a.id)!
    if (nb.length < 2) continue
    const cc = typeOf.get(a.id)!
    const theta = idealAngleDeg(order.get(a.id) ?? 1, 0)
    for (let i = 0; i < nb.length; i++) {
      for (let j = i + 1; j < nb.length; j++) {
        let c1 = typeOf.get(nb[i])!
        let c2 = typeOf.get(nb[j])!
        if (c1 > c2) [c1, c2] = [c2, c1]
        const key = `${c1}-${cc}-${c2}`
        if (angleSeen.has(key)) continue
        angleSeen.add(key)
        prm.push(`angle ${c1} ${cc} ${c2} 50.0 ${theta.toFixed(1)}`)
      }
    }
  }
  prm.push('')

  // Torsions: zero-amplitude wildcards over each central class pair present, so
  // Tinker has a (trivial) parameter for every rotatable bond.
  const torSeen = new Set<string>()
  for (const b of mol.bonds) {
    let c1 = typeOf.get(b.a)!
    let c2 = typeOf.get(b.b)!
    if (c1 > c2) [c1, c2] = [c2, c1]
    const key = `${c1}-${c2}`
    if (torSeen.has(key)) continue
    torSeen.add(key)
    prm.push(`torsion 0 ${c1} ${c2} 0 0.000 0.0 1`)
  }
  prm.push('')

  const key = [
    '# Auto-generated minimal key for the molecule builder.',
    'parameters builder-generic.prm'
  ]

  return { xyz: xyzLines.join('\n') + '\n', prm: prm.join('\n') + '\n', key: key.join('\n') + '\n' }
}
