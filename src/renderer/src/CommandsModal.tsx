import { useEffect, useMemo, useRef, useState } from 'react'
import { tinkerCommands, type TinkerCommand, type TinkerOption } from './data/tinkerCatalog'
import { liveKind } from './core/job'
import type { ClusterProfile } from '../../main/remote/types'

/**
 * The fields of the active system this panel needs. The full MolecularSystem lives
 * in the main window; only this lightweight summary is relayed to the detached
 * Commands window (which forwards launches back to run against the real system).
 */
export type SystemSummary = { name: string; fileType: string; hasKey: boolean }

/** Launch a Tinker program locally against the main window's active system. */
type RunLocal = (
  program: string,
  stdin: string,
  watch: boolean,
  requiresStructure: boolean,
  /** Load a converter's result when it finishes: 'xyz' (pdbxyz) or 'pdb' (xyzpdb). */
  loadResult?: 'xyz' | 'pdb'
) => void

/** Submit a job to a remote cluster. Returns true on a successful submission. */
export type SubmitRemote = (opts: {
  program: string
  clusterId: string
  source: 'upload' | 'remote'
  remoteInputDir?: string
  inputName?: string
  /** A specific remote .key path to use (run-on-existing-files case). */
  remoteKeyPath?: string
  variables: Record<string, string>
  stdin: string
  watch: boolean
  requiresStructure: boolean
}) => Promise<boolean>

// fileTypes ['ANY'] are sequence builders (protein/nucleic) that take no
// coordinate file; everything else operates on a loaded structure.
function needsStructure(command: TinkerCommand): boolean {
  return !command.fileTypes.includes('ANY')
}

/**
 * Data-driven Tinker command browser + launcher. Lists the programs applicable
 * to the active system's file type, renders each command's option form from the
 * catalog, and (when a Tinker directory and an on-disk system are available)
 * spawns the program, feeding the option values to its stdin and streaming the
 * output back into a log.
 */
export function CommandsModal({
  system,
  tinkerDir,
  clusters,
  embedded = false,
  onRun,
  onSubmitRemote,
  onManageClusters,
  onStarted,
  onClose
}: {
  system: SystemSummary | null
  tinkerDir?: string
  clusters: ClusterProfile[]
  /** Render to fill its own window (no modal backdrop/×) instead of as an overlay. */
  embedded?: boolean
  onRun: RunLocal
  onSubmitRemote: SubmitRemote
  onManageClusters: () => void
  /** Called when a command is launched — used to jump to the Jobs view. */
  onStarted: () => void
  onClose?: () => void
}) {
  const ft = system?.fileType.toUpperCase()
  const commands = useMemo(() => {
    if (!ft) return tinkerCommands
    const matched = tinkerCommands.filter((c) =>
      c.fileTypes.map((f) => f.toUpperCase()).includes(ft)
    )
    return matched.length ? matched : tinkerCommands
  }, [ft])

  const [selected, setSelected] = useState(commands[0]?.name ?? '')
  const command = commands.find((c) => c.name === selected) ?? commands[0]

  const body = (
    <>
      <div className="modal-head">
        <h3>Tinker Modeling Commands{ft ? ` · ${ft}` : ''}</h3>
        {!embedded && (
          <button className="modal-x" onClick={onClose}>
            ×
          </button>
        )}
      </div>
      <div className="cmd-body">
        <ul className="cmd-list">
          {commands.map((c) => (
            <li
              key={c.name}
              className={c.name === command?.name ? 'cmd-item active' : 'cmd-item'}
              onClick={() => setSelected(c.name)}
            >
              {c.name}
            </li>
          ))}
        </ul>
        <div className="cmd-detail">
          {command && (
            <CommandDetail
              key={command.name}
              command={command}
              system={system}
              tinkerDir={tinkerDir}
              clusters={clusters}
              onRun={onRun}
              onSubmitRemote={onSubmitRemote}
              onManageClusters={onManageClusters}
              onStarted={onStarted}
            />
          )}
        </div>
      </div>
    </>
  )

  if (embedded) {
    return <div className="commands-window">{body}</div>
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
        {body}
      </div>
    </div>
  )
}

