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

const PLAYBACK_FPS = 15

/**
 * Root layout: a sidebar (loaded systems, active-system info, display controls,
 * and trajectory playback) beside the 3D viewport. File actions live in the
 * native menu (File ▸ Open… / Load Example / Close System).
 */
export default function App() {
  const [systems, setSystems] = useState<MolecularSystem[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [options, setOptions] = useState<RenderOptions>(DEFAULT_RENDER_OPTIONS)
  const [error, setError] = useState<string | null>(null)
  const [frameIndex, setFrameIndex] = useState(0)
  const [playing, setPlaying] = useState(false)

  const active = systems.find((s) => s.id === activeId) ?? null
  const trajectory = active?.trajectory ?? null
  const frameCount = trajectory?.frames.length ?? 0
  const frameCoords = trajectory
    ? trajectory.frames[Math.min(frameIndex, frameCount - 1)] ?? null
    : null

  type Parsed = ReturnType<typeof parseStructureFile>

  function addSystem(parsed: Parsed, name: string): void {
    const system: MolecularSystem = {
      id: nextSystemId(),
      name,
      fileType: parsed.fileType,
      structure: parsed.structure,
      trajectory: parsed.trajectory
    }
    setSystems((prev) => [...prev, system])
    setActiveId(system.id)
  }

  async function handleOpen(): Promise<void> {
    setError(null)
    try {
      const file = await window.ffe.openStructure()
      if (!file) return
      addSystem(parseStructureFile(file.text, file.name), file.name)
    } catch (e) {
      setError(messageOf(e))
    }
  }

  function handleExample(): void {
    setError(null)
    try {
      addSystem(parseStructureFile(ethanolSample, 'ethanol.xyz'), 'ethanol.xyz (example)')
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

  // Route native-menu actions to handlers via a ref (stable subscription, fresh closures).
  const menuHandlerRef = useRef<(action: string) => void>(() => {})
  menuHandlerRef.current = (action: string): void => {
    if (action === 'open') void handleOpen()
    else if (action === 'loadExample') handleExample()
    else if (action === 'close' && activeId) closeSystem(activeId)
  }
  useEffect(() => {
    return window.ffe?.onMenu((action) => menuHandlerRef.current(action))
  }, [])

  // Reset playback when the active system changes.
  useEffect(() => {
    setFrameIndex(0)
    setPlaying(false)
  }, [activeId])

  // Trajectory playback loop.
  useEffect(() => {
    if (!playing || frameCount === 0) return
    const id = window.setInterval(() => {
      setFrameIndex((f) => (f + 1) % frameCount)
    }, 1000 / PLAYBACK_FPS)
    return () => window.clearInterval(id)
  }, [playing, frameCount])

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
              No systems loaded. Use <b>File ▸ Open…</b> for a Tinker <code>.xyz</code>/
              <code>.arc</code>, a <code>.pdb</code>, or a <code>.int</code> file — or
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
              {frameCount > 0 && (
                <>
                  <dt>Frames</dt>
                  <dd>{frameCount}</dd>
                </>
              )}
            </dl>
          </section>
        )}

        {trajectory && (
          <section className="panel">
            <h2>Trajectory</h2>
            <div className="traj-counter">
              Frame {frameIndex + 1} / {frameCount}
            </div>
            <input
              className="traj-slider"
              type="range"
              min={0}
              max={frameCount - 1}
              value={Math.min(frameIndex, frameCount - 1)}
              onChange={(e) => {
                setPlaying(false)
                setFrameIndex(Number(e.target.value))
              }}
            />
            <div className="traj-buttons">
              <button className="seg-btn" title="First frame" onClick={() => { setPlaying(false); setFrameIndex(0) }}>
                ⏮
              </button>
              <button
                className="seg-btn"
                title="Step back"
                onClick={() => { setPlaying(false); setFrameIndex((f) => (f - 1 + frameCount) % frameCount) }}
              >
                ◀
              </button>
              <button className="seg-btn" title={playing ? 'Pause' : 'Play'} onClick={() => setPlaying((p) => !p)}>
                {playing ? '⏸' : '▶'}
              </button>
              <button
                className="seg-btn"
                title="Step forward"
                onClick={() => { setPlaying(false); setFrameIndex((f) => (f + 1) % frameCount) }}
              >
                ▶▏
              </button>
            </div>
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
        <Viewer structure={active?.structure ?? null} options={options} frameCoords={frameCoords} />
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
