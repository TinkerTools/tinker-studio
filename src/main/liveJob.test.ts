import { describe, it, expect } from 'vitest'
import { hasSaveCycle, buildLiveKey, cycleFilesFor, nextVersionName, splitArcFrames } from './liveJob'

describe('liveJob helpers', () => {
  it('detects SAVE-CYCLE in a key (case-insensitive, line-anchored)', () => {
    expect(hasSaveCycle(undefined)).toBe(false)
    expect(hasSaveCycle('a-axis 20\nsave-cycle\n')).toBe(true)
    expect(hasSaveCycle('SAVE-CYCLE')).toBe(true)
    // not matched mid-line
    expect(hasSaveCycle('# do not save-cycle here')).toBe(false)
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
