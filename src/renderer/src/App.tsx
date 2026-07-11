import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { Viewer, type ViewerInputs } from './viewer/Viewer'
import { FrameWindow, LOCAL_SOURCE, REMOTE_SOURCE } from './core/frameWindow'
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
import { parseTinkerXyz } from './core/parseXyz'
import { parsePdb } from './core/parsePdb'
import { parseSdf } from './core/parseSdf'
import { SAVE_FORMATS, writePdb, type SaveFormat } from './core/writers'
import { writeTinkerXyz } from './core/writeXyz'
import { isUntyped, withBasicTypes } from './core/basicTypes'
import { parsePrm, applyForceField } from './core/parsePrm'
import {
  applyTransform,
  bakeTransform,
  IDENTITY_TRANSFORM,
  isIdentityTransform,
  type Transform
} from './core/transform'
import { AtomBrowser } from './AtomBrowser'
import { BuilderView } from './BuilderView'
import type { SubmitRemote } from './CommandsModal'
import { KeywordsModal } from './KeywordsModal'
import { ClustersModal } from './ClustersModal'
import { RemoteOpenModal } from './RemoteOpenModal'
import { liveKind, type JobRecord, type LiveKind } from './core/job'
import type { ClusterProfile, RemoteJobRecord } from '../../main/remote/types'

