import { useEffect, useRef, useState } from 'react'
import { type JobRecord, jobStatusLabel } from './core/job'
import type { RemoteJobRecord, RemoteJobState } from '../../main/remote/types'

/**
 * Jobs manager for both local Tinker runs and remote (cluster) jobs.
 *
 * In-progress jobs are shown prominently; finished ones (completed / failed /
 * canceled) collapse into a disclosure so old jobs are retained but out of the
 * way — they can still be reopened to read the log, download outputs, or open a
 * result. A left list selects a job; the right pane shows its detail.
 */

type Sel = { scope: 'local'; id: string } | { scope: 'remote'; id: string } | null

const REMOTE_ACTIVE: RemoteJobState[] = ['submitting', 'pending', 'running']

export function JobsModal({
  jobs,
  remoteJobs,
  onClose,
  onCancel,
  onClear,
  onRemoteCancel,
  onRemoteForget,
  onViewLive,
  onOpenResult
}: {
  jobs: JobRecord[]
  remoteJobs: RemoteJobRecord[]
  onClose: () => void
  onCancel: (jobId: string) => void
  onClear: (jobId: string) => void
  onRemoteCancel: (id: string) => void
  onRemoteForget: (id: string) => void
  onViewLive: (job: RemoteJobRecord) => void
  onOpenResult: (job: RemoteJobRecord) => void
}) {
  const [sel, setSel] = useState<Sel>(null)
  const [showFinished, setShowFinished] = useState(false)

  const localRunning = jobs.filter((j) => j.status === 'running')
  const localDone = jobs.filter((j) => j.status !== 'running')
  const remoteActive = remoteJobs.filter((j) => REMOTE_ACTIVE.includes(j.status))
  const remoteDone = remoteJobs.filter((j) => !REMOTE_ACTIVE.includes(j.status))
  const finishedCount = localDone.length + remoteDone.length

  // Default selection: the first active job, else the most recent finished one.
  const resolved: Sel =
    sel ??
    (remoteActive[0]
      ? { scope: 'remote', id: remoteActive[0].id }
      : localRunning[0]
        ? { scope: 'local', id: localRunning[0].id }
        : remoteDone[0]
          ? { scope: 'remote', id: remoteDone[0].id }
          : localDone[0]
            ? { scope: 'local', id: localDone[0].id }
            : null)

  const localSel = resolved?.scope === 'local' ? jobs.find((j) => j.id === resolved.id) ?? null : null
  const remoteSel =
    resolved?.scope === 'remote' ? remoteJobs.find((j) => j.id === resolved.id) ?? null : null

  const empty = jobs.length === 0 && remoteJobs.length === 0

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-xl" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Jobs</h3>
          <button className="modal-x" onClick={onClose}>
            ×
          </button>
        </div>

        {empty ? (
          <p className="placeholder">
            No jobs yet. Launch one from <b>Tinker ▸ Modeling Commands…</b> — locally or on a
            configured cluster — and it will appear here.
          </p>
        ) : (
          <div className="jobs-manager">
            <div className="jobs-side">
              {(remoteActive.length > 0 || localRunning.length > 0) && (
                <div className="jobs-group-label">In progress</div>
              )}
              {remoteActive.map((j) => (
                <RemoteRow
                  key={j.id}
                  job={j}
                  active={resolved?.scope === 'remote' && resolved.id === j.id}
                  onClick={() => setSel({ scope: 'remote', id: j.id })}
                />
              ))}
              {localRunning.map((j) => (
                <LocalRow
                  key={j.id}
                  job={j}
                  active={resolved?.scope === 'local' && resolved.id === j.id}
                  onClick={() => setSel({ scope: 'local', id: j.id })}
                />
              ))}

              {finishedCount > 0 && (
                <button className="jobs-finished-toggle" onClick={() => setShowFinished((s) => !s)}>
                  {showFinished ? '▾' : '▸'} Finished ({finishedCount})
                </button>
              )}
              {showFinished &&
                remoteDone.map((j) => (
                  <RemoteRow
                    key={j.id}
                    job={j}
                    active={resolved?.scope === 'remote' && resolved.id === j.id}
                    onClick={() => setSel({ scope: 'remote', id: j.id })}
                  />
                ))}
              {showFinished &&
                localDone.map((j) => (
                  <LocalRow
                    key={j.id}
                    job={j}
                    active={resolved?.scope === 'local' && resolved.id === j.id}
                    onClick={() => setSel({ scope: 'local', id: j.id })}
                  />
                ))}
            </div>

            <div className="jobs-detail">
              {localSel && (
                <LocalDetail job={localSel} onCancel={onCancel} onClear={onClear} />
              )}
              {remoteSel && (
                <RemoteDetail
                  job={remoteSel}
                  onCancel={onRemoteCancel}
                  onForget={onRemoteForget}
                  onViewLive={onViewLive}
                  onOpenResult={onOpenResult}
                />
              )}
              {!localSel && !remoteSel && <p className="placeholder">Select a job.</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function LocalRow({ job, active, onClick }: { job: JobRecord; active: boolean; onClick: () => void }) {
  return (
    <div className={active ? 'job-row active' : 'job-row'} onClick={onClick}>
      <span className={`job-dot ${job.status}`} />
      <span className="job-row-name">{job.program}</span>
      <span className="job-row-sub">local · {job.systemName}</span>
    </div>
  )
}

function RemoteRow({
  job,
  active,
  onClick
}: {
  job: RemoteJobRecord
  active: boolean
  onClick: () => void
}) {
  return (
    <div className={active ? 'job-row active' : 'job-row'} onClick={onClick}>
      <span className={`job-dot ${remoteDot(job.status)}`} />
      <span className="job-row-name">{job.program}</span>
      <span className="job-row-sub">
        {job.clusterName} · {job.status}
      </span>
    </div>
  )
}

function LocalDetail({
  job,
  onCancel,
  onClear
}: {
  job: JobRecord
  onCancel: (id: string) => void
  onClear: (id: string) => void
}) {
  const logRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [job.output])
  return (
    <>
      <div className="job-meta">
        <span className="job-meta-main">
          <code>{job.program}</code> · {job.systemName} · local
        </span>
        <span className={`job-status ${job.status}`}>{jobStatusLabel(job)}</span>
        {job.status === 'running' ? (
          <button className="mini-btn" onClick={() => onCancel(job.id)}>
            Cancel
          </button>
        ) : (
          <button className="mini-btn" onClick={() => onClear(job.id)}>
            Remove
          </button>
        )}
      </div>
      <pre ref={logRef} className="run-log job-log">
        {job.output || '(no output yet)'}
      </pre>
    </>
  )
}

function RemoteDetail({
  job,
  onCancel,
  onForget,
  onViewLive,
  onOpenResult
}: {
  job: RemoteJobRecord
  onCancel: (id: string) => void
  onForget: (id: string) => void
  onViewLive: (job: RemoteJobRecord) => void
  onOpenResult: (job: RemoteJobRecord) => void
}) {
  const logRef = useRef<HTMLPreElement>(null)
  const [files, setFiles] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [job.log])

  const active = REMOTE_ACTIVE.includes(job.status)
  const isDynamics = job.program.toLowerCase() === 'dynamic'

  async function loadFiles(): Promise<void> {
    setBusy(true)
    try {
      setFiles(await window.ffe.remote.listJobFiles(job.id))
    } catch {
      setFiles([])
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="job-meta">
        <span className="job-meta-main">
          <code>{job.program}</code> · {job.clusterName}
        </span>
        <span className={`job-status ${remoteDot(job.status)}`}>{remoteStatusLabel(job)}</span>
        {active && (
          <button className="mini-btn" onClick={() => onCancel(job.id)}>
            Cancel
          </button>
        )}
        {!active && (
          <button className="mini-btn" onClick={() => onForget(job.id)}>
            Remove
          </button>
        )}
      </div>

      <div className="job-subgrid">
        <span>Remote id</span>
        <code>{job.remoteJobId ?? '—'}</code>
        <span>Working dir</span>
        <code>{job.workdir}</code>
        {job.error && (
          <>
            <span>Error</span>
            <code className="err">{job.error}</code>
          </>
        )}
      </div>

      <div className="run-buttons">
        {job.outputFormat && (active || job.status === 'completed') && (
          <button className="modal-btn" onClick={() => onViewLive(job)}>
            {active ? 'View live' : 'Play trajectory'}
          </button>
        )}
        {(job.status === 'completed' || job.status === 'failed') && (
          <button className="modal-btn" onClick={() => onOpenResult(job)} disabled={!isDynamics && !job.inputName}>
            Open result
          </button>
        )}
        <button className="modal-btn ghost" onClick={loadFiles} disabled={busy}>
          {busy ? 'Listing…' : 'Files…'}
        </button>
      </div>

      {files && (
        <div className="job-files">
          {files.length === 0 && <span className="opt-desc">No files (or directory unavailable).</span>}
          {files.map((f) => (
            <div className="job-file-row" key={f}>
              <code>{f}</code>
              <button className="mini-btn ghost" onClick={() => void window.ffe.remote.saveJobFile(job.id, f)}>
                Download
              </button>
            </div>
          ))}
        </div>
      )}

      <pre ref={logRef} className="run-log job-log">
        {job.log || '(no output captured yet)'}
      </pre>
    </>
  )
}

function remoteDot(s: RemoteJobState): string {
  if (s === 'running' || s === 'pending' || s === 'submitting') return 'running'
  if (s === 'completed') return 'exited'
  return 'failed'
}

function remoteStatusLabel(job: RemoteJobRecord): string {
  if (job.status === 'failed' && job.exitCode != null) return `Failed (exit ${job.exitCode})`
  return job.status.charAt(0).toUpperCase() + job.status.slice(1)
}
