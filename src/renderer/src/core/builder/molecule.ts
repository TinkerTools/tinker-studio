/**
 * The molecule builder's editable model. Unlike the app's `Structure` (atoms +
 * orderless bonds, matching Tinker .xyz), this carries **bond orders** and tracks
 * per-atom manual hydrogen adjustments, because order drives both valence-filling
 * and the relaxed geometry. On handoff to the main UI it collapses to a plain
 * `Structure` (`toStructure`) — order is dropped, connectivity is preserved.
 *
 * Hydrogens are auto-generated to fill each heavy atom's valence. The user never
 * has to add them, but can add/remove: every add/remove just nudges the heavy
 * atom's `hDelta`, and reconciliation keeps the actual H atoms in sync. So making
 * a bond double (which consumes valence) drops an H automatically, and deleting
 * an H makes the change stick.
 */

import type { Structure, AtomRecord, BondRecord } from '../types'
import { defaultValence, idealBondLength } from './valence'
import type { Fragment } from './fragments'

export interface BuilderAtom {
  id: number
  element: string
  x: number
  y: number
  z: number
}

export interface BuilderBond {
  a: number // atom id, a < b not required (we normalize on read)
  b: number
  order: number // 1 | 2 | 3
}

export interface BuilderMolecule {
  atoms: BuilderAtom[]
  bonds: BuilderBond[]
  /** Manual hydrogen offset per heavy-atom id (user added/removed H). */
  hDelta: Record<number, number>
  nextId: number
}

export function emptyMolecule(): BuilderMolecule {
  return { atoms: [], bonds: [], hDelta: {}, nextId: 1 }
}

function isH(mol: BuilderMolecule, id: number): boolean {
  return mol.atoms.find((a) => a.id === id)?.element === 'H'
}

function atom(mol: BuilderMolecule, id: number): BuilderAtom | undefined {
  return mol.atoms.find((a) => a.id === id)
}

/** Bonds incident on an atom. */
function bondsOf(mol: BuilderMolecule, id: number): BuilderBond[] {
  return mol.bonds.filter((bd) => bd.a === id || bd.b === id)
}

function neighborId(bd: BuilderBond, id: number): number {
  return bd.a === id ? bd.b : bd.a
}

/** Sum of bond orders to non-hydrogen neighbors (the "heavy" valence used). */
function heavyOrderSum(mol: BuilderMolecule, id: number): number {
  return bondsOf(mol, id)
    .filter((bd) => !isH(mol, neighborId(bd, id)))
    .reduce((s, bd) => s + bd.order, 0)
}

function hydrogenIds(mol: BuilderMolecule, id: number): number[] {
  return bondsOf(mol, id)
    .map((bd) => neighborId(bd, id))
    .filter((n) => isH(mol, n))
}

/** Find an existing bond between two atoms, regardless of orientation. */
export function findBond(mol: BuilderMolecule, i: number, j: number): BuilderBond | undefined {
  return mol.bonds.find((bd) => (bd.a === i && bd.b === j) || (bd.a === j && bd.b === i))
}

/** Deterministic pseudo-random vector in [-1,1]³ from a seed (reproducible). */
function jitter(seed: number): [number, number, number] {
  const h = (k: number): number => {
    const x = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453
    return (x - Math.floor(x)) * 2 - 1
  }
  return [h(1), h(2), h(3)]
}

type Vec = [number, number, number]
const norm = (v: Vec): Vec => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}
const cross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
]
const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Rotate a point by the rotation that maps unit vector `u` onto unit vector `v`. */
function rotateAlign(p: Vec, u: Vec, v: Vec): Vec {
  const c = Math.max(-1, Math.min(1, dot(u, v)))
  if (c > 0.99999) return p
  let axis: Vec
  let angle: number
  if (c < -0.99999) {
    axis = perpendicularTo(u, [1, 0, 0]) // 180° about any perpendicular axis
    angle = Math.PI
  } else {
    axis = norm(cross(u, v))
    angle = Math.acos(c)
  }
  // Rodrigues: p·cosθ + (k×p)·sinθ + k(k·p)(1−cosθ)
  const s = Math.sin(angle)
  const kp = dot(axis, p)
  const kxp = cross(axis, p)
  return [
    p[0] * c + kxp[0] * s + axis[0] * kp * (1 - c),
    p[1] * c + kxp[1] * s + axis[1] * kp * (1 - c),
    p[2] * c + kxp[2] * s + axis[2] * kp * (1 - c)
  ]
}

