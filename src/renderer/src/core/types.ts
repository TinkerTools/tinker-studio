/**
 * Plain, framework-free data model for a molecular system. Kept free of Three.js
 * and Electron so it can be parsed/validated anywhere (renderer, main, tests).
 */

export interface AtomRecord {
  /** 1-based index within the structure (sequential after any renumbering). */
  index: number
  /** Atom name as written in the file (e.g. "C", "CA", "HN"). */
  name: string
  /** Inferred element symbol (authoritative element will later come from the force field). */
  element: string
  x: number
  y: number
  z: number
  /** Tinker force-field atom type. */
  type: number
  /** 1-based indices of bonded atoms, as listed for this atom. */
  bonds: number[]
  /** Residue name (PDB), e.g. "ALA". */
  residue?: string
  /** Residue sequence number (PDB). */
  residueSeq?: number
  /** Chain identifier (PDB). */
  chain?: string
  /** Partial charge, once a force field (.prm) has been applied. */
  charge?: number
}

export interface BondRecord {
  /** 1-based atom index, with a < b. */
  a: number
  b: number
}

export interface Structure {
  title: string
  atoms: AtomRecord[]
  bonds: BondRecord[]
  /** Periodic box (a, b, c, alpha, beta, gamma) if the file specified one. */
  box?: [number, number, number, number, number, number]
}
