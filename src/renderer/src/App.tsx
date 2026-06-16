import { useEffect, useState } from 'react'
import { Viewer } from './viewer/Viewer'
import { parseTinkerXyz } from './core/parseXyz'
import type { Structure } from './core/types'
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
 * Root layout shell: a toolbar, a sidebar (system info + display controls), the
 * 3D viewport, and a status bar. Loading flows through here; the parsed
 * Structure and the current RenderOptions are handed to the Viewer.
 */
export default function App() {
  const [structure, setStructure] = useState<Structure | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [options, setOptions] = useState<RenderOptions>(DEFAULT_RENDER_OPTIONS)

  // Under the headless screenshot harness, load the example automatically.
  useEffect(() => {
    if (window.ffe?.captureMode) handleExample()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleOpen(): Promise<void> {
    setError(null)
    try {
      const file = await window.ffe.openStructure()
      if (!file) return
      setStructure(parseTinkerXyz(file.text))
      setFileName(file.name)
    } catch (e) {
      setError(messageOf(e))
    }
  }

  function handleExample(): void {
    setError(null)
    try {
      setStructure(parseTinkerXyz(ethanolSample))
      setFileName('ethanol.xyz (example)')
    } catch (e) {
      setError(messageOf(e))
    }
  }

  const v = window.ffe?.versions

  return (
    <div className="app">
      <header className="titlebar">
        <span className="brand">Force Field Explorer</span>
        <span className="subtitle">molecular modeling for Tinker</span>
        <span className="spacer" />
        <button className="btn" onClick={handleOpen}>
          Open…
        </button>
        <button className="btn btn-ghost" onClick={handleExample}>
          Load example
        </button>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <section className="panel">
            <h2>System</h2>
            {structure ? (
              <dl className="info">
                <dt>File</dt>
                <dd>{fileName}</dd>
                {structure.title && (
                  <>
                    <dt>Title</dt>
                    <dd>{structure.title}</dd>
                  </>
                )}
                <dt>Atoms</dt>
                <dd>{structure.atoms.length}</dd>
                <dt>Bonds</dt>
                <dd>{structure.bonds.length}</dd>
                {structure.box && (
                  <>
                    <dt>Periodic box</dt>
                    <dd>{structure.box.slice(0, 3).map((n) => n.toFixed(2)).join(' × ')} Å</dd>
                  </>
                )}
              </dl>
            ) : (
              <p className="placeholder">
                No structure loaded. Use <b>Open…</b> to read a Tinker <code>.xyz</code> file, or
                <b> Load example</b> to view bundled ethanol.
              </p>
            )}
            {error && <p className="error">{error}</p>}
          </section>

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
          <Viewer structure={structure} options={options} />
        </section>
      </main>

      <footer className="statusbar">
        <span>
          {structure
            ? `${structure.atoms.length} atoms · ${structure.bonds.length} bonds`
            : 'Ready'}
        </span>
        <span className="spacer" />
        {v && (
          <span className="versions">
            Electron {v.electron} · Chromium {v.chrome} · Node {v.node}
          </span>
        )}
      </footer>
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
