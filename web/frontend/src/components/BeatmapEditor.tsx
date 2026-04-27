import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// .chart parsing ------------------------------------------------------------

interface ChartNote {
  tick: number
  lane: number       // 0-4 colored frets, 5 force-hopo, 6 tap, 7 open
  sustain: number    // sustain length in ticks (0 = single hit)
}

interface ParsedChart {
  resolution: number
  bpm: number               // first BPM in SyncTrack (millibpm/1000)
  bpmRaw: number            // raw "B" value (millibpm)
  songName: string
  rawBefore: string         // everything before the edited section
  difficulty: string        // section being edited e.g. ExpertSingle
  notes: ChartNote[]
  rawAfter: string          // everything after the edited section
}

const DIFFICULTY_PREFERENCE = ['ExpertSingle', 'HardSingle', 'MediumSingle', 'EasySingle']

function parseChart(text: string): ParsedChart {
  // Pull Resolution and the first SyncTrack BPM so we can convert ticks↔seconds
  const resMatch = text.match(/Resolution\s*=\s*(\d+)/)
  const resolution = resMatch ? Number(resMatch[1]) : 192
  const nameMatch = text.match(/Name\s*=\s*"([^"]*)"/)
  const songName = nameMatch ? nameMatch[1] : 'Untitled'
  const bpmMatch = text.match(/=\s*B\s+(\d+)/)
  const bpmRaw = bpmMatch ? Number(bpmMatch[1]) : 120000
  const bpm = bpmRaw / 1000

  // Find the first available difficulty section
  let difficulty = ''
  for (const d of DIFFICULTY_PREFERENCE) {
    const idx = text.indexOf(`[${d}]`)
    if (idx !== -1) { difficulty = d; break }
  }
  if (!difficulty) {
    return { resolution, bpm, bpmRaw, songName, rawBefore: text, difficulty: '', notes: [], rawAfter: '' }
  }

  const headerStart = text.indexOf(`[${difficulty}]`)
  const openBrace = text.indexOf('{', headerStart)
  const closeBrace = text.indexOf('}', openBrace)
  const before = text.slice(0, openBrace + 1)
  const inner = text.slice(openBrace + 1, closeBrace)
  const after = text.slice(closeBrace)

  const notes: ChartNote[] = []
  for (const raw of inner.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = line.match(/^(\d+)\s*=\s*N\s+(\d+)\s+(\d+)/)
    if (m) {
      notes.push({ tick: Number(m[1]), lane: Number(m[2]), sustain: Number(m[3]) })
    }
  }

  return {
    resolution,
    bpm,
    bpmRaw,
    songName,
    rawBefore: before,
    difficulty,
    notes,
    rawAfter: after,
  }
}

function serializeChart(parsed: ParsedChart): string {
  const sorted = [...parsed.notes].sort((a, b) => a.tick - b.tick || a.lane - b.lane)
  const lines = sorted.map((n) => `  ${n.tick} = N ${n.lane} ${n.sustain}`)
  return parsed.rawBefore + '\n' + lines.join('\n') + '\n' + parsed.rawAfter
}

function tickToSeconds(tick: number, bpm: number, resolution: number): number {
  return (tick / resolution) * (60 / bpm)
}

// Lane colors (Guitar Hero) -------------------------------------------------

const LANE_FILL = ['#22c55e', '#ef4444', '#eab308', '#3b82f6', '#f97316'] // 0-4
const LANE_NAME = ['Green', 'Red', 'Yellow', 'Blue', 'Orange']

// Component -----------------------------------------------------------------

interface Props {
  trackId: string
  beatmapId: string
  beatmapName: string
  onClose: () => void
}

