/**
 * A Tinker job launched from the UI. Records live at the App level (not inside
 * the Commands modal) so their output survives the modal being closed and can be
 * reviewed later in the Job Output window.
 */
export interface JobRecord {
  id: string
  /** Tinker program name, e.g. "minimize". */
  program: string
  /** Name of the system the job was run on. */
  systemName: string
  /** Path of the input structure on disk (used to locate Tinker's output). */
  structurePath?: string
  /** Full command line, once the job has started. */
  commandLine?: string
  startedAt: number
  status: 'running' | 'exited' | 'failed'
  exitCode?: number | null
  /** Accumulated stdout/stderr (plus our own status lines). */
  output: string
}

/** Kind of live visualization a program supports (null = none). */
export type LiveKind = 'dynamics' | 'minimize'

const MINIMIZERS = new Set(['minimize', 'optimize', 'newton', 'minirot', 'optirot', 'newtrot'])

export function liveKind(program: string): LiveKind | null {
  const p = program.toLowerCase()
  if (p === 'dynamic') return 'dynamics'
  if (MINIMIZERS.has(p)) return 'minimize'
  return null
}

export function jobStatusLabel(j: JobRecord): string {
  if (j.status === 'running') return 'Running'
  if (j.status === 'failed') return 'Failed'
  return j.exitCode === 0 || j.exitCode == null ? 'Done' : `Exit ${j.exitCode}`
}
