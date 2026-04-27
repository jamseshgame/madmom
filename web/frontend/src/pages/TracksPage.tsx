import { useCallback, useEffect, useRef, useState } from 'react'

interface Track {
  id: string
  name: string
  created_at: number
  stems: Record<string, string>
  stem_count: number
  model: string
  output_format: string
  artist: string
  album: string
  genre: string
  year: string
}

interface SongIniField {
  type: string
  default: unknown
  label: string
}

const STEM_COLORS: Record<string, string> = {
  vocals: 'text-pink-400',
  drums: 'text-amber-400',
  bass: 'text-green-400',
  guitar: 'text-orange-400',
  piano: 'text-violet-400',
  other: 'text-blue-400',
}

const STEM_LABELS: Record<string, string> = {
  vocals: 'Vocals',
  drums: 'Drums',
  bass: 'Bass',
  guitar: 'Guitar',
  piano: 'Piano',
  other: 'Other',
}

// Group song.ini fields for the form
const FIELD_GROUPS = [
  {
    title: 'Metadata',
    fields: ['name', 'artist', 'album', 'genre', 'year', 'charter', 'loading_phrase', 'icon', 'album_track', 'playlist_track'],
  },
  {
    title: 'Timing',
    fields: ['delay', 'preview_start_time', 'video_start_time', 'song_length'],
  },
  {
    title: 'Difficulty Ratings',
    fields: ['diff_guitar', 'diff_rhythm', 'diff_bass', 'diff_guitar_coop', 'diff_drums', 'diff_drums_real', 'diff_keys', 'diff_guitarghl', 'diff_bassghl'],
  },
  {
    title: 'Gameplay',
    fields: ['hopo_frequency', 'sustain_cutoff_threshold', 'five_lane_drums', 'modchart'],
  },
]