function CommandDetail({
  command,
  system,
  tinkerDir,
  clusters,
  onRun,
  onSubmitRemote,
  onManageClusters,
  onStarted
}: {
  command: TinkerCommand
  system: SystemSummary | null
  tinkerDir?: string
  clusters: ClusterProfile[]
  onRun: RunLocal
  onSubmitRemote: SubmitRemote
  onManageClusters: () => void
  onStarted: () => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const valueOf = (o: TinkerOption): string => values[o.name] ?? o.default

  const buildStdin = (): string => {
    const lines = command.options.map((o) => valueOf(o)).filter((v) => v !== '')
    return lines.length ? lines.join('\n') + '\n' : ''
  }

  return (
    <>
      <h4>{command.name}</h4>
      <p className="cmd-desc">{command.description}</p>
      {command.options.length > 0 && (
        <div className="cmd-options">
          {command.options.map((o, i) => (
            <OptionField
              key={i}
              option={o}
              value={valueOf(o)}
              onChange={(v) => setValues((m) => ({ ...m, [o.name]: v }))}
            />
          ))}
        </div>
      )}
      <RunSection
        command={command}
        system={system}
        tinkerDir={tinkerDir}
        clusters={clusters}
        onRun={onRun}
        onSubmitRemote={onSubmitRemote}
        onManageClusters={onManageClusters}
        onStarted={onStarted}
        buildStdin={buildStdin}
      />
    </>
  )
}

function OptionField({
  option,
  value,
  onChange
}: {
  option: TinkerOption
  value: string
  onChange: (value: string) => void
}) {
  const gui = option.gui
  return (
    <div className="opt-field">
      <label className="opt-label">{option.name}</label>
      {option.description && <p className="opt-desc">{option.description}</p>}

      {(gui === 'TEXTFIELD' || gui === 'TERMINATEDTEXTFIELD' || gui === 'SYSTEMS') && (
        <input className="opt-input" value={value} onChange={(e) => onChange(e.target.value)} />
      )}

      {gui === 'RADIOBUTTONS' && (
        <div className="opt-choices">
          {(option.values.length ? option.values : ['Y', 'N']).map((v) => (
            <label key={v} className="opt-choice">
              <input type="radio" name={option.name} checked={value === v} onChange={() => onChange(v)} />
              {v}
            </label>
          ))}
        </div>
      )}

      {gui === 'CHECKBOXES' && (
        <div className="opt-choices">
          {option.values.map((v) => {
            const checked = value.includes(v)
            return (
              <label key={v} className="opt-choice">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    onChange(
                      option.values.filter((cv) => (cv === v ? !checked : value.includes(cv))).join('')
                    )
                  }
                />
                {v}
              </label>
            )
          })}
        </div>
      )}

      {(gui === 'PROTEIN' || gui === 'NUCLEIC') && (
        <textarea
          className="opt-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`${gui === 'PROTEIN' ? 'Protein' : 'Nucleic acid'} sequence…`}
        />
      )}

      {option.conditionals.map((c, i) => (
        <div key={i} className="opt-cond">
          <span className="opt-cond-label">
            if “{c.value}”: {c.description}
          </span>
          <input className="opt-input" defaultValue={c.default} />
        </div>
      ))}
    </div>
  )
}

