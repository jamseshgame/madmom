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
} from './pipeline/generationTypes'
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
  const [beatmaps, setBeatmaps] = useState<Record<string, { jobId: string; state: BeatmapState }>>({})
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
  // and the next click of the green main button picks them up.
  //
  // useState lazy-init runs the loader twice on mount (once per useState),
  // but JSON.parse on a tiny stored object is negligible.
  const [generation, setGeneration] = useState<GenerationState>(() => loadStoredGeneration().generation)
  const [activePreset, setActivePreset] = useState<string>(() => loadStoredGeneration().activePreset)
  const [modalStem, setModalStem] = useState<string | null>(null)

  // Persist on every change. Note: this also fires on the initial mount,
  // writing the just-loaded values back to localStorage. Harmless but
  // unavoidable with this pattern — the write is synchronous and tiny.
  useEffect(() => {
    saveStoredGeneration(generation, activePreset)
  }, [generation, activePreset])

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

  const generateBeatmap = async (stem: string) => {
    if (!lock.acquire(`beatmap:${stem}`)) return
    const label = STEM_LABELS[stem] || stem
    setBeatmaps((prev) => ({ ...prev, [stem]: { jobId: '', state: 'generating' } }))

    // Drums uses the legacy single-shot endpoint — V2 doesn't support drums
    // yet (separate follow-up project). Everything else gets the V2 staged
    // pipeline with whatever preset/engine settings the user has set on
    // this page (defaults to v1).
    const useV2 = stem !== 'drums' && !!trackId
    try {
      let res: Response
      if (useV2) {
        const formData = new FormData()
        formData.append('stem', stem)
        for (const [key, val] of Object.entries(songIni)) {
          formData.append(key, String(val ?? ''))
        }
        for (const stage of Object.keys(GENERATION_STAGE_LABELS) as GenerationStage[]) {
          const sel = generation[stage]
          const fieldPrefix =
            stage === 'lanes_expert' ? 'lanes' :
            stage === 'lanes_filtered' ? 'playability' :
            stage
          formData.append(`${fieldPrefix}_engine`, sel.engine)
          formData.append(`${fieldPrefix}_params`, JSON.stringify(sel.params))
        }
        if (activePreset) formData.append('preset', activePreset)
        res = await fetch(`/api/tracks/${trackId}/generate-beatmap-v2`, { method: 'POST', body: formData })
      } else {
        const formData = new FormData()
        formData.append('stem_job_id', jobId)
        formData.append('stem', stem)
        formData.append('title', `${trackName} (${label})`)
        res = await fetch('/api/beatmap/from-stem', { method: 'POST', body: formData })
      }
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
  }

  const generateSelected = async () => {
    setBatchError('')
    const targets = Array.from(selectedStems).filter(
      (stem) => stem !== 'song' && stem !== 'vocals' && !NON_AUDIO_KEYS.has(stem) && !beatmaps[stem],
    )
    if (targets.length === 0) return
    for (const stem of targets) {
      await generateBeatmap(stem)
    }
    setSelectedStems(new Set())
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
                      aria-label={`Select ${label} for batch beatmap`}
                      title="Select for batch beatmap generation"
                    />
                  ) : (
                    <div className="h-4 w-4 shrink-0" />
                  )}
                  <span className={`text-sm font-semibold ${color}`}>{label}</span>
                </div>

                {/* Waveform column */}
                <div className="flex-1 min-w-0 flex items-center">
                  <StemPlayer src={`/api/stems/${jobId}/download/${stem}`} peaks={stemPeaks?.[stem] ?? null} />
                </div>

                {/* Actions column */}
                <div className="md:w-80 md:shrink-0 flex flex-col gap-1.5">
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
                            {stem !== 'drums' && trackId && (
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

                  {stem !== 'vocals' && stem !== 'drums' && stem !== 'song' && !bm && activePreset && activePreset !== 'v1' && (
                    <span
                      className="self-center text-[10px] text-gray-500 italic mt-0.5"
                      title={`Generation preset: ${activePreset}`}
                    >
                      preset: {activePreset}
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
                      <span className="text-xs text-gray-500">Starting...</span>
                    </div>
                  )}

                  {bm?.state === 'generating' && bm.jobId && stem !== 'vocals' && (
                    <StemBeatmapTracker
                      beatmapJobId={bm.jobId}
                      onCancelled={() => {
                        setBeatmaps((prev) => {
                          const next = { ...prev }
                          delete next[stem]
                          return next
                        })
                        lock.release()
                      }}
                      onDone={() => {
                        setBeatmaps((prev) => {
                          const next = { ...prev }
                          delete next[stem]
                          return next
                        })
                        lock.release()
                        refetchBeatmaps()
                      }}
                      onError={() => { lock.release() }}
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
              disabled={selectedStems.size === 0 || !!lock.owner}
              title={lock.owner ? 'Another task is running' : undefined}
              className="px-3 py-1.5 bg-jam-600 hover:bg-jam-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-md text-xs font-medium transition-colors"
            >
              Generate beatmap for {selectedStems.size || 'selected'} stem{selectedStems.size === 1 ? '' : 's'}
            </button>
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
          trackId={trackId}
          stem={modalStem}
          songIni={songIni}
          generation={generation}
          activePreset={activePreset}
          onGenerationChange={setGeneration}
          onActivePresetChange={setActivePreset}
          onClose={() => setModalStem(null)}
          onGenerated={(beatmapJobId) => {
            // Capture modalStem inside the callback — TS doesn't narrow
            // through closure boundaries even though the surrounding
            // `modalStem && trackId &&` already proved it non-null.
            const stem = modalStem
            if (!stem) return
            // Acquire the same per-stem lock the main button uses so the user
            // can't kick off a parallel generation on this row while the
            // modal-started one is in flight. The existing StemBeatmapTracker
            // SSE callbacks (done/error/cancelled) release the lock.
            lock.acquire(`beatmap:${stem}`)
            setBeatmaps((prev) => ({
              ...prev,
              [stem]: { jobId: beatmapJobId, state: 'generating' },
            }))
          }}
        />
      )}
    </div>
  )
}
