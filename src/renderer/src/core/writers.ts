import type { Structure } from './types'
import { writeTinkerXyz } from './writeXyz'

/**
 * Structure serializers for "Save Structure As". Tinker .xyz is the native
 * format (writeXyz.ts); the rest are popular interchange formats produced from
 * the same in-memory model so the molecule can be opened in other tools.
 */

export type SaveFormat = 'txyz' | 'xyz' | 'mol' | 'pdb'

export interface FormatSpec {
  id: SaveFormat
  label: string
  ext: string
  write: (s: Structure) => string
}

/** Gather each atom's bonded partners (1-based), from both bond directions. */
function partnerLists(structure: Structure): number[][] {
  const partners: number[][] = structure.atoms.map(() => [])
  for (const b of structure.bonds) {
    if (partners[b.a - 1] && partners[b.b - 1]) {
      partners[b.a - 1].push(b.b)
      partners[b.b - 1].push(b.a)
    }
  }
  return partners
}

/** Plain (standard) XYZ: count, comment, then `element x y z` per atom. */
export function writeXyz(structure: Structure): string {
  const out: string[] = [String(structure.atoms.length), structure.title ?? '']
  for (const a of structure.atoms) {
    out.push(`${a.element.padEnd(2)} ${f(a.x, 10)} ${f(a.y, 10)} ${f(a.z, 10)}`)
  }
  return out.join('\n') + '\n'
}

/** MDL Molfile (V2000): atom block + bond block (all bonds written as order 1). */
export function writeMol(structure: Structure): string {
  const atoms = structure.atoms
  const bonds = structure.bonds
  const lines: string[] = [
    structure.title ?? '',
    '  TinkStud3D',
    '',
    `${i3(atoms.length)}${i3(bonds.length)}  0  0  0  0  0  0  0  0999 V2000`
  ]
  for (const a of atoms) {
    lines.push(`${f(a.x, 10, 4)}${f(a.y, 10, 4)}${f(a.z, 10, 4)} ${a.element.padEnd(3)}0  0  0  0  0  0  0  0  0  0  0  0`)
  }
  for (const b of bonds) {
    lines.push(`${i3(b.a)}${i3(b.b)}  1  0  0  0  0`)
  }
  lines.push('M  END')
  return lines.join('\n') + '\n'
}

/** PDB: ATOM records (+ CONECT for bonds). Missing residue/chain are defaulted. */
export function writePdb(structure: Structure): string {
  const lines: string[] = []
  if (structure.title) lines.push(`TITLE     ${structure.title}`.slice(0, 80))
  structure.atoms.forEach((a, i) => {
    const serial = String((i + 1) % 100000).padStart(5)
    const name = a.name.length >= 4 ? a.name.slice(0, 4) : ` ${a.name.padEnd(3)}`
    const res = (a.residue ?? 'UNK').slice(0, 3).padStart(3)
    const chain = (a.chain ?? 'A').slice(0, 1)
    const seq = String(a.residueSeq ?? 1).padStart(4)
    const elem = a.element.toUpperCase().padStart(2)
    lines.push(
      `ATOM  ${serial} ${name} ${res} ${chain}${seq}    ` +
        `${f(a.x, 8, 3)}${f(a.y, 8, 3)}${f(a.z, 8, 3)}  1.00  0.00          ${elem}`
    )
  })
  const partners = partnerLists(structure)
  partners.forEach((list, i) => {
    const sorted = [...list].sort((x, y) => x - y)
    for (let k = 0; k < sorted.length; k += 4) {
      const chunk = sorted.slice(k, k + 4).map((p) => String(p).padStart(5)).join('')
      lines.push(`CONECT${String(i + 1).padStart(5)}${chunk}`)
    }
  })
  lines.push('END')
  return lines.join('\n') + '\n'
}

export const SAVE_FORMATS: FormatSpec[] = [
  { id: 'txyz', label: 'Tinker XYZ', ext: 'xyz', write: writeTinkerXyz },
  { id: 'xyz', label: 'XYZ', ext: 'xyz', write: writeXyz },
  { id: 'mol', label: 'MDL MOL', ext: 'mol', write: writeMol },
  { id: 'pdb', label: 'PDB', ext: 'pdb', write: writePdb }
]

function f(v: number, width: number, decimals = 6): string {
  return v.toFixed(decimals).padStart(width)
}

function i3(n: number): string {
  return String(n).padStart(3)
}
