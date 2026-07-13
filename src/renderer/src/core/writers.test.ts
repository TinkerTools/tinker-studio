import { describe, it, expect } from 'vitest'
import { writeXyz, writeMol, writePdb } from './writers'
import type { Structure } from './types'

const water: Structure = {
  title: 'water',
  atoms: [
    { index: 1, name: 'O', element: 'O', x: 0, y: 0, z: 0, type: 1, bonds: [2, 3] },
    { index: 2, name: 'H', element: 'H', x: 0.96, y: 0, z: 0, type: 2, bonds: [1] },
    { index: 3, name: 'H', element: 'H', x: -0.24, y: 0.93, z: 0, type: 2, bonds: [1] }
  ],
  bonds: [
    { a: 1, b: 2 },
    { a: 1, b: 3 }
  ]
}

describe('structure writers', () => {
  it('standard XYZ: count, title, element + coords', () => {
    const lines = writeXyz(water).trimEnd().split('\n')
    expect(lines[0]).toBe('3')
    expect(lines[1]).toBe('water')
    expect(lines[2].split(/\s+/)).toEqual(['O', '0.000000', '0.000000', '0.000000'])
    expect(lines).toHaveLength(5)
  })

  it('MOL: V2000 counts line and bond block', () => {
    const lines = writeMol(water).split('\n')
    expect(lines[3]).toContain('V2000')
    expect(lines[3].slice(0, 6)).toBe('  3  2') // 3 atoms, 2 bonds
    expect(lines).toContain('M  END')
    // bond lines reference 1-based atoms with order 1
    expect(writeMol(water)).toContain('  1  2  1  0  0  0  0')
  })

  it('PDB: ATOM records and CONECT', () => {
    const out = writePdb(water)
    const atom = out.split('\n').find((l) => l.startsWith('ATOM'))!
    expect(atom.slice(0, 6)).toBe('ATOM  ')
    expect(atom).toContain('UNK')
    expect(atom.trimEnd().endsWith('O')).toBe(true)
    expect(out).toContain('CONECT')
    expect(out.trimEnd().endsWith('END')).toBe(true)
  })
})
