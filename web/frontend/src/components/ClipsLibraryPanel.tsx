import type { ReactNode } from 'react'

interface ClipRow {
  id: string
  name: string
  sourceId: string | null   // null = upload-based
  sourceLabel: string       // display label for the source badge
  startSec: number
  endSec: number
  notesCount: number
  isPlaced: boolean
}

interface Props {
  clips: ClipRow[]
  selectedClipId: string | null
  onSelect: (id: string | null) => void
  onAudition: (id: string) => void
  onPlaceAtPlayhead: (id: string) => void
  onRename: (id: string, newName: string) => void
  onDelete: (id: string) => void
  Wrapper: ({ children, title, right, id }: { children: ReactNode; title: string; right?: ReactNode; id: string }) => ReactNode
}

export function ClipsLibraryPanel({
  clips, selectedClipId, onSelect, onAudition, onPlaceAtPlayhead, onRename, onDelete, Wrapper,
}: Props) {
  return (
    <Wrapper
      id="clips-library"
      title="Clips"
      right={clips.length > 0 ? (
        <span className="text-[10px] text-cyan-300 font-mono">{clips.length}</span>
      ) : undefined}
    >
      {clips.length === 0 ? (
        <p className="text-[10px] text-gray-600 leading-snug">
          Import a source above and drag a region on the waveform to author your first clip.
        </p>
      ) : (
        <ul className="space-y-1">
          {clips.map((c) => {
            const sel = c.id === selectedClipId
            return (
              <li
                key={c.id}
                className={`px-2 py-1.5 rounded border ${
                  sel ? 'border-cyan-500 bg-cyan-900/15' : 'border-gray-800 bg-gray-900/40'
                }`}
                onClick={() => onSelect(c.id)}
              >
                <div className="flex items-center gap-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); onAudition(c.id) }}
                    className="shrink-0 px-1 py-0.5 bg-gray-800 hover:bg-gray-700 rounded text-[10px] text-gray-200"
                    title="Audition this clip"
                  >
                    ⏵
                  </button>
                  <input
                    type="text"
                    value={c.name}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onRename(c.id, e.target.value)}
                    className="flex-1 min-w-0 bg-transparent border-0 text-[11px] text-gray-200 truncate focus:outline-none focus:bg-gray-800 rounded px-1"
                    title={c.name}
                  />
                  <button
                    onClick={(e) => { e.stopPropagation(); onDelete(c.id) }}
                    className="shrink-0 px-1 py-0.5 bg-red-900/30 hover:bg-red-800/60 border border-red-800/40 rounded text-[10px] text-red-300"
                    title="Delete clip + any places of it"
                  >
                    ×
                  </button>
                </div>
                <div className="text-[10px] text-gray-500 font-mono mt-0.5 flex items-center gap-2">
                  <span className="px-1 bg-gray-800 rounded text-gray-400">{c.sourceLabel}</span>
                  {c.sourceId ? (
                    <span>{(c.endSec - c.startSec).toFixed(1)}s · {c.notesCount}n</span>
                  ) : (
                    <span>(uploaded) · {c.notesCount}n</span>
                  )}
                  {c.isPlaced && <span className="text-emerald-400">placed</span>}
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); onPlaceAtPlayhead(c.id) }}
                  className="mt-1 w-full text-[10px] px-1.5 py-1 bg-gray-800 hover:bg-gray-700 rounded text-gray-200"
                >
                  + place at playhead
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Wrapper>
  )
}
