import { describe, it, expect } from 'vitest'
import { hasSaveCycle, buildLiveKey, cycleFilesFor, nextVersionName } from './liveJob'

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
