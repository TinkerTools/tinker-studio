import { describe, it, expect, afterAll } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  hasSaveCycle,
  hasDcdArchive,
  buildLiveKey,
  cycleFilesFor,
  nextVersionName,
  splitArcFrames
} from './liveJob'
import { indexArc, readFrameCoords, detectStride } from './trajectory'

describe('liveJob helpers', () => {
  it('detects SAVE-CYCLE in a key (case-insensitive, line-anchored)', () => {
    expect(hasSaveCycle(undefined)).toBe(false)
    expect(hasSaveCycle('a-axis 20\nsave-cycle\n')).toBe(true)
    expect(hasSaveCycle('SAVE-CYCLE')).toBe(true)
    // not matched mid-line
    expect(hasSaveCycle('# do not save-cycle here')).toBe(false)
  })

  it('detects DCD-ARCHIVE in a key (case-insensitive, line-anchored)', () => {
    expect(hasDcdArchive(undefined)).toBe(false)
    expect(hasDcdArchive('parameters amoeba\nDCD-ARCHIVE\n')).toBe(true)
    expect(hasDcdArchive('  dcd-archive')).toBe(true)
    expect(hasDcdArchive('# not dcd-archive here')).toBe(false)
  })

  it('builds a temp key that appends SAVE-CYCLE', () => {
    expect(buildLiveKey(undefined)).toBe('SAVE-CYCLE\n')
    expect(buildLiveKey('parameters amoeba\n')).toBe('parameters amoeba\nSAVE-CYCLE\n')
    expect(buildLiveKey('a\nb')).toBe('a\nb\nSAVE-CYCLE\n')
  })

  it('finds and orders numbered cycle files for a stem', () => {
    const names = ['mol.xyz', 'mol.key', 'mol.002', 'mol.001', 'mol.010', 'other.001']
    expect(cycleFilesFor(names, 'mol').map((c) => c.name)).toEqual(['mol.001', 'mol.002', 'mol.010'])
  })

  it('picks the next free version-numbered output name', () => {
    expect(nextVersionName([], 'mol.xyz')).toBe('mol.xyz_2')
    expect(nextVersionName(['mol.xyz_2', 'mol.xyz_3'], 'mol.xyz')).toBe('mol.xyz_4')
  })
})

describe('splitArcFrames (incremental .arc framing)', () => {
  // 2-atom frames, no box line: stride = 3 lines.
  const frame = (x: number): string =>
    `2 t\n1 C ${x}.0 0.0 0.0 1 2\n2 O 1.0 0.0 0.0 2 1\n`

  it('emits only complete frames and carries the partial remainder forward', () => {
    const a = splitArcFrames(frame(0) + '2 t\n1 C 5', 0)
    expect(a.frames).toHaveLength(1)
    expect(a.stride).toBe(3)
    expect(a.rest).toBe('2 t\n1 C 5')

    // feeding the rest of that frame plus a bit of the next completes frame 2
    const b = splitArcFrames(a.rest + frame(1).slice('2 t\n1 C 5'.length) + '2 t\n', a.stride)
    expect(b.frames).toHaveLength(1)
    expect(b.rest).toBe('2 t\n')
  })

  it('waits until the first frame is fully known before deciding stride', () => {
    const r = splitArcFrames('2 t\n', 0)
    expect(r.frames).toHaveLength(0)
    expect(r.stride).toBe(0)
  })

  it('handles a periodic box line (stride = atoms + 2)', () => {
    const boxed = '2 t\n20.0 20.0 20.0 90.0 90.0 90.0\n1 C 0.0 0.0 0.0 1 2\n2 O 1.0 0.0 0.0 2 1\n'
    const r = splitArcFrames(boxed, 0)
    expect(r.stride).toBe(4)
    expect(r.frames).toHaveLength(1)
  })
})

describe('live .arc incremental indexing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ffe-live-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  // Mirror the main-process live watcher: read the file in arbitrary chunks,
  // frame the completed ones, and build a byte-offset index from the cumulative
  // byte length of each frame. That index must read back identically to the one
  // a full indexArc() scan produces (the renderer's trajectory:frame relies on it).
  it('builds offsets that match a full indexArc scan, across chunk boundaries', () => {
    const boxed = '2 t\n20.0 20.0 20.0 90.0 90.0 90.0' // box line so stride = 4
    const frame = (x: number): string => `${boxed}\n1 C ${x}.0 0.0 0.0 1 2\n2 O 1.0 0.0 0.0 2 1\n`
    const full = frame(0) + frame(1) + frame(2) + frame(3)
    const path = join(dir, 'live.arc')
    writeFileSync(path, full)

    // Feed the text in 7-byte chunks to exercise partial-frame carry-over.
    let buffer = ''
    let stride = 0
    const offsets = [0]
    let natoms = 0
    let hasBox = false
    for (let i = 0; i < full.length; i += 7) {
      buffer += full.slice(i, i + 7)
      const r = splitArcFrames(buffer, stride)
      stride = r.stride
      buffer = r.rest
      if (r.frames.length && natoms === 0) {
        const l = r.frames[0].split('\n')
        const d = detectStride(l[0], l[1] ?? '')
        natoms = d.natoms
        hasBox = d.hasBox
      }
      for (const t of r.frames) offsets.push(offsets[offsets.length - 1] + Buffer.byteLength(t, 'utf8'))
    }

    const canonical = indexArc(path)
    expect({ natoms, hasBox, frameCount: offsets.length - 1 }).toEqual({
      natoms: canonical.natoms,
      hasBox: canonical.hasBox,
      frameCount: canonical.frameCount
    })
    expect(offsets).toEqual(canonical.offsets)

    // And the resulting index decodes every frame correctly.
    const live = { path, offsets, natoms, hasBox, frameCount: offsets.length - 1 }
    for (let f = 0; f < live.frameCount; f++) {
      expect(Array.from(readFrameCoords(live, f))).toEqual([f, 0, 0, 1, 0, 0])
    }
  })
})
