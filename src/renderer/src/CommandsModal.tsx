import { useMemo, useState } from 'react'
import { tinkerCommands, type TinkerCommand, type TinkerOption } from './data/tinkerCatalog'
import type { MolecularSystem } from './core/system'
import { liveKind, type JobRecord } from './core/job'

type RunJob = (
  program: string,
  system: MolecularSystem,
  stdin: string,
  watch: boolean
) => Promise<string>

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
  jobs,
  onRunJob,
  onClose
}: {
  system: MolecularSystem | null
  tinkerDir?: string
  jobs: JobRecord[]
  onRunJob: RunJob
  onClose: () => void
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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Tinker Modeling Commands{ft ? ` · ${ft}` : ''}</h3>
          <button className="modal-x" onClick={onClose}>
            ×
          </button>
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
                jobs={jobs}
                onRunJob={onRunJob}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function CommandDetail({
  command,
  system,
  tinkerDir,
  jobs,
  onRunJob
}: {
  command: TinkerCommand
  system: MolecularSystem | null
  tinkerDir?: string
  jobs: JobRecord[]
  onRunJob: RunJob
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
        jobs={jobs}
        onRunJob={onRunJob}
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
  jobs,
  onRunJob,
  buildStdin
}: {
  command: TinkerCommand
  system: MolecularSystem | null
  tinkerDir?: string
  jobs: JobRecord[]
  onRunJob: RunJob
  buildStdin: () => string
}) {
  // The job started from this panel; its output/status are read from the shared
  // App-level job list so they survive the modal closing.
  const [jobId, setJobId] = useState<string | null>(null)
  const [watchLive, setWatchLive] = useState(true)
  const job = jobs.find((j) => j.id === jobId) ?? null
  const running = job?.status === 'running'
  const canRun = Boolean(system?.path)
  const kind = liveKind(command.name.toLowerCase())

  async function run(): Promise<void> {
    if (!system) return
    const id = await onRunJob(command.name.toLowerCase(), system, buildStdin(), watchLive)
    setJobId(id)
  }

  return (
    <div className="run-section">
      <div className="run-status">
        Program <code>{command.name.toLowerCase()}</code>
        {tinkerDir ? (
          <>
            {' · '}
            Tinker: <code>{tinkerDir}</code>
          </>
        ) : (
          <span className="run-warn"> · Tinker directory not set (Tinker ▸ Set Tinker Directory…)</span>
        )}
      </div>
      {!canRun && (
        <div className="run-warn">Open this system from a file on disk to run Tinker on it.</div>
      )}
      {kind && (
        <label className="watch-live">
          <input
            type="checkbox"
            checked={watchLive}
            disabled={running}
            onChange={(e) => setWatchLive(e.target.checked)}
          />
          Watch live — animate the {kind === 'dynamics' ? 'trajectory' : 'minimization'} as it runs
        </label>
      )}
      <div className="run-buttons">
        <button className="modal-btn primary" onClick={run} disabled={!canRun || running}>
          {running ? 'Running…' : 'Run'}
        </button>
        {running && job && (
          <button className="modal-btn ghost" onClick={() => window.ffe.job.cancel(job.id)}>
            Cancel
          </button>
        )}
        {job && (
          <span className="run-hint">Output is kept in Tinker ▸ Job Output…</span>
        )}
      </div>
      {job?.output && <pre className="run-log">{job.output}</pre>}
    </div>
  )
}
