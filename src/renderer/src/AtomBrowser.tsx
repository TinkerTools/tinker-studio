import { useMemo, useState } from 'react'
import type { MolecularSystem } from './core/system'
import { connectedComponents } from './core/select'
import { elementInfo } from './core/elements'

/**
 * Browsable list of a system's atoms (the "hierarchy" from the original FFE).
 * Structures with residue info (PDB) group into collapsible residue nodes;
 * multi-molecule structures group into per-molecule nodes; everything else
 * shows a flat list. Clicking an atom selects it (highlight + measurement).
 */

type Atoms = MolecularSystem['structure']['atoms']

interface AtomGroup {
  key: string
  label: string
  atomIndices: number[]
}

function groupByResidue(atoms: Atoms): AtomGroup[] | null {
  if (!atoms.some((a) => a.residueSeq !== undefined)) return null
  const map = new Map<string, AtomGroup>()
  const groups: AtomGroup[] = []
  atoms.forEach((a, i) => {
    const key = `${a.chain ?? ''}/${a.residueSeq ?? ''}/${a.residue ?? ''}`
    let group = map.get(key)
    if (!group) {
      const label = `${a.chain ? a.chain + ' · ' : ''}${a.residue ?? '?'} ${a.residueSeq ?? ''}`.trim()
      group = { key, label, atomIndices: [] }
      map.set(key, group)
      groups.push(group)
    }
    group.atomIndices.push(i)
  })
  return groups
}

// Group atoms by connected molecule, but only when there are at least two
// molecules (a single molecule stays a flat list).
function groupByMolecule(system: MolecularSystem): AtomGroup[] | null {
  const components = connectedComponents(system.structure)
  if (components.length < 2) return null
  return components.map((atomIndices, i) => ({
    key: `mol-${i}`,
    label: `Molecule ${i + 1}`,
    atomIndices
  }))
}

function elementColor(element: string): string {
  return '#' + elementInfo(element).color.toString(16).padStart(6, '0')
}

export function AtomBrowser({
  system,
  selected,
  onPick
}: {
  system: MolecularSystem
  selected: Set<number>
  onPick: (atomIndex: number, additive: boolean) => void
}) {
  const atoms = system.structure.atoms
  const groups = useMemo(
    () => groupByResidue(atoms) ?? groupByMolecule(system),
    [atoms, system]
  )

  return (
    <div className="atom-scroll">
      {groups ? (
        groups.map((g) => (
          <GroupNode key={g.key} group={g} atoms={atoms} selected={selected} onPick={onPick} />
        ))
      ) : (
        <ul className="atom-list">
          {atoms.map((a, i) => (
            <AtomRow key={i} index={i} name={a.name} element={a.element} selected={selected.has(i)} onPick={onPick} />
          ))}
        </ul>
      )}
    </div>
  )
}

function GroupNode({
  group,
  atoms,
  selected,
  onPick
}: {
  group: AtomGroup
  atoms: Atoms
  selected: Set<number>
  onPick: (atomIndex: number, additive: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const hasSelected = group.atomIndices.some((i) => selected.has(i))
  return (
    <div className="res-node">
      <div
        className={hasSelected ? 'res-header has-sel' : 'res-header'}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="res-caret">{open ? '▾' : '▸'}</span>
        <span className="res-label">{group.label}</span>
        <span className="res-count">{group.atomIndices.length}</span>
      </div>
      {open && (
        <ul className="atom-list">
          {group.atomIndices.map((i) => (
            <AtomRow
              key={i}
              index={i}
              name={atoms[i].name}
              element={atoms[i].element}
              selected={selected.has(i)}
              onPick={onPick}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function AtomRow({
  index,
  name,
  element,
  selected,
  onPick
}: {
  index: number
  name: string
  element: string
  selected: boolean
  onPick: (atomIndex: number, additive: boolean) => void
}) {
  return (
    <li
      className={selected ? 'atom-row sel' : 'atom-row'}
      onClick={(e) => onPick(index, e.metaKey || e.ctrlKey)}
    >
      <span className="atom-idx">{index + 1}</span>
      <span className="atom-name">{name}</span>
      <span className="atom-elem" style={{ color: elementColor(element) }}>
        {element}
      </span>
    </li>
  )
}
