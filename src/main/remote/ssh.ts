import { spawn } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'fs'

/**
 * Thin wrapper over the system `ssh` binary. We deliberately shell out rather
 * than bundle a JS SSH library: it honors the user's existing ~/.ssh/config,
 * keys, agent, and ProxyJump, stores no credentials, and keeps the app's
 * zero-runtime-dependency posture.
 *
 * All file transfer also goes over ssh (`cat`), not scp — one transport, one set
 * of options, and it benefits from the shared ControlMaster connection so the
 * many small reads a live trajectory makes don't each pay a full TCP+auth setup.
 */

export interface SshTarget {
  /** `user@host` or a Host alias from ~/.ssh/config. */
  host: string
  /** Extra args inserted before our defaults, e.g. `-p 2222 -J jump.host`. */
  sshOptions?: string
  /** When set, authenticate with this password via an SSH_ASKPASS helper. */
  password?: string
  /** Auto-accept an unknown host key (StrictHostKeyChecking=accept-new). */
  acceptNewHostKeys?: boolean
}

/**
 * A tiny askpass helper that prints $FFE_SSH_PW. ssh runs it (when SSH_ASKPASS +
 * SSH_ASKPASS_REQUIRE=force are set) to obtain the password without a TTY. Written
 * once to a 0700 temp file; the password itself is passed per-call via the child's
 * environment, never written to disk.
 */
let askpassPath: string | null = null
function ensureAskpass(): string {
  if (askpassPath) return askpassPath
  const dir = mkdtempSync(join(tmpdir(), 'ffe-askpass-'))
  const p = join(dir, 'askpass.sh')
  writeFileSync(p, '#!/bin/sh\nprintf \'%s\\n\' "$FFE_SSH_PW"\n', { mode: 0o700 })
  chmodSync(p, 0o700)
  askpassPath = p
  return p
}

