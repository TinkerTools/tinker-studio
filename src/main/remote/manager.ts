import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type {
  ClusterProfile,
  RemoteJobRecord,
  RemoteJobState,
  RemoteSubmitRequest
} from './types'
import {
  renderTemplate,
  buildJobScript,
  buildSetup,
  extractJobId,
  composeTinkerCommand
} from './template'
import { classifyStatus, exitCodeFromStatus } from './status'
import {
  type SshTarget,
  sshRun,
  sshMkdirp,
  uploadBytes,
  downloadBytes,
  remoteQuote,
  testConnection
} from './ssh'
import {
  openRemoteArc,
  openRemoteDcd,
  refreshRemoteArc,
  refreshRemoteDcd,
  readRemoteFrame,
  atomCountOf,
  type RemoteTrajHandle
} from './remoteTrajectory'

type Emit = (channel: string, payload: unknown) => void

const POLL_MS = 7000

/**
 * Owns remote clusters and jobs: persists both to disk (so jobs survive an app
 * restart), submits/polls/cancels over ssh, and streams remote trajectories.
 *
 * Kept free of Electron imports — the caller passes the data directory and an
 * event emitter — so the orchestration is straightforward to reason about and
 * the pure helpers it builds on stay independently testable.
 */
export class RemoteManager {
  private clusters: ClusterProfile[] = []
  private jobs: Map<string, RemoteJobRecord> = new Map()
  private timers = new Map<string, ReturnType<typeof setInterval>>()
  private trajectories = new Map<string, RemoteTrajHandle>()
  private trajCounter = 0
  private readonly clustersPath: string
  private readonly jobsPath: string

  constructor(
    dataDir: string,
    private emit: Emit
  ) {
    this.clustersPath = join(dataDir, 'clusters.json')
    this.jobsPath = join(dataDir, 'remote-jobs.json')
    this.load()
  }

  // ---- persistence -------------------------------------------------------

  private load(): void {
    try {
      if (existsSync(this.clustersPath)) {
        this.clusters = JSON.parse(readFileSync(this.clustersPath, 'utf8'))
      }
    } catch {
      this.clusters = []
    }
    try {
      if (existsSync(this.jobsPath)) {
        const arr: RemoteJobRecord[] = JSON.parse(readFileSync(this.jobsPath, 'utf8'))
        for (const j of arr) this.jobs.set(j.id, j)
      }
    } catch {
      // start with no remembered jobs
    }
  }

  private saveClusters(): void {
    try {
      writeFileSync(this.clustersPath, JSON.stringify(this.clusters, null, 2))
    } catch (e) {
      console.error('Failed to save clusters:', e)
    }
  }

  private saveJobs(): void {
    try {
      writeFileSync(this.jobsPath, JSON.stringify([...this.jobs.values()], null, 2))
    } catch (e) {
      console.error('Failed to save remote jobs:', e)
    }
  }

  // ---- clusters ----------------------------------------------------------

  listClusters(): ClusterProfile[] {
    return this.clusters
  }

  saveCluster(profile: ClusterProfile): ClusterProfile[] {
    const i = this.clusters.findIndex((c) => c.id === profile.id)
    if (i >= 0) this.clusters[i] = profile
    else this.clusters.push(profile)
    this.saveClusters()
    return this.clusters
  }

  deleteCluster(id: string): ClusterProfile[] {
    this.clusters = this.clusters.filter((c) => c.id !== id)
    this.saveClusters()
    return this.clusters
  }

  private cluster(id: string): ClusterProfile {
    const c = this.clusters.find((x) => x.id === id)
    if (!c) throw new Error('Unknown cluster')
    return c
  }

  private targetOf(c: ClusterProfile): SshTarget {
    return { host: c.host, sshOptions: c.sshOptions }
  }

  testConnection(clusterId: string): Promise<{ ok: boolean; message: string }> {
    return testConnection(this.targetOf(this.cluster(clusterId)))
  }

  // ---- jobs --------------------------------------------------------------

  listJobs(): RemoteJobRecord[] {
    return [...this.jobs.values()].sort((a, b) => b.submittedAt - a.submittedAt)
  }

  getJob(id: string): RemoteJobRecord | undefined {
    return this.jobs.get(id)
  }

  private update(id: string, patch: Partial<RemoteJobRecord>): void {
    const j = this.jobs.get(id)
    if (!j) return
    Object.assign(j, patch)
    this.saveJobs()
    this.emit('remote:jobUpdate', j)
  }

  forgetJob(id: string): RemoteJobRecord[] {
    this.stopPolling(id)
    this.jobs.delete(id)
    this.saveJobs()
    return this.listJobs()
  }

  /** Sanitize a name into a shell- and path-safe token. */
  private safe(name: string): string {
    return (name.replace(/\.[^.]*$/, '') || 'job').replace(/[^A-Za-z0-9._-]/g, '_')
  }

