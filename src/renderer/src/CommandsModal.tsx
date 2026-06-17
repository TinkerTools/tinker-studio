import { useMemo, useState } from 'react'
import { tinkerCommands, type TinkerCommand, type TinkerOption } from './data/tinkerCatalog'

/**
 * Data-driven Tinker command browser, generated from the original commands.xml.
 * Lists the programs applicable to the active system's file type and renders
 * each command's option form from the catalog. Execution (launching Tinker) is
 * a later step; this is the option UI.
 */
export function CommandsModal({ fileType, onClose }: { fileType?: string; onClose: () => void }) {
  const ft = fileType?.toUpperCase()
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
          <div className="cmd-detail">{command && <CommandDetail command={command} />}</div>
        </div>
      </div>
    </div>
  )
}

function CommandDetail({ command }: { command: TinkerCommand }) {
  return (
    <>
      <h4>{command.name}</h4>
      <p className="cmd-desc">{command.description}</p>
      {command.options.length > 0 && (
        <div className="cmd-options">
          {command.options.map((o, i) => (
            <OptionField key={i} option={o} />
          ))}
        </div>
      )}
      <p className="cmd-note">Launching Tinker to run the command is a later step.</p>
    </>
  )
}

function OptionField({ option }: { option: TinkerOption }) {
  const [value, setValue] = useState(option.default)
  const gui = option.gui

  return (
    <div className="opt-field">
      <label className="opt-label">{option.name}</label>
      {option.description && <p className="opt-desc">{option.description}</p>}

      {(gui === 'TEXTFIELD' || gui === 'TERMINATEDTEXTFIELD' || gui === 'SYSTEMS') && (
        <input className="opt-input" value={value} onChange={(e) => setValue(e.target.value)} />
      )}

      {gui === 'RADIOBUTTONS' && (
        <div className="opt-choices">
          {(option.values.length ? option.values : ['Y', 'N']).map((v) => (
            <label key={v} className="opt-choice">
              <input
                type="radio"
                name={option.name}
                checked={value === v}
                onChange={() => setValue(v)}
              />
              {v}
            </label>
          ))}
        </div>
      )}

      {gui === 'CHECKBOXES' && (
        <div className="opt-choices">
          {option.values.map((v) => (
            <label key={v} className="opt-choice">
              <input type="checkbox" defaultChecked={option.default.includes(v)} />
              {v}
            </label>
          ))}
        </div>
      )}

      {(gui === 'PROTEIN' || gui === 'NUCLEIC') && (
        <textarea
          className="opt-textarea"
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
