import type { Structure, AtomRecord, BondRecord } from './types'
import { parseTinkerXyz, parseTinkerArc } from './parseXyz'
import { parsePdb } from './parsePdb'
import { parseTinkerInt } from './parseInt'

/** A trajectory: per-frame coordinate sets (each numAtoms*3) over one topology. */
export interface Trajectory {
  frames: Float32Array[]
}

/**
 * A loaded molecular system. Multiple systems can be open at once; the UI lists
 * them and one is "active" (shown in the viewport).
 */
export interface MolecularSystem {
  id: string
  name: string
  /** Source format: 'xyz' | 'arc' | 'pdb' | 'int'. */
  fileType: string
  structure: Structure
  /** Present for multi-frame archives (.arc). */
  trajectory?: Trajectory
  /** Absolute path of the source file on disk, if it came from one (needed to run Tinker). */
  path?: string
}

let counter = 0
export function nextSystemId(): string {
  counter += 1
  return `sys-${counter}`
}

/**
 * Combine several structures into one by concatenating atoms (renumbered to a
 * single sequence) and bonds (re-indexed). Atoms keep their own coordinates.
 */
export function mergeStructures(structures: Structure[]): Structure {
  const atoms: AtomRecord[] = []
  const bonds: BondRecord[] = []
  let offset = 0
  for (const s of structures) {
    for (const atom of s.atoms) {
      atoms.push({
        ...atom,
        index: atom.index + offset,
        bonds: atom.bonds.map((b) => b + offset)
      })
    }
    for (const bond of s.bonds) {
      bonds.push({ a: bond.a + offset, b: bond.b + offset })
    }
    offset += s.atoms.length
  }
  return { title: 'Merged system', atoms, bonds }
}

/**
 * Pick a parser from the file name and return the parsed structure plus a
 * normalized file-type tag. Additional formats (PDB, INT) register here.
 */
export function parseStructureFile(
  text: string,
  fileName: string
): { structure: Structure; fileType: string; trajectory?: Trajectory } {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase()
  switch (ext) {
    case 'pdb':
      return { structure: parsePdb(text), fileType: 'pdb' }
    case 'int':
      return { structure: parseTinkerInt(text), fileType: 'int' }
    case 'arc': {
      const { structure, frames } = parseTinkerArc(text)
      return {
        structure,
        fileType: 'arc',
        trajectory: frames.length > 1 ? { frames } : undefined
      }
    }
    case 'xyz':
    case 'txyz':
    default:
      return { structure: parseTinkerXyz(text), fileType: 'xyz' }
  }
}
