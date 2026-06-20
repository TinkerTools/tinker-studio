/**
 * Self-contained geometry engine for the molecule builder. Given connectivity and
 * bond orders, it relaxes atom positions to minimize a tiny "force field":
 *
 *   E = Σ bond springs (ideal length from covalent radii + order)
 *     + Σ angle springs (ideal angle from hybridization)
 *     + Σ improper springs (keep sp² centers locally coplanar)
 *     + Σ torsion springs (sp²–sp² dihedrals → planar; flattens aromatic rings)
 *     + Σ soft non-bonded clash repulsion (so distant parts don't overlap)
 *
 * Minimized in two phases: FIRE (inertial MD, escapes the puckered/symmetric local
 * minima a plain descent gets stuck in) followed by a steepest-descent polish.
 * Because it's a global energy minimization (not a constructive build), closing a
 * ring just adds bonds/torsions and the whole molecule re-relaxes to accommodate.
 *
 * No Tinker, no atom types. Approximate by design — aromatic rings come out
 * roughly (not perfectly) planar; a real minimize can be run in the main UI
 * afterward with a user-supplied key for exact geometry.
 */

import { elementInfo } from '../elements'
import type { BuilderMolecule } from './molecule'
import { idealAngleDeg, idealBondLength } from './valence'

// Bonds are far stiffer than angles (as in a real force field), so bond lengths
// stay near ideal even under ring/angle strain instead of collapsing.
const KB = 4.0 // bond spring stiffness
const KA = 0.4 // angle spring stiffness (angles in radians)
const KC = 0.5 // clash repulsion stiffness
const KI = 15 // improper (out-of-plane) stiffness, keeps sp² centers planar
const KT = 40 // torsion stiffness across sp²–sp² bonds, flattens conjugated/aromatic rings
const CLASH_SCALE = 0.75 // non-bonded pairs repel inside this × (vdwA + vdwB)

interface BondTerm {
  i: number
  j: number
  r0: number
}
interface AngleTerm {
  c: number
  a: number
  b: number
  theta0: number
}
interface ClashTerm {
  i: number
  j: number
  d0: number
}
/** Keeps an sp² center coplanar with its three neighbors (a, b, d). */
interface ImproperTerm {
  c: number
  a: number
  b: number
  d: number
}
/** Keeps the dihedral a–b–c–d planar (0 or 180°) around a double bond b=c. */
interface TorsionTerm {
  a: number
  b: number
  c: number
  d: number
}

/**
 * Relax the molecule's atom coordinates in place. `iterations` caps the descent
 * steps (molecules are small, so a couple hundred converges). Returns the same
 * object for convenience.
 */
