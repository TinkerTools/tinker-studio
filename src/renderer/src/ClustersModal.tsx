import { useState } from 'react'
import type { ClusterProfile, ClusterKind, ClusterVariable } from '../../main/remote/types'

/**
 * Manage the remote clusters jobs can be submitted to. Each profile is a
 * connection (an ssh destination honoring ~/.ssh/config) plus the command
 * templates that wrap FFE's Tinker command into a submission for that site.
 * Built-in `ssh-direct` and `slurm` kinds seed sensible templates; `custom`
 * starts from the ssh-direct set as a blank canvas. Everything stays editable.
 */
export function ClustersModal({
  clusters,
  onChange,
  onClose
}: {
  clusters: ClusterProfile[]
  onChange: (clusters: ClusterProfile[]) => void
  onClose: () => void
}) {
  // Working list = the persisted clusters plus any not-yet-saved drafts. Drafts
  // exist only here until the user clicks Save, so the rest of the app (the
  // submit dropdown, etc.) never sees a half-configured cluster.
  const [list, setList] = useState<ClusterProfile[]>(clusters)
  const [savedIds, setSavedIds] = useState<Set<string>>(() => new Set(clusters.map((c) => c.id)))
  const [selectedId, setSelectedId] = useState<string | null>(clusters[0]?.id ?? null)
  const selected = list.find((c) => c.id === selectedId) ?? null

  async function addCluster(kind: ClusterKind): Promise<void> {
    // Create a draft only — not persisted until Save.
    const profile = await window.ffe.remote.newProfile(kind)
    setList((l) => [...l, profile])
    setSelectedId(profile.id)
  }

  async function save(profile: ClusterProfile): Promise<void> {
    const next = await window.ffe.remote.saveCluster(profile)
    setList((l) => l.map((c) => (c.id === profile.id ? profile : c)))
    setSavedIds((s) => new Set(s).add(profile.id))
    onChange(next)
  }

  async function remove(id: string): Promise<void> {
    // Persisted clusters are deleted on disk; an unsaved draft is just dropped.
    if (savedIds.has(id)) {
      const next = await window.ffe.remote.deleteCluster(id)
      onChange(next)
    }
    setList((l) => l.filter((c) => c.id !== id))
    setSavedIds((s) => {
      const n = new Set(s)
      n.delete(id)
      return n
    })
    if (selectedId === id) setSelectedId((cur) => (cur === id ? null : cur))
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-xl" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Clusters</h3>
          <button className="modal-x" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="cmd-body">
          <div className="cluster-list">
            {list.length === 0 && <p className="placeholder">No clusters configured yet.</p>}
            {list.map((c) => (
              <div
                key={c.id}
                className={c.id === selectedId ? 'cluster-item active' : 'cluster-item'}
                onClick={() => setSelectedId(c.id)}
              >
                <span className="cluster-name">{c.name}</span>
                <span className="cluster-kind">
                  {c.kind}
                  {!savedIds.has(c.id) && <span className="cluster-unsaved"> • unsaved</span>}
                </span>
              </div>
            ))}
            <div className="cluster-add">
              <button className="mini-btn" onClick={() => addCluster('ssh-direct')}>
                + SSH host
              </button>
              <button className="mini-btn" onClick={() => addCluster('slurm')}>
                + SLURM
              </button>
              <button className="mini-btn" onClick={() => addCluster('custom')}>
                + Custom
              </button>
            </div>
          </div>
          <div className="cluster-detail">
            {selected ? (
              <ClusterEditor
                key={selected.id}
                profile={selected}
                unsaved={!savedIds.has(selected.id)}
                onSave={save}
                onDelete={() => remove(selected.id)}
              />
            ) : (
              <p className="placeholder">Select or add a cluster to configure it.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ClusterEditor({
  profile,
  unsaved,
  onSave,
  onDelete
}: {
  profile: ClusterProfile
  unsaved: boolean
  onSave: (p: ClusterProfile) => void
  onDelete: () => void
}) {
  const [draft, setDraft] = useState<ClusterProfile>(profile)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [dirty, setDirty] = useState(false)
  const needsSave = dirty || unsaved

  function set<K extends keyof ClusterProfile>(key: K, value: ClusterProfile[K]): void {
    setDraft((d) => ({ ...d, [key]: value }))
    setDirty(true)
  }
  function setTemplate(key: keyof ClusterProfile['templates'], value: string): void {
    setDraft((d) => ({ ...d, templates: { ...d.templates, [key]: value } }))
    setDirty(true)
  }

  function setVar(i: number, patch: Partial<ClusterVariable>): void {
    setDraft((d) => {
      const variables = d.variables.map((v, j) => (j === i ? { ...v, ...patch } : v))
      return { ...d, variables }
    })
    setDirty(true)
  }
  function addVar(): void {
    setDraft((d) => ({ ...d, variables: [...d.variables, { name: '', default: '', scope: 'submit' }] }))
    setDirty(true)
  }
  function removeVar(i: number): void {
    setDraft((d) => ({ ...d, variables: d.variables.filter((_, j) => j !== i) }))
    setDirty(true)
  }

  async function test(): Promise<void> {
    // Test the current draft directly — no need to persist it first. Connection
    // variables use their entered defaults.
    setTesting(true)
    setTestMsg(null)
    try {
      const r = await window.ffe.remote.testProfile(draft)
      setTestMsg({ ok: r.ok, text: r.message })
    } catch (e) {
      setTestMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="cluster-form">
      <div className="form-row">
        <label>Name</label>
        <input value={draft.name} onChange={(e) => set('name', e.target.value)} />
      </div>
      <div className="form-row">
        <label>SSH host</label>
        <input
          placeholder="user@login.cluster.edu  (or a ~/.ssh/config alias)"
          value={draft.host}
          onChange={(e) => set('host', e.target.value)}
        />
      </div>
      <div className="form-row">
        <label>SSH options</label>
        <input
          placeholder="-p 2222 -J jump.host   (optional)"
          value={draft.sshOptions ?? ''}
          onChange={(e) => set('sshOptions', e.target.value)}
        />
      </div>
      <div className="form-row">
        <label>Remote job dir</label>
        <input
          placeholder="~/ffe-jobs"
          value={draft.remoteBaseDir}
          onChange={(e) => set('remoteBaseDir', e.target.value)}
        />
      </div>
      <div className="form-row">
        <label>Tinker bin dir</label>
        <input
          placeholder="/opt/tinker/bin   (prepended to PATH; optional)"
          value={draft.remoteTinkerDir ?? ''}
          onChange={(e) => set('remoteTinkerDir', e.target.value)}
        />
      </div>
      <div className="form-row">
        <label>Setup lines</label>
        <textarea
          className="mono"
          rows={2}
          placeholder="module load tinker   (run before the Tinker command; optional)"
          value={draft.setupCommands ?? ''}
          onChange={(e) => set('setupCommands', e.target.value)}
        />
      </div>

      <div className="form-section">
        <div className="form-section-head">
          <span>Variables</span>
          <button className="mini-btn" onClick={addVar}>
            + Add
          </button>
        </div>
        <p className="opt-desc">
          Usable in templates as <code>{'{{name}}'}</code>. <b>Submit</b> variables are
          prompted when launching a job; <b>connection</b> variables are part of the ssh host /
          options and are needed for everything (submitting, polling, downloading, opening remote
          files) — e.g. a node number behind a login front-door. A connection variable's default is
          its stored value.
        </p>
        {draft.variables.map((v, i) => (
          <div className="var-row var-row-scoped" key={i}>
            <input
              className="var-name"
              placeholder="name"
              value={v.name}
              onChange={(e) => setVar(i, { name: e.target.value })}
            />
            <input
              className="var-label"
              placeholder="label (optional)"
              value={v.label ?? ''}
              onChange={(e) => setVar(i, { label: e.target.value })}
            />
            <input
              className="var-default"
              placeholder={v.scope === 'connection' ? 'value' : 'default value'}
              value={v.default ?? ''}
              onChange={(e) => setVar(i, { default: e.target.value })}
            />
            <select
              className="var-scope"
              value={v.scope ?? 'submit'}
              onChange={(e) => setVar(i, { scope: e.target.value as 'submit' | 'connection' })}
            >
              <option value="submit">submit</option>
              <option value="connection">connection</option>
            </select>
            <button className="mini-btn ghost" onClick={() => removeVar(i)}>
              ×
            </button>
          </div>
        ))}
      </div>

      <button className="link-btn" onClick={() => setShowAdvanced((s) => !s)}>
        {showAdvanced ? '▾' : '▸'} Command templates (advanced)
      </button>
      {showAdvanced && (
        <div className="form-section">
          <p className="opt-desc">
            Variables available: <code>{'{{workdir}}'}</code>, <code>{'{{job_name}}'}</code>,{' '}
            <code>{'{{job_id}}'}</code>, <code>{'{{program}}'}</code>, <code>{'{{input}}'}</code>,
            plus your variables. FFE first uploads inputs and a <code>job.sh</code> (which runs the
            setup + Tinker command and records the exit code); these only launch / query / cancel it.
          </p>
          <TemplateField
            label="Submit (must print the job id)"
            value={draft.templates.submit}
            onChange={(v) => setTemplate('submit', v)}
          />
          <TemplateField
            label="Status (stdout is classified into a state)"
            value={draft.templates.status}
            onChange={(v) => setTemplate('status', v)}
          />
          <TemplateField
            label="Cancel"
            value={draft.templates.cancel}
            onChange={(v) => setTemplate('cancel', v)}
          />
          <div className="form-row">
            <label>Job-id regex</label>
            <input
              className="mono"
              value={draft.templates.submitIdPattern ?? ''}
              onChange={(e) => setTemplate('submitIdPattern', e.target.value)}
            />
          </div>
        </div>
      )}

      <div className="form-actions">
        <button
          className="modal-btn primary"
          onClick={() => {
            onSave(draft)
            setDirty(false)
          }}
          disabled={!needsSave}
        >
          {needsSave ? 'Save' : 'Saved'}
        </button>
        <button className="modal-btn" onClick={test} disabled={testing || !draft.host}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <button className="modal-btn ghost danger" onClick={onDelete}>
          Delete
        </button>
        {testMsg && (
          <span className={testMsg.ok ? 'test-ok' : 'test-bad'}>
            {testMsg.ok ? '✓ ' : '✗ '}
            {testMsg.text}
          </span>
        )}
      </div>
    </div>
  )
}

function TemplateField({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="form-row stacked">
      <label>{label}</label>
      <textarea className="mono" rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}
