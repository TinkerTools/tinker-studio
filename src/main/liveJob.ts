/**
 * Pure helpers for live-job file handling (kept framework-free so they can be
 * unit tested). A "live" run streams the coordinate files Tinker writes while it
 * runs so the renderer can animate the simulation:
 *
 *  - dynamics writes frames into a single growing `<stem>.arc`
 *  - minimizers with the SAVE-CYCLE keyword write one numbered file per
 *    iteration (`<stem>.001`, `<stem>.002`, …)
 *
 * When SAVE-CYCLE is not already in the system's key we run on a throwaway
 * `<stem>_ffelive.*` copy with a temp key that adds it, so the user's real key
 * and directory stay clean; those temp files are removed when the job ends.
 */

/** Suffix appended to the input stem for throwaway live-run files. */
export const LIVE_SUFFIX = '_ffelive'

/** True if the key file already enables per-iteration coordinate output. */
export function hasSaveCycle(keyText?: string): boolean {
  if (!keyText) return false
  return keyText.split(/\r?\n/).some((l) => /^\s*save-cycle\b/i.test(l))
}

/** Build a temp key = the real key (if any) plus a SAVE-CYCLE line. */
export function buildLiveKey(realKeyText?: string): string {
  const base = realKeyText && realKeyText.trim() ? realKeyText.replace(/\s*$/, '') + '\n' : ''
  return base + 'SAVE-CYCLE\n'
}

/** Numbered Tinker cycle files (`<stem>.NNN`) for a stem, sorted by number. */
export function cycleFilesFor(names: string[], stem: string): Array<{ name: string; n: number }> {
  const prefix = `${stem}.`
  const re = /\.(\d+)$/
  return names
    .filter((nm) => nm.startsWith(prefix) && re.test(nm))
    .map((nm) => ({ name: nm, n: Number(nm.match(re)![1]) }))
    .sort((a, b) => a.n - b.n)
}

/**
 * Tinker's version-numbered output name for `baseName` (e.g. `mol.xyz`):
 * `mol.xyz_2`, then `_3`, … picking the first that doesn't already exist.
 */
export function nextVersionName(existing: string[], baseName: string): string {
  const set = new Set(existing)
  let n = 2
  while (set.has(`${baseName}_${n}`)) n++
  return `${baseName}_${n}`
}