export function relax(mol: BuilderMolecule, iterations = 200): BuilderMolecule {
  const atoms = mol.atoms
  const n = atoms.length
  if (n < 2) return mol

  const idx = new Map<number, number>()
  atoms.forEach((a, i) => idx.set(a.id, i))

  const px = new Float64Array(n)
  const py = new Float64Array(n)
  const pz = new Float64Array(n)
  atoms.forEach((a, i) => {
    px[i] = a.x
    py[i] = a.y
    pz[i] = a.z
  })

  // --- Precompute energy terms from the (fixed) topology --------------------
  const neighbors: number[][] = atoms.map(() => [])
  const bondTerms: BondTerm[] = []
  for (const bd of mol.bonds) {
    const i = idx.get(bd.a)
    const j = idx.get(bd.b)
    if (i == null || j == null) continue
    neighbors[i].push(j)
    neighbors[j].push(i)
    bondTerms.push({ i, j, r0: idealBondLength(atoms[i].element, atoms[j].element, bd.order) })
  }

  // Per-atom max/double bond order, for the ideal angle at each center.
  const maxOrder = new Float64Array(n)
  const doubleCount = new Float64Array(n)
  for (const bd of mol.bonds) {
    const i = idx.get(bd.a)
    const j = idx.get(bd.b)
    if (i == null || j == null) continue
    maxOrder[i] = Math.max(maxOrder[i], bd.order)
    maxOrder[j] = Math.max(maxOrder[j], bd.order)
    if (bd.order === 2) {
      doubleCount[i] += 1
      doubleCount[j] += 1
    }
  }

  const angleTerms: AngleTerm[] = []
  for (let c = 0; c < n; c++) {
    const nb = neighbors[c]
    if (nb.length < 2) continue
    const theta0 = (idealAngleDeg(maxOrder[c], doubleCount[c]) * Math.PI) / 180
    for (let a = 0; a < nb.length; a++) {
      for (let b = a + 1; b < nb.length; b++) {
        angleTerms.push({ c, a: nb[a], b: nb[b], theta0 })
      }
    }
  }

  // Improper terms: a 3-coordinate atom carrying a double bond is sp² and should
  // be planar with its three neighbors (the angle springs alone leave a ring free
  // to pucker, since 120° is satisfiable both flat and puckered).
  const improperTerms: ImproperTerm[] = []
  for (let c = 0; c < n; c++) {
    if (neighbors[c].length === 3 && maxOrder[c] === 2) {
      const [a, b, d] = neighbors[c]
      improperTerms.push({ c, a, b, d })
    }
  }

  // Torsion terms across every bond between two sp² centers (both endpoints carry
  // a double bond): each dihedral a–b–c–d is driven toward planar (0 or 180°).
  // Using *all* sp²–sp² bonds, not just the double bonds, flattens a whole
  // conjugated/aromatic ring — in a Kekulé benzene the single bonds between the
  // double bonds would otherwise be free to twist and let the ring pucker. The
  // per-atom improper above only keeps each center locally coplanar, which a
  // globally folded ring can still satisfy.
  const torsionTerms: TorsionTerm[] = []
  for (const bd of mol.bonds) {
    const b = idx.get(bd.a)
    const c = idx.get(bd.b)
    if (b == null || c == null) continue
    if (maxOrder[b] !== 2 || maxOrder[c] !== 2) continue
    for (const a of neighbors[b]) {
      if (a === c) continue
      for (const d of neighbors[c]) {
        if (d === b || d === a) continue
        torsionTerms.push({ a, b, c, d })
      }
    }
  }

  // Clash pairs: every non-bonded pair that doesn't share a bonded neighbor (1-3).
  const bonded = new Set<number>()
  const pairKey = (i: number, j: number): number => (i < j ? i * n + j : j * n + i)
  for (const t of bondTerms) bonded.add(pairKey(t.i, t.j))
  // angleTerm a/b are already array indices (neighbors store indices), so the two
  // ends of each angle are a 1-3 pair excluded from clash.
  const oneThree = new Set<number>()
  for (const t of angleTerms) oneThree.add(pairKey(t.a, t.b))

  const vdw = atoms.map((a) => elementInfo(a.element).vdwRadius)
  const clashTerms: ClashTerm[] = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const k = pairKey(i, j)
      if (bonded.has(k) || oneThree.has(k)) continue
      clashTerms.push({ i, j, d0: CLASH_SCALE * (vdw[i] + vdw[j]) })
    }
  }

  const gx = new Float64Array(n)
  const gy = new Float64Array(n)
  const gz = new Float64Array(n)

  /** Accumulate energy and gradient (∂E/∂x) for the current positions. */
  function evaluate(withGrad: boolean): number {
    let E = 0
    if (withGrad) {
      gx.fill(0)
      gy.fill(0)
      gz.fill(0)
    }
    // Bonds
    for (const t of bondTerms) {
      const dx = px[t.j] - px[t.i]
      const dy = py[t.j] - py[t.i]
      const dz = pz[t.j] - pz[t.i]
      const r = Math.hypot(dx, dy, dz) || 1e-9
      const diff = r - t.r0
      E += 0.5 * KB * diff * diff
      if (withGrad) {
        const f = (KB * diff) / r
        gx[t.j] += f * dx
        gy[t.j] += f * dy
        gz[t.j] += f * dz
        gx[t.i] -= f * dx
        gy[t.i] -= f * dy
        gz[t.i] -= f * dz
      }
    }
    // Angles
    for (const t of angleTerms) {
      const ux = px[t.a] - px[t.c]
      const uy = py[t.a] - py[t.c]
      const uz = pz[t.a] - pz[t.c]
      const vx = px[t.b] - px[t.c]
      const vy = py[t.b] - py[t.c]
      const vz = pz[t.b] - pz[t.c]
      const ru = Math.hypot(ux, uy, uz) || 1e-9
      const rv = Math.hypot(vx, vy, vz) || 1e-9
      let cos = (ux * vx + uy * vy + uz * vz) / (ru * rv)
      cos = Math.max(-1, Math.min(1, cos))
      const sin = Math.sqrt(Math.max(1e-8, 1 - cos * cos))
      const theta = Math.acos(cos)
      const diff = theta - t.theta0
      E += 0.5 * KA * diff * diff
      if (withGrad && sin > 1e-4) {
        const coeff = (KA * diff) / sin
        // ∂θ/∂a = (cos·û − v̂)/(|u|·sin), similarly for b; ∂θ/∂c = −(∂θ/∂a+∂θ/∂b)
        const uhx = ux / ru
        const uhy = uy / ru
        const uhz = uz / ru
        const vhx = vx / rv
        const vhy = vy / rv
        const vhz = vz / rv
        const dax = (coeff * (cos * uhx - vhx)) / ru
        const day = (coeff * (cos * uhy - vhy)) / ru
        const daz = (coeff * (cos * uhz - vhz)) / ru
        const dbx = (coeff * (cos * vhx - uhx)) / rv
        const dby = (coeff * (cos * vhy - uhy)) / rv
        const dbz = (coeff * (cos * vhz - uhz)) / rv
        gx[t.a] += dax
        gy[t.a] += day
        gz[t.a] += daz
        gx[t.b] += dbx
        gy[t.b] += dby
        gz[t.b] += dbz
        gx[t.c] -= dax + dbx
        gy[t.c] -= day + dby
        gz[t.c] -= daz + dbz
      }
    }
    // Improper / out-of-plane: penalize the signed volume of the tetrahedron
    // (center, a, b, d). Zero volume ⇒ the four atoms are coplanar. The squared
    // volume is smooth everywhere (no collinearity singularities) and its gradient
    // is a clean set of cross products.
    for (const t of improperTerms) {
      const ux = px[t.c] - px[t.a]
      const uy = py[t.c] - py[t.a]
      const uz = pz[t.c] - pz[t.a]
      const vx = px[t.b] - px[t.a]
      const vy = py[t.b] - py[t.a]
      const vz = pz[t.b] - pz[t.a]
      const wx = px[t.d] - px[t.a]
      const wy = py[t.d] - py[t.a]
      const wz = pz[t.d] - pz[t.a]
      // v × w, w × u, u × v
      const vwx = vy * wz - vz * wy
      const vwy = vz * wx - vx * wz
      const vwz = vx * wy - vy * wx
      const V = ux * vwx + uy * vwy + uz * vwz // det[u, v, w]
      E += 0.5 * KI * V * V
      if (withGrad) {
        const f = KI * V
        const wux = wy * uz - wz * uy
        const wuy = wz * ux - wx * uz
        const wuz = wx * uy - wy * ux
        const uvx = uy * vz - uz * vy
        const uvy = uz * vx - ux * vz
        const uvz = ux * vy - uy * vx
        // ∂V/∂c = v×w, ∂V/∂b = w×u, ∂V/∂d = u×v, ∂V/∂a = −(sum)
        gx[t.c] += f * vwx
        gy[t.c] += f * vwy
        gz[t.c] += f * vwz
        gx[t.b] += f * wux
        gy[t.b] += f * wuy
        gz[t.b] += f * wuz
        gx[t.d] += f * uvx
        gy[t.d] += f * uvy
        gz[t.d] += f * uvz
        gx[t.a] -= f * (vwx + wux + uvx)
        gy[t.a] -= f * (vwy + wuy + uvy)
        gz[t.a] -= f * (vwz + wuz + uvz)
      }
    }
    // Torsion: penalize sin²φ of the dihedral a–b–c–d so it rests at 0 or 180°
    // (planar). Standard dihedral gradient (Blondel–Karplus form).
    for (const t of torsionTerms) {
      const b1x = px[t.b] - px[t.a]
      const b1y = py[t.b] - py[t.a]
      const b1z = pz[t.b] - pz[t.a]
      const b2x = px[t.c] - px[t.b]
      const b2y = py[t.c] - py[t.b]
      const b2z = pz[t.c] - pz[t.b]
      const b3x = px[t.d] - px[t.c]
      const b3y = py[t.d] - py[t.c]
      const b3z = pz[t.d] - pz[t.c]
      // n1 = b1×b2, n2 = b2×b3
      const n1x = b1y * b2z - b1z * b2y
      const n1y = b1z * b2x - b1x * b2z
      const n1z = b1x * b2y - b1y * b2x
      const n2x = b2y * b3z - b2z * b3y
      const n2y = b2z * b3x - b2x * b3z
      const n2z = b2x * b3y - b2y * b3x
      const n1sq = n1x * n1x + n1y * n1y + n1z * n1z
      const n2sq = n2x * n2x + n2y * n2y + n2z * n2z
      const b2len = Math.sqrt(b2x * b2x + b2y * b2y + b2z * b2z)
      if (n1sq < 1e-10 || n2sq < 1e-10 || b2len < 1e-9) continue
      const n1n2 = Math.sqrt(n1sq * n2sq)
      let cos = (n1x * n2x + n1y * n2y + n1z * n2z) / n1n2
      cos = Math.max(-1, Math.min(1, cos))
      // sinφ = (n1×n2)·b2 / (|b2| |n1| |n2|)
      const cnx = n1y * n2z - n1z * n2y
      const cny = n1z * n2x - n1x * n2z
      const cnz = n1x * n2y - n1y * n2x
      const sin = (cnx * b2x + cny * b2y + cnz * b2z) / (b2len * n1n2)
      E += 0.5 * KT * sin * sin
      if (withGrad) {
        // dE/dφ = KT·sinφ·cosφ
        const dEdphi = KT * sin * cos
        // ∂φ/∂a and ∂φ/∂d, then b,c by the projection identities (sum = 0).
        const fa = -b2len / n1sq
        const ax = fa * n1x
        const ay = fa * n1y
        const az = fa * n1z
        const fd = b2len / n2sq
        const dx = fd * n2x
        const dy = fd * n2y
        const dz = fd * n2z
        const p = (b1x * b2x + b1y * b2y + b1z * b2z) / (b2len * b2len)
        const q = (b3x * b2x + b3y * b2y + b3z * b2z) / (b2len * b2len)
        const bx = (p - 1) * ax - q * dx
        const by = (p - 1) * ay - q * dy
        const bz = (p - 1) * az - q * dz
        const cx = -p * ax + (q - 1) * dx
        const cy = -p * ay + (q - 1) * dy
        const cz = -p * az + (q - 1) * dz
        gx[t.a] += dEdphi * ax
        gy[t.a] += dEdphi * ay
        gz[t.a] += dEdphi * az
        gx[t.b] += dEdphi * bx
        gy[t.b] += dEdphi * by
        gz[t.b] += dEdphi * bz
        gx[t.c] += dEdphi * cx
        gy[t.c] += dEdphi * cy
        gz[t.c] += dEdphi * cz
        gx[t.d] += dEdphi * dx
        gy[t.d] += dEdphi * dy
        gz[t.d] += dEdphi * dz
      }
    }
    // Non-bonded clash (repulsive only, inside d0)
    for (const t of clashTerms) {
      const dx = px[t.j] - px[t.i]
      const dy = py[t.j] - py[t.i]
      const dz = pz[t.j] - pz[t.i]
      const r = Math.hypot(dx, dy, dz) || 1e-9
      if (r >= t.d0) continue
      const diff = r - t.d0 // negative
      E += 0.5 * KC * diff * diff
      if (withGrad) {
        const f = (KC * diff) / r
        gx[t.j] += f * dx
        gy[t.j] += f * dy
        gz[t.j] += f * dz
        gx[t.i] -= f * dx
        gy[t.i] -= f * dy
        gz[t.i] -= f * dz
      }
    }
    return E
  }

  // --- Two-phase relaxation ------------------------------------------------
  // Phase 1: FIRE (inertial MD with adaptive damping) to escape the puckered /
  // symmetric local minima that a pure descent gets stuck in (e.g. a folded
  // aromatic ring). A small capped timestep keeps it stable under the stiff bond
  // and improper springs. Phase 2: a short steepest-descent polish guarantees we
  // finish at a clean local minimum (and never worse than FIRE left us).
  const DT_MAX = 0.18
  const N_MIN = 5
  const F_INC = 1.1
  const F_DEC = 0.5
  const A_START = 0.1
  const F_A = 0.99
  let dt = 0.05
  let a = A_START
  let sinceNeg = 0

  const vx = new Float64Array(n)
  const vy = new Float64Array(n)
  const vz = new Float64Array(n)
  evaluate(true)

  const fireSteps = Math.floor(iterations * 0.7)
  for (let iter = 0; iter < fireSteps; iter++) {
    let power = 0
    let vnorm = 0
    let fnorm = 0
    let gmax = 0
    for (let i = 0; i < n; i++) {
      power += -gx[i] * vx[i] + -gy[i] * vy[i] + -gz[i] * vz[i]
      vnorm += vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i]
      fnorm += gx[i] * gx[i] + gy[i] * gy[i] + gz[i] * gz[i]
      gmax = Math.max(gmax, Math.abs(gx[i]), Math.abs(gy[i]), Math.abs(gz[i]))
    }
    if (gmax < 1e-5) break
    vnorm = Math.sqrt(vnorm)
    fnorm = Math.sqrt(fnorm)
    const mix = fnorm > 1e-12 ? (a * vnorm) / fnorm : 0
    for (let i = 0; i < n; i++) {
      vx[i] = (1 - a) * vx[i] - mix * gx[i]
      vy[i] = (1 - a) * vy[i] - mix * gy[i]
      vz[i] = (1 - a) * vz[i] - mix * gz[i]
    }
    if (power > 0) {
      sinceNeg += 1
      if (sinceNeg > N_MIN) {
        dt = Math.min(dt * F_INC, DT_MAX)
        a *= F_A
      }
    } else {
      sinceNeg = 0
      dt *= F_DEC
      a = A_START
      vx.fill(0)
      vy.fill(0)
      vz.fill(0)
    }
    for (let i = 0; i < n; i++) {
      vx[i] -= dt * gx[i]
      vy[i] -= dt * gy[i]
      vz[i] -= dt * gz[i]
      px[i] += dt * vx[i]
      py[i] += dt * vy[i]
      pz[i] += dt * vz[i]
    }
    evaluate(true)
  }

  // Phase 2: steepest descent with a backtracking line search (monotonic).
  let step = 0.05
  let E = evaluate(true)
  const tx = new Float64Array(n)
  const ty = new Float64Array(n)
  const tz = new Float64Array(n)
  for (let iter = fireSteps; iter < iterations; iter++) {
    let gmax = 0
    for (let i = 0; i < n; i++) {
      gmax = Math.max(gmax, Math.abs(gx[i]), Math.abs(gy[i]), Math.abs(gz[i]))
    }
    if (gmax < 1e-5) break
    let accepted = false
    for (let tries = 0; tries < 12; tries++) {
      for (let i = 0; i < n; i++) {
        tx[i] = px[i] - step * gx[i]
        ty[i] = py[i] - step * gy[i]
        tz[i] = pz[i] - step * gz[i]
      }
      const Etrial = evaluateAt(tx, ty, tz)
      if (Etrial < E) {
        px.set(tx)
        py.set(ty)
        pz.set(tz)
        E = Etrial
        step *= 1.2
        accepted = true
        break
      }
      step *= 0.5
    }
    if (!accepted) break
    E = evaluate(true)
  }

  /** Energy-only evaluation at given coordinates (for the line search). */
  function evaluateAt(qx: Float64Array, qy: Float64Array, qz: Float64Array): number {
    const sx = px.slice()
    const sy = py.slice()
    const sz = pz.slice()
    px.set(qx)
    py.set(qy)
    pz.set(qz)
    const e = evaluate(false)
    px.set(sx)
    py.set(sy)
    pz.set(sz)
    return e
  }

  atoms.forEach((a, i) => {
    a.x = px[i]
    a.y = py[i]
    a.z = pz[i]
  })
  return mol
}
