import { describe, it, expect } from 'vitest'
import { distance, angle, dihedral } from './measure'

describe('measure', () => {
  it('distance', () => {
    expect(distance([0, 0, 0], [3, 4, 0])).toBeCloseTo(5)
  })

  it('angle (at the middle atom)', () => {
    expect(angle([1, 0, 0], [0, 0, 0], [0, 1, 0])).toBeCloseTo(90)
    expect(angle([1, 0, 0], [0, 0, 0], [-1, 0, 0])).toBeCloseTo(180)
  })

  it('dihedral', () => {
    // a–b–c–d rotated 90° about the b–c axis.
    expect(dihedral([1, 0, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1])).toBeCloseTo(-90)
    // Planar (cis) arrangement.
    expect(Math.abs(dihedral([1, 0, 0], [0, 0, 0], [0, 0, 1], [1, 0, 1]))).toBeCloseTo(0)
  })
})