function RunSection({
  command,
  system,
  tinkerDir,
  clusters,
  onRun,
  onSubmitRemote,
  onManageClusters,
  onStarted,
  buildStdin
}: {
  command: TinkerCommand
  system: SystemSummary | null
  tinkerDir?: string
  clusters: ClusterProfile[]
  onRun: RunLocal
  onSubmitRemote: SubmitRemote
  onManageClusters: () => void
  onStarted: () => void
  buildStdin: () => string
}) {
  const [watchLive, setWatchLive] = useState(true)
  // 'local' or a cluster id.
  const [target, setTarget] = useState('local')
  const [source, setSource] = useState<'upload' | 'remote'>('upload')
  const [remoteDir, setRemoteDir] = useState('')
  const [remoteInput, setRemoteInput] = useState('')
  const [remoteKey, setRemoteKey] = useState('')
  const [vars, setVars] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitMsg, setSubmitMsg] = useState<string | null>(null)
  // Brief guard so a double-click doesn't launch two jobs (progress is shown in
  // the Jobs window, so the Run button has no long-lived running state of its own).
  const [justLaunched, setJustLaunched] = useState(false)
  const launchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (launchTimer.current && clearTimeout(launchTimer.current)), [])

  const program = command.name.toLowerCase()
  const requires = needsStructure(command)
  const kind = liveKind(program)
  const noKeyWarning = requires && system != null && !system.hasKey
  const cluster = clusters.find((c) => c.id === target) ?? null
  const isRemote = cluster != null
  // A converter (pdbxyz / xyzpdb) declares the result to load back via its action.
  const loadResult: 'xyz' | 'pdb' | undefined = command.actions.includes('LOADXYZ')
    ? 'xyz'
    : command.actions.includes('LOADPDB')
      ? 'pdb'
      : undefined

  function run(): void {
    if (justLaunched) return
    // Launch runs against the main window's active system + viewer; progress is
    // shown in the Jobs window, which onStarted opens.
    onRun(program, buildStdin(), watchLive, requires, loadResult)
    onStarted()
    setJustLaunched(true)
    launchTimer.current = setTimeout(() => setJustLaunched(false), 1200)
  }

  async function submitRemote(): Promise<void> {
    if (!cluster) return
    setSubmitting(true)
    setSubmitMsg(null)
    try {
      const variables: Record<string, string> = {}
      for (const v of cluster.variables) variables[v.name] = vars[v.name] ?? v.default ?? ''
      const ok = await onSubmitRemote({
        program,
        clusterId: cluster.id,
        source,
        remoteInputDir: source === 'remote' ? remoteDir.trim() : undefined,
        inputName: source === 'remote' ? remoteInput.trim() : undefined,
        remoteKeyPath: source === 'remote' && remoteKey.trim() ? remoteKey.trim() : undefined,
        variables,
        stdin: buildStdin(),
        watch: watchLive,
        requiresStructure: requires
      })
      if (ok) onStarted()
      else setSubmitMsg('Submission failed — see the Jobs window for details.')
    } catch (e) {
      setSubmitMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const canRunLocal = requires ? Boolean(system) : true
  const canSubmitRemote =
    isRemote &&
    Boolean(cluster?.host) &&
    (source === 'upload' ? !requires || Boolean(system) : Boolean(remoteDir.trim() && remoteInput.trim()))

  return (
    <div className="run-section">
      <div className="run-status">
        Program <code>{program}</code>
        {requires && !isRemote && (
          <>
            {' · '}
            System: <code>{system?.name ?? '(none)'}</code>
          </>
        )}
      </div>

      <div className="run-target">
        <label>Run on</label>
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="local">This computer (local)</option>
          {clusters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.kind})
            </option>
          ))}
        </select>
        <button className="link-btn" onClick={onManageClusters}>
          Manage clusters…
        </button>
      </div>

      {!isRemote && !tinkerDir && (
        <div className="run-warn">Tinker directory not set (Tinker ▸ Set Tinker Installation Folder…).</div>
      )}
      {!isRemote && requires && !system && (
        <div className="run-warn">Load a system to run this command on.</div>
      )}
      {noKeyWarning && !isRemote && (
        <div className="run-warn">
          No key file attached — attempting with a minimal default key; the run may need a force
          field (.prm) to succeed.
        </div>
      )}

      {isRemote && (
        <div className="remote-submit">
          {requires && (
            <div className="run-source">
              <label className="opt-choice">
                <input
                  type="radio"
                  name="src"
                  checked={source === 'upload'}
                  onChange={() => setSource('upload')}
                />
                Upload current system{system ? `: ${system.name}` : ' (none loaded)'}
              </label>
              <label className="opt-choice">
                <input
                  type="radio"
                  name="src"
                  checked={source === 'remote'}
                  onChange={() => setSource('remote')}
                />
                Use files already on the cluster
              </label>
            </div>
          )}
          {requires && source === 'remote' && (
            <div className="remote-files">
              <div className="form-row">
                <label>Remote dir</label>
                <input
                  placeholder="~/runs/mysim"
                  value={remoteDir}
                  onChange={(e) => setRemoteDir(e.target.value)}
                />
              </div>
              <div className="form-row">
                <label>Input file</label>
                <input
                  placeholder="mol.xyz"
                  value={remoteInput}
                  onChange={(e) => setRemoteInput(e.target.value)}
                />
              </div>
              <div className="form-row">
                <label>Key file</label>
                <input
                  placeholder="optional — e.g. ~/params/run.key (copied to <input>.key)"
                  value={remoteKey}
                  onChange={(e) => setRemoteKey(e.target.value)}
                />
              </div>
            </div>
          )}
          {cluster && cluster.variables.length > 0 && (
            <div className="remote-vars">
              {cluster.variables.map((v) => (
                <div className="form-row" key={v.name}>
                  <label title={v.description}>{v.label || v.name}</label>
                  <input
                    value={vars[v.name] ?? v.default ?? ''}
                    onChange={(e) => setVars((m) => ({ ...m, [v.name]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {kind && (
        <label className="watch-live">
          <input type="checkbox" checked={watchLive} onChange={(e) => setWatchLive(e.target.checked)} />
          {isRemote
            ? `Stream the ${kind === 'dynamics' ? 'trajectory' : 'output'} into the viewer as it runs`
            : `Watch live — animate the ${kind === 'dynamics' ? 'trajectory' : 'minimization'} as it runs`}
        </label>
      )}

      <div className="run-buttons">
        {!isRemote ? (
          <button className="modal-btn primary" onClick={run} disabled={!canRunLocal || justLaunched}>
            {justLaunched ? 'Launching…' : 'Run'}
          </button>
        ) : (
          <button
            className="modal-btn primary"
            onClick={submitRemote}
            disabled={!canSubmitRemote || submitting}
          >
            {submitting ? 'Submitting…' : 'Submit'}
          </button>
        )}
        <span className="run-hint">Jobs are tracked in Tinker ▸ Jobs…</span>
      </div>
      {submitMsg && <div className="run-warn">{submitMsg}</div>}
    </div>
  )
}