/** A unit vector perpendicular to `e`, biased by the seeded jitter `j`. */
function perpendicularTo(e: Vec, j: Vec): Vec {
  const d = dot(j, e)
  let p: Vec = [j[0] - d * e[0], j[1] - d * e[1], j[2] - d * e[2]]
  if (Math.hypot(p[0], p[1], p[2]) < 1e-3) {
    // Jitter parallel to e — fall back to a deterministic perpendicular axis.
    p = Math.abs(e[0]) < 0.9 ? cross(e, [1, 0, 0]) : cross(e, [0, 1, 0])
  }
  return norm(p)
}

/**
 * Choose a placement direction for a new substituent on `parent`, using simple
 * VSEPR templates so the starting geometry is already roughly right (the
 * relaxation only polishes it). This matters because a symmetric/planar placement
 * is a local minimum the optimizer can't climb out of:
 *   - 0 existing bonds → an arbitrary axis.
 *   - 1 existing bond  → ~109.5° off it (never collinear).
 *   - ≥2 bonds, asymmetric → opposite their average (completes a trigonal slot).
 *   - ≥2 bonds, balanced/coplanar → along the plane normal (the out-of-plane slot
 *     of a tetrahedron — this is what keeps methane from collapsing flat).
 * The seeded jitter makes every choice deterministic and breaks exact ties.
 */
function placementDir(mol: BuilderMolecule, parentId: number, seed: number): Vec {
  const p = atom(mol, parentId)!
  const dirs: Vec[] = []
  for (const bd of bondsOf(mol, parentId)) {
    const q = atom(mol, neighborId(bd, parentId))!
    const v: Vec = [q.x - p.x, q.y - p.y, q.z - p.z]
    if (Math.hypot(v[0], v[1], v[2]) > 1e-6) dirs.push(norm(v))
  }
  const j = jitter(seed)

  if (dirs.length === 0) {
    return norm([1 + j[0] * 0.3, j[1] * 0.3, j[2] * 0.3])
  }
  if (dirs.length === 1) {
    // ~109.5° from the single existing bond: e·cosθ + perp·sinθ.
    const e = dirs[0]
    const perp = perpendicularTo(e, j)
    const c = -0.333 // cos(109.5°)
    const s = 0.943 // sin(109.5°)
    return norm([e[0] * c + perp[0] * s, e[1] * c + perp[1] * s, e[2] * c + perp[2] * s])
  }
  const sum: Vec = dirs.reduce<Vec>((a, e) => [a[0] + e[0], a[1] + e[1], a[2] + e[2]], [0, 0, 0])
  if (Math.hypot(sum[0], sum[1], sum[2]) > 0.35) {
    // Bonds are lopsided — the open slot is opposite their average.
    const d = norm([-sum[0], -sum[1], -sum[2]])
    // If that slot is (nearly) collinear with a bond the atom already has, a
    // second substituent placed here lands exactly on the first — e.g. the two
    // geminal hydrogens of a symmetric ring CH₂ see the same neighbour sum and
    // resolve to the same outward direction. That exact overlap is one the
    // relaxation can never split (the H–C–H angle spring vanishes at zero
    // separation, and geminal pairs are excluded from clash repulsion), so nudge
    // it off-axis with the seeded jitter. Slots that point into open space (a
    // benzene/carbonyl C–H) are anti-parallel to their neighbours and left exactly
    // as-is, preserving their planar geometry.
    if (dirs.some((e) => dot(e, d) > 0.98)) {
      return norm([d[0] + j[0] * 0.3, d[1] + j[1] * 0.3, d[2] + j[2] * 0.3])
    }
    return d
  }
  // Bonds are balanced/coplanar — go along the plane normal (out of plane). Use
  // the most non-parallel pair to define it; sign chosen by the jitter.
  let normal: Vec = [0, 0, 1]
  let best = 0
  for (let a = 0; a < dirs.length; a++) {
    for (let b = a + 1; b < dirs.length; b++) {
      const c = cross(dirs[a], dirs[b])
      const m = Math.hypot(c[0], c[1], c[2])
      if (m > best) {
        best = m
        normal = [c[0] / m, c[1] / m, c[2] / m]
      }
    }
  }
  if (best < 1e-3) normal = perpendicularTo(dirs[0], j) // all collinear
  return dot(normal, j) < 0 ? [-normal[0], -normal[1], -normal[2]] : normal
}

