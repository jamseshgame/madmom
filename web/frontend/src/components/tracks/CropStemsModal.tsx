import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { clampRange, formatTime, parseTime, type CropRange } from '../../audio/cropRange'
import { STEM_COLORS, STEM_LABELS } from '../stemDisplay'

const NON_AUDIO_KEYS = new Set(['song_ini', 'album_png'])
const BUCKET_MS = 20

interface Props {
  trackId: string
  trackName: string
  stems: Record<string, string>
  beatmapCount: number
  /** Bumped by the parent after a crop so a re-opened modal refetches the
      waveform and audio rather than drawing the browser's cached copy. */
  nonce?: number
  onClose: () => void
  onCropped: (durationMs: number) => void
}

type Handle = 'start' | 'end'

/**
 * Trims the head and tail off every stem of a track at once. The waveform of
 * one stem is only a reference for picking the range — the crop always applies
 * to all of them, which is the point: hand-trimming stems one at a time is how
 * they drift out of alignment.
 */
export default function CropStemsModal({
  trackId, trackName, stems, beatmapCount, nonce = 0, onClose, onCropped,
}: Props) {
  const audioStems = useMemo(
    () => Object.keys(stems).filter((s) => !NON_AUDIO_KEYS.has(s)),
    [stems],
  )
  const [stem, setStem] = useState(
    () => (audioStems.includes('song') ? 'song' : audioStems[0]) || '',
  )
  const [peaks, setPeaks] = useState<Float32Array | null>(null)
  const [loadError, setLoadError] = useState('')
  const [duration, setDuration] = useState(0)
  const [range, setRange] = useState<CropRange>({ start: 0, end: 0 })
  // Field text is held separately so a half-typed "1:2" doesn't snap under the
  // caret before the value is complete.
  const [draft, setDraft] = useState<{ start: string; end: string }>({ start: '', end: '' })
  const [dragging, setDragging] = useState<Handle | null>(null)
  const [playhead, setPlayhead] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const barRef = useRef<HTMLDivElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const setRangeAndDraft = useCallback((next: CropRange, total: number) => {
    const clamped = clampRange(next, total)
    setRange(clamped)
    setDraft({ start: formatTime(clamped.start), end: formatTime(clamped.end) })
  }, [])

  // Pull the precomputed peaks for the reference stem. Their length × bucket
  // is the stem's duration, so no separate metadata request is needed.
  useEffect(() => {
    if (!stem) return
    const ctrl = new AbortController()
    setPeaks(null)
    setLoadError('')
    fetch(`/api/tracks/${trackId}/stems/${stem}/peaks?bucket_ms=${BUCKET_MS}&v=${nonce}`, { signal: ctrl.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Waveform unavailable (${r.status})`)
        return r.arrayBuffer()
      })
      .then((buf) => {
        const data = new Float32Array(buf)
        const total = (data.length * BUCKET_MS) / 1000
        setPeaks(data)
        setDuration(total)
        setRangeAndDraft({ start: 0, end: total }, total)
      })
      .catch((e) => {
        if ((e as Error).name !== 'AbortError') setLoadError((e as Error).message)
      })
    return () => ctrl.abort()
  }, [trackId, stem, nonce, setRangeAndDraft])

  // Handle dragging. Bound on window so the pointer can leave the bar.
  useEffect(() => {
    if (!dragging) return
    const secAt = (clientX: number) => {
      const rect = barRef.current?.getBoundingClientRect()
      if (!rect || rect.width === 0) return 0
      return ((clientX - rect.left) / rect.width) * duration
    }
    const move = (e: PointerEvent) => {
      const sec = secAt(e.clientX)
      setRangeAndDraft(
        dragging === 'start' ? { start: sec, end: range.end } : { start: range.start, end: sec },
        duration,
      )
    }
    const up = () => setDragging(null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [dragging, duration, range.start, range.end, setRangeAndDraft])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const commitField = (which: Handle, text: string) => {
    const sec = parseTime(text)
    if (sec === null) {
      // Unparseable — put the live value back rather than silently keeping it.
      setDraft((d) => ({ ...d, [which]: formatTime(range[which]) }))
      return
    }
    setRangeAndDraft(which === 'start' ? { ...range, start: sec } : { ...range, end: sec }, duration)
  }

  const togglePreview = () => {
    const audio = audioRef.current
    if (!audio) return
    if (!audio.paused) { audio.pause(); return }
    audio.currentTime = range.start
    audio.play().catch(() => setError('Preview playback failed'))
  }

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/tracks/${trackId}/crop-stems`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_sec: range.start, end_sec: range.end }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.detail || `Crop failed (${res.status})`)
      onCropped(body.duration_ms || 0)
    } catch (e) {
      setError((e as Error).message)
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  const pct = (sec: number) => (duration > 0 ? (sec / duration) * 100 : 0)
  const headTrim = range.start
  const tailTrim = Math.max(0, duration - range.end)
  const nothingToDo = headTrim < 0.001 && tailTrim < 0.001

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="w-full max-w-3xl bg-gray-900 border border-gray-700 rounded-xl p-5 space-y-4"
        role="dialog"
        aria-modal="true"
        aria-label={`Crop stems for ${trackName}`}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-gray-100 font-semibold">Crop stems</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Trims the same head and tail off every stem of {trackName}, plus the stored master.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 text-lg leading-none px-1"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500" htmlFor="crop-stem">Reference waveform</label>
          <select
            id="crop-stem"
            value={stem}
            onChange={(e) => setStem(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
          >
            {audioStems.map((s) => (
              <option key={s} value={s}>{STEM_LABELS[s] || s}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={togglePreview}
            disabled={!duration}
            className="ml-auto px-2.5 py-1 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 border border-gray-700 rounded text-xs text-gray-200"
          >
            {playing ? '❚❚ Stop' : '▶ Preview selection'}
          </button>
        </div>

        {/* Waveform + handles */}
        <div
          ref={barRef}
          className={`relative h-28 bg-gray-950 border border-gray-800 rounded overflow-hidden ${
            dragging ? 'cursor-ew-resize' : ''
          }`}
        >
          {!peaks && !loadError && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-600">
              Loading waveform…
            </div>
          )}
          {loadError && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-red-400">
              {loadError}
            </div>
          )}
          {peaks && (
            <svg
              className={`absolute inset-0 w-full h-full ${STEM_COLORS[stem] || 'text-cyan-400'}`}
              viewBox="0 0 1000 112"
              preserveAspectRatio="none"
            >
              {Array.from({ length: 500 }, (_, i) => {
                const idx = Math.floor((i / 500) * peaks.length)
                const h = Math.max(1, Math.min(1, peaks[idx] || 0) * 104)
                return (
                  <line
                    key={i}
                    x1={i * 2} y1={56 - h / 2} x2={i * 2} y2={56 + h / 2}
                    stroke="currentColor" strokeWidth={1.5}
                  />
                )
              })}
            </svg>
          )}

          {/* Dimmed regions that will be discarded */}
          <div className="absolute inset-y-0 left-0 bg-black/65 pointer-events-none"
               style={{ width: `${pct(range.start)}%` }} />
          <div className="absolute inset-y-0 right-0 bg-black/65 pointer-events-none"
               style={{ width: `${100 - pct(range.end)}%` }} />

          {playing && (
            <div className="absolute inset-y-0 w-px bg-yellow-400 pointer-events-none"
                 style={{ left: `${pct(playhead)}%` }} />
          )}

          {(['start', 'end'] as Handle[]).map((h) => (
            <div
              key={h}
              role="slider"
              tabIndex={0}
              aria-label={h === 'start' ? 'Crop start' : 'Crop end'}
              aria-valuemin={0}
              aria-valuemax={duration}
              aria-valuenow={range[h]}
              onPointerDown={(e) => { e.preventDefault(); setDragging(h) }}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 1 : 0.05
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
                e.preventDefault()
                const delta = e.key === 'ArrowLeft' ? -step : step
                setRangeAndDraft({ ...range, [h]: range[h] + delta }, duration)
              }}
              className="absolute inset-y-0 w-3 -ml-1.5 cursor-ew-resize group"
              style={{ left: `${pct(range[h])}%` }}
            >
              <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-jam-400 group-hover:bg-jam-300" />
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-8 rounded-sm bg-jam-500 group-hover:bg-jam-400" />
            </div>
          ))}
        </div>

        {/* Numeric fields */}
        <div className="flex items-end gap-4 flex-wrap">
          {(['start', 'end'] as Handle[]).map((h) => (
            <div key={h} className="flex flex-col gap-1">
              <label className="text-[10px] uppercase tracking-wide text-gray-500" htmlFor={`crop-${h}`}>
                {h}
              </label>
              <input
                id={`crop-${h}`}
                value={draft[h]}
                onChange={(e) => setDraft((d) => ({ ...d, [h]: e.target.value }))}
                onBlur={(e) => commitField(h, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') commitField(h, (e.target as HTMLInputElement).value) }}
                className="w-28 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm font-mono text-gray-200"
              />
            </div>
          ))}
          <p className="text-xs text-gray-400 pb-1.5">
            keeps <span className="font-mono text-gray-200">{formatTime(range.end - range.start)}</span>
            {' · '}trims <span className="font-mono text-gray-200">{headTrim.toFixed(2)}s</span> head
            {' / '}<span className="font-mono text-gray-200">{tailTrim.toFixed(2)}s</span> tail
          </p>
        </div>

        {beatmapCount > 0 && (
          <p className="text-xs text-amber-300 bg-amber-950/40 border border-amber-900/60 rounded px-3 py-2">
            This track has {beatmapCount} beatmap{beatmapCount === 1 ? '' : 's'}. Each keeps its own
            copy of the audio, so their charts stay on the old timing — regenerate them after cropping.
          </p>
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-md text-xs text-gray-300"
          >
            Cancel
          </button>
          {confirming ? (
            <button
              onClick={submit}
              disabled={busy}
              className="px-3 py-1.5 bg-red-700 hover:bg-red-600 disabled:opacity-50 rounded-md text-xs font-medium text-white"
            >
              {busy ? 'Cropping…' : 'Yes — overwrite all stems'}
            </button>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              disabled={!duration || nothingToDo || busy}
              title={nothingToDo ? 'Move a handle first — nothing would be trimmed' : undefined}
              className="px-3 py-1.5 bg-jam-600 hover:bg-jam-500 disabled:opacity-40 rounded-md text-xs font-medium text-white"
            >
              Crop all stems
            </button>
          )}
        </div>
        <p className="text-[10px] text-gray-600 text-right -mt-2">
          Overwrites the stems in place — this cannot be undone.
        </p>

        <audio
          ref={audioRef}
          src={`/api/tracks/${trackId}/stems/${stem}${nonce ? `?v=${nonce}` : ''}`}
          preload="none"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => {
            const t = e.currentTarget.currentTime
            setPlayhead(t)
            // Preview only the kept region.
            if (t >= range.end) e.currentTarget.pause()
          }}
        />
      </div>
    </div>
  )
}
