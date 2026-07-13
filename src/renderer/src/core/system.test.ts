import { describe, it, expect } from 'vitest'
import { mergeStructures } from './system'
import type { Structure } from './types'

function diatomic(title: string, e1: string, e2: string): Structure {
  return {
    title,
    atoms: [
      { index: 1, name: e1, element: e1, x: 0, y: 0, z: 0, type: 0, bonds: [2] },
      { index: 2, name: e2, element: e2, x: 1, y: 0, z: 0, type: 0, bonds: [1] }
    ],
    bonds: [{ a: 1, b: 2 }]
  }
}

describe('mergeStructures', () => {
  it('concatenates atoms with renumbering and offsets bond indices', () => {
    const merged = mergeStructures([diatomic('a', 'C', 'O'), diatomic('b', 'N', 'H')])
    expect(merged.atoms).toHaveLength(4)
    expect(merged.atoms.map((a) => a.index)).toEqual([1, 2, 3, 4])
    expect(merged.atoms.map((a) => a.element)).toEqual(['C', 'O', 'N', 'H'])
    // Per-atom bond lists are also offset.
    expect(merged.atoms[2].bonds).toEqual([4])
    expect(merged.bonds).toEqual([
      { a: 1, b: 2 },
      { a: 3, b: 4 }
    ])
  })
})
