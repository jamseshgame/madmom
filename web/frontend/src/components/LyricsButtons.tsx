import { useEffect, useState } from 'react'

export type LyricsScope = { jobId: string } | { trackId: string }

type Lyrics = {
  source: 'lrclib' | 'whisper' | null
  language?: string
  model?: string
  fetched_at?: string
  words: Array<{ time_s: number; text: string; phrase_start?: boolean; phrase_end?: boolean }>
}

type Props = {
  scope: LyricsScope
  hasVocals: boolean
  // Used by the LRClib search; pass the song.ini fields the parent already has.
  meta: { artist: string; title: string; album?: string; duration_s?: number }
  // Optional: parent can listen for lyrics changes to update its own state.
  onLyricsChange?: (lyrics: Lyrics | null) => void
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'lrclib-loading' }
  | { kind: 'lrclib-miss' }
  | { kind: 'whisper-running'; jobId: string; progress: number; message: string }
  | { kind: 'have-lyrics'; lyrics: Lyrics }
  | { kind: 'error'; message: string }

function scopeQuery(scope: LyricsScope): string {
  return 'jobId' in scope ? `job_id=${scope.jobId}` : `track_id=${scope.trackId}`
}

export default function LyricsButtons({ scope, hasVocals, meta, onLyricsChange }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [previewOpen, setPreviewOpen] = useState(false)

  // Hydrate from the server on mount.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/lyrics?${scopeQuery(scope)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return
        if (data && data.words) {
          setPhase({ kind: 'have-lyrics', lyrics: data })
          onLyricsChange?.(data)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(scope)])

  const fetchLrclib = async () => {
    setPhase({ kind: 'lrclib-loading' })
    try {
      const res = await fetch(`/api/lyrics/lrclib?${scopeQuery(scope)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: Lyrics = await res.json()
      if (!data.source) {
        setPhase({ kind: 'lrclib-miss' })
        return
      }
      setPhase({ kind: 'have-lyrics', lyrics: data })
      onLyricsChange?.(data)
    } catch (e) {
      setPhase({ kind: 'error', message: (e as Error).message })
    }
  }

  const startWhisper = async () => {
    try {
      const res = await fetch(`/api/lyrics/whisper?${scopeQuery(scope)}`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }
      const { job_id } = await res.json()
      setPhase({ kind: 'whisper-running', jobId: job_id, progress: 0, message: 'Starting…' })

      const es = new EventSource(`/api/jobs/${job_id}/events`)
      es.onmessage = async (ev) => {
        const d = JSON.parse(ev.data)
        if (typeof d.progress === 'number' && d.progress >= 0) {
          setPhase((p) => (p.kind === 'whisper-running' ? { ...p, progress: d.progress, message: d.message ?? p.message } : p))
        }
        if (d.step === 'done') {
          es.close()
          // Reload the saved lyrics now that they're persisted server-side
          const got = await fetch(`/api/lyrics?${scopeQuery(scope)}`)
          if (got.ok) {
            const lyrics: Lyrics = await got.json()
            setPhase({ kind: 'have-lyrics', lyrics })
            onLyricsChange?.(lyrics)
          } else {
            setPhase({ kind: 'error', message: 'Transcription finished but lyrics could not be loaded' })
          }
        } else if (d.step === 'error' || d.step === 'cancelled') {
          es.close()
          setPhase({ kind: 'error', message: d.message || 'Whisper failed' })
        }
      }
      es.onerror = () => {
        es.close()
        setPhase({ kind: 'error', message: 'SSE connection lost' })
      }
    } catch (e) {
      setPhase({ kind: 'error', message: (e as Error).message })
    }
  }

  const lrclibLabel =
    phase.kind === 'lrclib-loading'
      ? 'Searching…'
      : phase.kind === 'lrclib-miss'
        ? 'No match — try again'
        : phase.kind === 'have-lyrics'
          ? 'Preview Lyrics'
          : 'Get Lyrics'

  const lrclibDisabled = phase.kind === 'lrclib-loading' || phase.kind === 'whisper-running'
  const lrclibAction = phase.kind === 'have-lyrics' ? () => setPreviewOpen(true) : fetchLrclib

  return (
    <>
      <button
        onClick={lrclibAction}
        disabled={lrclibDisabled}
        className="px-3 py-1.5 bg-purple-700/60 hover:bg-purple-600/70 disabled:opacity-50 text-purple-100 rounded text-xs font-medium transition-colors w-full"
      >
        {lrclibLabel}
      </button>
      {hasVocals && (
        <button
          onClick={startWhisper}
          disabled={phase.kind === 'whisper-running' || phase.kind === 'lrclib-loading'}
          className="px-3 py-1.5 bg-gray-700/70 hover:bg-gray-600/80 disabled:opacity-50 text-gray-200 rounded text-xs font-medium transition-colors w-full"
          title="Local Whisper transcription. ~2 min on CPU; first run downloads ~1.5 GB."
        >
          {phase.kind === 'whisper-running'
            ? `Transcribing… ${phase.progress}%`
            : phase.kind === 'have-lyrics' && phase.lyrics.source === 'whisper'
              ? 'Re-transcribe'
              : 'Transcribe Vocals'}
        </button>
      )}
      {previewOpen && phase.kind === 'have-lyrics' && (
        <PreviewModal lyrics={phase.lyrics} onClose={() => setPreviewOpen(false)} />
      )}
    </>
  )
}

function PreviewModal({ lyrics, onClose }: { lyrics: Lyrics; onClose: () => void }) {
  const sourceLabel =
    lyrics.source === 'lrclib'
      ? 'LRClib'
      : lyrics.source === 'whisper'
        ? `Whisper · ${lyrics.model || 'medium'}`
        : 'unknown'
  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg p-5 space-y-3 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-100">Lyrics</h3>
          <span className="text-xs text-gray-500">
            {sourceLabel} · {lyrics.words.length} words
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
