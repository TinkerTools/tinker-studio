/**
 * Helpers for the Tinker `.key` files we hand to spawned Tinker programs.
 *
 * Kept free of Electron/`fs` (the path lookup is injected) so the logic is pure and
 * unit-testable; the main process wires in the real resolver.
 */

/**
 * Rewrite any `parameters <name>` line that names a Tinker parameter file by a bare
 * filename (no directory) to an absolute path.
 *
 * Tinker's getprm resolves such a name relative to the program's current directory.
 * Our jobs run in a scratch work dir where e.g. `basic.prm` doesn't exist, so getprm
 * would fall back to an interactive prompt — and since we feed the program a fixed
 * stdin and close it, that read hits EOF and Tinker aborts with an "end of file"
 * error in getprm. Pointing the keyword at the real file avoids the prompt entirely.
 *
 * The actual lookup is injected as `resolve` (so the policy — bundled `basic.prm` vs.
 * the user's Tinker params dir — lives in the caller and this stays pure/testable).
 * Names that already contain a path separator, or that `resolve` can't place, are
 * left untouched (Tinker may still find them, or will report a clear error).
 *
 * @param resolve Maps a bare parameter-file name to an absolute path, or null.
 */
export function resolveKeyParameterPaths(
  keyText: string,
  resolve: (name: string) => string | null
): string {
  return keyText
    .split('\n')
    .map((line) => {
      const m = line.match(/^(\s*parameters\s+)(.+?)\s*$/i)
      if (!m) return line
      const value = m[2].trim().replace(/^["']|["']$/g, '') // strip surrounding quotes
      if (value === '' || /[\\/]/.test(value)) return line // already a path (or empty)
      const abs = resolve(value)
      return abs ? `${m[1]}"${abs}"` : line
    })
    .join('\n')
}
