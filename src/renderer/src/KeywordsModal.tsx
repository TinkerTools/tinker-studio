import { useMemo, useState } from 'react'
import { keywordSections } from './data/tinkerCatalog'

/**
 * Searchable Tinker keyword reference + a key-file composer, generated from the
 * original keywords.xml (30 sections, 338 keywords). Clicking a keyword appends
 * a line to the draft key file. Saving to a system's .key is a later step.
 */
export function KeywordsModal({
  initialText,
  attachLabel,
  onAttach,
  onClose
}: {
  initialText?: string
  /** Label for the attach-back button (shown only when onAttach is provided). */
  attachLabel?: string
  /** Called with the edited draft to write it back to a system's key. */
  onAttach?: (text: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState(initialText ?? '')
  const q = query.trim().toLowerCase()

  const sections = useMemo(() => {
    if (!q) return keywordSections
    return keywordSections
      .map((s) => ({
        ...s,
        keywords: s.keywords.filter(
          (k) => k.name.toLowerCase().includes(q) || k.description.toLowerCase().includes(q)
        )
      }))
      .filter((s) => s.keywords.length > 0)
  }, [q])

  function addKeyword(name: string, firstValue?: string): void {
    setDraft((d) => {
      const prefix = d && !d.endsWith('\n') ? '\n' : ''
      return `${d}${prefix}${name}${firstValue ? ' ' + firstValue : ' '}\n`
    })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Tinker Keywords</h3>
          <button className="modal-x" onClick={onClose}>
            ×
          </button>
        </div>
        <input
          className="modal-input"
          placeholder="Search keywords…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <div className="kw-body">
          <div className="kw-list">
            {sections.map((s) => (
              <div key={s.name} className="kw-section">
                <div className="kw-section-name">{s.name}</div>
                {s.keywords.map((k) => (
                  <div
                    key={k.name}
                    className="kw-item"
                    title="Add to key file"
                    onClick={() => addKeyword(k.name, k.values[0])}
                  >
                    <div className="kw-name">
                      {k.name} <span className="kw-rep">{k.rep}</span>
                    </div>
                    <div className="kw-desc">{k.description}</div>
                    {k.values.length > 0 && <div className="kw-values">{k.values.join(' · ')}</div>}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="kw-draft">
            <label className="control-label">Key file (click keywords to add)</label>
            <textarea
              className="kw-textarea"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="# Tinker keyword file"
              spellCheck={false}
            />
            <div className="kw-actions">
              {onAttach && (
                <button className="modal-btn primary" onClick={() => onAttach(draft)}>
                  {attachLabel ?? 'Attach to system'}
                </button>
              )}
              <button
                className="modal-btn ghost kw-save"
                disabled={!draft.trim()}
                onClick={() => void window.tinker.saveTextFile('tinker.key', draft)}
              >
                Save Key File…
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
