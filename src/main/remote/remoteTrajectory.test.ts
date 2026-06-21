import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { indexArc, readFrameText } from '../trajectory'
import { awkOffsetCommand, parseAwkOffsets } from './remoteTrajectory'

/**
 * The hardest part of remote .arc streaming is the on-cluster `awk` pass that
 * produces frame-start byte offsets. We can't reach a real cluster from CI, but
 * `awk` is the same program here — so run the EXACT command we'd send remotely
 * against a bundled sample and check the offsets match the trusted local indexer.
 */
describe('remote .arc awk offset indexing', () => {
  const arc = join(__dirname, '../../renderer/src/samples/nitrogen.arc')

  it('produces offsets identical to the local indexer', () => {
    const local = indexArc(arc)
    const stride = 1 + (local.hasBox ? 1 : 0) + local.natoms
    // Run the remote command locally via /bin/sh (mirrors the remote shell).
    const stdout = execFileSync('/bin/sh', ['-c', awkOffsetCommand(arc, stride)], {
      encoding: 'utf8'
    })
    const { offsets, frameCount } = parseAwkOffsets(stdout, stride)
    expect(frameCount).toBe(local.frameCount)
    expect(offsets).toEqual(local.offsets)
  })

  it('byte ranges from the awk offsets select whole frames', () => {
    const local = indexArc(arc)
    const stride = 1 + (local.hasBox ? 1 : 0) + local.natoms
    const stdout = execFileSync('/bin/sh', ['-c', awkOffsetCommand(arc, stride)], {
      encoding: 'utf8'
    })
    const { offsets } = parseAwkOffsets(stdout, stride)
    // The text a remote range read would fetch equals the local frame text.
    expect(offsets[1] - offsets[0]).toBe(local.offsets[1] - local.offsets[0])
    expect(readFrameText({ ...local, offsets }, 0)).toBe(readFrameText(local, 0))
  })

  it('drops a trailing partial frame', () => {
    // 2 complete frames of stride 3 plus a half-written 3rd frame (1 line).
    const stdout = ['0', '30', '60', '70\t7'].join('\n') + '\n'
    const { offsets, frameCount } = parseAwkOffsets(stdout, 3)
    expect(frameCount).toBe(2)
    expect(offsets).toEqual([0, 30, 60])
  })

  it('keeps an exact final frame (no partial)', () => {
    const stdout = ['0', '30', '90\t6'].join('\n') + '\n'
    const { offsets, frameCount } = parseAwkOffsets(stdout, 3)
    expect(frameCount).toBe(2)
    expect(offsets).toEqual([0, 30, 90])
  })
})
