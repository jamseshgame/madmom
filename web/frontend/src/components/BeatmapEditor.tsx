import {
  SceneEvent, SceneFlags,
  applySceneToFullText, parseSceneEvents, parseSceneFlags,
} from './sceneEvents'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

// .chart parsing ------------------------------------------------------------

interface ChartNote {
  tick: number
  lane: number       // 0-4 colored frets, 5 force-hopo, 6 tap, 7 open
  sustain: number    // sustain length in ticks (0 = single hit)
}

// Tutorial-mode events sit in their own [TutorialScript] section in the
// chart. VOs are timestamped audio playback prompts; STEPs declare a
// pass/fail boundary with optional retry semantics. Both are draggable on
// the runway just like notes.
type TimingMode = 'any' | 'perfect'

interface TutorialVoEvent {
  kind: 'vo'
  id: string             // ephemeral, not persisted (regenerated per parse)
  tick: number
  file: string           // relative path under the beatmap dir, e.g. "vo/abc.ogg"
  text: string           // optional draft text used to (re)generate the clip
}

interface TutorialStepEvent {
  kind: 'step'
  id: string
  tick: number
  stepId: string         // user-facing identifier, e.g. "intro" or "chord_drill"
  required: number       // notes the player must hit to pass; 0 = no gate
  timing: TimingMode     // 'any' counts every hit, 'perfect' only perfects
  retryVo: string        // optional VO file played on fail
  next: string           // step id to jump to on pass; empty = end-of-tutorial
}

interface TutorialMusicEvent {
  kind: 'music'
  id: string
  tick: number             // parent-chart tick where the segment activates
  file: string             // relative path under the beatmap dir, e.g. "segments/abc.ogg"
  sectionName: string      // chart section that holds this segment's notes (e.g. "MusicSeg_abc")
  bpm: number              // segment's own BPM (notes are timed against this)
  resolution: number       // segment's tick resolution (usually 192)
  durationSeconds: number  // clip duration, used for visual band length on runway
  notesCount: number       // generated note count (display only)
  required: number
  timing: TimingMode
  retryVo: string
  next: string
}

type TutorialEvent = TutorialVoEvent | TutorialStepEvent | TutorialMusicEvent

interface ChartState {
  fullText: string
  resolution: number
  bpm: number
  bpmRaw: number
  songName: string
  availableSections: string[]
  activeName: string
  notes: ChartNote[]
  tutorialEnabled: boolean
  tutorial: TutorialEvent[]
  // Body text of every [MusicSeg_*] section. Keyed by section name; values
  // are the verbatim inner block (no braces). Round-tripped on save so
  // segment notes survive even though we don't edit them inline.
  musicSections: Record<string, string>
  sceneFlags: SceneFlags
  sceneFlagsUnknown: Record<string, string>
  sceneEvents: SceneEvent[]
  sceneEventsPassthrough: string[]
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

// ── Tutorial section parsing ────────────────────────────────────────────────
// The chart-side schema is intentionally simple: every line in [TutorialScript]
// looks like `<tick> = STEP|VO <args>`. STEP lines carry id + pass/fail
// fields as key=value; VO lines carry a file path and an optional draft text.
//
// Examples:
//   192 = STEP "intro" required=5 timing=any retry_vo="vo/retry.ogg" next="chord_drill"
//   384 = VO "vo/intro.ogg" text="Welcome to the tutorial."

function _shellSplit(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      inQuote = !inQuote
      continue
    }
    if (!inQuote && /\s/.test(ch)) {
      if (cur) { out.push(cur); cur = '' }
      continue
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

function hasTutorialSection(text: string): boolean {
  return /\[TutorialScript\]\s*\{[^}]*\}/.test(text)
}

function parseTutorialSection(text: string): TutorialEvent[] {
  const m = text.match(/\[TutorialScript\]\s*\{([^}]*)\}/)
  if (!m) return []
  const body = m[1]
  const events: TutorialEvent[] = []
  let counter = 0
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/^\s*;.*$/, '').trim()
    if (!line) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const tick = Number(line.slice(0, eq).trim())
    if (!Number.isFinite(tick)) continue
    const tail = line.slice(eq + 1).trim()
    const tokens = _shellSplit(tail)
    if (tokens.length === 0) continue
    const kind = tokens[0].toUpperCase()
    if (kind === 'VO') {
      const file = tokens[1] || ''
      let textArg = ''
      for (const t of tokens.slice(2)) {
        if (t.startsWith('text=')) textArg = t.slice(5)
      }
      events.push({
        kind: 'vo',
        id: `vo-${tick}-${counter++}`,
        tick,
        file,
        text: textArg,
      })
    } else if (kind === 'STEP') {
      const stepId = tokens[1] || ''
      const fields: Record<string, string> = {}
      for (const t of tokens.slice(2)) {
        const ix = t.indexOf('=')
        if (ix > 0) fields[t.slice(0, ix)] = t.slice(ix + 1)
      }
      const timing: TimingMode = fields.timing === 'perfect' ? 'perfect' : 'any'
      events.push({
        kind: 'step',
        id: `step-${tick}-${counter++}`,
        tick,
        stepId,
        required: Number(fields.required || 0) || 0,
        timing,
        retryVo: fields.retry_vo || '',
        next: fields.next || '',
      })
    } else if (kind === 'MUSIC') {
      const file = tokens[1] || ''
      const fields: Record<string, string> = {}
      for (const t of tokens.slice(2)) {
        const ix = t.indexOf('=')
        if (ix > 0) fields[t.slice(0, ix)] = t.slice(ix + 1)
      }
      const timing: TimingMode = fields.timing === 'perfect' ? 'perfect' : 'any'
      events.push({
        kind: 'music',
        id: `music-${tick}-${counter++}`,
        tick,
        file,
        sectionName: fields.section || '',
        bpm: Number(fields.bpm) || 120,
        resolution: Number(fields.resolution) || 192,
        durationSeconds: Number(fields.duration) || 0,
        notesCount: Number(fields.notes) || 0,
        required: Number(fields.required || 0) || 0,
        timing,
        retryVo: fields.retry_vo || '',
        next: fields.next || '',
      })
    }
  }
  return events.sort((a, b) => a.tick - b.tick)
}

function parseMusicSections(text: string): Record<string, string> {
  const re = /\[(MusicSeg_[A-Za-z0-9_-]+)\]\s*\{([^}]*)\}/g
  const out: Record<string, string> = {}
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out[m[1]] = m[2]
  }
  return out
}

