import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import StemPlayer from './StemPlayer.tsx'
import BeatmapStatsModal, { BeatmapRecord } from './BeatmapStatsModal.tsx'
import LyricsButtons from './LyricsButtons'
import VocalmapButtons from './VocalmapButtons'
import useInstalledVersion from './useInstalledVersion'
import { useExclusiveTask } from './useExclusiveTask'
import StemGenerationModal from './StemGenerationModal'
import {
  GENERATION_STAGE_LABELS,
  type GenerationStage,
  type GenerationState,
  type QueuedGeneration,
} from './pipeline/generationTypes'
import { materializeQueue } from './pipeline/queueBuilder'
import { loadStoredGeneration, saveStoredGeneration } from './pipeline/generationStorage'
import { STEM_COLORS, STEM_LABELS } from './stemDisplay'

interface StemResultProps {
  jobId: string
  metadata: Record<string, unknown>
}

// Keys that historically appeared in the stems map but aren't actual audio
const NON_AUDIO_KEYS = new Set(['song_ini', 'album_png'])

// Mirrors LyricsButtons / VocalmapButtons SOURCE_BADGE: short uppercase badge
// for the model that produced the beatmap. Legacy records (no model field)
// fall through to the neutral gray badge.
const BEATMAP_MODEL_BADGE: Record<string, string> = {
  madmom: 'bg-green-700/40 text-green-200 border-green-700/60',
  manual: 'bg-gray-700/40 text-gray-200 border-gray-700/60',
  imported: 'bg-blue-700/40 text-blue-200 border-blue-700/60',
}

type BeatmapState = 'idle' | 'generating' | 'done' | 'error'

function StemBeatmapTracker({
  beatmapJobId,
  onDone,
  onView,
  onCancelled,
  onError,
}: {
  beatmapJobId: string
  onDone?: (jobId: string) => void
  onView?: (jobId: string) => void
  onCancelled?: () => void
  onError?: () => void
}) {
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState('Starting...')
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [cancelled, setCancelled] = useState(false)

  useEffect(() => {
    const evtSource = new EventSource(`/api/beatmap/${beatmapJobId}/status`)

    evtSource.onmessage = (e) => {
      const data = JSON.parse(e.data)
      if (data.progress >= 0) setProgress(data.progress)
      setMessage(data.message)

      if (data.step === 'done') {
        evtSource.close()
        setDone(true)
        if (onDone) onDone(beatmapJobId)
      } else if (data.step === 'error') {
        evtSource.close()
        setError(data.message)
        if (onError) onError()
      } else if (data.step === 'cancelled') {
        evtSource.close()
        setCancelled(true)
        if (onCancelled) onCancelled()
      }
    }

    evtSource.onerror = () => {
      evtSource.close()
      setError('Connection lost')
      if (onError) onError()
    }

    return () => evtSource.close()
  }, [beatmapJobId, onDone, onCancelled, onError])

  if (cancelled) {
    return <div className="text-xs text-gray-500 mt-1">Cancelled</div>
  }

  if (error) {
    return <div className="text-xs text-red-400 mt-1">{error}</div>
  }

  if (done) {
    return (
      <div className="flex flex-wrap gap-1.5 mt-1">
        {onView && (
          <button
            onClick={() => onView(beatmapJobId)}
            className="px-2.5 py-1 bg-jam-600 hover:bg-jam-500 text-white rounded text-xs font-medium transition-colors"
          >
            View stats
          </button>
        )}
        <a
          href={`/api/beatmap/${beatmapJobId}/download/zip`}
          className="px-2.5 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded text-xs font-medium transition-colors"
        >
          ZIP
        </a>
        <a
          href={`/api/beatmap/${beatmapJobId}/download/notes.chart`}
          className="px-2.5 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded text-xs font-medium transition-colors"
        >
          .chart
        </a>
      </div>
    )
  }

  return (
    <div className="mt-1 space-y-1">
      <div className="w-full bg-gray-900 rounded-full h-1.5 overflow-hidden">
        <div
          className="bg-jam-500 h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.max(progress, 2)}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-gray-500 truncate flex-1">{message}</div>
        <button
          onClick={async () => {
            try {
              await fetch(`/api/beatmap/${beatmapJobId}/cancel`, { method: 'POST' })
            } catch {
              // best-effort
            }
          }}
          className="shrink-0 px-2 py-0.5 bg-red-900/40 hover:bg-red-800/60 border border-red-800 text-red-300 hover:text-red-200 rounded text-[10px] font-medium transition-colors"
        >
          Kill
        </button>
      </div>
    </div>
  )
}