function addRawAtom(mol: BuilderMolecule, element: string, pos: [number, number, number]): number {
  const id = mol.nextId++
  mol.atoms.push({ id, element, x: pos[0], y: pos[1], z: pos[2] })
  return id
}

/**
 * Reconcile each heavy atom's hydrogens so its filled count equals
 *   valence - (orders to heavy neighbors) + hDelta,  clamped to [0, 8].
 * Adds H leaves (placed at an ideal bond length off the parent) or removes
 * surplus ones, in place. Hydrogens themselves are skipped.
 */
export function reconcileHydrogens(mol: BuilderMolecule): void {
  for (const a of [...mol.atoms]) {
    if (a.element === 'H') continue
    const valence = defaultValence(a.element)
    if (valence === 0) continue
    const target = Math.max(0, Math.min(8, valence - heavyOrderSum(mol, a.id) + (mol.hDelta[a.id] ?? 0)))
    const have = hydrogenIds(mol, a.id)
    if (have.length < target) {
      for (let k = have.length; k < target; k++) {
        const dir = placementDir(mol, a.id, mol.nextId)
        const r = idealBondLength(a.element, 'H', 1)
        const hid = addRawAtom(mol, 'H', [a.x + dir[0] * r, a.y + dir[1] * r, a.z + dir[2] * r])
        mol.bonds.push({ a: a.id, b: hid, order: 1 })
      }
    } else if (have.length > target) {
      for (const hid of have.slice(target)) removeAtomRaw(mol, hid)
    }
  }
}

/** Remove an atom and its bonds (no reconciliation, no hDelta bookkeeping). */
function removeAtomRaw(mol: BuilderMolecule, id: number): void {
  mol.atoms = mol.atoms.filter((a) => a.id !== id)
  mol.bonds = mol.bonds.filter((bd) => bd.a !== id && bd.b !== id)
}

/**
 * Add an atom of `element` bonded to `parentId` (or as the first/seed atom when
 * parentId is null). Adding 'H' to a parent is treated as a manual hydrogen bump
 * rather than a distinct heavy atom. Returns the new heavy atom's id, or null
 * when the add was a hydrogen bump (no new selectable atom).
 */
export function addAtom(
  mol: BuilderMolecule,
  parentId: number | null,
  element: string
): number | null {
  if (element === 'H' && parentId != null) {
    mol.hDelta[parentId] = (mol.hDelta[parentId] ?? 0) + 1
    reconcileHydrogens(mol)
    return null
  }
  let pos: [number, number, number] = [0, 0, 0]
  if (parentId != null) {
    const p = atom(mol, parentId)!
    const dir = placementDir(mol, parentId, mol.nextId)
    const r = idealBondLength(p.element, element, 1)
    pos = [p.x + dir[0] * r, p.y + dir[1] * r, p.z + dir[2] * r]
  }
  const id = addRawAtom(mol, element, pos)
  if (parentId != null) mol.bonds.push({ a: parentId, b: id, order: 1 })
  reconcileHydrogens(mol)
  return id
}

/**
 * Insert a whole fragment (a ring or functional group). With `parentId` set, the
 * fragment's `attach` atom bonds to that atom (a substitution — both lose a
 * hydrogen); otherwise it's dropped in as a new disconnected piece. The fragment's
 * pre-built coordinates are translated into place; the relaxation then orients and
 * settles it. Returns the new id of the fragment's attach atom (for selection).
 */
