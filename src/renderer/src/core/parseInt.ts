import type { Structure, AtomRecord, BondRecord } from './types'
import { guessElement } from './elements'

/**
 * Parser for Tinker internal-coordinate (.int) files. Each atom is defined by a
 * z-matrix entry (bond partner + length, angle partner + angle, torsion partner
 * + dihedral, and a chirality flag). After the atoms an optional section lists
 * extra bonds to add and bonds to remove.
 *
 * Coordinates are reconstructed with `intToXyz`, a direct port of Tinker's
 * routine (also used by the original Tinker-FFE).
 */

type Vec3 = [number, number, number]

export function parseTinkerInt(text: string): Structure {
  const lines = text.split(/\r?\n/)
  let i = 0
  const skipBlank = (): void => {
    while (i < lines.length && lines[i].trim() === '') i++
  }

  skipBlank()
  if (i >= lines.length) throw new Error('File is empty')

  const header = lines[i].trim()
  const headerTokens = header.split(/\s+/)
  const numAtoms = Number.parseInt(headerTokens[0], 10)
  if (!Number.isInteger(numAtoms) || numAtoms < 1) {
    throw new Error(`Invalid atom count in header: "${header}"`)
  }
  const title = header.slice(headerTokens[0].length).trim()
  i++

  const names: string[] = []
  const types: number[] = []
  const zi: number[][] = [] // [partner, anglePartner, torsionPartner, chirality]
  const zv: number[][] = [] // [bond, angle, dihedral]

  for (let a = 0; a < numAtoms; a++) {
    skipBlank()
    if (i >= lines.length) {
      throw new Error(`Unexpected end of file: expected ${numAtoms} atoms, found ${a}`)
    }
    const t = lines[i].trim().split(/\s+/)
    i++
    if (t.length < 3) throw new Error(`Malformed INT atom line ${a + 1}: "${t.join(' ')}"`)

    names.push(t[1])
    types.push(Number.parseInt(t[2], 10))

    const ziRow = [0, 0, 0, 0]
    const zvRow = [0, 0, 0]
    if (t.length >= 5) {
      ziRow[0] = Number.parseInt(t[3], 10)
      zvRow[0] = Number.parseFloat(t[4])
    }
    if (t.length >= 7) {
      ziRow[1] = Number.parseInt(t[5], 10)
      zvRow[1] = Number.parseFloat(t[6])
    }
    if (t.length >= 10) {
      ziRow[2] = Number.parseInt(t[7], 10)
      zvRow[2] = Number.parseFloat(t[8])
      ziRow[3] = Number.parseInt(t[9], 10)
    }
    zi.push(ziRow)
    zv.push(zvRow)
  }

  // Optional trailing sections: a blank line, then "bonds to add" pairs, then a
  // blank line, then "bonds to remove" pairs.
  const zadd: Array<[number, number]> = []
  const zdel: Array<[number, number]> = []
  if (i < lines.length && lines[i].trim() === '') {
    i++
    while (i < lines.length && lines[i].trim() !== '') {
      const t = lines[i].trim().split(/\s+/)
      i++
      if (t.length === 2) zadd.push([Number.parseInt(t[0], 10), Number.parseInt(t[1], 10)])
    }
    if (i < lines.length && lines[i].trim() === '') i++
    while (i < lines.length && lines[i].trim() !== '') {
      const t = lines[i].trim().split(/\s+/)
      i++
      if (t.length === 2) zdel.push([Number.parseInt(t[0], 10), Number.parseInt(t[1], 10)])
    }
  }

  // Reconstruct Cartesian coordinates from the z-matrix.
  const coords: Vec3[] = new Array(numAtoms)
  for (let a = 0; a < numAtoms; a++) {
    coords[a] = intToXyz(coords, zi[a], zv[a])
  }

  const atoms: AtomRecord[] = names.map((name, a) => ({
    index: a + 1,
    name,
    element: guessElement(name),
    x: coords[a][0],
    y: coords[a][1],
    z: coords[a][2],
    type: types[a],
    bonds: []
  }))

  // Bonds: each atom's z-matrix bond partner, minus removals, plus additions.
  const bonds: BondRecord[] = []
  const seen = new Set<string>()
  const addBond = (p: number, q: number): void => {
    const lo = Math.min(p, q)
    const hi = Math.max(p, q)
    if (lo === hi || lo < 1 || hi > numAtoms) return
    const key = `${lo}-${hi}`
    if (seen.has(key)) return
    seen.add(key)
    bonds.push({ a: lo, b: hi })
  }

  for (let a = 1; a < numAtoms; a++) {
    const partner = zi[a][0]
    if (partner < 1) continue
    const removed = zdel.some(
      ([p, q]) => (p === a + 1 && q === partner) || (q === a + 1 && p === partner)
    )
    if (!removed) addBond(a + 1, partner)
  }
  for (const [p, q] of zadd) addBond(p, q)

  return { title, atoms, bonds }
}

function normalize(v: Vec3): Vec3 {
  const r = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / r, v[1] / r, v[2] / r]
}