  async submit(req: RemoteSubmitRequest): Promise<RemoteJobRecord> {
    const c = this.cluster(req.clusterId)
    const target = this.targetOf(c)
    const id = `rj-${Date.now().toString(36)}`
    const stem = this.safe(req.jobName || req.inputName || req.program)
    const jobName = `${stem}-${id}`

    // Working directory: a fresh per-job dir under the cluster base when staging
    // local files, or the existing remote directory when running files in place.
    const workdir = req.remoteInputDir
      ? req.remoteInputDir
      : `${c.remoteBaseDir.replace(/\/+$/, '')}/${jobName}`

    const outputFormat = req.outputFormat ?? null
    const outputName = outputFormat ? `${req.inputName.replace(/\.[^.]*$/, '')}.${outputFormat}` : undefined

    const record: RemoteJobRecord = {
      id,
      clusterId: c.id,
      clusterName: c.name,
      program: req.program,
      jobName,
      workdir,
      inputName: req.inputName,
      outputFormat,
      outputName,
      submittedAt: Date.now(),
      status: 'submitting',
      log: ''
    }
    this.jobs.set(id, record)
    this.saveJobs()
    this.emit('remote:jobUpdate', record)

    try {
      // 1. Ensure the working directory exists.
      const mk = await sshMkdirp(target, workdir)
      if (mk.code !== 0) throw new Error(mk.stderr.trim() || 'could not create remote working directory')

      // 2. Stage input files (skipped when running on existing remote files).
      for (const f of req.files ?? []) {
        const up = await uploadBytes(target, `${workdir}/${f.name}`, Buffer.from(f.text, 'utf8'))
        if (up.code !== 0) throw new Error(up.stderr.trim() || `failed to upload ${f.name}`)
      }

      // 3. Write job.sh (setup + Tinker command + exit-code capture).
      const setup = buildSetup({ remoteTinkerDir: c.remoteTinkerDir, setupCommands: c.setupCommands })
      const tinkerCmd = composeTinkerCommand({
        program: req.program,
        input: req.inputName,
        args: req.tinkerArgs,
        stdin: req.stdin
      })
      const script = buildJobScript({ workdir, setup, tinkerCmd })
      const upScript = await uploadBytes(target, `${workdir}/job.sh`, Buffer.from(script, 'utf8'))
      if (upScript.code !== 0) throw new Error(upScript.stderr.trim() || 'failed to upload job.sh')

      // 4. Render + run the submit template.
      const vars = this.submitVars(c, req, workdir, jobName)
      const { text: submitCmd, missing } = renderTemplate(c.templates.submit, vars)
      if (missing.length) {
        this.append(id, `Warning: unfilled template variables: ${missing.join(', ')}\n`)
      }
      const res = await sshRun(target, submitCmd)
      this.append(id, `$ ${submitCmd}\n${res.stdout}${res.stderr}`)
      if (res.code !== 0) throw new Error(res.stderr.trim() || `submit exited ${res.code}`)

      const remoteJobId = extractJobId(res.stdout, c.templates.submitIdPattern)
      if (!remoteJobId) throw new Error('Could not parse a job id from the submit output')

      this.update(id, {
        remoteJobId,
        status: 'pending',
        commandLine: `${req.program} ${req.inputName}`
      })
      this.startPolling(id)
    } catch (e) {
      this.update(id, { status: 'failed', error: messageOf(e), finishedAt: Date.now() })
    }
    return this.jobs.get(id)!
  }

  private submitVars(
    c: ClusterProfile,
    req: RemoteSubmitRequest,
    workdir: string,
    jobName: string
  ): Record<string, string> {
    const vars: Record<string, string> = {
      workdir,
      job_name: jobName,
      program: req.program,
      input: req.inputName,
      script: 'job.sh'
    }
    // Variable defaults first, then user-supplied overrides.
    for (const v of c.variables) vars[v.name] = v.default ?? ''
    for (const [k, val] of Object.entries(req.variables ?? {})) vars[k] = val
    return vars
  }

  private append(id: string, text: string): void {
    const j = this.jobs.get(id)
    if (!j) return
    j.log = (j.log + text).slice(-20000)
    this.saveJobs()
    this.emit('remote:jobUpdate', j)
  }

  // ---- polling -----------------------------------------------------------

  /** Resume polling every job that was still active when the app last closed. */
  resumePolling(): void {
    for (const j of this.jobs.values()) {
      if (j.status === 'pending' || j.status === 'running' || j.status === 'submitting') {
        if (j.remoteJobId) this.startPolling(j.id)
      }
    }
  }

  private startPolling(id: string): void {
    if (this.timers.has(id)) return
    void this.poll(id)
    this.timers.set(id, setInterval(() => void this.poll(id), POLL_MS))
  }

  private stopPolling(id: string): void {
    const t = this.timers.get(id)
    if (t) clearInterval(t)
    this.timers.delete(id)
  }

