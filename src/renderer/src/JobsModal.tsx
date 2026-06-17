import { useEffect, useRef, useState } from 'react'
import { type JobRecord, jobStatusLabel } from './core/job'

/**
 * Persistent Tinker job console. One tab per job started this session; each tab
 * shows that job's full captured output. Jobs keep accumulating output even
 * while this window is closed, so it can be reopened any time to review them.
 */
export function JobsModal({
  jobs,
  onClose,
  onCancel,
  onClear
}: {
  jobs: JobRecord[]
  onClose: () => void
  onCancel: (jobId: string) => void
  onClear: (jobId: string) => void
}) {
  const [activeId, setActiveId] = useState<string | null>(null)
  // Default to (and follow) the most recent job until the user picks one.
  const pinnedRef = useRef(false)
  const latest = jobs[jobs.length - 1]
  const active = jobs.find((j) => j.id === activeId) ?? latest ?? null

  const logRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [active?.output])

  const select = (id: string): void => {
    pinnedRef.current = true
    setActiveId(id)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Job Output</h3>
          <button className="modal-x" onClick={onClose}>
            ×
          </button>
        </div>

        {jobs.length === 0 ? (
          <p className="placeholder">
            No jobs yet. Launch one from <b>Tinker ▸ Modeling Commands…</b> and its output
            will be kept here.
          </p>
        ) : (
          <div className="jobs-body">
            <div className="jobs-tabs" role="tablist">
              {jobs.map((j) => (
                <button
                  key={j.id}
                  className={j.id === active?.id ? 'job-tab active' : 'job-tab'}
                  onClick={() => select(j.id)}
                  title={j.commandLine ?? j.program}
                >
                  <span className={`job-dot ${j.status}`} />
                  <span className="job-tab-name">{j.program}</span>
                </button>
              ))}
            </div>
            {active && (
              <div className="job-view">
                <div className="job-meta">
                  <span className="job-meta-main">
                    <code>{active.program}</code> · {active.systemName}
                  </span>
                  <span className={`job-status ${active.status}`}>{jobStatusLabel(active)}</span>
                  {active.status === 'running' && (
                    <button className="mini-btn" onClick={() => onCancel(active.id)}>
                      Cancel
                    </button>
                  )}
                  {active.status !== 'running' && (
                    <button className="mini-btn" onClick={() => onClear(active.id)}>
                      Remove
                    </button>
                  )}
                </div>
                <pre ref={logRef} className="run-log job-log">
                  {active.output || '(no output yet)'}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