export function addFragment(
  mol: BuilderMolecule,
  parentId: number | null,
  frag: Fragment
): number {
  const fa = frag.atoms[frag.attach]
  // Local positions of every fragment atom, relative to the attach atom.
  let local: Vec[] = frag.atoms.map((a) => [a.x - fa.x, a.y - fa.y, a.z - fa.z])

  let base: Vec = [0, 0, 0] // where the attach atom ends up

  if (parentId != null) {
    const p = atom(mol, parentId)!
    const dir = placementDir(mol, parentId, mol.nextId)
    const r = idealBondLength(p.element, fa.element, 1)
    base = [p.x + dir[0] * r, p.y + dir[1] * r, p.z + dir[2] * r]
    // Orient the fragment so the attach atom's outward direction (away from its
    // own neighbors, e.g. radially out of a ring) points back toward the parent —
    // i.e. the new exocyclic bond lies along the bond axis, not across the ring.
    const outward = attachOutward(frag)
    local = local.map((q) => rotateAlign(q, outward, [-dir[0], -dir[1], -dir[2]]))
  } else if (mol.atoms.length > 0) {
    // Standalone onto a non-empty canvas: offset so it doesn't overlap; the clash
    // term keeps the pieces apart.
    base = [3, 0, 0]
  }

  const ids = frag.atoms.map((_, i) =>
    addRawAtom(mol, frag.atoms[i].element, [
      base[0] + local[i][0],
      base[1] + local[i][1],
      base[2] + local[i][2]
    ])
  )
  for (const b of frag.bonds) mol.bonds.push({ a: ids[b.a], b: ids[b.b], order: b.order })
  if (parentId != null) mol.bonds.push({ a: parentId, b: ids[frag.attach], order: 1 })
  reconcileHydrogens(mol)
  return ids[frag.attach]
}

/**
 * Fuse a ring fragment onto an existing edge — the ring-fusion analogue of
 * `addFragment`. `aId` and `bId` must be two bonded heavy atoms (a shared edge, e.g.
 * a C–C bond of an existing benzene). The fragment's `fuseEdge` atoms are identified
 * *with* aId/bId, so only the fragment's other n−2 atoms are added; they close back
 * onto aId and bId. The shared aId–bId bond is left untouched (not duplicated), and
 * the new ring's remaining bond orders are copied from the template — for an aromatic
 * template whose `fuseEdge` is a double edge this reproduces a correct fused Kekulé
 * structure (benzene onto benzene → naphthalene; all-single → decalin).
 *
 * The two bridgeheads each gain one ring bond, so `reconcileHydrogens` strips a
 * hydrogen from each on its own: a benzene C–H becomes a bare ring-junction carbon, a
 * cyclohexane CH₂ becomes a CH. Returns the id of one newly added ring atom (for
 * selection), or null when the fragment isn't fusable, the two atoms aren't a bonded
 * heavy edge, or a bridgehead has no free valence for the new bond.
 *
 * Scope: the intended cases are like-with-like (aromatic+aromatic, saturated+
 * saturated). Fusing an aromatic ring onto a saturated one (or vice-versa) still
 * yields a valence-correct molecule, but the shared bond won't be aromatic on both
 * sides. Heteroaromatic fusions (quinoline, isoquinoline) are made by fusing a plain
 * benzene and then retyping the chosen ring carbon to N (see `replaceAtomWithElement`),
 * which is why heterocyclic fragments carry no `fuseEdge`.
 */
export function fuseRing(
  mol: BuilderMolecule,
  aId: number,
  bId: number,
  frag: Fragment
): number | null {
  if (!frag.fuseEdge) return null
  if (aId === bId || isH(mol, aId) || isH(mol, bId) || !findBond(mol, aId, bId)) return null
  const pA = atom(mol, aId)
  const pB = atom(mol, bId)
  if (!pA || !pB) return null
  // Each bridgehead gains one single ring bond; refuse if that would over-fill it
  // (e.g. it's already a ring junction with no spare valence).
  if (
    heavyOrderSum(mol, aId) + 1 > defaultValence(pA.element) ||
    heavyOrderSum(mol, bId) + 1 > defaultValence(pB.element)
  ) {
    return null
  }

  const [e0, e1] = frag.fuseEdge
  const seq = ringWalk(frag, e0, e1) // [e0, e1, v2, …, v(n-1)] around the ring
  if (seq.length !== frag.atoms.length) return null // fuseEdge not on a simple cycle

  const coords = placeFusedRing(mol, aId, bId, seq.length)

  // Map fragment atom index → builder id; the bridgeheads reuse the existing atoms,
  // the other n−2 are newly added at the pre-computed coordinates (in seq order).
  const idOf = new Map<number, number>([
    [e0, aId],
    [e1, bId]
  ])
  seq.slice(2).forEach((fi, k) => {
    idOf.set(fi, addRawAtom(mol, frag.atoms[fi].element, coords[k]))
  })

  // Recreate every ring bond except the shared edge (already present), copying the
  // template's bond order for each.
  for (const fb of frag.bonds) {
    if ((fb.a === e0 && fb.b === e1) || (fb.a === e1 && fb.b === e0)) continue // shared edge
    const i = idOf.get(fb.a)
    const j = idOf.get(fb.b)
    if (i == null || j == null) continue
    mol.bonds.push({ a: i, b: j, order: fb.order })
  }
  reconcileHydrogens(mol)
  return idOf.get(seq[2]) ?? null
}

