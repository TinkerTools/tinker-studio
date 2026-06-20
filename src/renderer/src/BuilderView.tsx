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
 * The molecule builder — a separate, full-screen mode that starts blank. You pick
 * an element and grow a molecule by bonding atoms to a selected atom; hydrogens
 * fill valences automatically, bond orders adjust them, and a self-contained
 * geometry engine relaxes the coordinates after every edit (no Tinker needed).
 * On Done, the molecule is handed back to the main UI as a new system.
 */

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
  const [element, setElement] = useState<string>('C')
  const [moveMode, setMoveMode] = useState(false)
  // Snapshot of selected atom coords at the start of a manual drag.
  const moveSnapRef = useRef<Record<number, { x: number; y: number; z: number }>>({})
  const [minimizeAvailable, setMinimizeAvailable] = useState(false)
  const [minimizing, setMinimizing] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  /** Apply a mutation, relax, and refresh. */
  function edit(fn: () => void): void {
    fn()
    relax(molRef.current)
    setVersion((v) => v + 1)
  }

  function handlePick(result: PickResult | null, additive: boolean): void {
    if (!result) {
      if (!additive) setSelected([])
      return
    }
    const id = idForIndex[result.atomIndex]
    if (id == null) return
    setSelected((prev) => {
      if (additive) return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      return prev.includes(id) && prev.length === 1 ? [] : [id]
    })
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
    setVersion((v) => v + 1)
  }

  function moveEnd(): void {
    moveSnapRef.current = {}
  }

  // Optional Tinker geometry clean-up: available only when a `minimize` executable
  // is configured. Uses an auto-generated minimal force field (see tinkerExport).
  useEffect(() => {
    void window.ffe?.builder?.hasMinimize().then(setMinimizeAvailable)
  }, [])

  async function runMinimize(): Promise<void> {
    if (minimizing || molRef.current.atoms.length === 0) return
    setMinimizing(true)
    setError(null)
    try {
      const res = await window.ffe.builder.minimize(buildTinkerInput(molRef.current))
      if (!res.ok || !res.xyz) {
        setError(`Tinker minimize failed — ${res.error ?? 'unknown error'}`)
        return
      }
      // Minimized atoms are in the same order; copy coordinates back in place.
      const min = parseTinkerXyz(res.xyz)
      if (min.atoms.length === molRef.current.atoms.length) {
        molRef.current.atoms.forEach((a, i) => {
          a.x = min.atoms[i].x
          a.y = min.atoms[i].y
          a.z = min.atoms[i].z
        })
        setVersion((v) => v + 1)
      } else {
        setError('Tinker minimize returned an unexpected atom count.')
      }
    } catch (e) {
      setError(`Tinker minimize error — ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setMinimizing(false)
    }
  }

  function addElement(el: string): void {
    const parent = selected.length >= 1 ? selected[selected.length - 1] : null
    // Adding the first heavy atom, or growing from the selected atom.
    if (mol.atoms.length === 0 || parent != null || el !== 'H') {
      let newId: number | null = null
      edit(() => {
        newId = addAtom(molRef.current, parent, el)
      })
      // Chain growth: keep the new heavy atom selected so you can keep extending.
      if (newId != null) setSelected([newId])
    }
  }

  function addStructure(fragId: string): void {
    const frag = FRAGMENTS.find((f) => f.id === fragId)
    if (!frag) return
    // Attach to the single selected atom, or drop in standalone otherwise.
    const parent = selected.length === 1 ? selected[0] : null
    let attachId = 0
    edit(() => {
      attachId = addFragment(molRef.current, parent, frag)
    })
    setSelected([attachId])
  }

  function bondSelected(): void {
    if (selected.length !== 2) return
    edit(() => {
      bondAtoms(molRef.current, selected[0], selected[1])
    })
  }

  function orderSelected(order: number): void {
    if (selected.length !== 2) return
    edit(() => {
      setBondOrder(molRef.current, selected[0], selected[1], order)
    })
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

  // Relationship of the current selection, for enabling bond/order controls.
  const twoSelected = selected.length === 2
  const existingBond = twoSelected ? findBond(mol, selected[0], selected[1]) : undefined
  const atomCount = mol.atoms.length

  return (
    <div className="builder">
      <header className="builder-bar">
        <span className="builder-title">Molecule Builder</span>

        <div className="builder-group" title="Click to grow from the selected atom (or place the first atom)">
          <span className="builder-label">Add</span>
          {BUILDER_ELEMENTS.map((el) => (
            <button
              key={el}
              className={el === element ? 'el on' : 'el'}
              onClick={() => {
                setElement(el)
                addElement(el)
              }}
            >
              {el}
            </button>
          ))}
        </div>

        <div
          className="builder-group"
          title="Insert a ring or group — attached to the selected atom, or on its own"
        >
          <select
            className="builder-frag"
            value=""
            onChange={(e) => {
              if (e.target.value) addStructure(e.target.value)
              e.target.value = ''
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

        <div className="builder-group">
          <button disabled={!twoSelected || !!existingBond} onClick={bondSelected} title="Bond the two selected atoms (closes rings)">
            Bond
          </button>
          <button disabled={!existingBond} onClick={() => orderSelected(1)} title="Single bond">
            —
          </button>
          <button disabled={!existingBond} onClick={() => orderSelected(2)} title="Double bond">
            =
          </button>
          <button disabled={!existingBond} onClick={() => orderSelected(3)} title="Triple bond">
            ≡
          </button>
        </div>

        <div className="builder-group">
          <button
            className={moveMode ? 'on' : ''}
            disabled={atomCount === 0}
            onClick={() => setMoveMode((m) => !m)}
            title="Move mode: drag selected atoms by hand (no auto-relax)"
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
            <button
              disabled={atomCount === 0 || minimizing}
              onClick={runMinimize}
              title="Clean up geometry with Tinker minimize (generated minimal force field)"
            >
              {minimizing ? 'Minimizing…' : 'Minimize'}
            </button>
          )}
        </div>

        <div className="builder-group builder-right">
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
              group. Hydrogens fill in automatically.
            </p>
          ) : moveMode ? (
            <p>
              <b>Move mode:</b> drag an atom to reposition it (and any others selected with it) in the
              screen plane. No auto-relax — your placement sticks. Toggle <b>Move</b> off to edit.
            </p>
          ) : (
            <p>
              Select an atom and click an element to bond it on, or <b>Add structure…</b> to attach a
              ring/group. ⌘/Ctrl-click a second atom, then <b>Bond</b> to connect them (or set{' '}
              <b>=</b>/<b>≡</b> for double/triple).
            </p>
          )}
          <p className="builder-count">{atomCount} atoms</p>
          {error && <p className="builder-error">{error}</p>}
        </div>
      </div>
    </div>
  )
}
