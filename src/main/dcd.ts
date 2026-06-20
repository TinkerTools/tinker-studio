import { openSync, readSync, closeSync, fstatSync } from 'fs'

/**
 * Reader for CHARMM/X-PLOR binary trajectory files (.dcd), as written by Tinker.
 *
 * A .dcd holds only coordinates (no topology), so it must be paired with the
 * matching .xyz for atom names/bonds. Frames are a fixed size (we don't support
 * the rare fixed-atom variant), so — like the .arc path — we read the small
 * header once and then seek to any frame on demand, never loading the whole file.
 *
 * Layout (Fortran unformatted, 4-byte record markers):
 *   [84]"CORD" + 20×int32 ICNTRL + [84]      header block 1
 *   [n] int32 NTITLE + NTITLE×80-char + [n]  title block
 *   [4] int32 NATOM [4]                       atom-count block
 *   then per frame:
 *     ([48] 6×double box [48])?               unit cell, if ICNTRL[10]==1
 *     [4N] N×float32 X [4N]                    coordinates, separate X/Y/Z arrays
 *     [4N] N×float32 Y [4N]
 *     [4N] N×float32 Z [4N]
 */

export interface DcdIndex {
  path: string
  natoms: number
  frameCount: number
  hasBox: boolean
  littleEndian: boolean
  /** Byte offset of the first frame. */
  headerSize: number
  /** Constant bytes per frame. */
  frameSize: number
}

/** Parse a .dcd header. Throws if it isn't a usable coordinate DCD. */
export function openDcd(path: string): DcdIndex {
  const fd = openSync(path, 'r')
  try {
    const fileSize = fstatSync(fd).size
    if (fileSize < 104) throw new Error('Not a DCD file (too small)')
    const head = Buffer.allocUnsafe(Math.min(fileSize, 1 << 16))
    const n = readSync(fd, head, 0, head.length, 0)

    // The leading record marker is 84; its byte order tells us the file's endianness.
    let le = true
    if (head.readInt32LE(0) !== 84) {
      if (head.readInt32BE(0) !== 84) throw new Error('Not a DCD file (bad header)')
      le = false
    }
    const i32 = (off: number): number => {
      if (off + 4 > n) throw new Error('DCD header is truncated or malformed')
      return le ? head.readInt32LE(off) : head.readInt32BE(off)
    }

    if (head.toString('ascii', 4, 8) !== 'CORD') throw new Error('Not a coordinate DCD')
    const icntrl: number[] = []
    for (let k = 0; k < 20; k++) icntrl.push(i32(8 + k * 4))
    if (icntrl[8] !== 0) throw new Error('DCD with fixed atoms is not supported')
    const hasBox = icntrl[10] === 1

    // Title block at 92, then the atom-count block.
    const titleSize = i32(92)
    const atomBlock = 92 + 4 + titleSize + 4
    if (i32(atomBlock) !== 4) throw new Error('Malformed DCD (atom-count block)')
    const natoms = i32(atomBlock + 4)
    if (!Number.isInteger(natoms) || natoms < 1) throw new Error('Malformed DCD (atom count)')
    const headerSize = atomBlock + 12

    const frameSize = (hasBox ? 56 : 0) + 3 * (8 + 4 * natoms)
    const frameCount = Math.floor((fileSize - headerSize) / frameSize)
    if (frameCount < 1) throw new Error('DCD has no frames')

    // Integrity check: the first coordinate record's marker must be 4*natoms in
    // the detected byte order. Catches wrong endianness / atom mismatch / a file
    // that only looks like a DCD.
    const firstMarker = i32(headerSize + (hasBox ? 56 : 0))
    if (firstMarker !== 4 * natoms) throw new Error('DCD coordinate layout does not match its header')

    return { path, natoms, frameCount, hasBox, littleEndian: le, headerSize, frameSize }
  } finally {
    closeSync(fd)
  }
}

/**
 * Read one frame's coordinates as a packed Float32Array (natoms*3, interleaved
 * x,y,z per atom — the order the renderer expects), seeking directly to it.
 */
export function readDcdFrame(index: DcdIndex, frame: number): Float32Array {
  const { natoms, hasBox, littleEndian: le, headerSize, frameSize } = index
  const coordBytes = 4 * natoms
  const recordSize = 8 + coordBytes // marker + data + marker
  const start = headerSize + frame * frameSize + (hasBox ? 56 : 0)
  const len = 3 * recordSize
  const buf = Buffer.allocUnsafe(len)
  const fd = openSync(index.path, 'r')
  try {
    readSync(fd, buf, 0, len, start)
  } finally {
    closeSync(fd)
  }
  const out = new Float32Array(natoms * 3)
  const rd = (off: number): number => (le ? buf.readFloatLE(off) : buf.readFloatBE(off))
  const xOff = 4 // skip the leading record marker of the X array
  const yOff = recordSize + 4
  const zOff = 2 * recordSize + 4
  for (let a = 0; a < natoms; a++) {
    out[a * 3] = rd(xOff + a * 4)
    out[a * 3 + 1] = rd(yOff + a * 4)
    out[a * 3 + 2] = rd(zOff + a * 4)
  }
  return out
}
