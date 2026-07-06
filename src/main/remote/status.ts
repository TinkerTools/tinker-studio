import type { RemoteJobState } from './types'

/**
 * Normalize the stdout of a cluster's status command into a canonical job state.
 *
 * Handles three flavors with one classifier:
 *  - Tinker Studio's own ssh-direct templates, which print `RUNNING` / `COMPLETED` /
 *    `FAILED:<code>` / `UNKNOWN`;
 *  - SLURM `sacct` State words (RUNNING, COMPLETED, FAILED, PENDING, CANCELLED,
 *    TIMEOUT, OUT_OF_MEMORY, NODE_FAIL, …);
 *  - SLURM `squeue` compact ST codes (R, PD, CG, CD, F, TO, CA, NF, S).
 *
 * Anything unrecognized (including empty output, which often means the
 * scheduler has already purged a finished job) maps to 'unknown'; callers decide
 * how to treat that based on context.
 */
export function classifyStatus(raw: string): RemoteJobState {
  const text = raw.trim().toUpperCase()
  if (!text) return 'unknown'

  // squeue compact code: the whole output is exactly one short token.
  const compact: Record<string, RemoteJobState> = {
    PD: 'pending',
    CF: 'pending',
    R: 'running',
    S: 'running',
    CG: 'running',
    CD: 'completed',
    F: 'failed',
    TO: 'failed',
    NF: 'failed',
    OOM: 'failed',
    CA: 'canceled'
  }
  const firstToken = text.split(/\s+/)[0]
  if (firstToken in compact) return compact[firstToken]

  // Our ssh-direct template encodes a nonzero exit as FAILED:<code>.
  if (/^FAILED\b/.test(text)) return 'failed'

  if (/\bCANCEL+ED\b/.test(text)) return 'canceled'
  if (/\b(FAILED|TIMEOUT|OUT_OF_MEMORY|NODE_FAIL|BOOT_FAIL|DEADLINE|PREEMPTED|REVOKED)\b/.test(text))
    return 'failed'
  if (/\b(COMPLETED|DONE|SUCCESS)\b/.test(text)) return 'completed'
  if (/\b(RUNNING|COMPLETING)\b/.test(text)) return 'running'
  if (/\b(PENDING|QUEUED|CONFIGURING|REQUEUED|RESV_DEL_HOLD|SUSPENDED)\b/.test(text)) return 'pending'
  return 'unknown'
}

/** Pull the exit code out of our ssh-direct `FAILED:<code>` / `COMPLETED` output. */
export function exitCodeFromStatus(raw: string): number | undefined {
  const m = raw.trim().match(/^FAILED:(-?\d+)/i)
  if (m) return Number(m[1])
  if (/^COMPLETED/i.test(raw.trim())) return 0
  return undefined
}