/** Walk a fragment's ring cycle starting e0 → e1, returning atom indices in order. */
function ringWalk(frag: Fragment, e0: number, e1: number): number[] {
  const adj = new Map<number, number[]>()
  const link = (a: number, b: number): void => {
    if (!adj.has(a)) adj.set(a, [])
    adj.get(a)!.push(b)
  }
  for (const b of frag.bonds) {
    link(b.a, b.b)
    link(b.b, b.a)
  }
  const seq = [e0, e1]
  while (seq.length < frag.atoms.length) {
    const cur = seq[seq.length - 1]
    const prev = seq[seq.length - 2]
    const next = (adj.get(cur) ?? []).find((n) => n !== prev && !seq.includes(n))
    if (next == null) break
    seq.push(next)
  }
  return seq
}

/** Rotate point `p` about unit-normalizable `axis` by `angle` (Rodrigues). */
function rotateAbout(p: Vec, axis: Vec, angle: number): Vec {
  const k = norm(axis)
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const kp = dot(k, p)
  const kxp = cross(k, p)
  return [
    p[0] * c + kxp[0] * s + k[0] * kp * (1 - c),
    p[1] * c + kxp[1] * s + k[1] * kp * (1 - c),
    p[2] * c + kxp[2] * s + k[2] * kp * (1 - c)
  ]
}

/** Approximate normal of the existing ring at the shared edge aId–bId. */
function existingRingNormal(mol: BuilderMolecule, aId: number, bId: number): Vec {
  const pA = atom(mol, aId)!
  const pB = atom(mol, bId)!
  const ex = norm([pB.x - pA.x, pB.y - pA.y, pB.z - pA.z])
  // A heavy neighbour of either bridgehead (other than the far bridgehead) fixes the
  // plane the shared edge lies in.
  for (const [id, other] of [
    [aId, bId],
    [bId, aId]
  ] as const) {
    const p = atom(mol, id)!
    const nb = bondsOf(mol, id)
      .map((bd) => neighborId(bd, id))
      .filter((n) => n !== other && !isH(mol, n))
      .map((n) => atom(mol, n)!)[0]
    if (nb) {
      const nrm = cross(ex, [nb.x - p.x, nb.y - p.y, nb.z - p.z])
      if (Math.hypot(nrm[0], nrm[1], nrm[2]) > 1e-6) return norm(nrm)
    }
  }
  return [0, 0, 1] // isolated edge — any plane containing it will do
}

/**
 * Planar coordinates for the n−2 new atoms of a ring fused onto the edge aId–bId:
 * a regular n-gon that shares that edge, lies coplanar with the existing ring, and
 * extends *away* from it. Returned in ring order starting at the vertex adjacent to
 * bId (matching `ringWalk(...).slice(2)`). The relaxer then polishes/puckers it.
 */
