import { useCallback, useEffect, useState } from 'react'

export type LyricsScope = { jobId: string } | { trackId: string }

type Lyrics = {
  source: 'lrclib' | 'whisper' | null
  language?: string
  model?: string
  fetched_at?: string
  words: Array<{ time_s: number; text: string; phrase_start?: boolean; phrase_end?: boolean }>
}

type LyricsVersion = {
  file: string
  source: 'lrclib' | 'whisper'
  fetched_at: string
  word_count: number
  language?: string
  model?: string
  active: boolean
}

type Props = {
  scope: LyricsScope
  hasVocals: boolean
  meta: { artist: string; title: string; album?: string; duration_s?: number }
  onLyricsChange?: (lyrics: Lyrics | null) => void
}

type WhisperState =
  | { kind: 'idle' }
  | { kind: 'running'; jobId: string; progress: number; message: string }
type LrclibState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'miss' }
type ErrorState = { kind: 'none' } | { kind: 'error'; message: string }

function scopeQuery(scope: LyricsScope): string {
  return 'jobId' in scope ? `job_id=${scope.jobId}` : `track_id=${scope.trackId}`
}

const fmtFetchedAt = (iso: string): string => {
  // "2026-05-05T17:49:21Z" -> "5 May, 18:49"
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return iso
  }
}

const SOURCE_LABEL: Record<LyricsVersion['source'], string> = {
  lrclib: 'LRClib',
  whisper: 'Whisper',
}

const SOURCE_BADGE: Record<LyricsVersion['source'], string> = {
  lrclib: 'bg-purple-700/40 text-purple-200 border-purple-700/60',
  whisper: 'bg-sky-700/40 text-sky-200 border-sky-700/60',
}

