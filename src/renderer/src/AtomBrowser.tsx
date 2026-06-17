import { useMemo, useState } from 'react'
import type { MolecularSystem } from './core/system'
import { elementInfo } from './core/elements'

/**
 * Browsable list of a system's atoms (the "hierarchy" from the original FFE).
 * For structures with residue info (PDB) it groups atoms into collapsible
 * residue nodes; otherwise it shows a flat list. Clicking an atom selects it
 * (used for highlighting and measurement).
 */

type Atoms = MolecularSystem['structure']['atoms']

interface ResidueGroup {
  key: string
  label: string
  atomIndices: number[]
}

function groupByResidue(atoms: Atoms): ResidueGroup[] | null {
  if (!atoms.some((a) => a.residueSeq !== undefined)) return null
  const map = new Map<string, ResidueGroup>()
  const groups: ResidueGroup[] = []
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
  onPick: (atomIndex: number) => void
}) {
  const atoms = system.structure.atoms
  const groups = useMemo(() => groupByResidue(atoms), [atoms])

  return (
    <div className="atom-scroll">
      {groups ? (
        groups.map((g) => (
          <ResidueNode key={g.key} group={g} atoms={atoms} selected={selected} onPick={onPick} />
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

function ResidueNode({
  group,
  atoms,
  selected,
  onPick
}: {
  group: ResidueGroup
  atoms: Atoms
  selected: Set<number>
  onPick: (atomIndex: number) => void
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
  onPick: (atomIndex: number) => void
}) {
  return (
    <li className={selected ? 'atom-row sel' : 'atom-row'} onClick={() => onPick(index)}>
      <span className="atom-idx">{index + 1}</span>
      <span className="atom-name">{name}</span>
      <span className="atom-elem" style={{ color: elementColor(element) }}>
        {element}
      </span>
    </li>
  )
}
