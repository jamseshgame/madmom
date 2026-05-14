import { useEffect, useState } from 'react'

interface Beatmap {
  id: string
  stem: string
  song_name?: string
  generated_at?: number
}

interface Track {
  id: string
  name: string
  artist?: string
  beatmaps?: Beatmap[]
}

interface Props {
  existingIds: string[]              // already-imported local ids; reject collisions
  onCancel: () => void
  onPick: (localId: string, trackId: string, beatmapId: string, displayName: string) => void
}

export function SourcePickerModal({ existingIds, onCancel, onPick }: Props) {
  const [tracks, setTracks] = useState<Track[]>([])
  const [selectedTrack, setSelectedTrack] = useState<Track | null>(null)
  const [selectedBeatmap, setSelectedBeatmap] = useState<Beatmap | null>(null)
  const [localId, setLocalId] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/tracks').then((r) => r.json()).then(setTracks).catch(() => undefined)
  }, [])

  // Escape closes the modal (matches the editor's other modals).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  useEffect(() => {
    if (!selectedTrack) return
    fetch(`/api/tracks/${selectedTrack.id}`)
      .then((r) => r.json())
      .then((data: Track) => setSelectedTrack(data))
      .catch(() => undefined)
  }, [selectedTrack?.id])  // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-suggest a local id.
  useEffect(() => {
    let n = 1
    while (existingIds.includes(`src_${String.fromCharCode(96 + n)}`) && n < 26) n++
    setLocalId(n <= 26 ? `src_${String.fromCharCode(96 + n)}` : `src_${Date.now().toString(36)}`)
  }, [existingIds.length])  // eslint-disable-line react-hooks/exhaustive-deps

  const validId = /^[a-z][a-z0-9_]*$/.test(localId) && !existingIds.includes(localId)

  const handleImport = () => {
    if (!selectedTrack || !selectedBeatmap || !validId) {
      setError(!validId ? 'Local id must match [a-z][a-z0-9_]* and be unique' : 'Pick a track and beatmap')
      return
    }
    onPick(
      localId,
      selectedTrack.id,
      selectedBeatmap.id,
      selectedBeatmap.song_name || selectedTrack.name,
    )
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center" onClick={onCancel}>
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 w-[640px] max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold text-gray-200 mb-3">Pick a beatmap to import</h2>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <div className="text-[10px] text-gray-500 uppercase mb-1">Tracks ({tracks.length})</div>
            <ul className="border border-gray-800 rounded h-64 overflow-y-auto">
              {tracks.map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => { setSelectedTrack(t); setSelectedBeatmap(null) }}
                    className={`w-full text-left px-2 py-1 text-[11px] ${
                      selectedTrack?.id === t.id ? 'bg-cyan-900/30 text-cyan-200' : 'text-gray-300 hover:bg-gray-800'
                    }`}
                  >
                    {t.name}
                    {t.artist && <span className="text-gray-600"> · {t.artist}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-[10px] text-gray-500 uppercase mb-1">Beatmaps</div>
            <ul className="border border-gray-800 rounded h-64 overflow-y-auto">
              {(selectedTrack?.beatmaps ?? []).map((bm) => (
                <li key={bm.id}>
                  <button
                    onClick={() => setSelectedBeatmap(bm)}
                    className={`w-full text-left px-2 py-1 text-[11px] ${
                      selectedBeatmap?.id === bm.id ? 'bg-cyan-900/30 text-cyan-200' : 'text-gray-300 hover:bg-gray-800'
                    }`}
                  >
                    {bm.stem}
                    {bm.song_name && <span className="text-gray-600"> · {bm.song_name}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] text-gray-500 uppercase tracking-wider">Local id</span>
          <input
            type="text"
            value={localId}
            onChange={(e) => { setLocalId(e.target.value); setError('') }}
            className={`bg-gray-800 border ${validId ? 'border-gray-700' : 'border-red-700'} rounded px-2 py-1 text-[11px] text-gray-200 w-32 font-mono`}
          />
          <span className="text-[10px] text-gray-600">a-z, 0-9, _ — must be unique</span>
        </div>
        {error && <p className="text-[11px] text-red-400 mb-2">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="text-[11px] px-3 py-1 bg-gray-800 hover:bg-gray-700 rounded text-gray-300">
            Cancel
          </button>
          <button
            onClick={handleImport}
            disabled={!selectedTrack || !selectedBeatmap || !validId}
            className="text-[11px] px-3 py-1 bg-cyan-700 hover:bg-cyan-600 disabled:opacity-40 rounded text-white"
          >
            Import
          </button>
        </div>
      </div>
    </div>
  )
}
