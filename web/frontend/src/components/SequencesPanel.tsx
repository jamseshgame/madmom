import { useState, type ReactNode } from 'react'
import type { SequenceNote } from '../chart/sequences'

export interface SequenceRowData {
  id: string
  name: string
  resolution: number
  notes: SequenceNote[]
}

export type PasteScale = 0.5 | 1 | 2

interface Props {
  sequences: SequenceRowData[]
  scale: PasteScale
  canSave: boolean            // a non-empty gem selection exists
  selectionCount: number
  onScaleChange: (s: PasteScale) => void
  onSaveSelection: (name: string) => void
  onPlace: (id: string) => void
  onRename: (id: string, newName: string) => void
  onClone: (id: string) => void
  onDelete: (id: string) => void
  Wrapper: ({ children, title, right }: { children: ReactNode; title: string; right?: ReactNode }) => ReactNode
}

const SCALES: { value: PasteScale; label: string }[] = [
  { value: 0.5, label: '×½' },
  { value: 1, label: '×1' },
  { value: 2, label: '×2' },
]

function lengthBeats(s: SequenceRowData): number {
  let endTick = 0
  for (const n of s.notes) {
    const end = n.tick + n.sustain
    if (end > endTick) endTick = end
  }
  return endTick / s.resolution
}

// One row's rename field: edits locally, commits on blur/Enter so the
// server isn't PATCHed per keystroke.
function NameField({ name, onCommit }: { name: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft !== null && draft.trim() && draft.trim() !== name) onCommit(draft.trim())
    setDraft(null)
  }
  return (
    <input
      type="text"
      value={draft ?? name}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      className="flex-1 min-w-0 bg-transparent border-0 text-[11px] text-gray-200 truncate focus:outline-none focus:bg-gray-800 rounded px-1"
      title={name}
    />
  )
}

export function SequencesPanel({
  sequences, scale, canSave, selectionCount,
  onScaleChange, onSaveSelection, onPlace, onRename, onClone, onDelete, Wrapper,
}: Props) {
  return (
    <Wrapper
      title="Sequences"
      right={sequences.length > 0 ? (
        <span className="text-[10px] text-cyan-300 font-mono">{sequences.length}</span>
      ) : undefined}
    >
      <div className="flex items-center gap-1 mb-1.5">
        <button
          disabled={!canSave}
          onClick={() => {
            const name = window.prompt('Sequence name?')
            if (name && name.trim()) onSaveSelection(name.trim())
          }}
          className="flex-1 text-[10px] px-1.5 py-1 bg-violet-800/50 hover:bg-violet-700/60 disabled:opacity-40 disabled:cursor-not-allowed border border-violet-700/60 text-violet-100 rounded font-medium"
          title={canSave ? `Save the ${selectionCount} selected notes as a reusable sequence` : 'Select some gems first'}
        >
          + Save selection{canSave ? ` (${selectionCount})` : ''}
        </button>
        <div className="flex rounded overflow-hidden border border-gray-700" title="Paste scale — stretch or compress note spacing when placing">
          {SCALES.map((s) => (
            <button
              key={s.value}
              onClick={() => onScaleChange(s.value)}
              className={`px-1.5 py-1 text-[10px] font-mono ${
                scale === s.value ? 'bg-cyan-700/60 text-cyan-100' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {sequences.length === 0 ? (
        <p className="text-[10px] text-gray-600 leading-snug">
          Select gems on the highway (shift+click range, alt+drag marquee) and save them as a reusable sequence.
        </p>
      ) : (
        <ul className="space-y-1">
          {sequences.map((s) => (
            <li key={s.id} className="px-2 py-1.5 rounded border border-gray-800 bg-gray-900/40">
              <div className="flex items-center gap-1">
                <NameField name={s.name} onCommit={(v) => onRename(s.id, v)} />
                <button
                  onClick={() => onClone(s.id)}
                  className="shrink-0 px-1 py-0.5 bg-gray-800 hover:bg-gray-700 rounded text-[10px] text-gray-200"
                  title="Clone this sequence"
                >
                  ⧉
                </button>
                <button
                  onClick={() => { if (window.confirm(`Delete sequence "${s.name}"?`)) onDelete(s.id) }}
                  className="shrink-0 px-1 py-0.5 bg-red-900/30 hover:bg-red-800/60 border border-red-800/40 rounded text-[10px] text-red-300"
                  title="Delete this sequence"
                >
                  ×
                </button>
              </div>
              <div className="text-[10px] text-gray-500 font-mono mt-0.5">
                {s.notes.length}n · {lengthBeats(s).toFixed(1)} beats
              </div>
              <button
                onClick={() => onPlace(s.id)}
                className="mt-1 w-full text-[10px] px-1.5 py-1 bg-gray-800 hover:bg-gray-700 rounded text-gray-200"
                title="Insert at the playhead, snapped to the grid, scaled by the selector above"
              >
                + place at playhead {scale !== 1 ? SCALES.find((x) => x.value === scale)!.label : ''}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Wrapper>
  )
}
