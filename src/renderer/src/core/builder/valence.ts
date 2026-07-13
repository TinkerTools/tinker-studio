/**
 * Chemistry parameters for the molecule builder's self-contained geometry engine.
 *
 * This is deliberately a *small, approximate* valence model — enough to sketch a
 * reasonable organic molecule and relax it to sensible 3D coordinates, not a real
 * force field. It carries no Tinker atom types; a built molecule is exported as
 * plain connectivity (see molecule.ts `toStructure`).
 */

import { elementInfo } from '../elements'

/** Elements offered in the builder palette (common organic set). */
export const BUILDER_ELEMENTS = ['H', 'C', 'N', 'O', 'F', 'P', 'S', 'Cl', 'Br', 'I'] as const

/**
 * Typical neutral valence (number of bonds, counting a double as 2 and a triple
 * as 3) used to decide how many hydrogens fill an atom. Approximate — picks the
 * most common organic oxidation state. Unknown elements get 0 (no auto-H).
 */
const VALENCE: Record<string, number> = {
  H: 1,
  C: 4,
  N: 3,
  O: 2,
  F: 1,
  P: 3,
  S: 2,
  Cl: 1,
  Br: 1,
  I: 1
}

export function defaultValence(element: string): number {
  return VALENCE[element] ?? 0
}

/**
 * Ideal bond angle (degrees) at an atom, from a crude hybridization guess:
 *   - any triple bond, or two double bonds on the atom -> sp  (180)
 *   - exactly one double bond                          -> sp2 (120)
 *   - otherwise by heavy+H coordination: >=4 -> 109.5, 3 -> 109.5,
 *     2 -> 109.5 (bent, e.g. water/ether), <2 irrelevant.
 *
 * `maxOrder` is the highest bond order incident on the atom; `doubleCount` is how
 * many double bonds it has.
 */
export function idealAngleDeg(maxOrder: number, doubleCount: number): number {
  if (maxOrder >= 3 || doubleCount >= 2) return 180
  if (maxOrder === 2) return 120
  return 109.5
}

/**
 * Ideal bond length (Angstrom) between two elements at a given order: the sum of
 * covalent radii, shortened for multiple bonds (~0.07 Å per extra order, the
 * usual single->double->triple contraction).
 */
export function idealBondLength(a: string, b: string, order: number): number {
  const single = elementInfo(a).covalentRadius + elementInfo(b).covalentRadius
  return single - 0.07 * (order - 1)
}
