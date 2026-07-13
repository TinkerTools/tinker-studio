import type { Structure, AtomRecord, BondRecord } from './types'
import { normalizeElement } from './elements'

/**
 * Parser for MDL Molfile / SDF (V2000) — the format returned by PubChem and the
 * NCI CACTUS service. The atom block gives element + coordinates and the bond
 * block gives explicit connectivity, so no bond perception is needed.
 */
export function parseSdf(text: string): Structure {
  const lines = text.split(/\r?\n/)
  if (lines.length < 4) throw new Error('Not a valid SDF/MOL file')

  const title = lines[0].trim()
  const counts = lines[3]
  const numAtoms = Number.parseInt(counts.slice(0, 3), 10)
  const numBonds = Number.parseInt(counts.slice(3, 6), 10)
  if (!Number.isInteger(numAtoms) || numAtoms < 1) {
    throw new Error('Invalid SDF atom count (no 3D record returned?)')
  }

  const atoms: AtomRecord[] = []
  for (let i = 0; i < numAtoms; i++) {
    const line = lines[4 + i]
    if (line === undefined) throw new Error(`SDF truncated at atom ${i + 1}`)
    const t = line.trim().split(/\s+/)
    const x = Number.parseFloat(t[0])
    const y = Number.parseFloat(t[1])
    const z = Number.parseFloat(t[2])
    const element = normalizeElement(t[3] ?? 'X')
    atoms.push({ index: i + 1, name: element, element, x, y, z, type: 0, bonds: [] })
  }

  const bonds: BondRecord[] = []
  const seen = new Set<string>()
  for (let i = 0; i < numBonds; i++) {
    const line = lines[4 + numAtoms + i]
    if (line === undefined) break
    const a = Number.parseInt(line.slice(0, 3), 10)
    const b = Number.parseInt(line.slice(3, 6), 10)
    if (!Number.isInteger(a) || !Number.isInteger(b)) continue
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    if (lo < 1 || hi > numAtoms || lo === hi) continue
    const key = `${lo}-${hi}`
    if (seen.has(key)) continue
    seen.add(key)
    bonds.push({ a: lo, b: hi })
  }

  return { title, atoms, bonds }
}
