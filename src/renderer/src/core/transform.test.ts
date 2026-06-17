import { describe, it, expect } from 'vitest'
import { applyTransform, bakeTransform, isIdentityTransform, IDENTITY_TRANSFORM } from './transform'
import type { Structure } from './types'

// 90° rotation about z: maps +x -> +y.
const ROT_Z_90: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2]

describe('transform', () => {
  it('identity transform leaves points unchanged', () => {
    expect(isIdentityTransform(IDENTITY_TRANSFORM)).toBe(true)
    expect(applyTransform([1, 2, 3], IDENTITY_TRANSFORM)).toEqual([1, 2, 3])
  })

  it('rotates then translates', () => {
    const t = { position: [10, 0, 0] as [number, number, number], quaternion: ROT_Z_90 }
    const [x, y, z] = applyTransform([1, 0, 0], t)
    expect(x).toBeCloseTo(10)
    expect(y).toBeCloseTo(1)
    expect(z).toBeCloseTo(0)
  })

  it('bakes a transform into atom coordinates', () => {
    const s: Structure = {
      title: 't',
      atoms: [{ index: 1, name: 'C', element: 'C', x: 1, y: 0, z: 0, type: 0, bonds: [] }],
      bonds: []
    }
    const baked = bakeTransform(s, { position: [0, 0, 5], quaternion: ROT_Z_90 })
    expect(baked.atoms[0].x).toBeCloseTo(0)
    expect(baked.atoms[0].y).toBeCloseTo(1)
    expect(baked.atoms[0].z).toBeCloseTo(5)
    // original is untouched
    expect(s.atoms[0].x).toBe(1)
  })

  it('returns the same structure for an identity transform', () => {
    const s: Structure = { title: 't', atoms: [], bonds: [] }
    expect(bakeTransform(s, undefined)).toBe(s)
  })
})
