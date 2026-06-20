/**
 * Library of common substructures (rings + functional groups) the builder can
 * drop in whole, instead of placing every atom by hand. Each fragment carries
 * pre-built planar coordinates so an inserted ring starts at (and stays at) good
 * geometry — in particular an aromatic ring goes in flat. Hydrogens are not
 * listed; they're filled by valence when the fragment is added (see
 * molecule.ts `addFragment`).
 *
 * `attach` is the atom that bonds to the currently-selected atom when the
 * fragment is added onto an existing molecule (it loses one hydrogen to make the
 * bond, like any substitution).
 */

export interface FragmentAtom {
  element: string
  x: number
  y: number
  z: number
}
export interface FragmentBond {
  a: number
  b: number
  order: number
}
export interface Fragment {
  id: string
  name: string
  atoms: FragmentAtom[]
  bonds: FragmentBond[]
  /** Index of the atom that bonds to the selection when attached. */
  attach: number
}

/**
 * Build a planar ring from per-vertex elements and per-edge bond orders. The
 * radius is chosen so neighboring vertices sit one bond length apart.
 */
function ring(
  id: string,
  name: string,
  elements: string[],
  orders: number[],
  attach: number,
  bond = 1.4
): Fragment {
  const n = elements.length
  const r = bond / (2 * Math.sin(Math.PI / n))
  const atoms: FragmentAtom[] = elements.map((element, k) => {
    const a = (2 * Math.PI * k) / n - Math.PI / 2
    return { element, x: r * Math.cos(a), y: r * Math.sin(a), z: 0 }
  })
  const bonds: FragmentBond[] = elements.map((_, k) => ({ a: k, b: (k + 1) % n, order: orders[k] }))
  return { id, name, atoms, bonds, attach }
}

// Kekulé orders alternate around an aromatic ring (double, single, …).
const C6 = ['C', 'C', 'C', 'C', 'C', 'C']
const C5 = ['C', 'C', 'C', 'C', 'C']

export const FRAGMENTS: Fragment[] = [
  ring('benzene', 'Benzene', C6, [2, 1, 2, 1, 2, 1], 0, 1.4),
  ring('cyclohexane', 'Cyclohexane', C6, [1, 1, 1, 1, 1, 1], 0, 1.54),
  ring('cyclopentane', 'Cyclopentane', C5, [1, 1, 1, 1, 1], 0, 1.54),
  ring('cyclobutane', 'Cyclobutane', ['C', 'C', 'C', 'C'], [1, 1, 1, 1], 0, 1.54),
  ring('cyclopropane', 'Cyclopropane', ['C', 'C', 'C'], [1, 1, 1], 0, 1.54),
  // Pyridine: N at vertex 0 with one double + one single ring bond → no N–H.
  ring('pyridine', 'Pyridine', ['N', 'C', 'C', 'C', 'C', 'C'], [2, 1, 2, 1, 2, 1], 3, 1.39),
  // Pyrrole: N–H, flanked by two single bonds; the carbons carry the doubles.
  ring('pyrrole', 'Pyrrole', ['N', 'C', 'C', 'C', 'C'], [1, 2, 1, 2, 1], 2, 1.38),
  // Furan: ring oxygen, two single bonds → no O–H.
  ring('furan', 'Furan', ['O', 'C', 'C', 'C', 'C'], [1, 2, 1, 2, 1], 2, 1.37),
  // Carboxyl –C(=O)OH: the carbonyl O is double, the hydroxyl O single (gets its H).
  {
    id: 'carboxyl',
    name: 'Carboxyl (–COOH)',
    atoms: [
      { element: 'C', x: 0, y: 0, z: 0 },
      { element: 'O', x: 0.6, y: 1.05, z: 0 },
      { element: 'O', x: 1.05, y: -0.6, z: 0 }
    ],
    bonds: [
      { a: 0, b: 1, order: 2 },
      { a: 0, b: 2, order: 1 }
    ],
    attach: 0
  }
]
