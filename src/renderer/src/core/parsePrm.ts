import type { Structure, AtomRecord } from './types'
import { symbolForAtomicNumber } from './elements'

/**
 * Minimal Tinker force-field (.prm) parser — just the records needed for
 * visualization: `atom` (atom type → element), `charge` (fixed-charge models),
 * and `multipole` (AMOEBA monopole). Bonded/VDW parameters are skipped.
 */
export interface ForceField {
  /** Atom type → element symbol (from the atomic number). */
  elementForType: Map<number, string>
  /** Atom type → partial charge. */
  chargeForType: Map<number, number>
}

export function parsePrm(text: string): ForceField {
  const elementForType = new Map<number, string>()
  const chargeForType = new Map<number, number>()
  const multipoleCharge = new Map<number, number>()

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const keyword = line.split(/\s+/, 1)[0].toLowerCase()

    if (keyword === 'atom') {
      // atom <type> <class> <name> "<description>" <atomicNumber> <mass> <valence>
      const q1 = line.indexOf('"')
      const q2 = line.indexOf('"', q1 + 1)
      if (q1 < 0 || q2 < 0) continue
      const before = line.slice(0, q1).trim().split(/\s+/) // [atom, type, class, name]
      const after = line.slice(q2 + 1).trim().split(/\s+/) // [atomicNumber, mass, valence]
      const type = Number.parseInt(before[1], 10)
      const atomicNumber = Number.parseInt(after[0], 10)
      const symbol = symbolForAtomicNumber(atomicNumber)
      if (Number.isInteger(type) && symbol) elementForType.set(type, symbol)
      continue
    }

    if (keyword === 'charge') {
      // charge <type> <value>
      const t = line.split(/\s+/)
      const type = Number.parseInt(t[1], 10)
      const value = Number.parseFloat(t[2])
      if (Number.isInteger(type) && Number.isFinite(value)) chargeForType.set(type, value)
      continue
    }

    if (keyword === 'multipole') {
      // multipole <type> [frame types...] <monopole>  — monopole is the last token
      const t = line.split(/\s+/)
      const type = Number.parseInt(t[1], 10)
      const monopole = Number.parseFloat(t[t.length - 1])
      if (Number.isInteger(type) && Number.isFinite(monopole) && !multipoleCharge.has(type)) {
        multipoleCharge.set(type, monopole)
      }
      continue
    }
  }

  // Fixed-charge records win; fall back to AMOEBA monopoles for any missing type.
  for (const [type, q] of multipoleCharge) {
    if (!chargeForType.has(type)) chargeForType.set(type, q)
  }

  return { elementForType, chargeForType }
}

/** Apply a force field to a structure: set each atom's element + charge from its type. */
export function applyForceField(structure: Structure, ff: ForceField): Structure {
  const atoms: AtomRecord[] = structure.atoms.map((a) => ({
    ...a,
    element: ff.elementForType.get(a.type) ?? a.element,
    charge: ff.chargeForType.get(a.type) ?? a.charge
  }))
  return { ...structure, atoms }
}
