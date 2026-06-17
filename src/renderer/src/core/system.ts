import type { Structure } from './types'
import { parseTinkerXyz } from './parseXyz'

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
}

let counter = 0
export function nextSystemId(): string {
  counter += 1
  return `sys-${counter}`
}

/**
 * Pick a parser from the file name and return the parsed structure plus a
 * normalized file-type tag. Additional formats (PDB, INT) register here.
 */
export function parseStructureFile(
  text: string,
  fileName: string
): { structure: Structure; fileType: string } {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase()
  switch (ext) {
    case 'arc':
      return { structure: parseTinkerXyz(text), fileType: 'arc' }
    case 'xyz':
    case 'txyz':
    default:
      return { structure: parseTinkerXyz(text), fileType: 'xyz' }
  }
}
