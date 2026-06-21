/**
 * Element table (CPK-ish colors + covalent/van-der-Waals radii) and a heuristic
 * that maps a Tinker atom *name* to an element symbol.
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
  /** Covalent radius in Angstrom (used for ball-and-stick sizing). */
  covalentRadius: number
  /** Van der Waals radius in Angstrom (used for spacefill). */
  vdwRadius: number
}

type Entry = Omit<ElementInfo, 'symbol'>

const TABLE: Record<string, Entry> = {
  H: { color: 0xffffff, covalentRadius: 0.31, vdwRadius: 1.2 },
  He: { color: 0xd9ffff, covalentRadius: 0.28, vdwRadius: 1.4 },
  Li: { color: 0xcc80ff, covalentRadius: 1.28, vdwRadius: 1.82 },
  B: { color: 0xffb5b5, covalentRadius: 0.84, vdwRadius: 1.85 },
  C: { color: 0x909090, covalentRadius: 0.76, vdwRadius: 1.7 },
  N: { color: 0x3050f8, covalentRadius: 0.71, vdwRadius: 1.55 },
  O: { color: 0xff0d0d, covalentRadius: 0.66, vdwRadius: 1.52 },
  F: { color: 0x90e050, covalentRadius: 0.57, vdwRadius: 1.47 },
  Ne: { color: 0xb3e3f5, covalentRadius: 0.58, vdwRadius: 1.54 },
  Na: { color: 0xab5cf2, covalentRadius: 1.66, vdwRadius: 2.27 },
  Mg: { color: 0x8aff00, covalentRadius: 1.41, vdwRadius: 1.73 },
  Al: { color: 0xbfa6a6, covalentRadius: 1.21, vdwRadius: 1.84 },
  Si: { color: 0xf0c8a0, covalentRadius: 1.11, vdwRadius: 2.1 },
  P: { color: 0xff8000, covalentRadius: 1.07, vdwRadius: 1.8 },
  S: { color: 0xffff30, covalentRadius: 1.05, vdwRadius: 1.8 },
  Cl: { color: 0x1ff01f, covalentRadius: 1.02, vdwRadius: 1.75 },
  Ar: { color: 0x80d1e3, covalentRadius: 1.06, vdwRadius: 1.88 },
  K: { color: 0x8f40d4, covalentRadius: 2.03, vdwRadius: 2.75 },
  Ca: { color: 0x3dff00, covalentRadius: 1.76, vdwRadius: 2.31 },
  Fe: { color: 0xe06633, covalentRadius: 1.32, vdwRadius: 2.0 },
  Cu: { color: 0xc88033, covalentRadius: 1.32, vdwRadius: 1.4 },
  Zn: { color: 0x7d80b0, covalentRadius: 1.22, vdwRadius: 1.39 },
  Se: { color: 0xffa100, covalentRadius: 1.2, vdwRadius: 1.9 },
  Br: { color: 0xa62929, covalentRadius: 1.2, vdwRadius: 1.85 },
  I: { color: 0x940094, covalentRadius: 1.39, vdwRadius: 1.98 }
}

const DEFAULT: Entry = { color: 0xff1493, covalentRadius: 0.75, vdwRadius: 1.7 }

export function elementInfo(symbol: string): ElementInfo {
  return { symbol, ...(TABLE[symbol] ?? DEFAULT) }
}

// Standard atomic weights for common elements (u). Unknowns default to carbon's,
// which is good enough for centering a structure on its center of mass.
const MASS: Record<string, number> = {
  H: 1.008, C: 12.011, N: 14.007, O: 15.999, F: 18.998, Na: 22.99, Mg: 24.305,
  P: 30.974, S: 32.06, Cl: 35.45, K: 39.098, Ca: 40.078, Fe: 55.845, Zn: 65.38,
  Br: 79.904, I: 126.904
}
export function atomicMass(symbol: string): number {
  return MASS[symbol] ?? 12.011
}

// Symbol by atomic number (index 0 unused). Used by the .prm parser to turn an
// atom type's atomic number into an element symbol.
const ATOMIC_SYMBOLS = [
  '', 'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne', 'Na', 'Mg', 'Al', 'Si', 'P', 'S',
  'Cl', 'Ar', 'K', 'Ca', 'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Ge',
  'As', 'Se', 'Br', 'Kr', 'Rb', 'Sr', 'Y', 'Zr', 'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd',
  'In', 'Sn', 'Sb', 'Te', 'I', 'Xe', 'Cs', 'Ba', 'La', 'Ce', 'Pr', 'Nd', 'Pm', 'Sm', 'Eu', 'Gd',
  'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb', 'Lu', 'Hf', 'Ta', 'W', 'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg',
  'Tl', 'Pb', 'Bi', 'Po', 'At', 'Rn', 'Fr', 'Ra', 'Ac', 'Th', 'Pa', 'U', 'Np', 'Pu'
]

export function symbolForAtomicNumber(z: number): string | undefined {
  return ATOMIC_SYMBOLS[z]
}

const ATOMIC_NUMBERS: Record<string, number> = Object.fromEntries(
  ATOMIC_SYMBOLS.map((s, z) => [s, z]).filter(([s]) => s !== '')
)

/** Atomic number for an element symbol (0 if unknown). */
export function atomicNumber(symbol: string): number {
  return ATOMIC_NUMBERS[normalizeElement(symbol)] ?? 0
}

/** Normalize an element symbol to canonical case (e.g. "FE" -> "Fe", " c" -> "C"). */
export function normalizeElement(symbol: string): string {
  const s = symbol.trim()
  if (s.length === 0) return 'X'
  if (s.length === 1) return s.toUpperCase()
  return s[0].toUpperCase() + s.slice(1).toLowerCase()
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