function serializeTutorialSection(events: TutorialEvent[]): string {
  if (events.length === 0) return ''
  const sorted = [...events].sort((a, b) => a.tick - b.tick)
  const lines = sorted.map((e) => {
    if (e.kind === 'vo') {
      const t = e.text ? ` text="${e.text.replace(/"/g, "'")}"` : ''
      return `  ${e.tick} = VO "${e.file}"${t}`
    }
    if (e.kind === 'step') {
      return (
        `  ${e.tick} = STEP "${e.stepId}" required=${e.required} timing=${e.timing}`
        + (e.retryVo ? ` retry_vo="${e.retryVo}"` : '')
        + (e.next ? ` next="${e.next}"` : '')
      )
    }
    // music
    return (
      `  ${e.tick} = MUSIC "${e.file}" section="${e.sectionName}"`
      + ` bpm=${e.bpm.toFixed(2)} resolution=${e.resolution}`
      + ` duration=${e.durationSeconds.toFixed(2)} notes=${e.notesCount}`
      + ` required=${e.required} timing=${e.timing}`
      + (e.retryVo ? ` retry_vo="${e.retryVo}"` : '')
      + (e.next ? ` next="${e.next}"` : '')
    )
  })
  return `[TutorialScript]\n{\n${lines.join('\n')}\n}\n`
}

function serializeMusicSections(sections: Record<string, string>, events: TutorialEvent[]): string {
  // Only emit sections referenced by an active MUSIC event, so deleting an
  // event also drops its body on save instead of leaving orphans behind.
  const referenced = new Set(
    events.filter((e): e is TutorialMusicEvent => e.kind === 'music').map((e) => e.sectionName),
  )
  const blocks: string[] = []
  for (const [name, body] of Object.entries(sections)) {
    if (!referenced.has(name)) continue
    blocks.push(`[${name}]\n{${body}}\n`)
  }
  return blocks.join('')
}

function applyTutorialToFullText(
  fullText: string,
  events: TutorialEvent[],
  enabled: boolean,
  musicSections: Record<string, string>,
): string {
  // Strip both [TutorialScript] and any [MusicSeg_*] sections — we re-emit
  // them from the in-memory state so they stay in sync.
  let stripped = fullText.replace(/\[TutorialScript\]\s*\{[^}]*\}\s*/g, '')
  stripped = stripped.replace(/\[MusicSeg_[A-Za-z0-9_-]+\]\s*\{[^}]*\}\s*/g, '')
  if (!enabled || events.length === 0) return stripped
  const newSection = serializeTutorialSection(events)
  const musicBlocks = serializeMusicSections(musicSections, events)
  return stripped.trimEnd() + '\n' + newSection + (musicBlocks ? musicBlocks : '')
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
  const tutorial = parseTutorialSection(text)
  const musicSections = parseMusicSections(text)
  const scene = parseSceneFlags(text)
  const sceneEventsParsed = parseSceneEvents(text)
  // Pre-flip tutorial mode on whenever the chart already carries a
  // [TutorialScript] section (even an empty one). The blank-tutorial flow
  // and the empty-beatmap-with-tutorial flow both emit an empty section
  // for exactly this reason — so the user doesn't have to tick the
  // sidebar checkbox before adding their first VO/STEP.
  const tutorialEnabled = tutorial.length > 0 || hasTutorialSection(text)
  return {
    fullText: text, resolution, bpm, bpmRaw, songName,
    availableSections, activeName, notes,
    tutorialEnabled, tutorial, musicSections,
    sceneFlags: scene.flags,
    sceneFlagsUnknown: scene.unknownKeys,
    sceneEvents: sceneEventsParsed.events,
    sceneEventsPassthrough: sceneEventsParsed.passthroughLines,
  }
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

// ── TutorialTimeline ────────────────────────────────────────────────────────
// Horizontal strip in the editor header showing every tutorial event as a
// colour-coded block over the song's full duration. Zoomable via wheel,
// scrubbable by clicking the track, blocks draggable to reposition tick.
//
// Events are rendered in three layers visually:
//   • MUSIC (orange) — wide, spans the segment's clip duration
//   • STEP  (purple) — full-height marker with a flag icon
//   • VO    (cyan)   — full-height marker with a ▶ icon

interface TimelineProps {
  duration: number
  currentTime: number
  bpm: number
  resolution: number
  events: TutorialEvent[]
  snapDivisor: number
  onSeek: (sec: number) => void
  onMoveEvent: (id: string, tick: number) => void
}

