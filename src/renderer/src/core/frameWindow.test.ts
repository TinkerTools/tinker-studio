import { describe, it, expect } from 'vitest'
import { FrameWindow } from './frameWindow'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('FrameWindow', () => {
  it('prefetches the current frame + read-ahead in the play direction', async () => {
    const fetched: number[] = []
    const w = new FrameWindow(
      't',
      12,
      async (_id, idx) => {
        fetched.push(idx)
        return new Float32Array([idx])
      },
      () => {},
      { budgetBytes: 600, prefetchAhead: 2 } // capacity 50, ahead 2
    )
    w.request(10, 100, 1)
    await flush()
    expect(fetched.sort((a, b) => a - b)).toEqual([10, 11, 12])
    expect(w.get(10)?.[0]).toBe(10)
    expect(w.get(13)).toBeNull() // beyond the read-ahead
  })

  it('evicts the frames furthest behind, keeping a forward-biased window within budget', async () => {
    const w = new FrameWindow(
      't',
      12,
      async (_id, idx) => new Float32Array([idx]),
      () => {},
      { budgetBytes: 60, prefetchAhead: 2 } // capacity = 60/12 = 5
    )
    w.request(0, 100, 1)
    await flush()
    expect([0, 1, 2].every((i) => w.get(i) != null)).toBe(true)

    w.request(3, 100, 1)
    await flush()
    // 6 frames fetched (0..5) but capacity is 5 → the furthest-behind (0) is dropped.
    expect(w.get(0)).toBeNull()
    expect([1, 2, 3, 4, 5].every((i) => w.get(i) != null)).toBe(true)
  })

  it("doesn't prefetch past the end of the trajectory", async () => {
    const fetched: number[] = []
    const w = new FrameWindow(
      't',
      12,
      async (_id, idx) => {
        fetched.push(idx)
        return new Float32Array([idx])
      },
      () => {},
      { budgetBytes: 600, prefetchAhead: 5 }
    )
    w.request(8, 10, 1) // frames 8,9 valid; 10..13 out of range
    await flush()
    expect(fetched.sort((a, b) => a - b)).toEqual([8, 9])
  })
})
