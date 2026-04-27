import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

// .chart parsing ------------------------------------------------------------

interface ChartNote {
  tick: number
  lane: number       // 0-4 colored frets, 5 force-hopo, 6 tap, 7 open
  sustain: number    // sustain length in ticks (0 = single hit)
}

interface ChartState {
  fullText: string
  resolution: number
  bpm: number
  bpmRaw: number
  songName: string
  availableSections: string[]
  activeName: string
  notes: ChartNote[]
}

const DIFFICULTY_PREFERENCE = [
  'ExpertSingle', 'HardSingle', 'MediumSingle', 'EasySingle',
  'ExpertDrums', 'HardDrums', 'MediumDrums', 'EasyDrums',
  'ExpertDoubleBass', 'HardDoubleBass', 'MediumDoubleBass', 'EasyDoubleBass',
  'ExpertDoubleGuitar', 'HardDoubleGuitar',
  'ExpertKeyboard', 'HardKeyboard',
]

function findNoteSections(text: string): string[] {
  const re = /\[([A-Za-z0-9_]+)\][\s\r\n]*\{([^}]*)\}/g
  const out: string[] = []
  let m
  while ((m = re.exec(text)) !== null) {
    if (/^\s*\d+\s*=\s*N\s+/m.test(m[2])) out.push(m[1])
  }
  return out
}

function parseSectionNotes(text: string, name: string): ChartNote[] {
  const start = text.indexOf(`[${name}]`)
  if (start === -1) return []
  const open = text.indexOf('{', start)
  const close = text.indexOf('}', open)
  if (open === -1 || close === -1) return []
  const inner = text.slice(open + 1, close)
  const notes: ChartNote[] = []
  for (const raw of inner.split('\n')) {
    const m = raw.trim().match(/^(\d+)\s*=\s*N\s+(\d+)\s+(\d+)/)
    if (m) notes.push({ tick: Number(m[1]), lane: Number(m[2]), sustain: Number(m[3]) })
  }
  return notes
}

function replaceSectionNotes(text: string, name: string, notes: ChartNote[]): string {
  const start = text.indexOf(`[${name}]`)
  if (start === -1) return text
  const open = text.indexOf('{', start)
  const close = text.indexOf('}', open)
  if (open === -1 || close === -1) return text
  const inner = text.slice(open + 1, close)
  // Keep non-note lines (E events, S star power, A anchors) verbatim, replace N lines
  const keptLines = inner
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim() && !/^\s*\d+\s*=\s*N\s+/.test(l))
  const sorted = [...notes].sort((a, b) => a.tick - b.tick || a.lane - b.lane)
  const noteLines = sorted.map((n) => `  ${n.tick} = N ${n.lane} ${n.sustain}`)
  const combined = [...keptLines, ...noteLines].sort((a, b) => {
    const ta = Number(a.match(/^\s*(\d+)/)?.[1] ?? 0)
    const tb = Number(b.match(/^\s*(\d+)/)?.[1] ?? 0)
    return ta - tb
  })
  return text.slice(0, open + 1) + '\n' + combined.join('\n') + '\n' + text.slice(close)
}

function parseChart(text: string, prefer?: string): ChartState {
  const resMatch = text.match(/Resolution\s*=\s*(\d+)/)
  const resolution = resMatch ? Number(resMatch[1]) : 192
  const nameMatch = text.match(/Name\s*=\s*"([^"]*)"/)
  const songName = nameMatch ? nameMatch[1] : 'Untitled'
  const bpmMatch = text.match(/=\s*B\s+(\d+)/)
  const bpmRaw = bpmMatch ? Number(bpmMatch[1]) : 120000
  const bpm = bpmRaw / 1000

  const availableSections = findNoteSections(text)
  let activeName = ''
  if (prefer && availableSections.includes(prefer)) activeName = prefer
  if (!activeName) {
    for (const d of DIFFICULTY_PREFERENCE) {
      if (availableSections.includes(d)) { activeName = d; break }
    }
  }
  if (!activeName && availableSections.length > 0) activeName = availableSections[0]

  const notes = activeName ? parseSectionNotes(text, activeName) : []
  return { fullText: text, resolution, bpm, bpmRaw, songName, availableSections, activeName, notes }
}

