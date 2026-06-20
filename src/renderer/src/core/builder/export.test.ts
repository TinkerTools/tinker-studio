import { describe, it, expect } from 'vitest'
import { emptyMolecule, addAtom, toStructure } from './molecule'
import { relax } from './relax'
import { writeTinkerXyz } from '../writeXyz'
import { parseTinkerXyz } from '../parseXyz'

/**
 * End-to-end: build a molecule, relax it, export to a Structure, write Tinker .xyz,
 * and parse it back — the path a finished build takes into the main UI / to disk.
 */
describe('builder → Tinker .xyz round trip', () => {
  it('exports ethanol (CCO + H) as a valid, re-parseable .xyz', () => {
    const mol = emptyMolecule()
    const c1 = addAtom(mol, null, 'C')! // CH3
    const c2 = addAtom(mol, c1, 'C')! // CH2
    addAtom(mol, c2, 'O') // OH
    relax(mol, 400)

    const structure = toStructure(mol)
    // Ethanol C2H6O = 9 atoms.
    expect(structure.atoms.filter((a) => a.element === 'C').length).toBe(2)
    expect(structure.atoms.filter((a) => a.element === 'O').length).toBe(1)
    expect(structure.atoms.filter((a) => a.element === 'H').length).toBe(6)
    expect(structure.atoms.length).toBe(9)

    const xyz = writeTinkerXyz(structure)
    expect(xyz.split('\n')[0].trim().startsWith('9')).toBe(true)

    // Re-parsing yields the same atom count and symmetric connectivity.
    const reparsed = parseTinkerXyz(xyz)
    expect(reparsed.atoms.length).toBe(9)
    for (const a of reparsed.atoms) {
      for (const partner of a.bonds) {
        expect(reparsed.atoms[partner - 1].bonds).toContain(a.index)
      }
    }
    // No NaN coordinates leaked out of the relaxation.
    for (const a of reparsed.atoms) {
      expect(Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z)).toBe(true)
    }
  })
})