/** Environment for an ssh child: adds the askpass plumbing when a password is set. */
function spawnEnv(target: SshTarget): NodeJS.ProcessEnv {
  if (target.password == null) return process.env
  return {
    ...process.env,
    SSH_ASKPASS: ensureAskpass(),
    // OpenSSH 8.4+: use askpass even with a tty and without DISPLAY.
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env.DISPLAY || ':0',
    FFE_SSH_PW: target.password
  }
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Split a shell-ish options string into argv, honoring simple quoting. */
export function splitArgs(s?: string): string[] {
  if (!s) return []
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

/**
 * ControlMaster socket path. Unix-domain socket paths are capped (~104 bytes on
 * macOS), and macOS `$TMPDIR` is long — combined with the 40-char `%C` hash and
 * ssh's own random suffix it overflows. So we keep the socket in a short per-user
 * dir under /tmp. Returns null on Windows (OpenSSH there has no ControlMaster) or
 * if the dir can't be made, in which case we simply don't multiplex.
 */
let controlDir: string | null | undefined
function controlPath(): string | null {
  if (process.platform === 'win32') return null
  if (controlDir === undefined) {
    try {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0
      const d = join('/tmp', `ffe-cm-${uid}`)
      mkdirSync(d, { recursive: true, mode: 0o700 })
      controlDir = d
    } catch {
      controlDir = null
    }
  }
  return controlDir ? join(controlDir, '%C') : null
}

/**
 * Base ssh args. User-supplied options come first so they win (ssh takes the
 * first value seen for an option); our defaults add non-interactive behavior, a
 * connect timeout, and — where supported — a persistent ControlMaster so repeated
 * calls to the same host reuse one connection (%C is a hash of the connection).
 */
function baseArgs(target: SshTarget): string[] {
  const args = [...splitArgs(target.sshOptions), '-o', 'ConnectTimeout=15']
  const cp = controlPath()
  if (cp) {
    args.push(
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPath=${cp}`,
      // Hold the authenticated master open a while so password hosts authenticate
      // once and subsequent calls (incl. background polls) reuse it without a prompt.
      '-o',
      'ControlPersist=300'
    )
  }
  if (target.acceptNewHostKeys) args.push('-o', 'StrictHostKeyChecking=accept-new')
  if (target.password != null) {
    // Password auth via askpass: don't disable prompts, cap retries, and steer
    // toward password / keyboard-interactive methods.
    args.push(
      '-o',
      'NumberOfPasswordPrompts=1',
      '-o',
      'PreferredAuthentications=keyboard-interactive,password'
    )
  } else {
    // Key/agent auth: never block on a prompt.
    args.push('-o', 'BatchMode=yes')
  }
  return args
}

/** Run a command on the remote host; capture stdout/stderr as text. */
export function sshRun(target: SshTarget, command: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('ssh', [...baseArgs(target), target.host, command], { env: spawnEnv(target) })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', (e) => resolve({ code: null, stdout, stderr: stderr + e.message }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** Run a command and capture stdout as raw bytes (for binary range reads). */
export function sshRunBinary(target: SshTarget, command: string): Promise<{ code: number | null; data: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('ssh', [...baseArgs(target), target.host, command], { env: spawnEnv(target) })
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', (e) => resolve({ code: null, data: Buffer.concat(chunks), stderr: stderr + e.message }))
    child.on('close', (code) => resolve({ code, data: Buffer.concat(chunks), stderr }))
  })
}

/** Quote a path for the remote shell, but leave a leading ~ for tilde expansion. */
export function remoteQuote(path: string): string {
  if (path.startsWith('~/')) return '~/' + sq(path.slice(2))
  if (path === '~') return '~'
  return sq(path)
}
function sq(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'"
}

/** Create a remote directory (mkdir -p). */
export async function sshMkdirp(target: SshTarget, dir: string): Promise<RunResult> {
  return sshRun(target, `mkdir -p ${remoteQuote(dir)}`)
}

/** Upload bytes to a remote path by piping them into `cat > path`. */
export function uploadBytes(target: SshTarget, remotePath: string, data: Buffer): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('ssh', [...baseArgs(target), target.host, `cat > ${remoteQuote(remotePath)}`], {
      env: spawnEnv(target)
    })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', (e) => resolve({ code: null, stdout: '', stderr: stderr + e.message }))
    child.on('close', (code) => resolve({ code, stdout: '', stderr }))
    child.stdin.end(data)
  })
}

/** Download a whole remote file's bytes via `cat path`. */
export async function downloadBytes(target: SshTarget, remotePath: string): Promise<Buffer> {
  const r = await sshRunBinary(target, `cat ${remoteQuote(remotePath)}`)
  if (r.code !== 0) throw new Error(r.stderr.trim() || `download failed (exit ${r.code})`)
  return r.data
}

/** Read a byte range [offset, offset+len) of a remote file (binary-safe). */
export async function readRange(
  target: SshTarget,
  remotePath: string,
  offset: number,
  len: number
): Promise<Buffer> {
  // tail -c +N is 1-based from the start of the file.
  const cmd = `tail -c +${offset + 1} ${remoteQuote(remotePath)} | head -c ${len}`
  const r = await sshRunBinary(target, cmd)
  if (r.code !== 0) throw new Error(r.stderr.trim() || `range read failed (exit ${r.code})`)
  return r.data
}

/** Remote file size in bytes (via `wc -c`), or -1 if it doesn't exist yet. */
export async function remoteSize(target: SshTarget, remotePath: string): Promise<number> {
  const r = await sshRun(target, `wc -c < ${remoteQuote(remotePath)} 2>/dev/null || echo -1`)
  const n = Number.parseInt(r.stdout.trim(), 10)
  return Number.isFinite(n) ? n : -1
}

/** Quick reachability check: run `true` and report success or the ssh error. */
export async function testConnection(target: SshTarget): Promise<{ ok: boolean; message: string }> {
  const r = await sshRun(target, 'echo ffe-ok')
  if (r.code === 0 && r.stdout.includes('ffe-ok')) return { ok: true, message: 'Connected.' }
  return { ok: false, message: r.stderr.trim() || r.stdout.trim() || `ssh exited ${r.code}` }
}
