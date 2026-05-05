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

const VOICINGS: Voicing[] = ['sung', 'spoken', 'whispered']
const VOICING_LABEL: Record<Voicing, string> = { sung: 'Sung', spoken: 'Spoken', whispered: 'Whisper' }

function colorFor(s: Syllable): { fill: string; outline: string } {
  const base = PITCH_COLORS[((s.midi_pitch % 12) + 12) % 12]
  if (s.voicing === 'whispered') return { fill: base + '55', outline: base + 'aa' }
  if (s.voicing === 'spoken') return { fill: base + '99', outline: base }
  return { fill: base, outline: base }
}

const fmtTime = (sec: number) => {
  const m = Math.floor(sec / 60)
  const s = (sec % 60).toFixed(2).padStart(5, '0')
  return `${m}:${s}`
}

type LocalSyll = Syllable & { _uid: number }
let _nextUid = 1
const withUids = (sylls: Syllable[]): LocalSyll[] => sylls.map((s) => ({ ...s, _uid: _nextUid++ }))
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
  const [playbackRate, setPlaybackRate] = useState(1)
  const [volume, setVolume] = useState(1)
  const [snapToFrame, setSnapToFrame] = useState(true)
  const [autoFollowPitch, setAutoFollowPitch] = useState(true)

  const [selectedUid, setSelectedUid] = useState<number | null>(null)
  const [editingUid, setEditingUid] = useState<number | null>(null)
  const [editText, setEditText] = useState('')

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const highwayRef = useRef<HTMLDivElement | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
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

  // ---------- Quantization ----------
  const hopS = meta?.frame_hop_s ?? 0.01
  const snap = (t: number) => (snapToFrame ? +(Math.round(t / hopS) * hopS).toFixed(3) : +t.toFixed(3))

  // ---------- Animation: drive layer transform from audio.currentTime ----------
  useEffect(() => {
    let raf = 0
    let last = 0
    const tick = () => {
      const a = audioRef.current
      const h = highwayRef.current
      const l = layerRef.current
      if (a && h && l) {
        const t = a.currentTime
        const halfW = h.clientWidth / 2
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

  // ---------- Auto-follow pitch: vertical scroll to keep "now" centered ----------
  useEffect(() => {
    if (!autoFollowPitch) return
    const sc = scrollerRef.current
    if (!sc) return
    // Find the syllable closest to currentTime
    let closest: LocalSyll | null = null
    let bestDt = Infinity
    for (const s of sylls) {
      const mid = s.time_s + s.duration_s / 2
      const dt = Math.abs(mid - currentTime)
      if (dt < bestDt) { bestDt = dt; closest = s }
    }
    if (!closest) return
    const targetY = yForMidi(closest.midi_pitch) + ROW_H / 2
    const desiredScroll = targetY - sc.clientHeight / 2
    const maxScroll = sc.scrollHeight - sc.clientHeight
    const clamped = Math.max(0, Math.min(maxScroll, desiredScroll))
    // Smooth-ish: only nudge if off by more than half a row
    if (Math.abs(sc.scrollTop - clamped) > ROW_H / 2) {
      sc.scrollTo({ top: clamped, behavior: 'smooth' })
    }
  }, [currentTime, autoFollowPitch, sylls, maxMidi])

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
      time_s: Math.max(0, snap(time)),
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
  }, [snap])

  // ---------- Drag ----------
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
      const newTime = Math.max(0, snap(d.origTime + dx / pps))
      const newPitch = Math.max(minMidi, Math.min(maxMidi, d.origPitch - Math.round(dy / ROW_H)))
      updateByUid(d.uid, { time_s: newTime, midi_pitch: newPitch }, false)
    } else {
      const newDur = Math.max(hopS, snap(d.origDur + dx / pps))
      updateByUid(d.uid, { duration_s: newDur }, false)
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
    if (d.mode === 'move' && d.moved) {
      setSylls((cur) => [...cur].sort((a, b) => a.time_s - b.time_s))
    }
    dragRef.current = null
  }

  const onHighwayClick = (e: React.MouseEvent) => {
    if (dragRef.current?.moved) return
    if (editingUid !== null) return
    if ((e.target as HTMLElement).closest('[data-syl]')) return
    const h = highwayRef.current
    const sc = scrollerRef.current
    if (!h || !sc) return
    const rect = h.getBoundingClientRect()
    const halfW = rect.width / 2
    const xInLayer = e.clientX - rect.left - halfW
    const time = currentTime + xInLayer / pps
    const yInLayer = e.clientY - rect.top + sc.scrollTop
    const pitch = midiForY(yInLayer)
    if (time < 0) return
    addAt(time, pitch)
  }

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

  // ---------- Transport ----------
  const togglePlay = useCallback(() => {
    const a = audioRef.current
    if (!a) return
    if (a.paused) a.play().catch(() => {})
    else a.pause()
  }, [])

  const seekBy = (delta: number) => {
    const a = audioRef.current
    if (!a) return
    a.currentTime = Math.max(0, Math.min(a.duration || Infinity, a.currentTime + delta))
  }

  const seekTo = (sec: number) => {
    const a = audioRef.current
    if (!a) return
    a.currentTime = Math.max(0, Math.min(a.duration || Infinity, sec))
  }

  const seekToSelected = () => {
    if (selectedUid === null) return
    const s = sylls.find((x) => x._uid === selectedUid)
    if (s) seekTo(Math.max(0, s.time_s - 0.3))
  }

  // ---------- Keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editingUid !== null) return
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedUid !== null) {
          e.preventDefault()
          deleteByUid(selectedUid)
        }
        return
      }
      if (e.key === 'Home') {
        e.preventDefault()
        seekTo(0)
        return
      }
      if (e.key === 'End') {
        e.preventDefault()
        seekTo(duration || 0)
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
          const step = e.shiftKey ? 0.1 : hopS
          updateByUid(selectedUid, {
            time_s: Math.max(0, snap(sel.time_s + delta * step)),
          }, true)
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          startEdit(selectedUid)
          return
        }
      } else {
        // Transport without selection: arrow keys scrub
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          const step = e.shiftKey ? 1 : 0.1
          seekBy(e.key === 'ArrowRight' ? step : -step)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUid, editingUid, sylls, minMidi, maxMidi, duration, hopS, snapToFrame, togglePlay])

  // ---------- Audio events / one-shot pre-roll ----------
  const didAutoSeekRef = useRef(false)
  const onAudioPlay = () => setPlaying(true)
  const onAudioPause = () => setPlaying(false)
  const onAudioMetadata = () => {
    const a = audioRef.current
    if (!a) return
    setDuration(a.duration || 0)
    a.playbackRate = playbackRate
    a.volume = volume
    if (!didAutoSeekRef.current && sylls.length && a.currentTime === 0) {
      a.currentTime = Math.max(0, sylls[0].time_s - 1)
      didAutoSeekRef.current = true
    }
  }
  useEffect(() => {
    const a = audioRef.current
    if (a) a.playbackRate = playbackRate
  }, [playbackRate])
  useEffect(() => {
    const a = audioRef.current
    if (a) a.volume = volume
  }, [volume])
  useEffect(() => {
    if (didAutoSeekRef.current) return
    const a = audioRef.current
    if (!a || !sylls.length) return
    if (a.readyState >= 1 && a.duration > 0) {
      a.currentTime = Math.max(0, sylls[0].time_s - 1)
      didAutoSeekRef.current = true
    }
  }, [sylls])

  // ---------- Visible window helpers ----------
  const viewportSpanS = useMemo(() => {
    const w = highwayRef.current?.clientWidth ?? 1200
    return w / pps
  }, [pps, highwayRef.current?.clientWidth])

  const visibleCount = useMemo(() => {
    const halfSpan = viewportSpanS / 2
    return sylls.filter((s) => {
      const end = s.time_s + s.duration_s
      return end > currentTime - halfSpan && s.time_s < currentTime + halfSpan
    }).length
  }, [sylls, currentTime, viewportSpanS])

  const nextSyllAfterNow = useMemo(() => sylls.find((s) => s.time_s > currentTime) ?? null, [sylls, currentTime])

  const jumpToNext = () => { if (nextSyllAfterNow) seekTo(Math.max(0, nextSyllAfterNow.time_s - 0.5)) }

  // ---------- Save ----------
  const save = async () => {
    if (!trackId || !meta) return
    setSaving(true); setSaveError('')
    try {
      const body: VocalNotes = { ...meta, syllables: stripUids(sylls) }
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
    } finally { setSaving(false) }
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
    return sylls
      .slice(phraseStart, phraseEnd + 1)
      .map((s, i, arr) => {
        const isCurrent = arr[i] && arr[i].time_s <= currentTime && currentTime < arr[i].time_s + arr[i].duration_s
        return { text: s.text, current: isCurrent }
      })
  }, [sylls, currentTime])

  const selected = selectedUid !== null ? sylls.find((s) => s._uid === selectedUid) || null : null

  // ---------- Render ----------
  if (loading) return <div className="p-8 text-gray-400">Loading vocal notes…</div>
  if (loadError) {
    return (
      <div className="p-8 space-y-3">
        <div className="text-amber-300">{loadError}</div>
        <button onClick={() => navigate(-1)} className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-sm text-gray-300">Back</button>
      </div>
    )
  }

  const audioUrl = `/api/tracks/${trackId}/stems/${audioSource}`
  const halfW = highwayRef.current?.clientWidth ? highwayRef.current.clientWidth / 2 : 0
  const highwayHeight = totalRows * ROW_H
  const totalDur = Math.max(duration || 0, ...sylls.map((s) => s.time_s + s.duration_s))

  return (
    <div className="fixed inset-0 bg-gray-950 text-gray-200 flex flex-col">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-gray-900/80 shrink-0">
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
          <div className="text-sm font-semibold text-jam-300">Vocalmap Editor</div>
          {meta && (
            <div className="text-xs text-gray-500 hidden md:block">
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
            className="px-4 py-1.5 bg-jam-600 hover:bg-jam-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs rounded font-medium"
          >
            {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* HIGHWAY */}
        <div
          ref={highwayRef}
          onClick={onHighwayClick}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className="flex-1 relative overflow-hidden cursor-crosshair select-none bg-gray-950 min-w-0"
        >
          {/* Vertically scrollable layer (pitch grid + bars) */}
          <div
            ref={scrollerRef}
            className="absolute inset-0 overflow-y-auto overflow-x-hidden"
          >
            <div className="relative" style={{ height: highwayHeight, width: '100%' }}>
              {/* Pitch row stripes */}
              <div className="absolute inset-0 pointer-events-none">
                {Array.from({ length: totalRows }).map((_, i) => {
                  const midi = maxMidi - i
                  const isOctC = (midi % 12) === 0
                  return (
                    <div
                      key={i}
                      className={`absolute left-0 right-0 ${
                        isOctC
                          ? 'bg-gray-900/80 border-t border-gray-800'
                          : i % 2
                            ? 'bg-gray-900/40'
                            : 'bg-gray-900/20'
                      }`}
                      style={{ top: i * ROW_H, height: ROW_H }}
                    >
                      {isOctC && (
                        <span className="absolute left-1 top-0.5 text-[9px] text-gray-600 font-mono">
                          {noteName(midi)}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Bars layer (translated horizontally by raf) */}
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
                  const isSelected = s._uid === selectedUid
                  const isEditing = s._uid === editingUid
                  return (
                    <div
                      key={s._uid}
                      data-syl={s._uid}
                      onPointerDown={(e) => beginDrag(e, s, 'move')}
                      onDoubleClick={(e) => { e.stopPropagation(); startEdit(s._uid) }}
                      className={`absolute rounded-sm overflow-hidden flex items-center px-1 text-[11px] font-medium cursor-grab active:cursor-grabbing ${
                        isSelected ? 'ring-2 ring-white ring-offset-1 ring-offset-gray-950 z-10' : ''
                      }`}
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
            </div>
          </div>

          {/* Static center marker (full highway height, ignores vertical scroll) */}
          <div className="absolute top-0 bottom-0 left-1/2 w-px bg-jam-400 pointer-events-none z-20" />
          <div className="absolute top-1 left-1/2 -translate-x-1/2 px-1.5 py-0.5 bg-jam-600/90 text-white text-[10px] font-semibold rounded pointer-events-none z-20">
            {fmtTime(currentTime)}
          </div>

          {/* Empty-viewport hint */}
          {visibleCount === 0 && nextSyllAfterNow && (
            <button
              onClick={(e) => { e.stopPropagation(); jumpToNext() }}
              className="absolute top-1/2 right-4 -translate-y-1/2 px-3 py-2 bg-pink-700/80 hover:bg-pink-600 text-pink-100 text-xs rounded-md font-medium z-30 shadow-lg"
            >
              → Next note ({nextSyllAfterNow.time_s.toFixed(1)}s)
            </button>
          )}
        </div>

        {/* SIDEBAR */}
        <aside className="w-72 shrink-0 border-l border-gray-800 bg-gray-950 overflow-y-auto p-4 space-y-5">
          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Transport</h3>
            <div className="flex items-center gap-2 mb-2">
              <button
                onClick={togglePlay}
                className="w-9 h-9 rounded-full bg-jam-600 hover:bg-jam-500 text-white flex items-center justify-center text-sm"
                aria-label={playing ? 'Pause' : 'Play'}
              >
                {playing ? '❚❚' : '▶'}
              </button>
              <span className="text-xs font-mono text-gray-400 tabular-nums">
                {fmtTime(currentTime)} / {fmtTime(totalDur)}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={totalDur || 1}
              step={0.05}
              value={currentTime}
              onChange={(e) => seekTo(parseFloat(e.target.value))}
              className="w-full accent-jam-500"
            />
            <div className="flex items-center gap-2 mt-2 text-[11px]">
              <button
                onClick={() => seekBy(-1)}
                className="px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 rounded text-gray-300"
                title="Back 1s (Shift+←)"
              >−1s</button>
              <button
                onClick={() => seekBy(1)}
                className="px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 rounded text-gray-300"
                title="Forward 1s (Shift+→)"
              >+1s</button>
              <button
                onClick={() => seekTo(0)}
                className="px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 rounded text-gray-300 ml-auto"
                title="Home"
              >⏮</button>
            </div>
          </section>

          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Audio source</h3>
            <div className="grid grid-cols-2 gap-1">
              <button
                onClick={() => setAudioSource('vocals')}
                className={`px-2 py-1 rounded text-xs font-medium ${audioSource === 'vocals' ? 'bg-pink-700/60 text-pink-100' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >Vocals stem</button>
              <button
                onClick={() => setAudioSource('song')}
                className={`px-2 py-1 rounded text-xs font-medium ${audioSource === 'song' ? 'bg-jam-700/60 text-jam-100' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >Full mix</button>
            </div>
          </section>

          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Speed</h3>
            <div className="grid grid-cols-4 gap-1">
              {[0.5, 0.75, 1, 1.25].map((r) => (
                <button
                  key={r}
                  onClick={() => setPlaybackRate(r)}
                  className={`px-1 py-1 rounded text-xs font-medium ${playbackRate === r ? 'bg-jam-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                >{r}×</button>
              ))}
            </div>
          </section>

          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Volume</h3>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              className="w-full accent-jam-500"
            />
          </section>

          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Zoom</h3>
            <input
              type="range"
              min={MIN_PPS}
              max={MAX_PPS}
              step={10}
              value={pps}
              onChange={(e) => setPps(parseInt(e.target.value))}
              className="w-full accent-jam-500"
            />
            <div className="text-[11px] font-mono text-gray-500 mt-0.5">{pps} px/s</div>
          </section>

          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">View</h3>
            <label className="flex items-center gap-2 text-[11px] text-gray-300 mb-1">
              <input
                type="checkbox"
                checked={autoFollowPitch}
                onChange={(e) => setAutoFollowPitch(e.target.checked)}
                className="accent-jam-500"
              />
              Auto-follow pitch
            </label>
            <label className="flex items-center gap-2 text-[11px] text-gray-300">
              <input
                type="checkbox"
                checked={snapToFrame}
                onChange={(e) => setSnapToFrame(e.target.checked)}
                className="accent-jam-500"
              />
              Snap to {Math.round(hopS * 1000)} ms grid
            </label>
          </section>

          <section className="border-t border-gray-800 pt-4">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Selected note</h3>
            {!selected ? (
              <div className="text-[11px] text-gray-600">Click a bar to select.</div>
            ) : (
              <div className="space-y-2 text-[11px]">
                <div className="flex items-center gap-2">
                  <span className="text-gray-500 w-12">Lyric</span>
                  <input
                    value={selected.text}
                    onChange={(e) => updateByUid(selected._uid, { text: e.target.value || '—' })}
                    className="flex-1 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-gray-200"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-gray-500 w-12">Pitch</span>
                  <input
                    type="number"
                    value={selected.midi_pitch}
                    min={minMidi}
                    max={maxMidi}
                    onChange={(e) => updateByUid(selected._uid, {
                      midi_pitch: Math.max(minMidi, Math.min(maxMidi, parseInt(e.target.value) || 60)),
                    })}
                    className="w-16 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-gray-200"
                  />
                  <span className="text-gray-500 font-mono">{noteName(selected.midi_pitch)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-gray-500 w-12">Time</span>
                  <input
                    type="number"
                    step={hopS}
                    value={selected.time_s}
                    onChange={(e) => updateByUid(selected._uid, {
                      time_s: Math.max(0, parseFloat(e.target.value) || 0),
                    }, true)}
                    className="w-24 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-gray-200 font-mono"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-gray-500 w-12">Dur</span>
                  <input
                    type="number"
                    step={hopS}
                    min={hopS}
                    value={selected.duration_s}
                    onChange={(e) => updateByUid(selected._uid, {
                      duration_s: Math.max(hopS, parseFloat(e.target.value) || hopS),
                    })}
                    className="w-24 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-gray-200 font-mono"
                  />
                </div>
                <div>
                  <span className="text-gray-500 block mb-1">Voicing</span>
                  <div className="grid grid-cols-3 gap-1">
                    {VOICINGS.map((v) => (
                      <button
                        key={v}
                        onClick={() => updateByUid(selected._uid, { voicing: v })}
                        className={`px-1 py-1 rounded text-[10px] font-medium ${
                          selected.voicing === v ? 'bg-jam-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                        }`}
                      >{VOICING_LABEL[v]}</button>
                    ))}
                  </div>
                </div>
                <div className="flex gap-1 pt-1">
                  <button
                    onClick={seekToSelected}
                    className="flex-1 px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded text-[10px] text-gray-300"
                  >Seek to here</button>
                  <button
                    onClick={() => deleteByUid(selected._uid)}
                    className="px-2 py-1 bg-red-900/40 hover:bg-red-800/60 rounded text-[10px] text-red-200"
                  >Delete</button>
                </div>
              </div>
            )}
          </section>

          <section className="border-t border-gray-800 pt-4">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Shortcuts</h3>
            <ul className="text-[11px] text-gray-400 space-y-1 leading-snug">
              <li><span className="font-mono text-gray-300">Click empty</span> add syllable</li>
              <li><span className="font-mono text-gray-300">Click bar</span> select</li>
              <li><span className="font-mono text-gray-300">Drag bar</span> move (time + pitch)</li>
              <li><span className="font-mono text-gray-300">Drag right edge</span> resize</li>
              <li><span className="font-mono text-gray-300">Dbl-click</span> edit lyric</li>
              <li><span className="font-mono text-gray-300">↑/↓</span> ±semitone (Shift: ±octave)</li>
              <li><span className="font-mono text-gray-300">←/→</span> nudge time (Shift: 0.1s)</li>
              <li><span className="font-mono text-gray-300">Enter</span> edit lyric</li>
              <li><span className="font-mono text-gray-300">Del</span> remove</li>
              <li><span className="font-mono text-gray-300">Space</span> play/pause</li>
              <li><span className="font-mono text-gray-300">Home/End</span> jump to start/end</li>
            </ul>
          </section>
        </aside>
      </div>

      {/* Lyric line — full width below highway */}
      <div className="border-t border-gray-800 bg-gray-900 px-4 py-2 text-center shrink-0">
        <div className="text-[10px] uppercase tracking-wider text-gray-600">Now</div>
        <div className="text-base text-gray-300 truncate">
          {Array.isArray(currentPhraseLine) && currentPhraseLine.length > 0 ? (
            currentPhraseLine.map((p, i) => (
              <span
                key={i}
                className={p.current ? 'text-jam-200 font-semibold' : 'text-gray-400'}
              >
                {p.text}{i < currentPhraseLine.length - 1 ? ' ' : ''}
              </span>
            ))
          ) : (
            <span className="text-gray-600">—</span>
          )}
        </div>
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