/**
 * Place one atom from its z-matrix entry given the already-placed atoms.
 * Direct port of Tinker's `intxyz` (degrees in; radians used internally).
 */
function intToXyz(coords: Vec3[], zi: number[], zv: number[]): Vec3 {
  const ang1 = (zv[1] * Math.PI) / 180
  const ang2 = (zv[2] * Math.PI) / 180
  const zcos0 = Math.cos(ang1)
  const zcos1 = Math.cos(ang2)
  const zsin0 = Math.sin(ang1)
  const zsin1 = Math.sin(ang2)
  const bond = zv[0]
  const eps = 1e-7

  // No partners — at the origin.
  if (zi[0] === 0) return [0, 0, 0]

  const xa = coords[zi[0] - 1]

  // One partner — along the z-axis.
  if (zi[1] === 0) return [xa[0], xa[1], xa[2] + bond]

  const xb = coords[zi[1] - 1]

  // Two partners — in the xz-plane.
  if (zi[2] === 0) {
    const xab: Vec3 = [xa[0] - xb[0], xa[1] - xb[1], xa[2] - xb[2]]
    const rab = Math.hypot(xab[0], xab[1], xab[2])
    const u = normalize(xab)
    const cosb = u[2]
    const sinb = Math.sqrt(u[0] * u[0] + u[1] * u[1])
    let cosg = 1
    let sing = 0
    if (sinb !== 0) {
      cosg = u[1] / sinb
      sing = u[0] / sinb
    }
    const xtmp = bond * zsin0
    const ztmp = rab - bond * zcos0
    return [
      xb[0] + xtmp * cosg + ztmp * sing * sinb,
      xb[1] - xtmp * sing + ztmp * cosg * sinb,
      xb[2] + ztmp * cosb
    ]
  }

  const xc = coords[zi[2] - 1]

  // General case with a dihedral.
  if (zi[3] === 0) {
    const xab = normalize([xa[0] - xb[0], xa[1] - xb[1], xa[2] - xb[2]])
    const xbc = normalize([xb[0] - xc[0], xb[1] - xc[1], xb[2] - xc[2]])
    const xt: Vec3 = [
      xab[2] * xbc[1] - xab[1] * xbc[2],
      xab[0] * xbc[2] - xab[2] * xbc[0],
      xab[1] * xbc[0] - xab[0] * xbc[1]
    ]
    const cosine = xab[0] * xbc[0] + xab[1] * xbc[1] + xab[2] * xbc[2]
    const sine = Math.sqrt(Math.max(1 - cosine * cosine, eps))
    const xts: Vec3 = [xt[0] / sine, xt[1] / sine, xt[2] / sine]
    const xu: Vec3 = [
      xts[1] * xab[2] - xts[2] * xab[1],
      xts[2] * xab[0] - xts[0] * xab[2],
      xts[0] * xab[1] - xts[1] * xab[0]
    ]
    return [
      xa[0] + bond * (xu[0] * zsin0 * zcos1 + xts[0] * zsin0 * zsin1 - xab[0] * zcos0),
      xa[1] + bond * (xu[1] * zsin0 * zcos1 + xts[1] * zsin0 * zsin1 - xab[1] * zcos0),
      xa[2] + bond * (xu[2] * zsin0 * zcos1 + xts[2] * zsin0 * zsin1 - xab[2] * zcos0)
    ]
  }

  // General case defined by two angles (chirality flag = ±1).
  const xba = normalize([xb[0] - xa[0], xb[1] - xa[1], xb[2] - xa[2]])
  const xac = normalize([xa[0] - xc[0], xa[1] - xc[1], xa[2] - xc[2]])
  const xt: Vec3 = [
    xba[2] * xac[1] - xba[1] * xac[2],
    xba[0] * xac[2] - xba[2] * xac[0],
    xba[1] * xac[0] - xba[0] * xac[1]
  ]
  const cosine = xba[0] * xac[0] + xba[1] * xac[1] + xba[2] * xac[2]
  const sine2 = Math.max(1 - cosine * cosine, eps)
  let a = (-zcos1 - cosine * zcos0) / sine2
  let b = (zcos0 + cosine * zcos1) / sine2
  let c = (1 + a * zcos1 - b * zcos0) / sine2
  if (c > eps) {
    c = zi[3] * Math.sqrt(c)
  } else if (c < -eps) {
    const rt =
      (a * xac[0] + b * xba[0]) ** 2 +
      (a * xac[1] + b * xba[1]) ** 2 +
      (a * xac[2] + b * xba[2]) ** 2
    const denom = Math.sqrt(rt)
    a /= denom
    b /= denom
    c = 0
  } else {
    c = 0
  }
  return [
    xa[0] + bond * (a * xac[0] + b * xba[0] + c * xt[0]),
    xa[1] + bond * (a * xac[1] + b * xba[1] + c * xt[1]),
    xa[2] + bond * (a * xac[2] + b * xba[2] + c * xt[2])
  ]
}
