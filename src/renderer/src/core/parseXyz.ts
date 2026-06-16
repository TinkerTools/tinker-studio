import type { Structure, AtomRecord, BondRecord } from './types'
import { guessElement } from './elements'

/**
 * Parser for the Tinker Cartesian coordinate (.xyz) and archive (.arc) formats.
 *
 * Layout:
 *   <numAtoms> [title]
 *   [a b c alpha beta gamma]            <- optional periodic box
 *   <index> <name> <x> <y> <z> <type> [bonded indices...]
 *   ...
 *
 * The box line is recognized because all six of its tokens are numeric, whereas
 * an atom line's second token is always a (non-numeric) atom name.
 *
 * This parses the first coordinate frame. Multi-frame archives (.arc) will reuse
 * the same per-frame logic when trajectory support is added.
 */
export function parseTinkerXyz(text: string): Structure {
  const lines = text.split(/\r?\n/)
  let i = 0
  const skipBlank = (): void => {
    while (i < lines.length && lines[i].trim() === '') i++
  }

  skipBlank()
  if (i >= lines.length) throw new Error('File is empty')

  // Header: atom count followed by an optional title.
  const header = lines[i].trim()
  const headerTokens = header.split(/\s+/)
  const numAtoms = Number.parseInt(headerTokens[0], 10)
  if (!Number.isInteger(numAtoms) || numAtoms < 1) {
    throw new Error(`Invalid atom count in header: "${header}"`)
  }
  const title = header.slice(headerTokens[0].length).trim()
  i++

  // Optional periodic-box line.
  skipBlank()
  let box: Structure['box']
  if (i < lines.length) {
    const t = lines[i].trim().split(/\s+/)
    if (isBoxLine(t)) {
      box = [Number(t[0]), Number(t[1]), Number(t[2]), Number(t[3]), Number(t[4]), Number(t[5])]
      i++
    }
  }

  interface RawAtom {
    fileIndex: number
    name: string
    x: number
    y: number
    z: number
    type: number
    bonds: number[]
  }

  const raw: RawAtom[] = []
  for (let a = 0; a < numAtoms; a++) {
    skipBlank()
    if (i >= lines.length) {
      throw new Error(`Unexpected end of file: expected ${numAtoms} atoms, found ${a}`)
    }
    const t = lines[i].trim().split(/\s+/)
    i++
    if (t.length < 6) {
      throw new Error(`Malformed atom line ${a + 1}: "${t.join(' ')}"`)
    }
    const bonds: number[] = []
    for (let k = 6; k < t.length; k++) {
      const b = Number.parseInt(t[k], 10)
      if (Number.isInteger(b) && b > 0) bonds.push(b)
    }
    raw.push({
      fileIndex: Number.parseInt(t[0], 10),
      name: t[1],
      x: Number.parseFloat(t[2]),
      y: Number.parseFloat(t[3]),
      z: Number.parseFloat(t[4]),
      type: Number.parseInt(t[5], 10),
      bonds
    })
  }

  // Remap (possibly non-sequential) file indices to 1..N in order of appearance.
  const indexMap = new Map<number, number>()
  raw.forEach((r, k) => indexMap.set(r.fileIndex, k + 1))

  const atoms: AtomRecord[] = raw.map((r, k) => ({
    index: k + 1,
    name: r.name,
    element: guessElement(r.name),
    x: r.x,
    y: r.y,
    z: r.z,
    type: r.type,
    bonds: r.bonds
      .map((b) => indexMap.get(b))
      .filter((v): v is number => v !== undefined)
  }))

  const bonds = dedupeBonds(atoms)
  return { title, atoms, bonds, box }
}

function isBoxLine(tokens: string[]): boolean {
  if (tokens.length < 6) return false
  for (let k = 0; k < 6; k++) {
    const tok = tokens[k]
    if (tok === '' || !Number.isFinite(Number(tok))) return false
  }
  return true
}

function dedupeBonds(atoms: AtomRecord[]): BondRecord[] {
  const seen = new Set<string>()
  const bonds: BondRecord[] = []
  for (const atom of atoms) {
    for (const partner of atom.bonds) {
      const lo = Math.min(atom.index, partner)
      const hi = Math.max(atom.index, partner)
      if (lo === hi) continue
      const key = `${lo}-${hi}`
      if (seen.has(key)) continue
      seen.add(key)
      bonds.push({ a: lo, b: hi })
    }
  }
  return bonds
}
