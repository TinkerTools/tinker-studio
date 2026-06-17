import type { Structure, AtomRecord } from './types'
import { guessElement, normalizeElement } from './elements'
import { perceiveBonds } from './bondPerception'

/**
 * Parser for PDB coordinate files. Reads ATOM/HETATM records (fixed-column
 * layout), keeps the first model, and honors the primary alternate location.
 * PDB has no general connectivity, so bonds come from distance-based perception,
 * augmented by any explicit CONECT records.
 */
export function parsePdb(text: string): Structure {
  const lines = text.split(/\r?\n/)
  const atoms: AtomRecord[] = []
  const serialToIndex = new Map<number, number>()
  let title = ''

  for (const line of lines) {
    const record = line.slice(0, 6).trim()

    if (record === 'TITLE') {
      title = `${title} ${line.slice(10).trim()}`.trim()
      continue
    }

    if (record === 'ATOM' || record === 'HETATM') {
      // Keep only the primary alternate location (' ' or 'A').
      const altLoc = line.charAt(16)
      if (altLoc !== ' ' && altLoc !== 'A' && altLoc !== '') continue

      const x = Number.parseFloat(line.slice(30, 38))
      const y = Number.parseFloat(line.slice(38, 46))
      const z = Number.parseFloat(line.slice(46, 54))
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue

      const name = line.slice(12, 16).trim()
      const elementField = line.slice(76, 78).trim()
      const element = elementField ? normalizeElement(elementField) : guessElement(name)
      const serial = Number.parseInt(line.slice(6, 11), 10)

      const index = atoms.length + 1
      atoms.push({ index, name, element, x, y, z, type: 0, bonds: [] })
      if (Number.isFinite(serial)) serialToIndex.set(serial, index)
      continue
    }

    // First model only.
    if (record === 'ENDMDL') break
  }

  if (atoms.length === 0) {
    throw new Error('No ATOM/HETATM records found in PDB file')
  }

  const bonds = perceiveBonds(atoms)

  // Merge in explicit CONECT bonds (ligands, metals, disulfides, etc.).
  const seen = new Set(bonds.map((b) => `${b.a}-${b.b}`))
  for (const line of lines) {
    if (line.slice(0, 6).trim() !== 'CONECT') continue
    const from = serialToIndex.get(Number.parseInt(line.slice(6, 11), 10))
    if (from === undefined) continue
    for (let col = 11; col + 5 <= Math.max(line.length, 31); col += 5) {
      const to = serialToIndex.get(Number.parseInt(line.slice(col, col + 5), 10))
      if (to === undefined || to === from) continue
      const lo = Math.min(from, to)
      const hi = Math.max(from, to)
      const key = `${lo}-${hi}`
      if (!seen.has(key)) {
        seen.add(key)
        bonds.push({ a: lo, b: hi })
      }
    }
  }

  return { title, atoms, bonds }
}
