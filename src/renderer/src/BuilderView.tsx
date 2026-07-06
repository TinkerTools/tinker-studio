import { useMemo, useRef, useState, useEffect } from 'react'
import { Viewer, type ViewerInputs } from './viewer/Viewer'
import type { PickResult, Renderable } from './viewer/scene'
import { DEFAULT_RENDER_OPTIONS, type RenderOptions } from './viewer/renderOptions'
import type { Structure } from './core/types'
import {
  emptyMolecule,
  addAtom,
  addFragment,
  bondAtoms,
  setBondOrder,
  deleteAtom,
  replaceAtomWithElement,
  replaceAtomWithFragment,
  findBond,
  toStructure,
  type BuilderMolecule
} from './core/builder/molecule'
import { relax } from './core/builder/relax'
import { BUILDER_ELEMENTS } from './core/builder/valence'
import { FRAGMENTS } from './core/builder/fragments'
import { buildTinkerInput } from './core/builder/tinkerExport'
import { parseTinkerXyz } from './core/parseXyz'

/**
 * The molecule builder — a separate, full-screen mode that starts blank. Spartan
 * style: pick an element or ring/group as the active tool, then click an atom to
 * replace it with that tool. Hydrogens are open valences, so clicking one grows the
 * molecule there; clicking a heavy atom retypes it (or swaps it for a group).
 * Hydrogens fill valences automatically, bond orders adjust them, and a
 * self-contained geometry engine relaxes the coordinates after every edit (no Tinker
 * needed). ⌘/Ctrl-click selects atoms for the Bond / bond-order / Delete controls.
 * On Done, the molecule is handed back to the main UI as a new system.
 */

/**
 * The active build tool: an element to type, a ring/group fragment to graft, or
 * bond mode of a given order (click one atom then another to bond them; hydrogens
 * are added/removed to satisfy the new valence).
 */
type Tool =
  | { kind: 'element'; value: string }
  | { kind: 'fragment'; id: string }
  | { kind: 'bond'; order: 1 | 2 | 3 }

// Builder rendering is fixed: ball-and-stick, hydrogens shown, no fog/effects.
const BUILDER_OPTIONS: RenderOptions = {
  ...DEFAULT_RENDER_OPTIONS,
  representation: 'ball-and-stick',
  showHydrogens: true
}

