import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import LyricsButtons from '../components/LyricsButtons'
import StemPlayer from '../components/StemPlayer.tsx'
import BeatmapStatsModal, { BeatmapRecord as BeatmapStatsRecord } from '../components/BeatmapStatsModal.tsx'
import VocalmapButtons from '../components/VocalmapButtons'
import useInstalledVersion from '../components/useInstalledVersion'

type BeatmapRecord = BeatmapStatsRecord

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
  beatmaps?: BeatmapRecord[]
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
  rhythm: 'text-green-400',
  guitar: 'text-orange-400',
  piano: 'text-violet-400',
  other: 'text-blue-400',
  song: 'text-gray-300',
}

const STEM_LABELS: Record<string, string> = {
  vocals: 'Vocals',
  drums: 'Drums',
  bass: 'Bass',
  rhythm: 'Bass',
  guitar: 'Guitar',
  piano: 'Piano',
  other: 'Other',
  song: 'Master Mix',
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

function BeatmapPanel({
  track,
  stem,
  onClose,
  onGenerated,
}: {
  track: Track
  stem: string
  onClose: () => void
  onGenerated?: () => void
}) {
  const navigate = useNavigate()
  const [schema, setSchema] = useState<Record<string, SongIniField>>({})
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [generating, setGenerating] = useState(false)
  const [creatingEmpty, setCreatingEmpty] = useState(false)
  const [emptyError, setEmptyError] = useState('')
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
          if (onGenerated) onGenerated()
        } else if (data.step === 'error') {
          evtSource.close()
          setError(data.message)
          setGenerating(false)
        } else if (data.step === 'cancelled') {
          evtSource.close()
          setGenerating(false)
          setProgress(0)
          setMessage('')
          setJobId('')
          setBeatmapJobId('')
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
          <div className="flex items-center gap-2">
            <a
              href={`/api/tracks/${track.id}/stems/${stem}`}
              className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-gray-600 text-gray-200 rounded-md text-xs font-medium transition-colors"
              title={`Download ${STEM_LABELS[stem] || stem} stem`}
            >
              Download stem
            </a>
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">&times;</button>
          </div>
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
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handleGenerate}
                disabled={generating || creatingEmpty}
                className="px-6 py-2.5 bg-jam-600 hover:bg-jam-500 disabled:opacity-50 text-white rounded-lg font-medium transition-colors"
              >
                {generating ? 'Generating...' : 'Generate Beatmap'}
              </button>
              <button
                onClick={async () => {
                  setCreatingEmpty(true)
                  setEmptyError('')
                  try {
                    const fd = new FormData()
                    fd.append('stem', stem)
                    const res = await fetch(`/api/tracks/${track.id}/empty-beatmap`, {
                      method: 'POST',
                      body: fd,
                    })
                    if (!res.ok) {
                      const err = await res.json().catch(() => ({}))
                      throw new Error(err.detail || `Failed (${res.status})`)
                    }
                    const data = await res.json()
                    if (onGenerated) onGenerated()
                    navigate(`/edit/${data.track_id}/${data.beatmap_id}`)
                  } catch (e) {
                    setEmptyError((e as Error).message)
                  } finally {
                    setCreatingEmpty(false)
                  }
                }}
                disabled={generating || creatingEmpty}
                className="px-4 py-2.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 hover:border-gray-600 text-gray-200 rounded-lg text-sm font-medium transition-colors"
                title="Skip beat detection — open the editor with an empty chart"
              >
                {creatingEmpty ? 'Creating…' : 'Open empty editor →'}
              </button>
              {emptyError && <span className="text-xs text-red-400">{emptyError}</span>}
            </div>
          )}

          {generating && jobId && (
            <div className="space-y-2">
              <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
                <div className="bg-jam-500 h-full rounded-full transition-all duration-500" style={{ width: `${Math.max(progress, 2)}%` }} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-gray-500 flex-1 truncate">{message}</p>
                <button
                  onClick={async () => {
                    try {
                      await fetch(`/api/beatmap/${jobId}/cancel`, { method: 'POST' })
                    } catch {
                      // best-effort
                    }
                  }}
                  className="shrink-0 px-3 py-1.5 bg-red-900/40 hover:bg-red-800/60 border border-red-800 text-red-300 hover:text-red-200 rounded text-xs font-medium transition-colors"
                >
                  Kill task
                </button>
              </div>
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


// ── Tutorial samples + voice reference manager ────────────────────────────
const TUTORIAL_SAMPLE_SLOTS: { slot: string; label: string; cls: string }[] = [
  { slot: 'lane_1', label: 'Lane 1 (Green)', cls: 'text-emerald-400' },
  { slot: 'lane_2', label: 'Lane 2 (Red)', cls: 'text-red-400' },
  { slot: 'lane_3', label: 'Lane 3 (Yellow)', cls: 'text-amber-400' },
  { slot: 'lane_4', label: 'Lane 4 (Blue)', cls: 'text-sky-400' },
  { slot: 'lane_5', label: 'Lane 5 (Orange)', cls: 'text-orange-400' },
  { slot: 'chord_12', label: 'Chord 1+2', cls: 'text-amber-200' },
  { slot: 'chord_23', label: 'Chord 2+3', cls: 'text-amber-200' },
  { slot: 'chord_34', label: 'Chord 3+4', cls: 'text-amber-200' },
  { slot: 'chord_45', label: 'Chord 4+5', cls: 'text-amber-200' },
  { slot: 'open', label: 'Open strum', cls: 'text-purple-300' },
]

// ── Real-notes sound packs — pick a curated pack + scale; backend renders
// all 10 sample slots into the track's stems_dir/tutorial_samples/ and turns
// on the [real_notes] flag in song.ini. Reuses the tutorial-samples slot
// layout so a track can carry tutorial-mode samples and real-notes samples
// from the same files.
interface SoundPack {
  pack_id: string
  name: string
  family: string
  description: string
}
interface SoundScale {
  scale_id: string
  name: string
  description: string
}

function SoundPackPanel({ track }: { track: Track }) {
  const [expanded, setExpanded] = useState(false)
  const [packs, setPacks] = useState<SoundPack[]>([])
  const [scales, setScales] = useState<SoundScale[]>([])
  const [packId, setPackId] = useState('')
  const [scaleId, setScaleId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  const [previewing, setPreviewing] = useState(false)

  // Cancel any in-flight preview when the user switches pack or scale.
  useEffect(() => {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause()
      previewAudioRef.current = null
      setPreviewing(false)
    }
  }, [packId, scaleId])

  const playPreview = () => {
    if (!packId || !scaleId) return
    if (previewAudioRef.current) {
      previewAudioRef.current.pause()
      previewAudioRef.current = null
      setPreviewing(false)
      return
    }
    const url = `/api/sample-packs/${encodeURIComponent(packId)}/${encodeURIComponent(scaleId)}/preview`
    const a = new Audio(url)
    a.onended = () => { setPreviewing(false); previewAudioRef.current = null }
    a.onerror = () => { setPreviewing(false); previewAudioRef.current = null }
    previewAudioRef.current = a
    setPreviewing(true)
    a.play().catch(() => { setPreviewing(false); previewAudioRef.current = null })
  }

  useEffect(() => {
    if (!expanded) return
    fetch('/api/sample-packs')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return
        setPacks(data.packs || [])
        setScales(data.scales || [])
        // Default selections: first of each.
        if (data.packs?.length) setPackId((cur) => cur || data.packs[0].pack_id)
        if (data.scales?.length) setScaleId((cur) => cur || data.scales[0].scale_id)
      })
      .catch(() => undefined)
  }, [expanded])

  const apply = async () => {
    if (!packId || !scaleId) return
    setBusy(true)
    setError('')
    setStatus('')
    try {
      const fd = new FormData()
      fd.append('pack_id', packId)
      fd.append('scale_id', scaleId)
      const res = await fetch(`/api/tracks/${track.id}/apply-sample-pack`, {
        method: 'POST',
        body: fd,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Apply failed (${res.status})`)
      }
      const data = await res.json() as { slots: Record<string, string> }
      setStatus(`Rendered ${Object.keys(data.slots).length} samples · real-notes mode is on for this track.`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Detect existing real-notes setup from track.stems (any sample_* entry that
  // points at tutorial_samples/ implies a pack has already been applied).
  const hasRealNotes = Object.entries(track.stems || {}).some(
    ([k, v]) => k.startsWith('sample_') && typeof v === 'string' && v.startsWith('tutorial_samples/'),
  )

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="mt-3 w-full py-2.5 border border-cyan-800 bg-cyan-900/20 hover:bg-cyan-900/40 text-cyan-300 rounded-lg text-sm font-medium transition-colors"
      >
        Real-notes sound pack{hasRealNotes ? ' · applied' : ''}
      </button>
    )
  }

  return (
    <div className="mt-3 border border-cyan-800 bg-cyan-900/10 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-cyan-300">Real-notes sound pack</h4>
        <button
          onClick={() => setExpanded(false)}
          className="text-xs text-gray-500 hover:text-gray-300"
        >
          ✕ close
        </button>
      </div>
      <p className="text-[11px] text-gray-500 leading-snug">
        Pick a timbre + scale. The backend renders 10 OGGs (lane_1..lane_5,
        chord_12..chord_45, open) into this track's stems folder and flags
        real-notes mode on in song.ini. The game client plays the matching
        sample whenever a note is hit successfully — even outside tutorial mode.
      </p>

      <div>
        <label className="block text-[11px] text-gray-400 mb-1">Sound pack</label>
        <select
          value={packId}
          onChange={(e) => setPackId(e.target.value)}
          disabled={busy || packs.length === 0}
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-[12px] text-gray-200 focus:outline-none focus:border-cyan-500 disabled:opacity-50"
        >
          {packs.map((p) => (
            <option key={p.pack_id} value={p.pack_id}>
              {p.name} — {p.family}
            </option>
          ))}
        </select>
        {packs.find((p) => p.pack_id === packId) && (
          <p className="text-[10px] text-gray-600 mt-1">
            {packs.find((p) => p.pack_id === packId)?.description}
          </p>
        )}
      </div>

      <div>
        <label className="block text-[11px] text-gray-400 mb-1">Scale (10 pitches)</label>
        <select
          value={scaleId}
          onChange={(e) => setScaleId(e.target.value)}
          disabled={busy || scales.length === 0}
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-[12px] text-gray-200 focus:outline-none focus:border-cyan-500 disabled:opacity-50"
        >
          {scales.map((s) => (
            <option key={s.scale_id} value={s.scale_id}>{s.name}</option>
          ))}
        </select>
        {scales.find((s) => s.scale_id === scaleId) && (
          <p className="text-[10px] text-gray-600 mt-1">
            {scales.find((s) => s.scale_id === scaleId)?.description}
          </p>
        )}
      </div>

      {error && <p className="text-xs text-red-400 break-words">{error}</p>}
      {status && <p className="text-xs text-emerald-400">{status}</p>}

      <div className="flex gap-2">
        <button
          onClick={playPreview}
          disabled={!packId || !scaleId}
          className="shrink-0 px-3 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-200 rounded text-xs font-medium"
          title="Play the scale root (lane_1) to audition the pack"
        >
          {previewing ? '❚❚ Stop' : '▶ Preview'}
        </button>
        <button
          onClick={apply}
          disabled={busy || !packId || !scaleId}
          className="flex-1 px-3 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white rounded text-xs font-medium"
        >
          {busy ? 'Rendering…' : hasRealNotes ? 'Re-render with this pack' : 'Apply pack to track'}
        </button>
      </div>
      <p className="text-[10px] text-gray-600">
        Overwrites this track's tutorial_samples/ folder. Manual sample uploads
        in the panel below will be replaced.
      </p>
    </div>
  )
}

function TutorialSamplesPanel({ track }: { track: Track }) {
  const [expanded, setExpanded] = useState(false)
  const [samples, setSamples] = useState<Record<string, { filename: string; size_bytes: number; mtime: number }>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [hasVoiceRef, setHasVoiceRef] = useState(false)
  const [voiceRefBust, setVoiceRefBust] = useState(0)

  const loadSamples = useCallback(() => {
    fetch(`/api/tutorial/${track.id}/samples`)
      .then((r) => (r.ok ? r.json() : {}))
      .then(setSamples)
      .catch(() => undefined)
    fetch(`/api/tutorial/${track.id}/voice-ref`, { method: 'HEAD' })
      .then((r) => setHasVoiceRef(r.ok))
      .catch(() => setHasVoiceRef(false))
  }, [track.id])

  useEffect(() => {
    if (expanded) loadSamples()
  }, [expanded, loadSamples])

  const uploadSample = async (slot: string, file: File) => {
    setBusy(slot)
    setError('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`/api/tutorial/${track.id}/samples/${slot}`, { method: 'PUT', body: fd })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Upload failed (${res.status})`)
      }
      loadSamples()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const deleteSample = async (slot: string) => {
    setBusy(slot)
    setError('')
    try {
      await fetch(`/api/tutorial/${track.id}/samples/${slot}`, { method: 'DELETE' })
      loadSamples()
    } finally {
      setBusy(null)
    }
  }

  const uploadVoiceRef = async (file: File) => {
    setBusy('_voice_ref')
    setError('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`/api/tutorial/${track.id}/voice-ref`, { method: 'POST', body: fd })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Upload failed (${res.status})`)
      }
      setHasVoiceRef(true)
      setVoiceRefBust((v) => v + 1)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const deleteVoiceRef = async () => {
    setBusy('_voice_ref')
    try {
      await fetch(`/api/tutorial/${track.id}/voice-ref`, { method: 'DELETE' })
      setHasVoiceRef(false)
    } finally {
      setBusy(null)
    }
  }

  const slotsFilled = Object.keys(samples).length

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="mt-3 w-full py-2.5 border border-purple-800 bg-purple-900/20 hover:bg-purple-900/40 text-purple-300 rounded-lg text-sm font-medium transition-colors"
      >
        Tutorial samples + voice clone {slotsFilled > 0 ? `· ${slotsFilled}/10 slots filled` : ''}
      </button>
    )
  }

  return (
    <div className="mt-4 border border-purple-900/50 rounded-xl overflow-hidden">
      <div className="bg-purple-900/20 px-4 py-3 flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold text-purple-300">Tutorial samples + voice clone</h4>
          <p className="text-xs text-gray-500">
            10 instrument samples (slide_up / slide_down auto-generated at publish)
            + an optional 5–30s voice reference for Chatterbox to clone.
          </p>
        </div>
        <button onClick={() => setExpanded(false)} className="text-gray-500 hover:text-gray-300 text-lg">&times;</button>
      </div>

      {error && (
        <div className="mx-4 mt-3 bg-red-900/30 border border-red-800 rounded p-2 text-xs text-red-300">{error}</div>
      )}

      <div className="p-4 space-y-4">
        {/* Voice ref */}
        <div className="bg-gray-950 border border-gray-800 rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-sky-300">Voice reference</span>
            <span className="text-[11px] text-gray-500">5–30s clip · cloned by TTS</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="px-2.5 py-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-xs text-gray-200 cursor-pointer">
              {hasVoiceRef ? 'Replace' : 'Upload'}
              <input
                type="file"
                accept=".wav,.ogg,.mp3,.flac,.m4a"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) uploadVoiceRef(f)
                }}
              />
            </label>
            {hasVoiceRef && (
              <>
                <audio
                  controls
                  src={`/api/tutorial/${track.id}/voice-ref?t=${voiceRefBust}`}
                  className="h-6 max-w-xs"
                />
                <button
                  onClick={deleteVoiceRef}
                  disabled={busy === '_voice_ref'}
                  className="px-2 py-1 bg-red-900/40 hover:bg-red-800/60 border border-red-800 text-red-300 rounded text-[11px]"
                >
                  Delete
                </button>
              </>
            )}
            {busy === '_voice_ref' && <span className="text-xs text-gray-500">Uploading…</span>}
          </div>
        </div>

        {/* Sample slots */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {TUTORIAL_SAMPLE_SLOTS.map(({ slot, label, cls }) => {
            const filled = samples[slot]
            return (
              <div key={slot} className="bg-gray-950 border border-gray-800 rounded p-2 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-xs font-medium ${cls}`}>{label}</span>
                  {filled && (
                    <button
                      onClick={() => deleteSample(slot)}
                      disabled={busy === slot}
                      className="text-[10px] text-red-400 hover:text-red-200"
                    >
                      delete
                    </button>
                  )}
                </div>
                {filled ? (
                  <audio
                    controls
                    src={`/api/tutorial/${track.id}/samples/${slot}/file?t=${filled.mtime}`}
                    className="w-full h-7"
                  />
                ) : (
                  <span className="text-[11px] text-gray-600">empty</span>
                )}
                <label className="block px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-center text-[11px] text-gray-300 cursor-pointer">
                  {filled ? 'Replace' : 'Upload OGG / WAV / MP3'}
                  <input
                    type="file"
                    accept=".ogg,.wav,.mp3,.flac,.m4a"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) uploadSample(slot, f)
                    }}
                  />
                </label>
                {busy === slot && <span className="text-[10px] text-gray-500">Working…</span>}
              </div>
            )
          })}
        </div>

        <p className="text-[11px] text-gray-600">
          slide_up / slide_down variants for each slot are synthesised automatically
          at publish time via ffmpeg pitch-shift (±2 semitones). No upload required.
        </p>
      </div>
    </div>
  )
}

