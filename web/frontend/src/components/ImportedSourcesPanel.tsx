import type { ReactNode } from 'react'

interface SourceRow {
  id: string
  name: string
  spliceCount: number
  selected: boolean
}

interface Props {
  rows: SourceRow[]
  onSelect: (id: string | null) => void
  onOpenPicker: () => void
  onRename: (id: string, newId: string) => void
  onDelete: (id: string) => void
  Wrapper: ({ children, title, right, id }: { children: ReactNode; title: string; right?: ReactNode; id: string }) => ReactNode
}

export function ImportedSourcesPanel({
  rows, onSelect, onOpenPicker, onRename, onDelete, Wrapper,
}: Props) {
  return (
    <Wrapper
      id="imported-sources"
      title="Imported sources"
      right={rows.length > 0 ? (
        <span className="text-[10px] text-cyan-300 font-mono">{rows.length}</span>
      ) : undefined}
    >
      <ul className="space-y-1 mb-2">
        {/* Pseudo-row for the tutorial itself — selecting it shows the
            tutorial's own song waveform with no splicing. */}
        <li>
          <button
            onClick={() => onSelect(null)}
            className={`w-full px-2 py-1 text-left text-[11px] rounded border ${
              rows.every((r) => !r.selected)
                ? 'border-cyan-500 bg-cyan-900/15 text-cyan-200'
                : 'border-gray-800 bg-gray-900/40 text-gray-400 hover:bg-gray-800/60'
            }`}
            title="Show this tutorial's own song; cannot splice (it's the tutorial itself)"
          >
            &#9675; (this tutorial)
          </button>
        </li>
        {rows.map((r) => (
          <li
            key={r.id}
            className={`px-2 py-1 rounded border ${
              r.selected ? 'border-cyan-500 bg-cyan-900/15' : 'border-gray-800 bg-gray-900/40'
            }`}
          >
            <div className="flex items-center gap-1">
              <button
                onClick={() => onSelect(r.id)}
                className={`shrink-0 w-4 h-4 rounded-full text-[8px] font-mono ${
                  r.selected ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-500'
                }`}
                title="Make this source active for splicing"
              >
                {r.selected ? '◉' : '○'}
              </button>
              <input
                type="text"
                value={r.id}
                onChange={(e) => onRename(r.id, e.target.value)}
                className="flex-1 min-w-0 bg-transparent border-0 text-[11px] text-gray-200 font-mono truncate focus:outline-none focus:bg-gray-800 rounded px-1"
                title="Local id (a-z, 0-9, _) — propagates to MUSIC source= refs on save"
              />
              <button
                onClick={() => onDelete(r.id)}
                className="shrink-0 px-1 py-0.5 bg-red-900/30 hover:bg-red-800/60 border border-red-800/40 rounded text-[10px] text-red-300"
                title="Remove import + any splices that reference it"
              >
                &times;
              </button>
            </div>
            <div className="text-[10px] text-gray-500 truncate mt-0.5" title={r.name}>
              {r.name} &middot; {r.spliceCount} splice{r.spliceCount === 1 ? '' : 's'}
            </div>
          </li>
        ))}
      </ul>
      <button
        onClick={onOpenPicker}
        className="w-full text-[10px] px-2 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-gray-200"
      >
        + Import beatmap&hellip;
      </button>
    </Wrapper>
  )
}
