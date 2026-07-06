import { describe, it, expect } from 'vitest'
import { resolveKeyParameterPaths } from './tinkerKey'

const PARAMS = '/Users/ponder/tinker/params'
// Pretend basic.prm and amoeba09.prm exist in the params dir; nothing else does.
const present = new Set([`${PARAMS}/basic.prm`, `${PARAMS}/amoeba09.prm`])
const exists = (p: string): boolean => present.has(p)

describe('resolveKeyParameterPaths', () => {
  it('rewrites a bare basic.prm to the absolute params path', () => {
    const out = resolveKeyParameterPaths('parameters basic.prm\n', PARAMS, exists)
    expect(out).toBe(`parameters "${PARAMS}/basic.prm"\n`)
  })

  it('infers the .prm extension when omitted', () => {
    const out = resolveKeyParameterPaths('parameters basic', PARAMS, exists)
    expect(out).toBe(`parameters "${PARAMS}/basic.prm"`)
  })

  it('strips surrounding quotes before resolving', () => {
    const out = resolveKeyParameterPaths('parameters "amoeba09.prm"', PARAMS, exists)
    expect(out).toBe(`parameters "${PARAMS}/amoeba09.prm"`)
  })

  it('preserves indentation, casing, and other keywords', () => {
    const key = ['# a built molecule', '  PARAMETERS basic.prm', 'a-axis 20.0'].join('\n')
    const out = resolveKeyParameterPaths(key, PARAMS, exists)
    expect(out).toBe(
      ['# a built molecule', `  PARAMETERS "${PARAMS}/basic.prm"`, 'a-axis 20.0'].join('\n')
    )
  })

  it('leaves a value that already contains a path untouched', () => {
    const key = 'parameters /opt/tinker/params/basic.prm'
    expect(resolveKeyParameterPaths(key, PARAMS, exists)).toBe(key)
  })

  it('leaves an unresolvable bare name untouched', () => {
    const key = 'parameters mystery.prm'
    expect(resolveKeyParameterPaths(key, PARAMS, exists)).toBe(key)
  })

  it('is a no-op when the params dir is unknown', () => {
    const key = 'parameters basic.prm'
    expect(resolveKeyParameterPaths(key, null, exists)).toBe(key)
  })

  it('does not touch non-parameters lines that mention the word', () => {
    const key = '# choose your parameters carefully'
    expect(resolveKeyParameterPaths(key, PARAMS, exists)).toBe(key)
  })
})