function TutorialTimeline({
  duration,
  currentTime,
  bpm,
  resolution,
  events,
  snapDivisor,
  onSeek,
  onMoveEvent,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  const [view, setView] = useState({ start: 0, end: Math.max(duration, 1) })
  const dragRef = useRef<{ id: string; offset: number; lastTick: number } | null>(null)
  const [scrubbing, setScrubbing] = useState(false)

  // Sync view to duration whenever it changes (e.g. song.ogg loaded)
  useEffect(() => {
    setView((v) => {
      const realEnd = Math.max(duration, 1)
      // If we'd previously fit the whole song, keep showing the whole song.
      if (v.end <= 0 || v.end > realEnd || (v.start === 0 && v.end <= realEnd && Math.abs((v.end - v.start) - realEnd) < 0.01)) {
        return { start: 0, end: realEnd }
      }
      return v
    })
  }, [duration])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setWidth(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const span = Math.max(0.001, view.end - view.start)
  const tickToSec = (t: number) => (t / resolution) * (60 / bpm)
  const secToTick = (s: number) => Math.max(0, Math.round((s * bpm * resolution) / 60))
  const secToX = (s: number) => ((s - view.start) / span) * width
  const xToSec = (x: number) => view.start + (x / Math.max(1, width)) * span

  const handleClickTrack = (e: React.MouseEvent) => {
    const rect = containerRef.current!.getBoundingClientRect()
    onSeek(Math.max(0, Math.min(duration, xToSec(e.clientX - rect.left))))
  }

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const rect = containerRef.current!.getBoundingClientRect()
    const cursorSec = xToSec(e.clientX - rect.left)
    if (e.shiftKey) {
      // Shift+wheel → pan
      const delta = (e.deltaY / 200) * span
      let s = view.start + delta
      let en = view.end + delta
      if (s < 0) { en -= s; s = 0 }
      if (en > duration) { s -= en - duration; en = duration }
      setView({ start: Math.max(0, s), end: Math.min(duration, en) })
      return
    }
    // Wheel → zoom around cursor
    const factor = e.deltaY > 0 ? 1.25 : 0.8
    const newSpan = Math.max(1.0, Math.min(duration, span * factor))
    const ratio = (cursorSec - view.start) / span
    const newStart = Math.max(0, Math.min(duration - newSpan, cursorSec - ratio * newSpan))
    setView({ start: newStart, end: newStart + newSpan })
  }

  // Drag a block to reposition its tick. Listens at document level so the
  // pointer can leave the strip without losing the drag.
  useEffect(() => {
    if (!dragRef.current && !scrubbing) return
    const move = (ev: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const sec = xToSec(ev.clientX - rect.left)
      if (scrubbing) {
        onSeek(Math.max(0, Math.min(duration, sec)))
        return
      }
      if (!dragRef.current) return
      const targetSec = sec - dragRef.current.offset
      const rawTick = secToTick(Math.max(0, targetSec))
      const snapTicks = Math.max(1, Math.round(resolution / snapDivisor))
      const snapped = Math.round(rawTick / snapTicks) * snapTicks
      if (snapped !== dragRef.current.lastTick) {
        dragRef.current.lastTick = snapped
        onMoveEvent(dragRef.current.id, snapped)
      }
    }
    const up = () => {
      dragRef.current = null
      setScrubbing(false)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
    return () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubbing, view.start, view.end, width, duration, resolution, snapDivisor, bpm])

  // Beat-line ticks: draw a light line every beat when there's room.
  const beatSpacingSec = 60 / Math.max(1, bpm)
  const visibleBeats = Math.ceil(span / beatSpacingSec)
  const beatStride = visibleBeats > 80 ? Math.ceil(visibleBeats / 80) : 1

  // Time-labels stride (whole seconds, picked so labels don't overlap)
  const desiredLabelSpacingPx = 70
  const desiredLabelSpacingSec = desiredLabelSpacingPx * (span / Math.max(1, width))
  const labelStrides = [1, 2, 5, 10, 15, 30, 60, 120, 300]
  const labelStride = labelStrides.find((s) => s >= desiredLabelSpacingSec) || 600

  const fmtSec = (s: number) => {
    const m = Math.floor(s / 60)
    const ss = Math.floor(s % 60)
    return `${m}:${ss.toString().padStart(2, '0')}`
  }

  // Sort so MUSIC blocks render first (under), then STEP, then VO (on top)
  const ordered = [...events].sort((a, b) => {
    const w = (e: TutorialEvent) => (e.kind === 'music' ? 0 : e.kind === 'step' ? 1 : 2)
    return w(a) - w(b)
  })

  return (
    <div
      ref={containerRef}
      className="relative h-full bg-gray-950 border border-gray-800 rounded overflow-hidden select-none cursor-crosshair"
      onMouseDown={(e) => {
        // mousedown on track (not on a block) → seek + start scrubbing
        if ((e.target as HTMLElement).dataset?.block) return
        const rect = containerRef.current!.getBoundingClientRect()
        onSeek(Math.max(0, Math.min(duration, xToSec(e.clientX - rect.left))))
        setScrubbing(true)
      }}
      onClick={handleClickTrack}
      onWheel={handleWheel}
      title="Wheel to zoom · Shift+wheel to pan · click to seek · drag a block to move"
    >
      {/* beat grid */}
      {Array.from({ length: visibleBeats + 2 }).map((_, i) => {
        const beatIndex = Math.floor(view.start / beatSpacingSec) + i
        if (beatIndex < 0 || beatIndex % beatStride !== 0) return null
        const sec = beatIndex * beatSpacingSec
        const x = secToX(sec)
        if (x < -2 || x > width + 2) return null
        const isBar = beatIndex % 4 === 0
        return (
          <div
            key={beatIndex}
            className={isBar ? 'absolute top-0 bottom-0 w-px bg-gray-800' : 'absolute top-0 bottom-0 w-px bg-gray-900'}
            style={{ left: x }}
          />
        )
      })}

      {/* time labels */}
      {Array.from({ length: Math.ceil(span / labelStride) + 2 }).map((_, i) => {
        const s = Math.floor(view.start / labelStride) * labelStride + i * labelStride
        if (s < 0 || s > duration) return null
        const x = secToX(s)
        if (x < -10 || x > width + 10) return null
        return (
          <div
            key={s}
            className="absolute top-0 text-[9px] text-gray-600 font-mono px-0.5 pointer-events-none"
            style={{ left: x + 1 }}
          >
            {fmtSec(s)}
          </div>
        )
      })}

      {/* event blocks */}
      {ordered.map((ev) => {
        const startSec = tickToSec(ev.tick)
        const x = secToX(startSec)
        if (ev.kind === 'music') {
          const w = Math.max(8, secToX(startSec + ev.durationSeconds) - x)
          if (x + w < -10 || x > width + 10) return null
          return (
            <div
              key={ev.id}
              data-block="1"
              className="absolute top-3 h-[calc(100%-12px)] bg-orange-700/50 hover:bg-orange-600/70 border border-orange-500/70 rounded text-[10px] text-orange-100 font-medium overflow-hidden cursor-grab active:cursor-grabbing"
              style={{ left: x, width: w }}
              onMouseDown={(e) => {
                e.stopPropagation()
                const rect = containerRef.current!.getBoundingClientRect()
                const offset = xToSec(e.clientX - rect.left) - startSec
                dragRef.current = { id: ev.id, offset, lastTick: ev.tick }
              }}
              onClick={(e) => {
                e.stopPropagation()
                onSeek(startSec)
              }}
              title={`MUSIC ${ev.file.split('/').pop()} · ${ev.notesCount} notes · ${ev.durationSeconds.toFixed(1)}s`}
            >
              <span className="px-1 truncate inline-block w-full leading-tight">♪ {(ev.file.split('/').pop() || 'music')}</span>
            </div>
          )
        }
        if (ev.kind === 'step') {
          if (x < -10 || x > width + 10) return null
          return (
            <div
              key={ev.id}
              data-block="1"
              className="absolute top-3 h-[calc(100%-12px)] flex items-center cursor-grab active:cursor-grabbing"
              style={{ left: x - 1, width: 2 }}
              onMouseDown={(e) => {
                e.stopPropagation()
                const rect = containerRef.current!.getBoundingClientRect()
                const offset = xToSec(e.clientX - rect.left) - startSec
                dragRef.current = { id: ev.id, offset, lastTick: ev.tick }
              }}
              onClick={(e) => {
                e.stopPropagation()
                onSeek(startSec)
              }}
              title={`STEP "${ev.stepId}" · ${ev.required} ${ev.timing}`}
            >
              <div className="absolute inset-0 bg-purple-500" />
              <span
                data-block="1"
                className="absolute -top-0.5 -translate-x-1/2 text-[10px] text-purple-200 font-medium bg-purple-700/90 border border-purple-500 rounded px-1 py-0.5 leading-none whitespace-nowrap pointer-events-auto"
              >
                ⚑ {ev.stepId || 'step'}
              </span>
            </div>
          )
        }
        // vo
        if (x < -10 || x > width + 10) return null
        return (
          <div
            key={ev.id}
            data-block="1"
            className="absolute top-3 h-[calc(100%-12px)] cursor-grab active:cursor-grabbing"
            style={{ left: x - 1, width: 2 }}
            onMouseDown={(e) => {
              e.stopPropagation()
              const rect = containerRef.current!.getBoundingClientRect()
              const offset = xToSec(e.clientX - rect.left) - startSec
              dragRef.current = { id: ev.id, offset, lastTick: ev.tick }
            }}
            onClick={(e) => {
              e.stopPropagation()
              onSeek(startSec)
            }}
            title={`VO ${ev.file || ''}${ev.text ? ' · ' + ev.text : ''}`}
          >
            <div className="absolute inset-0 bg-sky-400" />
            <span
              data-block="1"
              className="absolute -top-0.5 -translate-x-1/2 text-[10px] text-sky-100 font-medium bg-sky-700/90 border border-sky-500 rounded px-1 py-0.5 leading-none whitespace-nowrap pointer-events-auto"
            >
              ▶ {ev.text ? ev.text.slice(0, 14) : 'vo'}
            </span>
          </div>
        )
      })}

      {/* playhead */}
      <div
        className="absolute top-0 bottom-0 w-px bg-jam-400 pointer-events-none"
        style={{ left: secToX(currentTime), boxShadow: '0 0 4px rgba(168, 85, 247, 0.6)' }}
      />

      {/* zoom hint when fully zoomed out */}
      {span >= duration - 0.5 && (
        <div className="absolute bottom-0.5 right-1 text-[9px] text-gray-600 pointer-events-none font-mono">
          full song · scroll to zoom
        </div>
      )}
    </div>
  )
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
  // VO audio playback during transport. Each VO with a non-empty `file` gets
  // its own HTMLAudioElement preloaded into voAudiosRef. firedVosRef tracks
  // which ones have already been triggered in the current play pass — reset
  // on any meaningful seek so a VO can replay if you scrub back over it.
  const voAudiosRef = useRef<Map<string, HTMLAudioElement>>(new Map())
  const firedVosRef = useRef<Set<string>>(new Set())
  const lastSampleTimeRef = useRef(0)
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

    // Tutorial events (drawn beneath notes so notes stay legible)
    if (chart.tutorialEnabled) {
      // STEP boundaries — full-width horizontal stripe with a label.
      ctx.font = '10px monospace'
      ctx.textAlign = 'left'
      for (const ev of chart.tutorial) {
        if (ev.kind !== 'step') continue
        const y = HIT - (t2s(ev.tick) - currentTime) * scrollSpeed
        if (y < -40 || y > H + 20) continue
        ctx.fillStyle = 'rgba(168, 85, 247, 0.10)'
        ctx.fillRect(0, y - 12, W, 14)
        ctx.strokeStyle = 'rgba(168, 85, 247, 0.55)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(W, y)
        ctx.stroke()
        ctx.fillStyle = '#c4b5fd'
        const tag = `STEP ${ev.stepId || '?'} · ${ev.required || 0} ${ev.timing}`
        ctx.fillText(tag, 6, y - 2)
      }
      // MUSIC segments — orange band spanning the segment's duration
      for (const ev of chart.tutorial) {
        if (ev.kind !== 'music') continue
        const yStart = HIT - (t2s(ev.tick) - currentTime) * scrollSpeed
        const bandHeight = Math.max(8, ev.durationSeconds * scrollSpeed)
        const yTop = yStart - bandHeight
        if (yStart < -40 || yTop > H + 40) continue
        ctx.fillStyle = 'rgba(249, 115, 22, 0.13)'
        ctx.fillRect(0, yTop, W, bandHeight)
        ctx.strokeStyle = 'rgba(249, 115, 22, 0.55)'
        ctx.lineWidth = 1
        ctx.strokeRect(0.5, yTop + 0.5, W - 1, bandHeight - 1)
        ctx.fillStyle = '#fdba74'
        ctx.font = 'bold 10px sans-serif'
        ctx.textAlign = 'left'
        const filename = ev.file.split('/').pop() || ev.file
        ctx.fillText(`♪ MUSIC ${filename}`, 6, yTop + 12)
        ctx.fillStyle = '#fb923c'
        ctx.font = '10px monospace'
        ctx.fillText(
          `${ev.notesCount} notes · ${ev.bpm.toFixed(0)} BPM · ${ev.required} ${ev.timing}`,
          6, yTop + 24,
        )
      }

      // VOs — left-edge ▶ icon + thin line across the runway
      for (const ev of chart.tutorial) {
        if (ev.kind !== 'vo') continue
        const y = HIT - (t2s(ev.tick) - currentTime) * scrollSpeed
        if (y < -20 || y > H + 20) continue
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)'
        ctx.setLineDash([4, 3])
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(W, y)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = '#38bdf8'
        ctx.font = 'bold 11px sans-serif'
        ctx.textAlign = 'left'
        ctx.fillText('▶', 4, y + 4)
        if (ev.text) {
          ctx.font = '10px sans-serif'
          ctx.fillStyle = '#7dd3fc'
          ctx.fillText(ev.text.slice(0, 50), 18, y + 4)
        }
      }
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
    let newFull = replaceSectionNotes(chart.fullText, chart.activeName, chart.notes)
    newFull = applyTutorialToFullText(newFull, chart.tutorial, chart.tutorialEnabled, chart.musicSections)
    newFull = applySceneToFullText(
      newFull,
      chart.sceneFlags,
      chart.sceneFlagsUnknown,
      chart.sceneEvents,
      chart.sceneEventsPassthrough,
    )
    const newNotes = parseSectionNotes(newFull, name)
    // Tutorial section is shared across difficulties — just keep current state.
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
      let newFull = replaceSectionNotes(chart.fullText, chart.activeName, chart.notes)
      newFull = applyTutorialToFullText(newFull, chart.tutorial, chart.tutorialEnabled, chart.musicSections)
      newFull = applySceneToFullText(
        newFull,
        chart.sceneFlags,
        chart.sceneFlagsUnknown,
        chart.sceneEvents,
        chart.sceneEventsPassthrough,
      )
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

  // ── Tutorial editing helpers ──────────────────────────────────────────────
  const updateTutorial = (next: TutorialEvent[], enabled?: boolean) => {
    if (!chart) return
    setChart({
      ...chart,
      tutorial: next,
      tutorialEnabled: enabled ?? chart.tutorialEnabled,
    })
    setDirty(true)
  }

  const setSceneFlag = (key: keyof SceneFlags, value: number) => {
    if (!chart) return
    setChart({
      ...chart,
      sceneFlags: { ...chart.sceneFlags, [key]: value },
    })
    setDirty(true)
  }

  const playheadTick = useMemo(() => {
    if (!chart) return 0
    const snap = Math.max(1, Math.round(chart.resolution / snapDivisor))
    const raw = (currentTime * chart.bpm * chart.resolution) / 60
    return Math.max(0, Math.round(raw / snap) * snap)
  }, [chart, currentTime, snapDivisor])

  const addVo = () => {
    if (!chart) return
    const ev: TutorialVoEvent = {
      kind: 'vo',
      id: `vo-${Date.now()}`,
      tick: playheadTick,
      file: '',
      text: '',
    }
    updateTutorial([...chart.tutorial, ev], true)
  }

  // ── Music segments — upload modal state + handler ────────────────────────
  const [musicModal, setMusicModal] = useState<{ tick: number; difficulty: string } | null>(null)
  const [musicBusy, setMusicBusy] = useState(false)
  const [musicError, setMusicError] = useState('')
  const musicInputRef = useRef<HTMLInputElement | null>(null)

  const addMusicSegment = async (clip: File, difficulty: string) => {
    if (!chart || !musicModal) return
    setMusicBusy(true)
    setMusicError('')
    try {
      const fd = new FormData()
      fd.append('file', clip)
      fd.append('difficulty', difficulty)
      const res = await fetch(
        `/api/tutorial/${trackId}/beatmaps/${beatmapId}/music-segment`,
        { method: 'POST', body: fd },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Music-segment upload failed (${res.status})`)
      }
      const data = await res.json()
      const ev: TutorialMusicEvent = {
        kind: 'music',
        id: `music-${Date.now()}`,
        tick: musicModal.tick,
        file: data.rel_path,
        sectionName: data.section_name,
        bpm: Number(data.bpm) || 120,
        resolution: Number(data.resolution) || 192,
        durationSeconds: Number(data.duration_seconds) || 0,
        notesCount: Number(data.notes_count) || 0,
        required: Math.min(5, Number(data.notes_count) || 0),
        timing: 'any',
        retryVo: '',
        next: '',
      }
      const nextSections = { ...chart.musicSections }
      if (data.section_body) {
        nextSections[data.section_name] = '\n' + data.section_body + '\n'
      }
      setChart({
        ...chart,
        tutorial: [...chart.tutorial, ev],
        tutorialEnabled: true,
        musicSections: nextSections,
      })
      setDirty(true)
      setMusicModal(null)
    } catch (e) {
      setMusicError((e as Error).message)
    } finally {
      setMusicBusy(false)
    }
  }

  const removeMusicEvent = async (ev: TutorialMusicEvent) => {
    if (!chart) return
    // Best-effort drop the audio file on disk too
    const filename = ev.file.startsWith('segments/') ? ev.file.slice('segments/'.length) : ev.file
    fetch(`/api/tutorial/${trackId}/beatmaps/${beatmapId}/segments/${filename}`, { method: 'DELETE' }).catch(() => undefined)
    const nextEvents = chart.tutorial.filter((e) => e.id !== ev.id)
    const nextSections = { ...chart.musicSections }
    delete nextSections[ev.sectionName]
    setChart({
      ...chart,
      tutorial: nextEvents,
      musicSections: nextSections,
    })
    setDirty(true)
  }

  const addStep = () => {
    if (!chart) return
    const ev: TutorialStepEvent = {
      kind: 'step',
      id: `step-${Date.now()}`,
      tick: playheadTick,
      stepId: `step_${chart.tutorial.filter((e) => e.kind === 'step').length + 1}`,
      required: 5,
      timing: 'any',
      retryVo: '',
      next: '',
    }
    updateTutorial([...chart.tutorial, ev], true)
  }

  const removeTutorialEvent = (id: string) => {
    if (!chart) return
    updateTutorial(chart.tutorial.filter((e) => e.id !== id))
  }

  const updateTutorialEvent = (id: string, patch: Partial<TutorialEvent>) => {
    if (!chart) return
    const next = chart.tutorial.map((e) =>
      e.id === id ? ({ ...e, ...patch } as TutorialEvent) : e,
    )
    updateTutorial(next)
  }

  const seekToTick = (tick: number) => {
    if (!chart || !audioRef.current) return
    const sec = (tick / chart.resolution) * (60 / chart.bpm)
    audioRef.current.currentTime = sec
    setCurrentTime(sec)
  }

  // Build / tear down HTMLAudioElement instances for every VO that has an
  // audio file. Re-runs whenever the tutorial event list (or chart context)
  // changes so newly-synthesized VOs become playable without a remount.
  useEffect(() => {
    const have = voAudiosRef.current
    const want = new Set<string>()
    if (chart) {
      for (const ev of chart.tutorial) {
        if (ev.kind !== 'vo' || !ev.file) continue
        want.add(ev.id)
        const url = `/api/tutorial/${trackId}/beatmaps/${beatmapId}/${ev.file}`
        const existing = have.get(ev.id) as (HTMLAudioElement & { _voUrl?: string }) | undefined
        if (!existing || existing._voUrl !== url) {
          if (existing) existing.pause()
          const a = new Audio(url) as HTMLAudioElement & { _voUrl?: string }
          a.preload = 'auto'
          a._voUrl = url
          have.set(ev.id, a)
        }
      }
    }
    for (const [id, a] of have) {
      if (!want.has(id)) {
        a.pause()
        have.delete(id)
      }
    }
  }, [chart, trackId, beatmapId])

  // Trigger / pause VO audio elements based on the current playhead. Detects
  // seeks via the time delta and resets the fired set so VOs can replay
  // after scrubbing back, and pre-marks VOs whose start is already in the
  // past after a seek-forward so they don't all retroactively fire.
  useEffect(() => {
    if (!chart) return
    const delta = currentTime - lastSampleTimeRef.current
    const isSeek = Math.abs(delta) > 0.3
    if (isSeek) {
      firedVosRef.current = new Set()
      for (const ev of chart.tutorial) {
        if (ev.kind !== 'vo') continue
        const voSec = (ev.tick / chart.resolution) * (60 / chart.bpm)
        if (currentTime > voSec + 0.05) {
          firedVosRef.current.add(ev.id)
        }
        if (currentTime < voSec) {
          const a = voAudiosRef.current.get(ev.id)
          if (a && !a.paused) a.pause()
        }
      }
    }
    lastSampleTimeRef.current = currentTime
    if (!playing) return
    for (const ev of chart.tutorial) {
      if (ev.kind !== 'vo' || !ev.file) continue
      const voSec = (ev.tick / chart.resolution) * (60 / chart.bpm)
      if (currentTime >= voSec && !firedVosRef.current.has(ev.id)) {
        const a = voAudiosRef.current.get(ev.id)
        if (a) {
          a.currentTime = Math.max(0, currentTime - voSec)
          a.play().catch(() => { /* autoplay blocked; user must interact again */ })
          firedVosRef.current.add(ev.id)
        }
      }
    }
  }, [currentTime, playing, chart])

  // Pause / unmount cleanup: keep VO audio paused whenever the song transport
  // is paused, and stop everything on unmount so they don't keep playing
  // after navigating away.
  useEffect(() => {
    if (playing) return
    for (const a of voAudiosRef.current.values()) {
      if (!a.paused) a.pause()
    }
  }, [playing])
  useEffect(() => {
    const audios = voAudiosRef.current
    return () => { for (const a of audios.values()) a.pause() }
  }, [])

  // TTS for a VO event — POST text to backend, then assign returned file path
  const [ttsBusy, setTtsBusy] = useState<string | null>(null)
  const generateVoAudio = async (ev: TutorialVoEvent) => {
    if (!ev.text.trim()) return
    setTtsBusy(ev.id)
    try {
      const fd = new FormData()
      fd.append('text', ev.text)
      fd.append('track_id', trackId)
      fd.append('beatmap_id', beatmapId)
      const res = await fetch('/api/tutorial/tts/synth', { method: 'POST', body: fd })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `TTS failed (${res.status})`)
      }
      const data = await res.json()
      updateTutorialEvent(ev.id, { file: data.rel_path })
    } catch (e) {
      window.alert((e as Error).message)
    } finally {
      setTtsBusy(null)
    }
  }

  const fmtTick = (tick: number) => {
    if (!chart) return ''
    const sec = (tick / chart.resolution) * (60 / chart.bpm)
    const m = Math.floor(sec / 60)
    const s = Math.floor(sec % 60)
    const cs = Math.floor((sec % 1) * 100)
    return `${m}:${s.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`
  }

  const noteCount = chart?.notes.length ?? 0

  // Seek by seconds — used by the timeline. Updates audio + state in lockstep.
  const seekSeconds = useCallback(
    (sec: number) => {
      const a = audioRef.current
      if (a) a.currentTime = sec
      setCurrentTime(sec)
    },
    [],
  )

  return (
    <div className="fixed inset-0 bg-black flex flex-col z-[60]">
      <header className="h-20 shrink-0 border-b border-gray-800 bg-gray-950 flex items-center px-3 gap-3">
        <button
          onClick={handleClose}
          className="shrink-0 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-md text-sm font-medium transition-colors"
        >
          ← Back
        </button>
        <div className="w-44 shrink-0 min-w-0">
          <h1 className="text-sm font-semibold text-gray-100 truncate">
            {meta?.name || (loadError ? 'Failed to load' : 'Beatmap editor')}
          </h1>
          <p className="text-[11px] text-gray-500 truncate leading-tight">
            {chart
              ? `${chart.activeName || '—'} · ${noteCount} notes · ${chart.bpm.toFixed(1)} BPM · res ${chart.resolution}`
              : loadError
                ? `Error: ${loadError}`
                : 'Loading…'}
          </p>
        </div>
        {/* Full-song zoomable timeline. Sits between title and save button. */}
        <div className="flex-1 min-w-0 h-12">
          {chart && duration > 0 ? (
            <TutorialTimeline
              duration={duration}
              currentTime={currentTime}
              bpm={chart.bpm}
              resolution={chart.resolution}
              events={chart.tutorialEnabled ? chart.tutorial : []}
              snapDivisor={snapDivisor}
              onSeek={seekSeconds}
              onMoveEvent={(id, tick) => updateTutorialEvent(id, { tick } as Partial<TutorialEvent>)}
            />
          ) : (
            <div className="h-full bg-gray-950 border border-gray-800 rounded text-[11px] text-gray-700 flex items-center justify-center">
              {loadError ? '—' : 'loading audio…'}
            </div>
          )}
        </div>
        {saveMsg && (
          <span className={`text-xs shrink-0 ${saveMsg === 'Saved' ? 'text-emerald-400' : 'text-red-400'}`}>{saveMsg}</span>
        )}
        <button
          onClick={handleSave}
          disabled={saving || !chart || !dirty}
          className="shrink-0 px-4 py-2 bg-jam-600 hover:bg-jam-500 disabled:opacity-40 text-white rounded-md text-sm font-medium transition-colors"
        >
          {saving ? 'Saving…' : dirty ? 'Save chart' : 'Saved'}
        </button>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* Outer flex centres the runway horizontally; inner container is
            capped at ~420px so the lanes sit at a comfortable density even
            on wide monitors. The canvas backing-store is sized to this
            container by the ResizeObserver, not to the full viewport. */}
        <div className="flex-1 flex justify-center bg-black min-w-0 px-4">
          <div ref={containerRef} className="relative w-full max-w-[420px]">
            <canvas
              ref={canvasRef}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              className="absolute inset-0 w-full h-full cursor-crosshair"
            />
          </div>
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

          {chart && (
            <section className="border-t border-gray-800 pt-4">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Scene</h3>
              <p className="text-[11px] text-gray-600 mb-2 leading-snug">
                Song-wide flags applied at load. <span className="font-mono">0</span> = off,
                <span className="font-mono"> 0.1</span> = on, higher = more intense.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {([
                  ['floorcrowd', 'Floor crowd'],
                  ['lasers_center', 'Lasers · center'],
                  ['lasers_left', 'Lasers · left'],
                  ['lasers_right', 'Lasers · right'],
                ] as const).map(([key, label]) => (
                  <label key={key} className="block">
                    <span className="text-[10px] text-gray-500">{label}</span>
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={chart.sceneFlags[key]}
                      onChange={(e) => setSceneFlag(key, Math.max(0, Number(e.target.value) || 0))}
                      className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200 font-mono"
                    />
                  </label>
                ))}
              </div>
            </section>
          )}

          {chart && (
            <section className="border-t border-gray-800 pt-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Tutorial</h3>
                <label className="flex items-center gap-1 text-[11px] text-gray-400">
                  <input
                    type="checkbox"
                    checked={chart.tutorialEnabled}
                    onChange={(e) => updateTutorial(chart.tutorial, e.target.checked)}
                    className="accent-jam-500"
                  />
                  enabled
                </label>
              </div>
              {chart.tutorialEnabled && (
                <>
                  <div className="grid grid-cols-3 gap-1 mb-2">
                    <button
                      onClick={addVo}
                      className="px-1.5 py-1 bg-sky-700/40 hover:bg-sky-600/60 border border-sky-700/60 text-sky-200 rounded text-[11px] font-medium transition-colors"
                      title={`Add VO at playhead (tick ${playheadTick})`}
                    >
                      + VO
                    </button>
                    <button
                      onClick={addStep}
                      className="px-1.5 py-1 bg-purple-700/40 hover:bg-purple-600/60 border border-purple-700/60 text-purple-200 rounded text-[11px] font-medium transition-colors"
                      title={`Add STEP boundary at playhead (tick ${playheadTick})`}
                    >
                      + STEP
                    </button>
                    <button
                      onClick={() => setMusicModal({ tick: playheadTick, difficulty: chart.activeName || 'ExpertSingle' })}
                      className="px-1.5 py-1 bg-orange-700/40 hover:bg-orange-600/60 border border-orange-700/60 text-orange-200 rounded text-[11px] font-medium transition-colors"
                      title={`Drop a music segment at playhead (tick ${playheadTick})`}
                    >
                      + MUSIC
                    </button>
                  </div>
                  <p className="text-[11px] text-gray-600 mb-1.5">
                    Adding at <span className="font-mono text-gray-400">{fmtTick(playheadTick)}</span>
                  </p>
                  <ul className="space-y-2">
                    {[...chart.tutorial].sort((a, b) => a.tick - b.tick).map((ev) => {
                      if (ev.kind === 'music') {
                        return (
                          <li
                            key={ev.id}
                            className="bg-orange-900/20 border border-orange-800/40 rounded p-2 space-y-1.5"
                          >
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => seekToTick(ev.tick)}
                                className="text-[10px] font-mono text-orange-300 hover:text-orange-200"
                              >
                                {fmtTick(ev.tick)}
                              </button>
                              <span className="text-[10px] text-orange-400/80">MUSIC</span>
                              <span className="text-[10px] text-gray-500 truncate flex-1" title={ev.file}>
                                {(ev.file.split('/').pop() || ev.file)}
                              </span>
                              <button
                                onClick={() => removeMusicEvent(ev)}
                                className="text-[10px] text-red-400 hover:text-red-200"
                                title="Delete this music segment"
                              >
                                ×
                              </button>
                            </div>
                            <div className="text-[10px] text-gray-500 font-mono">
                              {ev.notesCount} notes · {ev.bpm.toFixed(1)} BPM · {ev.durationSeconds.toFixed(1)}s
                            </div>
                            <audio
                              controls
                              src={`/api/tutorial/${trackId}/beatmaps/${beatmapId}/${ev.file}`}
                              className="w-full h-7"
                            />
                            <div className="grid grid-cols-2 gap-1">
                              <label className="block">
                                <span className="text-[10px] text-gray-500">required</span>
                                <input
                                  type="number"
                                  min="0"
                                  value={ev.required}
                                  onChange={(e) => updateTutorialEvent(ev.id, { required: Math.max(0, Number(e.target.value) || 0) })}
                                  className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200"
                                />
                              </label>
                              <label className="block">
                                <span className="text-[10px] text-gray-500">timing</span>
                                <select
                                  value={ev.timing}
                                  onChange={(e) => updateTutorialEvent(ev.id, { timing: e.target.value as TimingMode })}
                                  className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200"
                                >
                                  <option value="any">any</option>
                                  <option value="perfect">perfect</option>
                                </select>
                              </label>
                            </div>
                            <label className="block">
                              <span className="text-[10px] text-gray-500">retry_vo (file path)</span>
                              <input
                                type="text"
                                value={ev.retryVo}
                                onChange={(e) => updateTutorialEvent(ev.id, { retryVo: e.target.value })}
                                placeholder="vo/retry.ogg"
                                className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200"
                              />
                            </label>
                            <label className="block">
                              <span className="text-[10px] text-gray-500">next (step id)</span>
                              <input
                                type="text"
                                value={ev.next}
                                onChange={(e) => updateTutorialEvent(ev.id, { next: e.target.value })}
                                placeholder="next_step"
                                className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200"
                              />
                            </label>
                          </li>
                        )
                      }
                      return ev.kind === 'vo' ? (
                        <li
                          key={ev.id}
                          className="bg-sky-900/20 border border-sky-800/40 rounded p-2 space-y-1.5"
                        >
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => seekToTick(ev.tick)}
                              className="text-[10px] font-mono text-sky-400 hover:text-sky-200"
                              title="Jump to this tick"
                            >
                              {fmtTick(ev.tick)}
                            </button>
                            <span className="text-[10px] text-sky-500/80">VO</span>
                            <button
                              onClick={() => removeTutorialEvent(ev.id)}
                              className="ml-auto text-[10px] text-red-400 hover:text-red-200"
                              title="Delete this VO"
                            >
                              ×
                            </button>
                          </div>
                          <textarea
                            value={ev.text}
                            onChange={(e) => updateTutorialEvent(ev.id, { text: e.target.value })}
                            placeholder="VO script — what the narrator says"
                            rows={2}
                            className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-200 resize-y focus:outline-none focus:border-sky-500"
                          />
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => generateVoAudio(ev)}
                              disabled={!ev.text.trim() || ttsBusy === ev.id}
                              className="px-2 py-0.5 bg-jam-600 hover:bg-jam-500 disabled:opacity-40 text-white rounded text-[10px] font-medium transition-colors"
                              title="Generate speech with Chatterbox TTS"
                            >
                              {ttsBusy === ev.id ? 'Synth…' : '🔊 Generate'}
                            </button>
                            {ev.file && (
                              <audio
                                controls
                                src={`/api/tutorial/${trackId}/beatmaps/${beatmapId}/${ev.file}`}
                                className="flex-1 h-6"
                                style={{ minWidth: 0 }}
                              />
                            )}
                            <input
                              type="number"
                              value={ev.tick}
                              onChange={(e) => updateTutorialEvent(ev.id, { tick: Math.max(0, Number(e.target.value) || 0) })}
                              className="w-16 bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-[10px] text-gray-300 font-mono"
                              title="Tick position"
                            />
                          </div>
                        </li>
                      ) : (
                        <li
                          key={ev.id}
                          className="bg-purple-900/20 border border-purple-800/40 rounded p-2 space-y-1.5"
                        >
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => seekToTick(ev.tick)}
                              className="text-[10px] font-mono text-purple-300 hover:text-purple-200"
                            >
                              {fmtTick(ev.tick)}
                            </button>
                            <span className="text-[10px] text-purple-400/80">STEP</span>
                            <input
                              type="text"
                              value={ev.stepId}
                              onChange={(e) => updateTutorialEvent(ev.id, { stepId: e.target.value })}
                              className="flex-1 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200"
                              placeholder="step_id"
                            />
                            <button
                              onClick={() => removeTutorialEvent(ev.id)}
                              className="text-[10px] text-red-400 hover:text-red-200"
                              title="Delete this step"
                            >
                              ×
                            </button>
                          </div>
                          <div className="grid grid-cols-2 gap-1">
                            <label className="block">
                              <span className="text-[10px] text-gray-500">required</span>
                              <input
                                type="number"
                                min="0"
                                value={ev.required}
                                onChange={(e) => updateTutorialEvent(ev.id, { required: Math.max(0, Number(e.target.value) || 0) })}
                                className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200"
                              />
                            </label>
                            <label className="block">
                              <span className="text-[10px] text-gray-500">timing</span>
                              <select
                                value={ev.timing}
                                onChange={(e) => updateTutorialEvent(ev.id, { timing: e.target.value as TimingMode })}
                                className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200"
                              >
                                <option value="any">any</option>
                                <option value="perfect">perfect</option>
                              </select>
                            </label>
                          </div>
                          <label className="block">
                            <span className="text-[10px] text-gray-500">retry_vo (file path)</span>
                            <input
                              type="text"
                              value={ev.retryVo}
                              onChange={(e) => updateTutorialEvent(ev.id, { retryVo: e.target.value })}
                              placeholder="vo/retry1.ogg"
                              className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200"
                            />
                          </label>
                          <label className="block">
                            <span className="text-[10px] text-gray-500">next (step id)</span>
                            <input
                              type="text"
                              value={ev.next}
                              onChange={(e) => updateTutorialEvent(ev.id, { next: e.target.value })}
                              placeholder="next_step"
                              className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200"
                            />
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                  {chart.tutorial.length === 0 && (
                    <p className="text-[11px] text-gray-600 mt-1">
                      No tutorial events yet. Add a STEP to gate progression and a VO to play narration.
                    </p>
                  )}
                  <p className="text-[11px] text-gray-600 mt-2">
                    Set up the 10 instrument samples + voice clone reference on the
                    track detail page (Tutorial samples panel).
                  </p>
                </>
              )}
            </section>
          )}
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

      {musicModal && (
        <div
          className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[70] flex items-center justify-center px-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !musicBusy) setMusicModal(null)
          }}
        >
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-5 space-y-4">
            <div>
              <h3 className="text-lg font-semibold text-orange-300">Drop a music segment</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Upload a short clip. The chart generator runs on it and produces
                notes for the chosen difficulty. Your VO/STEP timeline gains
                a MUSIC event at the playhead.
              </p>
            </div>
            <div>
              <span className="text-xs text-gray-400 block mb-1">Position</span>
              <span className="text-xs font-mono text-gray-300">tick {musicModal.tick}</span>
            </div>
            <label className="block">
              <span className="text-xs text-gray-400">Generate notes for</span>
              <select
                value={musicModal.difficulty}
                onChange={(e) => setMusicModal({ ...musicModal, difficulty: e.target.value })}
                className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-orange-500"
              >
                <option value="ExpertSingle">Expert</option>
                <option value="HardSingle">Hard</option>
                <option value="MediumSingle">Medium</option>
                <option value="EasySingle">Easy</option>
              </select>
              <span className="text-[11px] text-gray-600 mt-1 block">
                Density staircase applies — Easy will be ~1 note/beat, Expert all detected onsets.
              </span>
            </label>
            <label className="block px-3 py-3 bg-gray-800 hover:bg-gray-700 border border-dashed border-gray-700 rounded-lg cursor-pointer text-center text-sm text-gray-300">
              Click to choose audio (OGG / WAV / MP3 / FLAC / M4A)
              <input
                ref={musicInputRef}
                type="file"
                accept=".ogg,.wav,.mp3,.flac,.m4a"
                className="hidden"
                disabled={musicBusy}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) addMusicSegment(f, musicModal.difficulty)
                }}
              />
            </label>
            {musicError && <div className="text-xs text-red-400">{musicError}</div>}
            {musicBusy && (
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <div className="animate-spin h-4 w-4 border-2 border-orange-400 border-t-transparent rounded-full" />
                Running chart generator on the clip…
              </div>
            )}
            <div className="flex justify-end">
              <button
                onClick={() => setMusicModal(null)}
                disabled={musicBusy}
                className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-200 rounded-md text-sm transition-colors"
              >
                {musicBusy ? 'Working…' : 'Cancel'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
