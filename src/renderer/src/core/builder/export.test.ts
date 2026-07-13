import { describe, it, expect } from 'vitest'
import { emptyMolecule, addAtom, addFragment, toStructure } from './molecule'
import { relax } from './relax'
import { writeTinkerXyz } from '../writeXyz'
import { parseTinkerXyz } from '../parseXyz'
import { withBasicTypes, isUntyped } from '../basicTypes'
import { FRAGMENTS } from './fragments'

/**
 * End-to-end: build a molecule, relax it, export to a Structure, write Tinker .xyz,
 * and parse it back — the path a finished build takes into the main UI / to disk.
 */
describe('builder → Tinker .xyz round trip', () => {
  it('assigns basic.prm atom types (10·Z + attached atoms) to a built molecule', () => {
    // The handoff to the main UI types the untyped build for Tinker's basic.prm.
    const mol = emptyMolecule()
    addFragment(mol, null, FRAGMENTS.find((f) => f.id === 'benzene')!)
    const typed = withBasicTypes(toStructure(mol))
    expect(isUntyped(typed)).toBe(false)
    for (const a of typed.atoms) {
      // Benzene: each ring carbon has 3 neighbours (2 C + 1 H) → 63; each H → 11.
      expect(a.type).toBe(a.element === 'C' ? 63 : 11)
    }

    // Methane's tetravalent carbon → 64.
    const m2 = emptyMolecule()
    addAtom(m2, null, 'C')
    const t2 = withBasicTypes(toStructure(m2))
    expect(t2.atoms.find((a) => a.element === 'C')!.type).toBe(64)
    expect(t2.atoms.filter((a) => a.element === 'H').every((a) => a.type === 11)).toBe(true)
  })

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