function placeFusedRing(mol: BuilderMolecule, aId: number, bId: number, n: number): Vec[] {
  const pA = atom(mol, aId)!
  const pB = atom(mol, bId)!
  const A: Vec = [pA.x, pA.y, pA.z]
  const B: Vec = [pB.x, pB.y, pB.z]
  const ex = norm([B[0] - A[0], B[1] - A[1], B[2] - A[2]])
  const ez = existingRingNormal(mol, aId, bId)
  let ey = norm(cross(ez, ex)) // in-plane, perpendicular to the shared edge
  const mid: Vec = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2]

  // Point ey away from the existing ring: the ring interior lies toward the mean of
  // the bridgeheads' other heavy neighbours, so flip ey if it points that way.
  const inward = meanOtherNeighbor(mol, aId, bId)
  if (inward && dot(ey, [inward[0] - mid[0], inward[1] - mid[1], inward[2] - mid[2]]) > 0) {
    ey = [-ey[0], -ey[1], -ey[2]]
  }

  const L = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2])
  const r = L / (2 * Math.sin(Math.PI / n))
  const apothem = r * Math.cos(Math.PI / n)
  const center: Vec = [
    mid[0] + ey[0] * apothem,
    mid[1] + ey[1] * apothem,
    mid[2] + ey[2] * apothem
  ]

  // Vertices sit on a circle of radius r about `center`; A is vertex 0, B vertex 1.
  // Rotate (A − center) about ez; pick the sign that lands vertex 1 on B, then emit
  // vertices 2…n−1 (the atoms we actually add).
  const cA: Vec = [A[0] - center[0], A[1] - center[1], A[2] - center[2]]
  const step = (2 * Math.PI) / n
  const probe = rotateAbout(cA, ez, step)
  const probeAbs: Vec = [center[0] + probe[0], center[1] + probe[1], center[2] + probe[2]]
  const sign = Math.hypot(probeAbs[0] - B[0], probeAbs[1] - B[1], probeAbs[2] - B[2]) < L ? 1 : -1

  const out: Vec[] = []
  for (let j = 2; j < n; j++) {
    const rot = rotateAbout(cA, ez, sign * step * j)
    out.push([center[0] + rot[0], center[1] + rot[1], center[2] + rot[2]])
  }
  return out
}

/** Mean position of the heavy neighbours of aId and bId, excluding each other. Null if none. */
function meanOtherNeighbor(mol: BuilderMolecule, aId: number, bId: number): Vec | null {
  const pts: Vec[] = []
  for (const [id, other] of [
    [aId, bId],
    [bId, aId]
  ] as const) {
    for (const bd of bondsOf(mol, id)) {
      const nid = neighborId(bd, id)
      if (nid === other || isH(mol, nid)) continue
      const p = atom(mol, nid)!
      pts.push([p.x, p.y, p.z])
    }
  }
  if (pts.length === 0) return null
  const s = pts.reduce<Vec>((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0])
  return [s[0] / pts.length, s[1] / pts.length, s[2] / pts.length]
}

/** Unit direction out of a fragment's attach atom, away from its bonded neighbors. */
function attachOutward(frag: Fragment): Vec {
  const fa = frag.atoms[frag.attach]
  let sx = 0
  let sy = 0
  let sz = 0
  for (const b of frag.bonds) {
    const other = b.a === frag.attach ? b.b : b.b === frag.attach ? b.a : -1
    if (other < 0) continue
    const o = frag.atoms[other]
    const d = norm([o.x - fa.x, o.y - fa.y, o.z - fa.z])
    sx += d[0]
    sy += d[1]
    sz += d[2]
  }
  if (Math.hypot(sx, sy, sz) < 1e-6) return [1, 0, 0]
  return norm([-sx, -sy, -sz])
}

/**
 * Bond two existing heavy atoms (e.g. to close a ring). No-op if they're the same
 * atom, already bonded, or either is a hydrogen. Reconciles H on both.
 */
export function bondAtoms(mol: BuilderMolecule, i: number, j: number, order = 1): boolean {
  if (i === j || isH(mol, i) || isH(mol, j) || findBond(mol, i, j)) return false
  mol.bonds.push({ a: i, b: j, order })
  reconcileHydrogens(mol)
  return true
}

/** Set the order (1–3) of the bond between two atoms. Reconciles H on both. */
export function setBondOrder(mol: BuilderMolecule, i: number, j: number, order: number): boolean {
  const bd = findBond(mol, i, j)
  if (!bd || isH(mol, i) || isH(mol, j)) return false
  bd.order = Math.max(1, Math.min(3, Math.round(order)))
  reconcileHydrogens(mol)
  return true
}

/**
 * Delete an atom. Deleting a hydrogen lowers its parent's hDelta so it stays gone;
 * deleting a heavy atom removes it and its hydrogens, then frees valence on its
 * former heavy neighbors (so they regain hydrogens).
 */
export function deleteAtom(mol: BuilderMolecule, id: number): void {
  if (isH(mol, id)) {
    const parent = bondsOf(mol, id)
      .map((bd) => neighborId(bd, id))
      .find((n) => !isH(mol, n))
    removeAtomRaw(mol, id)
    if (parent != null) mol.hDelta[parent] = (mol.hDelta[parent] ?? 0) - 1
    reconcileHydrogens(mol)
    return
  }
  const heavyNeighbors = bondsOf(mol, id)
    .map((bd) => neighborId(bd, id))
    .filter((n) => !isH(mol, n))
  for (const hid of hydrogenIds(mol, id)) removeAtomRaw(mol, hid)
  removeAtomRaw(mol, id)
  delete mol.hDelta[id]
  void heavyNeighbors // their valence is freed; reconcile re-adds their hydrogens
  reconcileHydrogens(mol)
}

