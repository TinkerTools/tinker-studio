import { useState } from 'react'
import { Viewer } from './viewer/Viewer'
import { parseTinkerXyz } from './core/parseXyz'
import type { Structure } from './core/types'
import ethanolSample from './samples/ethanol.xyz?raw'

/**
 * Root layout shell: a toolbar, a system-info sidebar, the 3D viewport, and a
 * status bar. Loading flows through here — open a file via the main process or
 * load the bundled example — and the parsed Structure is handed to the Viewer.
 */
export default function App() {
  const [structure, setStructure] = useState<Structure | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
        </aside>

        <section className="viewport">
          <Viewer structure={structure} />
        </section>
      </main>

      <footer className="statusbar">
        <span>{structure ? `${structure.atoms.length} atoms · ${structure.bonds.length} bonds` : 'Ready'}</span>
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

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
