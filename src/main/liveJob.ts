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
 * `<stem>_tslive.*` copy with a temp key that adds it, so the user's real key
 * and directory stay clean; those temp files are removed when the job ends.
 */

/** Suffix appended to the input stem for throwaway live-run files. */
export const LIVE_SUFFIX = '_tslive'

/** True if the key file already enables per-iteration coordinate output. */
export function hasSaveCycle(keyText?: string): boolean {
  if (!keyText) return false
  return keyText.split(/\r?\n/).some((l) => /^\s*save-cycle\b/i.test(l))
}

/** True if the key requests DCD trajectory output (Tinker's DCD-ARCHIVE keyword). */
export function hasDcdArchive(keyText?: string): boolean {
  if (!keyText) return false
  return keyText.split(/\r?\n/).some((l) => /^\s*dcd-archive\b/i.test(l))
}

/** Build a temp key = the real key (if any) plus a SAVE-CYCLE line. */
export function buildLiveKey(realKeyText?: string): string {
  const base = realKeyText && realKeyText.trim() ? realKeyText.replace(/\s*$/, '') + '\n' : ''
  return base + 'SAVE-CYCLE\n'
}

/** A Tinker box line is exactly six numeric tokens (atom lines have a name). */
function isBoxLine(tokens: string[]): boolean {
  if (tokens.length < 6) return false
  for (let k = 0; k < 6; k++) {
    if (tokens[k] === '' || !Number.isFinite(Number(tokens[k]))) return false
  }
  return tokens.length === 6
}

/**
 * Split accumulated .arc text into complete per-frame blocks without re-reading
 * the whole file. `stride` is the (constant) number of lines per frame; pass 0
 * the first time and it is derived from the first frame's header (+ optional box
 * line). Returns the complete frame blocks, the leftover (partial) text to carry
 * forward, and the resolved stride.
 */
export function splitArcFrames(
  buffer: string,
  stride: number
): { frames: string[]; rest: string; stride: number } {
  const segments = buffer.split('\n')
  const partial = segments[segments.length - 1] // text after the last newline
  const complete = segments.slice(0, -1)

  if (stride === 0) {
    if (complete.length < 2) return { frames: [], rest: buffer, stride: 0 }
    const natoms = Number.parseInt(complete[0].trim().split(/\s+/)[0], 10)
    if (!Number.isInteger(natoms) || natoms < 1) return { frames: [], rest: buffer, stride: 0 }
    const hasBox = isBoxLine(complete[1].trim().split(/\s+/))
    stride = 1 + (hasBox ? 1 : 0) + natoms
  }

  const numFrames = Math.floor(complete.length / stride)
  const frames: string[] = []
  for (let f = 0; f < numFrames; f++) {
    frames.push(complete.slice(f * stride, (f + 1) * stride).join('\n') + '\n')
  }
  const leftover = complete.slice(numFrames * stride)
  const rest = (leftover.length ? leftover.join('\n') + '\n' : '') + partial
  return { frames, rest, stride }
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