export default function BeatmapEditor({ trackId, beatmapId, beatmapName, onClose }: Props) {
  const [chart, setChart] = useState<ParsedChart | null>(null)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [dirty, setDirty] = useState(false)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [scrollSpeed, setScrollSpeed] = useState(450) // px/sec
  const [selectedId, setSelectedId] = useState<number | null>(null)

  // Note ids are stable references — we need to track edits.
  // Easier: use index as id since we re-derive from `chart.notes` each render.
  const audioSrc = `/api/tracks/${trackId}/beatmaps/${beatmapId}/download/song.ogg`

  useEffect(() => {
    fetch(`/api/tracks/${trackId}/beatmaps/${beatmapId}/chart`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((data) => setChart(parseChart(data.chart)))
      .catch((e) => setLoadError((e as Error).message))
  }, [trackId, beatmapId])

  // Audio sync via rAF
  useEffect(() => {
    let raf: number
    const tick = () => {
      const a = audioRef.current
      if (a) setCurrentTime(a.currentTime)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Canvas drawing
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !chart) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const W = canvas.width
    const H = canvas.height
    const HIT = H - 80
    const NUM_LANES = 5
    const LANE_W = W / NUM_LANES
    const NOTE_R = LANE_W * 0.35

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

    // Tick → seconds helper
    const t2s = (tick: number) => tickToSeconds(tick, chart.bpm, chart.resolution)

    // Draw notes — lane 0-4 only for the runway (open / hopo are decorative for now)
    for (let i = 0; i < chart.notes.length; i++) {
      const n = chart.notes[i]
      if (n.lane > 4) continue
      const noteSec = t2s(n.tick)
      const dy = (noteSec - currentTime) * scrollSpeed
      const y = HIT - dy
      if (y < -100 || y > H + 100) continue

      const x = (n.lane + 0.5) * LANE_W

      // Sustain tail
      if (n.sustain > 0) {
        const sustainSec = t2s(n.sustain)
        const tailLength = sustainSec * scrollSpeed
        const tailTopY = y - tailLength
        ctx.fillStyle = LANE_FILL[n.lane] + '88'
        ctx.fillRect(x - LANE_W * 0.1, tailTopY, LANE_W * 0.2, tailLength)
      }

      // Note head
      const isSelected = selectedId === i
      ctx.beginPath()
      ctx.arc(x, y, NOTE_R, 0, Math.PI * 2)
      ctx.fillStyle = LANE_FILL[n.lane]
      ctx.fill()
      ctx.lineWidth = isSelected ? 4 : 2
      ctx.strokeStyle = isSelected ? '#ffffff' : '#000000'
      ctx.stroke()
    }

    // Lane labels at bottom
    ctx.fillStyle = '#6b7280'
    ctx.font = '11px monospace'
    ctx.textAlign = 'center'
    for (let lane = 0; lane < NUM_LANES; lane++) {
      ctx.fillText(LANE_NAME[lane], (lane + 0.5) * LANE_W, H - 12)
    }

    // Time + selection readout
    ctx.fillStyle = '#9ca3af'
    ctx.font = '12px monospace'
    ctx.textAlign = 'left'
    const fmt = (t: number) =>
      `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, '0')}.${Math.floor((t % 1) * 100).toString().padStart(2, '0')}`
    ctx.fillText(`t = ${fmt(currentTime)}`, 10, 20)
    if (selectedId !== null && chart.notes[selectedId]) {
      const sel = chart.notes[selectedId]
      ctx.fillText(
        `selected: lane ${sel.lane} (${LANE_NAME[sel.lane] ?? '?'}) tick ${sel.tick} sustain ${sel.sustain}`,
        10,
        40,
      )
    } else {
      ctx.fillText('click a note to select', 10, 40)
    }
  }, [chart, currentTime, scrollSpeed, selectedId])

  useEffect(() => {
    let raf: number
    const loop = () => {
      draw()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [draw])

  // Click on canvas to select a note
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas || !chart) return
    const rect = canvas.getBoundingClientRect()
    const cx = ((e.clientX - rect.left) / rect.width) * canvas.width
    const cy = ((e.clientY - rect.top) / rect.height) * canvas.height
    const HIT = canvas.height - 80
    const LANE_W = canvas.width / 5
    const lane = Math.floor(cx / LANE_W)
    if (lane < 0 || lane > 4) return

    let bestId: number | null = null
    let bestDist = 30 // px tolerance
    for (let i = 0; i < chart.notes.length; i++) {
      const n = chart.notes[i]
      if (n.lane !== lane) continue
      const noteSec = tickToSeconds(n.tick, chart.bpm, chart.resolution)
      const y = HIT - (noteSec - currentTime) * scrollSpeed
      const dist = Math.abs(y - cy)
      if (dist < bestDist) {
        bestDist = dist
        bestId = i
      }
    }
    setSelectedId(bestId)
  }

  // Keyboard editing
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!chart) return
      // Space to play/pause regardless of selection
      if (e.code === 'Space' && (e.target as HTMLElement)?.tagName !== 'INPUT') {
        e.preventDefault()
        const a = audioRef.current
        if (a) {
          if (a.paused) a.play()
          else a.pause()
        }
        return
      }
      if (selectedId === null) return
      const n = chart.notes[selectedId]
      if (!n) return
      const stepTicks = chart.resolution / 8 // 1/32 of a beat resolution unit (small step)
      let updated: ChartNote | null = null
      if (e.key === 'ArrowLeft') updated = { ...n, tick: Math.max(0, n.tick - stepTicks) }
      else if (e.key === 'ArrowRight') updated = { ...n, tick: n.tick + stepTicks }
      else if (e.key === 'ArrowUp') updated = { ...n, lane: Math.min(4, n.lane + 1) }
      else if (e.key === 'ArrowDown') updated = { ...n, lane: Math.max(0, n.lane - 1) }
      else if (e.key === 'h' || e.key === 'H') {
        updated = { ...n, sustain: n.sustain > 0 ? 0 : chart.resolution } // toggle 1-beat hold
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
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
  }, [chart, selectedId])

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
      const text = serializeChart(chart)
      const res = await fetch(`/api/tracks/${trackId}/beatmaps/${beatmapId}/chart`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chart: text }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Save failed (${res.status})`)
      }
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
    onClose()
  }

  const noteCount = useMemo(() => chart?.notes.length ?? 0, [chart])

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-stretch justify-center p-4">
      <div ref={containerRef} className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-4xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 p-4 border-b border-gray-800">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-gray-100 truncate">{beatmapName}</h3>
            <p className="text-xs text-gray-500">
              {chart
                ? `${chart.difficulty} · ${noteCount} notes · ${chart.bpm.toFixed(1)} BPM · res ${chart.resolution}`
                : 'Loading…'}
            </p>
          </div>
          <button onClick={handleClose} className="text-gray-500 hover:text-gray-300 text-2xl leading-none">&times;</button>
        </div>

        {loadError && (
          <div className="m-4 bg-red-900/30 border border-red-800 rounded-lg p-3 text-sm text-red-400">{loadError}</div>
        )}

        {!loadError && (
          <div className="flex-1 flex flex-col min-h-0">
            {/* Canvas runway */}
            <div className="flex-1 flex items-center justify-center p-4 min-h-0">
              <canvas
                ref={canvasRef}
                width={400}
                height={520}
                onClick={handleCanvasClick}
                className="rounded-lg border border-gray-800 cursor-crosshair"
                style={{ maxHeight: '100%', maxWidth: '100%' }}
              />
            </div>

            {/* Transport */}
            <div className="px-4 py-2 border-t border-gray-800 space-y-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={togglePlay}
                  className="shrink-0 w-9 h-9 rounded-full bg-jam-600 hover:bg-jam-500 text-white flex items-center justify-center text-sm"
                  aria-label={playing ? 'Pause' : 'Play'}
                >
                  {playing ? '❚❚' : '▶'}
                </button>
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
                  className="flex-1 accent-jam-500"
                />
                <span className="text-xs font-mono text-gray-400 shrink-0">
                  {Math.floor(currentTime / 60)}:{Math.floor(currentTime % 60).toString().padStart(2, '0')}
                  {' / '}
                  {Math.floor(duration / 60)}:{Math.floor(duration % 60).toString().padStart(2, '0')}
                </span>
              </div>

              <div className="flex items-center gap-3 text-xs">
                <label className="flex items-center gap-2 text-gray-400">
                  Scroll speed
                  <input
                    type="range"
                    min={150}
                    max={1000}
                    step={25}
                    value={scrollSpeed}
                    onChange={(e) => setScrollSpeed(Number(e.target.value))}
                    className="accent-jam-500"
                  />
                  <span className="font-mono text-gray-500 w-12 text-right">{scrollSpeed} px/s</span>
                </label>
              </div>
            </div>

            {/* Action bar */}
            <div className="px-4 py-3 border-t border-gray-800 flex flex-wrap items-center gap-2">
              <span className="text-xs text-gray-500 mr-2">
                Click a note to select. <span className="font-mono">←/→</span> tick · <span className="font-mono">↑/↓</span> lane · <span className="font-mono">H</span> hold · <span className="font-mono">Del</span> delete · <span className="font-mono">Space</span> play.
              </span>
              <div className="ml-auto flex items-center gap-2">
                {saveMsg && (
                  <span className={`text-xs ${saveMsg === 'Saved' ? 'text-emerald-400' : 'text-red-400'}`}>
                    {saveMsg}
                  </span>
                )}
                <button
                  onClick={handleSave}
                  disabled={saving || !dirty}
                  className="px-4 py-2 bg-jam-600 hover:bg-jam-500 disabled:opacity-40 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  {saving ? 'Saving…' : dirty ? 'Save chart' : 'No changes'}
                </button>
              </div>
            </div>
          </div>
        )}

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
    </div>
  )
}