  async poll(id: string): Promise<RemoteJobState> {
    const j = this.jobs.get(id)
    if (!j || !j.remoteJobId) return j?.status ?? 'unknown'
    const c = this.clusters.find((x) => x.id === j.clusterId)
    if (!c) return j.status
    const { text: cmd } = renderTemplate(c.templates.status, {
      job_id: j.remoteJobId,
      workdir: j.workdir
    })
    const res = await sshRun(this.targetOf(c), cmd)
    const raw = res.stdout.trim()
    const state = classifyStatus(raw)
    if (state === 'unknown') return j.status // transient; keep prior state
    const exitCode = exitCodeFromStatus(raw)
    if (state !== j.status || exitCode !== j.exitCode) {
      const terminal = state === 'completed' || state === 'failed' || state === 'canceled'
      this.update(id, {
        status: state,
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(terminal ? { finishedAt: Date.now() } : {})
      })
      if (terminal) this.stopPolling(id)
    }
    return state
  }

  async cancel(id: string): Promise<void> {
    const j = this.jobs.get(id)
    if (!j || !j.remoteJobId) return
    const c = this.clusters.find((x) => x.id === j.clusterId)
    if (!c) return
    const { text: cmd } = renderTemplate(c.templates.cancel, {
      job_id: j.remoteJobId,
      workdir: j.workdir
    })
    const res = await sshRun(this.targetOf(c), cmd)
    this.append(id, `$ ${cmd}\n${res.stdout}${res.stderr}`)
    this.update(id, { status: 'canceled', finishedAt: Date.now() })
    this.stopPolling(id)
  }

  // ---- results + remote files -------------------------------------------

  /** Download a remote file's text by job id + relative name. */
  async fetchJobText(id: string, name: string): Promise<{ name: string; text: string }> {
    const j = this.jobs.get(id)
    if (!j) throw new Error('Unknown job')
    const c = this.cluster(j.clusterId)
    const buf = await downloadBytes(this.targetOf(c), `${j.workdir}/${name}`)
    return { name, text: buf.toString('utf8') }
  }

  /** List the files in a finished job's working directory. */
  async listJobFiles(id: string): Promise<string[]> {
    const j = this.jobs.get(id)
    if (!j) throw new Error('Unknown job')
    const c = this.cluster(j.clusterId)
    const r = await sshRun(this.targetOf(c), `ls -1 ${remoteQuote(j.workdir)} 2>/dev/null`)
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  }

  /** Download a remote file's bytes (binary-safe) by job id + relative name. */
  async fetchJobBytes(id: string, name: string): Promise<Buffer> {
    const j = this.jobs.get(id)
    if (!j) throw new Error('Unknown job')
    const c = this.cluster(j.clusterId)
    return downloadBytes(this.targetOf(c), `${j.workdir}/${name}`)
  }

  /** Open an arbitrary remote text file by absolute/relative path on a cluster. */
  async openRemoteText(clusterId: string, path: string): Promise<{ name: string; text: string }> {
    const c = this.cluster(clusterId)
    const buf = await downloadBytes(this.targetOf(c), path)
    return { name: path.split('/').pop() ?? path, text: buf.toString('utf8') }
  }

  // ---- remote trajectory streaming --------------------------------------

  /** Open a remote .arc/.dcd for streamed playback; returns id + shape + first frame. */
  async openTrajectory(
    clusterId: string,
    path: string
  ): Promise<{ trajId: string; frameCount: number; natoms: number; kind: 'arc' | 'dcd'; firstFrameText?: string }> {
    const c = this.cluster(clusterId)
    const target = this.targetOf(c)
    const trajId = `rtraj-${++this.trajCounter}`
    if (/\.dcd$/i.test(path)) {
      const handle = await openRemoteDcd(target, path)
      this.trajectories.set(trajId, handle)
      return { trajId, frameCount: handle.frameCount, natoms: atomCountOf(handle), kind: 'dcd' }
    }
    const { handle, firstFrameText } = await openRemoteArc(target, path)
    this.trajectories.set(trajId, handle)
    return { trajId, frameCount: handle.frameCount, natoms: atomCountOf(handle), kind: 'arc', firstFrameText }
  }

  /** Open the live output trajectory of a running job. */
  openJobTrajectory(id: string): ReturnType<RemoteManager['openTrajectory']> {
    const j = this.jobs.get(id)
    if (!j) throw new Error('Unknown job')
    if (!j.outputName) throw new Error('Job has no trajectory output')
    return this.openTrajectory(j.clusterId, `${j.workdir}/${j.outputName}`)
  }

  async refreshTrajectory(trajId: string): Promise<number> {
    const h = this.trajectories.get(trajId)
    if (!h) return 0
    return h.kind === 'arc' ? refreshRemoteArc(h) : refreshRemoteDcd(h)
  }

  readTrajectoryFrame(trajId: string, frame: number): Promise<Float32Array | null> {
    const h = this.trajectories.get(trajId)
    if (!h) return Promise.resolve(null)
    return readRemoteFrame(h, frame)
  }

  closeTrajectory(trajId: string): void {
    this.trajectories.delete(trajId)
  }

  /** Clear all poll timers (on app quit). */
  dispose(): void {
    for (const t of this.timers.values()) clearInterval(t)
    this.timers.clear()
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