/**
 * Replace atom `id` with `element` in place (Spartan-style substitution): the atom
 * keeps its heavy bonds and position, only its element changes, and hydrogens
 * re-fill to the new element's valence. Clicking a hydrogen this way promotes it to
 * a heavy atom — growing the molecule at that open valence — while clicking a heavy
 * atom simply retypes it. Replacing with 'H' instead means "cap this position with
 * hydrogen": the atom is removed and its former neighbours regain the freed valence
 * as H (i.e. `deleteAtom`), since a hydrogen can't stand in for a multiply-bonded
 * atom. No-op (returns false) when the atom already is that element.
 */
export function replaceAtomWithElement(
  mol: BuilderMolecule,
  id: number,
  element: string
): boolean {
  const a = atom(mol, id)
  if (!a || a.element === element) return false
  if (element === 'H') {
    deleteAtom(mol, id)
    return true
  }
  a.element = element
  // A retype resets any manual hydrogen bumps — the new element's valence decides.
  delete mol.hDelta[id]
  reconcileHydrogens(mol)
  return true
}

/**
 * Replace atom `id` with a fragment (ring/group), Spartan-style. The fragment's
 * attach atom takes the clicked atom's place, bonding to the atom's single heavy
 * neighbour: clicking a hydrogen grows the fragment off its parent (the hydrogen is
 * the consumed open valence); clicking a terminal heavy atom swaps that atom for the
 * fragment; clicking with an empty/lone atom drops the fragment in standalone.
 * Returns the new attach-atom id, or null for a bridging atom (2+ heavy neighbours),
 * which has no single site to graft onto.
 */
export function replaceAtomWithFragment(
  mol: BuilderMolecule,
  id: number,
  frag: Fragment
): number | null {
  const a = atom(mol, id)
  if (!a) return null
  if (a.element === 'H') {
    // A hydrogen is an open valence: graft the fragment onto its parent, which
    // consumes exactly this valence (addFragment's substitution drops the surplus
    // H). Leaving the delete to reconcile avoids double-counting via hDelta.
    const parent =
      bondsOf(mol, id)
        .map((bd) => neighborId(bd, id))
        .find((n) => !isH(mol, n)) ?? null
    return addFragment(mol, parent, frag)
  }
  const heavyNeighbors = bondsOf(mol, id)
    .map((bd) => neighborId(bd, id))
    .filter((n) => !isH(mol, n))
  if (heavyNeighbors.length > 1) return null // bridging atom: no single graft site
  const parent = heavyNeighbors[0] ?? null
  deleteAtom(mol, id) // remove the clicked atom (+ its H shell); re-caps the parent
  return addFragment(mol, parent, frag)
}

/**
 * Collapse the builder model to a plain `Structure` for handoff to the main UI:
 * atoms get 1-based sequential indices and per-element names (C1, C2, H1…);
 * bonds become orderless `BondRecord`s; force-field type is 0 (untyped).
 */
export function toStructure(mol: BuilderMolecule, title = 'Built molecule'): Structure {
  const order = mol.atoms
  const idToIndex = new Map<number, number>()
  order.forEach((a, i) => idToIndex.set(a.id, i + 1))

  const counts: Record<string, number> = {}
  const atoms: AtomRecord[] = order.map((a) => {
    counts[a.element] = (counts[a.element] ?? 0) + 1
    const index = idToIndex.get(a.id)!
    const bonds = bondsOf(mol, a.id)
      .map((bd) => idToIndex.get(neighborId(bd, a.id))!)
      .sort((x, y) => x - y)
    return {
      index,
      name: `${a.element}${counts[a.element]}`,
      element: a.element,
      x: a.x,
      y: a.y,
      z: a.z,
      type: 0,
      bonds
    }
  })

  const bonds: BondRecord[] = mol.bonds.map((bd) => {
    const a = idToIndex.get(bd.a)!
    const b = idToIndex.get(bd.b)!
    return a < b ? { a, b } : { a: b, b: a }
  })

  return { title, atoms, bonds }
}