function BeatmapPanel({ track, stem, onClose }: { track: Track; stem: string; onClose: () => void }) {
  const [schema, setSchema] = useState<Record<string, SongIniField>>({})
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [generating, setGenerating] = useState(false)
  const [jobId, setJobId] = useState('')
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState('')
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [beatmapJobId, setBeatmapJobId] = useState('')

  useEffect(() => {
    fetch('/api/tracks/schema/song-ini')
      .then((r) => r.json())
      .then((s: Record<string, SongIniField>) => {
        setSchema(s)
        // Initialize values from schema defaults + track metadata
        const init: Record<string, unknown> = {}
        for (const [key, field] of Object.entries(s)) {
          init[key] = field.default
        }
        init.name = `${track.name} (${STEM_LABELS[stem] || stem})`
        init.artist = track.artist || 'Unknown'
        init.album = track.album || 'Unknown'
        init.genre = track.genre || 'Unknown'
        init.year = track.year || ''
        setValues(init)
      })
  }, [track, stem])

  const setValue = (key: string, val: unknown) => {
    setValues((prev) => ({ ...prev, [key]: val }))
  }

  const handleGenerate = async () => {
    setGenerating(true)
    setError('')
    setDone(false)

    const formData = new FormData()
    formData.append('stem', stem)
    for (const [key, val] of Object.entries(values)) {
      formData.append(key, String(val ?? ''))
    }

    try {
      const res = await fetch(`/api/tracks/${track.id}/generate-beatmap`, { method: 'POST', body: formData })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Failed')
      }
      const { job_id } = await res.json()
      setBeatmapJobId(job_id)
      setJobId(job_id)

      // SSE tracking
      const evtSource = new EventSource(`/api/beatmap/${job_id}/status`)
      evtSource.onmessage = (e) => {
        const data = JSON.parse(e.data)
        if (data.progress >= 0) setProgress(data.progress)
        setMessage(data.message)
        if (data.step === 'done') {
          evtSource.close()
          setDone(true)
          setGenerating(false)
        } else if (data.step === 'error') {
          evtSource.close()
          setError(data.message)
          setGenerating(false)
        }
      }
      evtSource.onerror = () => {
        evtSource.close()
        setError('Connection lost')
        setGenerating(false)
      }
    } catch (e) {
      setError((e as Error).message)
      setGenerating(false)
    }
  }

  const renderField = (key: string) => {
    const field = schema[key]
    if (!field) return null
    const val = values[key]

    if (field.type === 'bool') {
      return (
        <label key={key} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={!!val}
            onChange={(e) => setValue(key, e.target.checked)}
            className="rounded border-gray-600 bg-gray-800"
          />
          <span className="text-sm text-gray-300">{field.label}</span>
        </label>
      )
    }

    if (field.type === 'int') {
      return (
        <label key={key} className="block">
          <span className="text-xs text-gray-500">{field.label}</span>
          <input
            type="number"
            value={val as number}
            onChange={(e) => setValue(key, parseInt(e.target.value) || 0)}
            className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-jam-500"
          />
        </label>
      )
    }

    return (
      <label key={key} className="block">
        <span className="text-xs text-gray-500">{field.label}</span>
        <input
          type="text"
          value={(val as string) || ''}
          onChange={(e) => setValue(key, e.target.value)}
          className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-jam-500"
        />
      </label>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-start justify-center overflow-y-auto py-8">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl mx-4">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h3 className="text-lg font-semibold">
            Generate Beatmap — <span className={STEM_COLORS[stem] || 'text-gray-300'}>{STEM_LABELS[stem] || stem}</span>
          </h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">&times;</button>
        </div>

        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {FIELD_GROUPS.map((group) => (
            <div key={group.title}>
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{group.title}</h4>
              <div className="grid grid-cols-2 gap-3">
                {group.fields.map((f) => renderField(f))}
              </div>
            </div>
          ))}
        </div>

        <div className="p-5 border-t border-gray-800 space-y-3">
          {!done && !error && (
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="px-6 py-2.5 bg-jam-600 hover:bg-jam-500 disabled:opacity-50 text-white rounded-lg font-medium transition-colors"
            >
              {generating ? 'Generating...' : 'Generate Beatmap'}
            </button>
          )}

          {generating && jobId && (
            <div className="space-y-2">
              <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
                <div className="bg-jam-500 h-full rounded-full transition-all duration-500" style={{ width: `${Math.max(progress, 2)}%` }} />
              </div>
              <p className="text-xs text-gray-500">{message}</p>
            </div>
          )}

          {done && beatmapJobId && (
            <div className="flex flex-wrap gap-2">
              <a
                href={`/api/beatmap/${beatmapJobId}/download/zip`}
                className="px-5 py-2.5 bg-jam-600 hover:bg-jam-500 text-white rounded-lg font-medium transition-colors"
              >
                Download ZIP
              </a>
              <a
                href={`/api/beatmap/${beatmapJobId}/download/notes.chart`}
                className="px-5 py-2.5 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-lg font-medium transition-colors"
              >
                Download .chart
              </a>
            </div>
          )}

          {error && (
            <div className="bg-red-900/30 border border-red-800 rounded-lg p-3 text-sm text-red-400">{error}</div>
          )}
        </div>
      </div>
    </div>
  )
}

