import { useEffect, useMemo, useRef, useState } from 'react'
import { Viewer } from './viewer/Viewer'
import type { Renderable, PickResult } from './viewer/scene'
import { distance, angle, dihedral } from './core/measure'
import { expandSelection, type PickLevel } from './core/select'
import { atomicMass } from './core/elements'
import {
  parseStructureFile,
  nextSystemId,
  mergeStructures,
  type MolecularSystem,
  type Trajectory
} from './core/system'
import { parseTinkerXyz, parseTinkerArc } from './core/parseXyz'
import { parsePdb } from './core/parsePdb'
import { parseSdf } from './core/parseSdf'
import { SAVE_FORMATS, type SaveFormat } from './core/writers'
import { parsePrm, applyForceField } from './core/parsePrm'
import {
  applyTransform,
  bakeTransform,
  IDENTITY_TRANSFORM,
  isIdentityTransform,
  type Transform
} from './core/transform'
import { AtomBrowser } from './AtomBrowser'
import { CommandsModal } from './CommandsModal'
import { JobsModal } from './JobsModal'
import { KeywordsModal } from './KeywordsModal'
import { liveKind, type JobRecord, type LiveKind } from './core/job'
import {
  DEFAULT_RENDER_OPTIONS,
  REPRESENTATIONS,
  COLOR_MODES,
  FOV_MIN,
  FOV_MAX,
  type RenderOptions,
  type Representation,
  type ColorMode
} from './viewer/renderOptions'
import ethanolSample from './samples/ethanol.xyz?raw'

/**
 * Root layout: a sidebar (systems, active-system info + atom browser, trajectory
 * playback, display controls, selection & measure) beside the 3D viewport.
 * Multiple systems can be shown at once and merged; file/Tinker actions live in
 * the native menu.
 */
