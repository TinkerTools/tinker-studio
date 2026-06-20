/**
 * Forward-biased, byte-budgeted frame window for streamed (lazy) trajectories.
 *
 * Playback is almost always forward, so we don't retain a big history — we keep
 * a sliding window of the current frame, a configurable read-ahead in the play
 * direction (to hide fetch latency), and whatever recent frames still fit a
 * memory *budget* (a small trail behind, for the occasional reversal). Frames
 * furthest behind the play direction are evicted first.
 *
 * Memory is bounded in *bytes*, not frame count: `capacity = budget / frameBytes`,
 * so a 10-atom system can hold thousands of frames while a million-atom system
 * holds only a handful — both within the same footprint. A whole trajectory that
 * fits the budget simply never evicts (it ends up fully resident); a huge or
 * remote one slides. The per-source config is the seam for future remote `.arc`
 * reads, which want a deeper read-ahead (higher latency) and possibly a tighter
 * budget.
 */

/** Always keep at least this many frames resident, even for huge per-frame sizes. */
const MIN_FRAMES = 4

export interface FrameSourceConfig {
  /** Maximum resident coordinate bytes. */
  budgetBytes: number
  /** How many frames ahead (in the play direction) to prefetch. */
  prefetchAhead: number
}

/** Local-disk default: reads are cheap, so a shallow read-ahead and modest budget. */
export const LOCAL_SOURCE: FrameSourceConfig = {
  budgetBytes: 96 * 1024 * 1024,
  prefetchAhead: 8
}

type FetchFrame = (trajId: string, index: number) => Promise<Float32Array | null>

export class FrameWindow {
  readonly trajId: string
  private readonly fetch: FetchFrame
  private readonly onArrive: () => void
  /** Max frames retained, derived from the byte budget. */
  private readonly capacity: number
  /** Effective read-ahead (never exceeds capacity − 1, so prefetched frames aren't evicted). */
  private readonly ahead: number

  private resident = new Map<number, Float32Array>()
  private inflight = new Set<number>()
  private cur = 0
  private dir = 1

  constructor(
    trajId: string,
    frameBytes: number,
    fetch: FetchFrame,
    onArrive: () => void,
    cfg: FrameSourceConfig = LOCAL_SOURCE
  ) {
    this.trajId = trajId
    this.fetch = fetch
    this.onArrive = onArrive
    this.capacity = Math.max(MIN_FRAMES, Math.floor(cfg.budgetBytes / Math.max(1, frameBytes)))
    this.ahead = Math.min(cfg.prefetchAhead, this.capacity - 1)
  }

  /** Resident coordinates for a frame, or null if it hasn't been fetched yet. */
  get(index: number): Float32Array | null {
    return this.resident.get(index) ?? null
  }

  /**
   * Note the current frame + play direction and kick off any missing prefetches
   * (the current frame and the next `ahead` in the play direction). Cheap to call
   * every frame; already-resident / in-flight frames are skipped.
   */
  request(cur: number, frameCount: number, dir = 1): void {
    this.cur = cur
    this.dir = dir >= 0 ? 1 : -1
    for (let d = 0; d <= this.ahead; d++) {
      const idx = cur + d * this.dir
      if (idx < 0 || idx >= frameCount) break
      if (this.resident.has(idx) || this.inflight.has(idx)) continue
      this.inflight.add(idx)
      void this.fetch(this.trajId, idx).then((coords) => {
        this.inflight.delete(idx)
        if (!coords) return
        this.admit(idx, coords)
        this.onArrive()
      })
    }
  }

  private admit(index: number, coords: Float32Array): void {
    this.resident.set(index, coords)
    while (this.resident.size > this.capacity) {
      let evict = -1
      let worst = -Infinity
      for (const i of this.resident.keys()) {
        if (i === index) continue
        const r = this.rank(i)
        if (r > worst) {
          worst = r
          evict = i
        }
      }
      if (evict < 0) break
      this.resident.delete(evict)
    }
  }

  /** Lower = keep. Current frame is 0, the read-ahead is 1..ahead, the trail behind ranks after. */
  private rank(index: number): number {
    const ahead = (index - this.cur) * this.dir
    return ahead >= 0 ? ahead : this.ahead + 1 - ahead
  }

  dispose(): void {
    this.resident.clear()
    this.inflight.clear()
  }
}