// Payloads forwarded from the detached windows, derived from the ambient
// window.tinker type (importing the preload source would break the renderer's
// composite tsconfig).
type JobsAction = Parameters<Window['tinker']['jobsWindow']['sendAction']>[0]
type CommandsRunReq = Parameters<Window['tinker']['commandsWindow']['run']>[0]
import {
  DEFAULT_RENDER_OPTIONS,
  REPRESENTATIONS,
  COLOR_MODES,
  FOV_MIN,
  FOV_MAX,
  DEFAULT_BACKGROUND,
  CONTRAST_DEFAULT,
  GLOSSINESS_DEFAULT,
  HIGHLIGHT_COLOR_DEFAULT,
  LABEL_COLOR_DEFAULT,
  type RenderOptions,
  type Representation,
  type ColorMode
} from './viewer/renderOptions'
// The shape returned by openStructure / openSample (typed through window.tinker,
// so we don't import across the preload project boundary).
type OpenedFile = NonNullable<Awaited<ReturnType<Window['tinker']['openStructure']>>>

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
  // Mirror of frameIndex for the playback timer to read without a stale closure.
  const frameIndexRef = useRef(0)
  const [downloadSource, setDownloadSource] = useState<DownloadSource | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [measureMode, setMeasureMode] = useState<MeasureMode>('inspect')
  const [pickLevel, setPickLevel] = useState<PickLevel>('atom')
  const [picks, setPicks] = useState<PickResult[]>([])
  const [modal, setModal] = useState<
    'keywords' | 'graphics' | 'clusters' | 'remoteOpen' | null
  >(null)
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [clusters, setClusters] = useState<ClusterProfile[]>([])
  const [pwPrompt, setPwPrompt] = useState<{ clusterId: string; clusterName: string } | null>(null)
  const pwResolveRef = useRef<((ok: boolean) => void) | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [atomsOpen, setAtomsOpen] = useState(false)
  const [keyEditTarget, setKeyEditTarget] = useState<string | null>(null)
  const [tinkerDir, setTinkerDir] = useState<string | undefined>(undefined)
  const [keyText, setKeyText] = useState('')
  const [moveMode, setMoveMode] = useState(false)
  const [moveTransform, setMoveTransform] = useState<'translate' | 'rotate'>('translate')
  const [builderOpen, setBuilderOpen] = useState(false)

  const active = systems.find((s) => s.id === activeId) ?? null
  const trajectory = active?.trajectory ?? null
  const frameCount = trajectory?.frameCount ?? 0
  // Latest active system, read inside async callbacks without a stale closure.
  const activeRef = useRef(active)
  activeRef.current = active
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
      seqName?: string
      seqText?: string
      select?: boolean
    } = {}
  ): string {
    const { path, ffName, keyName, keyText, seqName, seqText, select = true } = opts
    const system: MolecularSystem = {
      id: nextSystemId(),
      name,
      fileType: parsed.fileType,
      structure: parsed.structure,
      trajectory: parsed.trajectory,
      path,
      ffName,
      keyName,
      keyText,
      seqName,
      seqText
    }
    setSystems((prev) => [...prev, system])
    // A selected system becomes active and visible; an unselected one (e.g. a
    // finished job's result) is just added to the list for the user to reveal.
    if (select) {
      setActiveId(system.id)
      setVisibleIds((prev) => new Set(prev).add(system.id))
    }
    return system.id
  }

  // Attach a .dcd trajectory to a system. It only attaches if the .dcd parses and
  // its atom count matches the structure; otherwise it's left off (silently for an
  // auto-detected sibling, with an error for an explicit attach).
  async function attachDcd(
    systemId: string,
    structure: Parsed['structure'],
    dcdPath: string,
    opts: { silent?: boolean } = {}
  ): Promise<void> {
    const prevTrajId = systems.find((s) => s.id === systemId)?.trajectory?.source?.trajId
    const res = await window.tinker.trajectory.openDcd(dcdPath, structure.atoms.length)
    if (!res.ok) {
      if (!opts.silent) setError(`Could not attach DCD — ${res.reason ?? 'unknown error'}.`)
      return
    }
    if (prevTrajId) void window.tinker.trajectory.close(prevTrajId)
    setSystems((prev) =>
      prev.map((s) =>
        s.id === systemId
          ? {
              ...s,
              dcdName: res.name,
              trajectory: { frameCount: res.frameCount!, source: { trajId: res.trajId! } }
            }
          : s
      )
    )
    setFrameIndex(0)
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

  // Add a system from an opened file (dialog) or a bundled example (same shape):
  // stream a .arc lazily, otherwise parse the text and auto-apply any sibling force
  // field / attach sibling .key / .seq / .dcd. `label` overrides the system's display
  // name (e.g. "… (example)"); the real `file.name` is kept for format detection so
  // its extension isn't mangled.
  async function loadOpenedFile(file: OpenedFile, label?: string): Promise<void> {
    const displayName = label ?? file.name
    // .arc files are opened lazily: index on disk, fetch frames on demand.
    if (file.arc) {
      // First frame shows immediately; the frame count + full scrubbing unlock
      // when the background index finishes (trajectory:ready).
      const t = await window.tinker.trajectory.open(file.path)
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
        displayName,
        { path: file.path }
      )
      return
    }
    const parsed = parseStructureFile(file.text, file.name)
    // Auto-pick-up sibling .key and .seq files.
    const meta = {
      keyName: file.keyName,
      keyText: file.keyText,
      seqName: file.seqName,
      seqText: file.seqText
    }
    // Auto-apply the force field found via a sibling .key's PARAMETERS line.
    let id: string
    if (file.prmText) {
      const structure = applyForceField(parsed.structure, parsePrm(file.prmText))
      id = addSystem({ ...parsed, structure }, displayName, {
        path: file.path,
        ffName: file.prmName,
        ...meta
      })
    } else {
      id = addSystem(parsed, displayName, { path: file.path, ...meta })
    }
    // Auto-attach a sibling .dcd trajectory if one lines up with this structure.
    if (file.dcdPath) void attachDcd(id, parsed.structure, file.dcdPath, { silent: true })
  }

  async function handleOpen(): Promise<void> {
    setError(null)
    try {
      const file = await window.tinker.openStructure()
      if (file) await loadOpenedFile(file)
    } catch (e) {
      setError(messageOf(e))
    }
  }

  // Load a bundled example by filename. Loads exactly like opening that file, so a
  // sibling .key in the samples dir (e.g. ethanol.key → parameters basic.prm) is
  // auto-applied; .arc examples stream lazily like any trajectory.
  async function handleExample(name: string): Promise<void> {
    setError(null)
    try {
      const file = await window.tinker.openSample(name)
      if (!file) {
        setError(`Example "${name}" could not be found.`)
        return
      }
      await loadOpenedFile(file, `${file.name} (example)`)
    } catch (e) {
      setError(messageOf(e))
    }
  }

  async function runDownload(source: DownloadSource, query: string): Promise<void> {
    setError(null)
    setDownloading(true)
    try {
      const result = await window.tinker.download(source, query)
      const structure = result.format === 'pdb' ? parsePdb(result.text) : parseSdf(result.text)
      // Small-molecule sources (PubChem/NCI) get basic.prm atom types (10·Z + attached
      // atoms) and a key pointing at the bundled basic.prm, so they're immediately
      // usable — same treatment as a built molecule. A PDB (protein/nucleic) download
      // is left untyped for the user to apply a real force field.
      if (source === 'pdb') {
        addSystem({ structure, fileType: result.format }, `${result.name} (${source})`)
      } else {
        addSystem(
          { structure: withBasicTypes(structure), fileType: result.format },
          `${result.name} (${source})`,
          { keyName: BASIC_KEY_NAME, keyText: BASIC_KEY }
        )
      }
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
    if (trajId) void window.tinker.trajectory.close(trajId)
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
    // Tinker .xyz of a force-field-less structure: assign basic.prm atom types
    // (10·Z + neighbors) instead of zeros, and drop a sibling .key referencing
    // basic.prm so the file is immediately usable by Tinker.
    if (format === 'txyz' && isUntyped(structure)) {
      const typed = withBasicTypes(structure)
      void window.tinker.saveTinkerXyz(`${base}.xyz`, writeTinkerXyz(typed), true)
      return
    }
    void window.tinker.saveTextFile(`${base}.${spec.ext}`, spec.write(structure))
  }

  async function handleOpenKey(): Promise<void> {
    setError(null)
    try {
      const file = await window.tinker.openTextFile(KEY_FILE_FILTERS)
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
      const file = await window.tinker.openTextFile()
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
    if (!job) return
    try {
      // The calculation's key carries onto whatever structure it produced, so the
      // result (e.g. pdbxyz's .xyz) keeps the same parameters/force field.
      const carry = { keyName: job.resultKeyName, keyText: job.resultKeyText }
      // A converter (pdbxyz/xyzpdb) writes a named result next to its input — load it.
      if (job.loadResult && job.inputPath) {
        const out = await window.tinker.job.collectNamed(job.inputPath, job.loadResult, job.startedAt)
        if (out) {
          addSystem(parseStructureFile(out.text, out.name), `${job.program} · ${out.name}`, {
            path: out.path,
            select: false,
            ...carry
          })
        }
        return
      }
      if (!job.structurePath) return
      const result = await window.tinker.job.collectResult(job.structurePath, job.startedAt)
      if (!result) return
      addSystem(parseStructureFile(result.text, result.name), `${job.program} · ${result.name}`, {
        path: result.path,
        select: false,
        ...carry
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
    /** True when streaming into an existing system (DCD dynamics) vs a new one. */
    attached: boolean
    /** Display name for an attached .dcd, shown once frames start streaming. */
    dcdName?: string
    frameCount: number
  }
  const liveRef = useRef<LiveState | null>(null)
  const liveJobIdsRef = useRef<Set<string>>(new Set())

  // Lazily-fetched frames for streamed (large) trajectories, keyed "trajId:index".
  // frameTick bumps to re-render when a requested frame arrives.
  // Streamed-trajectory frames are served by a forward-biased, byte-budgeted
  // window (one for the active source trajectory) instead of an unbounded cache.
  const frameWindowRef = useRef<FrameWindow | null>(null)
  // Last frame shown for the active system, held while the next frame is still
  // being fetched so a streamed/live trajectory doesn't flicker back to the
  // structure's rest positions between frames.
  const lastFrameCoordsRef = useRef<{ id: string; coords: Float32Array } | null>(null)
  // Heavy scene inputs (structure + coords) handed to the Viewer by ref, never as
  // props — see ViewerInputs. Assigned fresh each render below.
  const viewerInputsRef = useRef<ViewerInputs>({ renderables: [], liveUpdate: null })
  const [frameTick, setFrameTick] = useState(0)

  // The coordinates for a trajectory frame: in-memory directly, or from the lazy
  // cache (null until the streamed frame has been fetched).
  function frameAt(traj: Trajectory | null | undefined, index: number): Float32Array | null {
    if (!traj) return null
    if (traj.frames) return traj.frames[Math.min(index, traj.frames.length - 1)] ?? null
    if (traj.source) {
      const w = frameWindowRef.current
      return w && w.trajId === traj.source.trajId ? w.get(index) : null
    }
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

  function applyFFToSystem(id: string, prmText: string, prmName: string): void {
    setSystems((prev) =>
      prev.map((s) =>
        s.id === id
          ? {
              ...s,
              structure: applyForceField(s.structure, parsePrm(prmText)),
              rev: (s.rev ?? 0) + 1,
              ffName: prmName
            }
          : s
      )
    )
  }

  // Attach a .key, .seq, or .prm to the active system (routed by extension).
  // Attaching a key also pulls in its referenced force field; a .prm applies
  // directly.
  async function handleAttach(): Promise<void> {
    if (!active) return
    setError(null)
    try {
      const chosen = await window.tinker.chooseFile(ATTACH_FILTERS)
      if (!chosen) return
      const ext = (chosen.name.split('.').pop() ?? '').toLowerCase()
      // .dcd is binary and may be huge — hand its path to the trajectory API
      // rather than reading it as text.
      if (ext === 'dcd') {
        await attachDcd(active.id, active.structure, chosen.path)
        return
      }
      const text = await window.tinker.readTextFile(chosen.path)
      if (ext === 'seq') {
        setSystems((prev) =>
          prev.map((s) =>
            s.id === active.id ? { ...s, seqName: chosen.name, seqText: text } : s
          )
        )
      } else if (ext === 'prm') {
        applyFFToSystem(active.id, text, chosen.name)
      } else {
        // .key (default)
        setSystemKey(active.id, chosen.name, text)
        const ff = await window.tinker.resolveForceFieldFromKey(text, chosen.path)
        if (ff.prmText && ff.prmName) applyFFToSystem(active.id, ff.prmText, ff.prmName)
      }
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
    const offOut = window.tinker.job.onOutput((o) =>
      setJobs((prev) =>
        prev.map((j) => (j.id === o.jobId ? { ...j, output: j.output + o.chunk } : j))
      )
    )
    const offExit = window.tinker.job.onExit((e) => {
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

    // Minimize streams discrete cycle files as one-frame appends. The count is
    // bounded (a minimization converges in a modest number of cycles), so these
    // are kept in memory; dynamics instead streams via onLiveArc (disk-backed).
    const offLive = window.tinker.job.onLive((m) => {
      const live = liveRef.current
      if (!live || live.jobId !== m.jobId) return
      {
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

    // Dynamics: the run's growing .arc is indexed on disk in the main process and
    // exposed as a streamed `source` trajectory. We just track the frame count and
    // follow the latest frame; the windowed frame path fetches coordinates from
    // disk on demand (bounded memory), so the whole run stays scrubbable without
    // holding every frame in RAM.
    const offLiveArc = window.tinker.job.onLiveArc(({ jobId, trajId, frameCount }) => {
      const live = liveRef.current
      if (!live || live.jobId !== jobId) return
      live.frameCount = frameCount
      setSystems((prev) =>
        prev.map((s) =>
          s.id === live.systemId
            ? {
                ...s,
                trajectory: { frameCount, source: { trajId } },
                ...(live.attached && live.dcdName ? { dcdName: live.dcdName } : {})
              }
            : s
        )
      )
      setFrameIndex(frameCount - 1)
    })

    const offLiveEnd = window.tinker.job.onLiveEnd((m) => {
      const live = liveRef.current
      if (!live || live.jobId !== m.jobId) return
      // Attached DCD dynamics: the .dcd stays attached to the existing system and
      // remains scrubbable — nothing to rename, hide, or restore.
      if (live.attached) {
        liveRef.current = null
        return
      }
      // Keep the finished result trajectory active and visible (positioned at the
      // last frame); just drop the "(live)" suffix. Don't revert to the original.
      setSystems((prev) =>
        prev.map((s) => (s.id === live.systemId ? { ...s, name: s.name.replace(/ \(live\)$/, '') } : s))
      )
      liveRef.current = null
    })

    return () => {
      offOut()
      offExit()
      offLive()
      offLiveArc()
      offLiveEnd()
    }
  }, [])

  // Launch a Tinker program and register it as a retained job. Returns the job id
  // so the launcher can reflect live status from the shared job list. When `watch`
  // is on and the program supports it, a live trajectory system is created and the
  // simulation animates into it.
  async function startJob(
    program: string,
    system: MolecularSystem | null,
    stdin: string,
    watch: boolean,
    requiresStructure: boolean,
    loadResult?: 'xyz' | 'pdb'
  ): Promise<{ id: string; ok: boolean }> {
    const id = `job-${Date.now()}`
    const sysName = system?.name ?? program
    setJobs((prev) => [
      ...prev,
      {
        id,
        program,
        systemName: sysName,
        structurePath: system?.path,
        startedAt: Date.now(),
        status: 'running',
        output: ''
      }
    ])

    // Resolve the coordinate file and the effective key. Builders (no structure) run
    // with none; a system without a file on disk is written to a scratch file in its
    // NATIVE format (a PDB system → a real .pdb, so pdbxyz gets the file it expects).
    let structurePath = ''
    let effectiveKey: string | null = null
    // The meaningful key to carry onto structures this calculation produces (the
    // attached key or the auto basic.prm key — not a params-less default).
    let carryKeyText: string | undefined
    let carryKeyName: string | undefined
    if (requiresStructure && system) {
      const baked = bakeTransform(system.structure, system.transform)
      const hasOwnParams = !!system.keyText && /^\s*parameters\b/im.test(system.keyText)
      // A PDB system runs only pdbxyz, which needs a real .pdb; every other system
      // runs Tinker-.xyz programs, so it's written as a Tinker .xyz (and can be
      // auto-typed for basic.prm when it's an untyped in-memory molecule).
      const nativePdb = system.fileType === 'pdb'
      const useBasic = isUntyped(baked) && !hasOwnParams && !nativePdb && !system.path
      // The key the run should use: an attached/loaded key wins; else basic.prm for an
      // auto-typed molecule; else a minimal key for a scratch system; else none (a
      // file-backed system falls back to Tinker's on-disk sibling key).
      effectiveKey = system.keyText?.trim()
        ? system.keyText
        : useBasic
          ? BASIC_KEY
          : system.path
            ? null
            : DEFAULT_KEY
      if (system.keyText?.trim()) {
        carryKeyText = system.keyText
        carryKeyName = system.keyName ?? 'tinker.key'
      } else if (useBasic) {
        carryKeyText = BASIC_KEY
        carryKeyName = BASIC_KEY_NAME
      }
      if (system.path) {
        structurePath = system.path
      } else {
        try {
          const [text, ext] = nativePdb
            ? [writePdb(baked), 'pdb']
            : [writeTinkerXyz(useBasic ? withBasicTypes(baked) : baked), 'xyz']
          structurePath = await window.tinker.job.prepareStructure(system.name, ext, text)
        } catch (e) {
          setJobs((prev) =>
            prev.map((j) => (j.id === id ? { ...j, status: 'failed', output: messageOf(e) } : j))
          )
          return { id, ok: false }
        }
      }
    }

    // Record, for onJobFinished: where a converter (pdbxyz/xyzpdb) writes its result,
    // and the key to carry onto any structure this calculation produces.
    if ((loadResult && structurePath) || carryKeyText) {
      setJobs((prev) =>
        prev.map((j) =>
          j.id === id
            ? {
                ...j,
                ...(loadResult && structurePath ? { inputPath: structurePath, loadResult } : {}),
                ...(carryKeyText ? { resultKeyText: carryKeyText, resultKeyName: carryKeyName } : {})
              }
            : j
        )
      )
    }

    const kind = watch && system && structurePath ? liveKind(program) : null
    if (kind && system) {
      // Dynamics with a DCD-ARCHIVE key writes a .dcd — stream it into the SAME
      // system (attach), rather than spawning a separate "(live)" arc system.
      const dcdOutput = kind === 'dynamics' && /^\s*dcd-archive\b/im.test(effectiveKey ?? '')
      if (dcdOutput) {
        const prevTrajId = system.trajectory?.source?.trajId
        if (prevTrajId) void window.tinker.trajectory.close(prevTrajId)
        setActiveId(system.id)
        setVisibleIds((prev) => new Set(prev).add(system.id))
        liveRef.current = {
          jobId: id,
          systemId: system.id,
          kind,
          attached: true,
          dcdName: system.name.replace(/\.[^.]*$/, '') + '.dcd',
          frameCount: 0
        }
      } else {
        const liveId = nextSystemId()
        const liveSystem: MolecularSystem = {
          id: liveId,
          name: `${program} · ${system.name} (live)`,
          fileType: kind === 'dynamics' ? 'arc' : system.fileType,
          structure: system.structure,
          trajectory: { frameCount: 0, frames: [] },
          // Carry the calculation's key onto the resulting trajectory.
          keyName: carryKeyName,
          keyText: carryKeyText
        }
        setSystems((prev) => [...prev, liveSystem])
        setActiveId(liveId)
        setVisibleIds(new Set([liveId]))
        liveRef.current = {
          jobId: id,
          systemId: liveId,
          kind,
          attached: false,
          frameCount: 0
        }
      }
      liveJobIdsRef.current.add(id)
    }

    const res = await window.tinker.job.run({
      jobId: id,
      program,
      structurePath,
      stdin,
      watch: kind,
      keyText: effectiveKey ?? undefined
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
    return { id, ok: res.ok }
  }

  function clearJob(id: string): void {
    setJobs((prev) => prev.filter((j) => j.id !== id))
  }

  // Representation/color from the Display panel apply to the current selection;
  // with nothing selected they become the global default (and clear per-atom
  // overrides, so everything reverts).
  function applyRepresentation(rep: Representation): void {
    if (active && selectedInActive.size > 0) {
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

  // The active system's current-frame coordinates. While a streamed/live frame is
  // still being fetched, frameAt returns null; rather than snap to the structure's
  // rest positions (visible jitter during live dynamics), hold the last frame
  // shown for this system until the new one arrives.
  let activeCoords: Float32Array | null = null
  if (active?.trajectory) {
    const c = frameAt(active.trajectory, frameIndex)
    if (c) {
      activeCoords = c
      lastFrameCoordsRef.current = { id: active.id, coords: c }
    } else if (lastFrameCoordsRef.current?.id === active.id) {
      activeCoords = lastFrameCoordsRef.current.coords
    }
  }

  const renderables: Renderable[] = visibleSystems.map((s) => ({
    id: s.id,
    structure: s.structure,
    coords: s.id === activeId ? activeCoords : null,
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
    options.colorMode === 'uniform' ? options.uniformColor : '',
    options.ballScale,
    options.bondScale,
    options.wireWidth,
    options.showHydrogens ? 'h' : '',
    options.showBox ? 'box' : '',
    options.restrictToSelection ? 'r' : '',
    options.restrictToSelection ? [...selectedInActive].sort((a, b) => a - b).join(',') : ''
  ].join('|')

  // Frame + transform for the active system, applied in place when they change.
  const liveUpdate = active
    ? { systemId: active.id, coords: activeCoords, transform: active.transform }
    : null
  const coordKey = `${activeId ?? ''}|${frameIndex}|${frameTick}|${transformSig(active?.transform)}`
  // Keep the heavy data in the ref so it stays out of React's prop diffing.
  viewerInputsRef.current = { renderables, liveUpdate }

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
    else if (action === 'build') setBuilderOpen(true)
    else if (action.startsWith('loadExample:')) void handleExample(action.slice('loadExample:'.length))
    else if (action === 'close' && activeId) closeSystem(activeId)
    else if (action === 'download:pubchem') setDownloadSource('pubchem')
    else if (action === 'download:nci') setDownloadSource('nci')
    else if (action === 'download:pdb') setDownloadSource('pdb')
    else if (action === 'graphics') setModal('graphics')
    else if (action === 'clusters') setModal('clusters')
    else if (action === 'openRemote') setModal('remoteOpen')
    else if (action === 'keywords') {
      setKeyText('')
      setModal('keywords')
    } else if (action.startsWith('save:')) handleSave(action.slice(5) as SaveFormat)
    else if (action === 'openKey') void handleOpenKey()
    else if (action === 'applyFF') void handleApplyFF()
    else if (action === 'setTinkerDir') {
      void window.tinker.settings.chooseTinkerDir().then((s) => {
        setTinkerDir(s.tinkerDir)
        if (s.tinkerDir && !s.hasExecutables) {
          setError(
            "No Tinker executables found there. Pick the top-level Tinker folder — the one " +
              'containing the "bin" and "params" subfolders, not "bin" itself.'
          )
        } else if (s.tinkerDir) {
          setError(null)
        }
      })
    }
  }
  useEffect(() => {
    return window.tinker?.onMenu((action) => menuHandlerRef.current(action))
  }, [])

  // Actions forwarded from the detached Jobs window run here, since this window
  // owns local job state and the 3D viewer. A ref keeps the subscription stable
  // while the handlers see fresh closures.
  const jobsActionRef = useRef<(a: JobsAction) => void>(() => {})
  jobsActionRef.current = (a: JobsAction): void => {
    if (a.type === 'clear') clearJob(a.id)
    else if (a.type === 'viewLive') void viewRemoteJob(a.job)
    else if (a.type === 'openResult') void openRemoteResult(a.job)
  }
  useEffect(() => {
    return window.tinker?.jobsWindow.onAction((a) => jobsActionRef.current(a))
  }, [])

  // Keep the detached Jobs window's local job list in sync with ours.
  useEffect(() => {
    window.tinker?.jobsWindow.publishLocal(jobs)
  }, [jobs])

  // Launches forwarded from the detached Modeling Commands window run here, since
  // this window owns the active system, launch logic, and viewer. Refs keep the
  // subscriptions stable while the handlers see fresh closures (active, clusters).
  const commandsRunRef = useRef<(req: CommandsRunReq) => void>(() => {})
  commandsRunRef.current = (req: CommandsRunReq): void => {
    void startJob(req.program, active, req.stdin, req.watch, req.requiresStructure, req.loadResult)
  }
  const commandsSubmitRef = useRef<(m: { reqId: number; opts: unknown }) => void>(() => {})
  commandsSubmitRef.current = (m): void => {
    void submitRemote(m.opts as Parameters<SubmitRemote>[0]).then((ok) =>
      window.tinker.commandsWindow.submitResult(m.reqId, ok)
    )
  }
  useEffect(() => {
    const offRun = window.tinker?.commandsWindow.onRun((req) => commandsRunRef.current(req))
    const offSubmit = window.tinker?.commandsWindow.onSubmit((m) => commandsSubmitRef.current(m))
    const offManage = window.tinker?.commandsWindow.onManageClusters(() => setModal('clusters'))
    return () => {
      offRun?.()
      offSubmit?.()
      offManage?.()
    }
  }, [])

  // Publish the context the detached Commands window needs (active-system summary,
  // Tinker dir, clusters) whenever it changes.
  const cmdSystem = active
    ? { name: active.name, fileType: active.fileType, hasKey: Boolean(active.keyText) }
    : null
  useEffect(() => {
    window.tinker?.commandsWindow.publishContext({ system: cmdSystem, tinkerDir, clusters })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmdSystem?.name, cmdSystem?.fileType, cmdSystem?.hasKey, tinkerDir, clusters])

  useEffect(() => {
    void window.tinker?.settings.get().then((s) => setTinkerDir(s.tinkerDir))
  }, [])

  // Load configured clusters and react to remote job updates. The remote job list
  // itself is now owned by the detached Jobs window; here we only need the updates
  // to stop growing a finished live job's streamed trajectory in the viewer.
  useEffect(() => {
    void window.tinker?.remote.listClusters().then(setClusters)
    return window.tinker?.remote.onJobUpdate((job) => {
      // When a live job finishes, stop growing its streamed trajectory (one final
      // refresh still happens on the next tick before the flag clears).
      const terminal =
        job.status === 'completed' || job.status === 'failed' || job.status === 'canceled'
      if (terminal) {
        setSystems((prev) =>
          prev.map((s) =>
            s.trajectory?.source?.jobId === job.id && s.trajectory.source.growing
              ? { ...s, trajectory: { ...s.trajectory, source: { ...s.trajectory.source, growing: false } } }
              : s
          )
        )
      }
    })
  }, [])

  // Grow remote live trajectories: re-index the still-writing remote file and
  // raise the scrubbable frame count until the job that produces it finishes.
  const growingKey = systems
    .filter((s) => s.trajectory?.source?.remote && s.trajectory.source.growing)
    .map((s) => s.trajectory!.source!.trajId)
    .join(',')
  useEffect(() => {
    if (!growingKey) return
    const ids = growingKey.split(',')
    const iv = window.setInterval(() => {
      for (const trajId of ids) {
        void window.tinker.remote.refreshTrajectory(trajId).then((fc) => {
          setSystems((prev) =>
            prev.map((s) =>
              s.trajectory?.source?.trajId === trajId && s.trajectory.frameCount !== fc
                ? { ...s, trajectory: { ...s.trajectory, frameCount: fc } }
                : s
            )
          )
          // Follow the latest frame as it streams in (like local live runs), but
          // only for the active system so a background job doesn't yank the view.
          if (fc > 0 && activeRef.current?.trajectory?.source?.trajId === trajId) {
            frameIndexRef.current = fc - 1
            setFrameIndex(fc - 1)
          }
        })
      }
    }, 5000)
    return () => window.clearInterval(iv)
  }, [growingKey])

  // For a password-auth cluster with no password yet this session, prompt for it
  // (and optionally remember it, encrypted). Resolves true once a password is set,
  // false if the user cancels. Key-auth clusters resolve immediately.
  async function ensurePassword(clusterId: string): Promise<boolean> {
    if (!(await window.tinker.remote.needsPassword(clusterId))) return true
    const cluster = clusters.find((c) => c.id === clusterId)
    return new Promise<boolean>((resolve) => {
      pwResolveRef.current = resolve
      setPwPrompt({ clusterId, clusterName: cluster?.name ?? 'cluster' })
    })
  }

  async function submitPassword(password: string, remember: boolean): Promise<void> {
    const prompt = pwPrompt
    if (prompt) await window.tinker.remote.setPassword(prompt.clusterId, password, remember)
    setPwPrompt(null)
    pwResolveRef.current?.(true)
    pwResolveRef.current = null
  }

  function cancelPassword(): void {
    setPwPrompt(null)
    pwResolveRef.current?.(false)
    pwResolveRef.current = null
  }

  // Submit a Tinker job to a remote cluster. Builds the staged input files from
  // the current system (or references files already on the host), then hands off
  // to the main-process remote manager, which uploads, submits, and polls.
  const submitRemote: SubmitRemote = async (opts) => {
    setError(null)
    const cluster = clusters.find((c) => c.id === opts.clusterId)
    if (!cluster) {
      setError('Unknown cluster.')
      return false
    }
    if (!(await ensurePassword(cluster.id))) return false
    try {
      let req: Parameters<typeof window.tinker.remote.submit>[0]
      if (opts.source === 'remote') {
        // Run on files already present in a remote directory.
        const outputFormat = opts.program === 'dynamic' ? 'arc' : null
        req = {
          clusterId: cluster.id,
          program: opts.program,
          jobName: opts.inputName || opts.program,
          inputName: opts.inputName!,
          remoteInputDir: opts.remoteInputDir,
          remoteKeyPath: opts.remoteKeyPath,
          stdin: opts.stdin,
          variables: opts.variables,
          outputFormat
        }
      } else {
        // Upload the active system's coordinates (+ key) to a fresh job directory.
        const system = active
        if (opts.requiresStructure && !system) {
          setError('Load a system to submit.')
          return false
        }
        const staged = system ? buildRemoteFiles(system, opts.program) : null
        req = {
          clusterId: cluster.id,
          program: opts.program,
          jobName: staged?.stem ?? opts.program,
          inputName: staged?.inputName ?? '',
          files: staged?.files,
          stdin: opts.stdin,
          variables: opts.variables,
          outputFormat: staged?.outputFormat ?? null
        }
      }
      const job = await window.tinker.remote.submit(req)
      // Open the Jobs window pre-selecting this job (onStarted also opens it next).
      window.tinker.jobsWindow.open(job.id)
      return job.status !== 'failed'
    } catch (e) {
      setError(messageOf(e))
      return false
    }
  }

  // Open (or start streaming) a remote job's trajectory output into the viewer.
  async function viewRemoteJob(job: RemoteJobRecord): Promise<void> {
    setError(null)
    if (!(await ensurePassword(job.clusterId))) return
    try {
      const res = await window.tinker.remote.openJobTrajectory(job.id)
      let structure: Parsed['structure']
      if (res.kind === 'arc' && res.firstFrameText) {
        structure = parseTinkerXyz(res.firstFrameText)
      } else {
        // .dcd carries no topology — fetch the input .xyz to get atoms/bonds.
        const input = await window.tinker.remote.openJobText(job.id, job.inputName ?? '')
        structure = parseTinkerXyz(input.text)
      }
      const active = job.status === 'running' || job.status === 'pending' || job.status === 'submitting'
      const id = nextSystemId()
      const system: MolecularSystem = {
        id,
        name: `${job.program} · ${job.clusterName}${active ? ' (live)' : ''}`,
        fileType: res.kind,
        structure,
        trajectory: {
          frameCount: res.frameCount,
          source: { trajId: res.trajId, remote: true, growing: active, jobId: job.id }
        }
      }
      setSystems((prev) => [...prev, system])
      setActiveId(id)
      setVisibleIds(new Set([id]))
      setFrameIndex(0)
      setModal(null)
    } catch (e) {
      setError(messageOf(e))
    }
  }

  // Download a finished job's optimized/result structure and open it locally.
  async function openRemoteResult(job: RemoteJobRecord): Promise<void> {
    setError(null)
    if (!(await ensurePassword(job.clusterId))) return
    try {
      const files = await window.tinker.remote.listJobFiles(job.id)
      const stem = (job.inputName ?? '').replace(/\.[^.]*$/, '')
      // Prefer the highest Tinker cycle file (mol.xyz_N), else a plain result xyz.
      const cycles = files
        .filter((f) => new RegExp(`^${escapeRegExp(stem)}\\.xyz_\\d+$`).test(f))
        .sort((a, b) => Number(b.split('_').pop()) - Number(a.split('_').pop()))
      const pick = cycles[0] ?? (files.includes(`${stem}.xyz`) ? `${stem}.xyz` : job.inputName)
      if (!pick) {
        setError('No result coordinate file found in the job directory.')
        return
      }
      const { name, text } = await window.tinker.remote.openJobText(job.id, pick)
      addSystem(parseStructureFile(text, name), `${name} · ${job.clusterName}`)
      setModal(null)
    } catch (e) {
      setError(messageOf(e))
    }
  }

  // Open an arbitrary remote file: stream a .arc/.dcd, or load a structure text.
  // `vars` carries connection-scoped variable values (e.g. a node number).
  async function openRemotePath(
    clusterId: string,
    path: string,
    vars: Record<string, string> = {}
  ): Promise<void> {
    setError(null)
    const cluster = clusters.find((c) => c.id === clusterId)
    if (!(await ensurePassword(clusterId))) return
    try {
      if (/\.(arc|dcd)$/i.test(path)) {
        const res = await window.tinker.remote.openTrajectory(clusterId, path, vars)
        let structure: Parsed['structure']
        if (res.kind === 'arc' && res.firstFrameText) {
          structure = parseTinkerXyz(res.firstFrameText)
        } else {
          // Need topology for a .dcd: read the sibling .xyz next to it.
          const xyzPath = path.replace(/\.dcd$/i, '.xyz')
          const input = await window.tinker.remote.openText(clusterId, xyzPath, vars)
          structure = parseTinkerXyz(input.text)
        }
        const id = nextSystemId()
        setSystems((prev) => [
          ...prev,
          {
            id,
            name: `${path.split('/').pop()} · ${cluster?.name ?? 'remote'}`,
            fileType: res.kind,
            structure,
            trajectory: { frameCount: res.frameCount, source: { trajId: res.trajId, remote: true } }
          }
        ])
        setActiveId(id)
        setVisibleIds(new Set([id]))
        setFrameIndex(0)
      } else {
        const { name, text } = await window.tinker.remote.openText(clusterId, path, vars)
        addSystem(parseStructureFile(text, name), `${name} · ${cluster?.name ?? 'remote'}`)
      }
      setModal(null)
    } catch (e) {
      setError(messageOf(e))
    }
  }

  // As a streamed trajectory's background index grows, raise the scrubbable frame
  // count (so the already-indexed prefix is usable); on the final update mark it
  // done, or drop the trajectory if it turned out to have only one frame.
  useEffect(() => {
    return window.tinker?.trajectory.onProgress(({ trajId, frameCount, done }) => {
      setSystems((prev) =>
        prev.map((s) => {
          if (s.trajectory?.source?.trajId !== trajId) return s
          if (done && frameCount <= 1) {
            void window.tinker.trajectory.close(trajId)
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
    window.tinker?.setPdbExportEnabled(active?.fileType === 'pdb')
  }, [active?.fileType])

  // Reset playback and selection when the active system changes.
  useEffect(() => {
    setFrameIndex(0)
    setPlaying(false)
    setPicks([])
  }, [activeId])

  // Keep frameIndexRef in step with frameIndex (for the playback timer to read).
  useEffect(() => {
    frameIndexRef.current = frameIndex
  }, [frameIndex])

  // Trajectory playback loop (honors oscillate / speed / skip).
  useEffect(() => {
    if (!playing || frameCount === 0) return
    const step = Math.max(1, skip)
    const advance = (): void => {
      const f = frameIndexRef.current
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
      // For a streamed (disk-windowed) trajectory, don't outrun the fetch: if the
      // next frame isn't loaded yet, keep it (and the read-ahead) fetching and wait
      // for the next tick. Playback then throttles to the achievable rate instead
      // of racing ahead of the window and freezing on a stale frame.
      const w = frameWindowRef.current
      if (w && next !== f && !w.get(next)) {
        w.request(next, frameCount, playDirRef.current)
        return
      }
      frameIndexRef.current = next
      setFrameIndex(next)
    }
    const id = window.setInterval(advance, 1000 / Math.max(1, speed))
    return () => window.clearInterval(id)
  }, [playing, frameCount, oscillate, speed, skip])

  // Build (or rebuild) the frame window when the active source trajectory or its
  // per-frame size changes; dispose it when there's no streamed source.
  useEffect(() => {
    const src = active?.trajectory?.source
    const natoms = active?.structure.atoms.length ?? 0
    if (!src || natoms === 0) {
      frameWindowRef.current?.dispose()
      frameWindowRef.current = null
      return
    }
    if (frameWindowRef.current?.trajId !== src.trajId) {
      frameWindowRef.current?.dispose()
      frameWindowRef.current = new FrameWindow(
        src.trajId,
        natoms * 3 * 4,
        src.remote
          ? (id, idx) => window.tinker.remote.trajFrame(id, idx)
          : (id, idx) => window.tinker.trajectory.frame(id, idx),
        () => setFrameTick((t) => t + 1),
        src.remote ? REMOTE_SOURCE : LOCAL_SOURCE
      )
    }
  }, [active?.id, active?.trajectory?.source?.trajId, active?.structure.atoms.length])

  // Prefetch around the current frame (in the play direction) as it advances.
  useEffect(() => {
    const traj = active?.trajectory
    if (traj?.source) {
      frameWindowRef.current?.request(frameIndex, traj.frameCount, playDirRef.current)
    }
  }, [active?.id, active?.trajectory, frameIndex])

  // Under the headless screenshot harness, load the example automatically (once).
  const autoLoadedRef = useRef(false)
  useEffect(() => {
    if (window.tinker?.captureMode && !autoLoadedRef.current) {
      autoLoadedRef.current = true
      if (window.tinker.captureBuilder) setBuilderOpen(true)
      else void handleExample('ethanol.xyz')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The builder is a separate full-screen mode: blank canvas, its own UI. On Done
  // its molecule arrives here as a normal new system; on Cancel nothing changes.
  if (builderOpen) {
    return (
      <BuilderView
        demo={!!window.tinker?.captureBuilder}
        onDone={(structure) => {
          // A built molecule has no force field, so give it Tinker basic.prm atom
          // types (10·Z + attached atoms) and a sibling .key that points at
          // basic.prm — so the new system is immediately usable with that force
          // field (jobs/saves see its own types + parameters line, not zeros).
          addSystem({ structure: withBasicTypes(structure), fileType: 'xyz' }, 'New molecule', {
            keyName: BASIC_KEY_NAME,
            keyText: BASIC_KEY
          })
          setBuilderOpen(false)
        }}
        onCancel={() => setBuilderOpen(false)}
      />
    )
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-brand">Tinker Studio</div>

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
            {active.fileType !== 'arc' && (
              <div className="files-block">
                <div className="key-row">
                  <span className="key-row-label">Key file</span>
                  <span className={active.keyName ? 'key-row-name' : 'key-row-name none'}>
                    {active.keyName ?? '(none)'}
                  </span>
                  <div className="key-row-actions">
                    <button className="mini-btn" onClick={handleEditKey}>
                      Edit…
                    </button>
                  </div>
                </div>
                {/* Only proteins/nucleic acids built with a sequence carry a .seq;
                    show the row only once one is attached, so it isn't noise. */}
                {active.seqName && (
                  <div className="key-row">
                    <span className="key-row-label">Seq file</span>
                    <span className="key-row-name">{active.seqName}</span>
                  </div>
                )}
                {/* A .dcd trajectory attached to this .xyz unlocks the playback panel. */}
                {active.dcdName && (
                  <div className="key-row">
                    <span className="key-row-label">DCD file</span>
                    <span className="key-row-name">{active.dcdName}</span>
                  </div>
                )}
                {/* Attach applies to any supplementary file, not just the key —
                    give it its own line so that's clear. */}
                <button
                  className="mini-btn attach-file-btn"
                  onClick={() => void handleAttach()}
                  title="Attach a Tinker .key, .seq, .prm, or .dcd trajectory to this system"
                >
                  Attach file… (.key / .seq / .prm / .dcd)
                </button>
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
            <details className="atoms-disclosure" open>
              <summary>Trajectory</summary>
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
            </details>
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
            {options.colorMode === 'uniform' && (
              <label className="color-pick">
                <span>Custom color</span>
                <input
                  type="color"
                  value={hexColor(options.uniformColor)}
                  onChange={(e) =>
                    setOptions((o) => ({ ...o, uniformColor: parseHexColor(e.target.value) }))
                  }
                />
              </label>
            )}
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
          inputsRef={viewerInputsRef}
          options={options}
          sceneKey={sceneKey}
          pickingEnabled={active != null && !moveMode}
          highlights={highlights}
          onPick={applySelection}
          manipulation={moveMode && active ? { systemId: active.id, mode: moveTransform } : null}
          onTransform={setSystemTransform}
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

      {modal === 'clusters' && (
        <ClustersModal
          clusters={clusters}
          onChange={setClusters}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'remoteOpen' && (
        <RemoteOpenModal
          clusters={clusters}
          onOpen={openRemotePath}
          onManageClusters={() => setModal('clusters')}
          onClose={() => setModal(null)}
        />
      )}
      {pwPrompt && (
        <PasswordModal
          clusterName={pwPrompt.clusterName}
          onSubmit={submitPassword}
          onCancel={cancelPassword}
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
      {modal === 'graphics' && (
        <GraphicsModal options={options} setOptions={setOptions} onClose={() => setModal(null)} />
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
const ATTACH_FILTERS = [{ name: 'Tinker Files', extensions: ['key', 'seq', 'prm', 'dcd'] }]
// Used when running a command on a system that has no key attached.
const DEFAULT_KEY = '# Tinker Studio: no key file attached\n'
// Attached to a Builder / PubChem / NCI system: its basic.prm atom types (10·Z +
// attached atoms) pair with this parameters line, which Tinker Studio resolves to
// its bundled basic.prm at run time — unless the user attaches a key naming a
// different parameter file, which then takes precedence.
const BASIC_KEY = '# Tinker Studio: basic.prm atom types (10*Z + attached atoms)\nparameters basic.prm\n'
// The .key filename shown for those auto-typed systems.
const BASIC_KEY_NAME = 'basic.key'

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

function GraphicsModal({
  options,
  setOptions,
  onClose
}: {
  options: RenderOptions
  setOptions: Dispatch<SetStateAction<RenderOptions>>
  onClose: () => void
}) {
  const set = (patch: Partial<RenderOptions>): void => setOptions((o) => ({ ...o, ...patch }))
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-gfx" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Graphics</h3>
          <button className="modal-x" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="gfx-row">
          <label>Ball size</label>
          <input
            type="range"
            min={0.2}
            max={3}
            step={0.05}
            value={options.ballScale}
            onChange={(e) => set({ ballScale: Number(e.target.value) })}
          />
          <span className="gfx-val">{options.ballScale.toFixed(2)}×</span>
        </div>
        <div className="gfx-row">
          <label>Bond thickness</label>
          <input
            type="range"
            min={0.2}
            max={3}
            step={0.05}
            value={options.bondScale}
            onChange={(e) => set({ bondScale: Number(e.target.value) })}
          />
          <span className="gfx-val">{options.bondScale.toFixed(2)}×</span>
        </div>
        <div className="gfx-row">
          <label title="Line width for the Wireframe representation">Wire width</label>
          <input
            type="range"
            min={1}
            max={8}
            step={0.5}
            value={options.wireWidth}
            onChange={(e) => set({ wireWidth: Number(e.target.value) })}
          />
          <span className="gfx-val">{options.wireWidth.toFixed(1)} px</span>
        </div>
        <div className="gfx-row">
          <label>Contrast</label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={options.contrast}
            onChange={(e) => set({ contrast: Number(e.target.value) })}
          />
          <span className="gfx-val">{Math.round(options.contrast * 100)}%</span>
        </div>
        <div className="gfx-row">
          <label>Perspective</label>
          <div className="perspective-row">
            <span className="perspective-end" title="Wide angle — camera close">
              ◗
            </span>
            <input
              className="perspective-slider"
              type="range"
              min={FOV_MIN}
              max={FOV_MAX}
              // Left = wide angle (large FOV); invert so the slider reads near-to-far.
              value={FOV_MIN + FOV_MAX - options.fov}
              onChange={(e) => set({ fov: FOV_MIN + FOV_MAX - Number(e.target.value) })}
            />
            <span className="perspective-end" title="Telephoto — camera far">
              ◓
            </span>
          </div>
        </div>
        <div className="gfx-row">
          <label>Finish</label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={options.glossiness}
            onChange={(e) => set({ glossiness: Number(e.target.value) })}
          />
          <span className="gfx-val">{options.glossiness < 0.5 ? 'matte' : 'glossy'}</span>
        </div>
        <div className="gfx-row">
          <label>Background</label>
          <input
            type="color"
            value={hexColor(options.backgroundColor)}
            onChange={(e) => set({ backgroundColor: parseHexColor(e.target.value) })}
          />
          <label className="gfx-check">
            <input
              type="checkbox"
              checked={options.backgroundGradient}
              onChange={(e) => set({ backgroundGradient: e.target.checked })}
            />
            Gradient
          </label>
        </div>
        <div className="gfx-row">
          <label>Antialiasing</label>
          <label className="gfx-check">
            <input
              type="checkbox"
              checked={options.antialias}
              onChange={(e) => set({ antialias: e.target.checked })}
            />
            Smooth edges
          </label>
        </div>
        <div className="gfx-row">
          <label>Highlight</label>
          <input
            type="color"
            value={hexColor(options.highlightColor)}
            onChange={(e) => set({ highlightColor: parseHexColor(e.target.value) })}
          />
        </div>
        <div className="gfx-row">
          <label>Labels</label>
          <input
            type="color"
            value={hexColor(options.labelColor)}
            onChange={(e) => set({ labelColor: parseHexColor(e.target.value) })}
          />
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            value={options.labelScale}
            onChange={(e) => set({ labelScale: Number(e.target.value) })}
            title="Label size"
          />
        </div>
        <div className="gfx-row">
          <label>Depth cueing</label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={options.fog}
            onChange={(e) => set({ fog: Number(e.target.value) })}
          />
          <span className="gfx-val">{options.fog === 0 ? 'off' : `${Math.round(options.fog * 100)}%`}</span>
        </div>
        <div className="gfx-row">
          <label>Effects</label>
          <label className="gfx-check">
            <input
              type="checkbox"
              checked={options.ambientOcclusion}
              onChange={(e) => set({ ambientOcclusion: e.target.checked })}
            />
            AO
          </label>
          <label className="gfx-check">
            <input
              type="checkbox"
              checked={options.outline}
              onChange={(e) => set({ outline: e.target.checked })}
            />
            Outline
          </label>
        </div>
        <div className="gfx-row">
          <label>Projection</label>
          <label className="gfx-check">
            <input
              type="checkbox"
              checked={options.orthographic}
              onChange={(e) => set({ orthographic: e.target.checked })}
            />
            Orthographic
          </label>
          <label className="gfx-check">
            <input
              type="checkbox"
              checked={options.showBox}
              onChange={(e) => set({ showBox: e.target.checked })}
            />
            Periodic box
          </label>
        </div>
        <div className="modal-buttons">
          <button
            className="modal-btn ghost"
            onClick={() =>
              set({
                ballScale: 1,
                bondScale: 1,
                wireWidth: 1,
                backgroundColor: DEFAULT_BACKGROUND,
                backgroundGradient: false,
                contrast: CONTRAST_DEFAULT,
                glossiness: GLOSSINESS_DEFAULT,
                antialias: true,
                highlightColor: HIGHLIGHT_COLOR_DEFAULT,
                labelColor: LABEL_COLOR_DEFAULT,
                labelScale: 1,
                fog: 0,
                ambientOcclusion: false,
                outline: false,
                orthographic: false,
                showBox: false
              })
            }
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  )
}

function PasswordModal({
  clusterName,
  onSubmit,
  onCancel
}: {
  clusterName: string
  onSubmit: (password: string, remember: boolean) => void
  onCancel: () => void
}) {
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Password for {clusterName}</h3>
          <button className="modal-x" onClick={onCancel}>
            ×
          </button>
        </div>
        <div className="form-section">
          <div className="form-row">
            <label>Password</label>
            <input
              type="password"
              autoFocus
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && password) onSubmit(password, remember)
              }}
            />
          </div>
          <div className="form-row">
            <label></label>
            <label className="opt-choice">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              Remember (encrypted in the OS keychain)
            </label>
          </div>
          <div className="form-actions">
            <button
              className="modal-btn primary"
              onClick={() => onSubmit(password, remember)}
              disabled={!password}
            >
              Connect
            </button>
            <button className="modal-btn ghost" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build the files to stage for a remote job from the active system: a Tinker
 * .xyz (basic-typed when the molecule is untyped) plus a sibling .key Tinker
 * picks up automatically. Mirrors the local launch's typing logic, never
 * mutating the in-memory system.
 */
function buildRemoteFiles(
  system: MolecularSystem,
  program: string
): { files: { name: string; text: string }[]; inputName: string; outputFormat: 'arc' | 'dcd' | null; stem: string } {
  const baked = bakeTransform(system.structure, system.transform)
  const hasOwnParams = !!system.keyText && /^\s*parameters\b/im.test(system.keyText)
  const useBasic = isUntyped(baked) && !hasOwnParams
  const struct = useBasic ? withBasicTypes(baked) : baked
  const stem =
    (system.path ? system.path.split(/[\\/]/).pop()! : system.name)
      .replace(/\.[^.]*$/, '')
      .replace(/[^A-Za-z0-9._-]/g, '_') || 'structure'
  const inputName = `${stem}.xyz`
  const keyText =
    system.keyText && system.keyText.trim()
      ? system.keyText
      : useBasic
        ? 'parameters basic.prm\n'
        : DEFAULT_KEY
  const files = [
    { name: inputName, text: writeTinkerXyz(struct) },
    { name: `${stem}.key`, text: keyText }
  ]
  const dcd = program === 'dynamic' && /^\s*dcd-archive\b/im.test(keyText)
  const outputFormat: 'arc' | 'dcd' | null = program === 'dynamic' ? (dcd ? 'dcd' : 'arc') : null
  return { files, inputName, outputFormat, stem }
}

function hexColor(n: number): string {
  return '#' + (n & 0xffffff).toString(16).padStart(6, '0')
}

function parseHexColor(s: string): number {
  return parseInt(s.replace('#', ''), 16) || 0
}
