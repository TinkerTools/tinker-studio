import type { Structure } from './types'

export type PickLevel = 'atom' | 'residue' | 'molecule' | 'system'

/** 0-based adjacency list from the structure's bonds. */
function adjacency(structure: Structure): number[][] {
  const adj: number[][] = structure.atoms.map(() => [])
  for (const b of structure.bonds) {
    if (adj[b.a - 1] && adj[b.b - 1]) {
      adj[b.a - 1].push(b.b - 1)
      adj[b.b - 1].push(b.a - 1)
    }
  }
  return adj
}

/**
 * Expand a picked atom (0-based) to the set of atom indices implied by the pick
 * level: the atom itself, its whole residue, its connected molecule, or the
 * entire system.
 */
export function expandSelection(structure: Structure, atomIndex: number, level: PickLevel): number[] {
  const atoms = structure.atoms
  if (atomIndex < 0 || atomIndex >= atoms.length || level === 'atom') return [atomIndex]
  if (level === 'system') return atoms.map((_, i) => i)

  if (level === 'residue') {
    const a = atoms[atomIndex]
    if (a.residueSeq === undefined) return [atomIndex]
    const out: number[] = []
    atoms.forEach((x, i) => {
      if (x.residueSeq === a.residueSeq && x.chain === a.chain) out.push(i)
    })
    return out
  }

  // molecule: connected component over the bond graph
  const adj = adjacency(structure)
  const seen = new Set<number>([atomIndex])
  const stack = [atomIndex]
  while (stack.length) {
    const cur = stack.pop() as number
    for (const nb of adj[cur]) {
      if (!seen.has(nb)) {
        seen.add(nb)
        stack.push(nb)
      }
    }
  }
  return [...seen].sort((x, y) => x - y)
}
