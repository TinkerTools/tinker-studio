/**
 * Helpers for the Tinker `.key` files we hand to spawned Tinker programs.
 *
 * Kept free of Electron/`fs` (paths and an existence predicate are injected) so the
 * logic is pure and unit-testable; the main process wires in the real params dir and
 * `existsSync`.
 */

import { join } from 'node:path'

/**
 * Rewrite any `parameters <name>` line that names a Tinker parameter file by a bare
 * filename (no directory) to an absolute path in the Tinker params directory.
 *
 * Tinker's getprm resolves such a name relative to the program's current directory.
 * Our jobs run in a scratch work dir where e.g. `basic.prm` doesn't exist, so getprm
 * would fall back to an interactive prompt — and since we feed the program a fixed
 * stdin and close it, that read hits EOF and Tinker aborts with an "end of file"
 * error in getprm. Pointing the keyword at the real file avoids the prompt entirely.
 *
 * A bare name is tried both as given and with a `.prm` extension. Names that already
 * contain a path separator, or that don't resolve in the params dir, are left
 * untouched (Tinker may still find them, or will report a clear error of its own).
 *
 * @param paramsDir Tinker's params directory, or null if it isn't known.
 * @param exists    Predicate reporting whether an absolute path exists (injected).
 */
export function resolveKeyParameterPaths(
  keyText: string,
  paramsDir: string | null,
  exists: (p: string) => boolean
): string {
  if (!paramsDir) return keyText
  return keyText
    .split('\n')
    .map((line) => {
      const m = line.match(/^(\s*parameters\s+)(.+?)\s*$/i)
      if (!m) return line
      const value = m[2].trim().replace(/^["']|["']$/g, '') // strip surrounding quotes
      if (value === '' || /[\\/]/.test(value)) return line // already a path (or empty)
      const names = value.toLowerCase().endsWith('.prm') ? [value] : [value, `${value}.prm`]
      for (const n of names) {
        const abs = join(paramsDir, n)
        if (exists(abs)) return `${m[1]}"${abs}"`
      }
      return line
    })
    .join('\n')
}
