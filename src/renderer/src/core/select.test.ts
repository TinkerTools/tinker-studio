import { describe, it, expect } from 'vitest'
import { expandSelection, connectedComponents } from './select'
import type { Structure } from './types'

// Two disconnected diatomics: atoms 0-1 bonded, atoms 2-3 bonded.
const twoMolecules: Structure = {
  title: 'two',
  atoms: [
    { index: 1, name: 'C', element: 'C', x: 0, y: 0, z: 0, type: 0, bonds: [2] },
    { index: 2, name: 'O', element: 'O', x: 1, y: 0, z: 0, type: 0, bonds: [1] },
    { index: 3, name: 'N', element: 'N', x: 5, y: 0, z: 0, type: 0, bonds: [4] },
    { index: 4, name: 'H', element: 'H', x: 6, y: 0, z: 0, type: 0, bonds: [3] }
  ],
  bonds: [
    { a: 1, b: 2 },
    { a: 3, b: 4 }
  ]
}

describe('expandSelection', () => {
  it('atom level returns just the atom', () => {
    expect(expandSelection(twoMolecules, 0, 'atom')).toEqual([0])
  })

  it('system level returns all atoms', () => {
    expect(expandSelection(twoMolecules, 0, 'system')).toEqual([0, 1, 2, 3])
  })

  it('molecule level returns the connected component', () => {
    expect(expandSelection(twoMolecules, 0, 'molecule')).toEqual([0, 1])
    expect(expandSelection(twoMolecules, 2, 'molecule')).toEqual([2, 3])
  })

  it('residue level falls back to the atom when there is no residue info', () => {
    expect(expandSelection(twoMolecules, 0, 'residue')).toEqual([0])
  })
})

describe('connectedComponents', () => {
  it('splits a structure into its molecules', () => {
    expect(connectedComponents(twoMolecules)).toEqual([
      [0, 1],
      [2, 3]
    ])
  })

  it('treats an unbonded atom as its own component', () => {
    const single: Structure = { title: 'one', atoms: [twoMolecules.atoms[0]], bonds: [] }
    expect(connectedComponents(single)).toEqual([[0]])
  })
})
