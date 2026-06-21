/**
 * Pure data model for remote (cluster) Tinker job submission.
 *
 * These are *types only* (no runtime), so the preload bridge can re-export them
 * to the renderer for the configuration UI without pulling main-process code
 * into the renderer bundle. The runtime that uses them lives in main/remote/.
 *
 * Design: FFE owns *what* to run (the Tinker program + its input files + key);
 * a ClusterProfile owns *how/where* it runs (the connection, the scheduler
 * wrapper, where Tinker lives on the remote). The two meet through a small set
 * of `{{variable}}` placeholders the templates can reference (see template.ts).
 */

/** Built-in shapes plus an escape hatch for anything else. */
export type ClusterKind = 'ssh-direct' | 'slurm' | 'custom'

/** A user-defined value exposed to the templates (and, for connection vars, to
 * the ssh destination itself). */
export interface ClusterVariable {
  /** Referenced in templates as {{name}}. */
  name: string
  /** Human-friendly label for the prompt (defaults to `name`). */
  label?: string
  /** Pre-filled value (also the stored value for connection-scoped variables). */
  default?: string
  /** Optional help text shown under the field. */
  description?: string
  /**
   * Where the variable is needed:
   *  - 'submit' (default): only when launching a job; substituted into the
   *    submit/status/cancel templates.
   *  - 'connection': part of the ssh destination itself (substituted into the
   *    host + ssh options), so it's needed for *every* operation on this cluster
   *    — submitting, polling, downloading, and opening remote files. Think a
   *    node number behind a login front-door.
   */
  scope?: 'connection' | 'submit'
}

/**
 * The three orchestration commands FFE runs over SSH. Each is a shell snippet
 * with `{{variable}}` placeholders substituted before sending. FFE first writes
 * a `job.sh` into the remote working directory (containing the setup + Tinker
 * command); these templates only launch / query / cancel it.
 */
export interface ClusterTemplates {
  /**
   * Launch the job. Runs in a shell on the remote host with these variables
   * available: workdir, job_name, script (the job.sh filename), plus any
   * user-defined variables. Must print the job id (PID or scheduler id) — the
   * id is extracted from stdout via `submitIdPattern`.
   */
  submit: string
  /** Query a job. Variables: job_id, workdir. Stdout is classified into a state. */
  status: string
  /** Cancel a job. Variables: job_id, workdir. */
  cancel: string
  /** Regex (as a string) whose first capture group is the job id in submit stdout. */
  submitIdPattern?: string
}

/** A configured remote machine or cluster. */
export interface ClusterProfile {
  id: string
  name: string
  kind: ClusterKind
  /**
   * SSH destination: `user@host`, or a Host alias from the user's ~/.ssh/config.
   * Whatever works in their terminal works here — we shell out to the system ssh.
   */
  host: string
  /** Extra args added to every ssh/scp call, e.g. `-p 2222 -J jump.host`. */
  sshOptions?: string
  /**
   * Authentication method. 'key' (default) relies on the user's ssh keys/agent —
   * fully non-interactive. 'password' supplies a password via an SSH_ASKPASS
   * helper (held in memory; optionally remembered, encrypted, via the OS keychain).
   */
  auth?: 'key' | 'password'
  /**
   * Auto-accept (trust-on-first-use) a host key not yet in known_hosts
   * (StrictHostKeyChecking=accept-new). Off by default; handy for password hosts
   * the user hasn't connected to from a terminal before.
   */
  acceptNewHostKeys?: boolean
  /**
   * Remembered password, encrypted with the OS keychain (Electron safeStorage),
   * base64-encoded. Only present when the user chose to remember it; otherwise the
   * password lives only in memory for the session.
   */
  encryptedPassword?: string
  /** Remote directory under which a per-job working directory is created. */
  remoteBaseDir: string
  /** Directory holding the remote Tinker binaries; prepended to PATH in job.sh. */
  remoteTinkerDir?: string
  /** Extra shell lines run before the Tinker command (e.g. `module load tinker`). */
  setupCommands?: string
  /** Values prompted at submit time and exposed to the templates. */
  variables: ClusterVariable[]
  /** The submit/status/cancel command templates (seeded from a preset, editable). */
  templates: ClusterTemplates
}

/** A file staged (uploaded) to the remote working directory before a run. */
export interface StagedFile {
  name: string
  text: string
}

/** Request to submit a Tinker job to a cluster (renderer → main). */
export interface RemoteSubmitRequest {
  clusterId: string
  program: string
  jobName: string
  /** Primary coordinate filename (e.g. mol.xyz). */
  inputName: string
  /** Interactive answers fed to Tinker on stdin (same mapping as the local run). */
  stdin?: string
  /** Extra positional args after the input filename. */
  tinkerArgs?: string[]
  /** Files to upload before running. Omit to run on files already on the host. */
  files?: StagedFile[]
  /** When running on existing remote files, the directory they live in. */
  remoteInputDir?: string
  /**
   * A specific remote .key file to use (for the run-on-existing-files case where
   * the key isn't sitting next to the .xyz with the matching name). It's copied
   * to `<inputStem>.key` in the working directory so Tinker picks it up.
   */
  remoteKeyPath?: string
  /** User-defined variable values (keyed by variable name). */
  variables?: Record<string, string>
  /** Trajectory output the run produces, for live streaming. */
  outputFormat?: 'arc' | 'dcd' | null
}

/** Lifecycle state of a remote job, normalized across schedulers. */
export type RemoteJobState =
  | 'submitting'
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'unknown'

/**
 * A persisted remote job. The registry is written to userData so jobs survive
 * the app being closed and reopened — we reconnect by polling the remote.
 */
export interface RemoteJobRecord {
  /** Local id (chosen by the app). */
  id: string
  clusterId: string
  clusterName: string
  /** Tinker program, e.g. "dynamic". */
  program: string
  jobName: string
  /** Scheduler / PID id returned by the submit command. */
  remoteJobId?: string
  /** Remote working directory holding inputs, job.sh, and outputs. */
  workdir: string
  /** Primary input coordinate filename on the remote (e.g. mol.xyz). */
  inputName?: string
  /** Trajectory output the run produces, for live streaming (null = none). */
  outputFormat?: 'arc' | 'dcd' | null
  /** Output trajectory filename on the remote, if any (e.g. mol.arc). */
  outputName?: string
  /** Connection-scoped variable values captured at submit time, reused for every
   * subsequent ssh op on this job (poll/cancel/download/stream), incl. after a
   * restart. */
  connectionVars?: Record<string, string>
  submittedAt: number
  finishedAt?: number
  status: RemoteJobState
  exitCode?: number
  commandLine?: string
  /** Small accumulated log (submission output + status notes). */
  log: string
  error?: string
  /** True once the user has downloaded the results locally. */
  downloaded?: boolean
}
