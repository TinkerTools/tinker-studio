import { describe, it, expect, afterAll } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { detectStride, parseFrameCoords, indexArc, readFrameCoords } from './trajectory'

describe('trajectory indexing', () => {
  it('detects stride from header + optional box', () => {
    expect(detectStride('2 t', '1 C 0 0 0 1')).toEqual({ natoms: 2, hasBox: false, stride: 3 })
    expect(detectStride('2 t', '20 20 20 90 90 90')).toEqual({ natoms: 2, hasBox: true, stride: 4 })
  })

  it('parses a frame\'s coordinates (skipping header + box)', () => {
    const text = '2 t\n20 20 20 90 90 90\n1 C 1.0 2.0 3.0 1 2\n2 O 4.0 5.0 6.0 2 1\n'
    expect(Array.from(parseFrameCoords(text, 2, true))).toEqual([1, 2, 3, 4, 5, 6])
  })

  const dir = mkdtempSync(join(tmpdir(), 'ffe-traj-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('indexes a multi-frame archive and reads frames by offset', () => {
    const frame = (x: number): string => `2 t\n1 C ${x}.0 0.0 0.0 1 2\n2 O 1.0 0.0 0.0 2 1\n`
    const path = join(dir, 'traj.arc')
    writeFileSync(path, frame(0) + frame(1) + frame(2))

    const index = indexArc(path)
    expect(index.frameCount).toBe(3)
    expect(index.natoms).toBe(2)
    expect(index.hasBox).toBe(false)
    expect(Array.from(readFrameCoords(index, 0))).toEqual([0, 0, 0, 1, 0, 0])
    expect(Array.from(readFrameCoords(index, 2))).toEqual([2, 0, 0, 1, 0, 0])
  })

  it('handles a periodic-box archive', () => {
    const frame = (x: number): string =>
      `2 t\n18 18 18 90 90 90\n1 C ${x}.0 0.0 0.0 1 2\n2 O 1.0 0.0 0.0 2 1\n`
    const path = join(dir, 'box.arc')
    writeFileSync(path, frame(0) + frame(5))
    const index = indexArc(path)
    expect(index.frameCount).toBe(2)
    expect(index.hasBox).toBe(true)
    expect(Array.from(readFrameCoords(index, 1))).toEqual([5, 0, 0, 1, 0, 0])
  })
})