function tickToSeconds(tick: number, bpm: number, resolution: number): number {
  return (tick / resolution) * (60 / bpm)
}

// Lane colors (Guitar Hero) -------------------------------------------------

const LANE_FILL = ['#22c55e', '#ef4444', '#eab308', '#3b82f6', '#f97316'] // 0-4
const GUITAR_LABELS = ['Green', 'Red', 'Yellow', 'Blue', 'Orange']
// 5-lane Clone Hero drums convention (kick, snare, hi-hat, tom, cymbal)
const DRUM_LABELS = ['Kick', 'Snare', 'Hi-hat', 'Tom', 'Cymbal']

const SNAP_OPTIONS = [
  { label: '1/4', divisor: 1 },
  { label: '1/8', divisor: 2 },
  { label: '1/16', divisor: 4 },
  { label: '1/32', divisor: 8 },
] as const

interface BeatmapMeta {
  name: string
  stem: string
}

// Component -----------------------------------------------------------------

export default function BeatmapEditor() {
  const params = useParams<{ trackId: string; beatmapId: string }>()
  const navigate = useNavigate()
  const trackId = params.trackId!
  const beatmapId = params.beatmapId!

  const [chart, setChart] = useState<ChartState | null>(null)
  const [meta, setMeta] = useState<BeatmapMeta | null>(null)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [dirty, setDirty] = useState(false)
  const [snapDivisor, setSnapDivisor] = useState(4)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{
    id: number
    startX: number
    startY: number
    moved: boolean
  } | null>(null)
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 800 })

  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [scrollSpeed, setScrollSpeed] = useState(450)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const audioSrc = `/api/tracks/${trackId}/beatmaps/${beatmapId}/download/song.ogg`

  // Lock body scroll while editor is mounted
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  // Load chart and beatmap meta in parallel
  useEffect(() => {
    fetch(`/api/tracks/${trackId}/beatmaps/${beatmapId}/chart`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((data) => setChart(parseChart(data.chart)))
      .catch((e) => setLoadError((e as Error).message))

    fetch(`/api/tracks/${trackId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((track) => {
        if (!track) return
        const bm = (track.beatmaps || []).find((b: { id: string }) => b.id === beatmapId)
        if (bm) setMeta({ name: bm.song_name, stem: bm.stem })
      })
      .catch(() => undefined)
  }, [trackId, beatmapId])

  // Resize canvas to container
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const updateSize = () => {
      const rect = el.getBoundingClientRect()
      setCanvasSize({
        w: Math.max(200, Math.floor(rect.width)),
        h: Math.max(200, Math.floor(rect.height)),
      })
    }
    updateSize()
    const ro = new ResizeObserver(updateSize)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Audio time tracking
  useEffect(() => {
    let raf: number
    const t = () => {
      const a = audioRef.current
      if (a) setCurrentTime(a.currentTime)
      raf = requestAnimationFrame(t)
    }
    raf = requestAnimationFrame(t)
    return () => cancelAnimationFrame(raf)
  }, [])

  const isDrums = meta?.stem === 'drums'
  const laneLabels = useMemo(() => (isDrums ? DRUM_LABELS : GUITAR_LABELS), [isDrums])

  // Canvas drawing
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !chart) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const W = canvas.width
    const H = canvas.height
    const HIT = H - 110
    const NUM_LANES = 5
    const LANE_W = W / NUM_LANES
    const NOTE_R = Math.min(LANE_W * 0.32, 60)

    ctx.fillStyle = '#0a0a0c'
    ctx.fillRect(0, 0, W, H)

    // Lane separators
    ctx.strokeStyle = '#1f2937'
    ctx.lineWidth = 1
    for (let i = 1; i < NUM_LANES; i++) {
      const x = i * LANE_W
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, H)
      ctx.stroke()
    }

    const t2s = (tick: number) => tickToSeconds(tick, chart.bpm, chart.resolution)
    const beatStep = chart.resolution
    const snapTicks = Math.max(1, Math.round(chart.resolution / snapDivisor))

    // Compute visible tick range (a bit beyond top/bottom so lines crossing edges still draw)
    const topSec = currentTime + (HIT + 200) / scrollSpeed
    const bottomSec = currentTime - (H - HIT + 200) / scrollSpeed
    const startTick = Math.max(0, Math.floor((bottomSec * chart.bpm * chart.resolution) / 60))
    const endTick = Math.ceil((topSec * chart.bpm * chart.resolution) / 60)
    const startBeat = Math.floor(startTick / beatStep) * beatStep

    // Snap subdivision lines (faint)
    if (snapDivisor > 1) {
      ctx.strokeStyle = '#0f172a'
      ctx.lineWidth = 1
      for (let t = startBeat; t <= endTick; t += snapTicks) {
        if (t % beatStep === 0) continue
        const y = HIT - (t2s(t) - currentTime) * scrollSpeed
        if (y < -10 || y > H + 10) continue
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(W, y)
        ctx.stroke()
      }
    }
    // Beat lines (stronger)
    ctx.strokeStyle = '#1f2937'
    ctx.lineWidth = 1
    for (let t = startBeat; t <= endTick; t += beatStep) {
      const y = HIT - (t2s(t) - currentTime) * scrollSpeed
      if (y < -10 || y > H + 10) continue
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(W, y)
      ctx.stroke()
    }

    // Hit line + lane circles
    ctx.strokeStyle = '#374151'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(0, HIT)
    ctx.lineTo(W, HIT)
    ctx.stroke()
    for (let lane = 0; lane < NUM_LANES; lane++) {
      const x = (lane + 0.5) * LANE_W
      ctx.beginPath()
      ctx.arc(x, HIT, NOTE_R, 0, Math.PI * 2)
      ctx.fillStyle = '#1f2937'
      ctx.fill()
      ctx.strokeStyle = LANE_FILL[lane]
      ctx.lineWidth = 2
      ctx.stroke()
    }

    // Notes
    for (let i = 0; i < chart.notes.length; i++) {
      const n = chart.notes[i]
      if (n.lane > 4) continue
      const noteSec = t2s(n.tick)
      const dy = (noteSec - currentTime) * scrollSpeed
      const y = HIT - dy
      if (y < -200 || y > H + 200) continue
      const x = (n.lane + 0.5) * LANE_W

      if (n.sustain > 0) {
        const sustainSec = t2s(n.sustain)
        const tailLen = sustainSec * scrollSpeed
        ctx.fillStyle = LANE_FILL[n.lane] + '88'
        ctx.fillRect(x - LANE_W * 0.1, y - tailLen, LANE_W * 0.2, tailLen)
      }

      const isSelected = selectedId === i
      ctx.beginPath()
      ctx.arc(x, y, NOTE_R, 0, Math.PI * 2)
      ctx.fillStyle = LANE_FILL[n.lane]
      ctx.fill()
      ctx.lineWidth = isSelected ? 4 : 2
      ctx.strokeStyle = isSelected ? '#ffffff' : '#000000'
      ctx.stroke()
    }

    // Lane labels at bottom — drum-type or colour name + colour swatch underneath
    ctx.textAlign = 'center'
    for (let lane = 0; lane < NUM_LANES; lane++) {
      const x = (lane + 0.5) * LANE_W
      ctx.fillStyle = LANE_FILL[lane]
      ctx.font = 'bold 13px sans-serif'
      ctx.fillText(laneLabels[lane], x, H - 50)
      if (isDrums) {
        ctx.fillStyle = '#6b7280'
        ctx.font = '10px monospace'
        ctx.fillText(GUITAR_LABELS[lane], x, H - 32)
      }
    }

    // Time + selection readout
    ctx.fillStyle = '#9ca3af'
    ctx.font = '12px monospace'
    ctx.textAlign = 'left'
    const fmt = (t: number) =>
      `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, '0')}.${Math.floor((t % 1) * 100).toString().padStart(2, '0')}`
    ctx.fillText(`t = ${fmt(currentTime)}`, 12, 22)
    if (selectedId !== null && chart.notes[selectedId]) {
      const sel = chart.notes[selectedId]
      ctx.fillText(
        `selected: ${laneLabels[sel.lane] ?? '?'} · tick ${sel.tick} · sustain ${sel.sustain}`,
        12,
        42,
      )
    }
  }, [chart, currentTime, scrollSpeed, selectedId, snapDivisor, isDrums, laneLabels])

  // Resize canvas backing store on container size change
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas) {
      canvas.width = canvasSize.w
      canvas.height = canvasSize.h
    }
  }, [canvasSize])

  // Drive draw loop
  useEffect(() => {
    let raf: number
    const loop = () => {
      draw()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [draw])

  // Mouse interactions
  const canvasToCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const cx = ((e.clientX - rect.left) / rect.width) * canvas.width
    const cy = ((e.clientY - rect.top) / rect.height) * canvas.height
    return { cx, cy }
  }

  const findNoteAt = (cx: number, cy: number): number | null => {
    if (!chart) return null
    const canvas = canvasRef.current
    if (!canvas) return null
    const HIT = canvas.height - 110
    const LANE_W = canvas.width / 5
    const lane = Math.floor(cx / LANE_W)
    if (lane < 0 || lane > 4) return null
    let bestId: number | null = null
    let bestDist = 36
    for (let i = 0; i < chart.notes.length; i++) {
      const n = chart.notes[i]
      if (n.lane !== lane) continue
      const noteSec = tickToSeconds(n.tick, chart.bpm, chart.resolution)
      const y = HIT - (noteSec - currentTime) * scrollSpeed
      const d = Math.abs(y - cy)
      if (d < bestDist) {
        bestDist = d
        bestId = i
      }
    }
    return bestId
  }

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!chart) return
    const { cx, cy } = canvasToCoords(e)
    const id = findNoteAt(cx, cy)
    if (id === null) {
      setSelectedId(null)
      return
    }
    setSelectedId(id)
    dragRef.current = { id, startX: cx, startY: cy, moved: false }
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!chart || !dragRef.current) return
    const canvas = canvasRef.current!
    const { cx, cy } = canvasToCoords(e)
    const dx = cx - dragRef.current.startX
    const dy = cy - dragRef.current.startY
    if (!dragRef.current.moved && Math.hypot(dx, dy) < 4) return
    dragRef.current.moved = true

    const HIT = canvas.height - 110
    const LANE_W = canvas.width / 5
    const newLane = Math.max(0, Math.min(4, Math.floor(cx / LANE_W)))
    const targetSec = currentTime + (HIT - cy) / scrollSpeed
    const targetTickRaw = Math.max(0, (targetSec * chart.bpm * chart.resolution) / 60)
    const snapTicks = Math.max(1, Math.round(chart.resolution / snapDivisor))
    const newTick = Math.round(targetTickRaw / snapTicks) * snapTicks

    const idx = dragRef.current.id
    const orig = chart.notes[idx]
    if (!orig) return
    if (orig.tick === newTick && orig.lane === newLane) return
    const next = [...chart.notes]
    next[idx] = { ...orig, tick: newTick, lane: newLane }
    setChart({ ...chart, notes: next })
    setDirty(true)
  }

  const handleMouseUp = () => {
    dragRef.current = null
  }

  // Keyboard
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!chart) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return
      if (e.code === 'Space') {
        e.preventDefault()
        const a = audioRef.current
        if (a) { if (a.paused) a.play(); else a.pause() }
        return
      }
      if (selectedId === null) return
      const n = chart.notes[selectedId]
      if (!n) return
      const stepTicks = Math.max(1, Math.round(chart.resolution / snapDivisor))
      let updated: ChartNote | null = null
      if (e.key === 'ArrowLeft') updated = { ...n, tick: Math.max(0, n.tick - stepTicks) }
      else if (e.key === 'ArrowRight') updated = { ...n, tick: n.tick + stepTicks }
      else if (e.key === 'ArrowUp') updated = { ...n, lane: Math.min(4, n.lane + 1) }
      else if (e.key === 'ArrowDown') updated = { ...n, lane: Math.max(0, n.lane - 1) }
      else if (e.key === 'h' || e.key === 'H') updated = { ...n, sustain: n.sustain > 0 ? 0 : chart.resolution }
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        const next = chart.notes.filter((_, i) => i !== selectedId)
        setChart({ ...chart, notes: next })
        setSelectedId(null)
        setDirty(true)
        return
      }
      if (updated) {
        e.preventDefault()
        const next = [...chart.notes]
        next[selectedId] = updated
        setChart({ ...chart, notes: next })
        setDirty(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [chart, selectedId, snapDivisor])

  const switchDifficulty = (name: string) => {
    if (!chart || name === chart.activeName) return
    if (dirty && !window.confirm('Switch difficulty? Unsaved edits in this section will be kept in memory but you must Save to write them back.')) {
      return
    }
    const newFull = replaceSectionNotes(chart.fullText, chart.activeName, chart.notes)
    const newNotes = parseSectionNotes(newFull, name)
    setChart({ ...chart, fullText: newFull, activeName: name, notes: newNotes })
    setSelectedId(null)
  }

  const togglePlay = () => {
    const a = audioRef.current
    if (!a) return
    if (a.paused) a.play()
    else a.pause()
  }

  const handleSave = async () => {
    if (!chart) return
    setSaving(true)
    setSaveMsg('')
    try {
      const newFull = replaceSectionNotes(chart.fullText, chart.activeName, chart.notes)
      const res = await fetch(`/api/tracks/${trackId}/beatmaps/${beatmapId}/chart`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chart: newFull }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Save failed (${res.status})`)
      }
      setChart({ ...chart, fullText: newFull })
      setSaveMsg('Saved')
      setDirty(false)
      setTimeout(() => setSaveMsg(''), 2000)
    } catch (e) {
      setSaveMsg((e as Error).message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleClose = () => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return
    navigate(`/?id=${trackId}`)
  }

  const noteCount = chart?.notes.length ?? 0

  return (
    <div className="fixed inset-0 bg-black flex flex-col z-[60]">
      <header className="h-14 shrink-0 border-b border-gray-800 bg-gray-950 flex items-center px-4 gap-3">
        <button
          onClick={handleClose}
          className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-md text-sm font-medium transition-colors"
        >
          ← Back
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold text-gray-100 truncate">
            {meta?.name || (loadError ? 'Failed to load' : 'Beatmap editor')}
          </h1>
          <p className="text-xs text-gray-500 truncate">
            {chart
              ? `${chart.activeName} · ${noteCount} notes · ${chart.bpm.toFixed(1)} BPM · res ${chart.resolution}`
              : loadError
                ? `Error: ${loadError}`
                : 'Loading…'}
          </p>
        </div>
        {saveMsg && (
          <span className={`text-xs ${saveMsg === 'Saved' ? 'text-emerald-400' : 'text-red-400'}`}>{saveMsg}</span>
        )}
        <button
          onClick={handleSave}
          disabled={saving || !chart || !dirty}
          className="px-4 py-2 bg-jam-600 hover:bg-jam-500 disabled:opacity-40 text-white rounded-md text-sm font-medium transition-colors"
        >
          {saving ? 'Saving…' : dirty ? 'Save chart' : 'Saved'}
        </button>
      </header>

      <div className="flex-1 flex min-h-0">
        <div ref={containerRef} className="flex-1 relative bg-black min-w-0">
          <canvas
            ref={canvasRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            className="absolute inset-0 w-full h-full cursor-crosshair"
          />
        </div>

        <aside className="w-80 shrink-0 border-l border-gray-800 bg-gray-950 overflow-y-auto p-4 space-y-5">
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
              <span className="text-xs font-mono text-gray-400">
                {Math.floor(currentTime / 60)}:{Math.floor(currentTime % 60).toString().padStart(2, '0')}
                {' / '}
                {Math.floor(duration / 60)}:{Math.floor(duration % 60).toString().padStart(2, '0')}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.05}
              value={currentTime}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (audioRef.current) audioRef.current.currentTime = v
                setCurrentTime(v)
              }}
              className="w-full accent-jam-500"
            />
          </section>

          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Difficulty</h3>
            <select
              value={chart?.activeName || ''}
              onChange={(e) => switchDifficulty(e.target.value)}
              disabled={!chart || (chart?.availableSections.length ?? 0) === 0}
              className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-jam-500"
            >
              {chart && chart.availableSections.length === 0 && <option value="">(no sections)</option>}
              {chart?.availableSections.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            {chart && chart.availableSections.length > 1 && (
              <p className="text-[11px] text-gray-600 mt-1">
                Switching difficulty keeps in-memory edits — Save writes them all back.
              </p>
            )}
          </section>

          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Snap to grid</h3>
            <div className="grid grid-cols-4 gap-1">
              {SNAP_OPTIONS.map((opt) => (
                <button
                  key={opt.divisor}
                  onClick={() => setSnapDivisor(opt.divisor)}
                  className={`px-2 py-1.5 rounded text-xs font-medium transition-colors ${
                    snapDivisor === opt.divisor
                      ? 'bg-jam-600 text-white'
                      : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-gray-600 mt-1">
              Drag-to-move and arrow nudge snap to this beat fraction.
            </p>
          </section>

          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Scroll speed</h3>
            <input
              type="range"
              min={150}
              max={1200}
              step={25}
              value={scrollSpeed}
              onChange={(e) => setScrollSpeed(Number(e.target.value))}
              className="w-full accent-jam-500"
            />
            <span className="text-xs font-mono text-gray-500">{scrollSpeed} px/s</span>
          </section>

          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
              Lanes {isDrums && <span className="text-gray-600 normal-case font-normal">(5-lane drums)</span>}
            </h3>
            <ul className="space-y-1 text-xs">
              {laneLabels.map((label, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span
                    className="w-3 h-3 rounded-full inline-block shrink-0"
                    style={{ backgroundColor: LANE_FILL[i] }}
                  />
                  <span className="text-gray-200">{label}</span>
                  {isDrums && (
                    <span className="text-gray-600 text-[11px] font-mono ml-auto">{GUITAR_LABELS[i]}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Shortcuts</h3>
            <ul className="text-xs text-gray-400 space-y-1 leading-snug">
              <li><span className="font-mono text-gray-300">Click</span> select a note</li>
              <li><span className="font-mono text-gray-300">Drag</span> move note (snapped)</li>
              <li><span className="font-mono text-gray-300">←/→</span> nudge tick by snap</li>
              <li><span className="font-mono text-gray-300">↑/↓</span> change lane</li>
              <li><span className="font-mono text-gray-300">H</span> toggle hold/sustain</li>
              <li><span className="font-mono text-gray-300">Del</span> delete note</li>
              <li><span className="font-mono text-gray-300">Space</span> play/pause</li>
            </ul>
          </section>
        </aside>
      </div>

      <audio
        ref={audioRef}
        src={audioSrc}
        preload="metadata"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    </div>
  )
}
