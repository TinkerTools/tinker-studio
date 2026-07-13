import { describe, it, expect } from 'vitest'
import { parsePdb } from './parsePdb'

/** Build a correctly-columned PDB ATOM record. */
function atom(serial: number, name: string, x: number, y: number, z: number, element: string): string {
  let line = 'ATOM  ' + String(serial).padStart(5) + ' ' + ` ${name}`.padEnd(4)
  line += ' UNK A   1' // altLoc(space) + resName + chain + resSeq
  line = line.padEnd(30)
  line += x.toFixed(3).padStart(8) + y.toFixed(3).padStart(8) + z.toFixed(3).padStart(8)
  line = line.padEnd(76) + element.padStart(2)
  return line
}

describe('parsePdb', () => {
  it('reads atoms, elements, and perceives bonds by distance', () => {
    // C at origin, O at 1.2 Å (C-O bond), H at 1.0 Å (C-H bond); O-H is 1.56 Å (no bond).
    const pdb = [
      'TITLE     SMALL MOLECULE',
      atom(1, 'C', 0, 0, 0, 'C'),
      atom(2, 'O', 1.2, 0, 0, 'O'),
      atom(3, 'H', 0, 0, 1.0, 'H'),
      'END'
    ].join('\n')

    const s = parsePdb(pdb)
    expect(s.title).toBe('SMALL MOLECULE')
    expect(s.atoms).toHaveLength(3)
    expect(s.atoms.map((a) => a.element)).toEqual(['C', 'O', 'H'])
    expect(s.bonds).toHaveLength(2)
    expect(s.bonds).toContainEqual({ a: 1, b: 2 })
    expect(s.bonds).toContainEqual({ a: 1, b: 3 })
    expect(s.bonds).not.toContainEqual({ a: 2, b: 3 })
  })

  it('guesses element from the atom name when the element column is blank', () => {
    const line = ('ATOM  ' + '    1' + '  CA').padEnd(30) + '   1.000   2.000   3.000'
    const s = parsePdb(line + '\nEND')
    expect(s.atoms).toHaveLength(1)
    expect(s.atoms[0].element).toBe('C') // "CA" -> alpha carbon, not calcium
  })

  it('honors explicit CONECT records', () => {
    const pdb = [
      atom(1, 'FE', 0, 0, 0, 'FE'),
      atom(2, 'O', 3.0, 0, 0, 'O'), // 3 Å apart: too far for distance perception
      'CONECT    1    2',
      'END'
    ].join('\n')
    const s = parsePdb(pdb)
    expect(s.atoms[0].element).toBe('Fe')
    expect(s.bonds).toContainEqual({ a: 1, b: 2 })
  })
})