function InlinePublish({ track }: { track: Track }) {
  const [expanded, setExpanded] = useState(false)
  const [schema, setSchema] = useState<Record<string, SongIniField>>({})
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [publishing, setPublishing] = useState(false)
  const [result, setResult] = useState<{ commitUrl: string; folder: string } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!expanded) return
    fetch('/api/tracks/schema/song-ini')
      .then((r) => r.json())
      .then((s: Record<string, SongIniField>) => {
        setSchema(s)
        const init: Record<string, unknown> = {}
        for (const [key, field] of Object.entries(s)) {
          init[key] = field.default
        }
        init.name = track.name
        init.artist = track.artist || ''
        init.album = track.album || ''
        init.genre = track.genre || ''
        init.year = track.year || ''
        setValues(init)
      })
  }, [track, expanded])

  const setValue = (key: string, val: unknown) => {
    setValues((prev) => ({ ...prev, [key]: val }))
  }

  const handlePublish = async () => {
    setPublishing(true)
    setError('')
    try {
      const formData = new FormData()
      formData.append('song_ini', JSON.stringify(values))
      const res = await fetch(`/api/tracks/${track.id}/publish-game`, { method: 'POST', body: formData })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Publish failed')
      }
      const data = await res.json()
      setResult({ commitUrl: data.commit_url, folder: data.folder })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPublishing(false)
    }
  }

  const renderField = (key: string) => {
    const field = schema[key]
    if (!field) return null
    const val = values[key]

    if (field.type === 'bool') {
      return (
        <label key={key} className="flex items-center gap-2">
          <input type="checkbox" checked={!!val} onChange={(e) => setValue(key, e.target.checked)} className="rounded border-gray-600 bg-gray-800" />
          <span className="text-sm text-gray-300">{field.label}</span>
        </label>
      )
    }

    if (field.type === 'int') {
      return (
        <label key={key} className="block">
          <span className="text-xs text-gray-500">{field.label}</span>
          <input type="number" value={val as number} onChange={(e) => setValue(key, parseInt(e.target.value) || 0)} className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-jam-500" />
        </label>
      )
    }

    return (
      <label key={key} className="block">
        <span className="text-xs text-gray-500">{field.label}</span>
        <input type="text" value={(val as string) || ''} onChange={(e) => setValue(key, e.target.value)} className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-jam-500" />
      </label>
    )
  }

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="mt-3 w-full py-2.5 border border-green-800 bg-green-900/20 hover:bg-green-900/40 text-green-400 rounded-lg text-sm font-medium transition-colors"
      >
        Publish to Game
      </button>
    )
  }

  return (
    <div className="mt-4 border border-green-900/50 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="bg-green-900/20 px-4 py-3 flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold text-green-400">Publish to Game</h4>
          <p className="text-xs text-gray-500">Edit song.ini, then publish stems to GitHub</p>
        </div>
        <button onClick={() => setExpanded(false)} className="text-gray-500 hover:text-gray-300 text-lg">&times;</button>
      </div>

      {/* Stem mapping */}
      <div className="px-4 py-2 bg-gray-800/30 border-b border-gray-800">
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs font-mono text-gray-600">
          {Object.keys(track.stems).map((s) => {
            const gameName = ({ bass: 'rhythm', other: 'crowd' } as Record<string, string>)[s] || s
            return (
              <span key={s}>
                {s !== gameName ? `${s} → ` : ''}
                <span className={STEM_COLORS[s] || 'text-gray-400'}>{gameName}.ogg</span>
              </span>
            )
          })}
          <span>+ <span className="text-gray-300">song.ogg</span></span>
          <span>+ <span className="text-yellow-400">song.ini</span></span>
        </div>
      </div>

      {/* song.ini form */}
      <div className="p-4 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-yellow-400 text-xs font-mono">song.ini</span>
          <span className="text-gray-700 text-xs">[song]</span>
        </div>
        {FIELD_GROUPS.map((group) => (
          <div key={group.title}>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">{group.title}</h4>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {group.fields.map((f) => renderField(f))}
            </div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="px-4 py-3 border-t border-gray-800 space-y-3">
        {!result && (
          <button
            onClick={handlePublish}
            disabled={publishing}
            className="px-6 py-2.5 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white rounded-lg font-medium transition-colors"
          >
            {publishing ? 'Publishing...' : 'Publish to GitHub'}
          </button>
        )}

        {publishing && (
          <div className="flex items-center gap-2">
            <div className="animate-spin h-4 w-4 border-2 border-green-400 border-t-transparent rounded-full" />
            <span className="text-sm text-gray-400">Converting stems and pushing to GitHub...</span>
          </div>
        )}

        {result && (
          <div className="bg-green-900/20 border border-green-800 rounded-lg p-4 space-y-2">
            <p className="text-sm text-green-400 font-medium">Published!</p>
            <p className="text-xs text-gray-500 font-mono">{result.folder}</p>
            <a href={result.commitUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-jam-400 hover:text-jam-300 underline">
              View commit on GitHub
            </a>
          </div>
        )}

        {error && (
          <div className="bg-red-900/30 border border-red-800 rounded-lg p-3 text-sm text-red-400">{error}</div>
        )}
      </div>
    </div>
  )
}

// Keys that historically appeared in stems map but aren't audio
const NON_AUDIO_KEYS = new Set(['song_ini', 'album_png'])

export default function TracksPage() {
  const [tracks, setTracks] = useState<Track[]>([])
  const [loading, setLoading] = useState(true)
  const [beatmapPanel, setBeatmapPanel] = useState<{ track: Track; stem: string } | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Track | null>(null)
  const [deleting, setDeleting] = useState(false)

  // song.ini editor state for the detail view
  const [songIni, setSongIni] = useState<Record<string, string>>({})
  const [iniSaveState, setIniSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [iniError, setIniError] = useState('')
  const [albumArtFile, setAlbumArtFile] = useState<File | null>(null)
  const [albumPreview, setAlbumPreview] = useState<string | null>(null)
  const albumInputRef = useRef<HTMLInputElement | null>(null)
  const updateIni = (key: string, value: string) =>
    setSongIni((prev) => ({ ...prev, [key]: value }))
  const handleAlbumPick = (f: File | null) => {
    if (!f) return
    if (albumPreview && albumPreview.startsWith('blob:')) URL.revokeObjectURL(albumPreview)
    setAlbumArtFile(f)
    setAlbumPreview(URL.createObjectURL(f))
  }

  const loadTracks = useCallback(() => {
    fetch('/api/tracks')
      .then((r) => r.json())
      .then((data) => {
        setTracks(data)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => { loadTracks() }, [loadTracks])

  // Whenever the user selects a different track, hydrate the metadata panel
  useEffect(() => {
    if (!selectedId) {
      if (albumPreview && albumPreview.startsWith('blob:')) URL.revokeObjectURL(albumPreview)
      setSongIni({})
      setAlbumArtFile(null)
      setAlbumPreview(null)
      setIniSaveState('idle')
      setIniError('')
      return
    }
    const track = tracks.find((t) => t.id === selectedId)
    if (!track) return
    fetch(`/api/tracks/${selectedId}/song-ini`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((data: Record<string, unknown>) => {
        const out: Record<string, string> = {}
        for (const [k, v] of Object.entries(data)) out[k] = String(v ?? '')
        // Fall back to track-level metadata when song.ini is missing fields
        if (!out.name && track.name) out.name = track.name
        if (!out.artist && track.artist) out.artist = track.artist
        if (!out.album && track.album) out.album = track.album
        if (!out.genre && track.genre) out.genre = track.genre
        if (!out.year && track.year) out.year = track.year
        setSongIni(out)
      })
      .catch(() => setSongIni({}))

    if (track.stems.album_png) {
      setAlbumPreview(`/api/tracks/${selectedId}/stems/album_png`)
    } else {
      setAlbumPreview(null)
    }
    setAlbumArtFile(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, tracks])

  const saveTrackSongIni = async () => {
    if (!selectedId) return
    setIniSaveState('saving')
    setIniError('')
    try {
      const fd = new FormData()
      fd.append('fields', JSON.stringify(songIni))
      if (albumArtFile) fd.append('album_art', albumArtFile)
      const res = await fetch(`/api/tracks/${selectedId}/song-ini`, { method: 'PATCH', body: fd })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Save failed: ${res.status}`)
      }
      const updated = await res.json()
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(updated)) out[k] = String(v ?? '')
      setSongIni(out)
      if (albumArtFile) {
        if (albumPreview && albumPreview.startsWith('blob:')) URL.revokeObjectURL(albumPreview)
        setAlbumArtFile(null)
        setAlbumPreview(`/api/tracks/${selectedId}/stems/album_png?t=${Date.now()}`)
      }
      setIniSaveState('saved')
      setTimeout(() => setIniSaveState('idle'), 2000)
      // Refresh track list so the row reflects new name/artist
      loadTracks()
    } catch (e) {
      setIniError((e as Error).message)
      setIniSaveState('error')
    }
  }

  const handleDelete = async (id: string) => {
    await fetch(`/api/tracks/${id}`, { method: 'DELETE' })
    loadTracks()
  }

  const performConfirmedDelete = async () => {
    if (!confirmDelete) return
    setDeleting(true)
    try {
      await handleDelete(confirmDelete.id)
      setSelectedId(null)
      setConfirmDelete(null)
    } finally {
      setDeleting(false)
    }
  }

  const formatDate = (ts: number) => {
    return new Date(ts * 1000).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  const selectedTrack = tracks.find((t) => t.id === selectedId) || null

  if (selectedTrack) {
    return (
      <div className="space-y-6">
        <button
          onClick={() => setSelectedId(null)}
          className="text-sm text-gray-400 hover:text-gray-200 transition-colors"
        >
          ← Back to library
        </button>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h3 className="font-semibold text-gray-100 text-lg">{selectedTrack.name}</h3>
              <p className="text-xs text-gray-600 mt-0.5">
                {formatDate(selectedTrack.created_at)} &middot; {selectedTrack.model} &middot;{' '}
                {selectedTrack.output_format.toUpperCase()}
              </p>
            </div>
            <button
              onClick={() => setConfirmDelete(selectedTrack)}
              className="px-3 py-1.5 bg-red-900/40 hover:bg-red-800/60 border border-red-800/60 hover:border-red-700 text-red-300 hover:text-red-200 rounded-md text-xs font-medium transition-colors"
            >
              Delete track
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {Object.entries(selectedTrack.stems)
              .filter(([stem]) => !NON_AUDIO_KEYS.has(stem))
              .map(([stem]) => (
                <div
                  key={stem}
                  className="bg-gray-800 border border-gray-700 rounded-lg p-3 flex flex-col items-center gap-2"
                >
                  <span className={`text-sm font-semibold ${STEM_COLORS[stem] || 'text-gray-300'}`}>
                    {STEM_LABELS[stem] || stem}
                  </span>
                  <div className="flex flex-wrap gap-1.5 justify-center">
                    <a
                      href={`/api/tracks/${selectedTrack.id}/stems/${stem}`}
                      className="px-2 py-1 bg-gray-700 text-gray-300 hover:bg-gray-600 rounded text-xs font-medium transition-colors"
                    >
                      Download
                    </a>
                    <button
                      onClick={() => setBeatmapPanel({ track: selectedTrack, stem })}
                      className="px-2 py-1 bg-green-700/60 hover:bg-green-600/70 text-green-200 rounded text-xs font-medium transition-colors"
                    >
                      Beatmap
                    </button>
                  </div>
                </div>
              ))}
          </div>

          <div className="mt-6 bg-gray-950 border border-gray-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-yellow-400 text-xs font-mono">song.ini</span>
                <span className="text-gray-600 text-xs">[song]</span>
              </div>
              <div className="flex items-center gap-3">
                {iniSaveState === 'saved' && (
                  <span className="text-xs text-emerald-400">Saved</span>
                )}
                {iniSaveState === 'error' && (
                  <span className="text-xs text-red-400">{iniError}</span>
                )}
                <button
                  onClick={saveTrackSongIni}
                  disabled={iniSaveState === 'saving'}
                  className="px-3 py-1.5 bg-jam-600 hover:bg-jam-500 disabled:opacity-40 text-white rounded-md text-xs font-medium"
                >
                  {iniSaveState === 'saving' ? 'Saving...' : 'Save metadata'}
                </button>
              </div>
            </div>

            {/* Album art */}
            <div className="flex gap-4 items-start">
              <button
                type="button"
                onClick={() => albumInputRef.current?.click()}
                className="group relative w-24 h-24 shrink-0 rounded-lg overflow-hidden border border-gray-700 hover:border-jam-500 bg-gray-800"
                title="Click to replace album.png"
              >
                {albumPreview ? (
                  <>
                    <img src={albumPreview} alt="album" className="w-full h-full object-cover" />
                    <span className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-xs text-gray-200">
                      Change
                    </span>
                  </>
                ) : (
                  <span className="w-full h-full flex items-center justify-center text-xs text-gray-500 px-2 text-center">
                    Click to add<br />album.png
                  </span>
                )}
              </button>
              <input
                ref={albumInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => handleAlbumPick(e.target.files?.[0] ?? null)}
              />
              <div className="text-xs text-gray-500 mt-1">
                <p>
                  <span className="text-gray-400 font-mono">album.png</span> — included in the published game folder.
                </p>
                <p className="text-gray-600 mt-1">Any image is resized to 512×512 PNG on save.</p>
              </div>
            </div>

            {/* Primary fields */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {([
                ['name', 'name *'],
                ['artist', 'artist *'],
              ] as const).map(([key, label]) => (
                <label key={key} className="block">
                  <span className="text-xs text-gray-400">{label}</span>
                  <input
                    type="text"
                    value={songIni[key] ?? ''}
                    onChange={(e) => updateIni(key, e.target.value)}
                    className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-jam-500"
                  />
                </label>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {(['album', 'genre', 'year'] as const).map((key) => (
                <label key={key} className="block">
                  <span className="text-xs text-gray-400">{key}</span>
                  <input
                    type="text"
                    value={songIni[key] ?? ''}
                    onChange={(e) => updateIni(key, e.target.value)}
                    className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-jam-500"
                  />
                </label>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(['charter', 'loading_phrase'] as const).map((key) => (
                <label key={key} className="block">
                  <span className="text-xs text-gray-400">{key}</span>
                  <input
                    type="text"
                    value={songIni[key] ?? ''}
                    onChange={(e) => updateIni(key, e.target.value)}
                    className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-jam-500"
                  />
                </label>
              ))}
            </div>

            {/* Timing */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {([
                ['delay', 'delay (ms)'],
                ['song_length', 'song_length (ms)'],
                ['preview_start_time', 'preview_start_time (ms)'],
              ] as const).map(([key, label]) => (
                <label key={key} className="block">
                  <span className="text-xs text-gray-400">{label}</span>
                  <input
                    type="number"
                    value={songIni[key] ?? ''}
                    onChange={(e) => updateIni(key, e.target.value)}
                    className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-jam-500"
                  />
                </label>
              ))}
            </div>

            {/* Difficulties */}
            <div>
              <span className="text-xs text-gray-500 block mb-2">Difficulties</span>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                {(['diff_band', 'diff_guitar', 'diff_drums', 'diff_bass', 'diff_rhythm', 'diff_keys'] as const).map(
                  (key) => (
                    <label key={key} className="block">
                      <span className="text-xs text-gray-600">{key.replace('diff_', '')}</span>
                      <input
                        type="number"
                        min="-1"
                        max="6"
                        value={songIni[key] ?? ''}
                        onChange={(e) => updateIni(key, e.target.value)}
                        className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 text-center focus:outline-none focus:border-jam-500"
                      />
                    </label>
                  ),
                )}
              </div>
              <span className="text-xs text-gray-700 mt-1 block">-1 = uncharted, 0–6 = difficulty tier</span>
            </div>
          </div>

          <InlinePublish track={selectedTrack} />
        </div>

        {beatmapPanel && (
          <BeatmapPanel
            track={beatmapPanel.track}
            stem={beatmapPanel.stem}
            onClose={() => setBeatmapPanel(null)}
          />
        )}

        {confirmDelete && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center px-4">
            <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-6 space-y-4">
              <h3 className="text-lg font-semibold text-gray-100">Delete this track?</h3>
              <p className="text-sm text-gray-400">
                <span className="text-gray-200 font-medium">{confirmDelete.name}</span> and all of its
                stems, song.ini, and album art will be permanently removed. This cannot be undone.
              </p>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setConfirmDelete(null)}
                  disabled={deleting}
                  className="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-200 rounded-lg text-sm font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={performConfirmedDelete}
                  disabled={deleting}
                  className="px-4 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  {deleting ? 'Deleting...' : 'Delete track'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Studio Library</h1>
        <p className="text-gray-500 mt-1">Saved stems from previous separations. Click a track to view details.</p>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-gray-400">
          <div className="animate-spin h-5 w-5 border-2 border-jam-400 border-t-transparent rounded-full" />
          Loading tracks...
        </div>
      )}

      {!loading && tracks.length === 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
          <p className="text-gray-400">No tracks saved yet.</p>
          <p className="text-gray-600 text-sm mt-1">Separate a track on the Create page to save it here.</p>
        </div>
      )}

      <div className="space-y-2">
        {tracks.map((track) => {
          const stemCount = Object.entries(track.stems).filter(
            ([k]) => !NON_AUDIO_KEYS.has(k),
          ).length
          const hasArt = !!track.stems.album_png
          return (
            <button
              key={track.id}
              onClick={() => setSelectedId(track.id)}
              className="w-full text-left bg-gray-900 border border-gray-800 hover:border-gray-700 hover:bg-gray-900/70 rounded-xl px-4 py-3 transition-colors"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-12 h-12 shrink-0 rounded-md overflow-hidden bg-gray-800 border border-gray-700 flex items-center justify-center">
                    {hasArt ? (
                      <img
                        src={`/api/tracks/${track.id}/stems/album_png`}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-gray-600 text-[10px] font-mono">no art</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-medium text-gray-100 truncate">{track.name}</h3>
                    <p className="text-xs text-gray-600 mt-0.5">
                      {formatDate(track.created_at)} &middot; {track.model} &middot;{' '}
                      {track.output_format.toUpperCase()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-gray-500">{stemCount} stems</span>
                  <span className="text-gray-600">→</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