export default function StemResult({ jobId, metadata }: StemResultProps) {
  const navigate = useNavigate()
  const stems = (metadata.stems || {}) as Record<string, string>
  const trackName = (metadata.original_name as string) || 'track'
  const isGameReady = !!metadata.game_ready
  const trackId = (metadata.track_id as string) || ''
  const [beatmaps, setBeatmaps] = useState<Record<string, { jobId: string; state: BeatmapState; preset?: string }>>({})
  // Queued generations waiting behind the active one in `beatmaps[stem]`.
  // Drained by the SSE-done callback below; cleared by error/cancel paths.
  const [beatmapQueue, setBeatmapQueue] = useState<Record<string, QueuedGeneration[]>>({})
  // Stems waiting their turn in a "Generate beatmap for N selected stems"
  // batch. The active stem is the one in beatmaps[]; this list is everything
  // queued behind it. batchTotal is the original size of the multi-stem
  // batch (used to compute "X of N done" — only set while a multi-stem
  // batch is running so a single-stem fire keeps the row clean).
  const [pendingStems, setPendingStems] = useState<string[]>([])
  const [batchTotal, setBatchTotal] = useState<number | null>(null)
  // Mirror beatmapQueue + pendingStems through refs so the tracker callbacks
  // (which capture stale state) can read the latest at fire time without
  // pulling them into dep arrays.
  const beatmapQueueRef = useRef(beatmapQueue)
  beatmapQueueRef.current = beatmapQueue
  const pendingStemsRef = useRef(pendingStems)
  pendingStemsRef.current = pendingStems
  const [statsBeatmap, setStatsBeatmap] = useState<BeatmapRecord | null>(null)
  const [publishing, setPublishing] = useState<'idle' | 'publishing' | 'done' | 'error'>('idle')
  const [publishResult, setPublishResult] = useState<{ commitUrl: string; folder: string } | null>(null)
  const [publishError, setPublishError] = useState('')

  const [songIni, setSongIni] = useState<Record<string, string>>(() => {
    const raw = (metadata.song_ini || {}) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) out[k] = String(v ?? '')
    // If song.ini didn't carry name/artist (no embedded tags), fall back to the
    // upload filename. "Artist - Track Name.mp3" → artist + name; otherwise the
    // whole stem becomes name with artist left blank.
    const original = (metadata.original_name as string) || ''
    if (original && (!out.name || !out.artist)) {
      const parts = original.split(/\s*-\s*/)
      if (parts.length >= 2) {
        if (!out.artist) out.artist = parts[0].trim()
        if (!out.name) out.name = parts.slice(1).join(' - ').trim()
      } else if (!out.name) {
        out.name = original
      }
    }
    return out
  })
  const [coverFetchState, setCoverFetchState] = useState<'idle' | 'loading' | 'none' | 'error'>('idle')
  const [iniSaveState, setIniSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [iniError, setIniError] = useState('')
  const [stemPeaks, setStemPeaks] = useState<Record<string, number[]> | null>(null)
  const [vocalsStale, setVocalsStale] = useState(false)
  const [selectedStems, setSelectedStems] = useState<Set<string>>(new Set())
  const [hasVocalNotes, setHasVocalNotes] = useState(false)
  const [batchError, setBatchError] = useState('')
  const [existingBeatmaps, setExistingBeatmaps] = useState<BeatmapRecord[]>([])

  // Shared generation state for all non-drums stems on this page. Persisted
  // to localStorage so the user's preset/engine choices survive reloads.
  // Stays in sync with the cog modal: edits via the modal update this state
  // and the next click of the green main button picks them up. `activePresets`
  // is the multi-select picker state — one entry per preset to batch-run,
  // empty string for the "Custom" (engine-cards) pick.
  //
  // useState lazy-init runs the loader twice on mount (once per useState),
  // but JSON.parse on a tiny stored object is negligible.
  const [generation, setGeneration] = useState<GenerationState>(() => loadStoredGeneration().generation)
  const [activePresets, setActivePresets] = useState<string[]>(() => loadStoredGeneration().activePresets)
  const [modalStem, setModalStem] = useState<string | null>(null)

  // Persist on every change. Note: this also fires on the initial mount,
  // writing the just-loaded values back to localStorage. Harmless but
  // unavoidable with this pattern — the write is synchronous and tiny.
  useEffect(() => {
    saveStoredGeneration(generation, activePresets)
  }, [generation, activePresets])

  const installedMadmom = useInstalledVersion('madmom')
  const lock = useExclusiveTask()
  const beatmapBtnLabel = installedMadmom
    ? `Generate Beatmap with madmom ${installedMadmom}`
    : 'Generate Beatmap'

  const refetchBeatmaps = useCallback(async () => {
    if (!trackId) { setExistingBeatmaps([]); return }
    try {
      const r = await fetch(`/api/tracks/${trackId}`)
      if (!r.ok) { setExistingBeatmaps([]); return }
      const data = await r.json()
      setExistingBeatmaps(Array.isArray(data.beatmaps) ? data.beatmaps : [])
    } catch {
      setExistingBeatmaps([])
    }
  }, [trackId])

  useEffect(() => { refetchBeatmaps() }, [refetchBeatmaps])

  const formatDate = (ts: number) =>
    new Date(ts * 1000).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })

  const toggleSelectedStem = (stem: string) =>
    setSelectedStems((prev) => {
      const next = new Set(prev)
      if (next.has(stem)) next.delete(stem)
      else next.add(stem)
      return next
    })

  const refetchHasVocalNotes = useCallback(async () => {
    if (!jobId) { setHasVocalNotes(false); return }
    try {
      const r = await fetch(`/api/vocals/exists?job_id=${jobId}`)
      if (!r.ok) { setHasVocalNotes(false); return }
      const { exists } = await r.json()
      setHasVocalNotes(!!exists)
    } catch {
      setHasVocalNotes(false)
    }
  }, [jobId])

  useEffect(() => { refetchHasVocalNotes() }, [refetchHasVocalNotes])

  // Auto-tick stems that already have a chart on initial load so the user
  // can see at a glance what's covered. Beatmaps arrive via the tracks
  // refetch; vocals lags on its own probe so it gets a separate one-shot
  // applied flag. Manual unticks after the first pass stick.
  const autoTickRef = useRef<{ jobId: string; vocalsApplied: boolean }>({ jobId: '', vocalsApplied: false })
  useEffect(() => {
    if (!jobId) {
      autoTickRef.current = { jobId: '', vocalsApplied: false }
      return
    }
    if (autoTickRef.current.jobId !== jobId) {
      const next = new Set<string>()
      for (const bm of existingBeatmaps) next.add(bm.stem)
      setSelectedStems(next)
      autoTickRef.current = { jobId, vocalsApplied: false }
    }
    if (
      hasVocalNotes &&
      !autoTickRef.current.vocalsApplied &&
      Object.prototype.hasOwnProperty.call(stems, 'vocals')
    ) {
      setSelectedStems((prev) => {
        if (prev.has('vocals')) return prev
        const next = new Set(prev)
        next.add('vocals')
        return next
      })
      autoTickRef.current.vocalsApplied = true
    }
  }, [jobId, existingBeatmaps, hasVocalNotes, stems])

  const deleteVocalNotes = async () => {
    if (!jobId) return
    if (!window.confirm('Delete the vocal beatmap for this track? Lyrics versions are kept.')) return
    try {
      const r = await fetch(`/api/vocals?job_id=${jobId}`, { method: 'DELETE' })
      if (!r.ok) {
        const e = await r.json().catch(() => ({}))
        throw new Error(e.detail || `HTTP ${r.status}`)
      }
      setHasVocalNotes(false)
    } catch (e) {
      alert((e as Error).message)
    }
  }

  // Fetch backend-precomputed waveform peaks once. If 404 (older job), each
  // StemPlayer falls back to its in-browser Web Audio decode.
  useEffect(() => {
    if (!jobId) return
    const ctrl = new AbortController()
    fetch(`/api/stems/${jobId}/peaks`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data) setStemPeaks(data) })
      .catch(() => { /* ignore — fallback to client decode */ })
    return () => ctrl.abort()
  }, [jobId])

  // Detect vocal_notes.json staleness vs current lyrics.json. The browser
  // computes sha1 over a canonical JSON projection that mirrors the
  // backend's hashlib.sha1(json.dumps(lyrics, sort_keys=True, ensure_ascii=False)).
  // Probe /exists first — the staleness comparison is meaningless when either
  // side is missing, and skipping the data fetch avoids 404s in the console
  // for the common fresh-job case where neither file has been generated yet.
  useEffect(() => {
    if (!jobId) return
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const [lProbe, vProbe] = await Promise.all([
          fetch(`/api/lyrics/exists?job_id=${jobId}`, { signal: ctrl.signal })
            .then((r) => (r.ok ? r.json() : { exists: false }))
            .catch(() => ({ exists: false })),
          fetch(`/api/vocals/exists?job_id=${jobId}`, { signal: ctrl.signal })
            .then((r) => (r.ok ? r.json() : { exists: false }))
            .catch(() => ({ exists: false })),
        ])
        if (!lProbe.exists || !vProbe.exists) return
        const [lyrics, notes] = await Promise.all([
          fetch(`/api/lyrics?job_id=${jobId}`, { signal: ctrl.signal })
            .then((r) => (r.ok ? r.json() : null)),
          fetch(`/api/vocals?job_id=${jobId}`, { signal: ctrl.signal })
            .then((r) => (r.ok ? r.json() : null)),
        ])
        if (lyrics && notes?.lyrics_etag) {
          const canonical = JSON.stringify(lyrics, Object.keys(lyrics).sort())
          const buf = new TextEncoder().encode(canonical)
          const hash = await crypto.subtle.digest('SHA-1', buf)
          const hex = Array.from(new Uint8Array(hash))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
          setVocalsStale(hex !== notes.lyrics_etag)
        }
      } catch { /* ignore — aborted or transient */ }
    })()
    return () => ctrl.abort()
  }, [jobId])
  const updateIni = (key: string, value: string) =>
    setSongIni((prev) => ({ ...prev, [key]: value }))

  // Album art — preview existing if any, click to replace
  const albumInputRef = useRef<HTMLInputElement | null>(null)
  const [albumArtFile, setAlbumArtFile] = useState<File | null>(null)
  const [albumPreview, setAlbumPreview] = useState<string | null>(() =>
    (metadata.stems as Record<string, string> | undefined)?.album_png
      ? `/api/stems/${jobId}/download/album_png`
      : null,
  )
  const handleAlbumPick = (f: File | null) => {
    if (!f) return
    if (albumPreview && albumPreview.startsWith('blob:')) URL.revokeObjectURL(albumPreview)
    setAlbumArtFile(f)
    setAlbumPreview(URL.createObjectURL(f))
  }

  const fetchCoverByTags = async () => {
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
  }

  const saveSongIni = async () => {
    setIniSaveState('saving')
    setIniError('')
    try {
      const fd = new FormData()
      fd.append('fields', JSON.stringify(songIni))
      if (albumArtFile) fd.append('album_art', albumArtFile)
      const res = await fetch(`/api/stems/${jobId}/song-ini`, { method: 'PATCH', body: fd })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Save failed: ${res.status}`)
      }
      setSongIni(await res.json())
      if (albumArtFile) {
        // Force a fresh fetch from server now that album.png was rewritten
        if (albumPreview && albumPreview.startsWith('blob:')) URL.revokeObjectURL(albumPreview)
        setAlbumArtFile(null)
        setAlbumPreview(`/api/stems/${jobId}/download/album_png?t=${Date.now()}`)
      }
      setIniSaveState('saved')
      setTimeout(() => setIniSaveState('idle'), 2000)
    } catch (e) {
      setIniError((e as Error).message)
      setIniSaveState('error')
    }
  }

  const publishToGame = async () => {
    setPublishing('publishing')
    setPublishError('')
    try {
      const res = await fetch(`/api/stems/${jobId}/publish`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Publish failed')
      }
      const data = await res.json()
      setPublishResult({ commitUrl: data.commit_url, folder: data.folder })
      setPublishing('done')
    } catch (e) {
      setPublishError((e as Error).message)
      setPublishing('error')
    }
  }

  // Fire ONE V2 generation against `trackId` using the materialised item's
  // {preset, generation} bundle. Sets the resulting job_id into beatmaps[stem]
  // so <StemBeatmapTracker> picks it up. Throws on HTTP failure so the caller
  // can clean up the queue + release the lock.
  const fireOneV2 = async (stem: string, item: QueuedGeneration) => {
    if (!trackId) throw new Error('trackId required for V2 generation')
    const formData = new FormData()
    formData.append('stem', stem)
    for (const [key, val] of Object.entries(songIni)) {
      formData.append(key, String(val ?? ''))
    }
    for (const stage of Object.keys(GENERATION_STAGE_LABELS) as GenerationStage[]) {
      const sel = item.generation[stage]
      const fieldPrefix =
        stage === 'lanes_expert' ? 'lanes' :
        stage === 'lanes_filtered' ? 'playability' :
        stage
      formData.append(`${fieldPrefix}_engine`, sel.engine)
      formData.append(`${fieldPrefix}_params`, JSON.stringify(sel.params))
    }
    if (item.preset) formData.append('preset', item.preset)
    const res = await fetch(`/api/tracks/${trackId}/generate-beatmap-v2`, { method: 'POST', body: formData })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.detail || 'Failed to start beatmap generation')
    }
    const { job_id } = await res.json()
    setBeatmaps((prev) => ({ ...prev, [stem]: { jobId: job_id, state: 'generating', preset: item.preset } }))
  }

  // Kick off a batch of generations for a single stem. Caller must NOT
  // pre-acquire the lock; this function takes it.
  const startBatch = (stem: string, queue: QueuedGeneration[]) => {
    if (queue.length === 0) return
    if (!lock.acquire(`beatmap:${stem}`)) return
    setBeatmaps((prev) => ({ ...prev, [stem]: { jobId: '', state: 'generating', preset: queue[0].preset } }))
    setBeatmapQueue((prev) => ({ ...prev, [stem]: queue.slice(1) }))
    fireOneV2(stem, queue[0]).catch((e) => {
      setBeatmaps((prev) => ({ ...prev, [stem]: { jobId: '', state: 'error' } }))
      setBeatmapQueue((prev) => { const n = { ...prev }; delete n[stem]; return n })
      setBatchError((e as Error).message)
      lock.release()
    })
  }

  // Drain the next queued item for `stem` (if any). Used by the tracker's
  // onDone callback to chain runs. Returns true if it fired the next one;
  // false if the queue was empty (caller should release the lock).
  const dequeueAndFire = (stem: string): boolean => {
    const remaining = beatmapQueueRef.current[stem] || []
    if (remaining.length === 0) return false
    const item = remaining[0]
    setBeatmapQueue((prev) => {
      const arr = prev[stem] || []
      const n = { ...prev }
      if (arr.length <= 1) delete n[stem]
      else n[stem] = arr.slice(1)
      return n
    })
    setBeatmaps((prev) => ({ ...prev, [stem]: { jobId: '', state: 'generating', preset: item.preset } }))
    fireOneV2(stem, item).catch((e) => {
      setBeatmaps((prev) => ({ ...prev, [stem]: { jobId: '', state: 'error' } }))
      setBeatmapQueue((prev) => { const n = { ...prev }; delete n[stem]; return n })
      setBatchError((e as Error).message)
      lock.release()
    })
    return true
  }

  const generateBeatmap = async (stem: string) => {
    setBatchError('')
    // Loose-stems mode (no trackId, e.g. legacy upload flow) keeps the
    // single-shot v1 endpoint. Multi-select / batch is V2-only.
    if (!trackId) {
      if (!lock.acquire(`beatmap:${stem}`)) return
      const label = STEM_LABELS[stem] || stem
      setBeatmaps((prev) => ({ ...prev, [stem]: { jobId: '', state: 'generating' } }))
      try {
        const formData = new FormData()
        formData.append('stem_job_id', jobId)
        formData.append('stem', stem)
        formData.append('title', `${trackName} (${label})`)
        const res = await fetch('/api/beatmap/from-stem', { method: 'POST', body: formData })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.detail || 'Failed to start beatmap generation')
        }
        const { job_id } = await res.json()
        setBeatmaps((prev) => ({ ...prev, [stem]: { jobId: job_id, state: 'generating' } }))
      } catch (e) {
        setBeatmaps((prev) => ({ ...prev, [stem]: { jobId: '', state: 'error' } }))
        setBatchError((e as Error).message)
        lock.release()
      }
      return
    }
    // V2 path: materialise queue from the picker selection and run it.
    try {
      const queue = await materializeQueue(activePresets, generation, stem)
      if (queue.length === 0) {
        setBatchError('Pick at least one preset (open the cog to edit).')
        return
      }
      startBatch(stem, queue)
    } catch (e) {
      setBatchError((e as Error).message)
    }
  }

  // Drain the next pending stem (if any) and fire its batch. Called from
  // the tracker callbacks once a stem's per-preset queue is fully drained,
  // so multi-stem batches actually progress stem-by-stem instead of getting
  // wedged behind the page-scoped lock.
  const triggerNextStemIfAny = () => {
    const remaining = pendingStemsRef.current
    if (remaining.length === 0) {
      setBatchTotal(null)
      return false
    }
    const [next, ...rest] = remaining
    setPendingStems(rest)
    generateBeatmap(next)
    return true
  }

  const generateSelected = () => {
    setBatchError('')
    const targets = Array.from(selectedStems).filter(
      (stem) => stem !== 'song' && stem !== 'vocals' && !NON_AUDIO_KEYS.has(stem) && !beatmaps[stem],
    )
    if (targets.length === 0) return
    if (lock.owner) {
      setBatchError('Wait for the current task to finish.')
      return
    }
    setSelectedStems(new Set())
    if (targets.length > 1) {
      setBatchTotal(targets.length)
      setPendingStems(targets.slice(1))
    } else {
      setBatchTotal(null)
      setPendingStems([])
    }
    generateBeatmap(targets[0])
  }

  const createdAt = typeof metadata.created_at === 'number' ? (metadata.created_at as number) : null
  const modelName = (metadata.model as string) || ''
  const outputFormat = (metadata.output_format as string) || ''
  const meta = {
    artist: (songIni.artist || '').trim(),
    title: (songIni.name || '').trim(),
    album: (songIni.album || '').trim() || undefined,
    duration_s: typeof metadata.duration === 'number' ? metadata.duration : undefined,
  }
  const headerTitle = (() => {
    const liveName = meta.title || trackName
    return meta.artist ? `${meta.artist} — ${liveName}` : liveName
  })()

  return (
    <div className="space-y-6">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="font-semibold text-gray-100 text-lg">{headerTitle}</h3>
            <p className="text-xs text-gray-600 mt-0.5">
              {createdAt ? formatDate(createdAt) : (metadata.model === 'manual' ? 'Conversion Complete' : 'Separation Complete')}
              {modelName && <> &middot; {modelName}</>}
              {outputFormat && <> &middot; {outputFormat.toUpperCase()}</>}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          {Object.entries(stems)
            .filter(([stem]) => !NON_AUDIO_KEYS.has(stem))
            .map(([stem]) => {
            const label = STEM_LABELS[stem] || stem
            const color = STEM_COLORS[stem] || 'text-gray-300'
            const bm = beatmaps[stem]
            return (
              <div
                key={stem}
                className="bg-gray-800 border border-gray-700 rounded-lg p-3 flex flex-col gap-3 relative"
              >
                {/* Top row: identity + waveform spanning the full width */}
                <div className="flex items-center gap-3">
                  {/* Identity: checkbox + stem label */}
                  <div className="w-24 shrink-0 flex items-center justify-center gap-2">
                    {stem !== 'song' ? (
                      <input
                        type="checkbox"
                        checked={selectedStems.has(stem)}
                        onChange={() => toggleSelectedStem(stem)}
                        className="h-4 w-4 rounded border-gray-600 bg-gray-900 accent-jam-500 cursor-pointer shrink-0"
                        aria-label={`Select ${label} for batch beatmap`}
                        title="Select for batch beatmap generation"
                      />
                    ) : (
                      <div className="h-4 w-4 shrink-0" />
                    )}
                    <span className={`text-sm font-semibold ${color}`}>{label}</span>
                  </div>

                  {/* Waveform (gets the rest of the width) */}
                  <div className="flex-1 min-w-0 flex items-center">
                    <StemPlayer src={`/api/stems/${jobId}/download/${stem}`} peaks={stemPeaks?.[stem] ?? null} />
                  </div>
                </div>

                {/* Bottom row: actions + beatmap list, full width so each row stays on one line */}
                <div className="flex flex-col gap-1.5">
                  {stem === 'vocals' && (
                    <>
                      <LyricsButtons scope={{ jobId }} hasVocals={true} meta={meta} />
                      <VocalmapButtons
                        scope={{ jobId }}
                        meta={{ artist: meta.artist, title: meta.title, album: meta.album }}
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
                      {vocalsStale && (
                        <div className="bg-amber-900/40 border border-amber-800 rounded p-2 text-xs text-amber-200">
                          Lyrics changed since vocal beatmap was generated. Re-generate to refresh.
                        </div>
                      )}
                    </>
                  )}

                  {stem !== 'vocals' && (
                    <div className="flex items-stretch gap-1">
                      {stem === 'song' ? (
                        <a
                          href={`/api/stems/${jobId}/download/${stem}`}
                          className="flex-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded text-xs font-medium transition-colors text-center"
                        >
                          Download
                        </a>
                      ) : (
                        !bm && (
                          <>
                            <button
                              onClick={() => generateBeatmap(stem)}
                              disabled={lock.lockedByOther(`beatmap:${stem}`)}
                              className="flex-1 px-3 py-1.5 bg-green-700/60 hover:bg-green-600/70 disabled:opacity-50 disabled:cursor-not-allowed text-green-100 rounded text-xs font-medium transition-colors"
                              title={lock.lockedByOther(`beatmap:${stem}`) ? 'Another task is running' : 'Generate beatmap with the installed madmom model'}
                            >
                              {beatmapBtnLabel}
                            </button>
                            {trackId && (
                              <button
                                type="button"
                                onClick={() => setModalStem(stem)}
                                className="px-2 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded text-xs transition-colors"
                                title="Change preset / engine settings"
                                aria-label={`Open generation settings for ${STEM_LABELS[stem] || stem}`}
                              >
                                ⚙
                              </button>
                            )}
                          </>
                        )
                      )}
                    </div>
                  )}

                  {stem !== 'vocals' && stem !== 'song' && !bm && activePresets.length > 0 &&
                    !(activePresets.length === 1 && activePresets[0] === 'v1') && (
                    <span
                      className="self-center text-[10px] text-gray-500 italic mt-0.5"
                      title={`Generation ${activePresets.length === 1 ? 'preset' : 'presets'}: ${activePresets.map((n) => n || 'Custom').join(', ')}`}
                    >
                      {activePresets.length === 1 ? 'preset' : 'presets'}: {activePresets.map((n) => n || 'Custom').join(', ')}
                    </span>
                  )}

                  {/* Skip beat detection — open the editor with an empty chart.
                      Requires the track to have been saved to the library
                      (track_id present), which the Create flow does. */}
                  {stem !== 'song' && stem !== 'vocals' && trackId && !bm && (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          const fd = new FormData()
                          fd.append('stem', stem)
                          const res = await fetch(`/api/tracks/${trackId}/empty-beatmap`, { method: 'POST', body: fd })
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

                  {bm?.state === 'generating' && !bm.jobId && stem !== 'vocals' && (
                    <div className="flex items-center gap-1.5 mt-1">
                      <div className="animate-spin h-3 w-3 border-2 border-jam-400 border-t-transparent rounded-full" />
                      <span className="text-xs text-gray-500">
                        Starting{bm.preset !== undefined ? ` "${bm.preset || 'Custom'}"` : ''}...
                      </span>
                    </div>
                  )}

                  {bm?.state === 'generating' && bm.jobId && stem !== 'vocals' && (
                    <>
                      {bm.preset !== undefined && (
                        <div className="text-[10px] text-jam-300 mt-0.5">
                          Generating "{bm.preset || 'Custom'}"
                        </div>
                      )}
                      <StemBeatmapTracker
                        key={bm.jobId}
                        beatmapJobId={bm.jobId}
                        onCancelled={() => {
                          setBeatmaps((prev) => {
                            const next = { ...prev }
                            delete next[stem]
                            return next
                          })
                          setBeatmapQueue((prev) => { const n = { ...prev }; delete n[stem]; return n })
                          // Cancel aborts the whole multi-stem batch too —
                          // the user asked the active task to stop, treat
                          // that as "stop everything".
                          setPendingStems([])
                          setBatchTotal(null)
                          lock.release()
                        }}
                        onDone={() => {
                          refetchBeatmaps()
                          const fired = dequeueAndFire(stem)
                          if (!fired) {
                            setBeatmaps((prev) => {
                              const next = { ...prev }
                              delete next[stem]
                              return next
                            })
                            lock.release()
                            // This stem's whole per-preset batch is done;
                            // move on to the next stem in the multi-stem
                            // queue (if any).
                            triggerNextStemIfAny()
                          }
                          // When fired, dequeueAndFire already replaced
                          // beatmaps[stem] with the next job — the tracker
                          // re-keys on the new jobId and starts watching it.
                        }}
                        onError={() => {
                          setBeatmapQueue((prev) => { const n = { ...prev }; delete n[stem]; return n })
                          lock.release()
                          // Move on to the next stem in the multi-stem queue —
                          // a single transient failure shouldn't kill the
                          // whole batch. The "Failed" pill stays on this row.
                          triggerNextStemIfAny()
                        }}
                        onView={
                          trackId
                            ? (id) =>
                                setStatsBeatmap({
                                  id,
                                  stem,
                                  generated_at: Date.now() / 1000,
                                  folder_name: '',
                                  song_name: `${trackName} (${label})`,
                                })
                            : undefined
                        }
                      />
                    </>
                  )}

                  {bm?.state === 'generating' && (beatmapQueue[stem]?.length ?? 0) > 0 && (
                    <div
                      className="text-[10px] text-gray-500 italic mt-1 truncate"
                      title="Generations queued behind the active run"
                    >
                      queued: {(beatmapQueue[stem] || []).map((q) => q.preset || 'Custom').join(' · ')}
                    </div>
                  )}

                  {bm?.state === 'error' && (
                    <div className="text-xs text-red-400 mt-1">Failed</div>
                  )}

                  {/* Pre-existing beatmaps for this stem — open in editor or
                      view stats. Rendered for non-vocals only; vocals uses
                      vocal_notes.json via VocalmapButtons, not this list. */}
                  {stem !== 'vocals' && trackId && existingBeatmaps
                    .filter((b) => b.stem === stem)
                    .sort((a, b) => b.generated_at - a.generated_at)
                    .map((b) => {
                      const liveName = (b.song_name || '').trim()
                      const dateStr = formatDate(b.generated_at)
                      const isActive = !!b.active
                      const defaultName = `${trackName} (${label})`
                      // Treat "<default>", "<default> (copy)", "<default> (copy) (copy)"
                      // etc. as still-default so cloned rows keep showing the
                      // generated-at date rather than redundant track-name noise.
                      const baseName = liveName.replace(/(\s*\(copy\))+$/i, '')
                      const isCustom = !!liveName && baseName !== defaultName
                      const model = (b.model || 'madmom').toLowerCase()
                      const modelVer = (b.model_version || '').trim()
                      const modelLabel = modelVer ? `${model.toUpperCase()} ${modelVer}` : model.toUpperCase()
                      const modelBadgeCls = BEATMAP_MODEL_BADGE[model] || BEATMAP_MODEL_BADGE.manual
                      const isOlder = model === 'madmom' && !!modelVer && !!installedMadmom && modelVer !== installedMadmom
                      const activate = async () => {
                        if (isActive) return
                        try {
                          const r = await fetch(`/api/tracks/${trackId}/beatmaps/${b.id}/activate`, { method: 'POST' })
                          if (!r.ok) throw new Error(`HTTP ${r.status}`)
                          await refetchBeatmaps()
                        } catch (e) {
                          setBatchError((e as Error).message)
                        }
                      }
                      return (
                        <div
                          key={b.id}
                          className={`mt-1 flex items-center gap-1.5 rounded border px-1.5 py-1 ${
                            isActive ? 'border-jam-600/60 bg-jam-700/20' : 'border-gray-800 bg-gray-900/40'
                          }`}
                          title={liveName ? `${liveName} · ${dateStr}` : undefined}
                        >
                          <input
                            type="radio"
                            name={`active-beatmap-${stem}-${trackId}`}
                            checked={isActive}
                            onChange={activate}
                            className="shrink-0 h-3.5 w-3.5 accent-jam-500 cursor-pointer"
                            title={isActive ? 'Active beatmap (used when publishing)' : 'Use this beatmap'}
                          />
                          <span className={`shrink-0 inline-block px-1 py-0.5 rounded border text-[9px] font-semibold uppercase ${modelBadgeCls}`}>
                            {modelLabel}
                          </span>
                          <button
                            onClick={() => setStatsBeatmap(b)}
                            className="flex-1 min-w-0 text-left text-[10px] text-gray-400 hover:text-gray-200 truncate transition-colors"
                            title={liveName ? `${liveName} · ${dateStr}` : 'View beatmap details'}
                          >
                            {dateStr}
                            {isCustom && <span className="ml-1 text-gray-200">· {liveName}</span>}
                            {isOlder && (
                              <span className="ml-1 text-amber-400" title={`Re-generating would use madmom ${installedMadmom}`}>
                                (older)
                              </span>
                            )}
                          </button>
                          <button
                            onClick={() => navigate(`/edit/${trackId}/${b.id}`)}
                            className="shrink-0 px-2 py-0.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-gray-600 rounded text-[10px] text-gray-300 hover:text-gray-100 transition-colors"
                            title="Edit beatmap"
                          >
                            Edit
                          </button>
                          <button
                            onClick={async () => {
                              const msg = isActive
                                ? `Delete the ACTIVE ${label} beatmap? No beatmap will be active for this stem until you pick another or generate a fresh one.`
                                : 'Delete this beatmap? The active version is unaffected.'
                              if (!window.confirm(msg)) return
                              try {
                                const r = await fetch(`/api/tracks/${trackId}/beatmaps/${b.id}`, { method: 'DELETE' })
                                if (!r.ok) {
                                  const e = await r.json().catch(() => ({}))
                                  throw new Error(e.detail || `HTTP ${r.status}`)
                                }
                                await refetchBeatmaps()
                              } catch (e) {
                                setBatchError((e as Error).message)
                              }
                            }}
                            className="shrink-0 px-1 py-0.5 bg-red-900/30 hover:bg-red-800/50 text-red-300 rounded text-[10px]"
                            title={isActive ? 'Delete the active beatmap' : 'Delete this beatmap'}
                            aria-label="Delete beatmap"
                          >
                            ×
                          </button>
                        </div>
                      )
                    })}
                </div>
              </div>
            )
          })}
        </div>

        {/* Batch generate row */}
        <div className="mt-3 flex flex-col gap-2">
          {batchTotal !== null && (() => {
            const total = batchTotal
            const queued = pendingStems.length
            const activeStem = Object.entries(beatmaps).find(([, b]) => b?.state === 'generating')?.[0] || null
            const done = total - queued - (activeStem ? 1 : 0)
            const pct = total > 0 ? Math.round((done / total) * 100) : 0
            return (
              <div className="bg-gray-900/60 border border-gray-800 rounded-md p-2 space-y-1.5">
                <div className="flex items-center justify-between gap-2 text-xs text-gray-400">
                  <span>
                    Batch: <span className="text-gray-200 font-medium">{done} of {total}</span> stems done
                    {activeStem && (
                      <>
                        {' '}· running{' '}
                        <span className={STEM_COLORS[activeStem] || 'text-gray-200'}>
                          {STEM_LABELS[activeStem] || activeStem}
                        </span>
                      </>
                    )}
                  </span>
                  <span className="text-gray-500 text-[10px] tabular-nums">{pct}%</span>
                </div>
                <div className="w-full bg-gray-800 rounded-full h-1 overflow-hidden">
                  <div className="bg-jam-500 h-full transition-all duration-500" style={{ width: `${Math.max(pct, 2)}%` }} />
                </div>
                {queued > 0 && (
                  <div className="text-[10px] text-gray-500 truncate" title={`queued stems: ${pendingStems.join(', ')}`}>
                    next: {pendingStems.map((s) => STEM_LABELS[s] || s).join(' · ')}
                  </div>
                )}
              </div>
            )
          })()}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-gray-500">
              {batchTotal !== null
                ? null
                : selectedStems.size > 0
                  ? `${selectedStems.size} stem${selectedStems.size === 1 ? '' : 's'} selected`
                  : 'Tick stems above to queue multiple beatmap generations.'}
            </div>
            <div className="flex items-center gap-2">
              {batchError && <span className="text-xs text-red-400">{batchError}</span>}
              <button
                onClick={generateSelected}
                disabled={selectedStems.size === 0 || batchTotal !== null || !!lock.owner}
                title={
                  batchTotal !== null
                    ? 'Multi-stem batch already running'
                    : lock.owner
                      ? 'Another task is running'
                      : undefined
                }
                className="px-3 py-1.5 bg-jam-600 hover:bg-jam-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-md text-xs font-medium transition-colors"
              >
                {batchTotal !== null
                  ? 'Batch in progress…'
                  : `Generate beatmap for ${selectedStems.size || 'selected'} stem${selectedStems.size === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* song.ini metadata editor — same fields as the Create page */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
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
              onClick={saveSongIni}
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
                onClick={fetchCoverByTags}
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

      <div className="flex flex-wrap gap-3 items-center">
        <a
          href={`/api/stems/${jobId}/download/zip`}
          className="px-5 py-2.5 bg-jam-600 hover:bg-jam-500 text-white rounded-lg font-medium transition-colors"
        >
          Download All Stems (ZIP)
        </a>

        {isGameReady && publishing === 'idle' && (
          <button
            onClick={publishToGame}
            className="px-5 py-2.5 bg-green-700 hover:bg-green-600 text-white rounded-lg font-medium transition-colors"
          >
            Publish to Game
          </button>
        )}

        {publishing === 'publishing' && (
          <div className="flex items-center gap-2 px-4 py-2.5">
            <div className="animate-spin h-4 w-4 border-2 border-green-400 border-t-transparent rounded-full" />
            <span className="text-sm text-gray-400">Publishing to GitHub...</span>
          </div>
        )}

        {publishing === 'done' && publishResult && (
          <div className="flex items-center gap-3">
            <span className="text-sm text-green-400">Published!</span>
            <a
              href={publishResult.commitUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-jam-400 hover:text-jam-300 underline transition-colors"
            >
              View commit
            </a>
            <span className="text-xs text-gray-600 font-mono">{publishResult.folder}</span>
          </div>
        )}

        {publishing === 'error' && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-red-400">{publishError}</span>
            <button
              onClick={() => setPublishing('idle')}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {(metadata.track_id as string) && (
          <a
            href="/tracks"
            className="px-4 py-2.5 text-sm text-gray-400 hover:text-jam-300 transition-colors"
          >
            Saved to Track Library &rarr;
          </a>
        )}
      </div>

      {statsBeatmap && trackId && (
        <BeatmapStatsModal
          trackId={trackId}
          beatmap={statsBeatmap}
          onClose={() => setStatsBeatmap(null)}
          onRenamed={() => refetchBeatmaps()}
          onCloned={(cloned) => {
            setStatsBeatmap(null)
            navigate(`/edit/${trackId}/${cloned.id}`)
          }}
        />
      )}

      {modalStem && trackId && (
        <StemGenerationModal
          stem={modalStem}
          generation={generation}
          activePresets={activePresets}
          onGenerationChange={setGeneration}
          onActivePresetsChange={setActivePresets}
          onClose={() => setModalStem(null)}
          onBatchGenerate={(queue) => {
            // Capture modalStem inside the callback — TS doesn't narrow
            // through closure boundaries even though the surrounding
            // `modalStem && trackId &&` already proved it non-null.
            const stem = modalStem
            if (!stem) return
            // startBatch acquires the per-stem lock and fires the first
            // generation; the StemBeatmapTracker's onDone callback chains
            // through the rest of the queue.
            startBatch(stem, queue)
          }}
        />
      )}
    </div>
  )
}
