import { useEffect, useRef, useState } from 'react'
import { Viewer } from './viewer/Viewer'
import { parseStructureFile, nextSystemId, type MolecularSystem } from './core/system'
import {
  DEFAULT_RENDER_OPTIONS,
  REPRESENTATIONS,
  COLOR_MODES,
  type RenderOptions,
  type Representation,
  type ColorMode
} from './viewer/renderOptions'
import ethanolSample from './samples/ethanol.xyz?raw'

/**
 * Root layout: a sidebar (loaded systems + active-system info + display
 * controls) beside the 3D viewport. File actions live in the native menu
 * (File ▸ Open… / Load Example / Close System), not an in-window toolbar.
 */
export default function App() {
  const [systems, setSystems] = useState<MolecularSystem[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [options, setOptions] = useState<RenderOptions>(DEFAULT_RENDER_OPTIONS)
  const [error, setError] = useState<string | null>(null)

  const active = systems.find((s) => s.id === activeId) ?? null

  function addSystem(structure: MolecularSystem['structure'], name: string, fileType: string): void {
    const system: MolecularSystem = { id: nextSystemId(), name, fileType, structure }
    setSystems((prev) => [...prev, system])
    setActiveId(system.id)
  }

  async function handleOpen(): Promise<void> {
    setError(null)
    try {
      const file = await window.ffe.openStructure()
      if (!file) return
      const { structure, fileType } = parseStructureFile(file.text, file.name)
      addSystem(structure, file.name, fileType)
    } catch (e) {
      setError(messageOf(e))
    }
  }

  function handleExample(): void {
    setError(null)
    try {
      const { structure, fileType } = parseStructureFile(ethanolSample, 'ethanol.xyz')
      addSystem(structure, 'ethanol.xyz (example)', fileType)
    } catch (e) {
      setError(messageOf(e))
    }
  }

  function closeSystem(id: string): void {
    setSystems((prev) => prev.filter((s) => s.id !== id))
    setActiveId((current) => {
      if (current !== id) return current
      const remaining = systems.filter((s) => s.id !== id)
      return remaining.length ? remaining[remaining.length - 1].id : null
    })
  }

  // Route native-menu actions to handlers. A ref keeps the subscription stable
  // while always calling the latest closures (avoids stale state).
  const menuHandlerRef = useRef<(action: string) => void>(() => {})
  menuHandlerRef.current = (action: string): void => {
    if (action === 'open') void handleOpen()
    else if (action === 'loadExample') handleExample()
    else if (action === 'close' && activeId) closeSystem(activeId)
  }
  useEffect(() => {
    return window.ffe?.onMenu((action) => menuHandlerRef.current(action))
  }, [])

  // Under the headless screenshot harness, load the example automatically (once).
  const autoLoadedRef = useRef(false)
  useEffect(() => {
    if (window.ffe?.captureMode && !autoLoadedRef.current) {
      autoLoadedRef.current = true
      handleExample()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-brand">Force Field Explorer</div>

        <section className="panel">
          <h2>Systems</h2>
          {systems.length === 0 ? (
            <p className="placeholder">
              No systems loaded. Use <b>File ▸ Open…</b> for a Tinker <code>.xyz</code> file, or
              <b> File ▸ Load Example</b>.
            </p>
          ) : (
            <ul className="system-list">
              {systems.map((s) => (
                <li
                  key={s.id}
                  className={s.id === activeId ? 'system active' : 'system'}
                  onClick={() => setActiveId(s.id)}
                >
                  <span className="system-name" title={s.name}>
                    {s.name}
                  </span>
                  <span className="system-meta">{s.structure.atoms.length} atoms</span>
                  <button
                    className="system-close"
                    title="Close system"
                    onClick={(e) => {
                      e.stopPropagation()
                      closeSystem(s.id)
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error && <p className="error">{error}</p>}
        </section>

        {active && (
          <section className="panel">
            <h2>Active System</h2>
            <dl className="info">
              <dt>Name</dt>
              <dd>{active.name}</dd>
              {active.structure.title && (
                <>
                  <dt>Title</dt>
                  <dd>{active.structure.title}</dd>
                </>
              )}
              <dt>Format</dt>
              <dd>{active.fileType.toUpperCase()}</dd>
              <dt>Atoms</dt>
              <dd>{active.structure.atoms.length}</dd>
              <dt>Bonds</dt>
              <dd>{active.structure.bonds.length}</dd>
              {active.structure.box && (
                <>
                  <dt>Periodic box</dt>
                  <dd>{active.structure.box.slice(0, 3).map((n) => n.toFixed(2)).join(' × ')} Å</dd>
                </>
              )}
            </dl>
          </section>
        )}

        <section className="panel">
          <h2>Display</h2>
          <SegmentedControl<Representation>
            label="Representation"
            options={REPRESENTATIONS}
            value={options.representation}
            onChange={(representation) => setOptions((o) => ({ ...o, representation }))}
          />
          <SegmentedControl<ColorMode>
            label="Color"
            options={COLOR_MODES}
            value={options.colorMode}
            onChange={(colorMode) => setOptions((o) => ({ ...o, colorMode }))}
          />
        </section>
      </aside>

      <section className="viewport">
        <Viewer structure={active?.structure ?? null} options={options} />
      </section>
    </div>
  )
}

function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange
}: {
  label: string
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="control">
      <span className="control-label">{label}</span>
      <div className="seg">
        {options.map((opt) => (
          <button
            key={opt.value}
            className={opt.value === value ? 'seg-btn active' : 'seg-btn'}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
