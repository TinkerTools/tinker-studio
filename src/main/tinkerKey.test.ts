import { describe, it, expect } from 'vitest'
import { resolveKeyParameterPaths } from './tinkerKey'

const PARAMS = '/Users/ponder/tinker/params'

// Mirrors the main process's provisionJobKey resolver: basic.prm is copied into the
// job dir and kept bare (resolver returns null), any other known name resolves to an
// absolute path in the Tinker params dir, and unknown names are left as written.
const resolve = (name: string): string | null => {
  const file = /\.prm$/i.test(name) ? name : `${name}.prm`
  if (file.toLowerCase() === 'basic.prm') return null // provisioned locally, kept bare
  if (file.toLowerCase() === 'amoeba09.prm') return `${PARAMS}/amoeba09.prm`
  return null
}

describe('resolveKeyParameterPaths', () => {
  it('leaves basic.prm bare (it is provisioned into the job dir)', () => {
    expect(resolveKeyParameterPaths('parameters basic.prm\n', resolve)).toBe('parameters basic.prm\n')
  })

  it('resolves another named parameter file to an absolute path', () => {
    expect(resolveKeyParameterPaths('parameters amoeba09.prm', resolve)).toBe(
      `parameters "${PARAMS}/amoeba09.prm"`
    )
  })

  it('strips surrounding quotes and infers .prm before resolving', () => {
    expect(resolveKeyParameterPaths('parameters "amoeba09"', resolve)).toBe(
      `parameters "${PARAMS}/amoeba09.prm"`
    )
  })

  it('preserves indentation, casing, and other keywords', () => {
    const key = ['# a built molecule', '  PARAMETERS amoeba09.prm', 'a-axis 20.0'].join('\n')
    expect(resolveKeyParameterPaths(key, resolve)).toBe(
      ['# a built molecule', `  PARAMETERS "${PARAMS}/amoeba09.prm"`, 'a-axis 20.0'].join('\n')
    )
  })

  it('leaves a value that already contains a path untouched', () => {
    const key = 'parameters /opt/tinker/params/amoeba09.prm'
    expect(resolveKeyParameterPaths(key, resolve)).toBe(key)
  })

  it('leaves an unresolvable bare name untouched', () => {
    const key = 'parameters mystery.prm'
    expect(resolveKeyParameterPaths(key, resolve)).toBe(key)
  })

  it('does not touch non-parameters lines that mention the word', () => {
    const key = '# choose your parameters carefully'
    expect(resolveKeyParameterPaths(key, resolve)).toBe(key)
  })
})
