import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import FileUpload from './FileUpload.tsx'
import ProgressTracker from './ProgressTracker.tsx'
import StemResult from './StemResult.tsx'

type Phase = 'upload' | 'settings' | 'separating' | 'done' | 'error'

const MODELS: Record<string, { label: string; description: string; stems: string[] }> = {
  htdemucs_6s: {
    label: 'Extended (6 stems)',
    description: 'Vocals, drums, bass, guitar, piano, other',
    stems: ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'],
  },
  htdemucs_ft: {
    label: 'Fine-tuned (4 stems)',
    description: 'Higher quality — vocals, drums, bass, other',
    stems: ['vocals', 'drums', 'bass', 'other'],
  },
  htdemucs: {
    label: 'Standard (4 stems)',
    description: 'Vocals, drums, bass, other',
    stems: ['vocals', 'drums', 'bass', 'other'],
  },
}

const STEM_META: Record<string, { label: string; color: string }> = {
  vocals: { label: 'Vocals', color: 'text-pink-400' },
  drums: { label: 'Drums', color: 'text-amber-400' },
  bass: { label: 'Bass', color: 'text-green-400' },
  guitar: { label: 'Guitar', color: 'text-orange-400' },
  piano: { label: 'Piano', color: 'text-violet-400' },
  other: { label: 'Other', color: 'text-blue-400' },
}

