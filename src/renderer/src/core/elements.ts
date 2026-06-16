/**
 * Element table (CPK-ish colors + covalent radii) and a heuristic that maps a
 * Tinker atom *name* to an element symbol.
 *
 * Note: a Tinker .xyz file does not store the element directly — only an atom
 * name and a force-field type. The authoritative element comes from the force
 * field (atom type -> atomic number), which we will add with the .prm parser.
 * Until then we guess from the name, biased toward common organic/biomolecular
 * readings so that PDB-style names like "CA" (alpha carbon) are not misread as
 * calcium.
 */

export interface ElementInfo {
  symbol: string
  color: number
  /** Covalent radius in Angstrom. */
  covalentRadius: number
}

const TABLE: Record<string, { color: number; covalentRadius: number }> = {
  H: { color: 0xffffff, covalentRadius: 0.31 },
  He: { color: 0xd9ffff, covalentRadius: 0.28 },
  Li: { color: 0xcc80ff, covalentRadius: 1.28 },
  B: { color: 0xffb5b5, covalentRadius: 0.84 },
  C: { color: 0x909090, covalentRadius: 0.76 },
  N: { color: 0x3050f8, covalentRadius: 0.71 },
  O: { color: 0xff0d0d, covalentRadius: 0.66 },
  F: { color: 0x90e050, covalentRadius: 0.57 },
  Ne: { color: 0xb3e3f5, covalentRadius: 0.58 },
  Na: { color: 0xab5cf2, covalentRadius: 1.66 },
  Mg: { color: 0x8aff00, covalentRadius: 1.41 },
  Al: { color: 0xbfa6a6, covalentRadius: 1.21 },
  Si: { color: 0xf0c8a0, covalentRadius: 1.11 },
  P: { color: 0xff8000, covalentRadius: 1.07 },
  S: { color: 0xffff30, covalentRadius: 1.05 },
  Cl: { color: 0x1ff01f, covalentRadius: 1.02 },
  Ar: { color: 0x80d1e3, covalentRadius: 1.06 },
  K: { color: 0x8f40d4, covalentRadius: 2.03 },
  Ca: { color: 0x3dff00, covalentRadius: 1.76 },
  Fe: { color: 0xe06633, covalentRadius: 1.32 },
  Cu: { color: 0xc88033, covalentRadius: 1.32 },
  Zn: { color: 0x7d80b0, covalentRadius: 1.22 },
  Se: { color: 0xffa100, covalentRadius: 1.2 },
  Br: { color: 0xa62929, covalentRadius: 1.2 },
  I: { color: 0x940094, covalentRadius: 1.39 }
}

const DEFAULT = { color: 0xff1493, covalentRadius: 0.75 }

export function elementInfo(symbol: string): ElementInfo {
  return { symbol, ...(TABLE[symbol] ?? DEFAULT) }
}

// First letters that are common single-letter organic/biomolecular elements; for
// these we default to the single-letter reading. Genuine two-letter elements
// sharing those first letters that commonly appear as whole atom names are
// listed as overrides so e.g. "CL" still reads as chlorine.
const ORGANIC_SINGLE = new Set(['H', 'C', 'N', 'O', 'P', 'S'])
const TWO_LETTER_OVERRIDE = new Set(['Cl', 'Na', 'Si', 'Se'])

export function guessElement(atomName: string): string {
  // Drop any leading non-letters (e.g. PDB hydrogen names like "1HB").
  const letters = atomName.replace(/^[^A-Za-z]+/, '').match(/^[A-Za-z]{1,2}/)
  if (!letters) return 'X'
  const one = letters[0][0].toUpperCase()
  const two = letters[0].length === 2 ? one + letters[0][1].toLowerCase() : ''

  if (ORGANIC_SINGLE.has(one)) {
    if (two && TWO_LETTER_OVERRIDE.has(two)) return two
    return one
  }
  if (two && two in TABLE) return two
  return one
}
