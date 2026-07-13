import type { Structure } from './types'

/**
 * Serialize a Structure to Tinker .xyz format. Tinker reads coordinates in free
 * (whitespace-delimited) format, so exact columns aren't required — fields are
 * simply space-separated and roughly aligned.
 */
export function writeTinkerXyz(structure: Structure): string {
  const n = structure.atoms.length
  const out: string[] = [`${String(n).padStart(6)}  ${structure.title ?? ''}`.trimEnd()]

  // Each atom lists its bonded partners (1-based), gathered from both directions.
  const partners: number[][] = structure.atoms.map(() => [])
  for (const b of structure.bonds) {
    if (partners[b.a - 1] && partners[b.b - 1]) {
      partners[b.a - 1].push(b.b)
      partners[b.b - 1].push(b.a)
    }
  }

  structure.atoms.forEach((a, i) => {
    const bonds = partners[i]
      .sort((x, y) => x - y)
      .map((p) => String(p).padStart(6))
      .join('')
    out.push(
      `${String(a.index).padStart(6)} ${a.name.padEnd(3)} ${col(a.x)} ${col(a.y)} ${col(a.z)} ` +
        `${String(a.type).padStart(5)}${bonds}`
    )
  })

  return out.join('\n') + '\n'
}

function col(v: number): string {
  return v.toFixed(6).padStart(11)
}
