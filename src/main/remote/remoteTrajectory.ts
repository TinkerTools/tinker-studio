import { type SshTarget, sshRun, readRange, remoteSize, remoteQuote } from './ssh'
import { detectStride, parseFrameCoords } from '../trajectory'
import { parseDcdHeader, dcdFrameRange, decodeDcdFrame, type DcdIndex } from '../dcd'

/**
 * Stream a trajectory that lives on a remote host, growing or not, without ever
 * downloading the whole file. Mirrors the local lazy model (trajectory.ts /
 * dcd.ts) but the byte reads go over ssh:
 *
 *  - .arc (text, fixed line-count but variable-byte frames): a one-line remote
 *    `awk` pass emits only the frame-start byte offsets — the file bytes stay on
 *    the cluster. Frames are then fetched by byte range on demand. Re-running the
 *    awk pass cheaply refreshes the index for a still-growing live run.
 *  - .dcd (binary, fixed-size frames): read the small header once, then each
 *    frame is a pure arithmetic byte range.
 *
 * A small bounded cache keeps recently-viewed frames so scrubbing/playback over
 * the same window doesn't refetch every tick.
 */

const FRAME_CACHE_MAX = 64

interface BaseHandle {
  target: SshTarget
  path: string
  frameCount: number
  cache: Map<number, Float32Array>
}
interface ArcHandle extends BaseHandle {
  kind: 'arc'
  natoms: number
  hasBox: boolean
  stride: number
  offsets: number[]
}
interface DcdHandle extends BaseHandle {
  kind: 'dcd'
  header: Omit<DcdIndex, 'path'>
}
export type RemoteTrajHandle = ArcHandle | DcdHandle

function cachePut(h: BaseHandle, frame: number, coords: Float32Array): void {
  h.cache.set(frame, coords)
  if (h.cache.size > FRAME_CACHE_MAX) {
    const oldest = h.cache.keys().next().value
    if (oldest !== undefined) h.cache.delete(oldest)
  }
}

/** The remote awk one-liner that emits frame-start byte offsets for a stride. */
export function awkOffsetCommand(path: string, stride: number): string {
  // Prints the byte offset at the start of every `stride`-th line, then a final
  // "<totalBytes>\t<totalLines>" line. length($0)+1 assumes single-LF lines
  // (standard Tinker output); chars==bytes for ASCII coordinate files.
  return (
    `awk -v S=${stride} 'BEGIN{p=0} {if((NR-1)%S==0) print p; p+=length($0)+1} END{print p"\\t"NR}' ` +
    remoteQuote(path)
  )
}

/**
 * Parse the awk pass's stdout into a frame-offset index. Drops any trailing
 * partial frame (a live run mid-write) and guarantees a final end-of-last-frame
 * sentinel, matching the local TrajectoryIndex.offsets shape.
 */
export function parseAwkOffsets(stdout: string, stride: number): { offsets: number[]; frameCount: number } {
  const lines = stdout.trimEnd().split('\n')
  const endLine = lines.pop() ?? '0\t0'
  const [totBytesStr, totLinesStr] = endLine.split('\t')
  const totBytes = Number.parseInt(totBytesStr, 10) || 0
  const totLines = Number.parseInt(totLinesStr, 10) || 0
  const starts = lines.map((l) => Number.parseInt(l, 10)).filter((n) => Number.isFinite(n))
  const completeFrames = Math.floor(totLines / stride)
  const offsets =
    starts.length > completeFrames ? starts.slice(0, completeFrames + 1) : [...starts, totBytes]
  return { offsets, frameCount: Math.max(0, offsets.length - 1) }
}

/** Run the remote awk pass; returns frame-start offsets + an EOF sentinel. */
async function scanArcOffsets(
  target: SshTarget,
  path: string,
  stride: number
): Promise<{ offsets: number[]; frameCount: number }> {
  const r = await sshRun(target, awkOffsetCommand(path, stride))
  if (r.code !== 0) throw new Error(r.stderr.trim() || `failed to index remote .arc (exit ${r.code})`)
  return parseAwkOffsets(r.stdout, stride)
}

/** Open a remote .arc: detect topology, index offsets, return the first frame text. */
export async function openRemoteArc(
  target: SshTarget,
  path: string
): Promise<{ handle: ArcHandle; firstFrameText: string }> {
  const head = await sshRun(target, `head -n 2 ${remoteQuote(path)}`)
  if (head.code !== 0) throw new Error(head.stderr.trim() || 'cannot read remote file')
  const [l0, l1 = ''] = head.stdout.split('\n')
  const { natoms, hasBox, stride } = detectStride(l0, l1)
  const { offsets, frameCount } = await scanArcOffsets(target, path, stride)
  if (frameCount < 1) throw new Error('Remote trajectory has no complete frame')
  const handle: ArcHandle = {
    kind: 'arc',
    target,
    path,
    natoms,
    hasBox,
    stride,
    offsets,
    frameCount,
    cache: new Map()
  }
  const firstFrameText = (await readRange(target, path, offsets[0], offsets[1] - offsets[0])).toString('utf8')
  return { handle, firstFrameText }
}

/** Re-index a growing remote .arc; returns the new frame count. */
export async function refreshRemoteArc(h: ArcHandle): Promise<number> {
  const { offsets, frameCount } = await scanArcOffsets(h.target, h.path, h.stride)
  h.offsets = offsets
  h.frameCount = frameCount
  return frameCount
}

/** Open a remote .dcd: read its header once. */
export async function openRemoteDcd(target: SshTarget, path: string): Promise<DcdHandle> {
  const size = await remoteSize(target, path)
  if (size < 104) throw new Error('Remote .dcd is too small or missing')
  const head = await readRange(target, path, 0, Math.min(size, 1 << 16))
  const header = parseDcdHeader(head, size)
  return { kind: 'dcd', target, path, header, frameCount: header.frameCount, cache: new Map() }
}

/** Re-read a growing remote .dcd's size and recompute its frame count. */
export async function refreshRemoteDcd(h: DcdHandle): Promise<number> {
  const size = await remoteSize(h.target, h.path)
  if (size > 0) {
    h.header.frameCount = Math.floor((size - h.header.headerSize) / h.header.frameSize)
    h.frameCount = h.header.frameCount
  }
  return h.frameCount
}

/** Fetch one frame's coordinates from a remote trajectory (cached). */
export async function readRemoteFrame(h: RemoteTrajHandle, frame: number): Promise<Float32Array | null> {
  if (frame < 0 || frame >= h.frameCount) return null
  const cached = h.cache.get(frame)
  if (cached) return cached
  let coords: Float32Array
  if (h.kind === 'arc') {
    const start = h.offsets[frame]
    const len = h.offsets[frame + 1] - start
    const text = (await readRange(h.target, h.path, start, len)).toString('utf8')
    coords = parseFrameCoords(text, h.natoms, h.hasBox)
  } else {
    const { start, len } = dcdFrameRange(h.header, frame)
    const buf = await readRange(h.target, h.path, start, len)
    coords = decodeDcdFrame(buf, h.header.natoms, h.header.littleEndian)
  }
  cachePut(h, frame, coords)
  return coords
}

export function atomCountOf(h: RemoteTrajHandle): number {
  return h.kind === 'arc' ? h.natoms : h.header.natoms
}
