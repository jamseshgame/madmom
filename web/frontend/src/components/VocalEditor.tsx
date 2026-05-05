import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

type Voicing = 'sung' | 'spoken' | 'whispered'

type Syllable = {
  time_s: number
  duration_s: number
  text: string
  midi_pitch: number
  confidence: number
  voicing: Voicing
  pitch_curve_st?: number[]
  dynamics_db?: number[]
  phrase_start?: boolean
  phrase_end?: boolean
}

type VocalNotes = {
  version: number
  syllabified_from: string
  pitch_model: string
  syllabifier?: string
  frame_hop_s: number
  lyrics_etag?: string
  fetched_at?: string
  syllables: Syllable[]
}

// Scriabin-style pitch-class colour wheel: C=red around to B=magenta.
const PITCH_COLORS = [
  '#ff3b30', '#ff7a00', '#ffae00', '#ffd400',
  '#ffea00', '#a8d100', '#21c45d', '#08b3a3',
  '#1f7ce0', '#5b3ee2', '#9b30dc', '#e02bb6',
]
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const noteName = (midi: number) => `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`

const ROW_H = 20         // px per semitone row
const DEFAULT_PPS = 140  // pixels per second of audio
const MIN_PPS = 40
const MAX_PPS = 600

function colorFor(s: Syllable): { fill: string; outline: string } {
  const base = PITCH_COLORS[((s.midi_pitch % 12) + 12) % 12]
  if (s.voicing === 'whispered') return { fill: base + '55', outline: base + 'aa' }
  if (s.voicing === 'spoken') return { fill: base + '99', outline: base }
  return { fill: base, outline: base }
}

type LocalSyll = Syllable & { _uid: number }

let _nextUid = 1
const withUids = (sylls: Syllable[]): LocalSyll[] =>
  sylls.map((s) => ({ ...s, _uid: _nextUid++ }))
const stripUids = (sylls: LocalSyll[]): Syllable[] => sylls.map(({ _uid, ...s }) => s)

