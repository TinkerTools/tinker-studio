import { useState } from 'react'
import type { ClusterProfile } from '../../main/remote/types'

/**
 * Open a file that lives on a remote cluster: a structure (.xyz/.pdb/…) is
 * loaded directly, while a trajectory (.arc/.dcd) is streamed frame-on-demand
 * over ssh — nothing is downloaded whole. Pick the cluster, fill in any
 * connection-scoped variables (e.g. a node behind a front-door), type the
 * remote path, and go.
 */
export function RemoteOpenModal({
  clusters,
  onOpen,
  onManageClusters,
  onClose
}: {
  clusters: ClusterProfile[]
  onOpen: (clusterId: string, path: string, vars: Record<string, string>) => Promise<void>
  onManageClusters: () => void
  onClose: () => void
}) {
  const [clusterId, setClusterId] = useState(clusters[0]?.id ?? '')
  const [path, setPath] = useState('')
  const [vars, setVars] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const cluster = clusters.find((c) => c.id === clusterId) ?? null
  const connVars = (cluster?.variables ?? []).filter((v) => v.scope === 'connection')

  async function open(): Promise<void> {
    if (!clusterId || !path.trim()) return
    setBusy(true)
    try {
      const values: Record<string, string> = {}
      for (const v of connVars) values[v.name] = vars[v.name] ?? v.default ?? ''
      await onOpen(clusterId, path.trim(), values)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Open Remote File</h3>
          <button className="modal-x" onClick={onClose}>
            ×
          </button>
        </div>
        {clusters.length === 0 ? (
          <p className="placeholder">
            No clusters configured.{' '}
            <button className="link-btn" onClick={onManageClusters}>
              Add one…
            </button>
          </p>
        ) : (
          <div className="form-section">
            <div className="form-row">
              <label>Cluster</label>
              <select value={clusterId} onChange={(e) => setClusterId(e.target.value)}>
                {clusters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            {connVars.map((v) => (
              <div className="form-row" key={v.name}>
                <label title={v.description}>{v.label || v.name}</label>
                <input
                  value={vars[v.name] ?? v.default ?? ''}
                  onChange={(e) => setVars((m) => ({ ...m, [v.name]: e.target.value }))}
                />
              </div>
            ))}
            <div className="form-row">
              <label>Remote path</label>
              <input
                autoFocus
                placeholder="~/runs/sim/mol.arc"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void open()
                }}
              />
            </div>
            <p className="opt-desc">
              <code>.arc</code>/<code>.dcd</code> stream frame-by-frame; other files load directly.
              A <code>.dcd</code> reads its sibling <code>.xyz</code> for topology.
            </p>
            <div className="form-actions">
              <button className="modal-btn primary" onClick={open} disabled={busy || !path.trim()}>
                {busy ? 'Opening…' : 'Open'}
              </button>
              <button className="link-btn" onClick={onManageClusters}>
                Manage clusters…
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
