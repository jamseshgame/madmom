import {
  SCENE_EVENT_CATALOG, SceneEvent, SceneFlags,
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

type VoEngine = 'chatterbox' | 'elevenlabs'

interface TutorialVoEvent {
  kind: 'vo'
  id: string             // ephemeral, not persisted (regenerated per parse)
  tick: number
  file: string           // relative path under the beatmap dir, e.g. "vo/abc.ogg"
  text: string           // optional draft text used to (re)generate the clip
  engine: VoEngine       // which TTS engine generated the file (defaults to chatterbox)
  voiceId: string        // when engine === 'elevenlabs'; '' means inherit track default
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
      let engineArg: VoEngine = 'chatterbox'
      let voiceArg = ''
      for (const t of tokens.slice(2)) {
        if (t.startsWith('text=')) textArg = t.slice(5)
        else if (t.startsWith('engine=')) {
          const v = t.slice(7).toLowerCase()
          if (v === 'elevenlabs' || v === 'chatterbox') engineArg = v
        }
        else if (t.startsWith('voice=')) voiceArg = t.slice(6)
      }
      events.push({
        kind: 'vo',
        id: `vo-${tick}-${counter++}`,
        tick,
        file,
        text: textArg,
        engine: engineArg,
        voiceId: voiceArg,
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
      const engine = e.engine && e.engine !== 'chatterbox' ? ` engine=${e.engine}` : ''
      const voice = e.voiceId ? ` voice=${e.voiceId}` : ''
      return `  ${e.tick} = VO "${e.file}"${t}${engine}${voice}`
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

// ── SceneTimeline ──────────────────────────────────────────────────────────
// Sibling row to TutorialTimeline. Renders scene events as a row of bands
// (durational events) and spikes (instantaneous events). Click event to
// select; drag body to move tick; drag right edge to resize duration.

interface SceneTimelineProps {
  duration: number
  bpm: number
  resolution: number
  events: SceneEvent[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onMoveEvent: (id: string, tick: number) => void
  onResizeEvent: (id: string, duration: number) => void
}

function SceneTimeline({
  duration, bpm, resolution, events,
  selectedId, onSelect, onMoveEvent, onResizeEvent,
}: SceneTimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  const dragRef = useRef<
    | { kind: 'move'; id: string; offset: number }
    | { kind: 'resize'; id: string; startTick: number; pivotX: number }
    | null
  >(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setWidth(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const span = Math.max(0.001, duration)
  const tickToSec = (t: number) => (t / resolution) * (60 / bpm)
  const secToX = (s: number) => (s / span) * width
  const xToSec = (x: number) => (x / Math.max(1, width)) * span
  const secToTick = (s: number) => Math.max(0, Math.round((s * bpm * resolution) / 60))

  const handleMouseMove = (e: React.MouseEvent) => {
    const drag = dragRef.current
    if (!drag) return
    const rect = containerRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    if (drag.kind === 'move') {
      const sec = Math.max(0, Math.min(duration, xToSec(x - drag.offset)))
      onMoveEvent(drag.id, secToTick(sec))
    } else {
      const ev = events.find((e) => e.id === drag.id)
      if (!ev) return
      const cursorTick = secToTick(Math.max(0, xToSec(x)))
      const next = Math.max(0, cursorTick - drag.startTick)
      onResizeEvent(drag.id, next)
    }
  }

  const handleMouseUp = () => { dragRef.current = null }

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      className="relative h-6 bg-gray-950 border border-gray-800 rounded overflow-hidden select-none"
      onClick={(e) => {
        if (e.target === e.currentTarget) onSelect(null)
      }}
    >
      {events.map((ev) => {
        const startSec = tickToSec(ev.tick)
        const endSec = tickToSec(ev.tick + ev.duration)
        const x = secToX(startSec)
        const w = Math.max(2, secToX(endSec) - x)
        const isSel = ev.id === selectedId
        return (
          <div
            key={ev.id}
            onMouseDown={(e) => {
              e.stopPropagation()
              const rect = containerRef.current!.getBoundingClientRect()
              const localX = e.clientX - rect.left
              dragRef.current = { kind: 'move', id: ev.id, offset: localX - x }
              onSelect(ev.id)
            }}
            title={`${ev.name} @ tick ${ev.tick}${ev.duration > 0 ? ` (dur ${ev.duration})` : ''}`}
            className={`absolute top-0 bottom-0 ${isSel ? 'bg-emerald-400/70' : 'bg-emerald-600/60'} hover:bg-emerald-500/80 cursor-grab`}
            style={{ left: x, width: w }}
          >
            <span className="text-[9px] text-emerald-50 px-1 truncate block leading-6">{ev.name}</span>
            {ev.duration > 0 && (
              <div
                onMouseDown={(e) => {
                  e.stopPropagation()
                  dragRef.current = { kind: 'resize', id: ev.id, startTick: ev.tick, pivotX: x }
                  onSelect(ev.id)
                }}
                className="absolute top-0 bottom-0 right-0 w-1.5 cursor-ew-resize bg-emerald-200/40 hover:bg-emerald-200/80"
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function ScenePicker({
  onPick, onClose,
}: { onPick: (name: string) => void; onClose: () => void }) {
  // Group catalog by group label, preserving catalog order.
  const groups: { label: string; entries: typeof SCENE_EVENT_CATALOG }[] = []
  for (const entry of SCENE_EVENT_CATALOG) {
    const last = groups[groups.length - 1]
    if (last && last.label === entry.groupLabel) last.entries.push(entry)
    else groups.push({ label: entry.groupLabel, entries: [entry] })
  }
  return (
    <div
      className="absolute top-full left-0 mt-1 w-64 max-h-80 overflow-y-auto bg-gray-900 border border-gray-700 rounded-md shadow-2xl z-[80] p-1.5 space-y-1.5"
      onMouseLeave={onClose}
    >
      {groups.map((g) => (
        <div key={g.label}>
          <div className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
            {g.label}
          </div>
          <div className="grid grid-cols-2 gap-0.5">
            {g.entries.map((e) => (
              <button
                key={e.name}
                onClick={() => onPick(e.name)}
                className="text-left px-1.5 py-0.5 text-[10px] text-gray-200 hover:bg-emerald-700/40 rounded font-mono truncate"
                title={e.name}
              >
                {e.itemLabel}
              </button>
            ))}
          </div>
        </div>
      ))}
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
    // Notes that move together. snapshot is captured at drag start so we can
    // compute deltas relative to the original positions even after multiple
    // drag-move events. anchorId is the note the user actually grabbed.
    anchorId: number
    snapshot: Map<number, { tick: number; lane: number }>
    startX: number
    startY: number
    moved: boolean
  } | null>(null)
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 800 })

  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [scrollSpeed, setScrollSpeed] = useState(450)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [tool, setTool] = useState<'select' | 'note'>('select')
  const [noteToolLane, setNoteToolLane] = useState(0)  // lane chosen for click-to-place (0–4)
  // Undo/redo history. Each entry is a snapshot of `notes` (plus the active
  // section name so undo across difficulty switches is safe). We keep up to
  // 100 steps and push only on logical operations (add/delete/paste/move-end),
  // not per-frame during drag.
  const historyRef = useRef<{ activeName: string; notes: ChartNote[] }[]>([])
  const futureRef = useRef<{ activeName: string; notes: ChartNote[] }[]>([])
  const clipboardRef = useRef<ChartNote[]>([])
  // Bumped to force a re-render when undo/redo state changes (so the toolbar
  // buttons enable/disable). The arrays themselves live in refs.
  const [, setHistoryTick] = useState(0)

  const audioSrc = `/api/tracks/${trackId}/beatmaps/${beatmapId}/download/song.ogg`

  // Push the current notes snapshot onto the undo stack and apply the new one.
  // Use this for any change the user would expect Ctrl+Z to revert: add, delete,
  // paste, drag-end, arrow-nudge, sustain-toggle. Avoid pushing on every frame
  // mid-drag (handleMouseMove writes through directly).
  const commitNotes = useCallback((nextNotes: ChartNote[]) => {
    setChart((prev) => {
      if (!prev) return prev
      historyRef.current.push({ activeName: prev.activeName, notes: prev.notes })
      if (historyRef.current.length > 100) historyRef.current.shift()
      futureRef.current = []
      setHistoryTick((n) => n + 1)
      return { ...prev, notes: nextNotes }
    })
    setDirty(true)
  }, [])

  const undo = useCallback(() => {
    setChart((prev) => {
      if (!prev) return prev
      const last = historyRef.current.pop()
      if (!last) return prev
      // Only restore if the snapshot is for the currently active section. If
      // the user switched difficulty after the change, we silently skip rather
      // than corrupt the wrong section.
      if (last.activeName !== prev.activeName) return prev
      futureRef.current.push({ activeName: prev.activeName, notes: prev.notes })
      setHistoryTick((n) => n + 1)
      return { ...prev, notes: last.notes }
    })
    setDirty(true)
  }, [])

  const redo = useCallback(() => {
    setChart((prev) => {
      if (!prev) return prev
      const next = futureRef.current.pop()
      if (!next) return prev
      if (next.activeName !== prev.activeName) return prev
      historyRef.current.push({ activeName: prev.activeName, notes: prev.notes })
      setHistoryTick((n) => n + 1)
      return { ...prev, notes: next.notes }
    })
    setDirty(true)
  }, [])

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
    // Sidecar carries VO1, VO2, EV1, EV2 to the right of the gem lanes. We
    // give the gem lanes ~64% of the canvas width so a 5-lane chord still
    // sits comfortably; the four sidecar lanes share the remaining ~36%.
    const NUM_SIDECARS = 4
    const SIDECAR_FRAC = 0.36
    const SIDECAR_W_TOTAL = W * SIDECAR_FRAC
    const SIDECAR_W = SIDECAR_W_TOTAL / NUM_SIDECARS
    const GEM_W = W - SIDECAR_W_TOTAL
    const LANE_W = GEM_W / NUM_LANES
    const NOTE_R = Math.min(LANE_W * 0.32, 60)
    const SIDECAR_X0 = GEM_W
    const SIDECAR_LABELS = ['VO1', 'VO2', 'EV1', 'EV2']

    ctx.fillStyle = '#0a0a0c'
    ctx.fillRect(0, 0, W, H)

    // Sidecar background (slightly darker so it reads as a separate column)
    ctx.fillStyle = '#06070a'
    ctx.fillRect(SIDECAR_X0, 0, SIDECAR_W_TOTAL, H)

    // Lane separators (gem lanes)
    ctx.strokeStyle = '#1f2937'
    ctx.lineWidth = 1
    for (let i = 1; i < NUM_LANES; i++) {
      const x = i * LANE_W
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, H)
      ctx.stroke()
    }
    // Strong divider between gems and sidecar
    ctx.strokeStyle = '#374151'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(SIDECAR_X0, 0)
    ctx.lineTo(SIDECAR_X0, H)
    ctx.stroke()
    // Sidecar lane separators + headers
    ctx.strokeStyle = '#1f2937'
    ctx.lineWidth = 1
    for (let i = 1; i < NUM_SIDECARS; i++) {
      const x = SIDECAR_X0 + i * SIDECAR_W
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, H)
      ctx.stroke()
    }
    // Sidecar header labels along the top edge
    ctx.fillStyle = '#6b7280'
    ctx.font = '10px monospace'
    ctx.textAlign = 'center'
    for (let i = 0; i < NUM_SIDECARS; i++) {
      const cx = SIDECAR_X0 + (i + 0.5) * SIDECAR_W
      ctx.fillText(SIDECAR_LABELS[i], cx, 12)
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

    // Sidecar pills ──────────────────────────────────────────────────────────
    // VO events render in VO1/VO2 (lanes 0/1 of the sidecar). STEP, MUSIC and
    // scene events all share EV1/EV2 (lanes 2/3). Within each pair we run a
    // greedy non-overlap assignment so simultaneous events stack instead of
    // colliding.
    interface Pill {
      tickStart: number
      tickEnd: number   // = tickStart + duration in ticks (>= tickStart + 1)
      label: string     // multiline allowed via "\n"
      fill: string
      border: string
      text: string
    }

    const ticksPerSec = (chart.bpm * chart.resolution) / 60
    const tickFromSec = (s: number) => Math.max(0, s * ticksPerSec)
    // Minimum visual height for instantaneous events: ~8 px worth of ticks.
    const MIN_TICK_DUR = Math.max(1, Math.round((8 / scrollSpeed) * ticksPerSec))

    const voPills: Pill[] = []
    const evPills: Pill[] = []

    if (chart.tutorialEnabled) {
      for (const ev of chart.tutorial) {
        if (ev.kind === 'vo') {
          voPills.push({
            tickStart: ev.tick,
            tickEnd: ev.tick + MIN_TICK_DUR,
            label: ev.text ? `▶ ${ev.text.slice(0, 60)}` : '▶ VO',
            fill: 'rgba(56, 189, 248, 0.22)',
            border: 'rgba(56, 189, 248, 0.7)',
            text: '#7dd3fc',
          })
        } else if (ev.kind === 'step') {
          evPills.push({
            tickStart: ev.tick,
            tickEnd: ev.tick + MIN_TICK_DUR,
            label: `▌STEP ${ev.stepId || '?'}\n${ev.required || 0} ${ev.timing}`,
            fill: 'rgba(168, 85, 247, 0.22)',
            border: 'rgba(168, 85, 247, 0.7)',
            text: '#c4b5fd',
          })
        } else if (ev.kind === 'music') {
          const durTicks = Math.max(MIN_TICK_DUR, Math.round(tickFromSec(ev.durationSeconds)))
          const filename = ev.file.split('/').pop() || ev.file
          evPills.push({
            tickStart: ev.tick,
            tickEnd: ev.tick + durTicks,
            label: `♪ ${filename}\n${ev.notesCount}n · ${ev.bpm.toFixed(0)}BPM`,
            fill: 'rgba(249, 115, 22, 0.20)',
            border: 'rgba(249, 115, 22, 0.7)',
            text: '#fdba74',
          })
        }
      }
    }
    for (const ev of chart.sceneEvents) {
      const durTicks = ev.duration > 0 ? ev.duration : MIN_TICK_DUR
      // Strip the onboard_ prefix in the runway label to keep pills readable.
      const short = ev.name.replace(/^onboard_/, '')
      evPills.push({
        tickStart: ev.tick,
        tickEnd: ev.tick + durTicks,
        label: short,
        fill: 'rgba(16, 185, 129, 0.22)',
        border: 'rgba(16, 185, 129, 0.7)',
        text: '#6ee7b7',
      })
    }

    // Greedy two-lane non-overlap assignment. Sort by start tick, place on
    // lane 0 if its trailing edge frees up before this pill, else lane 1,
    // else lane 0 anyway (let it overlap rather than drop the cue).
    const assignLanes = (pills: Pill[]): Array<Pill & { lane: 0 | 1 }> => {
      const sorted = [...pills].sort((a, b) => a.tickStart - b.tickStart)
      let lane0End = -Infinity
      let lane1End = -Infinity
      return sorted.map((p) => {
        let lane: 0 | 1
        if (p.tickStart >= lane0End) {
          lane = 0
          lane0End = p.tickEnd
        } else if (p.tickStart >= lane1End) {
          lane = 1
          lane1End = p.tickEnd
        } else {
          lane = 0
          lane0End = Math.max(lane0End, p.tickEnd)
        }
        return { ...p, lane }
      })
    }

    const drawPills = (pills: Array<Pill & { lane: 0 | 1 }>, baseLaneIndex: number) => {
      ctx.font = '10px sans-serif'
      ctx.textAlign = 'left'
      for (const p of pills) {
        const yBottom = HIT - (t2s(p.tickStart) - currentTime) * scrollSpeed
        const yTop = HIT - (t2s(p.tickEnd) - currentTime) * scrollSpeed
        const h = Math.max(10, yBottom - yTop)
        if (yBottom < -40 || yTop > H + 40) continue
        const laneIndex = baseLaneIndex + p.lane
        const x = SIDECAR_X0 + laneIndex * SIDECAR_W + 2
        const w = SIDECAR_W - 4
        ctx.fillStyle = p.fill
        ctx.fillRect(x, yTop, w, h)
        ctx.strokeStyle = p.border
        ctx.lineWidth = 1
        ctx.strokeRect(x + 0.5, yTop + 0.5, w - 1, h - 1)
        ctx.fillStyle = p.text
        // Label fits inside the pill, top-anchored. Truncate per line.
        const lines = p.label.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const ly = yTop + 11 + i * 11
          if (ly > yBottom - 2) break
          ctx.fillText(lines[i].slice(0, Math.max(2, Math.floor(w / 5))), x + 3, ly)
        }
      }
    }

    drawPills(assignLanes(voPills), 0)  // VO1, VO2
    drawPills(assignLanes(evPills), 2)  // EV1, EV2

    // Index modifiers by tick so each rendered note can pick up its HOPO/tap
    // companion (lane 5 / 6) without an O(n²) inner loop. Open notes (lane 7)
    // are stored separately because they render as a runway-wide bar, not a
    // single gem.
    const modByTick = new Map<number, { hopo: boolean; tap: boolean }>()
    const openIdsByTick = new Map<number, number[]>()
    for (let i = 0; i < chart.notes.length; i++) {
      const n = chart.notes[i]
      if (n.lane === 5 || n.lane === 6) {
        const cur = modByTick.get(n.tick) || { hopo: false, tap: false }
        if (n.lane === 5) cur.hopo = true
        else cur.tap = true
        modByTick.set(n.tick, cur)
      } else if (n.lane === 7) {
        const arr = openIdsByTick.get(n.tick) || []
        arr.push(i)
        openIdsByTick.set(n.tick, arr)
      }
    }

    // Open notes — full-width bar across the gem lanes.
    openIdsByTick.forEach((ids, tick) => {
      const noteSec = t2s(tick)
      const dy = (noteSec - currentTime) * scrollSpeed
      const y = HIT - dy
      if (y < -200 || y > H + 200) return
      const note = chart.notes[ids[0]]
      const isSelected = ids.some((id) => selectedIds.has(id))
      const barH = 14
      // Sustain bar runs upward from the note marker like single-lane sustains.
      if (note.sustain > 0) {
        const sustainSec = t2s(note.sustain)
        const tailLen = sustainSec * scrollSpeed
        ctx.fillStyle = '#a855f7' + '55'  // purple/violet for opens
        ctx.fillRect(0, y - tailLen, GEM_W, tailLen)
      }
      ctx.fillStyle = '#a855f7'
      ctx.fillRect(0, y - barH / 2, GEM_W, barH)
      ctx.lineWidth = isSelected ? 3 : 1.5
      ctx.strokeStyle = isSelected ? '#ffffff' : '#3b0764'
      ctx.strokeRect(0.5, y - barH / 2 + 0.5, GEM_W - 1, barH - 1)
      // Label
      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 10px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('OPEN', GEM_W / 2, y + 3)
    })

    // Single-lane notes
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

      const isSelected = selectedIds.has(i)
      const mods = modByTick.get(n.tick)
      ctx.beginPath()
      ctx.arc(x, y, NOTE_R, 0, Math.PI * 2)
      ctx.fillStyle = LANE_FILL[n.lane]
      ctx.fill()
      ctx.lineWidth = isSelected ? 4 : 2
      ctx.strokeStyle = isSelected ? '#ffffff'
        : mods?.tap ? '#22d3ee'   // cyan ring on tap notes
        : '#000000'
      ctx.stroke()

      // Forced-HOPO indicator: small upward triangle riding on top of the gem.
      if (mods?.hopo) {
        ctx.fillStyle = '#fde047'
        ctx.beginPath()
        ctx.moveTo(x, y - NOTE_R - 8)
        ctx.lineTo(x - 6, y - NOTE_R - 1)
        ctx.lineTo(x + 6, y - NOTE_R - 1)
        ctx.closePath()
        ctx.fill()
        ctx.strokeStyle = '#000000'
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }

    // Note-tool ghost: when the user is in click-to-place mode, render a
    // translucent circle in the selected lane at the snapped tick under the
    // playhead so it's clear *where* a click will drop a note. Open notes
    // (lane 7) render as a wide bar instead.
    if (tool === 'note' && chart) {
      const ghostLane = noteToolLane
      if (ghostLane === 7) {
        ctx.fillStyle = '#a855f7' + '55'
        ctx.fillRect(0, HIT - 7, GEM_W, 14)
        ctx.strokeStyle = '#ffffff'
        ctx.setLineDash([4, 4])
        ctx.lineWidth = 1.5
        ctx.strokeRect(0.5, HIT - 7 + 0.5, GEM_W - 1, 13)
        ctx.setLineDash([])
      } else {
        const x = (ghostLane + 0.5) * LANE_W
        ctx.beginPath()
        ctx.arc(x, HIT, NOTE_R, 0, Math.PI * 2)
        ctx.fillStyle = LANE_FILL[ghostLane] + '55'
        ctx.fill()
        ctx.strokeStyle = '#ffffff'
        ctx.setLineDash([4, 4])
        ctx.lineWidth = 1.5
        ctx.stroke()
        ctx.setLineDash([])
      }
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
    if (selectedIds.size === 1) {
      const onlyId = selectedIds.values().next().value as number
      const sel = chart.notes[onlyId]
      if (sel) {
        const laneName = sel.lane === 7 ? 'OPEN'
          : sel.lane === 5 ? 'HOPO mod'
          : sel.lane === 6 ? 'Tap mod'
          : laneLabels[sel.lane] ?? '?'
        ctx.fillText(
          `selected: ${laneName} · tick ${sel.tick} · sustain ${sel.sustain}`,
          12,
          42,
        )
      }
    } else if (selectedIds.size > 1) {
      ctx.fillText(`${selectedIds.size} notes selected`, 12, 42)
    }
    if (tool === 'note') {
      ctx.fillStyle = '#a78bfa'
      const ghostLaneName = noteToolLane === 7 ? 'OPEN (full-width)'
        : `lane ${noteToolLane + 1} (${laneLabels[noteToolLane] ?? ''})`
      ctx.fillText(`Note tool · ${ghostLaneName}`, 12, 62)
    }
  }, [chart, currentTime, scrollSpeed, selectedIds, snapDivisor, isDrums, laneLabels, tool, noteToolLane])

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
    // Same split as draw(): 64% of width for gems, 36% for the sidecar.
    const GEM_W = canvas.width * 0.64
    if (cx >= GEM_W) return null  // Click landed in the sidecar
    const LANE_W = GEM_W / 5
    const lane = Math.floor(cx / LANE_W)
    let bestId: number | null = null
    let bestDist = 36
    for (let i = 0; i < chart.notes.length; i++) {
      const n = chart.notes[i]
      const noteSec = tickToSeconds(n.tick, chart.bpm, chart.resolution)
      const y = HIT - (noteSec - currentTime) * scrollSpeed
      // Open notes (lane 7) span the full gem width — accept a click anywhere
      // along the bar but with a tighter vertical tolerance to match the bar
      // height.
      if (n.lane === 7) {
        const d = Math.abs(y - cy)
        if (d < 12 && d < bestDist) { bestDist = d; bestId = i }
        continue
      }
      // HOPO/tap modifiers (lane 5/6) aren't directly clickable — they're
      // toggled via F/T on the underlying note.
      if (n.lane > 4) continue
      if (n.lane !== lane) continue
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

    // Click on existing note: select / shift-toggle, then start a group drag.
    if (id !== null) {
      const orig = chart.notes[id]
      if (!orig) return
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        setSelectedIds((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      } else if (!selectedIds.has(id)) {
        setSelectedIds(new Set([id]))
      }
      // Build the drag snapshot from the post-update selection: include the
      // clicked note even if the state update above hasn't flushed yet.
      const dragIds = new Set(selectedIds)
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        if (dragIds.has(id)) dragIds.delete(id); else dragIds.add(id)
      } else if (!dragIds.has(id)) {
        dragIds.clear(); dragIds.add(id)
      }
      const snapshot = new Map<number, { tick: number; lane: number }>()
      dragIds.forEach((i) => {
        const n = chart.notes[i]
        if (n) snapshot.set(i, { tick: n.tick, lane: n.lane })
      })
      dragRef.current = { anchorId: id, snapshot, startX: cx, startY: cy, moved: false }
      return
    }

    // Note tool: click on empty area drops a new note in the chosen lane at
    // the snapped tick under the cursor. The new note becomes the only
    // selection so further nudges/deletes are scoped to it.
    if (tool === 'note') {
      const canvas = canvasRef.current!
      const HIT = canvas.height - 110
      const targetSec = currentTime + (HIT - cy) / scrollSpeed
      const targetTickRaw = Math.max(0, (targetSec * chart.bpm * chart.resolution) / 60)
      const snapTicks = Math.max(1, Math.round(chart.resolution / snapDivisor))
      const newTick = Math.round(targetTickRaw / snapTicks) * snapTicks
      const newNote: ChartNote = { tick: newTick, lane: noteToolLane, sustain: 0 }
      const next = [...chart.notes, newNote].sort((a, b) => a.tick - b.tick || a.lane - b.lane)
      const newIdx = next.findIndex((n) => n === newNote)
      commitNotes(next)
      setSelectedIds(new Set([newIdx]))
      return
    }

    // Click on empty space in select tool: clear selection.
    setSelectedIds(new Set())
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
    const GEM_W = canvas.width * 0.64
    const LANE_W = GEM_W / 5
    const anchor = dragRef.current.snapshot.get(dragRef.current.anchorId)
    if (!anchor) return

    const newAnchorLane = Math.max(0, Math.min(4, Math.floor(cx / LANE_W)))
    const targetSec = currentTime + (HIT - cy) / scrollSpeed
    const targetTickRaw = Math.max(0, (targetSec * chart.bpm * chart.resolution) / 60)
    const snapTicks = Math.max(1, Math.round(chart.resolution / snapDivisor))
    const newAnchorTick = Math.round(targetTickRaw / snapTicks) * snapTicks

    const tickDelta = newAnchorTick - anchor.tick
    const laneDelta = newAnchorLane - anchor.lane

    const next = chart.notes.slice()
    let touched = false
    dragRef.current.snapshot.forEach((orig, idx) => {
      const cur = next[idx]
      if (!cur) return
      const proposedTick = Math.max(0, orig.tick + tickDelta)
      // Open notes (lane 7) and modifiers (5/6) only move along the time axis;
      // gem notes can also change lane within 0–4.
      const proposedLane = orig.lane > 4 ? orig.lane : Math.max(0, Math.min(4, orig.lane + laneDelta))
      if (cur.tick !== proposedTick || cur.lane !== proposedLane) {
        next[idx] = { ...cur, tick: proposedTick, lane: proposedLane }
        touched = true
      }
    })
    if (!touched) return
    // Mid-drag updates bypass the history stack — we only commit a single
    // snapshot in handleMouseUp so undo reverts the whole drag at once.
    setChart({ ...chart, notes: next })
    setDirty(true)
  }

  const handleMouseUp = () => {
    if (dragRef.current?.moved) {
      // Push a single history entry capturing the pre-drag positions so undo
      // returns the group to where the drag started.
      setChart((prev) => {
        if (!prev || !dragRef.current) return prev
        const restored = prev.notes.slice()
        dragRef.current.snapshot.forEach((orig, idx) => {
          const cur = restored[idx]
          if (cur) restored[idx] = { ...cur, tick: orig.tick, lane: orig.lane }
        })
        historyRef.current.push({ activeName: prev.activeName, notes: restored })
        if (historyRef.current.length > 100) historyRef.current.shift()
        futureRef.current = []
        setHistoryTick((n) => n + 1)
        return prev
      })
    }
    dragRef.current = null
  }

  // Keyboard
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!chart) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return

      const isCtrl = e.ctrlKey || e.metaKey

      // Undo / redo first: they don't depend on selection.
      if (isCtrl && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) redo(); else undo()
        return
      }
      if (isCtrl && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        redo()
        return
      }

      // Tool switching: 1 = select, 2 = note. Lane keys (qwert / 12345 in note
      // mode) pick the lane the next click drops into.
      if (e.key === '1' && !isCtrl) { setTool('select'); e.preventDefault(); return }
      if (e.key === '2' && !isCtrl) { setTool('note'); e.preventDefault(); return }

      if (e.code === 'Space') {
        e.preventDefault()
        const a = audioRef.current
        if (a) { if (a.paused) a.play(); else a.pause() }
        return
      }

      // Copy / cut: capture selected notes with ticks made relative to the
      // earliest selected note so paste can drop them at the playhead.
      if (isCtrl && (e.key === 'c' || e.key === 'C')) {
        if (selectedIds.size === 0) return
        const sel = Array.from(selectedIds).map((i) => chart.notes[i]).filter(Boolean)
        const minTick = Math.min(...sel.map((n) => n.tick))
        clipboardRef.current = sel.map((n) => ({ ...n, tick: n.tick - minTick }))
        e.preventDefault()
        return
      }
      if (isCtrl && (e.key === 'x' || e.key === 'X')) {
        if (selectedIds.size === 0) return
        const sel = Array.from(selectedIds).map((i) => chart.notes[i]).filter(Boolean)
        const minTick = Math.min(...sel.map((n) => n.tick))
        clipboardRef.current = sel.map((n) => ({ ...n, tick: n.tick - minTick }))
        const next = chart.notes.filter((_, i) => !selectedIds.has(i))
        commitNotes(next)
        setSelectedIds(new Set())
        e.preventDefault()
        return
      }
      if (isCtrl && (e.key === 'v' || e.key === 'V')) {
        if (clipboardRef.current.length === 0) return
        const playheadTickRaw = (currentTime * chart.bpm * chart.resolution) / 60
        const snapTicks = Math.max(1, Math.round(chart.resolution / snapDivisor))
        const baseTick = Math.max(0, Math.round(playheadTickRaw / snapTicks) * snapTicks)
        const pasted = clipboardRef.current.map((n) => ({
          ...n,
          tick: baseTick + n.tick,
        }))
        const merged = [...chart.notes, ...pasted].sort((a, b) => a.tick - b.tick || a.lane - b.lane)
        // Reselect the freshly pasted notes by identity. We tagged none so
        // identify them by membership in `pasted`.
        const pastedSet = new Set(pasted)
        commitNotes(merged)
        const newSel = new Set<number>()
        merged.forEach((n, i) => { if (pastedSet.has(n)) newSel.add(i) })
        setSelectedIds(newSel)
        e.preventDefault()
        return
      }
      if (isCtrl && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        setSelectedIds(new Set(chart.notes.map((_, i) => i)))
        return
      }

      // Selection-scoped operations below this point.
      if (selectedIds.size === 0) return
      const stepTicks = Math.max(1, Math.round(chart.resolution / snapDivisor))

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        const next = chart.notes.filter((_, i) => !selectedIds.has(i))
        commitNotes(next)
        setSelectedIds(new Set())
        return
      }

      // F / T toggle HOPO / Tap modifier on each unique tick covered by the
      // selection. A modifier (lane 5 / 6) lives at the same tick as the
      // affected gem note(s) — toggle = remove if present, add otherwise.
      if (!isCtrl && (e.key === 'f' || e.key === 'F' || e.key === 't' || e.key === 'T')) {
        e.preventDefault()
        const modLane = (e.key === 'f' || e.key === 'F') ? 5 : 6
        const ticks = new Set<number>()
        selectedIds.forEach((idx) => {
          const n = chart.notes[idx]
          if (n && n.lane <= 4) ticks.add(n.tick)  // Only fret notes can be flagged
        })
        if (ticks.size === 0) return
        const next = chart.notes.slice()
        ticks.forEach((tick) => {
          const existingIdx = next.findIndex((n) => n.tick === tick && n.lane === modLane)
          if (existingIdx >= 0) next.splice(existingIdx, 1)
          else next.push({ tick, lane: modLane, sustain: 0 })
        })
        next.sort((a, b) => a.tick - b.tick || a.lane - b.lane)
        commitNotes(next)
        return
      }

      // O converts each selected fret note (or chord cluster at one tick)
      // to an open note: remove the fret notes and any modifiers at the
      // same tick, add a single lane-7 note. Pressing O again on a selected
      // open note converts it back to a green (lane 0) note so the gesture
      // is reversible.
      if (!isCtrl && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault()
        const ticks = new Map<number, 'fret' | 'open'>()
        selectedIds.forEach((idx) => {
          const n = chart.notes[idx]
          if (!n) return
          if (n.lane === 7) ticks.set(n.tick, 'open')
          else if (n.lane <= 4) ticks.set(n.tick, ticks.get(n.tick) || 'fret')
        })
        if (ticks.size === 0) return
        let next = chart.notes.slice()
        const newSelTicks = new Set<number>()
        ticks.forEach((kind, tick) => {
          if (kind === 'fret') {
            // Drop all gem notes + modifiers at this tick, insert one open.
            const sustain = Math.max(...next.filter((n) => n.tick === tick && n.lane <= 4).map((n) => n.sustain), 0)
            next = next.filter((n) => n.tick !== tick || n.lane > 7)
            next.push({ tick, lane: 7, sustain })
          } else {
            // Convert open back to a green fret note at the same tick.
            next = next.filter((n) => !(n.tick === tick && n.lane === 7))
            next.push({ tick, lane: 0, sustain: 0 })
          }
          newSelTicks.add(tick)
        })
        next.sort((a, b) => a.tick - b.tick || a.lane - b.lane)
        commitNotes(next)
        // Re-anchor selection on the converted notes.
        const newSel = new Set<number>()
        next.forEach((n, i) => {
          if (newSelTicks.has(n.tick) && (n.lane === 7 || n.lane === 0)) newSel.add(i)
        })
        setSelectedIds(newSel)
        return
      }

      const transform = (n: ChartNote): ChartNote | null => {
        if (e.key === 'ArrowLeft') return { ...n, tick: Math.max(0, n.tick - stepTicks) }
        if (e.key === 'ArrowRight') return { ...n, tick: n.tick + stepTicks }
        if (n.lane <= 4) {
          if (e.key === 'ArrowUp') return { ...n, lane: Math.min(4, n.lane + 1) }
          if (e.key === 'ArrowDown') return { ...n, lane: Math.max(0, n.lane - 1) }
        }
        if (e.key === 'h' || e.key === 'H') return { ...n, sustain: n.sustain > 0 ? 0 : chart.resolution }
        return null
      }

      // Apply transform to all selected. If any change, commit a single
      // history entry covering the whole batch.
      let anyChanged = false
      const next = chart.notes.slice()
      selectedIds.forEach((idx) => {
        const cur = next[idx]
        if (!cur) return
        const u = transform(cur)
        if (u && (u.tick !== cur.tick || u.lane !== cur.lane || u.sustain !== cur.sustain)) {
          next[idx] = u
          anyChanged = true
        }
      })
      if (anyChanged) {
        e.preventDefault()
        commitNotes(next)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [chart, selectedIds, snapDivisor, commitNotes, undo, redo, currentTime])

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
    setSelectedIds(new Set())
    historyRef.current = []
    futureRef.current = []
    setHistoryTick((n) => n + 1)
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
      engine: 'chatterbox',
      voiceId: '',
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

  const [sceneSelectedId, setSceneSelectedId] = useState<string | null>(null)
  const [scenePickerOpen, setScenePickerOpen] = useState(false)

  const updateScene = (next: SceneEvent[]) => {
    if (!chart) return
    setChart({ ...chart, sceneEvents: next })
    setDirty(true)
  }

  const moveSceneEvent = (id: string, tick: number) => {
    if (!chart) return
    updateScene(chart.sceneEvents.map((e) => (e.id === id ? { ...e, tick } : e)))
  }

  const resizeSceneEvent = (id: string, duration: number) => {
    if (!chart) return
    updateScene(chart.sceneEvents.map((e) => (e.id === id ? { ...e, duration } : e)))
  }

  const removeSceneEvent = (id: string) => {
    if (!chart) return
    updateScene(chart.sceneEvents.filter((e) => e.id !== id))
    if (sceneSelectedId === id) setSceneSelectedId(null)
  }

  const addSceneEvent = (name: string) => {
    if (!chart) return
    const entry = SCENE_EVENT_CATALOG.find((e) => e.name === name)
    const ev: SceneEvent = {
      id: `scene-${Date.now()}`,
      tick: playheadTick,
      name,
      duration: entry?.acceptsDuration ? 384 : 0,
    }
    updateScene([...chart.sceneEvents, ev])
    setSceneSelectedId(ev.id)
    setScenePickerOpen(false)
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (sceneSelectedId === null) return
      if (e.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        removeSceneEvent(sceneSelectedId)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [sceneSelectedId, chart])

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

  // ElevenLabs voices fetched once per editor session. 503 is the "not
  // configured" path; we fall back to an empty list and the engine radio
  // will explain the situation to the user.
  interface ElVoice { voice_id: string; name: string }
  const [elVoices, setElVoices] = useState<ElVoice[]>([])
  const [elVoicesLoaded, setElVoicesLoaded] = useState(false)
  const [elVoicesError, setElVoicesError] = useState('')
  const [trackVoiceId, setTrackVoiceId] = useState('')

  useEffect(() => {
    fetch('/api/elevenlabs/voices')
      .then(async (r) => {
        if (r.status === 503) {
          setElVoicesError('ElevenLabs not configured')
          setElVoicesLoaded(true)
          return
        }
        if (!r.ok) {
          setElVoicesError(`Failed to load voices (${r.status})`)
          setElVoicesLoaded(true)
          return
        }
        const data = await r.json()
        setElVoices((data.voices || []).map((v: { voice_id: string; name: string }) => ({
          voice_id: v.voice_id, name: v.name,
        })))
        setElVoicesLoaded(true)
      })
      .catch(() => {
        setElVoicesError('Network error loading voices')
        setElVoicesLoaded(true)
      })
    fetch(`/api/tracks/${trackId}/beatmaps/${beatmapId}/elevenlabs-voice`)
      .then((r) => (r.ok ? r.json() : { voice_id: '' }))
      .then((d) => setTrackVoiceId(d.voice_id || ''))
      .catch(() => undefined)
  }, [trackId, beatmapId])

  // TTS for a VO event — POST text to backend, then assign returned file path
  const [ttsBusy, setTtsBusy] = useState<string | null>(null)
  const generateVoAudio = async (ev: TutorialVoEvent) => {
    if (!ev.text.trim()) return
    setTtsBusy(ev.id)
    try {
      let endpoint: string
      const fd = new FormData()
      fd.append('text', ev.text)
      fd.append('track_id', trackId)
      fd.append('beatmap_id', beatmapId)
      if (ev.engine === 'elevenlabs') {
        const voice = ev.voiceId || trackVoiceId
        if (!voice) {
          throw new Error('No ElevenLabs voice selected (set a track default or pick one on this VO)')
        }
        fd.append('voice_id', voice)
        endpoint = '/api/elevenlabs/synth'
      } else {
        endpoint = '/api/tutorial/tts/synth'
      }
      const res = await fetch(endpoint, { method: 'POST', body: fd })
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

  void elVoicesLoaded

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
        {/* Stacked timelines: tutorial events on top, scene events below. */}
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <div className="h-7">
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
          <div className="h-6 flex items-stretch gap-1">
            <div className="relative shrink-0">
              <button
                onClick={() => setScenePickerOpen((v) => !v)}
                className="h-full px-2 bg-emerald-700/50 hover:bg-emerald-600/60 border border-emerald-700/60 text-emerald-100 rounded text-[10px] font-medium transition-colors"
                title="Add a scene event at the playhead"
              >
                + Scene
              </button>
              {scenePickerOpen && (
                <ScenePicker
                  onPick={addSceneEvent}
                  onClose={() => setScenePickerOpen(false)}
                />
              )}
            </div>
            <div className="flex-1 min-w-0">
              {chart && duration > 0 ? (
                <SceneTimeline
                  duration={duration}
                  bpm={chart.bpm}
                  resolution={chart.resolution}
                  events={chart.sceneEvents}
                  selectedId={sceneSelectedId}
                  onSelect={setSceneSelectedId}
                  onMoveEvent={moveSceneEvent}
                  onResizeEvent={resizeSceneEvent}
                />
              ) : (
                <div className="h-full bg-gray-950 border border-gray-800 rounded" />
              )}
            </div>
          </div>
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
          <div ref={containerRef} className="relative w-full max-w-[660px]">
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
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Tools</h3>
            <div className="grid grid-cols-2 gap-1 mb-2">
              <button
                onClick={() => setTool('select')}
                className={`px-2 py-1.5 rounded text-xs font-medium transition-colors ${
                  tool === 'select'
                    ? 'bg-jam-600 text-white'
                    : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                }`}
                title="Select tool (1) — click notes, shift-click to add to selection"
              >
                ▣ Select <span className="text-[10px] opacity-60">(1)</span>
              </button>
              <button
                onClick={() => setTool('note')}
                className={`px-2 py-1.5 rounded text-xs font-medium transition-colors ${
                  tool === 'note'
                    ? 'bg-jam-600 text-white'
                    : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                }`}
                title="Note tool (2) — click on the runway to drop a note in the chosen lane"
              >
                ✚ Note <span className="text-[10px] opacity-60">(2)</span>
              </button>
            </div>
            {tool === 'note' && (
              <div className="mb-2">
                <span className="text-[11px] text-gray-500 block mb-1">Lane to drop</span>
                <div className="grid grid-cols-5 gap-1">
                  {[0, 1, 2, 3, 4].map((lane) => (
                    <button
                      key={lane}
                      onClick={() => setNoteToolLane(lane)}
                      className={`px-1 py-1.5 rounded text-[10px] font-mono transition-colors ${
                        noteToolLane === lane
                          ? 'ring-2 ring-white text-white'
                          : 'text-gray-300 hover:opacity-80'
                      }`}
                      style={{ backgroundColor: LANE_FILL[lane] }}
                      title={laneLabels[lane]}
                    >
                      {laneLabels[lane]}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setNoteToolLane(7)}
                  className={`mt-1 w-full px-1 py-1.5 rounded text-[10px] font-mono transition-colors ${
                    noteToolLane === 7
                      ? 'ring-2 ring-white text-white bg-violet-600'
                      : 'text-violet-200 hover:opacity-80 bg-violet-700/70'
                  }`}
                  title="Open note — full-width strum"
                >
                  Open (full-width)
                </button>
              </div>
            )}
            <div className="flex items-stretch gap-1">
              <button
                onClick={undo}
                disabled={historyRef.current.length === 0}
                className="flex-1 px-2 py-1 bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-gray-300 rounded text-[11px] transition-colors"
                title="Undo (Ctrl+Z)"
              >
                ↶ Undo
              </button>
              <button
                onClick={redo}
                disabled={futureRef.current.length === 0}
                className="flex-1 px-2 py-1 bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-gray-300 rounded text-[11px] transition-colors"
                title="Redo (Ctrl+Shift+Z or Ctrl+Y)"
              >
                ↷ Redo
              </button>
            </div>
            <p className="text-[10px] text-gray-600 mt-1.5 leading-snug">
              Shift-click to multi-select. Ctrl/Cmd + C/X/V copy, cut, paste at playhead. Ctrl+A selects all.
              <br />
              F = toggle force-HOPO · T = toggle tap · O = toggle open · H = toggle 1-beat sustain.
            </p>
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
                  <div className="mb-2 p-2 bg-gray-900 border border-gray-800 rounded">
                    <div className="text-[10px] text-gray-500 mb-1 uppercase tracking-wider">ElevenLabs default voice</div>
                    {elVoicesError ? (
                      <p className="text-[10px] text-gray-600">{elVoicesError}</p>
                    ) : (
                      <select
                        value={trackVoiceId}
                        onChange={async (e) => {
                          const next = e.target.value
                          setTrackVoiceId(next)
                          await fetch(`/api/tracks/${trackId}/beatmaps/${beatmapId}/elevenlabs-voice`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ voice_id: next }),
                          })
                        }}
                        className="w-full bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200"
                      >
                        <option value="">— no default —</option>
                        {elVoices.map((v) => (
                          <option key={v.voice_id} value={v.voice_id}>{v.name}</option>
                        ))}
                      </select>
                    )}
                    <p className="text-[10px] text-gray-600 mt-1 leading-snug">
                      VOs set to ElevenLabs use this voice unless overridden per-VO.
                    </p>
                  </div>
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
                          <div className="flex items-center gap-2 text-[10px] text-gray-400">
                            <label className="flex items-center gap-1 cursor-pointer">
                              <input
                                type="radio"
                                name={`engine-${ev.id}`}
                                checked={ev.engine === 'chatterbox'}
                                onChange={() => updateTutorialEvent(ev.id, { engine: 'chatterbox' })}
                                className="accent-jam-500"
                              />
                              Chatterbox
                            </label>
                            <label className="flex items-center gap-1 cursor-pointer">
                              <input
                                type="radio"
                                name={`engine-${ev.id}`}
                                checked={ev.engine === 'elevenlabs'}
                                onChange={() => updateTutorialEvent(ev.id, { engine: 'elevenlabs' })}
                                disabled={!!elVoicesError}
                                className="accent-jam-500"
                              />
                              ElevenLabs{elVoicesError ? ` (${elVoicesError})` : ''}
                            </label>
                            {ev.engine === 'elevenlabs' && (
                              <select
                                value={ev.voiceId}
                                onChange={(e) => updateTutorialEvent(ev.id, { voiceId: e.target.value })}
                                className="ml-auto bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-[10px] text-gray-200 max-w-[140px]"
                              >
                                <option value="">
                                  inherit{trackVoiceId
                                    ? ` (${(elVoices.find((v) => v.voice_id === trackVoiceId)?.name || 'track default')})`
                                    : ' (no track default)'}
                                </option>
                                {elVoices.map((v) => (
                                  <option key={v.voice_id} value={v.voice_id}>{v.name}</option>
                                ))}
                              </select>
                            )}
                          </div>
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