export default function App() {
  const [systems, setSystems] = useState<MolecularSystem[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set())
  const [options, setOptions] = useState<RenderOptions>(DEFAULT_RENDER_OPTIONS)
  const [error, setError] = useState<string | null>(null)
  const [frameIndex, setFrameIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [oscillate, setOscillate] = useState(false)
  const [speed, setSpeed] = useState(15)
  const [skip, setSkip] = useState(1)
  const playDirRef = useRef(1)
  const [downloadSource, setDownloadSource] = useState<DownloadSource | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [measureMode, setMeasureMode] = useState<MeasureMode>('inspect')
  const [pickLevel, setPickLevel] = useState<PickLevel>('atom')
  const [picks, setPicks] = useState<PickResult[]>([])
  const [modal, setModal] = useState<'commands' | 'keywords' | 'jobs' | null>(null)
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [atomsOpen, setAtomsOpen] = useState(false)
  const [keyEditTarget, setKeyEditTarget] = useState<string | null>(null)
  const [tinkerDir, setTinkerDir] = useState<string | undefined>(undefined)
  const [keyText, setKeyText] = useState('')
  const [moveMode, setMoveMode] = useState(false)
  const [moveTransform, setMoveTransform] = useState<'translate' | 'rotate'>('translate')

  const active = systems.find((s) => s.id === activeId) ?? null
  const trajectory = active?.trajectory ?? null
  const frameCount = trajectory?.frameCount ?? 0
  const visibleSystems = systems.filter((s) => visibleIds.has(s.id))
  const mergeable = visibleSystems.filter((s) => !s.trajectory)
  const need = MEASURE_NEED[measureMode]

  type Parsed = ReturnType<typeof parseStructureFile>

  function addSystem(
    parsed: Parsed,
    name: string,
    opts: {
      path?: string
      ffName?: string
      keyName?: string
      keyText?: string
      select?: boolean
    } = {}
  ): void {
    const { path, ffName, keyName, keyText, select = true } = opts
    const system: MolecularSystem = {
      id: nextSystemId(),
      name,
      fileType: parsed.fileType,
      structure: parsed.structure,
      trajectory: parsed.trajectory,
      path,
      ffName,
      keyName,
      keyText
    }
    setSystems((prev) => [...prev, system])
    // A selected system becomes active and visible; an unselected one (e.g. a
    // finished job's result) is just added to the list for the user to reveal.
    if (select) {
      setActiveId(system.id)
      setVisibleIds((prev) => new Set(prev).add(system.id))
    }
  }

  function renameSystem(id: string, name: string): void {
    const trimmed = name.trim()
    if (!trimmed) return
    setSystems((prev) => prev.map((s) => (s.id === id ? { ...s, name: trimmed } : s)))
  }

  function beginRename(s: MolecularSystem): void {
    setEditingId(s.id)
    setEditingName(s.name)
  }

  function commitRename(): void {
    if (editingId) renameSystem(editingId, editingName)
    setEditingId(null)
  }

  async function handleOpen(): Promise<void> {
    setError(null)
    try {
      const file = await window.ffe.openStructure()
      if (!file) return
      // .arc files are opened lazily: index on disk, fetch frames on demand.
      if (file.arc) {
        // First frame shows immediately; the frame count + full scrubbing unlock
        // when the background index finishes (trajectory:ready).
        const t = await window.ffe.trajectory.open(file.path)
        const structure = parseTinkerXyz(t.firstFrameText)
        addSystem(
          {
            structure,
            fileType: 'arc',
            trajectory: {
              frameCount: 0,
              source: { trajId: t.trajId },
              indexing: true,
              estimate: t.estimate
            }
          },
          file.name,
          { path: file.path }
        )
        return
      }
      const parsed = parseStructureFile(file.text, file.name)
      const key = { keyName: file.keyName, keyText: file.keyText }
      // Auto-apply the force field found via a sibling .key's PARAMETERS line.
      if (file.prmText) {
        const structure = applyForceField(parsed.structure, parsePrm(file.prmText))
        addSystem({ ...parsed, structure }, file.name, {
          path: file.path,
          ffName: file.prmName,
          ...key
        })
      } else {
        addSystem(parsed, file.name, { path: file.path, ...key })
      }
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
    // Release any streamed-trajectory index held in the main process.
    const trajId = systems.find((s) => s.id === id)?.trajectory?.source?.trajId
    if (trajId) void window.ffe.trajectory.close(trajId)
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
    // Bake each system's placement into its coordinates before concatenating, so
    // the merged structure preserves the relative configuration on screen.
    const structure = mergeStructures(mergeable.map((s) => bakeTransform(s.structure, s.transform)))
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

  function handleSave(format: SaveFormat): void {
    if (!active) return
    const spec = SAVE_FORMATS.find((s) => s.id === format) ?? SAVE_FORMATS[0]
    const base = active.name.replace(/\s*\(.*\)$/, '').replace(/\.[^./\\]*$/, '') || 'structure'
    const structure = bakeTransform(active.structure, active.transform)
    void window.ffe.saveTextFile(`${base}.${spec.ext}`, spec.write(structure))
  }

  async function handleOpenKey(): Promise<void> {
    setError(null)
    try {
      const file = await window.ffe.openTextFile(KEY_FILE_FILTERS)
      if (!file) return
      setKeyText(file.text)
      setModal('keywords')
    } catch (e) {
      setError(messageOf(e))
    }
  }

  async function handleApplyFF(): Promise<void> {
    if (!active) return
    setError(null)
    try {
      const file = await window.ffe.openTextFile()
      if (!file) return
      const newStructure = applyForceField(active.structure, parsePrm(file.text))
      setSystems((prev) =>
        prev.map((s) =>
          s.id === active.id
            ? { ...s, structure: newStructure, rev: (s.rev ?? 0) + 1, ffName: file.name }
            : s
        )
      )
    } catch (e) {
      setError(messageOf(e))
    }
  }

  // When a job finishes successfully, load the coordinate file Tinker produced
  // as a new, deselected system (kept in a ref so the once-mounted job
  // subscription always calls the latest closure).
  const jobsRef = useRef<JobRecord[]>([])
  jobsRef.current = jobs
  const onJobFinishedRef = useRef<(jobId: string) => void>(() => {})
  onJobFinishedRef.current = async (jobId: string): Promise<void> => {
    const job = jobsRef.current.find((j) => j.id === jobId)
    if (!job?.structurePath) return
    try {
      const result = await window.ffe.job.collectResult(job.structurePath, job.startedAt)
      if (!result) return
      addSystem(parseStructureFile(result.text, result.name), `${job.program} · ${result.name}`, {
        path: result.path,
        select: false
      })
    } catch (e) {
      setError(messageOf(e))
    }
  }

  // Live simulation streaming. While a watched job runs, frames are appended to a
  // dedicated "(live)" system that follows the latest frame; liveRef remembers
  // what to restore when it finishes.
  interface LiveState {
    jobId: string
    systemId: string
    kind: LiveKind
    prevActiveId: string | null
    prevVisibleIds: Set<string>
    frameCount: number
  }
  const liveRef = useRef<LiveState | null>(null)
  const liveJobIdsRef = useRef<Set<string>>(new Set())

  // Lazily-fetched frames for streamed (large) trajectories, keyed "trajId:index".
  // frameTick bumps to re-render when a requested frame arrives.
  const frameCacheRef = useRef<Map<string, Float32Array>>(new Map())
  const [frameTick, setFrameTick] = useState(0)

  // The coordinates for a trajectory frame: in-memory directly, or from the lazy
  // cache (null until the streamed frame has been fetched).
  function frameAt(traj: Trajectory | null | undefined, index: number): Float32Array | null {
    if (!traj) return null
    if (traj.frames) return traj.frames[Math.min(index, traj.frames.length - 1)] ?? null
    if (traj.source) return frameCacheRef.current.get(`${traj.source.trajId}:${index}`) ?? null
    return null
  }

  function coordsOf(atoms: ReadonlyArray<{ x: number; y: number; z: number }>): Float32Array {
    const c = new Float32Array(atoms.length * 3)
    atoms.forEach((a, i) => {
      c[i * 3] = a.x
      c[i * 3 + 1] = a.y
      c[i * 3 + 2] = a.z
    })
    return c
  }

  function setSystemKey(id: string, keyName: string | undefined, keyText: string): void {
    setSystems((prev) => prev.map((s) => (s.id === id ? { ...s, keyName, keyText } : s)))
  }

  // Pick a .key file from disk and attach it to the active system.
  async function handleAttachKey(): Promise<void> {
    if (!active) return
    setError(null)
    try {
      const file = await window.ffe.openTextFile(KEY_FILE_FILTERS)
      if (!file) return
      setSystemKey(active.id, file.name, file.text)
    } catch (e) {
      setError(messageOf(e))
    }
  }

  // Open the keyword editor seeded with the active system's key; on attach it
  // writes the edited text back to that system.
  function handleEditKey(): void {
    if (!active) return
    setKeyText(active.keyText ?? '')
    setKeyEditTarget(active.id)
    setModal('keywords')
  }

  // Tinker jobs are owned here (not in the Commands modal) so their output is
  // retained after the modal closes and can be reviewed in the Job Output window.
  useEffect(() => {
    const offOut = window.ffe.job.onOutput((o) =>
      setJobs((prev) =>
        prev.map((j) => (j.id === o.jobId ? { ...j, output: j.output + o.chunk } : j))
      )
    )
    const offExit = window.ffe.job.onExit((e) => {
      setJobs((prev) =>
        prev.map((j) =>
          j.id === e.jobId
            ? {
                ...j,
                status: e.error ? 'failed' : 'exited',
                exitCode: e.code,
                output:
                  j.output +
                  `\n[exited${e.code != null ? ` code ${e.code}` : ''}${e.error ? `: ${e.error}` : ''}]\n`
              }
            : j
        )
      )
      // A clean exit of a non-live job loads its result file as a system; live
      // jobs already built the result as their streamed (live) system.
      if (!e.error && e.code === 0 && !liveJobIdsRef.current.has(e.jobId)) {
        onJobFinishedRef.current(e.jobId)
      }
    })

    // Live-frame stream: append a new frame (minimize) or replace from the full
    // .arc (dynamics), and follow the latest frame.
    const offLive = window.ffe.job.onLive((m) => {
      const live = liveRef.current
      if (!live || live.jobId !== m.jobId) return
      if (m.mode === 'replace') {
        const { structure, frames } = parseTinkerArc(m.text)
        if (frames.length === 0) return
        live.frameCount = frames.length
        setSystems((prev) =>
          prev.map((s) =>
            s.id === live.systemId
              ? { ...s, structure, trajectory: { frameCount: frames.length, frames }, rev: (s.rev ?? 0) + 1 }
              : s
          )
        )
        setFrameIndex(frames.length - 1)
      } else {
        const struct = parseTinkerXyz(m.text)
        const coords = coordsOf(struct.atoms)
        const isFirst = live.frameCount === 0
        live.frameCount += 1
        setSystems((prev) =>
          prev.map((s) => {
            if (s.id !== live.systemId) return s
            const frames = [...(s.trajectory?.frames ?? []), coords]
            return {
              ...s,
              structure: isFirst ? struct : s.structure,
              trajectory: { frameCount: frames.length, frames },
              // Only the first frame establishes topology (needs a rebuild); later
              // frames just move atoms, handled in place via coordKey/updateSystem.
              rev: isFirst ? (s.rev ?? 0) + 1 : s.rev
            }
          })
        )
        setFrameIndex(live.frameCount - 1)
      }
    })

    const offLiveEnd = window.ffe.job.onLiveEnd((m) => {
      const live = liveRef.current
      if (!live || live.jobId !== m.jobId) return
      setSystems((prev) =>
        prev.map((s) => (s.id === live.systemId ? { ...s, name: s.name.replace(/ \(live\)$/, '') } : s))
      )
      // Dynamics: hide the trajectory and return to the original system. Minimize:
      // leave the result trajectory open and active for review.
      if (live.kind === 'dynamics') {
        setVisibleIds(new Set(live.prevVisibleIds))
        if (live.prevActiveId) setActiveId(live.prevActiveId)
      }
      liveRef.current = null
    })

    return () => {
      offOut()
      offExit()
      offLive()
      offLiveEnd()
    }
  }, [])

  // Launch a Tinker program and register it as a retained job. Returns the job id
  // so the launcher can reflect live status from the shared job list. When `watch`
  // is on and the program supports it, a live trajectory system is created and the
  // simulation animates into it.
  async function startJob(
    program: string,
    system: MolecularSystem,
    stdin: string,
    watch: boolean
  ): Promise<string> {
    const id = `job-${Date.now()}`
    setJobs((prev) => [
      ...prev,
      {
        id,
        program,
        systemName: system.name,
        structurePath: system.path,
        startedAt: Date.now(),
        status: 'running',
        output: ''
      }
    ])

    const kind = watch ? liveKind(program) : null
    if (kind) {
      const liveId = nextSystemId()
      const liveSystem: MolecularSystem = {
        id: liveId,
        name: `${program} · ${system.name} (live)`,
        fileType: kind === 'dynamics' ? 'arc' : system.fileType,
        structure: system.structure,
        trajectory: { frameCount: 0, frames: [] }
      }
      setSystems((prev) => [...prev, liveSystem])
      setActiveId(liveId)
      setVisibleIds(new Set([liveId]))
      liveRef.current = {
        jobId: id,
        systemId: liveId,
        kind,
        prevActiveId: activeId,
        prevVisibleIds: new Set(visibleIds),
        frameCount: 0
      }
      liveJobIdsRef.current.add(id)
    }

    const res = await window.ffe.job.run({
      jobId: id,
      program,
      structurePath: system.path!,
      stdin,
      watch: kind,
      keyText: system.keyText
    })
    setJobs((prev) =>
      prev.map((j) => {
        if (j.id !== id) return j
        if (!res.ok) {
          return { ...j, status: 'failed', output: `Failed to start: ${res.error ?? 'unknown error'}\n` }
        }
        return res.commandLine
          ? { ...j, commandLine: res.commandLine, output: `$ ${res.commandLine}\n` + j.output }
          : j
      })
    )
    return id
  }

  function clearJob(id: string): void {
    setJobs((prev) => prev.filter((j) => j.id !== id))
  }

  // Representation/color from the Display panel apply to the current selection;
  // with nothing selected they become the global default (and clear per-atom
  // overrides, so everything reverts). 'tube' is whole-structure only.
  function applyRepresentation(rep: Representation): void {
    if (active && rep !== 'tube' && selectedInActive.size > 0) {
      setSystems((prev) =>
        prev.map((s) => {
          if (s.id !== active.id) return s
          const repByAtom = { ...(s.repByAtom ?? {}) }
          for (const i of selectedInActive) repByAtom[i] = rep
          return { ...s, repByAtom, rev: (s.rev ?? 0) + 1 }
        })
      )
    } else {
      setOptions((o) => ({ ...o, representation: rep }))
      if (active) {
        setSystems((prev) =>
          prev.map((s) => (s.id === active.id ? { ...s, repByAtom: undefined, rev: (s.rev ?? 0) + 1 } : s))
        )
      }
    }
  }

  function applyColorMode(mode: ColorMode): void {
    if (active && selectedInActive.size > 0) {
      setSystems((prev) =>
        prev.map((s) => {
          if (s.id !== active.id) return s
          const colorByAtom = { ...(s.colorByAtom ?? {}) }
          for (const i of selectedInActive) colorByAtom[i] = mode
          return { ...s, colorByAtom, rev: (s.rev ?? 0) + 1 }
        })
      )
    } else {
      setOptions((o) => ({ ...o, colorMode: mode }))
      if (active) {
        setSystems((prev) =>
          prev.map((s) => (s.id === active.id ? { ...s, colorByAtom: undefined, rev: (s.rev ?? 0) + 1 } : s))
        )
      }
    }
  }

  // Translate the active system so its center of mass sits at the origin
  // (keeping any current rotation).
  function centerActiveSystem(): void {
    if (!active) return
    const atoms = active.structure.atoms
    if (atoms.length === 0) return
    let mx = 0
    let my = 0
    let mz = 0
    let total = 0
    for (const a of atoms) {
      const m = atomicMass(a.element)
      mx += a.x * m
      my += a.y * m
      mz += a.z * m
      total += m
    }
    const com: [number, number, number] = [mx / total, my / total, mz / total]
    const q = active.transform?.quaternion ?? IDENTITY_TRANSFORM.quaternion
    // position = -R(com): puts the rotated COM at the origin.
    const r = applyTransform(com, { position: [0, 0, 0], quaternion: q })
    setSystemTransform(active.id, {
      position: [-r[0], -r[1], -r[2]],
      quaternion: [q[0], q[1], q[2], q[3]]
    })
  }

  // The displayed position of a picked atom — tracks the current trajectory frame
  // for the active animating system, then applies that system's rigid-body
  // placement, so highlights/measurements follow both animation and moves.
  function livePosition(p: PickResult): [number, number, number] {
    const sys = systems.find((s) => s.id === p.systemId)
    let base: [number, number, number]
    const c = sys?.trajectory && p.systemId === active?.id ? frameAt(sys.trajectory, frameIndex) : null
    if (c) {
      base = [c[p.atomIndex * 3], c[p.atomIndex * 3 + 1], c[p.atomIndex * 3 + 2]]
    } else {
      base = p.position
    }
    return sys?.transform ? applyTransform(base, sys.transform) : base
  }

  // Persist a gizmo drag (or a button nudge) into the system's transform.
  function setSystemTransform(systemId: string, transform: Transform): void {
    setSystems((prev) => prev.map((s) => (s.id === systemId ? { ...s, transform } : s)))
  }

  function resetActiveTransform(): void {
    if (active) setSystemTransform(active.id, { ...IDENTITY_TRANSFORM })
  }

  function makePick(sys: MolecularSystem, i: number): PickResult {
    const a = sys.structure.atoms[i]
    return { systemId: sys.id, atomIndex: i, name: a.name, element: a.element, position: [a.x, a.y, a.z] }
  }

  // Selection: a click selects the picked atom expanded to the current pick level
  // (atom/residue/molecule/system); ⌘/Ctrl-click toggles that group; clicking
  // empty space clears. Works from the 3D view and the atom list.
  function selectGroup(systemId: string, atomIndex: number, additive: boolean): void {
    const sys = systems.find((s) => s.id === systemId)
    if (!sys) return
    const indices = expandSelection(sys.structure, atomIndex, pickLevel)
    setPicks((prev) => {
      if (!additive) return indices.map((i) => makePick(sys, i))
      const allSelected = indices.every((i) =>
        prev.some((p) => p.systemId === systemId && p.atomIndex === i)
      )
      if (allSelected) {
        const remove = new Set(indices)
        return prev.filter((p) => !(p.systemId === systemId && remove.has(p.atomIndex)))
      }
      const present = new Set(prev.filter((p) => p.systemId === systemId).map((p) => p.atomIndex))
      return [...prev, ...indices.filter((i) => !present.has(i)).map((i) => makePick(sys, i))]
    })
  }

  function applySelection(result: PickResult | null, additive: boolean): void {
    if (!result) {
      if (!additive) setPicks([])
      return
    }
    selectGroup(result.systemId, result.atomIndex, additive)
  }

  function pickFromList(atomIndex: number, additive: boolean): void {
    if (active) selectGroup(active.id, atomIndex, additive)
  }

  function selectAllAtoms(): void {
    if (active) setPicks(active.structure.atoms.map((_, i) => makePick(active, i)))
  }

  const selectedInActive = useMemo(() => {
    const set = new Set<number>()
    if (active) for (const p of picks) if (p.systemId === active.id) set.add(p.atomIndex)
    return set
  }, [picks, active])

  const highlights = useMemo(
    () =>
      picks.map((p) => ({
        position: livePosition(p),
        label: options.showLabels ? `${p.name}${p.atomIndex + 1}` : undefined
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [picks, activeId, frameIndex, frameCount, frameTick, options.showLabels]
  )

  const renderables: Renderable[] = visibleSystems.map((s) => ({
    id: s.id,
    structure: s.structure,
    coords: s.id === activeId && s.trajectory ? frameAt(s.trajectory, frameIndex) : null,
    selected: s.id === activeId ? selectedInActive : undefined,
    transform: s.transform,
    repByAtom: s.repByAtom,
    colorByAtom: s.colorByAtom
  }))

  const transformSig = (t?: Transform): string =>
    isIdentityTransform(t) ? '' : [...t!.position, ...t!.quaternion].map((v) => v.toFixed(4)).join(' ')

  // sceneKey triggers a full rebuild (membership / representation / color /
  // visibility / selection). Frame and transform changes are NOT here — they go
  // through coordKey, which updates the merged mesh in place (cheap).
  const sceneKey = [
    visibleSystems.map((s) => s.id).join(','),
    visibleSystems.map((s) => s.rev ?? 0).join(','),
    activeId ?? '',
    options.representation,
    options.colorMode,
    options.showHydrogens ? 'h' : '',
    options.restrictToSelection ? 'r' : '',
    options.restrictToSelection ? [...selectedInActive].sort((a, b) => a - b).join(',') : ''
  ].join('|')

  // The active system's coordinates (trajectory frame) + transform, applied in
  // place when they change.
  const activeCoords = active?.trajectory ? frameAt(active.trajectory, frameIndex) : null
  const liveUpdate = active
    ? { systemId: active.id, coords: activeCoords, transform: active.transform }
    : null
  const coordKey = `${activeId ?? ''}|${frameIndex}|${frameTick}|${transformSig(active?.transform)}`

  let measureResult: string | null = null
  if (picks.length > 0) {
    const pos = picks.map(livePosition)
    if (measureMode === 'inspect') {
      const p = picks[picks.length - 1]
      measureResult = `${p.name}${p.atomIndex + 1}: ${p.element} · (${pos[pos.length - 1]
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
    else if (action === 'jobs') setModal('jobs')
    else if (action === 'keywords') {
      setKeyText('')
      setModal('keywords')
    } else if (action.startsWith('save:')) handleSave(action.slice(5) as SaveFormat)
    else if (action === 'openKey') void handleOpenKey()
    else if (action === 'applyFF') void handleApplyFF()
    else if (action === 'setTinkerDir') {
      void window.ffe.settings.chooseTinkerDir().then((s) => setTinkerDir(s.tinkerDir))
    }
  }
  useEffect(() => {
    return window.ffe?.onMenu((action) => menuHandlerRef.current(action))
  }, [])

  useEffect(() => {
    void window.ffe?.settings.get().then((s) => setTinkerDir(s.tinkerDir))
  }, [])

  // As a streamed trajectory's background index grows, raise the scrubbable frame
  // count (so the already-indexed prefix is usable); on the final update mark it
  // done, or drop the trajectory if it turned out to have only one frame.
  useEffect(() => {
    return window.ffe?.trajectory.onProgress(({ trajId, frameCount, done }) => {
      setSystems((prev) =>
        prev.map((s) => {
          if (s.trajectory?.source?.trajId !== trajId) return s
          if (done && frameCount <= 1) {
            void window.ffe.trajectory.close(trajId)
            return { ...s, trajectory: undefined }
          }
          return { ...s, trajectory: { ...s.trajectory, frameCount, indexing: !done } }
        })
      )
    })
  }, [])

  // Only PDB-derived systems carry the residue/chain data PDB needs, so gate
  // the "Save as PDB" menu item on the active system's format.
  useEffect(() => {
    window.ffe?.setPdbExportEnabled(active?.fileType === 'pdb')
  }, [active?.fileType])

  // Reset playback and selection when the active system changes.
  useEffect(() => {
    setFrameIndex(0)
    setPlaying(false)
    setPicks([])
  }, [activeId])

  // Trajectory playback loop (honors oscillate / speed / skip).
  useEffect(() => {
    if (!playing || frameCount === 0) return
    const step = Math.max(1, skip)
    const id = window.setInterval(() => {
      setFrameIndex((f) => {
        let next = f + playDirRef.current * step
        if (oscillate) {
          if (next >= frameCount - 1) {
            next = frameCount - 1
            playDirRef.current = -1
          } else if (next <= 0) {
            next = 0
            playDirRef.current = 1
          }
        } else {
          next = ((next % frameCount) + frameCount) % frameCount
        }
        return next
      })
    }, 1000 / Math.max(1, speed))
    return () => window.clearInterval(id)
  }, [playing, frameCount, oscillate, speed, skip])

  // For a streamed (lazy) trajectory, fetch the current frame and a few ahead,
  // caching them with a simple size cap so huge archives never load whole.
  useEffect(() => {
    const traj = active?.trajectory
    if (!traj?.source) return
    const trajId = traj.source.trajId
    const cache = frameCacheRef.current
    const PREFETCH = 5
    const CACHE_CAP = 1000
    const want: number[] = []
    for (let d = 0; d <= PREFETCH; d++) {
      const idx = frameIndex + d
      if (idx < traj.frameCount && !cache.has(`${trajId}:${idx}`)) want.push(idx)
    }
    if (want.length === 0) return
    let cancelled = false
    void (async () => {
      let added = false
      for (const idx of want) {
        const coords = await window.ffe.trajectory.frame(trajId, idx)
        if (cancelled || !coords) continue
        cache.set(`${trajId}:${idx}`, coords)
        added = true
        while (cache.size > CACHE_CAP) {
          const oldest = cache.keys().next().value
          if (oldest === undefined) break
          cache.delete(oldest)
        }
      }
      if (!cancelled && added) setFrameTick((t) => t + 1)
    })()
    return () => {
      cancelled = true
    }
  }, [active?.id, active?.trajectory, frameIndex])

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
                    {editingId === s.id ? (
                      <input
                        className="system-rename"
                        autoFocus
                        value={editingName}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setEditingName(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename()
                          else if (e.key === 'Escape') setEditingId(null)
                        }}
                      />
                    ) : (
                      <span
                        className="system-name"
                        title={`${s.name} — double-click to rename`}
                        onDoubleClick={(e) => {
                          e.stopPropagation()
                          beginRename(s)
                        }}
                      >
                        {s.name}
                      </span>
                    )}
                    <span className="system-meta">{s.structure.atoms.length}</span>
                    <button
                      className="system-rename-btn"
                      title="Rename system"
                      onClick={(e) => {
                        e.stopPropagation()
                        beginRename(s)
                      }}
                    >
                      ✎
                    </button>
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
              {active.ffName && (
                <>
                  <dt>Force field</dt>
                  <dd>{active.ffName}</dd>
                </>
              )}
              {trajectory?.indexing ? (
                <>
                  <dt>Frames</dt>
                  <dd>~{trajectory.estimate} (indexing…)</dd>
                </>
              ) : (
                frameCount > 1 && (
                  <>
                    <dt>Frames</dt>
                    <dd>{frameCount}</dd>
                  </>
                )
              )}
            </dl>
            {active.fileType !== 'arc' && active.fileType !== 'pdb' && (
              <div className="key-row">
                <span className="key-row-label">Key file</span>
                <span className={active.keyName ? 'key-row-name' : 'key-row-name none'}>
                  {active.keyName ?? '(none)'}
                </span>
                <div className="key-row-actions">
                  <button className="mini-btn" onClick={() => void handleAttachKey()}>
                    Attach…
                  </button>
                  <button className="mini-btn" onClick={handleEditKey}>
                    Edit…
                  </button>
                </div>
              </div>
            )}
            <details
              className="atoms-disclosure"
              open={atomsOpen}
              onToggle={(e) => setAtomsOpen(e.currentTarget.open)}
            >
              <summary>Atoms ({active.structure.atoms.length})</summary>
              {/* Render the (potentially large) list only while expanded, so changing
                  the active system / live frames don't pay for it when collapsed. */}
              {atomsOpen && (
                <AtomBrowser system={active} selected={selectedInActive} onPick={pickFromList} />
              )}
            </details>
          </section>
        )}

        {trajectory?.indexing && frameCount <= 1 && (
          <section className="panel">
            <h2>Trajectory</h2>
            <div className="traj-counter">Indexing… (showing first frame)</div>
          </section>
        )}

        {trajectory && frameCount > 1 && (
          <section className="panel">
            <h2>Trajectory</h2>
            <div className="traj-counter">
              Frame {frameIndex + 1} / {frameCount}
              {trajectory.indexing && (
                <span className="traj-indexing"> · indexing… (~{trajectory.estimate})</span>
              )}
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
            <div className="traj-opts">
              <label className="traj-opt">
                <input type="checkbox" checked={oscillate} onChange={(e) => setOscillate(e.target.checked)} />
                Oscillate
              </label>
              <label className="traj-opt">
                Speed
                <input type="number" min={1} max={60} value={speed} onChange={(e) => setSpeed(Number(e.target.value) || 1)} />
              </label>
              <label className="traj-opt">
                Skip
                <input type="number" min={1} value={skip} onChange={(e) => setSkip(Number(e.target.value) || 1)} />
              </label>
            </div>
          </section>
        )}

        {active && (
          <section className="panel">
            <details className="atoms-disclosure">
              <summary>Selection &amp; Measure</summary>
              <SegmentedControl<PickLevel>
                label="Pick level"
                options={PICK_LEVELS}
                value={pickLevel}
                onChange={setPickLevel}
              />
              <div className="sel-actions">
                <button className="mini-btn" onClick={selectAllAtoms}>
                  Select all
                </button>
                <button className="mini-btn" onClick={() => setPicks([])} disabled={picks.length === 0}>
                  Clear
                </button>
              </div>
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
                    {picks.slice(0, 12).map((p, i) => (
                      <span key={i} className="pick-chip">
                        {p.name}
                        {p.atomIndex + 1}
                      </span>
                    ))}
                    {picks.length > 12 && <span className="pick-chip">+{picks.length - 12}</span>}
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
            </details>
          </section>
        )}

        <section className="panel">
          <details className="atoms-disclosure">
            <summary>Display</summary>
            <SegmentedControl<Representation>
              label="Representation"
              options={REPRESENTATIONS}
              value={options.representation}
              onChange={applyRepresentation}
            />
            <SegmentedControl<ColorMode>
              label="Color"
              options={COLOR_MODES}
              value={options.colorMode}
              onChange={applyColorMode}
            />
            <p className="display-hint">
              {selectedInActive.size > 0
                ? `Applies to ${selectedInActive.size} selected atom${selectedInActive.size > 1 ? 's' : ''}.`
                : 'Applies to all atoms (select atoms first to target a subset).'}
            </p>
            <div className="display-toggles">
              <label>
                <input
                  type="checkbox"
                  checked={options.showHydrogens}
                  onChange={(e) => setOptions((o) => ({ ...o, showHydrogens: e.target.checked }))}
                />
                Hydrogens
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={options.showLabels}
                  onChange={(e) => setOptions((o) => ({ ...o, showLabels: e.target.checked }))}
                />
                Labels
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={options.restrictToSelection}
                  onChange={(e) => setOptions((o) => ({ ...o, restrictToSelection: e.target.checked }))}
                />
                Only selection
              </label>
            </div>
            <div className="control">
              <span className="control-label">Perspective</span>
              <div className="perspective-row">
                <span className="perspective-end" title="Wide angle — camera close">
                  ◗
                </span>
                <input
                  className="perspective-slider"
                  type="range"
                  min={FOV_MIN}
                  max={FOV_MAX}
                  // Left = wide angle (large FOV); invert so the slider reads
                  // near-to-far left-to-right.
                  value={FOV_MIN + FOV_MAX - options.fov}
                  onChange={(e) =>
                    setOptions((o) => ({ ...o, fov: FOV_MIN + FOV_MAX - Number(e.target.value) }))
                  }
                />
                <span className="perspective-end" title="Telephoto — camera far">
                  ◓
                </span>
              </div>
            </div>
          </details>
        </section>

        {active && (
          <section className="panel">
            <details
              className="atoms-disclosure"
              onToggle={(e) => {
                if (!e.currentTarget.open) setMoveMode(false)
              }}
            >
              <summary>Move System</summary>
              <label className="move-toggle">
                <input
                  type="checkbox"
                  checked={moveMode}
                  onChange={(e) => setMoveMode(e.target.checked)}
                />
                Move <b>{active.name}</b> independently
              </label>
              {moveMode && (
                <>
                  <SegmentedControl<'translate' | 'rotate'>
                    label="Gizmo"
                    options={MOVE_MODES}
                    value={moveTransform}
                    onChange={setMoveTransform}
                  />
                  <p className="move-hint">
                    Drag the {moveTransform === 'translate' ? 'arrows' : 'rings'} to{' '}
                    {moveTransform} this system; drag empty space to orbit the camera. Picking is
                    paused while moving. Merge or Save bakes the placement into the coordinates.
                  </p>
                  <button
                    className="mini-btn"
                    onClick={resetActiveTransform}
                    disabled={isIdentityTransform(active.transform)}
                  >
                    Reset placement
                  </button>
                </>
              )}
              <div className="move-center">
                <button className="mini-btn" onClick={centerActiveSystem}>
                  Center (move center of mass to origin)
                </button>
              </div>
            </details>
          </section>
        )}
      </aside>

      <section className="viewport">
        <Viewer
          renderables={renderables}
          options={options}
          sceneKey={sceneKey}
          pickingEnabled={active != null && !moveMode}
          highlights={highlights}
          onPick={applySelection}
          manipulation={moveMode && active ? { systemId: active.id, mode: moveTransform } : null}
          onTransform={setSystemTransform}
          liveUpdate={liveUpdate}
          coordKey={coordKey}
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
        <CommandsModal
          system={active}
          tinkerDir={tinkerDir}
          jobs={jobs}
          onRunJob={startJob}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'jobs' && (
        <JobsModal
          jobs={jobs}
          onCancel={(id) => void window.ffe.job.cancel(id)}
          onClear={clearJob}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'keywords' && (
        <KeywordsModal
          initialText={keyText}
          attachLabel={keyEditTarget ? 'Attach to system' : undefined}
          onAttach={
            keyEditTarget
              ? (text) => {
                  const sys = systems.find((s) => s.id === keyEditTarget)
                  setSystemKey(keyEditTarget, sys?.keyName ?? 'tinker.key', text)
                  setKeyEditTarget(null)
                  setModal(null)
                }
              : undefined
          }
          onClose={() => {
            setKeyEditTarget(null)
            setModal(null)
          }}
        />
      )}
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

const KEY_FILE_FILTERS = [{ name: 'Tinker Key Files', extensions: ['key'] }]

const MOVE_MODES: ReadonlyArray<{ value: 'translate' | 'rotate'; label: string }> = [
  { value: 'translate', label: 'Translate' },
  { value: 'rotate', label: 'Rotate' }
]

const PICK_LEVELS: ReadonlyArray<{ value: PickLevel; label: string }> = [
  { value: 'atom', label: 'Atom' },
  { value: 'residue', label: 'Residue' },
  { value: 'molecule', label: 'Molecule' },
  { value: 'system', label: 'System' }
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
