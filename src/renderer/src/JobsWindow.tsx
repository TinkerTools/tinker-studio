import { useEffect, useState } from 'react'
import { JobsModal } from './JobsModal'
import type { JobRecord } from './core/job'
import type { RemoteJobRecord } from '../../main/remote/types'

/**
 * Root of the detachable Jobs window — the Jobs panel filling its own OS window.
 *
 * The main window owns local job state and the 3D viewer, so this window:
 *  - owns remote-job state itself (remote jobs live in the main process and are
 *    broadcast to every window, exactly as App.tsx consumes them);
 *  - receives the main window's local job list via the `jobsWindow.onLocalJobs`
 *    relay (requesting a fresh snapshot on mount);
 *  - forwards the actions that must run in the main window (removing a finished
 *    local job, and loading a remote job's live/result structure into the viewer)
 *    back through `jobsWindow.sendAction`.
 * Purely-IPC actions (cancel, remote cancel/forget/rename) are called directly.
 */
export function JobsWindow() {
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [remoteJobs, setRemoteJobs] = useState<RemoteJobRecord[]>([])
  const [selectId, setSelectId] = useState<string | null>(null)

  // Local jobs are pushed from the main window; ask for the current snapshot now.
  useEffect(() => {
    const off = window.tinker.jobsWindow.onLocalJobs((j) => setJobs(j as JobRecord[]))
    const offSel = window.tinker.jobsWindow.onSelect(setSelectId)
    window.tinker.jobsWindow.requestState()
    return () => {
      off()
      offSel()
    }
  }, [])

  // Remote jobs: load once, then keep live via the same broadcast App.tsx uses.
  useEffect(() => {
    void window.tinker.remote.listJobs().then(setRemoteJobs)
    return window.tinker.remote.onJobUpdate((job) => {
      setRemoteJobs((prev) => {
        const i = prev.findIndex((j) => j.id === job.id)
        if (i < 0) return [job, ...prev]
        const next = prev.slice()
        next[i] = job
        return next
      })
    })
  }, [])

  return (
    <JobsModal
      embedded
      jobs={jobs}
      remoteJobs={remoteJobs}
      initialRemoteId={selectId}
      onCancel={(id) => void window.tinker.job.cancel(id)}
      onClear={(id) => window.tinker.jobsWindow.sendAction({ type: 'clear', id })}
      onRemoteCancel={(id) => void window.tinker.remote.cancel(id)}
      onRemoteForget={(id) => void window.tinker.remote.forgetJob(id).then(setRemoteJobs)}
      onRemoteRename={(id, label) => void window.tinker.remote.renameJob(id, label)}
      onViewLive={(job) => window.tinker.jobsWindow.sendAction({ type: 'viewLive', job })}
      onOpenResult={(job) => window.tinker.jobsWindow.sendAction({ type: 'openResult', job })}
    />
  )
}