export function BuilderView({
  onDone,
  onCancel,
  demo = false
}: {
  /** Hand the finished molecule to the main UI as a new system. */
  onDone: (structure: Structure) => void
  /** Leave without keeping anything. */
  onCancel: () => void
  /** Headless-capture only: auto-build a benzene demo on mount. */
  demo?: boolean
}) {
  const molRef = useRef<BuilderMolecule>(emptyMolecule())
  const [version, setVersion] = useState(0)
  const [selected, setSelected] = useState<number[]>([]) // builder atom ids
  const [tool, setTool] = useState<Tool>({ kind: 'element', value: 'C' })
  const [moveMode, setMoveMode] = useState(false)
  // Snapshot of selected atom coords at the start of a manual drag.
  const moveSnapRef = useRef<Record<number, { x: number; y: number; z: number }>>({})
  const [minimizeAvailable, setMinimizeAvailable] = useState(false)
  const [minimizing, setMinimizing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Auto-minimize with Tinker after each edit (when available) — more robust than
  // the built-in relaxer, so it's the default. Falls back to the relaxer otherwise.
  const [autoMin, setAutoMin] = useState(true)
  // Edit generation: bumped on every change so a slower Tinker result that finished
  // after a newer edit (or manual move) is discarded instead of applied stale.
  const editGenRef = useRef(0)
  const autoTimerRef = useRef<number | undefined>(undefined)
  const inFlightRef = useRef(0)

  const mol = molRef.current

  // Re-derive the Structure + bond-order map for rendering whenever the model
  // changes. Structure atoms are in mol.atoms order, so structure index i maps to
  // mol.atoms[i].id (used to translate picks back to builder ids).
  const { structure, bondOrders, idForIndex, indexForId } = useMemo(() => {
    const s = toStructure(mol, 'New molecule')
    const idForIndex = mol.atoms.map((a) => a.id)
    const indexForId = new Map<number, number>()
    mol.atoms.forEach((a, i) => indexForId.set(a.id, i))
    const orders: Record<string, number> = {}
    for (const b of mol.bonds) {
      if (b.order > 1) {
        const i = (indexForId.get(b.a) ?? 0) + 1
        const j = (indexForId.get(b.b) ?? 0) + 1
        const key = i < j ? `${i}-${j}` : `${j}-${i}`
        orders[key] = b.order
      }
    }
    return { structure: s, bondOrders: orders, idForIndex, indexForId }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  const renderable: Renderable = useMemo(
    () => ({
      id: 'builder',
      structure,
      coords: null,
      selected: new Set(selected.map((id) => indexForId.get(id)!).filter((i) => i != null)),
      bondOrders
    }),
    [structure, bondOrders, selected, indexForId]
  )

  const inputsRef = useRef<ViewerInputs>({ renderables: [renderable], liveUpdate: null })
  inputsRef.current = { renderables: [renderable], liveUpdate: null }

  // Highlight markers on the selected atoms.
  const highlights = useMemo(
    () =>
      selected
        .map((id) => {
          const a = mol.atoms.find((x) => x.id === id)
          return a ? { position: [a.x, a.y, a.z] as [number, number, number] } : null
        })
        .filter((h): h is { position: [number, number, number] } => h != null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, version]
  )

  /**
   * Apply a mutation: run the built-in relaxer for instant feedback, then (if
   * auto-minimize is on and Tinker is available) refine the geometry with a
   * debounced Tinker minimize.
   */
  function edit(fn: () => void): void {
    fn()
    relax(molRef.current)
    editGenRef.current += 1
    setVersion((v) => v + 1)
    scheduleAutoMin()
  }

  function scheduleAutoMin(): void {
    if (!autoMin || !minimizeAvailable) return
    if (autoTimerRef.current) window.clearTimeout(autoTimerRef.current)
    // Debounce so a burst of quick edits triggers one minimize once it settles.
    autoTimerRef.current = window.setTimeout(() => void minimizeNow(), 250)
  }

  function handlePick(result: PickResult | null, additive: boolean): void {
    if (!result) {
      if (!additive) setSelected([])
      return
    }
    const id = idForIndex[result.atomIndex]
    if (id == null) return
    // ⌘/Ctrl-click toggles selection for the bond-order / Delete controls.
    if (additive) {
      setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
      return
    }
    // Bond mode: first click marks an atom, second click bonds the two.
    if (tool.kind === 'bond') {
      bondPick(id)
      return
    }
    // Plain click replaces the atom with the active tool (Spartan-style build).
    applyTool(id)
  }

  /**
   * Bond-mode pick: mark the first atom, then on the second click form a bond of the
   * tool's order between the two — creating it, or re-ordering an existing bond.
   * Hydrogens re-fill to the new valence (a double bond drops one H on each atom, a
   * single adds it back).
   */
  function bondPick(id: number): void {
    if (tool.kind !== 'bond') return
    const m = molRef.current
    const a = m.atoms.find((x) => x.id === id)
    if (!a || a.element === 'H') return // hydrogens are auto-managed, not bondable
    if (selected.length !== 1) {
      setSelected([id]) // mark the first atom (highlighted as pending)
      return
    }
    const first = selected[0]
    if (first === id) {
      setSelected([]) // clicked the same atom again → cancel
      return
    }
    const order = tool.order
    edit(() => {
      if (findBond(m, first, id)) setBondOrder(m, first, id, order)
      else bondAtoms(m, first, id, order)
    })
    setSelected([])
  }

  /** Replace atom `id` with the active tool (element retype/promote, or graft a group). */
  function applyTool(id: number): void {
    const m = molRef.current
    const clicked = m.atoms.find((a) => a.id === id)
    if (!clicked) return
    if (tool.kind === 'element') {
      // No-op when the click wouldn't change the element (skip relax/minimize churn).
      if (clicked.element === tool.value) return
      edit(() => {
        replaceAtomWithElement(m, id, tool.value)
      })
    } else if (tool.kind === 'fragment') {
      const frag = FRAGMENTS.find((f) => f.id === tool.id)
      if (!frag) return
      // A fragment can't graft onto a bridging atom (2+ heavy neighbours); replace
      // would be a no-op, so don't churn relax/minimize on it.
      const heavyNeighbors = m.bonds
        .filter((b) => b.a === id || b.b === id)
        .map((b) => (b.a === id ? b.b : b.a))
        .filter((n) => m.atoms.find((a) => a.id === n)?.element !== 'H')
      if (clicked.element !== 'H' && heavyNeighbors.length > 1) return
      edit(() => {
        replaceAtomWithFragment(m, id, frag)
      })
    }
    setSelected([])
  }

  // --- Manual atom dragging (move mode) ------------------------------------
  // Grabbing an atom selects it (keeping any existing selection it belongs to),
  // then drags move those atoms in the screen plane with no relaxation, so the
  // user's hand-placement sticks.
  function moveBegin(atomIndex: number, additive: boolean): void {
    const id = idForIndex[atomIndex]
    if (id == null) return
    let sel: number[]
    if (selected.includes(id)) sel = selected
    else if (additive) sel = [...selected, id]
    else sel = [id]
    setSelected(sel)
    const snap: Record<number, { x: number; y: number; z: number }> = {}
    for (const sid of sel) {
      const a = molRef.current.atoms.find((x) => x.id === sid)
      if (a) snap[sid] = { x: a.x, y: a.y, z: a.z }
    }
    moveSnapRef.current = snap
  }

  function moveDelta(delta: [number, number, number]): void {
    const snap = moveSnapRef.current
    for (const a of molRef.current.atoms) {
      const s = snap[a.id]
      if (!s) continue
      a.x = s.x + delta[0]
      a.y = s.y + delta[1]
      a.z = s.z + delta[2]
    }
    // A manual move invalidates any pending/in-flight auto-minimize so it can't
    // snap the hand-placed atoms back; manual moves don't trigger a new one.
    editGenRef.current += 1
    setVersion((v) => v + 1)
  }

  function moveEnd(): void {
    moveSnapRef.current = {}
  }

  // Optional Tinker geometry clean-up: available only when a `minimize` executable
  // is configured. Uses an auto-generated minimal force field (see tinkerExport).
  useEffect(() => {
    void window.tinker?.builder?.hasMinimize().then(setMinimizeAvailable)
  }, [])

  /**
   * Run Tinker minimize on the current molecule and copy the optimized coordinates
   * back. Guarded by the edit generation: if the molecule changed while minimize
   * was running, the (now stale) result is discarded. Used by both auto-minimize
   * and the manual button.
   */
  async function minimizeNow(): Promise<void> {
    if (molRef.current.atoms.length < 2) return
    const gen = editGenRef.current
    inFlightRef.current += 1
    setMinimizing(true)
    try {
      const res = await window.tinker.builder.minimize(buildTinkerInput(molRef.current))
      if (gen !== editGenRef.current) return // superseded by a newer edit
      if (res.ok && res.xyz) {
        const min = parseTinkerXyz(res.xyz)
        if (min.atoms.length === molRef.current.atoms.length) {
          molRef.current.atoms.forEach((a, i) => {
            a.x = min.atoms[i].x
            a.y = min.atoms[i].y
            a.z = min.atoms[i].z
          })
          setVersion((v) => v + 1)
          setError(null)
        }
      } else {
        setError(
          `Tinker minimize failed — ${res.error ?? 'unknown error'}` +
            (autoMin ? ' (showing approximate geometry)' : '')
        )
      }
    } catch (e) {
      setError(`Tinker minimize error — ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      inFlightRef.current -= 1
      if (inFlightRef.current === 0) setMinimizing(false)
    }
  }

  // Drop any pending auto-minimize timer on unmount.
  useEffect(() => {
    return () => {
      if (autoTimerRef.current) window.clearTimeout(autoTimerRef.current)
    }
  }, [])

  /**
   * Pick an element as the active tool. On an empty canvas there's nothing to click
   * yet, so also seed the first atom (e.g. C → methane) to build from.
   */
  function pickElement(el: string): void {
    setTool({ kind: 'element', value: el })
    if (mol.atoms.length === 0 && el !== 'H') {
      edit(() => {
        addAtom(molRef.current, null, el)
      })
      setSelected([])
    }
  }

  /** Pick a ring/group as the active tool; seed it standalone on an empty canvas. */
  function pickFragment(fragId: string): void {
    setTool({ kind: 'fragment', id: fragId })
    const frag = FRAGMENTS.find((f) => f.id === fragId)
    if (frag && mol.atoms.length === 0) {
      edit(() => {
        addFragment(molRef.current, null, frag)
      })
      setSelected([])
    }
  }

  /** Toggle bond mode on/off; entering defaults to single bonds, leaving returns to C. */
  function toggleBondMode(): void {
    setSelected([])
    setTool((t) => (t.kind === 'bond' ? { kind: 'element', value: 'C' } : { kind: 'bond', order: 1 }))
  }

  /** Enter bond mode of a given order (single/double/triple). */
  function setBondOrderTool(order: 1 | 2 | 3): void {
    setSelected([])
    setTool({ kind: 'bond', order })
  }

  function deleteSelected(): void {
    if (selected.length === 0) return
    const ids = [...selected]
    edit(() => {
      for (const id of ids) deleteAtom(molRef.current, id)
    })
    setSelected([])
  }

  function clearAll(): void {
    molRef.current = emptyMolecule()
    setSelected([])
    setVersion((v) => v + 1)
  }

  function finish(): void {
    if (molRef.current.atoms.length === 0) {
      onCancel()
      return
    }
    onDone(toStructure(molRef.current, 'New molecule'))
  }

  // Headless-capture demo: build benzene (6-ring, alternating double bonds) so a
  // screenshot exercises fragment insertion + attachment (toluene: a methyl carbon
  // with an attached benzene fragment) and the auto-hydrogens at once.
  useEffect(() => {
    if (!demo) return
    const m = emptyMolecule()
    const c = addAtom(m, null, 'C')!
    addFragment(m, c, FRAGMENTS.find((f) => f.id === 'benzene')!)
    relax(m, 1500)
    molRef.current = m
    setVersion((v) => v + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Delete/Backspace removes the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length > 0) {
        e.preventDefault()
        deleteSelected()
      } else if (e.key === 'Escape') {
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  const atomCount = mol.atoms.length

  return (
    <div className="builder">
      <header className="builder-bar">
        <span className="builder-title">Molecule Builder</span>

        <div className="builder-controls">
        <div
          className="builder-group"
          title="Pick an element, then click an atom to replace it (click a hydrogen to grow)"
        >
          {BUILDER_ELEMENTS.map((el) => (
            <button
              key={el}
              className={tool.kind === 'element' && tool.value === el ? 'el on' : 'el'}
              onClick={() => pickElement(el)}
            >
              {el}
            </button>
          ))}
        </div>

        <div
          className="builder-group"
          title="Pick a ring or group, then click an atom to graft it there (click a hydrogen to grow)"
        >
          <select
            className="builder-frag"
            value={tool.kind === 'fragment' ? tool.id : ''}
            onChange={(e) => {
              if (e.target.value) pickFragment(e.target.value)
            }}
          >
            <option value="">Add structure…</option>
            {FRAGMENTS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>

        <div
          className="builder-group"
          title="Bond mode: pick an order, then click two atoms to bond them (closes rings)"
        >
          <button
            className={tool.kind === 'bond' ? 'on' : ''}
            disabled={atomCount < 2}
            onClick={toggleBondMode}
            title="Bond mode: click one atom, then another, to bond them (closes rings)"
          >
            Bond
          </button>
          <button
            className={tool.kind === 'bond' && tool.order === 1 ? 'on' : ''}
            disabled={atomCount < 2}
            onClick={() => setBondOrderTool(1)}
            title="Single-bond mode: click two atoms"
          >
            —
          </button>
          <button
            className={tool.kind === 'bond' && tool.order === 2 ? 'on' : ''}
            disabled={atomCount < 2}
            onClick={() => setBondOrderTool(2)}
            title="Double-bond mode: click two atoms"
          >
            =
          </button>
          <button
            className={tool.kind === 'bond' && tool.order === 3 ? 'on' : ''}
            disabled={atomCount < 2}
            onClick={() => setBondOrderTool(3)}
            title="Triple-bond mode: click two atoms"
          >
            ≡
          </button>
        </div>

        <div className="builder-group">
          <button
            className={moveMode ? 'on' : ''}
            disabled={atomCount === 0}
            onClick={() => setMoveMode((m) => !m)}
            title="Move mode: drag an atom to reposition it by hand (won't auto-minimize)"
          >
            Move
          </button>
          <button disabled={selected.length === 0} onClick={deleteSelected} title="Delete selected (Del)">
            Delete
          </button>
          <button disabled={atomCount === 0} onClick={clearAll}>
            Clear
          </button>
          {minimizeAvailable && (
            <>
              <label
                className="builder-check"
                title="Refine geometry with Tinker minimize after every edit (uses basic.prm)"
              >
                <input
                  type="checkbox"
                  checked={autoMin}
                  onChange={(e) => {
                    setAutoMin(e.target.checked)
                    // Turning it on cleans up the current geometry right away.
                    if (e.target.checked && molRef.current.atoms.length >= 2) {
                      if (autoTimerRef.current) window.clearTimeout(autoTimerRef.current)
                      autoTimerRef.current = window.setTimeout(() => void minimizeNow(), 50)
                    }
                  }}
                />
                Auto-minimize
              </label>
              {(!autoMin || minimizing) && (
                <button
                  disabled={atomCount < 2 || minimizing}
                  onClick={() => void minimizeNow()}
                  title="Run Tinker minimize now"
                >
                  {minimizing ? 'Minimizing…' : 'Minimize'}
                </button>
              )}
            </>
          )}
        </div>
        </div>

        <div className="builder-actions">
          <button className="builder-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button className="builder-done" disabled={atomCount === 0} onClick={finish}>
            Done
          </button>
        </div>
      </header>

      <div className="builder-viewport">
        <Viewer
          inputsRef={inputsRef}
          options={BUILDER_OPTIONS}
          sceneKey={`builder-${version}`}
          pickingEnabled
          highlights={highlights}
          onPick={handlePick}
          moveMode={moveMode}
          onMoveBegin={moveBegin}
          onMoveDelta={moveDelta}
          onMoveEnd={moveEnd}
        />
        <div className="builder-help">
          {atomCount === 0 ? (
            <p>
              Click an element to place the first atom, or pick <b>Add structure…</b> for a ring or
              group. Hydrogens fill in automatically — then click them to grow.
            </p>
          ) : moveMode ? (
            <p>
              <b>Move mode:</b> drag an atom to reposition it (and any others selected with it) in the
              screen plane. No auto-relax — your placement sticks. Toggle <b>Move</b> off to edit.
            </p>
          ) : tool.kind === 'bond' ? (
            <p>
              <b>Bond mode ({tool.order === 1 ? 'single' : tool.order === 2 ? 'double' : 'triple'}):</b>{' '}
              click one atom, then another, to form that bond (or re-order an existing one) — hydrogens
              adjust to fit. Pick <b>—</b>/<b>=</b>/<b>≡</b> to change the order; click <b>Bond</b> again
              to leave.
            </p>
          ) : (
            <p>
              Pick an element or <b>Add structure…</b>, then <b>click an atom to replace it</b> — click
              a hydrogen to grow the molecule there. Use <b>Bond</b> / <b>—</b> / <b>=</b> / <b>≡</b> to
              connect two atoms, or ⌘/Ctrl-click to select for <b>Delete</b>.
            </p>
          )}
          <p className="builder-count">{atomCount} atoms</p>
          {error && <p className="builder-error">{error}</p>}
        </div>
      </div>
    </div>
  )
}
