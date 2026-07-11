import { describe, it, expect } from 'vitest'
import { resolveKeyParameterPaths } from './tinkerKey'

const HOME = '/Users/ponder'
const BASIC = '/var/folders/x/T/tinker-studio/basic.prm'
const PARAMS = '/Users/ponder/tinker/params'

// Mirrors the main process's provisionJobKey resolver: expand ~, keep absolute paths,
// map bare basic.prm to the copy staged in the job dir, resolve other bare names in
// the Tinker params dir, and leave anything else (incl. `none`) untouched.
const resolve = (value: string): string | null => {
  if (value.toLowerCase() === 'none') return null
  let p = value
  if (p === '~' || p.startsWith('~/')) p = `${HOME}${p.slice(1)}`
  if (p.startsWith('/')) return p // absolute
  if (p.includes('/')) return null // relative w/o a base dir
  const file = /\.prm$/i.test(p) ? p : `${p}.prm`
  if (file.toLowerCase() === 'basic.prm') return BASIC
  if (file.toLowerCase() === 'amber99sb.prm') return `${PARAMS}/amber99sb.prm`
  return null
}

describe('resolveKeyParameterPaths', () => {
  it('expands a ~ parameters path to an absolute path (unquoted, no spaces)', () => {
    expect(resolveKeyParameterPaths('parameters ~/tinker/params/amber99sb.prm\n', resolve)).toBe(
      `parameters ${HOME}/tinker/params/amber99sb.prm\n`
    )
  })

  it('quotes an absolute path only when it contains a space', () => {
    expect(resolveKeyParameterPaths('parameters /opt/my params/x.prm', resolve)).toBe(
      'parameters "/opt/my params/x.prm"'
    )
  })

  it('maps bare basic.prm to the staged job-dir copy', () => {
    expect(resolveKeyParameterPaths('parameters basic.prm', resolve)).toBe(`parameters ${BASIC}`)
  })

  it('resolves another bare name in the Tinker params dir (inferring .prm)', () => {
    expect(resolveKeyParameterPaths('parameters "amber99sb"', resolve)).toBe(
      `parameters ${PARAMS}/amber99sb.prm`
    )
  })

  it('preserves indentation, casing, and other keywords', () => {
    const key = ['# key', '  PARAMETERS ~/tinker/params/amber99sb.prm', 'a-axis 20.0'].join('\n')
    expect(resolveKeyParameterPaths(key, resolve)).toBe(
      ['# key', `  PARAMETERS ${HOME}/tinker/params/amber99sb.prm`, 'a-axis 20.0'].join('\n')
    )
  })

  it('leaves an unresolvable bare name and `none` untouched', () => {
    expect(resolveKeyParameterPaths('parameters mystery.prm', resolve)).toBe('parameters mystery.prm')
    expect(resolveKeyParameterPaths('parameters none', resolve)).toBe('parameters none')
  })

  it('does not touch non-parameters lines that mention the word', () => {
    const key = '# choose your parameters carefully'
    expect(resolveKeyParameterPaths(key, resolve)).toBe(key)
  })
})