function InlinePublish({ track }: { track: Track }) {
  const [expanded, setExpanded] = useState(false)
  const [schema, setSchema] = useState<Record<string, SongIniField>>({})
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [publishing, setPublishing] = useState(false)
  const [result, setResult] = useState<{
    commitUrl: string
    folder: string
    chart: {
      found: boolean
      source: string | null
      published_as?: string
      beatmap_id?: string
      included_stems?: string[]
      skipped_stems?: string[]
      selected_beatmaps?: Record<string, string>
    }
  } | null>(null)
  const [error, setError] = useState('')

  // Per-stem beatmap selection. Keys: stem name. Values: beatmap_id.
  // Initialised on expand to the most recently generated beatmap per stem,
  // matching the backend default. User can override via the dropdowns below.
  const beatmapsByStem = (track.beatmaps || []).reduce<Record<string, BeatmapRecord[]>>((acc, bm) => {
    if (!acc[bm.stem]) acc[bm.stem] = []
    acc[bm.stem].push(bm)
    return acc
  }, {})
  for (const stem of Object.keys(beatmapsByStem)) {
    beatmapsByStem[stem].sort((a, b) => b.generated_at - a.generated_at)
  }
  const [selectedBeatmaps, setSelectedBeatmaps] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!expanded) return
    const init: Record<string, string> = {}
    for (const [stem, bms] of Object.entries(beatmapsByStem)) {
      const active = bms.find((bm) => bm.active)
      init[stem] = (active || bms[0])?.id || ''
    }
    setSelectedBeatmaps(init)
    // We intentionally only initialise on expand; the by-stem map is derived
    // from the prop on every render and is stable enough for this purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, track.id])

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
      // Only send overrides for stems that actually have a beatmap selected;
      // empty entries are treated by the backend as "use latest" anyway.
      const overrides = Object.fromEntries(
        Object.entries(selectedBeatmaps).filter(([, bid]) => !!bid),
      )
      if (Object.keys(overrides).length > 0) {
        formData.append('selected_beatmaps', JSON.stringify(overrides))
      }
      const res = await fetch(`/api/tracks/${track.id}/publish-game`, { method: 'POST', body: formData })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Publish failed')
      }
      const data = await res.json()
      setResult({
        commitUrl: data.commit_url,
        folder: data.folder,
        chart: data.chart || { found: false, source: null },
      })
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

      {/* Stem mapping — preview of what lands in the published folder */}
      <div className="px-4 py-2 bg-gray-800/30 border-b border-gray-800">
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs font-mono text-gray-600">
          {Object.keys(track.stems)
            .filter((s) => !NON_AUDIO_KEYS.has(s) && s !== 'song')
            .map((s) => {
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
          {!!track.stems.album_png && (
            <span>+ <span className="text-pink-300">album.png</span></span>
          )}
          {(track.beatmaps && track.beatmaps.length > 0) ? (
            <span>+ <span className="text-emerald-400">notes_fixed_slides.chart</span></span>
          ) : (
            <span className="text-amber-500/80" title="No beatmap on this track yet — generate one before publishing or the song won't load">
              ⚠ no notes_fixed_slides.chart
            </span>
          )}
        </div>
      </div>

      {/* Beatmaps to publish — one per stem. Defaults to latest per stem; user
          can override via dropdown. Stems with no beatmap are omitted; stems
          with a single beatmap render as a static label. */}
      {Object.keys(beatmapsByStem).length > 0 && (
        <div className="px-4 py-3 border-b border-gray-800 space-y-2">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-emerald-400 text-xs font-mono">notes_fixed_slides.chart</span>
            <span className="text-gray-700 text-xs">beatmaps merged into the published chart</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {Object.entries(beatmapsByStem).map(([stem, bms]) => {
              const colour = STEM_COLORS[stem] || 'text-gray-300'
              const stemLabel = STEM_LABELS[stem] || stem
              const fmtBm = (bm: BeatmapRecord) => {
                const date = new Date(bm.generated_at * 1000).toLocaleString(undefined, {
                  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                })
                const liveName = (bm.song_name || '').trim()
                return liveName ? `${liveName} · ${date}` : date
              }
              return (
                <div key={stem} className="flex items-center gap-2">
                  <span className={`shrink-0 text-xs font-medium w-16 ${colour}`}>{stemLabel}</span>
                  {bms.length === 1 ? (
                    <span className="text-xs text-gray-400 truncate" title={fmtBm(bms[0])}>
                      {fmtBm(bms[0])}
                    </span>
                  ) : (
                    <select
                      value={selectedBeatmaps[stem] || bms[0].id}
                      onChange={(e) => setSelectedBeatmaps((prev) => ({ ...prev, [stem]: e.target.value }))}
                      className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-jam-500"
                    >
                      {bms.map((bm) => (
                        <option key={bm.id} value={bm.id}>
                          {fmtBm(bm)}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )
            })}
          </div>
          <p className="text-[11px] text-gray-600">
            Latest beatmap per stem is selected by default. Pick a different one to publish that take instead.
          </p>
        </div>
      )}

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
            <span className="text-sm text-gray-400">Packaging stems and pushing to GitHub...</span>
          </div>
        )}

        {result && (
          <div className="bg-green-900/20 border border-green-800 rounded-lg p-4 space-y-2">
            <p className="text-sm text-green-400 font-medium">Published!</p>
            <p className="text-xs text-gray-500 font-mono">{result.folder}</p>
            {result.chart.found ? (
              <p className="text-xs text-gray-500">
                Included <span className="font-mono text-gray-300">{result.chart.published_as || 'notes_fixed_slides.chart'}</span>
                {result.chart.included_stems && result.chart.included_stems.length > 0 && (
                  <span className="text-gray-600"> · stems: {result.chart.included_stems.join(', ')}</span>
                )}
                {result.chart.skipped_stems && result.chart.skipped_stems.length > 0 && (
                  <span className="text-amber-500/80"> · skipped: {result.chart.skipped_stems.join(', ')}</span>
                )}
              </p>
            ) : (
              <p className="text-xs text-amber-400">
                ⚠ No beatmap found for this track — published without notes_fixed_slides.chart. Generate a beatmap on a stem and re-publish.
              </p>
            )}
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

interface JobRow {
  id: string
  kind: string
  title: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  progress: number
  last_message: string
  created_at: number
  updated_at: number
  error: string | null
  track_id: string | null
}

const JOB_STATUS_PILL: Record<JobRow['status'], { label: string; cls: string }> = {
  queued: { label: 'Queued', cls: 'bg-gray-700/50 text-gray-300 border-gray-600' },
  running: { label: 'Running', cls: 'bg-jam-600/20 text-jam-300 border-jam-600/40' },
  done: { label: 'Done', cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-800/60' },
  failed: { label: 'Failed', cls: 'bg-red-900/40 text-red-300 border-red-800/60' },
  cancelled: { label: 'Cancelled', cls: 'bg-amber-900/30 text-amber-300 border-amber-800/60' },
}

function InlineBeatmapProgress({
  jobId,
  onDone,
  onCancelled,
}: {
  jobId: string
  onDone?: () => void
  onCancelled?: () => void
}) {
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState('Starting…')
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const es = new EventSource(`/api/jobs/${jobId}/events`)
    es.onmessage = (e) => {
      const d = JSON.parse(e.data)
      if (d.progress >= 0) setProgress(d.progress)
      if (d.message) setMessage(d.message)
      if (d.step === 'done' && d.metadata) {
        es.close()
        setDone(true)
        if (onDone) onDone()
      } else if (d.step === 'error') {
        es.close()
        setError(d.message)
      } else if (d.step === 'cancelled') {
        es.close()
        if (onCancelled) onCancelled()
      }
    }
    es.onerror = () => es.close()
    return () => es.close()
  }, [jobId, onDone, onCancelled])

  if (done) return <div className="text-[11px] text-emerald-400 mt-1">Generated ✓</div>
  if (error) return <div className="text-[11px] text-red-400 mt-1 truncate" title={error}>{error}</div>
  return (
    <div className="mt-1 space-y-1">
      <div className="w-full bg-gray-900 rounded-full h-1 overflow-hidden">
        <div
          className="bg-jam-500 h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.max(progress, 2)}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-1">
        <span className="text-[10px] text-gray-500 truncate flex-1" title={message}>{message}</span>
        <button
          onClick={async () => {
            try {
              await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' })
            } catch {
              // best-effort
            }
          }}
          className="shrink-0 px-1.5 py-0.5 bg-red-900/40 hover:bg-red-800/60 border border-red-800 text-red-300 hover:text-red-200 rounded text-[9px] font-medium transition-colors"
        >
          Kill
        </button>
      </div>
    </div>
  )
}

export default function TracksPage() {
  const [tracks, setTracks] = useState<Track[]>([])
  const [jobs, setJobs] = useState<JobRow[]>([])
  const [loading, setLoading] = useState(true)
  const [beatmapPanel, setBeatmapPanel] = useState<{ track: Track; stem: string } | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const selectedId = searchParams.get('id')
  const setSelectedId = useCallback(
    (id: string | null) => {
      if (id) setSearchParams({ id }, { replace: false })
      else setSearchParams({}, { replace: false })
    },
    [setSearchParams],
  )
  const [confirmDelete, setConfirmDelete] = useState<Track | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [statsBeatmap, setStatsBeatmap] = useState<BeatmapRecord | null>(null)
  const [coverFetchState, setCoverFetchState] = useState<'idle' | 'loading' | 'none' | 'error'>('idle')
  // Inline beatmap generation: per-stem job id when one is in flight, plus
  // tickbox selection for the batch-generate button below the stem grid.
  const [selectedStems, setSelectedStems] = useState<Set<string>>(new Set())
  const [inlineBmJobs, setInlineBmJobs] = useState<Record<string, string>>({})
  const [hasVocalNotes, setHasVocalNotes] = useState(false)
  const installedMadmom = useInstalledVersion('madmom')
  const beatmapBtnLabel = installedMadmom
    ? `Generate Beatmap with madmom ${installedMadmom}`
    : 'Generate Beatmap'

  const refetchHasVocalNotes = useCallback(async () => {
    if (!selectedId) { setHasVocalNotes(false); return }
    try {
      const r = await fetch(`/api/vocals?track_id=${selectedId}`)
      setHasVocalNotes(r.ok)
    } catch {
      setHasVocalNotes(false)
    }
  }, [selectedId])

  useEffect(() => { refetchHasVocalNotes() }, [refetchHasVocalNotes])

  const deleteVocalNotes = async () => {
    if (!selectedId) return
    if (!window.confirm('Delete the vocal beatmap for this track? Lyrics versions are kept.')) return
    try {
      const r = await fetch(`/api/vocals?track_id=${selectedId}`, { method: 'DELETE' })
      if (!r.ok) {
        const e = await r.json().catch(() => ({}))
        throw new Error(e.detail || `HTTP ${r.status}`)
      }
      setHasVocalNotes(false)
    } catch (e) {
      alert((e as Error).message)
    }
  }
  const [batchError, setBatchError] = useState('')

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

  const loadJobs = useCallback(() => {
    // Pull recent stem-related jobs. Beatmap jobs are surfaced inside the track
    // detail view, so they don't belong as ghost rows in the library list.
    fetch('/api/jobs?limit=30')
      .then((r) => (r.ok ? r.json() : []))
      .then((data: JobRow[]) => {
        const filtered = (data || []).filter(
          (j) => j.kind === 'separate' || j.kind === 'manual_stems',
        )
        setJobs(filtered)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => { loadTracks(); loadJobs() }, [loadTracks, loadJobs])

  // Poll jobs while any are still running so the status pill stays live
  useEffect(() => {
    const anyActive = jobs.some((j) => j.status === 'queued' || j.status === 'running')
    if (!anyActive) return
    const t = window.setInterval(() => {
      loadJobs()
      // Also refresh tracks so finished separations appear without a manual refresh
      loadTracks()
    }, 4000)
    return () => window.clearInterval(t)
  }, [jobs, loadJobs, loadTracks])

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

  // Reset inline beatmap state when switching tracks so jobs don't bleed across rows
  useEffect(() => {
    setSelectedStems(new Set())
    setInlineBmJobs({})
    setBatchError('')
  }, [selectedId])

  const toggleSelectedStem = (stem: string) =>
    setSelectedStems((prev) => {
      const next = new Set(prev)
      if (next.has(stem)) next.delete(stem)
      else next.add(stem)
      return next
    })

  const startQuickBeatmap = useCallback(
    async (stem: string): Promise<string | null> => {
      const track = tracks.find((t) => t.id === selectedId)
      if (!track) return null
      try {
        if (stem === 'vocals') {
          const meta = {
            artist: (songIni.artist || track.artist || '').trim(),
            title: (songIni.name || track.name || '').trim(),
            album: (songIni.album || track.album || '').trim() || undefined,
          }
          const res = await fetch(`/api/vocals/generate?track_id=${track.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(meta),
          })
          if (!res.ok) {
            const err = await res.json().catch(() => ({}))
            throw new Error(err.detail || `Failed (${res.status})`)
          }
          const { job_id } = await res.json()
          setInlineBmJobs((prev) => ({ ...prev, [stem]: job_id }))
          return job_id
        }
        const fd = new FormData()
        fd.append('stem', stem)
        fd.append('name', (songIni.name || track.name || '').trim())
        fd.append('artist', (songIni.artist || track.artist || 'Unknown').trim())
        fd.append('album', (songIni.album || track.album || 'Unknown').trim())
        fd.append('genre', (songIni.genre || track.genre || 'Unknown').trim())
        fd.append('year', (songIni.year || track.year || '').trim())
        // The backend now defaults five_lane_drums=true. Pass it explicitly for
        // drums stems so it sticks regardless of any future schema flip.
        if (stem === 'drums') fd.append('five_lane_drums', 'true')
        const res = await fetch(`/api/tracks/${track.id}/generate-beatmap`, {
          method: 'POST',
          body: fd,
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.detail || `Failed (${res.status})`)
        }
        const { job_id } = await res.json()
        setInlineBmJobs((prev) => ({ ...prev, [stem]: job_id }))
        return job_id
      } catch (e) {
        setBatchError((e as Error).message)
        return null
      }
    },
    [tracks, selectedId, songIni],
  )

  const generateSelected = useCallback(async () => {
    setBatchError('')
    for (const stem of Array.from(selectedStems)) {
      if (inlineBmJobs[stem]) continue
      await startQuickBeatmap(stem)
    }
    setSelectedStems(new Set())
  }, [selectedStems, inlineBmJobs, startQuickBeatmap])

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
              <h3 className="font-semibold text-gray-100 text-lg">
                {(() => {
                  const liveName = (songIni.name || '').trim() || selectedTrack.name
                  const liveArtist = (songIni.artist || '').trim() || selectedTrack.artist
                  return liveArtist ? `${liveArtist} — ${liveName}` : liveName
                })()}
              </h3>
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

          <div className="flex flex-col gap-2">
            {Object.entries(selectedTrack.stems)
              .filter(([stem]) => !NON_AUDIO_KEYS.has(stem))
              .map(([stem]) => (
                <div
                  key={stem}
                  className="bg-gray-800 border border-gray-700 rounded-lg p-3 flex flex-col md:flex-row md:items-stretch gap-3 relative"
                >
                  {/* Identity column: checkbox + stem label */}
                  <div className="md:w-24 md:shrink-0 flex md:flex-col items-center md:justify-center gap-2 md:gap-1.5">
                    {stem !== 'song' ? (
                      <input
                        type="checkbox"
                        checked={selectedStems.has(stem)}
                        onChange={() => toggleSelectedStem(stem)}
                        className="h-4 w-4 rounded border-gray-600 bg-gray-900 accent-jam-500 cursor-pointer shrink-0"
                        aria-label={`Select ${STEM_LABELS[stem] || stem} for batch beatmap`}
                        title="Select for batch beatmap generation"
                      />
                    ) : (
                      <div className="h-4 w-4 shrink-0" />
                    )}
                    <span className={`text-sm font-semibold ${STEM_COLORS[stem] || 'text-gray-300'}`}>
                      {STEM_LABELS[stem] || stem}
                    </span>
                  </div>

                  {/* Waveform column (gets the slack) */}
                  <div className="flex-1 min-w-0 flex items-center">
                    <StemPlayer src={`/api/tracks/${selectedTrack.id}/stems/${stem}`} />
                  </div>

                  {/* Actions column */}
                  <div className="md:w-80 md:shrink-0 flex flex-col gap-1.5">
                  {stem === 'vocals' && (
                    <>
                      <LyricsButtons
                        scope={{ trackId: selectedTrack.id }}
                        hasVocals={true}
                        meta={{
                          artist: (songIni.artist || '').trim() || selectedTrack.artist,
                          title: (songIni.name || '').trim() || selectedTrack.name,
                          album: (songIni.album || '').trim() || selectedTrack.album,
                          duration_s: undefined,
                        }}
                      />
                      <VocalmapButtons
                        scope={{ trackId: selectedTrack.id }}
                        meta={{
                          artist: (songIni.artist || '').trim() || selectedTrack.artist,
                          title: (songIni.name || '').trim() || selectedTrack.name,
                          album: (songIni.album || '').trim() || selectedTrack.album,
                        }}
                        hasActive={hasVocalNotes}
                        onActiveChange={refetchHasVocalNotes}
                      />
                      {hasVocalNotes && (
                        <button
                          onClick={deleteVocalNotes}
                          className="self-end px-1.5 py-0.5 bg-red-900/40 hover:bg-red-800/60 border border-red-800/60 text-red-300 hover:text-red-200 rounded text-[10px] transition-colors"
                          title="Delete vocal_notes.json for this track"
                          aria-label="Delete vocalmap"
                        >
                          delete vocalmap
                        </button>
                      )}
                    </>
                  )}
                  {stem !== 'vocals' && (
                    <div className="flex items-stretch gap-1">
                      {stem === 'song' ? (
                        <a
                          href={`/api/tracks/${selectedTrack.id}/stems/${stem}`}
                          className="flex-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded text-xs font-medium transition-colors text-center"
                        >
                          Download
                        </a>
                      ) : (
                        <>
                          <button
                            onClick={() => startQuickBeatmap(stem)}
                            disabled={!!inlineBmJobs[stem]}
                            className="flex-1 px-3 py-1.5 bg-green-700/60 hover:bg-green-600/70 disabled:opacity-50 text-green-100 rounded text-xs font-medium transition-colors"
                            title="Generate beatmap with the installed madmom model"
                          >
                            {beatmapBtnLabel}
                          </button>
                          <button
                            onClick={() => setBeatmapPanel({ track: selectedTrack, stem })}
                            disabled={!!inlineBmJobs[stem]}
                            className="px-2 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-200 rounded text-xs font-medium transition-colors"
                            title="Advanced settings & download stem"
                            aria-label="Advanced settings & download stem"
                          >
                            ⚙
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {/* Surface the empty-editor entry point on every non-vocals,
                      non-song stem so users can start a fresh manual chart even
                      if a beatmap already exists. Vocals uses VocalmapButtons
                      and doesn't need an empty-editor path. The song-stem
                      gets the link too so tutorial tracks (whose only stem
                      is 'song') aren't stranded without a way to drop new
                      empty beatmaps. */}
                  {stem !== 'vocals' && !inlineBmJobs[stem] && (
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const fd = new FormData()
                            fd.append('stem', stem)
                            const res = await fetch(`/api/tracks/${selectedTrack.id}/empty-beatmap`, { method: 'POST', body: fd })
                            if (!res.ok) {
                              const err = await res.json().catch(() => ({}))
                              throw new Error(err.detail || `Failed (${res.status})`)
                            }
                            const data = await res.json()
                            navigate(`/edit/${data.track_id}/${data.beatmap_id}`)
                          } catch (e) {
                            setBatchError((e as Error).message)
                          }
                        }}
                        className="text-[11px] text-gray-500 hover:text-jam-300 underline-offset-2 hover:underline transition-colors text-center"
                        title="Skip beat detection — open the editor with an empty chart"
                      >
                        or open empty editor →
                      </button>
                    )}
                  {inlineBmJobs[stem] && stem !== 'vocals' && (
                    <InlineBeatmapProgress
                      jobId={inlineBmJobs[stem]}
                      onDone={() => {
                        setInlineBmJobs((prev) => {
                          const next = { ...prev }
                          delete next[stem]
                          return next
                        })
                        loadTracks()
                      }}
                      onCancelled={() => {
                        setInlineBmJobs((prev) => {
                          const next = { ...prev }
                          delete next[stem]
                          return next
                        })
                      }}
                    />
                  )}
                  {/* Vocals uses VocalmapButtons → vocal_notes.json, not the
                      tracks.beatmaps array, so skip the legacy chart list here. */}
                  {stem !== 'vocals' && (selectedTrack.beatmaps || [])
                    .filter((bm) => bm.stem === stem)
                    .sort((a, b) => b.generated_at - a.generated_at)
                    .map((bm) => {
                      const liveName = (bm.song_name || '').trim()
                      const dateStr = formatDate(bm.generated_at)
                      const isActive = !!bm.active
                      const defaultName = `${selectedTrack.name} (${STEM_LABELS[stem] || stem})`
                      // Strip "(copy)" suffixes so cloned rows stay on the date
                      // until the user gives them a real custom name.
                      const baseName = liveName.replace(/(\s*\(copy\))+$/i, '')
                      const isCustom = !!liveName && baseName !== defaultName
                      const displayLabel = isCustom ? liveName : dateStr
                      const activate = async () => {
                        if (isActive) return
                        try {
                          const r = await fetch(`/api/tracks/${selectedTrack.id}/beatmaps/${bm.id}/activate`, { method: 'POST' })
                          if (!r.ok) throw new Error(`HTTP ${r.status}`)
                          await loadTracks()
                        } catch (e) {
                          setBatchError((e as Error).message)
                        }
                      }
                      return (
                      <div
                        key={bm.id}
                        className={`mt-1 flex items-center gap-1.5 rounded border px-1.5 py-1 ${
                          isActive ? 'border-jam-600/60 bg-jam-700/20' : 'border-gray-800 bg-gray-900/40'
                        }`}
                        title={liveName ? `${liveName} · ${dateStr}` : undefined}
                      >
                        <input
                          type="radio"
                          name={`active-beatmap-${stem}-${selectedTrack.id}`}
                          checked={isActive}
                          onChange={activate}
                          className="shrink-0 h-3.5 w-3.5 accent-jam-500 cursor-pointer"
                          title={isActive ? 'Active beatmap (used when publishing)' : 'Use this beatmap'}
                        />
                        <button
                          onClick={() => setStatsBeatmap(bm)}
                          className="flex-1 min-w-0 text-left text-[11px] text-gray-300 hover:text-gray-100 truncate transition-colors"
                          title={liveName ? `${liveName} · ${dateStr}` : 'View beatmap details'}
                        >
                          {displayLabel}
                        </button>
                        <button
                          onClick={() => navigate(`/edit/${selectedTrack.id}/${bm.id}`)}
                          className="shrink-0 px-2 py-0.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-gray-600 rounded text-[10px] text-gray-300 hover:text-gray-100 transition-colors"
                          title="Edit beatmap"
                        >
                          Edit
                        </button>
                      </div>
                      )
                    })}
                  </div>
                </div>
              ))}
          </div>

          {/* Batch generate row */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-gray-500">
              {selectedStems.size > 0
                ? `${selectedStems.size} stem${selectedStems.size === 1 ? '' : 's'} selected`
                : 'Tick stems above to queue multiple beatmap generations.'}
            </div>
            <div className="flex items-center gap-2">
              {batchError && <span className="text-xs text-red-400">{batchError}</span>}
              <button
                onClick={generateSelected}
                disabled={selectedStems.size === 0}
                className="px-3 py-1.5 bg-jam-600 hover:bg-jam-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-md text-xs font-medium transition-colors"
              >
                Generate beatmap for {selectedStems.size || 'selected'} stem{selectedStems.size === 1 ? '' : 's'}
              </button>
            </div>
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
              <div className="text-xs text-gray-500 mt-1 flex-1">
                <p>
                  <span className="text-gray-400 font-mono">album.png</span> — included in the published game folder.
                </p>
                <p className="text-gray-600 mt-1">Any image is resized to 512×512 PNG on save.</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      const artist = (songIni.artist || '').trim()
                      const title = (songIni.name || '').trim()
                      const album = (songIni.album || '').trim()
                      if (!artist && !title && !album) {
                        setCoverFetchState('error')
                        return
                      }
                      setCoverFetchState('loading')
                      try {
                        const fd = new FormData()
                        fd.append('artist', artist)
                        fd.append('title', title)
                        fd.append('album', album)
                        const res = await fetch('/api/beatmap/cover-art-search', { method: 'POST', body: fd })
                        if (res.status === 204) {
                          setCoverFetchState('none')
                          return
                        }
                        if (!res.ok) throw new Error(`${res.status}`)
                        const blob = await res.blob()
                        if (blob.size === 0) {
                          setCoverFetchState('none')
                          return
                        }
                        const file = new File([blob], 'album.png', { type: 'image/png' })
                        handleAlbumPick(file)
                        setCoverFetchState('idle')
                      } catch {
                        setCoverFetchState('error')
                      }
                    }}
                    disabled={coverFetchState === 'loading' || (!songIni.name && !songIni.artist && !songIni.album)}
                    className="px-2.5 py-1 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 border border-gray-700 hover:border-gray-600 text-gray-200 rounded-md text-xs font-medium transition-colors"
                    title="Pull cover art from iTunes / MusicBrainz using the name + artist below"
                  >
                    {coverFetchState === 'loading' ? 'Searching…' : 'Auto-fetch from name + artist'}
                  </button>
                  {coverFetchState === 'none' && (
                    <span className="text-amber-400">No cover found for those tags</span>
                  )}
                  {coverFetchState === 'error' && (
                    <span className="text-red-400">Search failed — fill in name + artist first</span>
                  )}
                </div>
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

          <SoundPackPanel track={selectedTrack} />
          <TutorialSamplesPanel track={selectedTrack} />
          <InlinePublish track={selectedTrack} />
        </div>

        {beatmapPanel && (
          <BeatmapPanel
            track={beatmapPanel.track}
            stem={beatmapPanel.stem}
            onClose={() => setBeatmapPanel(null)}
            onGenerated={loadTracks}
          />
        )}

        {statsBeatmap && selectedTrack && (
          <BeatmapStatsModal
            trackId={selectedTrack.id}
            beatmap={statsBeatmap}
            onClose={() => setStatsBeatmap(null)}
            onDeleted={() => {
              setStatsBeatmap(null)
              loadTracks()
            }}
            onRenamed={(updated) => {
              setStatsBeatmap((prev) => (prev ? { ...prev, song_name: updated.song_name } : prev))
              loadTracks()
            }}
            onCloned={(cloned) => {
              setStatsBeatmap(null)
              navigate(`/edit/${selectedTrack.id}/${cloned.id}`)
            }}
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
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Studio Library</h1>
        <p className="text-gray-500 mt-1">
          Tracks in progress and finished maps. Click any track to edit metadata, generate beatmaps, or publish.
          {' '}
          <Link to="/create" className="text-jam-300 hover:text-jam-200">+ Create a new track →</Link>
        </p>
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
        {/* Running / failed jobs as ghost rows. Done jobs whose track has been
            promoted into the library are filtered out so we don't double-list. */}
        {jobs
          .filter((j) => {
            if (j.status === 'done') return false
            if (j.status === 'cancelled' && Date.now() / 1000 - j.updated_at > 60 * 60) return false
            if (j.track_id && tracks.some((t) => t.id === j.track_id)) return false
            return true
          })
          .map((j) => {
            const pill = JOB_STATUS_PILL[j.status]
            const isActive = j.status === 'running' || j.status === 'queued'
            return (
              <div
                key={j.id}
                onClick={() => navigate(`/?job=${j.id}`)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    navigate(`/?job=${j.id}`)
                  }
                }}
                className="cursor-pointer bg-gray-900 border border-gray-800 hover:border-gray-700 hover:bg-gray-900/70 rounded-xl px-4 py-3 transition-colors"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-12 h-12 shrink-0 rounded-md bg-gray-800 border border-gray-700 flex items-center justify-center">
                      {isActive ? (
                        <div className="animate-spin h-5 w-5 border-2 border-jam-400 border-t-transparent rounded-full" />
                      ) : j.status === 'failed' ? (
                        <span className="text-red-400 text-lg leading-none">!</span>
                      ) : (
                        <span className="text-gray-600 text-[10px] font-mono">job</span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium text-gray-100 truncate">
                          {j.title || j.id}
                        </h3>
                        <span
                          className={`shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-medium uppercase tracking-wider ${pill.cls}`}
                        >
                          {pill.label}
                        </span>
                      </div>
                      <p className="text-xs text-gray-600 mt-0.5 truncate">
                        {j.kind === 'manual_stems' ? 'Stems-only mux' : 'Stem separation'}
                        {' · '}
                        {formatDate(j.created_at)}
                        {isActive && j.last_message ? (
                          <>
                            <span className="text-gray-700"> · </span>
                            <span className="text-gray-500">{j.last_message}</span>
                          </>
                        ) : null}
                        {j.status === 'failed' && j.error ? (
                          <>
                            <span className="text-gray-700"> · </span>
                            <span className="text-red-400/80">{j.error}</span>
                          </>
                        ) : null}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {isActive && (
                      <span className="text-xs font-mono text-gray-500">{j.progress}%</span>
                    )}
                    {!isActive && (
                      <button
                        type="button"
                        onClick={async (e) => {
                          e.stopPropagation()
                          try {
                            await fetch(`/api/jobs/${j.id}`, { method: 'DELETE' })
                            loadJobs()
                          } catch {
                            // best-effort; the row will refresh on next poll
                          }
                        }}
                        className="px-2.5 py-1 bg-red-900/30 hover:bg-red-800/60 border border-red-800/50 hover:border-red-700 text-red-300 hover:text-red-200 rounded-md text-xs font-medium transition-colors"
                        aria-label={`Delete job ${j.title || j.id}`}
                      >
                        Delete
                      </button>
                    )}
                    <span className="text-gray-600">→</span>
                  </div>
                </div>
              </div>
            )
          })}
        {tracks.map((track) => {
          const stemCount = Object.entries(track.stems).filter(
            ([k]) => !NON_AUDIO_KEYS.has(k),
          ).length
          const hasArt = !!track.stems.album_png
          return (
            <div
              key={track.id}
              onClick={() => setSelectedId(track.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setSelectedId(track.id)
                }
              }}
              className="cursor-pointer bg-gray-900 border border-gray-800 hover:border-gray-700 hover:bg-gray-900/70 rounded-xl px-4 py-3 transition-colors"
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
                    <h3 className="font-medium text-gray-100 truncate">
                      {track.artist ? `${track.artist} — ${track.name}` : track.name}
                    </h3>
                    <p className="text-xs text-gray-600 mt-0.5">
                      {formatDate(track.created_at)} &middot; {track.model} &middot;{' '}
                      {track.output_format.toUpperCase()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-gray-500">{stemCount} stems</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      setConfirmDelete(track)
                    }}
                    className="px-2.5 py-1 bg-red-900/30 hover:bg-red-800/60 border border-red-800/50 hover:border-red-700 text-red-300 hover:text-red-200 rounded-md text-xs font-medium transition-colors"
                    aria-label={`Delete ${track.name}`}
                  >
                    Delete
                  </button>
                  <span className="text-gray-600">→</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>

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
