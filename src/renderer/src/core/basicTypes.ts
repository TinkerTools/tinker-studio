import type { Structure } from './types'
import { atomicNumber } from './elements'

/**
 * Atom typing for Tinker's bundled generic `basic.prm`. Per that file: the atom
 * type is "ten times the atomic number plus the number of attached atoms", e.g.
 * tetravalent carbon = 64, a benzene carbon (3 neighbors) = 63, water oxygen = 82.
 *
 * Because it depends only on connectivity, it applies to any molecule — so we can
 * give a force-field-less structure (built by hand, or downloaded from NCI/PubChem)
 * real Tinker atom types instead of writing zeros.
 */
export function basicAtomType(element: string, neighborCount: number): number {
  const z = atomicNumber(element)
  return z === 0 ? 0 : z * 10 + neighborCount
}

/** Copy of `structure` with every atom's `type` set for `basic.prm`. */
export function withBasicTypes(structure: Structure): Structure {
  const degree = new Array(structure.atoms.length).fill(0)
  for (const b of structure.bonds) {
    if (b.a >= 1 && b.a <= degree.length) degree[b.a - 1]++
    if (b.b >= 1 && b.b <= degree.length) degree[b.b - 1]++
  }
  return {
    ...structure,
    atoms: structure.atoms.map((a, i) => ({ ...a, type: basicAtomType(a.element, degree[i]) }))
  }
}

/** True if no atom carries a force-field type yet (all zero) — i.e. untyped. */
export function isUntyped(structure: Structure): boolean {
  return structure.atoms.every((a) => !a.type)
}
