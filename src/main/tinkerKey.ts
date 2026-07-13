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
 * The actual lookup is injected as `resolve` (so the policy — expand `~`, bundled
 * `basic.prm` vs. the user's Tinker params dir, etc. — lives in the caller and this
 * stays pure/testable). Every parameter value (bare name, `~/…`, relative, or
 * absolute) is passed to `resolve`; whatever absolute path it returns is quoted into
 * the line, and a null result leaves the line untouched.
 *
 * @param resolve Maps a parameter-file reference to an absolute path, or null.
 */
export function resolveKeyParameterPaths(
  keyText: string,
  resolve: (value: string) => string | null
): string {
  return keyText
    .split('\n')
    .map((line) => {
      const m = line.match(/^(\s*parameters\s+)(.+?)\s*$/i)
      if (!m) return line
      const value = m[2].trim().replace(/^["']|["']$/g, '') // strip surrounding quotes
      if (value === '') return line
      const abs = resolve(value)
      if (!abs) return line
      // Tinker reads an unquoted path via gettext and a quoted one via getstring;
      // only quote when the path has whitespace (avoids relying on quote-parsing).
      return `${m[1]}${/\s/.test(abs) ? `"${abs}"` : abs}`
    })
    .join('\n')
}