function BlankTutorialButton() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('Tutorial')
  const [artist, setArtist] = useState('Jamsesh')
  const [bpm, setBpm] = useState(120)
  const [duration, setDuration] = useState(300)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    setCreating(true)
    setError('')
    try {
      const fd = new FormData()
      fd.append('name', name.trim() || 'Tutorial')
      fd.append('artist', artist.trim() || 'Jamsesh')
      fd.append('bpm', String(bpm))
      fd.append('duration_seconds', String(duration))
      const res = await fetch('/api/tracks/blank-tutorial', { method: 'POST', body: fd })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Failed (${res.status})`)
      }
      const data = await res.json()
      setOpen(false)
      navigate(`/edit/${data.track_id}/${data.beatmap_id}`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCreating(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm text-gray-500 hover:text-purple-300 underline-offset-2 hover:underline transition-colors"
      >
        Create a blank tutorial — no audio file
      </button>
      <p className="text-[11px] text-gray-700 mt-1">
        Empty chart with <span className="text-gray-500 font-mono">[TutorialScript]</span> ready for VOs and steps.
      </p>

      {open && (
        <div
          className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center px-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false)
          }}
        >
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-5 space-y-4">
            <div>
              <h3 className="text-lg font-semibold text-purple-300">New blank tutorial</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Creates a track with a silent placeholder song.ogg + an empty
                beatmap. You'll land in the editor with tutorial mode on.
              </p>
            </div>
            <label className="block">
              <span className="text-xs text-gray-400">Title</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Tutorial"
                autoFocus
                className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-purple-500"
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-400">Author / charter</span>
              <input
                type="text"
                value={artist}
                onChange={(e) => setArtist(e.target.value)}
                placeholder="Jamsesh"
                className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-purple-500"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs text-gray-400">BPM</span>
                <input
                  type="number"
                  min={40}
                  max={240}
                  value={bpm}
                  onChange={(e) => setBpm(Math.max(40, Math.min(240, Number(e.target.value) || 120)))}
                  className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-purple-500"
                />
              </label>
              <label className="block">
                <span className="text-xs text-gray-400">Duration (seconds)</span>
                <input
                  type="number"
                  min={30}
                  max={1800}
                  step={30}
                  value={duration}
                  onChange={(e) => setDuration(Math.max(30, Math.min(1800, Number(e.target.value) || 300)))}
                  className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-purple-500"
                />
              </label>
            </div>
            {error && <div className="text-xs text-red-400">{error}</div>}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setOpen(false)}
                disabled={creating}
                className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-md text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={creating || !name.trim()}
                className="px-4 py-1.5 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white rounded-md text-sm font-medium transition-colors"
              >
                {creating ? 'Creating…' : 'Create + open editor'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

interface YouTubeResult {
  video_id: string
  title: string
  channel: string
  duration: number
  thumbnail: string
  url: string
}

function YouTubeSearch({ onPicked }: { onPicked: (file: File) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<YouTubeResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [pulling, setPulling] = useState<{ videoId: string; jobId: string; progress: number; message: string } | null>(null)
  const [pullError, setPullError] = useState('')

  const runSearch = async () => {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    setSearchError('')
    setResults(null)
    try {
      const res = await fetch(`/api/youtube/search?q=${encodeURIComponent(q)}&limit=10`)
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Search failed (${res.status})`)
      }
      const data = (await res.json()) as YouTubeResult[]
      setResults(data)
    } catch (e) {
      setSearchError((e as Error).message)
    } finally {
      setSearching(false)
    }
  }

  const pickResult = async (r: YouTubeResult) => {
    setPullError('')
    setPulling({ videoId: r.video_id, jobId: '', progress: 0, message: 'Starting…' })
    try {
      const fd = new FormData()
      fd.append('video_id', r.video_id)
      const res = await fetch('/api/youtube/download', { method: 'POST', body: fd })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Download failed (${res.status})`)
      }
      const { job_id } = await res.json()
      setPulling((p) => (p ? { ...p, jobId: job_id } : null))

      const es = new EventSource(`/api/jobs/${job_id}/events`)
      es.onmessage = async (e) => {
        const d = JSON.parse(e.data)
        if (d.progress >= 0) {
          setPulling((p) => (p ? { ...p, progress: d.progress } : null))
        }
        if (d.message) {
          setPulling((p) => (p ? { ...p, message: d.message } : null))
        }
        if (d.step === 'done' && d.metadata) {
          es.close()
          try {
            const fileRes = await fetch(`/api/youtube/${job_id}/file`)
            if (!fileRes.ok) throw new Error(`File fetch failed (${fileRes.status})`)
            const blob = await fileRes.blob()
            const safeTitle = (d.metadata.title as string || r.title)
              .replace(/[\\/:*?"<>|]/g, '-')
              .slice(0, 100)
            const file = new File([blob], `${safeTitle}.mp3`, { type: 'audio/mpeg' })
            setPulling(null)
            setResults(null)
            setQuery('')
            onPicked(file)
          } catch (fe) {
            setPullError((fe as Error).message)
            setPulling(null)
          }
        } else if (d.step === 'error' || d.step === 'cancelled') {
          es.close()
          setPullError(d.message || `Job ${d.step}`)
          setPulling(null)
        }
      }
      es.onerror = () => {
        es.close()
        setPullError('SSE connection lost')
        setPulling(null)
      }
    } catch (e) {
      setPullError((e as Error).message)
      setPulling(null)
    }
  }

  const fmtDuration = (s: number) => {
    if (!s) return '–'
    const m = Math.floor(s / 60)
    const ss = Math.floor(s % 60)
    return `${m}:${ss.toString().padStart(2, '0')}`
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-red-500 text-lg leading-none">▶</span>
        <span className="text-sm font-semibold text-gray-200">Search YouTube</span>
        <span className="text-xs text-gray-600">Pull a track straight from a video — converted to MP3 and ready to split.</span>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          runSearch()
        }}
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Artist + title, e.g. Everfall Crashing Down"
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-jam-500"
        />
        <button
          type="submit"
          disabled={searching || !query.trim() || !!pulling}
          className="px-4 py-2 bg-jam-600 hover:bg-jam-500 disabled:opacity-40 text-white rounded-lg text-sm font-medium transition-colors"
        >
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>
      {searchError && <div className="text-xs text-red-400">{searchError}</div>}
      {pullError && <div className="text-xs text-red-400">{pullError}</div>}

      {pulling && (
        <div className="bg-gray-800/60 border border-gray-700 rounded-lg p-3 space-y-2">
          <div className="text-xs text-gray-300">{pulling.message}</div>
          <div className="w-full bg-gray-900 rounded-full h-1.5 overflow-hidden">
            <div className="bg-jam-500 h-full rounded-full transition-all duration-500" style={{ width: `${Math.max(pulling.progress, 2)}%` }} />
          </div>
          {pulling.jobId && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-gray-500 font-mono">job {pulling.jobId}</span>
              <button
                type="button"
                onClick={async () => {
                  if (pulling.jobId) {
                    try {
                      await fetch(`/api/jobs/${pulling.jobId}/cancel`, { method: 'POST' })
                    } catch {
                      // best-effort
                    }
                  }
                }}
                className="px-2 py-0.5 bg-red-900/40 hover:bg-red-800/60 border border-red-800 text-red-300 hover:text-red-200 rounded text-[11px] font-medium transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {results && results.length === 0 && !pulling && (
        <div className="text-xs text-gray-500">No results for "{query}".</div>
      )}
      {results && results.length > 0 && !pulling && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {results.map((r) => (
            <button
              key={r.video_id}
              type="button"
              onClick={() => pickResult(r)}
              className="text-left flex gap-2 p-2 bg-gray-800/40 hover:bg-gray-800 border border-gray-800 hover:border-gray-700 rounded-lg transition-colors"
              title="Download MP3 and use as input"
            >
              <div className="w-24 h-14 shrink-0 rounded overflow-hidden bg-gray-900 flex items-center justify-center">
                {r.thumbnail ? (
                  <img src={r.thumbnail} alt="" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-[10px] text-gray-600">no thumb</span>
                )}
              </div>
              <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5">
                <span className="text-xs font-medium text-gray-200 line-clamp-2 leading-tight">{r.title}</span>
                <span className="text-[11px] text-gray-500 truncate">
                  {r.channel} {r.duration ? `· ${fmtDuration(r.duration)}` : ''}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function CreateSection({ onSaved }: { onSaved?: () => void } = {}) {
  const [searchParams, setSearchParams] = useSearchParams()
  const resumeJobId = searchParams.get('job') || ''

  const [phase, setPhase] = useState<Phase>(resumeJobId ? 'separating' : 'upload')
  const [file, setFile] = useState<File | null>(null)
  const [jobId, setJobId] = useState(resumeJobId)
  const [metadata, setMetadata] = useState<Record<string, unknown>>({})
  const [error, setError] = useState('')

  // Settings
  const [model, setModel] = useState('htdemucs_6s')
  const [selectedStems, setSelectedStems] = useState<Set<string>>(new Set(MODELS.htdemucs_6s.stems))
  // shifts trades quality for time linearly — every additional shift is another full
  // inference pass over the audio. The Demucs paper's ablation plateaus around 2;
  // for game stems the quality bump beyond that is inaudible. Crank it up via the
  // slider if you really need it.
  const [shifts, setShifts] = useState(2)
  const [overlap, setOverlap] = useState(0.25)
  const [clipMode, setClipMode] = useState('rescale')
  const [loadingMeta, setLoadingMeta] = useState(false)
  const [albumArt, setAlbumArt] = useState<File | null>(null)
  const [albumPreview, setAlbumPreview] = useState<string | null>(null)
  const albumInputRef = useRef<HTMLInputElement | null>(null)
  const [mode, setMode] = useState<'generate' | 'manual'>('generate')
  const [manualStems, setManualStems] = useState<Record<string, File | null>>({
    vocals: null,
    drums: null,
    bass: null,
    guitar: null,
    piano: null,
    other: null,
  })
  const [songIni, setSongIni] = useState({
    name: '',
    artist: '',
    album: '',
    genre: '',
    year: '',
    charter: '',
    song_length: '',
    delay: '0',
    preview_start_time: '0',
    diff_band: '0',
    diff_guitar: '0',
    diff_drums: '0',
    diff_bass: '0',
    diff_rhythm: '0',
    diff_keys: '0',
    loading_phrase: '',
  })

  const updateIni = (key: string, value: string) => {
    setSongIni((prev) => ({ ...prev, [key]: value }))
  }

  // If the URL carries ?job=<id>, hydrate from the persisted backend record so
  // the user lands directly on the running progress / completed result view.
  useEffect(() => {
    if (!resumeJobId) return
    let cancelled = false
    fetch(`/api/jobs/${resumeJobId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((data) => {
        if (cancelled) return
        if (data.kind === 'beatmap') {
          // Beatmap jobs don't run inside CreateSection — drop the param and
          // fall back to the upload screen so the user isn't stranded.
          setSearchParams({}, { replace: true })
          setPhase('upload')
          return
        }
        const status = data.status
        if (status === 'done') {
          setMetadata(data.metadata || {})
          setPhase('done')
        } else if (status === 'failed' || status === 'cancelled') {
          setError(data.error || data.last_message || 'Job failed')
          setPhase('error')
        } else {
          setPhase('separating')
        }
      })
      .catch(() => {
        if (cancelled) return
        // Job ID points to nothing — clear the param and reset to upload
        setSearchParams({}, { replace: true })
        setPhase('upload')
        setJobId('')
      })
    return () => {
      cancelled = true
    }
  }, [resumeJobId, setSearchParams])

  const handleFile = async (f: File) => {
    // Filename fallback for name/artist
    const stem = f.name.replace(/\.[^.]+$/, '')
    const parts = stem.split(/\s*-\s*/)
    const fallback: Partial<typeof songIni> =
      parts.length >= 2
        ? { artist: parts[0].trim(), name: parts.slice(1).join(' - ').trim() }
        : { name: stem }
    setSongIni((prev) => ({ ...prev, ...fallback }))
    setFile(f)
    setPhase('settings')

    // Fetch real tags from the file via ffprobe, plus embedded cover art
    setLoadingMeta(true)
    const fd = new FormData()
    fd.append('file', f)
    try {
      const [metaRes, artRes] = await Promise.all([
        fetch('/api/beatmap/metadata', { method: 'POST', body: fd }),
        fetch('/api/beatmap/cover-art', { method: 'POST', body: (() => {
          const a = new FormData()
          a.append('file', f)
          return a
        })() }),
      ])
      if (metaRes.ok) {
        const m = (await metaRes.json()) as {
          title?: string
          artist?: string
          album?: string
          year?: string
          genre?: string
          duration?: number
        }
        setSongIni((prev) => ({
          ...prev,
          name: m.title || prev.name,
          artist: m.artist || prev.artist,
          album: m.album || prev.album,
          year: m.year || prev.year,
          genre: m.genre || prev.genre,
          song_length: m.duration ? String(Math.round(m.duration * 1000)) : prev.song_length,
        }))
      }
      if (artRes.ok && artRes.status !== 204) {
        const blob = await artRes.blob()
        if (blob.size > 0) {
          const artFile = new File([blob], 'album.png', { type: 'image/png' })
          setAlbumArt(artFile)
          setAlbumPreview(URL.createObjectURL(blob))
        }
      }
    } catch {
      // Non-fatal — keep filename fallback, no cover art
    } finally {
      setLoadingMeta(false)
    }
  }

  const handleAlbumArtSelect = (f: File | null) => {
    if (!f) return
    setAlbumArt(f)
    if (albumPreview) URL.revokeObjectURL(albumPreview)
    setAlbumPreview(URL.createObjectURL(f))
  }

  const handleModelChange = (m: string) => {
    setModel(m)
    setSelectedStems(new Set(MODELS[m].stems))
  }

  const toggleStem = (stem: string) => {
    setSelectedStems((prev) => {
      const next = new Set(prev)
      if (next.has(stem)) {
        if (next.size > 1) next.delete(stem)
      } else {
        next.add(stem)
      }
      return next
    })
  }

  const handleSeparate = async () => {
    if (mode === 'generate' && !file) return
    setPhase('separating')
    setError('')

    const formData = new FormData()
    if (file) formData.append('file', file)
    formData.append('song_ini', JSON.stringify(songIni))
    if (albumArt) formData.append('album_art', albumArt)

    let endpoint: string
    if (mode === 'manual') {
      const provided = Object.entries(manualStems).filter(([, f]) => f)
      if (provided.length === 0) {
        setError('Upload at least one stem file before continuing.')
        setPhase('error')
        return
      }
      if (!file && provided.length < 2) {
        setError('Need at least 2 stems to synthesise song.ogg without a master mix.')
        setPhase('error')
        return
      }
      for (const [stem, f] of provided) if (f) formData.append(stem, f)
      endpoint = '/api/stems/manual'
    } else {
      formData.append('model', model)
      formData.append('stems', Array.from(selectedStems).join(','))
      formData.append('shifts', String(shifts))
      formData.append('overlap', String(overlap))
      formData.append('clip_mode', clipMode)
      formData.append('game_ready', 'true')
      endpoint = '/api/stems/separate'
    }

    try {
      const res = await fetch(endpoint, { method: 'POST', body: formData })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Upload failed')
      }
      const { job_id } = await res.json()
      setJobId(job_id)
      // Pin the running job to the URL so the tab can be closed/shared/reopened
      setSearchParams({ job: job_id }, { replace: true })
    } catch (e) {
      setError((e as Error).message)
      setPhase('error')
    }
  }

  const handleDone = useCallback((meta: Record<string, unknown>) => {
    setMetadata(meta)
    setPhase('done')
    if (onSaved) onSaved()
  }, [onSaved])

  const handleKill = async () => {
    const id = jobId
    reset()
    if (id) {
      try {
        await fetch(`/api/jobs/${id}/cancel`, { method: 'POST' })
      } catch {
        // best-effort; backend may already be gone
      }
    }
  }

  const handleError = useCallback((msg: string) => {
    setError(msg)
    setPhase('error')
  }, [])

  const reset = () => {
    setPhase('upload')
    setFile(null)
    setJobId('')
    setMetadata({})
    setError('')
    setModel('htdemucs_6s')
    setSelectedStems(new Set(MODELS.htdemucs_6s.stems))
    setShifts(2)
    setOverlap(0.25)
    setClipMode('rescale')
    if (albumPreview) URL.revokeObjectURL(albumPreview)
    setAlbumArt(null)
    setAlbumPreview(null)
    setMode('generate')
    setManualStems({ vocals: null, drums: null, bass: null, guitar: null, piano: null, other: null })
    if (searchParams.get('job')) {
      setSearchParams({}, { replace: true })
    }
  }

  const currentModelStems = MODELS[model]?.stems || []

  return (
    <div className="space-y-8">
      {phase === 'upload' && (
        <>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
            <div>
              <h1 className="text-2xl font-bold text-gray-100">Welcome to Jamsesh Studio</h1>
              <p className="text-sm text-gray-400 mt-1">
                Turn any track into game-ready stems and beatmaps for Jamsesh.
              </p>
            </div>
            <ul className="space-y-2.5 text-sm">
              <li className="flex gap-3">
                <span className="shrink-0 w-28 px-2 py-0.5 rounded-md bg-jam-600/15 text-jam-300 text-xs font-medium text-center">
                  Studio Library
                </span>
                <span className="text-gray-400">
                  Drop a song below to split it into stems with Demucs (or upload your own).
                  Browse saved tracks, edit song.ini, generate beatmaps, and publish finished
                  songs to the Jamsesh game repo.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="shrink-0 w-28 px-2 py-0.5 rounded-md bg-gray-800 text-gray-300 text-xs font-medium text-center">
                  Game Library
                </span>
                <span className="text-gray-400">
                  View every song already published to the game repo. Edit metadata in place and
                  push the update straight back to GitHub.
                </span>
              </li>
            </ul>
          </div>
          <YouTubeSearch onPicked={handleFile} />
          <FileUpload accept=".flac,.mp3,.ogg,.wav,.m4a,.aac,.wma" label="Drop your audio file here" onFile={handleFile} />
          <div className="text-center">
            <button
              type="button"
              onClick={() => {
                setMode('manual')
                setFile(null)
                setPhase('settings')
              }}
              className="text-sm text-gray-500 hover:text-jam-300 underline-offset-2 hover:underline transition-colors"
            >
              I only have stems — no master mix
            </button>
            <p className="text-[11px] text-gray-700 mt-1">
              We'll mux the stems together to synthesise song.ogg.
            </p>
            <div className="mt-4 pt-4 border-t border-gray-800/60">
              <BlankTutorialButton />
            </div>
          </div>
        </>
      )}

      {phase === 'settings' && (file || mode === 'manual') && (
        <div className="space-y-6">
          {/* File info — only when a master file is present */}
          {file && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex items-center justify-between gap-4">
              <p className="text-sm text-gray-400">
                File: <span className="text-gray-200">{file.name}</span>{' '}
                <span className="text-gray-600">({(file.size / 1024 / 1024).toFixed(1)} MB)</span>
              </p>
              {loadingMeta && (
                <span className="flex items-center gap-2 text-xs text-gray-500">
                  <span className="animate-spin h-3.5 w-3.5 border-2 border-jam-400 border-t-transparent rounded-full" />
                  Reading metadata...
                </span>
              )}
            </div>
          )}

          {!file && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center justify-between gap-4">
              <p className="text-sm text-gray-400">
                <span className="text-gray-200 font-medium">Stems-only mode.</span>{' '}
                The uploaded stems will be summed into{' '}
                <span className="text-gray-300 font-mono">song.ogg</span> automatically.
              </p>
            </div>
          )}

          {/* Source mode — only meaningful when a master is present */}
          {file && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-2 flex gap-1">
              {(
                [
                  { key: 'generate', label: 'Generate stems', sub: 'Run Demucs to split the master' },
                  { key: 'manual', label: 'Upload stems', sub: 'Bring your own stems; master becomes song.ogg' },
                ] as const
              ).map((opt) => {
                const active = mode === opt.key
                return (
                  <button
                    key={opt.key}
                    onClick={() => setMode(opt.key)}
                    className={`flex-1 text-left p-3 rounded-lg transition-colors ${
                      active ? 'bg-jam-600/15 ring-1 ring-jam-500' : 'hover:bg-gray-800'
                    }`}
                  >
                    <div className={`text-sm font-medium ${active ? 'text-jam-300' : 'text-gray-200'}`}>{opt.label}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{opt.sub}</div>
                  </button>
                )
              })}
            </div>
          )}

          {mode === 'generate' && (
          <>
          {/* Model selection */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
            <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Model</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {Object.entries(MODELS).map(([key, { label, description }]) => (
                <button
                  key={key}
                  onClick={() => handleModelChange(key)}
                  className={`text-left p-3 rounded-lg border transition-colors ${
                    model === key
                      ? 'border-jam-500 bg-jam-600/10'
                      : 'border-gray-700 hover:border-gray-500'
                  }`}
                >
                  <div className="text-sm font-medium text-gray-200">{label}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{description}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Stem toggles */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
            <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Stems to extract</h3>
            <div className="flex flex-wrap gap-2">
              {currentModelStems.map((stem) => {
                const meta = STEM_META[stem] || { label: stem, color: 'text-gray-300' }
                const active = selectedStems.has(stem)
                return (
                  <button
                    key={stem}
                    onClick={() => toggleStem(stem)}
                    className={`px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                      active
                        ? `border-gray-600 bg-gray-800 ${meta.color}`
                        : 'border-gray-700 text-gray-600 hover:text-gray-400'
                    }`}
                  >
                    {meta.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Output settings */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-5">
            <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Output settings</h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Quality (shifts) */}
              <label className="block">
                <span className="text-xs text-gray-500">Quality (shifts)</span>
                <div className="flex items-center gap-2 mt-1">
                  <input
                    type="range"
                    min="1"
                    max="10"
                    value={shifts}
                    onChange={(e) => setShifts(Number(e.target.value))}
                    className="flex-1"
                  />
                  <span className="text-sm text-gray-400 w-6 text-right">{shifts}</span>
                </div>
                <span className="text-xs text-gray-600">
                  {shifts === 1
                    ? 'Fastest — single inference pass'
                    : shifts === 2
                      ? 'Recommended — quality plateau for most music'
                      : shifts <= 4
                        ? 'High — diminishing returns'
                        : 'Best — long wait for marginal gains'}
                </span>
              </label>

              {/* Clip mode */}
              <label className="block">
                <span className="text-xs text-gray-500">Clip mode</span>
                <select
                  value={clipMode}
                  onChange={(e) => setClipMode(e.target.value)}
                  className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-jam-500"
                >
                  <option value="rescale">Rescale</option>
                  <option value="clamp">Clamp</option>
                </select>
              </label>
            </div>

            {/* Overlap */}
            <label className="block max-w-xs">
              <span className="text-xs text-gray-500">Overlap</span>
              <div className="flex items-center gap-2 mt-1">
                <input
                  type="range"
                  min="0"
                  max="0.99"
                  step="0.05"
                  value={overlap}
                  onChange={(e) => setOverlap(Number(e.target.value))}
                  className="flex-1"
                />
                <span className="text-sm text-gray-400 w-10 text-right">{overlap.toFixed(2)}</span>
              </div>
            </label>
          </div>
          </>
          )}

          {mode === 'manual' && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Upload stems</h3>
                <p className="text-xs text-gray-500 mt-1">
                  Drop one file per stem (any audio format). Each gets converted to OGG with the game name. The master
                  audio above becomes <span className="text-gray-400 font-mono">song.ogg</span>.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {(['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'] as const).map((stem) => {
                  const meta = STEM_META[stem]
                  const f = manualStems[stem]
                  return (
                    <label
                      key={stem}
                      className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                        f ? 'border-jam-500/40 bg-jam-600/5' : 'border-gray-700 hover:border-gray-500 bg-gray-800/40'
                      }`}
                    >
                      <input
                        type="file"
                        accept=".flac,.mp3,.ogg,.wav,.m4a,.aac,.wma"
                        className="hidden"
                        onChange={(e) =>
                          setManualStems((prev) => ({ ...prev, [stem]: e.target.files?.[0] ?? null }))
                        }
                      />
                      <span className={`text-sm font-medium ${meta.color}`}>{meta.label}</span>
                      <span className="text-xs text-gray-500 flex-1 truncate">
                        {f ? f.name : 'Click to choose file'}
                      </span>
                      {f && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            setManualStems((prev) => ({ ...prev, [stem]: null }))
                          }}
                          className="text-gray-500 hover:text-gray-200 text-xs"
                          aria-label="Remove"
                        >
                          ✕
                        </button>
                      )}
                    </label>
                  )
                })}
              </div>
            </div>
          )}

          {/* song.ini editor */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
            <div className="space-y-4">
                <div className="border border-gray-700 rounded-lg overflow-hidden">
                  <div className="bg-gray-800/50 px-4 py-2 border-b border-gray-700 flex items-center gap-2">
                    <span className="text-yellow-400 text-xs font-mono">song.ini</span>
                    <span className="text-gray-600 text-xs">[song]</span>
                  </div>
                  <div className="p-4 space-y-3">
                    {/* Album art */}
                    <div className="flex gap-4 items-start">
                      <button
                        type="button"
                        onClick={() => albumInputRef.current?.click()}
                        className="group relative w-24 h-24 shrink-0 rounded-lg overflow-hidden border border-gray-700 hover:border-jam-500 bg-gray-800 focus:outline-none focus:border-jam-500"
                        title="Click to upload album art"
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
                        onChange={(e) => handleAlbumArtSelect(e.target.files?.[0] ?? null)}
                      />
                      <div className="text-xs text-gray-500 mt-1">
                        <p>
                          <span className="text-gray-400 font-mono">album.png</span> — embedded in the game folder. Auto-pulled from the audio file when present.
                        </p>
                        <p className="text-gray-600 mt-1">Any image is resized to 512×512 PNG.</p>
                      </div>
                    </div>

                    {/* Primary fields */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <label className="block">
                        <span className="text-xs text-gray-400">name <span className="text-red-500">*</span></span>
                        <input
                          type="text"
                          value={songIni.name}
                          onChange={(e) => updateIni('name', e.target.value)}
                          placeholder="Song Title"
                          className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-jam-500"
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs text-gray-400">artist <span className="text-red-500">*</span></span>
                        <input
                          type="text"
                          value={songIni.artist}
                          onChange={(e) => updateIni('artist', e.target.value)}
                          placeholder="Artist Name"
                          className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-jam-500"
                        />
                      </label>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <label className="block">
                        <span className="text-xs text-gray-400">album</span>
                        <input
                          type="text"
                          value={songIni.album}
                          onChange={(e) => updateIni('album', e.target.value)}
                          className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-jam-500"
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs text-gray-400">genre</span>
                        <input
                          type="text"
                          value={songIni.genre}
                          onChange={(e) => updateIni('genre', e.target.value)}
                          placeholder="rock"
                          className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-jam-500"
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs text-gray-400">year</span>
                        <input
                          type="text"
                          value={songIni.year}
                          onChange={(e) => updateIni('year', e.target.value)}
                          placeholder="2024"
                          className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-jam-500"
                        />
                      </label>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <label className="block">
                        <span className="text-xs text-gray-400">charter</span>
                        <input
                          type="text"
                          value={songIni.charter}
                          onChange={(e) => updateIni('charter', e.target.value)}
                          className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-jam-500"
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs text-gray-400">loading_phrase</span>
                        <input
                          type="text"
                          value={songIni.loading_phrase}
                          onChange={(e) => updateIni('loading_phrase', e.target.value)}
                          className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-jam-500"
                        />
                      </label>
                    </div>

                    {/* Timing */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <label className="block">
                        <span className="text-xs text-gray-400">delay <span className="text-gray-600">(ms)</span></span>
                        <input
                          type="number"
                          value={songIni.delay}
                          onChange={(e) => updateIni('delay', e.target.value)}
                          className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-jam-500"
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs text-gray-400">song_length <span className="text-gray-600">(ms)</span></span>
                        <input
                          type="number"
                          value={songIni.song_length}
                          onChange={(e) => updateIni('song_length', e.target.value)}
                          className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-jam-500"
                        />
                      </label>
                      <label className="block sm:col-span-2">
                        <span className="text-xs text-gray-400">preview_start_time <span className="text-gray-600">(ms)</span></span>
                        <input
                          type="number"
                          value={songIni.preview_start_time}
                          onChange={(e) => updateIni('preview_start_time', e.target.value)}
                          className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-jam-500"
                        />
                      </label>
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
                                value={songIni[key]}
                                onChange={(e) => updateIni(key, e.target.value)}
                                className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 text-center focus:outline-none focus:border-jam-500"
                              />
                            </label>
                          ),
                        )}
                      </div>
                      <span className="text-xs text-gray-700 mt-1 block">-1 = uncharted, 0-6 = difficulty tier</span>
                    </div>
                  </div>
                </div>
              </div>
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={handleSeparate}
              className="px-6 py-2.5 bg-jam-600 hover:bg-jam-500 text-white rounded-lg font-medium transition-colors"
            >
              {mode === 'manual'
                ? file
                  ? 'Build for Game'
                  : 'Mux Stems → Build for Game'
                : 'Separate for Game'}
            </button>
            <button onClick={reset} className="px-4 py-2.5 text-gray-400 hover:text-gray-200 transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase === 'separating' && !jobId && (
        <div className="flex items-center gap-3 bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="animate-spin h-5 w-5 border-2 border-jam-400 border-t-transparent rounded-full" />
          <span className="text-gray-300">
            {file
              ? `Uploading ${file.name}...`
              : `Uploading ${Object.values(manualStems).filter(Boolean).length} stems...`}
          </span>
        </div>
      )}

      {phase === 'separating' && jobId && (
        <div className="space-y-4">
          <ProgressTracker jobId={jobId} statusUrl={`/api/jobs/${jobId}/events`} onDone={handleDone} onError={handleError} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-gray-500">
              Resumable URL —
              {' '}
              <span className="font-mono text-gray-400 break-all">?job={jobId}</span>
              <span className="text-gray-700"> · safe to close this tab</span>
            </div>
            <button
              onClick={handleKill}
              className="px-4 py-2 bg-red-900/40 hover:bg-red-800/60 border border-red-800 text-red-300 hover:text-red-200 rounded-lg text-sm font-medium transition-colors"
            >
              Kill task
            </button>
          </div>
        </div>
      )}

      {phase === 'done' && <StemResult jobId={jobId} metadata={metadata} />}

      {phase === 'error' && (
        <div className="space-y-4">
          <div className="bg-red-900/30 border border-red-800 rounded-lg p-4 text-red-400">{error}</div>
          <button onClick={reset} className="px-4 py-2 text-gray-400 hover:text-gray-200 transition-colors">
            Try again
          </button>
        </div>
      )}

      {(phase === 'done' || phase === 'error') && (
        <button
          onClick={reset}
          className="px-4 py-2 text-sm text-gray-500 hover:text-gray-300 transition-colors"
        >
          Separate another
        </button>
      )}
    </div>
  )
}
