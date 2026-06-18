import { openSync, readSync, closeSync, fstatSync } from 'fs'

/**
 * Lazy, memory-bounded access to large Tinker .arc trajectories.
 *
 * Opening a multi-gigabyte archive by reading it whole (as the renderer does for
 * small files) blows up memory. Instead we stream the file once to record the
 * byte offset where each frame begins, keeping only that small index in memory.
 * Individual frames are then read on demand by seeking to their offset — so we
 * only ever hold the frames the UI is actually showing.
 *
 * Assumes a well-formed archive: every frame shares one topology (atom count)
 * and the same optional periodic-box line, and there are no blank separator
 * lines (standard Tinker output).
 */

export interface TrajectoryIndex {
  path: string
  /** Byte offset of the start of each frame, plus a final EOF/end sentinel. */
  offsets: number[]
  natoms: number
  hasBox: boolean
  frameCount: number
}

function isBoxLine(tokens: string[]): boolean {
  if (tokens.length !== 6) return false
  return tokens.every((t) => t !== '' && Number.isFinite(Number(t)))
}

/** Lines-per-frame from the first two lines (header + optional box). */
export function detectStride(line0: string, line1: string): { natoms: number; hasBox: boolean; stride: number } {
  const natoms = Number.parseInt(line0.trim().split(/\s+/)[0], 10)
  if (!Number.isInteger(natoms) || natoms < 1) throw new Error('Not a Tinker coordinate file')
  const hasBox = isBoxLine(line1.trim().split(/\s+/))
  return { natoms, hasBox, stride: 1 + (hasBox ? 1 : 0) + natoms }
}

/** Parse the x/y/z of one frame's text into a packed Float32Array (natoms*3). */
export function parseFrameCoords(text: string, natoms: number, hasBox: boolean): Float32Array {
  const lines = text.split(/\r?\n/)
  const coords = new Float32Array(natoms * 3)
  let i = 1 + (hasBox ? 1 : 0) // skip header (+ box)
  for (let a = 0; a < natoms; a++) {
    const t = lines[i++].trim().split(/\s+/)
    coords[a * 3] = Number.parseFloat(t[2])
    coords[a * 3 + 1] = Number.parseFloat(t[3])
    coords[a * 3 + 2] = Number.parseFloat(t[4])
  }
  return coords
}

/** Stream the archive once to build its frame-offset index. */
export function indexArc(path: string): TrajectoryIndex {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const CHUNK = 1 << 20
    const buf = Buffer.allocUnsafe(CHUNK)

    // First, grab enough to read the first two lines and fix the stride.
    const head = Buffer.allocUnsafe(Math.min(CHUNK, size))
    const headLen = readSync(fd, head, 0, head.length, 0)
    const headLines = head.toString('utf8', 0, headLen).split('\n')
    if (headLines.length < 2) throw new Error('Trajectory has no frames')
    const { natoms, hasBox, stride } = detectStride(headLines[0], headLines[1])

    // Then scan the whole file, recording a frame boundary every `stride` lines.
    const offsets = [0]
    let lines = 0
    let pos = 0
    while (pos < size) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos)
      if (n <= 0) break
      for (let k = 0; k < n; k++) {
        if (buf[k] === 0x0a) {
          lines++
          if (lines % stride === 0) offsets.push(pos + k + 1)
        }
      }
      pos += n
    }
    const frameCount = Math.floor(lines / stride)
    // offsets[frameCount] is the end of the last complete frame; trim any extra.
    offsets.length = frameCount + 1
    return { path, offsets, natoms, hasBox, frameCount }
  } finally {
    closeSync(fd)
  }
}

/** Read the raw text of one frame from the indexed file. */
export function readFrameText(index: TrajectoryIndex, frame: number): string {
  const start = index.offsets[frame]
  const end = index.offsets[frame + 1]
  const len = end - start
  const fd = openSync(index.path, 'r')
  try {
    const buf = Buffer.allocUnsafe(len)
    readSync(fd, buf, 0, len, start)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** Read and decode one frame's coordinates on demand. */
export function readFrameCoords(index: TrajectoryIndex, frame: number): Float32Array {
  return parseFrameCoords(readFrameText(index, frame), index.natoms, index.hasBox)
}