export default function VocalEditor() {
  const { trackId } = useParams<{ trackId: string }>()
  const navigate = useNavigate()

  const [meta, setMeta] = useState<Omit<VocalNotes, 'syllables'> | null>(null)
  const [sylls, setSylls] = useState<LocalSyll[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [audioSource, setAudioSource] = useState<'vocals' | 'song'>('vocals')
  const [pps, setPps] = useState(DEFAULT_PPS)

  const [selectedUid, setSelectedUid] = useState<number | null>(null)
  const [editingUid, setEditingUid] = useState<number | null>(null)
  const [editText, setEditText] = useState('')

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const layerRef = useRef<HTMLDivElement | null>(null)
  const editInputRef = useRef<HTMLInputElement | null>(null)

  // ---------- Load ----------
  useEffect(() => {
    if (!trackId) return
    setLoading(true)
    fetch(`/api/vocals?track_id=${trackId}`)
      .then((r) => {
        if (r.status === 404) return null
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((d: VocalNotes | null) => {
        if (!d) {
          setLoadError('No vocal_notes.json for this track yet. Generate one first from the Vocals stem card.')
          return
        }
        const { syllables, ...rest } = d
        setMeta(rest)
        setSylls(withUids(syllables || []))
      })
      .catch((e) => setLoadError((e as Error).message))
      .finally(() => setLoading(false))
  }, [trackId])

  // ---------- Pitch range ----------
  const { minMidi, maxMidi, totalRows } = useMemo(() => {
    let mn = 60, mx = 72
    if (sylls.length) {
      mn = Math.min(...sylls.map((s) => s.midi_pitch))
      mx = Math.max(...sylls.map((s) => s.midi_pitch))
    }
    mn -= 2; mx += 2
    if (mx - mn < 18) {
      const center = Math.round((mn + mx) / 2)
      mn = center - 9; mx = center + 9
    }
    return { minMidi: mn, maxMidi: mx, totalRows: mx - mn + 1 }
  }, [sylls])

  const yForMidi = (midi: number) => (maxMidi - midi) * ROW_H
  const midiForY = (y: number) => Math.max(minMidi, Math.min(maxMidi, maxMidi - Math.round(y / ROW_H)))

  // ---------- Animation: drive layer transform from audio.currentTime ----------
  useEffect(() => {
    let raf = 0
    let last = 0
    const tick = () => {
      const a = audioRef.current
      const c = containerRef.current
      const l = layerRef.current
      if (a && c && l) {
        const t = a.currentTime
        const halfW = c.clientWidth / 2
        const x = -t * pps + halfW
        l.style.transform = `translate3d(${x}px, 0, 0)`
        const now = performance.now()
        if (now - last > 100) {
          setCurrentTime(t)
          last = now
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [pps])

  // ---------- Edits ----------
  const updateByUid = useCallback((uid: number, patch: Partial<Syllable>, resort = false) => {
    setSylls((cur) => {
      const out = cur.map((s) => (s._uid === uid ? { ...s, ...patch } : s))
      if (resort) out.sort((a, b) => a.time_s - b.time_s)
      return out
    })
    setDirty(true)
  }, [])

  const deleteByUid = useCallback((uid: number) => {
    setSylls((cur) => cur.filter((s) => s._uid !== uid))
    setSelectedUid((cur) => (cur === uid ? null : cur))
    setDirty(true)
  }, [])

  const addAt = useCallback((time: number, pitch: number) => {
    const text = window.prompt('Lyric for new syllable:', '—')
    if (text === null) return
    const newSyl: LocalSyll = {
      _uid: _nextUid++,
      time_s: Math.max(0, +time.toFixed(3)),
      duration_s: 0.3,
      text: text.trim() || '—',
      midi_pitch: pitch,
      confidence: 1.0,
      voicing: 'sung',
    }
    setSylls((cur) => {
      const out = [...cur, newSyl]
      out.sort((a, b) => a.time_s - b.time_s)
      return out
    })
    setSelectedUid(newSyl._uid)
    setDirty(true)
  }, [])

  // ---------- Pointer handlers ----------
  const dragRef = useRef<{
    uid: number
    mode: 'move' | 'resize'
    startClientX: number
    startClientY: number
    origTime: number
    origDur: number
    origPitch: number
    moved: boolean
  } | null>(null)

  const beginDrag = (e: React.PointerEvent, syl: LocalSyll, mode: 'move' | 'resize') => {
    e.stopPropagation()
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    dragRef.current = {
      uid: syl._uid,
      mode,
      startClientX: e.clientX,
      startClientY: e.clientY,
      origTime: syl.time_s,
      origDur: syl.duration_s,
      origPitch: syl.midi_pitch,
      moved: false,
    }
    setSelectedUid(syl._uid)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.startClientX
    const dy = e.clientY - d.startClientY
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true
    if (d.mode === 'move') {
      const newTime = Math.max(0, +(d.origTime + dx / pps).toFixed(3))
      const newPitch = Math.max(minMidi, Math.min(maxMidi, d.origPitch - Math.round(dy / ROW_H)))
      updateByUid(d.uid, { time_s: newTime, midi_pitch: newPitch }, false)
    } else {
      const newDur = Math.max(0.05, +(d.origDur + dx / pps).toFixed(3))
      updateByUid(d.uid, { duration_s: newDur }, false)
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
    if (d.mode === 'move' && d.moved) {
      // Resort once at end so list stays time-ordered without thrashing during drag.
      setSylls((cur) => [...cur].sort((a, b) => a.time_s - b.time_s))
    }
    dragRef.current = null
  }

  const onContainerClick = (e: React.MouseEvent) => {
    if (dragRef.current?.moved) return
    if (editingUid !== null) return
    if ((e.target as HTMLElement).closest('[data-syl]')) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const halfW = rect.width / 2
    const xInLayer = e.clientX - rect.left - halfW
    const time = currentTime + xInLayer / pps
    const yInLayer = e.clientY - rect.top
    const pitch = midiForY(yInLayer)
    if (time < 0) return
    addAt(time, pitch)
  }

  // ---------- Keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editingUid !== null) return
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      if (e.code === 'Space') {
        e.preventDefault()
        const a = audioRef.current
        if (!a) return
        if (a.paused) a.play().catch(() => {})
        else a.pause()
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedUid !== null) {
          e.preventDefault()
          deleteByUid(selectedUid)
        }
        return
      }
      if (selectedUid !== null) {
        const sel = sylls.find((s) => s._uid === selectedUid)
        if (!sel) return
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          const delta = e.key === 'ArrowUp' ? 1 : -1
          const step = e.shiftKey ? 12 : 1
          updateByUid(selectedUid, {
            midi_pitch: Math.max(minMidi, Math.min(maxMidi, sel.midi_pitch + delta * step)),
          })
          return
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          const delta = e.key === 'ArrowRight' ? 1 : -1
          const step = e.shiftKey ? 0.1 : 0.01
          updateByUid(selectedUid, {
            time_s: Math.max(0, +(sel.time_s + delta * step).toFixed(3)),
          }, true)
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          startEdit(selectedUid)
          return
        }
      } else {
        // Transport without selection
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          const a = audioRef.current
          if (!a) return
          const step = e.shiftKey ? 1 : 0.1
          a.currentTime = Math.max(0, a.currentTime + (e.key === 'ArrowRight' ? step : -step))
        }
        if (e.key === 'Home') {
          e.preventDefault()
          const a = audioRef.current
          if (a) a.currentTime = 0
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUid, editingUid, sylls, minMidi, maxMidi])

  // ---------- Inline lyric edit ----------
  const startEdit = (uid: number) => {
    const s = sylls.find((x) => x._uid === uid)
    if (!s) return
    setEditingUid(uid)
    setEditText(s.text)
    setSelectedUid(uid)
    setTimeout(() => editInputRef.current?.focus(), 0)
  }
  const commitEdit = () => {
    if (editingUid === null) return
    updateByUid(editingUid, { text: editText.trim() || '—' })
    setEditingUid(null)
  }
  const cancelEdit = () => setEditingUid(null)

  // ---------- Audio events ----------
  const onAudioPlay = () => setPlaying(true)
  const onAudioPause = () => setPlaying(false)
  const didAutoSeekRef = useRef(false)
  const onAudioMetadata = () => {
    const a = audioRef.current
    if (!a) return
    setDuration(a.duration || 0)
    // One-shot pre-roll: jump to ~1s before the first syllable so the user
    // immediately sees content instead of an empty highway. Skips if the user
    // already moved the cursor (e.g. via seek slider) before metadata loaded.
    if (!didAutoSeekRef.current && sylls.length && a.currentTime === 0) {
      const target = Math.max(0, sylls[0].time_s - 1)
      a.currentTime = target
      didAutoSeekRef.current = true
    }
  }
  // Seek to first syllable once data and audio are both ready.
  useEffect(() => {
    if (didAutoSeekRef.current) return
    const a = audioRef.current
    if (!a || !sylls.length) return
    if (a.readyState >= 1 && a.duration > 0) {
      a.currentTime = Math.max(0, sylls[0].time_s - 1)
      didAutoSeekRef.current = true
    }
  }, [sylls])

  // Next-note indicator: where is the closest upcoming syllable relative
  // to the current playhead? Used to show a "→ jump to next note" button
  // when nothing is in the current viewport.
  const viewportSpanS = useMemo(() => {
    const w = containerRef.current?.clientWidth ?? 1200
    return w / pps
  }, [pps, containerRef.current?.clientWidth])

  const visibleCount = useMemo(() => {
    const halfSpan = viewportSpanS / 2
    return sylls.filter((s) => {
      const end = s.time_s + s.duration_s
      return end > currentTime - halfSpan && s.time_s < currentTime + halfSpan
    }).length
  }, [sylls, currentTime, viewportSpanS])

  const nextSyllAfterNow = useMemo(() => {
    return sylls.find((s) => s.time_s > currentTime) ?? null
  }, [sylls, currentTime])

  const jumpToNext = () => {
    const a = audioRef.current
    if (!a || !nextSyllAfterNow) return
    a.currentTime = Math.max(0, nextSyllAfterNow.time_s - 0.5)
  }

  // ---------- Save ----------
  const save = async () => {
    if (!trackId || !meta) return
    setSaving(true)
    setSaveError('')
    try {
      const body: VocalNotes = {
        ...meta,
        syllables: stripUids(sylls),
      }
      const res = await fetch(`/api/vocals?track_id=${trackId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.detail || `HTTP ${res.status}`)
      }
      setDirty(false)
    } catch (e) {
      setSaveError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // ---------- Current phrase line ----------
  const currentPhraseLine = useMemo(() => {
    if (!sylls.length) return ''
    let startIdx = 0
    for (let i = 0; i < sylls.length; i++) {
      if (sylls[i].time_s > currentTime) { startIdx = Math.max(0, i - 1); break }
      startIdx = i
    }
    let phraseStart = startIdx
    while (phraseStart > 0 && !sylls[phraseStart].phrase_start) phraseStart -= 1
    let phraseEnd = startIdx
    while (phraseEnd < sylls.length - 1 && !sylls[phraseEnd].phrase_end) phraseEnd += 1
    return sylls.slice(phraseStart, phraseEnd + 1).map((s) => s.text).join(' ')
  }, [sylls, currentTime])

  // ---------- Render ----------
  if (loading) {
    return <div className="p-8 text-gray-400">Loading vocal notes…</div>
  }
  if (loadError) {
    return (
      <div className="p-8 space-y-3">
        <div className="text-amber-300">{loadError}</div>
        <button
          onClick={() => navigate(-1)}
          className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-sm text-gray-300"
        >
          Back
        </button>
      </div>
    )
  }

  const audioUrl = `/api/tracks/${trackId}/stems/${audioSource}`
  const halfW = containerRef.current?.clientWidth ? containerRef.current.clientWidth / 2 : 0
  const highwayHeight = totalRows * ROW_H
  const totalDur = Math.max(duration || 0, ...sylls.map((s) => s.time_s + s.duration_s))

  return (
    <div className="fixed inset-0 bg-gray-950 text-gray-200 flex flex-col">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-gray-900/80">
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              if (dirty && !window.confirm('Discard unsaved changes?')) return
              navigate(-1)
            }}
            className="text-gray-500 hover:text-gray-300 text-sm"
          >
            ← Back
          </button>
          <div className="text-sm font-semibold text-jam-300">Vocal Beatmap Editor</div>
          {meta && (
            <div className="text-xs text-gray-500">
              {meta.pitch_model} · {meta.syllabified_from} · {sylls.length} syllables
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {dirty && <span className="text-xs text-amber-400">● unsaved</span>}
          {saveError && <span className="text-xs text-red-400">{saveError}</span>}
          <button
            onClick={save}
            disabled={saving || !dirty}
            className="px-3 py-1.5 bg-jam-600 hover:bg-jam-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs rounded font-medium"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </header>

      {/* Highway */}
      <div
        ref={containerRef}
        onClick={onContainerClick}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="flex-1 relative overflow-hidden cursor-crosshair select-none bg-gray-950"
        style={{ minHeight: highwayHeight + 80 }}
      >
        {/* Pitch row stripes */}
        <div className="absolute inset-0 pointer-events-none">
          {Array.from({ length: totalRows }).map((_, i) => {
            const midi = maxMidi - i
            const isOctC = (midi % 12) === 0
            return (
              <div
                key={i}
                className={`absolute left-0 right-0 ${isOctC ? 'bg-gray-900/80 border-t border-gray-800' : i % 2 ? 'bg-gray-900/40' : 'bg-gray-900/20'}`}
                style={{ top: i * ROW_H, height: ROW_H }}
              >
                {isOctC && (
                  <span className="absolute left-1 top-0.5 text-[9px] text-gray-600 font-mono">{noteName(midi)}</span>
                )}
              </div>
            )
          })}
        </div>

        {/* Syllable bars layer (translated by raf) */}
        <div
          ref={layerRef}
          className="absolute top-0 left-0 will-change-transform"
          style={{ transform: `translate3d(${halfW}px, 0, 0)`, height: highwayHeight }}
        >
          {sylls.map((s) => {
            const c = colorFor(s)
            const left = s.time_s * pps
            const width = Math.max(8, s.duration_s * pps)
            const top = yForMidi(s.midi_pitch)
            const selected = s._uid === selectedUid
            const isEditing = s._uid === editingUid
            return (
              <div
                key={s._uid}
                data-syl={s._uid}
                onPointerDown={(e) => beginDrag(e, s, 'move')}
                onDoubleClick={(e) => { e.stopPropagation(); startEdit(s._uid) }}
                className={`absolute rounded-sm overflow-hidden flex items-center px-1 text-[11px] font-medium cursor-grab active:cursor-grabbing ${selected ? 'ring-2 ring-white ring-offset-1 ring-offset-gray-950 z-10' : ''}`}
                style={{
                  left,
                  top,
                  width,
                  height: ROW_H - 2,
                  background: c.fill,
                  border: `1px solid ${c.outline}`,
                  color: '#0a0a0a',
                  textShadow: '0 0 2px rgba(255,255,255,0.4)',
                }}
                title={`${s.text} | ${noteName(s.midi_pitch)} | ${s.voicing} | ${s.time_s.toFixed(2)}s + ${s.duration_s.toFixed(2)}s`}
              >
                {isEditing ? (
                  <input
                    ref={editInputRef}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
                      if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="w-full bg-white/90 text-black px-1 text-[11px] outline-none"
                  />
                ) : (
                  <span className="truncate pointer-events-none">{s.text}</span>
                )}
                {/* Resize handle on right edge */}
                {!isEditing && (
                  <div
                    onPointerDown={(e) => beginDrag(e, s, 'resize')}
                    className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-black/30 opacity-0 hover:opacity-100"
                  />
                )}
                {s.phrase_start && <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-white/80" />}
                {s.phrase_end && <div className="absolute right-0 top-0 bottom-0 w-0.5 bg-white/80" />}
              </div>
            )
          })}
        </div>

        {/* Now marker (static, centered) */}
        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-jam-400 pointer-events-none z-20" />
        <div className="absolute top-1 left-1/2 -translate-x-1/2 px-1.5 py-0.5 bg-jam-600/90 text-white text-[10px] font-semibold rounded pointer-events-none z-20">
          {currentTime.toFixed(2)}s
        </div>

        {/* "Jump to next note" affordance when nothing is in view */}
        {visibleCount === 0 && nextSyllAfterNow && (
          <button
            onClick={(e) => { e.stopPropagation(); jumpToNext() }}
            className="absolute top-1/2 right-4 -translate-y-1/2 px-3 py-2 bg-pink-700/80 hover:bg-pink-600 text-pink-100 text-xs rounded-md font-medium z-30 shadow-lg"
            title={`Next note "${nextSyllAfterNow.text}" at ${nextSyllAfterNow.time_s.toFixed(2)}s`}
          >
            → Next note ({nextSyllAfterNow.time_s.toFixed(1)}s)
          </button>
        )}
      </div>

      {/* Lyric line */}
      <div className="border-t border-gray-800 bg-gray-900 px-4 py-2 text-center">
        <div className="text-[10px] uppercase tracking-wider text-gray-600">Now</div>
        <div className="text-base text-jam-200 truncate">{currentPhraseLine || '—'}</div>
      </div>

      {/* Transport */}
      <div className="border-t border-gray-800 bg-gray-900 px-4 py-2 flex items-center gap-3">
        <button
          onClick={() => {
            const a = audioRef.current
            if (!a) return
            if (a.paused) a.play().catch(() => {})
            else a.pause()
          }}
          className="px-3 py-1.5 bg-jam-600 hover:bg-jam-500 text-white text-sm rounded font-medium w-20"
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <span className="text-xs text-gray-400 tabular-nums w-20 text-center">
          {Math.floor(currentTime / 60)}:{Math.floor(currentTime % 60).toString().padStart(2, '0')}
          {' / '}
          {Math.floor(totalDur / 60)}:{Math.floor(totalDur % 60).toString().padStart(2, '0')}
        </span>
        <input
          type="range"
          min={0}
          max={totalDur || 1}
          step={0.05}
          value={currentTime}
          onChange={(e) => {
            const v = parseFloat(e.target.value)
            if (audioRef.current) audioRef.current.currentTime = v
          }}
          className="flex-1 accent-jam-500"
        />
        <div className="flex items-center gap-1 text-xs">
          <span className="text-gray-500">Audio:</span>
          <button
            onClick={() => setAudioSource('vocals')}
            className={`px-2 py-0.5 rounded ${audioSource === 'vocals' ? 'bg-pink-700/60 text-pink-200' : 'bg-gray-800 text-gray-500'}`}
          >
            vocals
          </button>
          <button
            onClick={() => setAudioSource('song')}
            className={`px-2 py-0.5 rounded ${audioSource === 'song' ? 'bg-jam-700/60 text-jam-200' : 'bg-gray-800 text-gray-500'}`}
          >
            song
          </button>
        </div>
        <div className="flex items-center gap-1 text-xs">
          <span className="text-gray-500">Zoom:</span>
          <input
            type="range"
            min={MIN_PPS}
            max={MAX_PPS}
            step={10}
            value={pps}
            onChange={(e) => setPps(parseInt(e.target.value))}
            className="w-24 accent-jam-500"
          />
        </div>
      </div>

      {/* Help footer */}
      <div className="border-t border-gray-800 bg-gray-950 px-4 py-1 text-[10px] text-gray-600 flex flex-wrap gap-x-4">
        <span>Click empty: add syllable</span>
        <span>Click bar: select</span>
        <span>Drag bar: move (time + pitch)</span>
        <span>Drag right edge: resize</span>
        <span>Double-click bar: edit lyric</span>
        <span>↑↓: ±semitone (Shift: ±octave)</span>
        <span>←→: nudge time (Shift: 0.1s)</span>
        <span>Enter: edit lyric</span>
        <span>Delete: remove</span>
        <span>Space: play/pause</span>
      </div>

      <audio
        ref={audioRef}
        src={audioUrl}
        preload="auto"
        onPlay={onAudioPlay}
        onPause={onAudioPause}
        onLoadedMetadata={onAudioMetadata}
      />
    </div>
  )
}
