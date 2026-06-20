import { describe, it, expect, afterAll } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDcd, readDcdFrame } from './dcd'

// Build a minimal CHARMM/X-PLOR .dcd (no box, no fixed atoms) from interleaved
// per-frame coordinates, in the requested byte order.
function buildDcd(natom: number, frames: number[][], le = true): Buffer {
  const frameSize = 3 * (8 + 4 * natom)
  const total = 92 + 12 + 12 + frames.length * frameSize
  const buf = Buffer.alloc(total)
  let o = 0
  const i32 = (v: number): void => {
    le ? buf.writeInt32LE(v, o) : buf.writeInt32BE(v, o)
    o += 4
  }
  const f32 = (v: number): void => {
    le ? buf.writeFloatLE(v, o) : buf.writeFloatBE(v, o)
    o += 4
  }
  // Header block 1
  i32(84)
  buf.write('CORD', o, 'ascii')
  o += 4
  const icntrl = new Array(20).fill(0)
  icntrl[0] = frames.length
  for (const v of icntrl) i32(v)
  i32(84)
  // Title block (NTITLE = 0)
  i32(4)
  i32(0)
  i32(4)
  // Atom-count block
  i32(4)
  i32(natom)
  i32(4)
  // Frames: separate X / Y / Z arrays, each a Fortran record.
  const m = 4 * natom
  for (const fr of frames) {
    for (let c = 0; c < 3; c++) {
      i32(m)
      for (let a = 0; a < natom; a++) f32(fr[a * 3 + c])
      i32(m)
    }
  }
  return buf
}

describe('dcd reader', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ffe-dcd-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const frames = [
    [1, 2, 3, 4, 5, 6, 7, 8, 9], // 3 atoms
    [10, 11, 12, 13, 14, 15, 16, 17, 18]
  ]

  it('parses the header and reads interleaved frame coordinates (little-endian)', () => {
    const path = join(dir, 'le.dcd')
    writeFileSync(path, buildDcd(3, frames, true))
    const idx = openDcd(path)
    expect(idx.natoms).toBe(3)
    expect(idx.frameCount).toBe(2)
    expect(idx.hasBox).toBe(false)
    expect(idx.littleEndian).toBe(true)
    expect(Array.from(readDcdFrame(idx, 0))).toEqual(frames[0])
    expect(Array.from(readDcdFrame(idx, 1))).toEqual(frames[1])
  })

  it('handles big-endian files', () => {
    const path = join(dir, 'be.dcd')
    writeFileSync(path, buildDcd(3, frames, false))
    const idx = openDcd(path)
    expect(idx.littleEndian).toBe(false)
    expect(idx.frameCount).toBe(2)
    expect(Array.from(readDcdFrame(idx, 1))).toEqual(frames[1])
  })

  it('derives the frame count from file size, not the (possibly stale) header', () => {
    // Three frames on disk even though only the first is described; count = 3.
    const path = join(dir, 'count.dcd')
    writeFileSync(path, buildDcd(2, [[0, 0, 0, 1, 1, 1], [2, 2, 2, 3, 3, 3], [4, 4, 4, 5, 5, 5]]))
    expect(openDcd(path).frameCount).toBe(3)
  })

  it('rejects a non-DCD file', () => {
    const path = join(dir, 'bad.dcd')
    writeFileSync(path, Buffer.alloc(200))
    expect(() => openDcd(path)).toThrow()
  })
})