export default function LyricsButtons({ scope, hasVocals, meta, onLyricsChange }: Props) {
  const [lrclib, setLrclib] = useState<LrclibState>({ kind: 'idle' })
  const [whisper, setWhisper] = useState<WhisperState>({ kind: 'idle' })
  const [error, setError] = useState<ErrorState>({ kind: 'none' })
  const [versions, setVersions] = useState<LyricsVersion[]>([])
  const [previewVersion, setPreviewVersion] = useState<{ meta: LyricsVersion; lyrics: Lyrics } | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)

  const refreshVersions = useCallback(async () => {
    try {
      const r = await fetch(`/api/lyrics/versions?${scopeQuery(scope)}`)
      if (!r.ok) return
      const data: LyricsVersion[] = await r.json()
      setVersions(data)
    } catch {
      /* swallow — list is non-critical */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(scope)])

  // Hydrate active lyrics + versions on mount.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/lyrics?${scopeQuery(scope)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return
        if (data && data.words) onLyricsChange?.(data)
      })
      .catch(() => {})
    refreshVersions()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(scope)])

  const fetchLrclib = async () => {
    setError({ kind: 'none' })
    setLrclib({ kind: 'loading' })
    try {
      const res = await fetch(`/api/lyrics/lrclib?${scopeQuery(scope)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.detail || `HTTP ${res.status}`)
      }
      const data: Lyrics = await res.json()
      if (!data.source) {
        setLrclib({ kind: 'miss' })
        return
      }
      onLyricsChange?.(data)
      setLrclib({ kind: 'idle' })
      refreshVersions()
    } catch (e) {
      setLrclib({ kind: 'idle' })
      setError({ kind: 'error', message: (e as Error).message })
    }
  }

  const startWhisper = async () => {
    setError({ kind: 'none' })
    try {
      const res = await fetch(`/api/lyrics/whisper?${scopeQuery(scope)}`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }
      const { job_id } = await res.json()
      setWhisper({ kind: 'running', jobId: job_id, progress: 0, message: 'Starting…' })

      const es = new EventSource(`/api/jobs/${job_id}/events`)
      es.onmessage = async (ev) => {
        const d = JSON.parse(ev.data)
        if (typeof d.progress === 'number' && d.progress >= 0) {
          setWhisper((p) => (
            p.kind === 'running' ? { ...p, progress: d.progress, message: d.message ?? p.message } : p
          ))
        }
        if (d.step === 'done') {
          es.close()
          setWhisper({ kind: 'idle' })
          // Reload active lyrics + versions
          const got = await fetch(`/api/lyrics?${scopeQuery(scope)}`)
          if (got.ok) {
            const lyrics: Lyrics = await got.json()
            onLyricsChange?.(lyrics)
          }
          refreshVersions()
        } else if (d.step === 'error' || d.step === 'cancelled') {
          es.close()
          setWhisper({ kind: 'idle' })
          setError({ kind: 'error', message: d.message || 'Whisper failed' })
        }
      }
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          setError({ kind: 'error', message: 'SSE connection lost' })
          setWhisper({ kind: 'idle' })
        }
      }
    } catch (e) {
      setWhisper({ kind: 'idle' })
      setError({ kind: 'error', message: (e as Error).message })
    }
  }

  const openPreview = async (v: LyricsVersion) => {
    setLoadingPreview(true)
    try {
      const r = await fetch(`/api/lyrics/versions/${encodeURIComponent(v.file)}?${scopeQuery(scope)}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data: Lyrics = await r.json()
      setPreviewVersion({ meta: v, lyrics: data })
    } catch (e) {
      setError({ kind: 'error', message: (e as Error).message })
    } finally {
      setLoadingPreview(false)
    }
  }

  const activate = async (v: LyricsVersion) => {
    try {
      const r = await fetch(`/api/lyrics/versions/${encodeURIComponent(v.file)}/activate?${scopeQuery(scope)}`, {
        method: 'POST',
      })
      if (!r.ok) {
        const e = await r.json().catch(() => ({}))
        throw new Error(e.detail || `HTTP ${r.status}`)
      }
      const got = await fetch(`/api/lyrics?${scopeQuery(scope)}`)
      if (got.ok) {
        const lyrics: Lyrics = await got.json()
        onLyricsChange?.(lyrics)
      }
      refreshVersions()
    } catch (e) {
      setError({ kind: 'error', message: (e as Error).message })
    }
  }

  const lrclibBusy = lrclib.kind === 'loading' || whisper.kind === 'running'
  const whisperBusy = whisper.kind === 'running' || lrclib.kind === 'loading'

  return (
    <div className="space-y-1.5 w-full">
      <button
        onClick={fetchLrclib}
        disabled={lrclibBusy}
        className="px-3 py-1.5 bg-purple-700/60 hover:bg-purple-600/70 disabled:opacity-50 text-purple-100 rounded text-xs font-medium transition-colors w-full"
      >
        {lrclib.kind === 'loading'
          ? 'Searching LRClib…'
          : lrclib.kind === 'miss'
            ? 'No LRClib match — try again'
            : 'Get lyrics from LRClib'}
      </button>
      {hasVocals && (
        <button
          onClick={startWhisper}
          disabled={whisperBusy}
          className="px-3 py-1.5 bg-sky-700/60 hover:bg-sky-600/70 disabled:opacity-50 text-sky-100 rounded text-xs font-medium transition-colors w-full"
          title="Local Whisper transcription. ~2 min on CPU; first run downloads ~1.5 GB."
        >
          {whisper.kind === 'running'
            ? `Transcribing… ${whisper.progress}%`
            : 'Transcribe with Whisper'}
        </button>
      )}

      {error.kind === 'error' && (
        <div className="text-[10px] text-red-300 truncate" title={error.message}>
          {error.message}
        </div>
      )}

      {versions.length > 0 && (
        <div className="pt-1 space-y-1">
          {versions.map((v) => (
            <div
              key={v.file}
              className={`flex items-center gap-1 text-[10px] rounded border px-1.5 py-1 ${
                v.active
                  ? 'border-jam-600/60 bg-jam-700/20'
                  : 'border-gray-800 bg-gray-900/40'
              }`}
              title={`${v.word_count} words${v.language ? ` · ${v.language}` : ''}${v.model ? ` · ${v.model}` : ''}`}
            >
              <span className={`shrink-0 inline-block px-1 py-0.5 rounded border text-[9px] font-semibold uppercase ${SOURCE_BADGE[v.source]}`}>
                {SOURCE_LABEL[v.source]}
              </span>
              <span className="text-gray-400 truncate flex-1">
                {fmtFetchedAt(v.fetched_at)}
              </span>
              {v.active && (
                <span className="shrink-0 text-jam-300 font-semibold uppercase tracking-wider">
                  active
                </span>
              )}
              <button
                onClick={() => openPreview(v)}
                disabled={loadingPreview}
                className="shrink-0 px-1 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-[10px]"
              >
                preview
              </button>
              {!v.active && (
                <button
                  onClick={() => activate(v)}
                  className="shrink-0 px-1 py-0.5 bg-jam-700/60 hover:bg-jam-600/80 text-jam-100 rounded text-[10px]"
                  title="Make this the active lyrics.json used by Generate Beatmap and Publish-to-Game"
                >
                  use
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {previewVersion && (
        <PreviewModal
          version={previewVersion.meta}
          lyrics={previewVersion.lyrics}
          onClose={() => setPreviewVersion(null)}
        />
      )}
    </div>
  )
}

function PreviewModal({
  version,
  lyrics,
  onClose,
}: {
  version: LyricsVersion
  lyrics: Lyrics
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg p-5 space-y-3 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-lg font-semibold text-gray-100">Lyrics</h3>
          <span className="text-xs text-gray-500">
            <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-semibold uppercase mr-2 ${SOURCE_BADGE[version.source]}`}>
              {SOURCE_LABEL[version.source]}
            </span>
            {fmtFetchedAt(version.fetched_at)} · {lyrics.words.length} words
            {lyrics.language ? ` · ${lyrics.language}` : ''}
            {lyrics.model ? ` · ${lyrics.model}` : ''}
            {version.active ? ' · active' : ''}
          </span>
        </div>
        <div className="flex-1 overflow-auto font-mono text-xs space-y-0.5 bg-black/30 rounded p-3">
          {lyrics.words.map((w, i) => (
            <div key={i} className="flex gap-2">
              <span className="text-gray-600 w-12 shrink-0 text-right">
                {Math.floor(w.time_s / 60)}:{(w.time_s % 60).toFixed(2).padStart(5, '0')}
              </span>
              <span className={w.phrase_start ? 'text-jam-300' : 'text-gray-200'}>
                {w.text}
                {w.phrase_end ? ' ⏎' : ''}
              </span>
            </div>
          ))}
        </div>
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-md text-sm"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
