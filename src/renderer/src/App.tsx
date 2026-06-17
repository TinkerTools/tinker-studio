import { useEffect, useMemo, useRef, useState } from 'react'
import { Viewer } from './viewer/Viewer'
import type { Renderable, PickResult } from './viewer/scene'
import { distance, angle, dihedral } from './core/measure'
import {
  parseStructureFile,
  nextSystemId,
  mergeStructures,
  type MolecularSystem
} from './core/system'
import { parsePdb } from './core/parsePdb'
import { parseSdf } from './core/parseSdf'
import { AtomBrowser } from './AtomBrowser'
import { CommandsModal } from './CommandsModal'
import { KeywordsModal } from './KeywordsModal'
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
 * Root layout: a sidebar (systems, active-system info, display controls,
 * trajectory playback) beside the 3D viewport. Multiple systems can be shown at
 * once (per-system visibility) and merged into one. File actions live in the
 * native menu.
 */
export default function App() {
  const [systems, setSystems] = useState<MolecularSystem[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set())
  const [options, setOptions] = useState<RenderOptions>(DEFAULT_RENDER_OPTIONS)
  const [error, setError] = useState<string | null>(null)
  const [frameIndex, setFrameIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [downloadSource, setDownloadSource] = useState<DownloadSource | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [measureMode, setMeasureMode] = useState<MeasureMode>('inspect')
  const [picks, setPicks] = useState<PickResult[]>([])
  const [modal, setModal] = useState<'commands' | 'keywords' | null>(null)
  const [tinkerDir, setTinkerDir] = useState<string | undefined>(undefined)

  const active = systems.find((s) => s.id === activeId) ?? null
  const trajectory = active?.trajectory ?? null
  const frameCount = trajectory?.frames.length ?? 0

  const visibleSystems = systems.filter((s) => visibleIds.has(s.id))
  const mergeable = visibleSystems.filter((s) => !s.trajectory)

  const renderables: Renderable[] = visibleSystems.map((s) => ({
    id: s.id,
    structure: s.structure,
    coords:
      s.id === activeId && s.trajectory
        ? s.trajectory.frames[Math.min(frameIndex, s.trajectory.frames.length - 1)] ?? null
        : null
  }))

  const sceneKey = [
    visibleSystems.map((s) => s.id).join(','),
    activeId ?? '',
    frameIndex,
    options.representation,
    options.colorMode
  ].join('|')

  type Parsed = ReturnType<typeof parseStructureFile>

  function addSystem(parsed: Parsed, name: string, path?: string): void {
    const system: MolecularSystem = {
      id: nextSystemId(),
      name,
      fileType: parsed.fileType,
      structure: parsed.structure,
      trajectory: parsed.trajectory,
      path
    }
    setSystems((prev) => [...prev, system])
    setActiveId(system.id)
    setVisibleIds((prev) => new Set(prev).add(system.id))
  }

  async function handleOpen(): Promise<void> {
    setError(null)
    try {
      const file = await window.ffe.openStructure()
      if (!file) return
      addSystem(parseStructureFile(file.text, file.name), file.name, file.path)
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

  async function runDownload(source: DownloadSource, query: string): Promise<void> {
    setError(null)
    setDownloading(true)
    try {
      const result = await window.ffe.download(source, query)
      const structure = result.format === 'pdb' ? parsePdb(result.text) : parseSdf(result.text)
      addSystem({ structure, fileType: result.format }, `${result.name} (${source})`)
      setDownloadSource(null)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setDownloading(false)
    }
  }

  function closeSystem(id: string): void {
    setSystems((prev) => prev.filter((s) => s.id !== id))
    setVisibleIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    setActiveId((current) => {
      if (current !== id) return current
      const remaining = systems.filter((s) => s.id !== id)
      return remaining.length ? remaining[remaining.length - 1].id : null
    })
  }

  function toggleVisible(id: string): void {
    setVisibleIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function mergeVisible(): void {
    if (mergeable.length < 2) return
    const structure = mergeStructures(mergeable.map((s) => s.structure))
    const merged: MolecularSystem = {
      id: nextSystemId(),
      name: `merged (${mergeable.length} systems)`,
      fileType: 'merged',
      structure
    }
    setSystems((prev) => [...prev, merged])
    setActiveId(merged.id)
    setVisibleIds(new Set([merged.id]))
  }

  // Selection: a plain click selects one atom, ⌘/Ctrl-click toggles an atom into
  // a multi-atom selection, and clicking empty space clears it. Works from both
  // the 3D view and the atom list.
  const need = MEASURE_NEED[measureMode]

  function applySelection(result: PickResult | null, additive: boolean): void {
    if (!result) {
      if (!additive) setPicks([]) // click away to deselect
      return
    }
    setPicks((prev) => {
      const i = prev.findIndex(
        (p) => p.systemId === result.systemId && p.atomIndex === result.atomIndex
      )
      if (additive) return i >= 0 ? prev.filter((_, k) => k !== i) : [...prev, result]
      return [result]
    })
  }

  function pickFromList(atomIndex: number, additive: boolean): void {
    if (!active) return
    const a = active.structure.atoms[atomIndex]
    const coords = active.trajectory
      ? active.trajectory.frames[Math.min(frameIndex, frameCount - 1)]
      : null
    const position: [number, number, number] = coords
      ? [coords[atomIndex * 3], coords[atomIndex * 3 + 1], coords[atomIndex * 3 + 2]]
      : [a.x, a.y, a.z]
    applySelection(
      { systemId: active.id, atomIndex, name: a.name, element: a.element, position },
      additive
    )
  }

  const highlights = useMemo(() => picks.map((p) => p.position), [picks])

  // Atom indices selected within the active system (to mark them in the browser).
  const selectedInActive = useMemo(() => {
    const set = new Set<number>()
    if (active) for (const p of picks) if (p.systemId === active.id) set.add(p.atomIndex)
    return set
  }, [picks, active])

  let measureResult: string | null = null
  if (picks.length > 0) {
    const pos = picks.map((p) => p.position)
    if (measureMode === 'inspect') {
      const p = picks[picks.length - 1]
      measureResult = `${p.name}${p.atomIndex + 1}: ${p.element} · (${p.position
        .map((v) => v.toFixed(2))
        .join(', ')})`
    } else if (measureMode === 'distance' && picks.length === 2) {
      measureResult = `${distance(pos[0], pos[1]).toFixed(3)} Å`
    } else if (measureMode === 'angle' && picks.length === 3) {
      measureResult = `${angle(pos[0], pos[1], pos[2]).toFixed(2)}°`
    } else if (measureMode === 'dihedral' && picks.length === 4) {
      measureResult = `${dihedral(pos[0], pos[1], pos[2], pos[3]).toFixed(2)}°`
    }
  }

  // Route native-menu actions to handlers via a ref (stable subscription, fresh closures).
  const menuHandlerRef = useRef<(action: string) => void>(() => {})
  menuHandlerRef.current = (action: string): void => {
    if (action === 'open') void handleOpen()
    else if (action === 'loadExample') handleExample()
    else if (action === 'close' && activeId) closeSystem(activeId)
    else if (action === 'download:pubchem') setDownloadSource('pubchem')
    else if (action === 'download:nci') setDownloadSource('nci')
    else if (action === 'download:pdb') setDownloadSource('pdb')
    else if (action === 'commands') setModal('commands')
    else if (action === 'keywords') setModal('keywords')
    else if (action === 'setTinkerDir') {
      void window.ffe.settings.chooseTinkerDir().then((s) => setTinkerDir(s.tinkerDir))
    }
  }
  useEffect(() => {
    return window.ffe?.onMenu((action) => menuHandlerRef.current(action))
  }, [])

  // Load the persisted Tinker directory on startup.
  useEffect(() => {
    void window.ffe?.settings.get().then((s) => setTinkerDir(s.tinkerDir))
  }, [])

  // Reset playback and selection when the active system changes.
  useEffect(() => {
    setFrameIndex(0)
    setPlaying(false)
    setPicks([])
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
            <>
              <ul className="system-list">
                {systems.map((s) => (
                  <li
                    key={s.id}
                    className={s.id === activeId ? 'system active' : 'system'}
                    onClick={() => setActiveId(s.id)}
                  >
                    <button
                      className={visibleIds.has(s.id) ? 'vis on' : 'vis'}
                      title={visibleIds.has(s.id) ? 'Hide' : 'Show'}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleVisible(s.id)
                      }}
                    />
                    <span className="system-name" title={s.name}>
                      {s.name}
                    </span>
                    <span className="system-meta">{s.structure.atoms.length}</span>
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
              {mergeable.length >= 2 && (
                <button className="merge-btn" onClick={mergeVisible}>
                  Merge {mergeable.length} visible systems
                </button>
              )}
            </>
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
            <details className="atoms-disclosure">
              <summary>Atoms ({active.structure.atoms.length})</summary>
              <AtomBrowser system={active} selected={selectedInActive} onPick={pickFromList} />
            </details>
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

        {active && (
          <section className="panel">
            <h2>Selection &amp; Measure</h2>
            <div className="seg">
              {MEASURE_MODES.map((m) => (
                <button
                  key={m.value}
                  className={m.value === measureMode ? 'seg-btn active' : 'seg-btn'}
                  onClick={() => setMeasureMode(m.value)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div className="measure-info">
              {picks.length === 0 ? (
                <span className="measure-hint">
                  Click an atom; ⌘-click to add more, click empty space to clear.
                </span>
              ) : (
                <div className="pick-chips">
                  {picks.map((p, i) => (
                    <span key={i} className="pick-chip">
                      {p.name}
                      {p.atomIndex + 1}
                    </span>
                  ))}
                </div>
              )}
              {measureResult ? (
                <div className="measure-result">{measureResult}</div>
              ) : (
                measureMode !== 'inspect' &&
                picks.length > 0 && (
                  <div className="measure-hint">
                    Select {need} atoms for {measureMode} ({picks.length} selected)
                  </div>
                )
              )}
            </div>
          </section>
        )}

      </aside>

      <section className="viewport">
        <Viewer
          renderables={renderables}
          options={options}
          sceneKey={sceneKey}
          pickingEnabled={active != null}
          highlights={highlights}
          onPick={applySelection}
        />
      </section>

      {downloadSource && (
        <DownloadModal
          source={downloadSource}
          busy={downloading}
          onSubmit={(q) => void runDownload(downloadSource, q)}
          onCancel={() => setDownloadSource(null)}
        />
      )}

      {modal === 'commands' && (
        <CommandsModal system={active} tinkerDir={tinkerDir} onClose={() => setModal(null)} />
      )}
      {modal === 'keywords' && <KeywordsModal onClose={() => setModal(null)} />}
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

type MeasureMode = 'inspect' | 'distance' | 'angle' | 'dihedral'

const MEASURE_NEED: Record<MeasureMode, number> = {
  inspect: 1,
  distance: 2,
  angle: 3,
  dihedral: 4
}

const MEASURE_MODES: ReadonlyArray<{ value: MeasureMode; label: string }> = [
  { value: 'inspect', label: 'Inspect' },
  { value: 'distance', label: 'Distance' },
  { value: 'angle', label: 'Angle' },
  { value: 'dihedral', label: 'Dihedral' }
]

type DownloadSource = 'pubchem' | 'nci' | 'pdb'

const DOWNLOAD_LABELS: Record<DownloadSource, { name: string; prompt: string }> = {
  pubchem: { name: 'PubChem', prompt: 'Molecule name (e.g. aspirin)' },
  nci: { name: 'NCI', prompt: 'Molecule name or SMILES (e.g. caffeine)' },
  pdb: { name: 'RCSB PDB', prompt: '4-character PDB ID (e.g. 1CRN)' }
}

function DownloadModal({
  source,
  busy,
  onSubmit,
  onCancel
}: {
  source: DownloadSource
  busy: boolean
  onSubmit: (query: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState('')
  const { name, prompt } = DOWNLOAD_LABELS[source]
  const submit = (): void => {
    if (value.trim()) onSubmit(value.trim())
  }
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Download from {name}</h3>
        <input
          autoFocus
          className="modal-input"
          placeholder={prompt}
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            else if (e.key === 'Escape') onCancel()
          }}
        />
        <div className="modal-buttons">
          <button className="modal-btn ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="modal-btn primary" onClick={submit} disabled={busy || !value.trim()}>
            {busy ? 'Downloading…' : 'Download'}
          </button>
        </div>
      </div>
    </div>
  )
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
