import { openSync, readSync, closeSync, fstatSync } from 'fs'
import { open as openAsync } from 'fs/promises'

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

/**
 * Read just the first frame (for immediate display) without scanning the file.
 * Returns its text plus the topology shape needed to index the rest.
 */
export function readFirstFrame(path: string): {
  firstFrameText: string
  natoms: number
  hasBox: boolean
  stride: number
} {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const CHUNK = 1 << 16
    let text = ''
    let pos = 0
    let stride = 0
    let natoms = 0
    let hasBox = false
    while (pos < size) {
      const want = Math.min(CHUNK, size - pos)
      const buf = Buffer.allocUnsafe(want)
      const n = readSync(fd, buf, 0, want, pos)
      if (n <= 0) break
      pos += n
      text += buf.toString('utf8', 0, n)
      if (stride === 0) {
        const nl1 = text.indexOf('\n')
        const nl2 = nl1 >= 0 ? text.indexOf('\n', nl1 + 1) : -1
        if (nl2 >= 0) {
          const d = detectStride(text.slice(0, nl1), text.slice(nl1 + 1, nl2))
          stride = d.stride
          natoms = d.natoms
          hasBox = d.hasBox
        }
      }
      if (stride > 0) {
        let idx = -1
        let count = 0
        for (let k = 0; k < stride; k++) {
          idx = text.indexOf('\n', idx + 1)
          if (idx < 0) break
          count++
        }
        if (count === stride) {
          return { firstFrameText: text.slice(0, idx + 1), natoms, hasBox, stride }
        }
      }
    }
    if (stride > 0) return { firstFrameText: text, natoms, hasBox, stride }
    throw new Error('Trajectory has no complete frame')
  } finally {
    closeSync(fd)
  }
}

/**
 * Build the frame-offset index without blocking the event loop, by reading the
 * file in chunks and awaiting between them. Use this at runtime; the sync
 * indexArc below is for tests.
 */
export async function indexArcAsync(path: string): Promise<TrajectoryIndex> {
  const head = readFirstFrame(path)
  const stride = head.stride
  const fh = await openAsync(path, 'r')
  try {
    const size = (await fh.stat()).size
    const CHUNK = 1 << 20
    const buf = Buffer.allocUnsafe(CHUNK)
    const offsets = [0]
    let lines = 0
    let pos = 0
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos), pos)
      if (bytesRead <= 0) break
      for (let k = 0; k < bytesRead; k++) {
        if (buf[k] === 0x0a) {
          lines++
          if (lines % stride === 0) offsets.push(pos + k + 1)
        }
      }
      pos += bytesRead
    }
    const frameCount = Math.floor(lines / stride)
    offsets.length = frameCount + 1
    return { path, offsets, natoms: head.natoms, hasBox: head.hasBox, frameCount }
  } finally {
    await fh.close()
  }
}

/** Stream the archive once to build its frame-offset index (synchronous). */
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
