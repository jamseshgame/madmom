import {
  SCENE_EVENT_CATALOG, SceneEvent, SceneEventCatalogEntry, SceneEventParam, SceneFlags,
  applySceneToFullText, entryAcceptsDuration, findCatalogEntry,
  migrateLegacySceneFlags, parseSceneEvents, parseSceneFlags,
} from './sceneEvents'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { WaveformStrip } from './WaveformStrip'
import { ImportedSourcesPanel } from './ImportedSourcesPanel'
import { ClipsLibraryPanel } from './ClipsLibraryPanel'
import { SourcePickerModal } from './SourcePickerModal'
import { GenerateTab } from './pipeline/GenerateTab'
import { importSlides, buildSlideEmitInfo, groupSlides, type SlideEvent } from '../chart/slides'

// .chart parsing ------------------------------------------------------------

interface ChartNote {
  tick: number
  lane: number       // 0-4 colored frets, 5 force-hopo, 6 tap, 7 open
  sustain: number    // sustain length in ticks (0 = single hit)
  // Slide membership. Notes sharing a slideId form one slide run; see
  // chart/slides.ts. The earliest tick is the start, the latest is the end.
  slideId?: number
  // Real-note: emit as `R` instead of `N`. Pack/scale are propagated from the
  // most recent E realnotes_pack / realnotes_scale event in the section at
  // parse time, and re-emitted as E events at serialize time when the active
  // (pack, scale) changes.
  type?: 'real'
  pack?: string
  scale?: string
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
  // Optional offsets into a collated audio file. When set, the engine plays
  // file[startMs : startMs+durationMs] instead of the whole clip — used by
  // the synthetic-tutorial generator that concats every VO into a single
  // vo/tutorial.ogg. undefined means whole-file playback.
  startMs?: number
  durationMs?: number
}

interface TutorialStepEvent {
  kind: 'step'
  id: string
  tick: number
  stepId: string         // user-facing identifier, e.g. "intro" or "chord_drill"
  required: number       // notes the player must hit to pass; 0 = no gate
  timing: TimingMode     // 'any' counts every hit, 'perfect' only perfects
  retryVo: string        // optional VO file played on fail. Typically points
                         // at the collated vo/tutorial.ogg so retry variants
                         // can live alongside section VOs as named slices.
  retryStartMs?: number  // slice offset within retryVo (when collated)
  retryDurationMs?: number
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
  // NEW — present when the event references an imported source. The engine
  // resolves audio to `sources/<source>/<stem>.ogg`. start_ms/duration_ms
  // give the slice window (mirrors VO's pattern).
  source?: string            // ImportedSource.id
  stem?: string              // default 'song'
  startMs?: number
  durationMs?: number
}

type TutorialEvent = TutorialVoEvent | TutorialStepEvent | TutorialMusicEvent

// A reference to another beatmap that this tutorial splices from.
// Stored as `[ImportedSources]` chart-section entries; the user-chosen
// `id` is stable and survives renames.
interface ImportedSource {
  id: string                 // local id — `[a-z][a-z0-9_]*`, e.g. 'src_a', 'verse_riff'
  trackId: string            // Studio-side track id
  beatmapId: string          // Studio-side beatmap id
  name: string               // display label (the source's song_name at import time)
}

// A clip = a saved [MusicSeg_<id>] section. Source-based clips
// reference an ImportedSource by its local id. Upload-based clips
// (legacy) have no sourceId.
interface Clip {
  id: string                 // matches the section name's id suffix
  sectionName: string
  name: string
  sourceId: string | null    // null = upload-based; else = ImportedSource.id
  startSec: number           // 0 for upload-based
  endSec: number             // 0 for upload-based
  notesCount: number
  bpm: number
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
  tutorialEnabled: boolean
  tutorial: TutorialEvent[]
  // Body text of every [MusicSeg_*] section. Keyed by section name; values
  // are the verbatim inner block (no braces). Round-tripped on save so
  // segment notes survive even though we don't edit them inline.
  musicSections: Record<string, string>
  importedSources: ImportedSource[]   // NEW
  clips: Clip[]                       // NEW
  sceneFlags: SceneFlags
  sceneFlagsUnknown: Record<string, string>
  sceneEvents: SceneEvent[]
  sceneEventsPassthrough: string[]
  // Section markers — `tick = E "section <name>"` rows from [Events].
  // Pulled out of sceneEventsPassthrough so the editor can edit them as
  // first-class objects; merged back at save time.
  sections: ChartSection[]
  // [SyncTrack] entries. tempoMarkers is guaranteed to be non-empty and to
  // have a marker at tick 0 (defaulted from the first marker's BPM if the
  // chart didn't carry one explicitly). timeSigs and syncOther round-trip
  // verbatim — we don't expose a UI for them but they must survive save.
  tempoMarkers: TempoMarker[]
  timeSigs: TimeSig[]
  syncOther: SyncOtherRow[]
}

interface ChartSection {
  id: string
  tick: number
  name: string
}

interface TempoMarker {
  tick: number
  microBpm: number  // BPM × 1000, the integer .chart "B" value
}

interface TimeSig {
  tick: number
  num: number
  denomPow: number  // .chart's optional second arg; denominator = 2^denomPow
}

interface SyncOtherRow {
  tick: number
  raw: string  // verbatim text after `tick = ` (e.g. "A 12345")
}

// Precomputed piecewise tempo map. `seconds` is the wall-clock time at `tick`
// given the cumulative effect of every preceding B marker. Built once per
// chart via buildTempoSegments and shared with every consumer.
interface TempoSegment {
  tick: number
  seconds: number
  microBpm: number
}

const SECTION_LINE_RE = /^\s*(\d+)\s*=\s*E\s+"section\s+([^"]*)"\s*$/

function extractSections(passthroughLines: string[]): {
  sections: ChartSection[]
  remaining: string[]
} {
  const sections: ChartSection[] = []
  const remaining: string[] = []
  let counter = 0
  for (const line of passthroughLines) {
    const m = line.match(SECTION_LINE_RE)
    if (m) {
      sections.push({
        id: `section-${m[1]}-${counter++}`,
        tick: Number(m[1]),
        name: m[2],
      })
    } else {
      remaining.push(line)
    }
  }
  sections.sort((a, b) => a.tick - b.tick)
  return { sections, remaining }
}

function sectionLines(sections: ChartSection[]): string[] {
  return sections
    .slice()
    .sort((a, b) => a.tick - b.tick)
    .map((s) => `  ${s.tick} = E "section ${s.name}"`)
}

// [SyncTrack] parsing/serialization. The block carries B (tempo), TS (time
// signature), and occasionally A (anchor) rows. We surface B as an editable
// list; TS and anything else (including A rows authored by Moonscraper/PCE)
// round-trip verbatim so we don't destroy data we don't have UI for yet.
const SYNC_TRACK_RE = /\[SyncTrack\]\s*\{([\s\S]*?)\}/

function parseSyncTrack(text: string): {
  tempoMarkers: TempoMarker[]
  timeSigs: TimeSig[]
  syncOther: SyncOtherRow[]
} {
  const tempoMarkers: TempoMarker[] = []
  const timeSigs: TimeSig[] = []
  const syncOther: SyncOtherRow[] = []
  const m = text.match(SYNC_TRACK_RE)
  if (!m) {
    tempoMarkers.push({ tick: 0, microBpm: 120000 })
    return { tempoMarkers, timeSigs, syncOther }
  }
  for (const rawLine of m[1].split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const eqIdx = line.indexOf('=')
    if (eqIdx < 0) continue
    const tickStr = line.slice(0, eqIdx).trim()
    const tick = Number(tickStr)
    if (!Number.isFinite(tick)) continue
    const rhs = line.slice(eqIdx + 1).trim()
    const bMatch = rhs.match(/^B\s+(\d+)\s*$/)
    if (bMatch) {
      tempoMarkers.push({ tick, microBpm: Number(bMatch[1]) })
      continue
    }
    const tsMatch = rhs.match(/^TS\s+(\d+)(?:\s+(\d+))?\s*$/)
    if (tsMatch) {
      timeSigs.push({
        tick,
        num: Number(tsMatch[1]),
        denomPow: tsMatch[2] !== undefined ? Number(tsMatch[2]) : 2,
      })
      continue
    }
    syncOther.push({ tick, raw: rhs })
  }
  tempoMarkers.sort((a, b) => a.tick - b.tick)
  timeSigs.sort((a, b) => a.tick - b.tick)
  if (tempoMarkers.length === 0) {
    tempoMarkers.push({ tick: 0, microBpm: 120000 })
  } else if (tempoMarkers[0].tick !== 0) {
    // Synthesize a tick-0 marker so segments always start at the song origin.
    // Use the earliest marker's BPM so wall-clock timing before that marker
    // doesn't shift the rest of the chart.
    tempoMarkers.unshift({ tick: 0, microBpm: tempoMarkers[0].microBpm })
  }
  return { tempoMarkers, timeSigs, syncOther }
}

function buildTempoSegments(markers: TempoMarker[], _resolution: number): TempoSegment[] {
  if (markers.length === 0) return [{ tick: 0, seconds: 0, microBpm: 120000 }]
  const out: TempoSegment[] = []
  let cumSec = 0
  for (let i = 0; i < markers.length; i++) {
    if (i > 0) {
      const prev = markers[i - 1]
      const dtTicks = markers[i].tick - prev.tick
      cumSec += (dtTicks / _resolution) * (60000 / prev.microBpm)
    }
    out.push({ tick: markers[i].tick, seconds: cumSec, microBpm: markers[i].microBpm })
  }
  return out
}

// tick → wall-clock seconds. Walks the segment list backwards to find the
// segment whose start tick is ≤ the query tick, then extrapolates within it
// at that segment's tempo. Constant-tempo charts hit the first segment and
// degenerate to the old (tick / resolution) * (60 / bpm) formula.
// Chart authoring rules — enforced when committing edits.
//
//   R1: At most 2 gem notes (lanes 0–4) on a single tick. Open notes (lane 7)
//       are mutually exclusive with gems at the same tick and count as 1.
//   R2: A "chord" must be exactly aligned: any two gem notes in different
//       lanes within CHORD_NEAR ticks of each other must share a tick. This
//       catches near-miss authoring slip-ups (e.g. dragging a chord partner
//       off by 1/32) without flagging legitimate fast runs at higher snap.
//
// Pure function — returns null when the chart is clean, or a human-readable
// message describing the first violation found.
function checkNoteRules(notes: ChartNote[], resolution: number): string | null {
  const CHORD_NEAR = Math.max(1, Math.round(resolution / 16))  // ≈ 1/16 beat
  // Group gem + open notes by tick. Modifiers (lanes 5/6) are skipped — they
  // attach to the underlying note and don't add to the chord count.
  const tickLanes = new Map<number, number[]>()
  for (const n of notes) {
    if (n.lane > 4 && n.lane !== 7) continue
    const arr = tickLanes.get(n.tick)
    if (arr) arr.push(n.lane); else tickLanes.set(n.tick, [n.lane])
  }
  // R1: max 2 notes per tick. An open + any gem at the same tick is a
  // gameplay-conflict (open = full strum) → also flagged.
  for (const [tick, lanes] of tickLanes) {
    if (lanes.length > 2) {
      return `Max 2 notes per beat (tick ${tick} has ${lanes.length})`
    }
    if (lanes.length === 2 && lanes.includes(7)) {
      return `Open notes can't be chorded with gems (tick ${tick})`
    }
  }
  // R2: near-miss chord check. Walk gem notes in tick order — any two within
  // CHORD_NEAR ticks that are NOT at the same tick are a misaligned chord.
  const gems = notes
    .filter((n) => n.lane <= 4)
    .map((n) => ({ tick: n.tick, lane: n.lane }))
    .sort((a, b) => a.tick - b.tick)
  for (let i = 0; i < gems.length; i++) {
    for (let j = i + 1; j < gems.length; j++) {
      const a = gems[i], b = gems[j]
      const gap = b.tick - a.tick
      if (gap === 0) continue          // same-tick chord — counted by R1
      if (gap >= CHORD_NEAR) break     // sorted: nothing closer further on
      if (b.lane !== a.lane) {
        return `Chord notes must share a tick (ticks ${a.tick} and ${b.tick} are too close)`
      }
    }
  }
  return null
}

function tickToSec(segs: TempoSegment[], resolution: number, tick: number): number {
  if (tick <= 0 || segs.length === 0) return 0
  let i = segs.length - 1
  while (i > 0 && segs[i].tick > tick) i--
  const seg = segs[i]
  const dt = tick - seg.tick
  return seg.seconds + (dt / resolution) * (60000 / seg.microBpm)
}

function secToTick(segs: TempoSegment[], resolution: number, sec: number): number {
  if (sec <= 0 || segs.length === 0) return 0
  let i = segs.length - 1
  while (i > 0 && segs[i].seconds > sec) i--
  const seg = segs[i]
  const ds = sec - seg.seconds
  const dt = (ds * seg.microBpm * resolution) / 60000
  return Math.max(0, Math.round(seg.tick + dt))
}

function applySyncTrackToFullText(
  fullText: string,
  tempoMarkers: TempoMarker[],
  timeSigs: TimeSig[],
  syncOther: SyncOtherRow[],
): string {
  type Row = { tick: number; sortKind: 0 | 1 | 2; text: string }
  const rows: Row[] = []
  for (const ts of timeSigs) {
    const text = ts.denomPow === 2 ? `TS ${ts.num}` : `TS ${ts.num} ${ts.denomPow}`
    rows.push({ tick: ts.tick, sortKind: 0, text })
  }
  for (const b of tempoMarkers) {
    rows.push({ tick: b.tick, sortKind: 1, text: `B ${b.microBpm}` })
  }
  for (const o of syncOther) {
    rows.push({ tick: o.tick, sortKind: 2, text: o.raw })
  }
  rows.sort((a, b) => (a.tick - b.tick) || (a.sortKind - b.sortKind))
  const body = rows.map((r) => `  ${r.tick} = ${r.text}`).join('\n')
  const block = `[SyncTrack]\n{\n${body}\n}`
  if (SYNC_TRACK_RE.test(fullText)) {
    return fullText.replace(SYNC_TRACK_RE, block)
  }
  const eventsIdx = fullText.indexOf('[Events]')
  if (eventsIdx >= 0) {
    return fullText.slice(0, eventsIdx) + block + '\n' + fullText.slice(eventsIdx)
  }
  return fullText + (fullText.endsWith('\n') ? '' : '\n') + block + '\n'
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
    // A section counts as a "note section" if it has any playable note —
    // N (regular) or R (real-note). Real-notes-only sections (e.g. the
    // realnote acid test) wouldn't otherwise show up in the difficulty
    // picker.
    if (/^\s*\d+\s*=\s*[NR]\s+/m.test(m[2])) out.push(m[1])
  }
  return out
}

function parseSectionNotes(text: string, name: string, resolution: number): ChartNote[] {
  const start = text.indexOf(`[${name}]`)
  if (start === -1) return []
  const open = text.indexOf('{', start)
  const close = text.indexOf('}', open)
  if (open === -1 || close === -1) return []
  const inner = text.slice(open + 1, close)
  // Walk in tick-stable order, propagating active (pack, scale) state from
  // E realnotes_pack / E realnotes_scale events into each R note. Lines at
  // the same tick keep their source order so a declaration written before
  // its R note applies to it.
  type RawLine =
    | { tick: number; kind: 'note' | 'realnote'; lane: number; sustain: number }
    | { tick: number; kind: 'pack' | 'scale'; value: string }
  const raws: { i: number; line: RawLine }[] = []
  const slideEvents: SlideEvent[] = []
  let i = 0
  for (const raw of inner.split('\n')) {
    i++
    const t = raw.trim()
    if (!t) continue
    let m = t.match(/^(\d+)\s*=\s*N\s+(\d+)\s+(\d+)/)
    if (m) { raws.push({ i, line: { tick: Number(m[1]), kind: 'note', lane: Number(m[2]), sustain: Number(m[3]) } }); continue }
    m = t.match(/^(\d+)\s*=\s*R\s+(\d+)\s+(\d+)/)
    if (m) { raws.push({ i, line: { tick: Number(m[1]), kind: 'realnote', lane: Number(m[2]), sustain: Number(m[3]) } }); continue }
    m = t.match(/^(\d+)\s*=\s*E\s+realnotes_pack\s+(\S+)/)
    if (m) { raws.push({ i, line: { tick: Number(m[1]), kind: 'pack', value: m[2] } }); continue }
    m = t.match(/^(\d+)\s*=\s*E\s+realnotes_scale\s+(\S+)/)
    if (m) { raws.push({ i, line: { tick: Number(m[1]), kind: 'scale', value: m[2] } }); continue }
    m = t.match(/^(\d+)\s*=\s*E\s+slide\s+(\d+)/)
    if (m) { slideEvents.push({ tick: Number(m[1]), fret: Number(m[2]) }); continue }
  }
  raws.sort((a, b) => a.line.tick - b.line.tick || a.i - b.i)
  let activePack: string | undefined
  let activeScale: string | undefined
  const notes: ChartNote[] = []
  for (const { line: r } of raws) {
    if (r.kind === 'pack') activePack = r.value
    else if (r.kind === 'scale') activeScale = r.value
    else if (r.kind === 'note') notes.push({ tick: r.tick, lane: r.lane, sustain: r.sustain })
    else if (r.kind === 'realnote') notes.push({
      tick: r.tick, lane: r.lane, sustain: r.sustain,
      type: 'real', pack: activePack, scale: activeScale,
    })
  }
  return importSlides(notes, slideEvents, resolution)
}

// Slice a source beatmap's notes into a [MusicSeg_<id>] section body.
// Hard clip (notes whose start tick is in [inTick, outTick) get
// included), sustains trimmed at outTick, active (pack, scale) state
// from the source section prepended at tick 0. Variable-tempo within
// a clip not supported (notes renormalised linearly using the local
// tempo at startSec).
function sliceSourceChartForClip(
  sourceNotes: ChartNote[],
  sourceTempoSegments: TempoSegment[],
  sourceResolution: number,
  startSec: number,
  endSec: number,
): { sectionBody: string; notesCount: number; bpm: number } {
  const inTick = secToTick(sourceTempoSegments, sourceResolution, startSec)
  const outTick = secToTick(sourceTempoSegments, sourceResolution, endSec)
  const sorted = [...sourceNotes].sort((a, b) => a.tick - b.tick || a.lane - b.lane)

  let preludePack: string | undefined
  let preludeScale: string | undefined
  for (const n of sorted) {
    if (n.tick > inTick) break
    if (n.type === 'real') {
      if (n.pack) preludePack = n.pack
      if (n.scale) preludeScale = n.scale
    }
  }

  const sliced: ChartNote[] = []
  for (const n of sorted) {
    if (n.tick < inTick) continue
    if (n.tick >= outTick) break
    const newTick = n.tick - inTick
    const newSustain = n.tick + n.sustain > outTick ? outTick - n.tick : n.sustain
    sliced.push({ ...n, tick: newTick, sustain: newSustain })
  }

  const lines: string[] = []
  if (preludePack) lines.push(`  0 = E realnotes_pack ${preludePack}`)
  if (preludeScale) lines.push(`  0 = E realnotes_scale ${preludeScale}`)
  let curPack = preludePack
  let curScale = preludeScale
  for (const n of sliced) {
    if (n.type === 'real') {
      if (n.pack && n.pack !== curPack) {
        lines.push(`  ${n.tick} = E realnotes_pack ${n.pack}`)
        curPack = n.pack
      }
      if (n.scale && n.scale !== curScale) {
        lines.push(`  ${n.tick} = E realnotes_scale ${n.scale}`)
        curScale = n.scale
      }
      lines.push(`  ${n.tick} = R ${n.lane} ${n.sustain}`)
    } else {
      lines.push(`  ${n.tick} = N ${n.lane} ${n.sustain}`)
    }
  }

  let microBpm = sourceTempoSegments[0]?.microBpm ?? 120000
  for (const seg of sourceTempoSegments) {
    if (seg.seconds > startSec) break
    microBpm = seg.microBpm
  }

  return {
    sectionBody: '\n' + lines.join('\n') + '\n',
    notesCount: sliced.filter((n) => n.lane <= 4 || n.lane === 7).length,
    bpm: microBpm / 1000,
  }
}

function emitNoteSectionLines(notes: ChartNote[]): string[] {
  // Sort by tick then lane, walking the active (pack, scale) state. Emit E
  // events when state changes — they always precede the R note that triggered
  // the change, so the reader sees the declaration first.
  const sorted = [...notes].sort((a, b) => a.tick - b.tick || a.lane - b.lane)
  const slideRoles = buildSlideEmitInfo(notes)
  let activePack: string | undefined
  let activeScale: string | undefined
  const out: string[] = []
  for (const n of sorted) {
    const role = slideRoles.get(n)
    if (role) {
      // start -> E slide only · middle -> N + E slide · end -> N only
      if (role !== 'start') out.push(`  ${n.tick} = N ${n.lane} 0`)
      if (role !== 'end') out.push(`  ${n.tick} = E slide ${n.lane}`)
      continue
    }
    if (n.type === 'real') {
      if (n.pack && n.pack !== activePack) {
        out.push(`  ${n.tick} = E realnotes_pack ${n.pack}`)
        activePack = n.pack
      }
      if (n.scale && n.scale !== activeScale) {
        out.push(`  ${n.tick} = E realnotes_scale ${n.scale}`)
        activeScale = n.scale
      }
      out.push(`  ${n.tick} = R ${n.lane} ${n.sustain}`)
    } else {
      out.push(`  ${n.tick} = N ${n.lane} ${n.sustain}`)
    }
  }
  return out
}

function replaceSectionNotes(text: string, name: string, notes: ChartNote[]): string {
  const start = text.indexOf(`[${name}]`)
  // Section doesn't exist yet — empty difficulties fall through here. Append
  // the new block (with whatever notes have been authored) to the end so a
  // fresh-difficulty edit survives the round-trip.
  if (start === -1) {
    if (notes.length === 0) return text
    const block = `[${name}]\n{\n${emitNoteSectionLines(notes).join('\n')}\n}\n`
    return text.trimEnd() + '\n' + block
  }
  const open = text.indexOf('{', start)
  const close = text.indexOf('}', open)
  if (open === -1 || close === -1) return text
  const inner = text.slice(open + 1, close)
  // Strip everything we re-emit: N + R note lines and E realnotes_* events.
  // Other E events, S star power, and A anchors pass through. E slide is owned by the model.
  const keptLines = inner
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => {
      const t = l.trim()
      if (!t) return false
      if (/^\d+\s*=\s*[NR]\s+/.test(t)) return false
      if (/^\d+\s*=\s*E\s+realnotes_(pack|scale)\b/.test(t)) return false
      // E slide lines are now owned by the model (emitted by emitNoteSectionLines).
      if (/^\d+\s*=\s*E\s+slide\b/.test(t)) return false
      return true
    })
  const newLines = emitNoteSectionLines(notes)
  const combined = [...keptLines, ...newLines].sort((a, b) => {
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
      let startMsArg: number | undefined
      let durationMsArg: number | undefined
      for (const t of tokens.slice(2)) {
        if (t.startsWith('text=')) textArg = t.slice(5)
        else if (t.startsWith('engine=')) {
          const v = t.slice(7).toLowerCase()
          if (v === 'elevenlabs' || v === 'chatterbox') engineArg = v
        }
        else if (t.startsWith('voice=')) voiceArg = t.slice(6)
        else if (t.startsWith('start_ms=')) {
          const n = Number(t.slice(9))
          if (Number.isFinite(n) && n >= 0) startMsArg = n
        }
        else if (t.startsWith('duration_ms=')) {
          const n = Number(t.slice(12))
          if (Number.isFinite(n) && n >= 0) durationMsArg = n
        }
      }
      events.push({
        kind: 'vo',
        id: `vo-${tick}-${counter++}`,
        tick,
        file,
        text: textArg,
        engine: engineArg,
        voiceId: voiceArg,
        startMs: startMsArg,
        durationMs: durationMsArg,
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
        retryStartMs: fields.retry_start_ms !== undefined ? Number(fields.retry_start_ms) : undefined,
        retryDurationMs: fields.retry_duration_ms !== undefined ? Number(fields.retry_duration_ms) : undefined,
        next: fields.next || '',
      })
    } else if (kind === 'MUSIC') {
      // Source-based events lead with `source="..."`; legacy upload-based
      // events lead with a bare quoted file path. Detect by whether
      // tokens[1] contains `=` to decide where the file slot is.
      const isSourceBased = (tokens[1] ?? '').includes('=')
      const file = isSourceBased ? '' : (tokens[1] || '')
      const fields: Record<string, string> = {}
      for (const t of tokens.slice(isSourceBased ? 1 : 2)) {
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
        source: fields.source || undefined,
        stem: fields.stem || undefined,
        startMs: fields.start_ms !== undefined ? Number(fields.start_ms) : undefined,
        durationMs: fields.duration_ms !== undefined ? Number(fields.duration_ms) : undefined,
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

function parseImportedSources(text: string): ImportedSource[] {
  const m = text.match(/\[ImportedSources\]\s*\{([^}]*)\}/)
  if (!m) return []
  const body = m[1]
  const out: ImportedSource[] = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith(';')) continue
    // <id> = track="..." beatmap="..." name="..."
    const idM = line.match(/^([a-z][a-z0-9_]*)\s*=/)
    if (!idM) continue
    const id = idM[1]
    const trackM = line.match(/track="([^"]*)"/)
    const beatmapM = line.match(/beatmap="([^"]*)"/)
    const nameM = line.match(/name="((?:[^"\\]|\\.)*)"/)
    if (!trackM || !beatmapM) continue
    out.push({
      id,
      trackId: trackM[1],
      beatmapId: beatmapM[1],
      name: nameM ? nameM[1].replace(/\\"/g, '"') : id,
    })
  }
  return out
}

function serializeImportedSources(sources: ImportedSource[]): string {
  if (sources.length === 0) return ''
  const lines = sources.map((s) =>
    `  ${s.id} = track="${s.trackId}" beatmap="${s.beatmapId}" name="${s.name.replace(/"/g, '\\"')}"`,
  )
  return `[ImportedSources]\n{\n${lines.join('\n')}\n}\n`
}

function parseClipMetadata(body: string): { name: string; sourceId: string | null; startSec: number; endSec: number } | null {
  const m = body.match(
    /;\s*(?:source="([^"]*)"\s+)?start_sec=([\d.]+)\s+end_sec=([\d.]+)\s+name="((?:[^"\\]|\\.)*)"/,
  )
  if (!m) return null
  return {
    sourceId: m[1] || null,
    startSec: Number(m[2]),
    endSec: Number(m[3]),
    name: m[4].replace(/\\"/g, '"'),
  }
}

function deriveClips(
  musicSections: Record<string, string>,
  events: TutorialEvent[],
): Clip[] {
  const out: Clip[] = []
  for (const [sectionName, body] of Object.entries(musicSections)) {
    const meta = parseClipMetadata(body)
    const ev = events.find(
      (e): e is TutorialMusicEvent => e.kind === 'music' && e.sectionName === sectionName,
    )
    const id = sectionName.replace(/^MusicSeg_/, '')
    const noteLines = body.split('\n').filter((l) => /^\s*\d+\s*=\s*[NR]\s+/.test(l))
    out.push({
      id,
      sectionName,
      name: meta?.name ?? (ev?.file?.split('/').pop() ?? sectionName),
      sourceId: meta?.sourceId ?? ev?.source ?? null,
      startSec: meta?.startSec ?? 0,
      endSec: meta?.endSec ?? 0,
      notesCount: noteLines.length,
      bpm: ev?.bpm ?? 120,
    })
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
      // start_ms / duration_ms are emitted right after the file path, before
      // free-form fields like text=, so engine parsers can short-circuit on
      // the offset before scanning the rest of the line.
      const startMs = e.startMs !== undefined ? ` start_ms=${e.startMs}` : ''
      const durationMs = e.durationMs !== undefined ? ` duration_ms=${e.durationMs}` : ''
      return `  ${e.tick} = VO "${e.file}"${startMs}${durationMs}${t}${engine}${voice}`
    }
    if (e.kind === 'step') {
      const retryAttrs = e.retryVo
        ? ` retry_vo="${e.retryVo}"`
          + (e.retryStartMs !== undefined ? ` retry_start_ms=${e.retryStartMs}` : '')
          + (e.retryDurationMs !== undefined ? ` retry_duration_ms=${e.retryDurationMs}` : '')
        : ''
      return (
        `  ${e.tick} = STEP "${e.stepId}" required=${e.required} timing=${e.timing}`
        + retryAttrs
        + (e.next ? ` next="${e.next}"` : '')
      )
    }
    if (e.kind === 'music') {
      // Source-based events use `source="..."` + slice fields; legacy
      // upload-based events still emit `file="..."`. Both shapes coexist.
      const head = e.source
        ? `source="${e.source}" stem="${e.stem || 'song'}"`
        : `"${e.file}"`
      return (
        `  ${e.tick} = MUSIC ${head} section="${e.sectionName}"`
        + (e.startMs !== undefined ? ` start_ms=${e.startMs}` : '')
        + (e.durationMs !== undefined ? ` duration_ms=${e.durationMs}` : '')
        + ` bpm=${e.bpm.toFixed(2)} resolution=${e.resolution}`
        + ` duration=${e.durationSeconds.toFixed(2)} notes=${e.notesCount}`
        + ` required=${e.required} timing=${e.timing}`
        + (e.retryVo ? ` retry_vo="${e.retryVo}"` : '')
        + (e.next ? ` next="${e.next}"` : '')
      )
    }
    return ''
  })
  return `[TutorialScript]\n{\n${lines.join('\n')}\n}\n`
}

function serializeMusicSections(
  musicSections: Record<string, string>,
  events: TutorialEvent[],
  clips: Clip[],
): string {
  // Only emit sections referenced by an active MUSIC event, so deleting an
  // event also drops its body on save instead of leaving orphans behind.
  const referenced = new Set(
    events.filter((e): e is TutorialMusicEvent => e.kind === 'music').map((e) => e.sectionName),
  )
  const out: string[] = []
  for (const [sectionName, body] of Object.entries(musicSections)) {
    if (!referenced.has(sectionName)) continue
    const clip = clips.find((c) => c.sectionName === sectionName)
    let prefix = ''
    if (clip && (clip.sourceId || clip.startSec > 0 || clip.endSec > 0 || clip.name !== sectionName)) {
      const sourceFrag = clip.sourceId ? `source="${clip.sourceId}" ` : ''
      prefix = `\n  ; ${sourceFrag}start_sec=${clip.startSec.toFixed(3)} end_sec=${clip.endSec.toFixed(3)} name="${clip.name.replace(/"/g, '\\"')}"\n`
      const stripped = body.replace(/^\n?\s*;\s*(?:source="[^"]*"\s+)?start_sec=[\d.]+\s+end_sec=[\d.]+\s+name="[^"]*"\s*\n?/, '\n')
      out.push(`[${sectionName}]\n{${prefix.trimEnd()}${stripped}}\n`)
    } else {
      out.push(`[${sectionName}]\n{${body}}\n`)
    }
  }
  return out.join('')
}

function applyTutorialToFullText(
  fullText: string,
  events: TutorialEvent[],
  enabled: boolean,
  musicSections: Record<string, string>,
  importedSources: ImportedSource[],
  clips: Clip[],
): string {
  // Strip [ImportedSources], [TutorialScript] and any [MusicSeg_*] sections —
  // we re-emit them from in-memory state so they stay in sync.
  let stripped = fullText.replace(/\[ImportedSources\]\s*\{[^}]*\}\s*/g, '')
  stripped = stripped.replace(/\[TutorialScript\]\s*\{[^}]*\}\s*/g, '')
  stripped = stripped.replace(/\[MusicSeg_[A-Za-z0-9_-]+\]\s*\{[^}]*\}\s*/g, '')
  if (!enabled || events.length === 0) {
    const srcBlock = serializeImportedSources(importedSources)
    return stripped.trimEnd() + (srcBlock ? '\n' + srcBlock : '') + '\n'
  }
  const importedSourcesBlock = serializeImportedSources(importedSources)
  const newSection = serializeTutorialSection(events)
  const musicBlocks = serializeMusicSections(musicSections, events, clips)
  // [ImportedSources] comes BEFORE [TutorialScript] so source declarations
  // appear before the events that reference them.
  return stripped.trimEnd() + '\n' + (importedSourcesBlock ? importedSourcesBlock : '') + newSection + (musicBlocks ? musicBlocks : '')
}

// Camera state for the 3D-perspective preview. Stored in localStorage so the
// user's preferred framing carries across sessions and beatmaps.
interface View3DState {
  enabled: boolean
  angleDeg: number       // tilt of the runway away from the viewer (0 = flat 2D)
  perspectivePx: number  // CSS perspective distance — smaller = stronger foreshortening
  depthPx: number        // translateZ — pulls the runway toward (+) or away (-) from camera
  liftPx: number         // translateY — nudges the strike line up/down on screen
  horizonFade: number    // 0..1, opacity of the top-edge fade-to-black overlay
  meshName: string       // filename of selected gem mesh from /api/gem-meshes; '' = flat 2D circles
  meshScale: number      // size multiplier for the rendered gem (1.0 = baseline ~32 px diameter)
  meshSpinDegPerSec: number  // optional auto-rotation around the up axis (0 = static)
  explosionScale: number     // size multiplier for the GemExplosion shard cluster (1.0 = matches gem size)
  ghostRestY: number     // ghost gem resting height (× baseGemSize) — sits above the strike
  ghostDropRange: number // how far the ghost falls when pressed (× baseGemSize). Pressed Y = rest - range
  highwayTexture: string         // filename of selected texture from /api/highway-textures; '' = plain dark plane
  highwayScroll: boolean         // animate the texture toward the camera at the same rate as gems
  highwayTint: string            // CSS hex (#RRGGBB) applied as a coloured overlay on the texture
  highwayTintOpacity: number     // 0..1, overlay opacity
  laneSeparators: boolean        // draw lines between lanes on the floor plane
  laneSeparatorColor: string     // CSS hex for the separator lines
  laneSeparatorWidth: number     // line thickness in world units (0.02 = thin, 0.1 = chunky)
  laneSeparatorGlow: number      // 0..1, outer-glow halo intensity around each separator
  // ── Battle mode debuffs — gimmick visual states layered on top of the
  // normal 3D scene so a single chart can throw them at the player during
  // gameplay. All default off.
  battleReverseScroll: boolean   // texture scrolls AWAY from the camera instead of toward it
  battleInkSplatter: boolean     // jet-black highway, no separators, glossy black gems
}

const VIEW3D_DEFAULT: View3DState = {
  enabled: false,
  angleDeg: 55,
  perspectivePx: 900,
  depthPx: 0,
  liftPx: 0,
  horizonFade: 0.55,
  meshName: '',
  meshScale: 1.0,
  meshSpinDegPerSec: 60,
  explosionScale: 1.0,
  ghostRestY: 1.5,
  ghostDropRange: 1.0,
  highwayTexture: '',
  highwayScroll: true,
  highwayTint: '#000000',
  highwayTintOpacity: 0.0,
  laneSeparators: true,
  laneSeparatorColor: '#FFFFFF',
  laneSeparatorWidth: 0.025,
  laneSeparatorGlow: 0.3,
  battleReverseScroll: false,
  battleInkSplatter: false,
}

interface GemMeshInfo {
  name: string
  stem: string
  ext: string
  size_bytes: number
}

// Same shape as GemMeshInfo, but kept as a separate type for clarity. The
// frontend lists them in a dropdown and the 3D layer loads the selected one
// as a tiled texture on the runway floor.
interface HighwayTextureInfo {
  name: string
  stem: string
  ext: string
  size_bytes: number
}

function loadView3d(): View3DState {
  try {
    const raw = localStorage.getItem('editor.view3d')
    if (!raw) return VIEW3D_DEFAULT
    const parsed = JSON.parse(raw) as Partial<View3DState>
    return { ...VIEW3D_DEFAULT, ...parsed }
  } catch {
    return VIEW3D_DEFAULT
  }
}

// Shape returned by /api/scene-events/types (Pydantic snake_case dump).
interface RawCustomType {
  name: string
  item_label: string
  group_label: string
  description: string
  param: SceneEventParam
}

function adaptCustomType(raw: RawCustomType): SceneEventCatalogEntry {
  return {
    name: raw.name,
    group: 'custom',
    groupLabel: raw.group_label || 'Custom',
    itemLabel: raw.item_label || raw.name,
    description: raw.description || '',
    param: raw.param,
    builtin: false,
  }
}

function defaultValueForParam(p: SceneEventParam | undefined): string {
  if (!p) return ''
  if (p.type === 'hex_color') return '#FFFFFF'
  if (p.type === 'enum') return p.options[0] || ''
  if (p.type === 'number') {
    if (typeof p.min === 'number') return String(p.min)
    return '0'
  }
  return ''
}

function parseChart(text: string, prefer?: string, customNames: Set<string> = new Set()): ChartState {
  const resMatch = text.match(/Resolution\s*=\s*(\d+)/)
  const resolution = resMatch ? Number(resMatch[1]) : 192
  const nameMatch = text.match(/Name\s*=\s*"([^"]*)"/)
  const songName = nameMatch ? nameMatch[1] : 'Untitled'
  const { tempoMarkers, timeSigs, syncOther } = parseSyncTrack(text)
  // Legacy chart.bpm/bpmRaw expose the tick-0 tempo for tooltips and the
  // approximate beat-grid in the timeline strips. Tempo-aware playback and
  // canvas timing use tempoMarkers/buildTempoSegments instead.
  const bpmRaw = tempoMarkers[0].microBpm
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
  // Fresh chart with no difficulty sections yet — start the user on Easy so
  // there's always a current target. The first save creates the section.
  if (!activeName) activeName = 'EasySingle'

  const notes = activeName ? parseSectionNotes(text, activeName, resolution) : []
  const tutorial = parseTutorialSection(text)
  const musicSections = parseMusicSections(text)
  const importedSources = parseImportedSources(text)
  const clips = deriveClips(musicSections, tutorial)
  const scene = parseSceneFlags(text)
  const sceneEventsParsed = parseSceneEvents(text, customNames)
  // Legacy [Scene] flags → tick-based events. Span from tick 0 to the active
  // difficulty's last note + sustain so the migrated cue covers the song.
  const endTick = notes.reduce((m, n) => Math.max(m, n.tick + (n.sustain || 0)), 0)
  const migrated = migrateLegacySceneFlags(scene.flags, endTick)
  const mergedSceneEvents = [...sceneEventsParsed.events, ...migrated.events]
  // Pre-flip tutorial mode on whenever the chart already carries a
  // [TutorialScript] section (even an empty one). The blank-tutorial flow
  // and the empty-beatmap-with-tutorial flow both emit an empty section
  // for exactly this reason — so the user doesn't have to tick the
  // sidebar checkbox before adding their first VO/STEP.
  const tutorialEnabled = tutorial.length > 0 || hasTutorialSection(text)
  const { sections: chartSections, remaining: passthroughWithoutSections } =
    extractSections(sceneEventsParsed.passthroughLines)
  return {
    fullText: text, resolution, bpm, bpmRaw, songName,
    availableSections, activeName, notes,
    tutorialEnabled, tutorial, musicSections, importedSources, clips,
    sceneFlags: migrated.clearedFlags,
    sceneFlagsUnknown: scene.unknownKeys,
    sceneEvents: mergedSceneEvents,
    sceneEventsPassthrough: passthroughWithoutSections,
    sections: chartSections,
    tempoMarkers, timeSigs, syncOther,
  }
}

// Lane colors (Guitar Hero) -------------------------------------------------

const LANE_FILL = ['#22c55e', '#ef4444', '#eab308', '#3b82f6', '#f97316'] // 0-4
const GUITAR_LABELS = ['Green', 'Red', 'Yellow', 'Blue', 'Orange']
// 5-lane Jamsesh drums convention (kick, snare, hi-hat, tom, cymbal)
const DRUM_LABELS = ['Kick', 'Snare', 'Hi-hat', 'Tom', 'Cymbal']

const SNAP_OPTIONS = [
  { label: '1/4', divisor: 1 },
  { label: '1/8', divisor: 2 },
  { label: '1/16', divisor: 4 },
  { label: '1/32', divisor: 8 },
] as const

// Draw each slide as a diagonal ribbon: a thick, semi-transparent segment
// between consecutive slide positions, coloured by the lane it leaves.
function drawSlideRibbons(
  ctx: CanvasRenderingContext2D,
  notes: ChartNote[],
  o: {
    laneFill: string[]
    gemX0: number
    laneW: number
    hit: number
    scrollSpeed: number
    currentTime: number
    t2s: (tick: number) => number
    selectedSlideIds: Set<number>
  },
): void {
  const laneX = (lane: number) => o.gemX0 + (lane + 0.5) * o.laneW
  const tickY = (tick: number) => o.hit - (o.t2s(tick) - o.currentTime) * o.scrollSpeed
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const [sid, group] of groupSlides(notes)) {
    const byTick = new Map<number, number[]>()
    for (const n of group) {
      const f = byTick.get(n.tick)
      if (f) f.push(n.lane)
      else byTick.set(n.tick, [n.lane])
    }
    const ticks = [...byTick.keys()].sort((a, b) => a - b)
    if (ticks.length < 2) continue
    for (const f of byTick.values()) f.sort((a, b) => a - b)
    const maxFrets = Math.max(...ticks.map((t) => byTick.get(t)!.length))
    const selected = o.selectedSlideIds.has(sid)
    for (let r = 0; r < maxFrets; r++) {
      for (let i = 0; i + 1 < ticks.length; i++) {
        const fa = byTick.get(ticks[i])!
        const fb = byTick.get(ticks[i + 1])!
        const laneA = fa[Math.min(r, fa.length - 1)]
        const laneB = fb[Math.min(r, fb.length - 1)]
        ctx.beginPath()
        ctx.moveTo(laneX(laneA), tickY(ticks[i]))
        ctx.lineTo(laneX(laneB), tickY(ticks[i + 1]))
        ctx.strokeStyle = o.laneFill[laneA] + (selected ? 'ff' : '88')
        ctx.lineWidth = o.laneW * (selected ? 0.46 : 0.4)
        ctx.stroke()
      }
    }
  }
}

interface BeatmapMeta {
  name: string
  stem: string
  hasAlbumArt: boolean
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
  tempoSegments: TempoSegment[]
  resolution: number
  events: TutorialEvent[]
  snapDivisor: number
  onSeek: (sec: number) => void
  onMoveEvent: (id: string, tick: number) => void
  view: { start: number; end: number }
  onViewChange: (v: { start: number; end: number }) => void
}

function TutorialTimeline({
  duration,
  currentTime,
  tempoSegments,
  resolution,
  events,
  snapDivisor,
  onSeek,
  onMoveEvent,
  view,
  onViewChange,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  const dragRef = useRef<{ id: string; offset: number; lastTick: number } | null>(null)
  const [scrubbing, setScrubbing] = useState(false)

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
  const tToSec = (t: number) => tickToSec(tempoSegments, resolution, t)
  const sToTick = (s: number) => secToTick(tempoSegments, resolution, s)
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
      onViewChange({ start: Math.max(0, s), end: Math.min(duration, en) })
      return
    }
    // Wheel → zoom around cursor
    const factor = e.deltaY > 0 ? 1.25 : 0.8
    const newSpan = Math.max(1.0, Math.min(duration, span * factor))
    const ratio = (cursorSec - view.start) / span
    const newStart = Math.max(0, Math.min(duration - newSpan, cursorSec - ratio * newSpan))
    onViewChange({ start: newStart, end: newStart + newSpan })
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
      const rawTick = sToTick(Math.max(0, targetSec))
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
  }, [scrubbing, view.start, view.end, width, duration, resolution, snapDivisor, tempoSegments])

  // Beat-line ticks: draw a light line every beat when there's room. Variable
  // tempo would make the grid non-uniform — for now we use the tick-0 BPM as
  // a visual approximation. The event bands themselves use the full tempo
  // map for positioning, so they stay accurate across mid-song tempo changes.
  const firstBpm = (tempoSegments[0]?.microBpm ?? 120000) / 1000
  const beatSpacingSec = 60 / Math.max(1, firstBpm)
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
        const startSec = tToSec(ev.tick)
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
  tempoSegments: TempoSegment[]
  resolution: number
  events: SceneEvent[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onMoveEvent: (id: string, tick: number) => void
  onResizeEvent: (id: string, duration: number) => void
}

function SceneTimeline({
  duration, tempoSegments, resolution, events,
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
  const tToSec = (t: number) => tickToSec(tempoSegments, resolution, t)
  const sToTick = (s: number) => secToTick(tempoSegments, resolution, s)
  const secToX = (s: number) => (s / span) * width
  const xToSec = (x: number) => (x / Math.max(1, width)) * span

  const handleMouseMove = (e: React.MouseEvent) => {
    const drag = dragRef.current
    if (!drag) return
    const rect = containerRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    if (drag.kind === 'move') {
      const sec = Math.max(0, Math.min(duration, xToSec(x - drag.offset)))
      onMoveEvent(drag.id, sToTick(sec))
    } else {
      const ev = events.find((e) => e.id === drag.id)
      if (!ev) return
      const cursorTick = sToTick(Math.max(0, xToSec(x)))
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
        const startSec = tToSec(ev.tick)
        const endSec = tToSec(ev.tick + ev.duration)
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
  catalog, onPick, onClose, onCreateType,
}: {
  catalog: SceneEventCatalogEntry[]
  onPick: (name: string) => void
  onClose: () => void
  onCreateType: () => void
}) {
  // Group catalog by group label, preserving catalog order so the builtin
  // sections (Controller L/R, Highway…) stay in their established positions.
  const groups: { label: string; entries: SceneEventCatalogEntry[] }[] = []
  for (const entry of catalog) {
    const last = groups[groups.length - 1]
    if (last && last.label === entry.groupLabel) last.entries.push(entry)
    else groups.push({ label: entry.groupLabel, entries: [entry] })
  }
  return (
    <div
      className="absolute top-full left-0 mt-1 w-72 max-h-96 overflow-y-auto bg-gray-900 border border-gray-700 rounded-md shadow-2xl z-[80] p-1.5 space-y-1.5"
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
                title={`${e.name}${e.description ? '\n\n' + e.description : ''}`}
              >
                {e.itemLabel}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="sticky bottom-0 -mb-1.5 -mx-1.5 px-1.5 pt-2 pb-1.5 border-t border-gray-700 bg-gray-900">
        <button
          onClick={onCreateType}
          className="w-full px-2 py-1 bg-emerald-700/70 hover:bg-emerald-600 text-white rounded text-[11px] font-medium"
          title="Register a new scene event type — generates a handover doc for the Unity engineer."
        >
          + New scene event type…
        </button>
      </div>
    </div>
  )
}

// ── GemMeshLayer ───────────────────────────────────────────────────────────
// Three.js overlay that renders the selected gem mesh at every visible note
// (lanes 0-4) inside the same wrapper as the 2D canvas. Both layers receive
// the same CSS perspective transform so the meshes appear to sit on the
// tilted runway. Camera is orthographic and matches canvas pixel space, so
// note positions are computed using the same y = HIT - (noteSec - currentTime)
// * scrollSpeed formula used by draw().

const LANE_COLOR_HEX = [0x22c55e, 0xef4444, 0xeab308, 0x3b82f6, 0xf97316] // 0-4

interface GemMeshLayerHandle {
  // Spawn a one-shot GemExplosion mesh at the strike-line of the given lane.
  // Called from BeatmapEditor's live-mode strum handler on a successful hit.
  spawnExplosion: (lane: number) => void
}

const GemMeshLayer = forwardRef<GemMeshLayerHandle, {
  meshUrl: string                 // full URL to the FBX/GLB; '' = render nothing
  explosionUrl: string            // full URL to the GemExplosion FBX (preloaded for hit FX)
  notes: ChartNote[]
  tempoSegments: TempoSegment[]
  resolution: number
  currentTime: number
  scrollSpeed: number             // px/sec on the 2D canvas — converted to world Z per second
  canvasW: number
  canvasH: number
  scale: number
  spinDegPerSec: number
  explosionScale: number          // multiplier for the GemExplosion shard cluster (1.0 = matches gem size)
  angleDeg: number                // runway tilt angle — drives the camera pitch
  perspectivePx: number           // CSS perspective px — used to derive Three.js FOV so 2D and 3D layers feel aligned
  ghostRestY: number              // ghost gem rest height multiplier (× baseGemSize)
  ghostDropRange: number          // ghost press drop multiplier (× baseGemSize)
  depthPx: number                 // camera distance offset (-300..300, 0 = default)
  liftPx: number                  // strike-line screen position offset; +ve pushes strike toward viewport bottom
  highwayTextureUrl: string       // '' = plain dark floor; otherwise a tile-able image url
  highwayScroll: boolean          // animate the texture's V offset to flow with the gems
  highwayTint: string             // hex colour applied as an overlay on top of the texture
  highwayTintOpacity: number      // 0..1
  laneSeparators: boolean
  laneSeparatorColor: string      // hex colour for the lines between lanes
  laneSeparatorWidth: number      // world-unit thickness (1 lane = 1 unit, so 0.02 ≈ a hair)
  laneSeparatorGlow: number       // 0..1, outer-glow halo opacity
  battleReverseScroll: boolean    // flips the highway scroll direction
  battleInkSplatter: boolean      // overrides highway → black, hides separators, gems go glossy black
  heldFretsRef: React.MutableRefObject<Set<number>>  // shared with BeatmapEditor's gamepad poll
}>(function GemMeshLayer({
  meshUrl, explosionUrl, notes, tempoSegments, resolution, currentTime, scrollSpeed,
  canvasW, canvasH, scale, spinDegPerSec, explosionScale, angleDeg, perspectivePx,
  ghostRestY, ghostDropRange, depthPx, liftPx,
  highwayTextureUrl, highwayScroll, highwayTint, highwayTintOpacity,
  laneSeparators, laneSeparatorColor, laneSeparatorWidth, laneSeparatorGlow,
  battleReverseScroll, battleInkSplatter,
  heldFretsRef,
}, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const meshTemplateRef = useRef<THREE.Object3D | null>(null)
  const explosionTemplateRef = useRef<THREE.Object3D | null>(null)
  // Runway elements that need per-prop updates instead of rebuilding the
  // whole scene. Floor = textured plane; tint = coloured overlay on top;
  // legacy lane-line objects we replace with thick separator planes.
  const floorMeshRef = useRef<THREE.Mesh | null>(null)
  const tintMeshRef = useRef<THREE.Mesh | null>(null)
  const legacyLineObjsRef = useRef<THREE.Object3D[]>([])
  // 6 separator pairs (between/around the 5 lanes). Each has a main thin
  // bar + a wider, fainter glow bar behind it for the outer-glow effect.
  const sepMainMeshesRef = useRef<THREE.Mesh[]>([])
  const sepGlowMeshesRef = useRef<THREE.Mesh[]>([])
  const lanePoolRef = useRef<THREE.Object3D[]>([])  // pooled clones, recycled per-frame
  // Five ghost gem instances permanently parked at the strike line (one per
  // lane). They render translucent and animate downward when the matching
  // fret button is held, mirroring the GH "held fret" tell.
  const ghostGemsRef = useRef<THREE.Group[]>([])
  // Active GemExplosion FX. Each entry holds the cloned root + per-shard
  // physics state — direction, velocity, angular velocity, etc. Ported from
  // Assets/Art/Scripts/GemExplosion.cs so the shards actually fly apart with
  // damping + gravity instead of a flat scale-fade.
  interface ExplosionShard {
    mesh: THREE.Object3D
    velocity: THREE.Vector3
    angularVelocity: THREE.Vector3
  }
  interface ActiveExplosion {
    id: number
    obj: THREE.Object3D
    shards: ExplosionShard[]
    startMs: number
    lane: number
  }
  const explosionsRef = useRef<ActiveExplosion[]>([])
  const explosionIdRef = useRef(0)
  // Queue of explosion-spawn requests from parent — processed inside the rAF
  // loop so we never touch three.js objects from outside it.
  const explosionQueueRef = useRef<number[]>([])
  const rafRef = useRef<number | null>(null)
  const lastTimestampRef = useRef<number>(performance.now())
  const lastPropsRef = useRef({ notes, tempoSegments, resolution, currentTime, scrollSpeed, scale, spinDegPerSec, explosionScale, angleDeg, perspectivePx, ghostRestY, ghostDropRange, depthPx, liftPx, highwayScroll, battleReverseScroll, battleInkSplatter })

  useImperativeHandle(ref, () => ({
    spawnExplosion: (lane: number) => {
      if (lane < 0 || lane > 4) return
      explosionQueueRef.current.push(lane)
    },
  }))

  // Keep mutable props accessible from the rAF loop without re-creating it.
  useEffect(() => {
    lastPropsRef.current = { notes, tempoSegments, resolution, currentTime, scrollSpeed, scale, spinDegPerSec, explosionScale, angleDeg, perspectivePx, ghostRestY, ghostDropRange, depthPx, liftPx, highwayScroll, battleReverseScroll, battleInkSplatter }
  }, [notes, tempoSegments, resolution, currentTime, scrollSpeed, scale, spinDegPerSec, explosionScale, angleDeg, perspectivePx, ghostRestY, ghostDropRange, depthPx, liftPx, highwayScroll, battleReverseScroll, battleInkSplatter])

  // Initialise renderer once on mount; size & camera follow canvasW/H.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x000000, 0)
    container.appendChild(renderer.domElement)
    Object.assign(renderer.domElement.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      pointerEvents: 'none',
    } as Partial<CSSStyleDeclaration>)

    const scene = new THREE.Scene()
    // Lighting: ambient + directional from above-front so the facets read.
    scene.add(new THREE.AmbientLight(0xffffff, 0.55))
    const dir = new THREE.DirectionalLight(0xffffff, 0.95)
    dir.position.set(0.3, 1.0, 0.5)
    scene.add(dir)
    // Runway floor — textured plane. Texture is loaded lazily by the
    // highwayTextureUrl effect and applied to this material's .map.
    const floorGeom = new THREE.PlaneGeometry(5.5, 60)
    floorGeom.rotateX(-Math.PI / 2)
    floorGeom.translate(0, 0, -29)
    const floorMat = new THREE.MeshBasicMaterial({
      color: 0x0e1422, transparent: true, opacity: 0.95, side: THREE.DoubleSide,
    })
    const floorMesh = new THREE.Mesh(floorGeom, floorMat)
    floorMesh.renderOrder = 0
    scene.add(floorMesh)
    floorMeshRef.current = floorMesh
    // Tint overlay — sits a hair above the floor, screens the texture with a
    // colour the user picks. Hidden when opacity = 0.
    const tintGeom = new THREE.PlaneGeometry(5.5, 60)
    tintGeom.rotateX(-Math.PI / 2)
    tintGeom.translate(0, 0.002, -29)
    const tintMat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0, side: THREE.DoubleSide,
      depthWrite: false,
    })
    const tintMesh = new THREE.Mesh(tintGeom, tintMat)
    tintMesh.renderOrder = 1
    scene.add(tintMesh)
    tintMeshRef.current = tintMesh
    // Lane separators — six thin planes lying flat on the floor, between
    // each pair of lanes (plus outer borders). Each has a wider, fainter
    // glow plane behind it for the outer-glow effect. Geometry is unit-size
    // (1×1); we scale per-frame via .scale.set(width, 1, length).
    for (let i = 0; i <= 5; i++) {
      const x = (i - 2.5) * 1.0
      const mkPlane = (yLift: number) => {
        const g = new THREE.PlaneGeometry(1, 1)
        g.rotateX(-Math.PI / 2)
        const m = new THREE.Mesh(
          g,
          new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 1.0, side: THREE.DoubleSide,
            depthWrite: false,
          }),
        )
        m.position.set(x, yLift, -29)
        return m
      }
      const glow = mkPlane(0.004)
      glow.renderOrder = 2
      glow.scale.set(0.08, 1, 58)
      scene.add(glow)
      sepGlowMeshesRef.current.push(glow)
      const main = mkPlane(0.006)
      main.renderOrder = 3
      main.scale.set(0.025, 1, 58)
      scene.add(main)
      sepMainMeshesRef.current.push(main)
    }
    // Strike line — bright stripe at z=0 marking where notes hit.
    const strikeGeom = new THREE.PlaneGeometry(5.0, 0.08)
    strikeGeom.rotateX(-Math.PI / 2)
    strikeGeom.translate(0, 0.008, 0)
    const strikeMesh = new THREE.Mesh(strikeGeom, new THREE.MeshBasicMaterial({ color: 0xffffff, depthWrite: false }))
    strikeMesh.renderOrder = 4
    scene.add(strikeMesh)

    // Perspective camera — the runway is rendered in true 3D so gems get
    // proper depth foreshortening (far gems small, near gems large), and
    // their positions trace the actual highway plane rather than a flat
    // line tilted via CSS. FOV is derived per-frame from the perspectivePx
    // slider so the slider keeps acting like "focal distance".
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000)

    rendererRef.current = renderer
    sceneRef.current = scene
    cameraRef.current = camera

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      renderer.dispose()
      // Free pooled geometry/materials
      for (const obj of lanePoolRef.current) {
        obj.traverse((c) => {
          const m = c as THREE.Mesh
          if (m.isMesh) {
            m.geometry?.dispose?.()
            const mat = m.material as THREE.Material | THREE.Material[]
            if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
            else mat?.dispose?.()
          }
        })
      }
      lanePoolRef.current = []
      for (const g of ghostGemsRef.current) scene.remove(g)
      ghostGemsRef.current = []
      for (const e of explosionsRef.current) scene.remove(e.obj)
      explosionsRef.current = []
      explosionQueueRef.current = []
      meshTemplateRef.current = null
      explosionTemplateRef.current = null
      try { container.removeChild(renderer.domElement) } catch {}
    }
  }, [])

  // Resize whenever the host canvas does. Camera FOV / position update on
  // the rAF loop so view3d slider tweaks are live.
  useEffect(() => {
    const renderer = rendererRef.current
    const camera = cameraRef.current
    if (!renderer || !camera) return
    renderer.setSize(canvasW, canvasH, false)
    camera.aspect = canvasW / Math.max(1, canvasH)
    camera.updateProjectionMatrix()
  }, [canvasW, canvasH])

  // ── Highway texture ──────────────────────────────────────────────────────
  // Load asynchronously and apply to the floor material. Tiles along the
  // runway depth so long highways look continuous. Cleared (back to plain
  // dark plane) when the dropdown is set to "no texture".
  useEffect(() => {
    const floor = floorMeshRef.current
    if (!floor) return
    const mat = floor.material as THREE.MeshBasicMaterial
    if (!highwayTextureUrl) {
      if (mat.map) { mat.map.dispose(); mat.map = null }
      mat.color.setHex(0x0e1422)
      mat.needsUpdate = true
      return
    }
    const loader = new THREE.TextureLoader()
    loader.setCrossOrigin('use-credentials')
    let cancelled = false
    loader.load(highwayTextureUrl, (tex) => {
      if (cancelled) { tex.dispose(); return }
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.RepeatWrapping
      // Tile ~8× down the 60-unit runway so each tile is roughly square
      // (5.5 wide vs ~7.5 long per tile).
      tex.repeat.set(1, 8)
      tex.colorSpace = THREE.SRGBColorSpace
      if (mat.map) mat.map.dispose()
      mat.map = tex
      mat.color.setHex(0xffffff)  // tint = white so the texture shows its true colour
      mat.needsUpdate = true
    })
    return () => { cancelled = true }
  }, [highwayTextureUrl])

  // ── Tint overlay ─────────────────────────────────────────────────────────
  useEffect(() => {
    const tint = tintMeshRef.current
    if (!tint) return
    const mat = tint.material as THREE.MeshBasicMaterial
    mat.color.set(highwayTint)
    mat.opacity = highwayTintOpacity
    mat.visible = highwayTintOpacity > 0
    mat.needsUpdate = true
  }, [highwayTint, highwayTintOpacity])

  // ── Lane separators ──────────────────────────────────────────────────────
  // Hidden entirely when the inkSplatter debuff is on — the highway turns
  // featureless black during the effect.
  useEffect(() => {
    const visible = laneSeparators && !battleInkSplatter
    for (const m of sepMainMeshesRef.current) {
      const mat = m.material as THREE.MeshBasicMaterial
      mat.color.set(laneSeparatorColor)
      mat.opacity = 1.0
      m.visible = visible
      m.scale.x = laneSeparatorWidth
      mat.needsUpdate = true
    }
    for (const g of sepGlowMeshesRef.current) {
      const mat = g.material as THREE.MeshBasicMaterial
      mat.color.set(laneSeparatorColor)
      mat.opacity = laneSeparatorGlow
      g.visible = visible && laneSeparatorGlow > 0
      g.scale.x = laneSeparatorWidth * 4
      mat.needsUpdate = true
    }
  }, [laneSeparators, laneSeparatorColor, laneSeparatorWidth, laneSeparatorGlow, battleInkSplatter])

  // ── Ink splatter floor override ──────────────────────────────────────────
  // material.color is multiplied with .map's sampled colour, so setting it
  // to pure black gives a featureless black floor without unloading the
  // texture. Toggling off restores the original colour the texture-load
  // effect set (white when a texture is selected, dark blue otherwise).
  useEffect(() => {
    const floor = floorMeshRef.current
    if (!floor) return
    const mat = floor.material as THREE.MeshBasicMaterial
    if (battleInkSplatter) {
      mat.color.setHex(0x000000)
    } else {
      mat.color.setHex(highwayTextureUrl ? 0xffffff : 0x0e1422)
    }
    mat.needsUpdate = true
  }, [battleInkSplatter, highwayTextureUrl])

  // Silence the "unused" linter for refs/arrays not read in TSX body
  void legacyLineObjsRef

  // Load (or unload) the selected mesh. Recycles instance pool when the
  // template changes.
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    // Drop any active instances from the previous mesh, plus ghost gems and
    // in-flight explosions (their templates also change with the gem mesh).
    for (const obj of lanePoolRef.current) scene.remove(obj)
    lanePoolRef.current = []
    for (const obj of ghostGemsRef.current) scene.remove(obj)
    ghostGemsRef.current = []
    for (const e of explosionsRef.current) scene.remove(e.obj)
    explosionsRef.current = []
    explosionQueueRef.current = []
    meshTemplateRef.current = null
    explosionTemplateRef.current = null
    if (!meshUrl) return

    let cancelled = false
    // For solid gem meshes we bake the centre+scale into each child geometry
    // so per-instance .scale.setScalar(N) maps cleanly to N world units.
    // For the explosion shard cluster we DON'T touch child geometries — each
    // shard's original local position is the resting point from which it
    // launches, and that information would be destroyed by geometry centering.
    // Instead we just scale the root so the assembly fits in roughly a unit
    // bounding box.
    const normaliseGemFbx = (fbx: THREE.Object3D) => {
      const box = new THREE.Box3().setFromObject(fbx)
      const size = box.getSize(new THREE.Vector3())
      const maxDim = Math.max(size.x, size.y, size.z) || 1
      const center = box.getCenter(new THREE.Vector3())
      fbx.traverse((c) => {
        const m = c as THREE.Mesh
        if (m.isMesh && m.geometry) {
          m.geometry.translate(-center.x, -center.y, -center.z)
          m.geometry.scale(1 / maxDim, 1 / maxDim, 1 / maxDim)
          m.geometry.computeBoundingSphere?.()
        }
      })
      fbx.position.set(0, 0, 0)
      fbx.scale.set(1, 1, 1)
      fbx.rotation.set(0, 0, 0)
    }
    const normaliseExplosionFbx = (fbx: THREE.Object3D) => {
      const box = new THREE.Box3().setFromObject(fbx)
      const size = box.getSize(new THREE.Vector3())
      const maxDim = Math.max(size.x, size.y, size.z) || 1
      const center = box.getCenter(new THREE.Vector3())
      const s = 1 / maxDim
      // Bake everything into the shards directly so the FBX root stays at
      // identity. For each shard:
      //   • geometry scaled to unit size
      //   • mesh position pulled toward the cluster centre then scaled,
      //     so children sit in roughly [-0.5, 0.5] local space.
      fbx.traverse((c) => {
        const m = c as THREE.Mesh
        if (m.isMesh && m.geometry) {
          m.geometry.scale(s, s, s)
          m.geometry.computeBoundingSphere?.()
          m.position.sub(center).multiplyScalar(s)
        }
      })
      fbx.position.set(0, 0, 0)
      fbx.scale.set(1, 1, 1)
      fbx.rotation.set(0, 0, 0)
    }
    const loadFbx = async (url: string, normalise: (o: THREE.Object3D) => void): Promise<THREE.Object3D> => {
      const res = await fetch(url, { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      const buf = await res.arrayBuffer()
      const fbx = new FBXLoader().parse(buf, '')
      normalise(fbx)
      return fbx
    }
    ;(async () => {
      try {
        const fbx = await loadFbx(meshUrl, normaliseGemFbx)
        if (cancelled) return
        meshTemplateRef.current = fbx
      } catch (e) {
        if (!cancelled) console.error('[GemMeshLayer] mesh load failed', meshUrl, e)
      }
    })()
    // Load the explosion FBX in parallel — it's small (~35 KB) so this is a
    // cheap upfront cost that avoids first-hit latency.
    ;(async () => {
      try {
        const exp = await loadFbx(explosionUrl, normaliseExplosionFbx)
        if (cancelled) return
        explosionTemplateRef.current = exp
      } catch (e) {
        if (!cancelled) console.warn('[GemMeshLayer] explosion mesh load failed', explosionUrl, e)
      }
    })()
    return () => { cancelled = true }
  }, [meshUrl, explosionUrl])

  // Build N evenly-distributed outward direction vectors via the Fibonacci
  // sphere — ported from BuildSphericalDirections in GemExplosion.cs. The
  // centroid is subtracted so the directions sum to zero and the cluster's
  // centre of motion stays locked on the explosion origin.
  const buildSphericalDirections = useCallback((n: number): THREE.Vector3[] => {
    const dirs: THREE.Vector3[] = []
    if (n === 0) return dirs
    const goldenAngle = Math.PI * (1 + Math.sqrt(5))
    let sx = 0, sy = 0, sz = 0
    for (let i = 0; i < n; i++) {
      const phi = Math.acos(1 - 2 * (i + 0.5) / n)
      const theta = goldenAngle * i
      const sinPhi = Math.sin(phi)
      const x = sinPhi * Math.cos(theta)
      const y = Math.cos(phi)
      const z = sinPhi * Math.sin(theta)
      dirs.push(new THREE.Vector3(x, y, z))
      sx += x; sy += y; sz += z
    }
    const cx = sx / n, cy = sy / n, cz = sz / n
    for (const d of dirs) {
      d.x -= cx; d.y -= cy; d.z -= cz
      const m = d.length()
      if (m > 0.0001) d.multiplyScalar(1 / m)
      else d.set(0, 1, 0)
    }
    return dirs
  }, [])

  // Animation loop. Drives all per-frame placement so the gems track scrub +
  // playback without React re-renders per frame.
  useEffect(() => {
    const renderer = rendererRef.current
    const scene = sceneRef.current
    const camera = cameraRef.current
    if (!renderer || !scene || !camera) return

    const tick = (now: number) => {
      rafRef.current = requestAnimationFrame(tick)
      const dtSec = Math.min(0.1, (now - lastTimestampRef.current) / 1000)
      lastTimestampRef.current = now

      const template = meshTemplateRef.current
      const props = lastPropsRef.current

      // World units: 1 unit ≈ one lane width. Five lanes span ~5 units; depth
      // is computed as "seconds-to-strike × Z_PER_SECOND" so a tweak to the
      // 2D scroll-speed slider also scales the 3D scroll. Camera lives in
      // the same coordinate system.
      const W = renderer.domElement.width / (renderer.getPixelRatio() || 1)
      const H = renderer.domElement.height / (renderer.getPixelRatio() || 1)
      const Z_PER_SECOND = 4.0
      const LANE_UNIT = 1.0
      const baseGemSize = 0.32 * Math.max(0.05, props.scale)

      // FOV from perspectivePx (matches the CSS perspective opening angle).
      const fovRad = 2 * Math.atan(H / (2 * Math.max(50, props.perspectivePx)))
      camera.fov = fovRad * 180 / Math.PI
      camera.aspect = W / Math.max(1, H)

      // Polar camera: pitched down by angleDeg, at a distance from the strike
      // point that the Depth slider can adjust. Lift slider then rotates the
      // camera up beyond the lookAt to push the strike toward the viewport
      // bottom — same framing knob as GH "highway tilt".
      //
      // Depth mapping: depthPx of 0 = baseline 5 wu; +ve = camera further
      // (smaller runway), -ve = closer (bigger runway). 0.01 wu/px keeps
      // the slider's pixel range feeling natural.
      // Lift mapping: liftPx in [-200, 300] maps to additional pitch in
      // [-0.5, 1.6] × halfFov, so +ve = strike line drops, hitting the
      // viewport's bottom edge near +200.
      const camDist = Math.max(1.5, 5.0 + props.depthPx * 0.01)
      const tiltRad = props.angleDeg * Math.PI / 180
      camera.position.set(
        0,
        camDist * Math.sin(tiltRad),
        camDist * Math.cos(tiltRad),
      )
      camera.lookAt(0, 0, 0)
      const halfFov = (camera.fov * Math.PI / 180) * 0.5
      const pitchFactor = 0.45 + props.liftPx * 0.004
      camera.rotateX(halfFov * pitchFactor)
      camera.updateProjectionMatrix()

      // Highway-texture scrolling — the gems flow toward the camera at
      // Z_PER_SECOND world-units/sec, so the floor texture's V offset must
      // change at the same rate (per tile world-length) to lock visually.
      // Tile world length = plane depth (60) / repeat.y (8) = 7.5.
      const floorForScroll = floorMeshRef.current
      if (floorForScroll) {
        const mat = floorForScroll.material as THREE.MeshBasicMaterial
        if (mat.map) {
          if (props.highwayScroll) {
            // Z_PER_SECOND = 4 (kept in sync with the gem-pos calc below).
            // Default flows TOWARD the camera (same direction gems travel).
            // Reverse-scroll battle debuff flips the sign so the highway
            // scrolls toward the horizon — disorienting on purpose.
            const baseOffset = (props.currentTime * (4 / 7.5)) % 1
            mat.map.offset.y = props.battleReverseScroll ? -baseOffset : baseOffset
          } else if (mat.map.offset.y !== 0) {
            mat.map.offset.y = 0
          }
        }
      }

      if (!template) {
        renderer.render(scene, camera)
        return
      }

      // Visibility window in seconds — extend a bit beyond the 2D draw so
      // gems fade in from far away rather than popping.
      const topSec = props.currentTime + 3.0
      const bottomSec = props.currentTime - 0.5
      const t2s = (t: number) => tickToSec(props.tempoSegments, props.resolution, t)

      const visible: { worldX: number; worldZ: number; lane: number }[] = []
      for (const n of props.notes) {
        if (n.lane > 4) continue
        const ns = t2s(n.tick)
        if (ns < bottomSec || ns > topSec) continue
        const ahead = ns - props.currentTime  // seconds, positive = future
        visible.push({
          worldX: (n.lane - 2) * LANE_UNIT,  // -2 = lane 0 leftmost
          worldZ: -ahead * Z_PER_SECOND,
          lane: n.lane,
        })
      }
      // Silence the "W is unused" linter — the value was read for FOV math
      void W

      // Pool of mesh clones. Each carries the gem material so we can re-tint
      // per-instance without leaking colour through shared materials.
      const pool = lanePoolRef.current
      while (pool.length < visible.length) {
        const inst = template.clone(true)
        inst.traverse((c) => {
          const m = c as THREE.Mesh
          if (m.isMesh) {
            m.material = new THREE.MeshStandardMaterial({
              color: 0xffffff, metalness: 0.35, roughness: 0.4,
              side: THREE.DoubleSide,
            })
          }
        })
        pool.push(inst)
        scene.add(inst)
      }
      while (pool.length > visible.length) {
        const inst = pool.pop()!
        scene.remove(inst)
      }

      const spin = props.spinDegPerSec * (Math.PI / 180) * dtSec
      for (let i = 0; i < visible.length; i++) {
        const { worldX, worldZ, lane } = visible[i]
        const inst = pool[i]
        // Park gems at half-height so they appear to sit on the runway plane
        inst.position.set(worldX, baseGemSize * 0.5, worldZ)
        inst.scale.setScalar(baseGemSize)
        inst.rotation.y += spin
        inst.traverse((c) => {
          const m = c as THREE.Mesh
          if (m.isMesh) {
            const mat = m.material as THREE.MeshStandardMaterial
            if (props.battleInkSplatter) {
              // Glossy black — barely any diffuse colour, mirror-like surface
              mat.color.setHex(0x0a0a0a)
              mat.metalness = 0.95
              mat.roughness = 0.08
            } else {
              mat.color.setHex(LANE_COLOR_HEX[lane])
              mat.metalness = 0.35
              mat.roughness = 0.4
            }
          }
        })
      }

      // ── Ghost gems ────────────────────────────────────────────────────────
      // Lazy-create one ghost per lane the first time we have a template.
      if (ghostGemsRef.current.length === 0) {
        for (let lane = 0; lane < 5; lane++) {
          const inst = template.clone(true)
          inst.traverse((c) => {
            const m = c as THREE.Mesh
            if (m.isMesh) {
              m.material = new THREE.MeshStandardMaterial({
                color: LANE_COLOR_HEX[lane],
                metalness: 0.25, roughness: 0.55,
                transparent: true, opacity: 0.5,
                side: THREE.DoubleSide,
              })
            }
          })
          const wrap = new THREE.Group()
          wrap.add(inst)
          // Park at the raised rest position from the start so the first
          // frame doesn't lerp from world origin.
          wrap.position.set((lane - 2) * LANE_UNIT, baseGemSize * props.ghostRestY, 0)
          wrap.scale.setScalar(baseGemSize)
          scene.add(wrap)
          ghostGemsRef.current.push(wrap)
        }
      }
      // Animate each ghost toward "rest" (raised above the strike) or
      // "pressed" (dropped to exactly the height a falling highway gem sits
      // at as it crosses the strike line — `baseGemSize * 0.5`). This way the
      // ghost merges with the incoming gem at the moment of the hit instead
      // of being below it.
      const held = heldFretsRef.current
      // Diagnostic: expose what the 3D layer is reading on window so it can
      // be compared with the sidebar's Held strip. If the two disagree we
      // have a ref/closure bug; if they agree, the issue is downstream
      // (visibility, lerp, occlusion).
      ;(window as unknown as { __ghostHeld?: number[] }).__ghostHeld = [...held].sort((a, b) => a - b)
      const RESTING_Y = baseGemSize * props.ghostRestY
      const PRESSED_Y = baseGemSize * (props.ghostRestY - props.ghostDropRange)
      for (let lane = 0; lane < 5; lane++) {
        const ghost = ghostGemsRef.current[lane]
        if (!ghost) continue
        const isPressed = held.has(lane)
        const targetY = isPressed ? PRESSED_Y : RESTING_Y
        const targetScale = baseGemSize * (isPressed ? 0.95 : 1.0)
        const lerp = Math.min(1, dtSec * 18)
        ghost.position.x = (lane - 2) * LANE_UNIT
        ghost.position.y += (targetY - ghost.position.y) * lerp
        ghost.position.z = 0
        const curScale = ghost.scale.x
        ghost.scale.setScalar(curScale + (targetScale - curScale) * lerp)
        const innerGem = ghost.children[0]
        if (innerGem) {
          innerGem.rotation.y += spin * 0.5
          // Ink-splatter overrides ghost colour/finish too so the whole
          // strike line goes glossy black during the debuff.
          innerGem.traverse((c) => {
            const m = c as THREE.Mesh
            if (m.isMesh) {
              const mat = m.material as THREE.MeshStandardMaterial
              if (props.battleInkSplatter) {
                mat.color.setHex(0x0a0a0a)
                mat.metalness = 0.95
                mat.roughness = 0.08
                mat.opacity = 0.55
              } else {
                mat.color.setHex(LANE_COLOR_HEX[lane])
                mat.metalness = 0.25
                mat.roughness = 0.55
                mat.opacity = 0.5
              }
            }
          })
        }
      }

      // ── Explosion FX ──────────────────────────────────────────────────────
      // Ports the shard physics from Assets/Art/Scripts/GemExplosion.cs:
      //   v(t+dt) = v * exp(-linearDamping * dt) + gravity * dt
      //   pos    += v * dt
      //   rot    *= axisAngle(angVel * dt)
      //   angVel *= exp(-angularDamping * dt)
      // Each shard gets a Fibonacci-sphere direction so the cluster fans out
      // evenly. Jitter on burst speed, lift, and spin keeps repeats varied.
      // Tuned for our scaled-down explosion space — shards live in fbx-local
      // coords (~unit-sized cluster), wrapped by a baseGemSize-scaled Group
      // (~0.32 wu by default). Original Unity values are too tame here, so
      // burst is boosted and damping eased so the cluster reaches ~1 wu.
      const EXPLOSION_BURST = 15.0
      const EXPLOSION_UPWARD = 2.0
      const EXPLOSION_RANDOMNESS = 0.25
      const EXPLOSION_LIN_DAMP = 4
      const EXPLOSION_ANG_DAMP = 2
      const EXPLOSION_SPIN = 14            // rad/s
      const EXPLOSION_GRAVITY_Y = -20
      const EXPLOSION_LIFETIME_MS = 700

      const expTpl = explosionTemplateRef.current
      while (explosionQueueRef.current.length > 0) {
        const lane = explosionQueueRef.current.shift()!
        if (!expTpl) {
          // FBX still loading — drop this spawn rather than holding a
          // long-tail queue that fires once the asset arrives.
          continue
        }
        const root = expTpl.clone(true)
        // Template was baked at identity by normaliseExplosionFbx — no need
        // to reset the clone's transform. Each shard's local position is
        // already in unit space.
        // Tint every shard with the lane colour, transparent for fade-out.
        const shardMeshes: THREE.Object3D[] = []
        root.traverse((c) => {
          const m = c as THREE.Mesh
          if (m.isMesh) {
            m.material = new THREE.MeshStandardMaterial({
              color: LANE_COLOR_HEX[lane],
              emissive: LANE_COLOR_HEX[lane],
              emissiveIntensity: 0.5,
              metalness: 0.3, roughness: 0.4,
              transparent: true, opacity: 1.0,
              side: THREE.DoubleSide,
            })
            shardMeshes.push(m)
          }
        })
        // Wrapper holds the position + scale; shards animate relative to it.
        // explosionScale lets the user shrink the burst independently of the
        // gem mesh — for less visual chaos on busy strums.
        const wrap = new THREE.Group()
        wrap.add(root)
        wrap.position.set((lane - 2) * LANE_UNIT, baseGemSize * 0.5, 0)
        wrap.scale.setScalar(baseGemSize * Math.max(0.05, props.explosionScale))
        scene.add(wrap)

        // Assign per-shard physics state.
        const dirs = buildSphericalDirections(shardMeshes.length)
        const shards: ExplosionShard[] = shardMeshes.map((mesh, i) => {
          const dir = dirs[i]
          const burstJit = 1 + (Math.random() * 2 - 1) * EXPLOSION_RANDOMNESS
          const liftJit = 1 + (Math.random() * 2 - 1) * EXPLOSION_RANDOMNESS
          const spinJit = 1 + (Math.random() * 2 - 1) * EXPLOSION_RANDOMNESS
          const velocity = new THREE.Vector3(
            dir.x * EXPLOSION_BURST * burstJit,
            dir.y * EXPLOSION_BURST * burstJit + EXPLOSION_UPWARD * liftJit,
            dir.z * EXPLOSION_BURST * burstJit,
          )
          // Spin axis perpendicular to travel — same trick as the Unity script
          let axis = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0))
          if (axis.lengthSq() < 0.0001) axis.set(1, 0, 0)
          axis.normalize()
          const angularVelocity = axis.multiplyScalar(EXPLOSION_SPIN * spinJit)
          return { mesh, velocity, angularVelocity }
        })

        explosionsRef.current.push({
          id: ++explosionIdRef.current,
          obj: wrap,
          shards,
          startMs: now,
          lane,
        })
      }

      // Integrate active explosions.
      const stillActive: ActiveExplosion[] = []
      for (const e of explosionsRef.current) {
        const elapsed = now - e.startMs
        if (elapsed >= EXPLOSION_LIFETIME_MS) {
          scene.remove(e.obj)
          e.obj.traverse((c) => {
            const m = c as THREE.Mesh
            if (m.isMesh) {
              const mat = m.material as THREE.Material | THREE.Material[]
              if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
              else mat?.dispose?.()
            }
          })
          continue
        }
        const t = elapsed / EXPLOSION_LIFETIME_MS
        const linDamp = Math.exp(-EXPLOSION_LIN_DAMP * dtSec)
        const angDamp = Math.exp(-EXPLOSION_ANG_DAMP * dtSec)
        const gyStep = EXPLOSION_GRAVITY_Y * dtSec
        for (const s of e.shards) {
          // v = v * linDamp + gravity*dt
          s.velocity.multiplyScalar(linDamp)
          s.velocity.y += gyStep
          s.angularVelocity.multiplyScalar(angDamp)
          // pos += v * dt (in wrapper-local units, but the wrapper is scaled
          // by baseGemSize ≈ 0.32 so the per-second burst of 4 traverses
          // about 1.3 world units / second in screen space — visually about
          // right for a quick pop at the strike line).
          s.mesh.position.x += s.velocity.x * dtSec
          s.mesh.position.y += s.velocity.y * dtSec
          s.mesh.position.z += s.velocity.z * dtSec
          // Rotation: axis-angle on the spin vector
          const avMag = s.angularVelocity.length()
          if (avMag > 0.0001) {
            const q = new THREE.Quaternion().setFromAxisAngle(
              s.angularVelocity.clone().multiplyScalar(1 / avMag),
              avMag * dtSec,
            )
            s.mesh.quaternion.premultiply(q)
          }
        }
        // Fade opacity over the back half of the lifetime so the shards stay
        // bright while they're still flying.
        const opacity = t < 0.5 ? 1.0 : Math.max(0, 1 - (t - 0.5) * 2)
        e.obj.traverse((c) => {
          const m = c as THREE.Mesh
          if (m.isMesh) {
            const mat = m.material as THREE.MeshStandardMaterial
            mat.opacity = opacity
          }
        })
        stillActive.push(e)
      }
      explosionsRef.current = stillActive

      renderer.render(scene, camera)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-none"
    />
  )
})

// BackgroundLayer -------------------------------------------------------------
// Renders the optional video that sits behind the highway. YouTube goes
// through an iframe embed (muted, autoplay, looped). Uploaded video files
// play via a native <video> element with the audio track muted, and follow
// the editor's audio playhead — paused when the song is paused, seeking
// when the user scrubs (jump-only, no per-frame writes since the browser
// already lerps between updates).

function BackgroundLayer({
  kind, ytId, videoUrl, currentTime, playing,
}: {
  kind: 'youtube' | 'video'
  ytId: string
  videoUrl: string
  currentTime: number
  playing: boolean
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)

  // Keep the <video> playing/paused in sync with the song transport.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (playing) v.play().catch(() => undefined)
    else v.pause()
  }, [playing])

  // Re-seek when the audio's currentTime drifts away from the video by more
  // than a small threshold (manual scrubs, jumps). Avoid setting every frame
  // — small natural drift is invisible and writing currentTime every frame
  // stutters playback.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (Math.abs(v.currentTime - currentTime) > 0.25) {
      try { v.currentTime = Math.max(0, currentTime) } catch {}
    }
  }, [currentTime])

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 0 }}>
      {kind === 'youtube' && ytId && (
        <iframe
          src={`https://www.youtube.com/embed/${ytId}?autoplay=1&mute=1&controls=0&loop=1&playlist=${ytId}&modestbranding=1&playsinline=1&rel=0`}
          title="background"
          allow="autoplay; encrypted-media"
          // No allowfullscreen — this is a background, not interactive
          className="absolute inset-0 w-full h-full"
          style={{ border: 0, opacity: 0.55, objectFit: 'cover' }}
        />
      )}
      {kind === 'video' && videoUrl && (
        <video
          ref={videoRef}
          src={videoUrl}
          autoPlay
          muted
          loop
          playsInline
          className="absolute inset-0 w-full h-full"
          style={{ objectFit: 'cover', opacity: 0.6 }}
        />
      )}
    </div>
  )
}

// CollapsibleSection ----------------------------------------------------------
// Wraps a sidebar panel so its body can be hidden behind the header. Open/closed
// state is persisted per `id` in localStorage so user preference sticks across
// reloads. Header gets a chevron + the panel title; an optional `right` slot
// can hold action buttons (Add-at-playhead, scan, reset, etc) that don't toggle.

function CollapsibleSection({
  id, title, right, defaultOpen = true, children,
}: {
  id: string
  title: string
  right?: React.ReactNode
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const storageKey = `editor.panel.${id}.open`
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(storageKey)
      return v === null ? defaultOpen : v === '1'
    } catch { return defaultOpen }
  })
  useEffect(() => {
    try { localStorage.setItem(storageKey, open ? '1' : '0') } catch {}
  }, [open, storageKey])
  return (
    <section>
      <div
        className="flex items-center justify-between cursor-pointer select-none group mb-2"
        onClick={(e) => {
          // Don't toggle when the click hits a button / input in the right slot
          if ((e.target as HTMLElement).closest('button, a, input, select, label')) return
          setOpen((o) => !o)
        }}
      >
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider group-hover:text-gray-200 transition-colors flex items-center gap-1">
          <span className="text-[9px] text-gray-600 group-hover:text-gray-400 inline-block w-2.5 transition-transform" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>
            ▶
          </span>
          {title}
        </h3>
        {right}
      </div>
      {open && children}
    </section>
  )
}

// Component -----------------------------------------------------------------

interface SourceChartCache {
  notes: ChartNote[]
  tempoSegments: TempoSegment[]
  resolution: number
  duration: number
  peaks: Float32Array | null
}

export default function BeatmapEditor() {
  const params = useParams<{ trackId: string; beatmapId: string }>()
  const trackId = params.trackId!
  const beatmapId = params.beatmapId!

  const [chart, setChart] = useState<ChartState | null>(null)
  const [meta, setMeta] = useState<BeatmapMeta | null>(null)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [dirty, setDirty] = useState(false)
  const [snapDivisor, setSnapDivisor] = useState(4)

  // Piecewise tempo map — recomputed whenever the chart's markers or
  // resolution change. Every tick↔seconds conversion in the editor (canvas
  // draw, click placement, drag, arrow nudge, VO firing, click track,
  // timelines) reads this so multi-tempo charts stay phase-locked.
  const tempoSegments = useMemo(() => {
    if (!chart) return [{ tick: 0, seconds: 0, microBpm: 120000 }]
    return buildTempoSegments(chart.tempoMarkers, chart.resolution)
  }, [chart])

  const audioRef = useRef<HTMLAudioElement | null>(null)
  // VO audio playback during transport. Each VO with a non-empty `file` gets
  // its own HTMLAudioElement preloaded into voAudiosRef. firedVosRef tracks
  // which ones have already been triggered in the current play pass — reset
  // on any meaningful seek so a VO can replay if you scrub back over it.
  const voAudiosRef = useRef<Map<string, HTMLAudioElement>>(new Map())
  const sliceAudioRef = useRef<HTMLAudioElement | null>(null)
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
  // Note-tool placement state. mousedown places a gem at sustain=0 and
  // captures the start y; subsequent mousemove (drag up) live-updates the
  // sustain length until mouseup. Quick click = no drag = stays at sustain 0.
  const placeRef = useRef<{
    idx: number
    noteTick: number
    startCy: number
  } | null>(null)
  // Click-and-drag-to-scrub state. Armed on mousedown in empty canvas area
  // (no note hit, Select tool); the drag handler converts y-delta to a
  // currentTime delta. If the user never drags far enough, the gesture is
  // treated as a plain click on mouseup (clears selection).
  const scrubRef = useRef<{
    startCy: number
    startCurrentTime: number
    moved: boolean
  } | null>(null)
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 800 })

  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [scrollSpeed, setScrollSpeed] = useState(450)
  // 3D-perspective preview. The canvas keeps drawing in 2D pixel space; we
  // tilt the rendered surface via CSS so the existing draw loop is untouched.
  // Editing (click/drag) is gated off in 3D since hit-testing assumes a
  // non-transformed canvas — wheel scrub and the playhead transport still
  // work. Settings persist in localStorage so each user's framing sticks.
  const [view3d, setView3d] = useState<View3DState>(() => loadView3d())
  useEffect(() => {
    try { localStorage.setItem('editor.view3d', JSON.stringify(view3d)) } catch {}
  }, [view3d])
  const [gemMeshes, setGemMeshes] = useState<GemMeshInfo[]>([])
  const [highwayTextures, setHighwayTextures] = useState<HighwayTextureInfo[]>([])
  useEffect(() => {
    fetch('/api/gem-meshes')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { meshes: GemMeshInfo[] } | null) => {
        if (data?.meshes) setGemMeshes(data.meshes)
      })
      .catch(() => undefined)
    fetch('/api/highway-textures')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { textures: HighwayTextureInfo[] } | null) => {
        if (data?.textures) setHighwayTextures(data.textures)
      })
      .catch(() => undefined)
  }, [])
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [tool, setTool] = useState<'select' | 'note' | 'real'>('select')
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
  // Playback rate. preservesPitch keeps voices intelligible when slowing down
  // for charting hard sections.
  const [playbackRate, setPlaybackRate] = useState(1)
  // Waveform peaks decoded from song.ogg — one entry per WAVE_BUCKET_MS slice
  // of the audio's full duration, stored in a ref so updates don't re-render
  // (the draw loop reads it on every frame regardless).
  const wavePeaksRef = useRef<Float32Array | null>(null)
  // Pixel-space hit regions for the runway sidecar pills (VO / STEP / MUSIC /
  // scene). Populated every draw frame so the click handler can pick the
  // matching event without re-deriving x/y/w/h itself.
  const pillRegionsRef = useRef<Array<{
    x: number; y: number; w: number; h: number
    id: string; kind: 'tutorial' | 'scene'
  }>>([])
  // Tutorial event (VO / STEP / MUSIC) and scene event currently being edited
  // in the side panel. Lifted up here so the canvas draw closure can
  // highlight the matching pill and the click handler can set them.
  const [selectedTutorialId, setSelectedTutorialId] = useState<string | null>(null)
  const [sceneSelectedId, setSceneSelectedId] = useState<string | null>(null)
  // Bumps to force a re-render when peaks finish decoding so any UI that
  // reflects waveform-ready state can update.
  const [, setWaveLoaded] = useState(false)

  // Audio playback source. The default 'beatmap' plays the stem audio
  // bundled with this beatmap (typically a single instrument). 'track-song'
  // swaps in the track's full master mix so charters can hear the rest of
  // the song while authoring against one stem. Switching is non-destructive
  // — the playhead position is preserved across the swap.
  const [audioSource, setAudioSource] = useState<'beatmap' | 'track-song'>('beatmap')
  // Off by default — many charters prefer a clean runway. Flip on to see the
  // audio peaks rendered across the full gem width so you can eyeball whether
  // gems are placed on transients.
  const [waveformOnHighway, setWaveformOnHighway] = useState(false)
  // WebAudio metronome. Schedules click sounds at each beat boundary against
  // the AudioContext clock for sample-accurate timing. Downbeats (every 4th
  // beat at 4/4) get a higher pitch so charters can hear bar boundaries.
  const [clickEnabled, setClickEnabled] = useState(false)
  const [clickVolume, setClickVolume] = useState(0.4)
  const clickCtxRef = useRef<AudioContext | null>(null)
  // Sound-pack picker — global catalog plus the user's current "default"
  // selection. Real-notes carry their own (pack, scale) intrinsically; this
  // pair just supplies the default that newly-dropped real-notes inherit and
  // the per-note dropdown's initial value.
  const [packCatalog, setPackCatalog] = useState<Array<{
    pack_id: string; name: string; family: string; description: string
  }>>([])
  const [scaleCatalog, setScaleCatalog] = useState<Array<{
    scale_id: string; name: string; description: string
  }>>([])
  const [pickedPackId, setPickedPackId] = useState('')
  const [pickedScaleId, setPickedScaleId] = useState('')
  const [packPreviewing, setPackPreviewing] = useState(false)
  const packPreviewRef = useRef<HTMLAudioElement | null>(null)

  // Real-notes preview — fires the matching sample whenever the playhead
  // crosses a real-note tick. Uses WebAudio with pre-decoded AudioBuffers,
  // keyed on (pack, scale); the per-tick resolution is in _resolveRealNote
  // below.
  const [realNotesEnabled, setRealNotesEnabled] = useState(true)

  // Per-source chart cache: notes + tempo + resolution + duration + peaks.
  // Populated on import / on first selection of an imported source. Keyed
  // by ImportedSource.id (the chart-local id, not Studio track/beatmap ids).
  const sourceCacheRef = useRef<Record<string, SourceChartCache>>({})
  const [sourceCache, setSourceCache] = useState<Record<string, SourceChartCache>>({})
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  sourceCacheRef.current = sourceCache

  const fetchSourceData = useCallback(async (src: ImportedSource): Promise<SourceChartCache | null> => {
    if (sourceCacheRef.current[src.id]) return sourceCacheRef.current[src.id]
    try {
      const [chartRes, peaksRes] = await Promise.all([
        fetch(`/api/tracks/${src.trackId}/beatmaps/${src.beatmapId}/chart`),
        fetch(`/api/tracks/${src.trackId}/beatmaps/${src.beatmapId}/song-peaks`),
      ])
      if (!chartRes.ok) return null
      const { chart: chartText } = await chartRes.json() as { chart: string }
      const parsed = parseChart(chartText)
      const peaks = peaksRes.ok ? new Float32Array(await peaksRes.arrayBuffer()) : null
      const tempoSegments = buildTempoSegments(parsed.tempoMarkers, parsed.resolution)
      const lastTick = parsed.notes.reduce((m, n) => Math.max(m, n.tick + (n.sustain || 0)), 0)
      const duration = tickToSec(tempoSegments, parsed.resolution, lastTick)
      const cache: SourceChartCache = {
        notes: parsed.notes,
        tempoSegments,
        resolution: parsed.resolution,
        duration,
        peaks,
      }
      setSourceCache((prev) => ({ ...prev, [src.id]: cache }))
      return cache
    } catch {
      return null
    }
  }, [])

  const [tutorialPeaks, setTutorialPeaks] = useState<Float32Array | null>(null)
  const [peaksBucketSec] = useState(0.020)
  const [timelineView, setTimelineView] = useState<{ start: number; end: number }>({ start: 0, end: 0 })

  // Sync the shared timeline view to song duration when it lands.
  useEffect(() => {
    if (duration > 0) setTimelineView((v) => v.end <= 0 ? { start: 0, end: duration } : v)
  }, [duration])

  // Fetch the tutorial's own song peaks.
  useEffect(() => {
    if (!trackId || !beatmapId) return
    let cancelled = false
    fetch(`/api/tracks/${trackId}/beatmaps/${beatmapId}/song-peaks`)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((buf) => { if (!cancelled && buf) setTutorialPeaks(new Float32Array(buf)) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [trackId, beatmapId])

  // When the user picks an imported source, prefetch its data into the cache.
  useEffect(() => {
    if (!activeSourceId || !chart) return
    const src = chart.importedSources.find((s) => s.id === activeSourceId)
    if (src) fetchSourceData(src)
  }, [activeSourceId, chart, fetchSourceData])

  const importSource = (id: string, trackId: string, beatmapId: string, name: string) => {
    if (!chart) return
    setChart({
      ...chart,
      importedSources: [...chart.importedSources, { id, trackId, beatmapId, name }],
    })
    setDirty(true)
    setActiveSourceId(id)
    setPickerOpen(false)
  }

  const renameSource = (oldId: string, newId: string) => {
    if (!chart) return
    if (!/^[a-z][a-z0-9_]*$/.test(newId)) return
    if (oldId === newId) return
    if (chart.importedSources.some((s) => s.id === newId)) return
    setChart({
      ...chart,
      importedSources: chart.importedSources.map((s) => s.id === oldId ? { ...s, id: newId } : s),
      clips: chart.clips.map((c) => c.sourceId === oldId ? { ...c, sourceId: newId } : c),
      tutorial: chart.tutorial.map((e) => (e.kind === 'music' && e.source === oldId) ? { ...e, source: newId } : e),
    })
    setDirty(true)
    if (activeSourceId === oldId) setActiveSourceId(newId)
  }

  const deleteSource = (id: string) => {
    if (!chart) return
    const src = chart.importedSources.find((s) => s.id === id)
    if (!src) return
    if (!window.confirm(`Remove "${src.name}" and any splices that reference it?`)) return
    const sectionsToDrop = new Set(chart.clips.filter((c) => c.sourceId === id).map((c) => c.sectionName))
    const nextSections = { ...chart.musicSections }
    for (const sn of sectionsToDrop) delete nextSections[sn]
    setChart({
      ...chart,
      importedSources: chart.importedSources.filter((s) => s.id !== id),
      musicSections: nextSections,
      clips: chart.clips.filter((c) => c.sourceId !== id),
      tutorial: chart.tutorial.filter((e) => !(e.kind === 'music' && e.source === id)),
    })
    setDirty(true)
    if (activeSourceId === id) setActiveSourceId(null)
  }

  const [pendingClip, setPendingClip] = useState<{ startSec: number; endSec: number; name: string; sourceId: string } | null>(null)
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)

  const saveClipFromPending = async () => {
    if (!chart || !pendingClip) return
    const { startSec, endSec, name, sourceId } = pendingClip
    const cleanName = name.trim() || `Clip ${chart.clips.length + 1}`
    const src = chart.importedSources.find((s) => s.id === sourceId)
    if (!src) return
    const cache = await fetchSourceData(src)
    if (!cache) return
    const slice = sliceSourceChartForClip(cache.notes, cache.tempoSegments, cache.resolution, startSec, endSec)
    let id: string
    do {
      id = Math.random().toString(36).slice(2, 10)
    } while (chart.musicSections[`MusicSeg_${id}`] !== undefined)
    const sectionName = `MusicSeg_${id}`
    const newClip: Clip = {
      id, sectionName, name: cleanName, sourceId,
      startSec, endSec, notesCount: slice.notesCount, bpm: slice.bpm,
    }
    setChart({
      ...chart,
      musicSections: { ...chart.musicSections, [sectionName]: slice.sectionBody },
      clips: [...chart.clips, newClip],
    })
    setDirty(true)
    setSelectedClipId(id)
    setPendingClip(null)
  }

  const renameClip = (id: string, name: string) => {
    if (!chart) return
    setChart({ ...chart, clips: chart.clips.map((c) => c.id === id ? { ...c, name } : c) })
    setDirty(true)
  }

  const deleteClip = (id: string) => {
    if (!chart) return
    const clip = chart.clips.find((c) => c.id === id)
    if (!clip) return
    if (!window.confirm(`Delete "${clip.name}" and any places of it?`)) return
    const nextSections = { ...chart.musicSections }
    delete nextSections[clip.sectionName]
    setChart({
      ...chart,
      musicSections: nextSections,
      clips: chart.clips.filter((c) => c.id !== id),
      tutorial: chart.tutorial.filter((e) => !(e.kind === 'music' && e.sectionName === clip.sectionName)),
    })
    setDirty(true)
    if (selectedClipId === id) setSelectedClipId(null)
  }

  const placeClipAtPlayhead = (id: string) => {
    if (!chart) return
    const clip = chart.clips.find((c) => c.id === id)
    if (!clip) return
    const tick = secToTick(tempoSegments, chart.resolution, currentTime)
    const ev: TutorialMusicEvent = {
      kind: 'music',
      id: `music-${Date.now()}`,
      tick,
      file: clip.sourceId ? '' : `segments/${clip.sectionName.replace('MusicSeg_', '')}.ogg`,
      sectionName: clip.sectionName,
      bpm: clip.bpm,
      resolution: chart.resolution,
      durationSeconds: clip.sourceId ? (clip.endSec - clip.startSec) : 0,
      notesCount: clip.notesCount,
      required: Math.min(5, clip.notesCount),
      timing: 'any',
      retryVo: '',
      next: '',
      ...(clip.sourceId ? {
        source: clip.sourceId,
        stem: 'song',
        startMs: Math.round(clip.startSec * 1000),
        durationMs: Math.round((clip.endSec - clip.startSec) * 1000),
      } : {}),
    }
    setChart({ ...chart, tutorial: [...chart.tutorial, ev], tutorialEnabled: true })
    setDirty(true)
    setSelectedTutorialId(ev.id)
  }

  const auditionClip = (id: string) => {
    if (!chart) return
    const clip = chart.clips.find((c) => c.id === id)
    if (!clip) return
    if (sliceAudioRef.current) { sliceAudioRef.current.pause(); sliceAudioRef.current = null }
    let url: string
    let start = 0
    let end: number = Infinity
    if (clip.sourceId) {
      const src = chart.importedSources.find((s) => s.id === clip.sourceId)
      if (!src) return
      url = `/api/tracks/${src.trackId}/beatmaps/${src.beatmapId}/download/song.ogg`
      start = clip.startSec
      end = clip.endSec
    } else {
      url = `/api/tutorial/${trackId}/beatmaps/${beatmapId}/segments/${clip.sectionName.replace('MusicSeg_', '')}.ogg`
    }
    const a = new Audio(url)
    sliceAudioRef.current = a
    const startPlayback = () => {
      if (start > 0) a.currentTime = start
      a.play().catch(() => undefined)
      if (Number.isFinite(end)) {
        const onTick = () => {
          if (a.currentTime >= end - 0.01) {
            a.pause()
            a.removeEventListener('timeupdate', onTick)
          }
        }
        a.addEventListener('timeupdate', onTick)
      }
    }
    if (a.readyState >= 1) startPlayback()
    else a.addEventListener('loadedmetadata', startPlayback, { once: true })
  }

  // Resolve the WaveformStrip props from the active source (or own).
  const activePeaks = activeSourceId
    ? sourceCache[activeSourceId]?.peaks ?? null
    : tutorialPeaks
  const activeDuration = activeSourceId
    ? sourceCache[activeSourceId]?.duration ?? 0
    : duration

  // ── Background panel — video behind the highway ───────────────────────────
  // Three modes:
  //   • none      — no video, plain black background (default)
  //   • youtube   — embed a YouTube URL muted + autoplay + loop
  //   • video     — play an uploaded file (also muted) via <video>
  // Config + the source YouTube URL the track was ingested from live in
  // song.ini's [background] section. We hold the live state in React and
  // PATCH song.ini when the user saves a change.
  type BackgroundKind = 'none' | 'youtube' | 'video'
  const [bgKind, setBgKind] = useState<BackgroundKind>('none')
  const [bgValue, setBgValue] = useState('')
  const [bgSourceUrl, setBgSourceUrl] = useState('')
  // True when we've loaded the persisted state at least once; avoids the
  // sidebar flickering "none" before song.ini comes back.
  const [bgLoaded, setBgLoaded] = useState(false)
  // Most-recently-saved snapshot for the dirty indicator.
  const [bgSaved, setBgSaved] = useState<{ kind: BackgroundKind; value: string }>({ kind: 'none', value: '' })
  const bgDirty = bgKind !== bgSaved.kind || bgValue !== bgSaved.value

  // Load song.ini's background fields on mount + when track changes.
  useEffect(() => {
    if (!trackId) return
    let cancelled = false
    fetch(`/api/tracks/${trackId}/song-ini`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((data: Record<string, string>) => {
        if (cancelled) return
        const kind = (data.background_kind || 'none') as BackgroundKind
        const value = data.background_value || ''
        setBgKind(kind === 'youtube' || kind === 'video' ? kind : 'none')
        setBgValue(value)
        setBgSaved({ kind: kind === 'youtube' || kind === 'video' ? kind : 'none', value })
        setBgSourceUrl(data.youtube_source_url || '')
        setBgLoaded(true)
      })
      .catch(() => { if (!cancelled) setBgLoaded(true) })
    return () => { cancelled = true }
  }, [trackId])

  const saveBackground = useCallback(async () => {
    if (!trackId) return
    try {
      // PATCH merges into existing song.ini — we need to re-fetch + spread
      // so we don't blow away non-background fields like name / artist etc.
      const cur = await fetch(`/api/tracks/${trackId}/song-ini`).then((r) => r.ok ? r.json() : {})
      const next = {
        ...cur,
        background_kind: bgKind,
        background_value: bgValue,
        youtube_source_url: bgSourceUrl,
      }
      const fd = new FormData()
      fd.append('fields', JSON.stringify(next))
      const res = await fetch(`/api/tracks/${trackId}/song-ini`, { method: 'PATCH', body: fd })
      if (!res.ok) throw new Error(`${res.status}`)
      setBgSaved({ kind: bgKind, value: bgValue })
    } catch (e) {
      console.error('[background] save failed', e)
    }
  }, [trackId, bgKind, bgValue, bgSourceUrl])

  const uploadBackgroundVideo = useCallback(async (file: File) => {
    if (!trackId) return
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`/api/tracks/${trackId}/background-video`, { method: 'POST', body: fd })
    if (!res.ok) {
      console.error('[background] upload failed', await res.text())
      return
    }
    const data = await res.json() as { filename: string }
    setBgKind('video')
    setBgValue(data.filename)
  }, [trackId])

  // Extract a YouTube video id from any common URL shape so the iframe URL
  // is straightforward to construct. Returns '' if nothing matches.
  const ytId = useMemo(() => {
    const src = bgKind === 'youtube' ? bgValue : ''
    if (!src) return ''
    const m =
      src.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([A-Za-z0-9_-]{6,32})/)
      ?? src.match(/^([A-Za-z0-9_-]{6,32})$/)
    return m ? m[1] : ''
  }, [bgKind, bgValue])
  const [realNotesVolume, setRealNotesVolume] = useState(0.8)

  // ── Player input (Bluetooth / USB guitar via Gamepad API) ─────────────────
  // Play mode:
  //   • autohit — existing behaviour: real-note samples auto-fire when the
  //     playhead crosses each tick.
  //   • live    — the player drives the hits. Real-notes only fire when the
  //     player strums while holding the right fret combo near the strike.
  const [playMode, setPlayMode] = useState<'autohit' | 'live'>(() =>
    (localStorage.getItem('editor.playMode') as 'autohit' | 'live') || 'autohit',
  )

  // Test toggle: in autohit mode, deduct one hit from the first attempt of
  // every section, forcing it below `required` so the engine plays the
  // section's retry VO and seeks back. The second attempt counts normally.
  // Lets you audition retry_vo without switching to live mode and missing
  // notes on purpose.
  const [simulateRetryOnce, setSimulateRetryOnce] = useState(false)
  // Per-step attempt counter — how many times we've crossed INTO each step
  // boundary. First crossing = attempt 1; the simulation deducts a hit only
  // when this is 0 (i.e., we haven't entered this section yet). Cleared on
  // pause so a fresh play pass re-tests the retry path.
  const sectionAttemptsRef = useRef<Map<string, number>>(new Map())
  // Index of the step the playhead is currently inside, updated each frame.
  // Stays in sync with the playhead so a forward boundary cross can be
  // detected as `idx === lastStepIdxRef.current + 1`.
  const lastStepIdxRef = useRef<number>(-1)

  // Performer mode — hide both sidebars + the top header so the highway
  // fills the window. A small floating toggle lives at the top-right corner
  // of the canvas and `Esc` (or F11-style) restores the chrome.
  const [maxHighway, setMaxHighway] = useState(false)
  useEffect(() => {
    if (!maxHighway) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMaxHighway(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [maxHighway])
  useEffect(() => {
    try { localStorage.setItem('editor.playMode', playMode) } catch {}
  }, [playMode])

  // ── Live-play scoring ─────────────────────────────────────────────────────
  // Hit windows lifted from Assets/Scripts/Jamsesh/Gameplay/Guitar/Playback/
  // GuitarJudge.cs — perfect / good (= early-late) / okay (= veryEarly-veryLate).
  // okWindow is the early side; lateOkWindow is the (tighter) late side.
  const HIT_PERFECT_SEC = 0.060
  const HIT_GOOD_SEC = 0.120     // beyond perfect but within Good = Early/Late
  const HIT_EARLY_OK_SEC = 0.200 // beyond Good but accepted as VeryEarly
  const HIT_LATE_OK_SEC = 0.150  // tighter late side — beyond this = miss
  type Tier = 'perfect' | 'early' | 'late' | 'veryEarly' | 'veryLate'

  interface ScoringSettings {
    targets: Record<string, number>           // max score per difficulty section name
    multipliers: Record<Tier, number>         // points × multiplier per tier
  }
  const DEFAULT_SCORING_SETTINGS: ScoringSettings = {
    targets: {
      EasySingle: 500_000,
      MediumSingle: 1_000_000,
      HardSingle: 1_750_000,
      ExpertSingle: 2_500_000,
    },
    multipliers: {
      veryEarly: 0.30,
      early: 0.65,
      perfect: 1.0,
      late: 0.65,
      veryLate: 0.30,
    },
  }
  const [scoringSettings, setScoringSettings] = useState<ScoringSettings>(() => {
    try {
      const raw = localStorage.getItem('editor.scoring')
      if (!raw) return DEFAULT_SCORING_SETTINGS
      const parsed = JSON.parse(raw) as Partial<ScoringSettings>
      return {
        targets: { ...DEFAULT_SCORING_SETTINGS.targets, ...(parsed.targets ?? {}) },
        multipliers: { ...DEFAULT_SCORING_SETTINGS.multipliers, ...(parsed.multipliers ?? {}) },
      }
    } catch {
      return DEFAULT_SCORING_SETTINGS
    }
  })
  useEffect(() => {
    try { localStorage.setItem('editor.scoring', JSON.stringify(scoringSettings)) } catch {}
  }, [scoringSettings])

  // Live per-pass scoring state. Reset whenever play starts from the
  // beginning, the user seeks before the first note, or the difficulty
  // changes — so retries get a fresh slate.
  const [score, setScore] = useState(0)
  const [streak, setStreak] = useState(0)
  const [maxStreak, setMaxStreak] = useState(0)
  // Last strum outcome. Hit tiers track perfect / early / late etc;
  // diagnostic tiers explain why a strum was a miss:
  //   • miss   — note was missed (passed late-okay window, detected by the
  //              passive miss-scan effect)
  //   • empty  — user strummed with no playable note within the timing window
  //   • frets  — user strummed with a note in window but wrong fret combo
  type StrumFeedback = Tier | 'miss' | 'empty' | 'frets'
  const [lastTier, setLastTier] = useState<StrumFeedback | null>(null)
  const lastTierAtMsRef = useRef<number>(0)  // for fade-out timing on the HUD
  // Tracks real-note ticks that have already been counted as missed this pass
  // so we don't break the streak twice for the same note.
  const liveMissedTicksRef = useRef<Set<number>>(new Set())

  const resetScoring = useCallback(() => {
    setScore(0)
    setStreak(0)
    setMaxStreak(0)
    setLastTier(null)
    liveHitTicksRef.current = new Set()
    liveMissedTicksRef.current = new Set()
  }, [])

  // Reset on rewind-to-zero (or near it) and on difficulty switch.
  const lastResetGuardRef = useRef({ time: -1, diff: '' })
  useEffect(() => {
    const diff = chart?.activeName || ''
    const guard = lastResetGuardRef.current
    if (currentTime < 0.05 && (guard.time > 0.5 || guard.diff !== diff)) {
      resetScoring()
    }
    if (diff !== guard.diff) {
      resetScoring()
    }
    lastResetGuardRef.current = { time: currentTime, diff }
  }, [currentTime, chart?.activeName, resetScoring])

  // Points per perfect hit at the current difficulty — derived from the
  // configured target divided by the number of scoreable notes.
  const noteCountForScoring = useMemo(() => {
    if (!chart) return 0
    // A "scoreable" note is a unique tick with at least one playable lane
    // (0-4 fret OR open=lane 7). Chord ticks count once.
    const ticks = new Set<number>()
    for (const n of chart.notes) {
      if (n.lane <= 4 || n.lane === 7) ticks.add(n.tick)
    }
    return ticks.size
  }, [chart])
  const pointsPerPerfectHit = useMemo(() => {
    if (!chart || noteCountForScoring === 0) return 0
    const target = scoringSettings.targets[chart.activeName] ?? scoringSettings.targets.ExpertSingle ?? 2_500_000
    return Math.round(target / noteCountForScoring)
  }, [chart, noteCountForScoring, scoringSettings])

  // List of currently-connected gamepads, refreshed on connect/disconnect.
  // The dropdown also includes a sentinel "keyboard" entry so keyboard
  // bindings can be split into their own per-device set.
  const KEYBOARD_DEVICE_ID = 'keyboard'
  const [gamepadList, setGamepadList] = useState<Array<{ id: string; index: number; buttons: number }>>([])
  const [gamepadId, setGamepadId] = useState<string>(() => localStorage.getItem('editor.gamepadId') || '')
  const isKeyboardDevice = gamepadId === KEYBOARD_DEVICE_ID
  useEffect(() => {
    try { localStorage.setItem('editor.gamepadId', gamepadId) } catch {}
    // Wipe in-flight input state so swapping devices doesn't leak phantom
    // held frets or pressed keys from the previous device.
    heldFretsRef.current.clear()
    pressedKeysRef.current.clear()
  }, [gamepadId])

  const refreshGamepads = useCallback(() => {
    const list = (navigator.getGamepads?.() || [])
      .filter((g): g is Gamepad => !!g)
      .map((g) => ({ id: g.id, index: g.index, buttons: g.buttons.length }))
    setGamepadList(list)
    // Auto-select the only available device on first connection so the user
    // doesn't have to dig into the dropdown.
    if (!gamepadId && list.length > 0) setGamepadId(list[0].id)
  }, [gamepadId])

  // Continuous re-scan while the device list is empty — Chrome only enumerates
  // a Bluetooth HID gamepad after the first activation on the page, and the
  // `gamepadconnected` event sometimes fires before our useEffect attaches.
  useEffect(() => {
    refreshGamepads()
    const onChange = () => refreshGamepads()
    window.addEventListener('gamepadconnected', onChange)
    window.addEventListener('gamepaddisconnected', onChange)
    const poll = window.setInterval(() => {
      if (gamepadList.length === 0) refreshGamepads()
    }, 1000)
    return () => {
      window.removeEventListener('gamepadconnected', onChange)
      window.removeEventListener('gamepaddisconnected', onChange)
      window.clearInterval(poll)
    }
  }, [refreshGamepads, gamepadList.length])

  // Button mapping. Each slot holds parallel lists of gamepad button indices
  // and keyboard key codes (event.code, e.g. "KeyG", "Space"), so a single
  // lane can be triggered by any of: primary fret button, secondary fret
  // button, a chosen keyboard key, etc. Empty arrays = unbound. Persisted
  // per device id so swapping guitars doesn't clobber mappings.
  interface BindingSlot { buttons: number[]; keys: string[] }
  interface InputBinding {
    fret1: BindingSlot; fret2: BindingSlot; fret3: BindingSlot; fret4: BindingSlot; fret5: BindingSlot
    strumUp: BindingSlot; strumDown: BindingSlot
  }
  const emptySlot = (): BindingSlot => ({ buttons: [], keys: [] })
  const DEFAULT_BINDING: InputBinding = {
    fret1: emptySlot(), fret2: emptySlot(), fret3: emptySlot(),
    fret4: emptySlot(), fret5: emptySlot(),
    strumUp: emptySlot(), strumDown: emptySlot(),
  }
  // Migrate any legacy shape (single int, plain array, or partial slot)
  // into the current { buttons, keys } structure.
  const normaliseBinding = (raw: unknown): InputBinding => {
    if (!raw || typeof raw !== 'object') return DEFAULT_BINDING
    const out: InputBinding = {
      fret1: emptySlot(), fret2: emptySlot(), fret3: emptySlot(),
      fret4: emptySlot(), fret5: emptySlot(),
      strumUp: emptySlot(), strumDown: emptySlot(),
    }
    for (const k of Object.keys(DEFAULT_BINDING) as (keyof InputBinding)[]) {
      const v = (raw as Record<string, unknown>)[k]
      if (typeof v === 'number' && v >= 0) {
        out[k] = { buttons: [v], keys: [] }
      } else if (Array.isArray(v)) {
        out[k] = { buttons: v.filter((x): x is number => typeof x === 'number' && x >= 0), keys: [] }
      } else if (v && typeof v === 'object') {
        const slot = v as { buttons?: unknown; keys?: unknown }
        out[k] = {
          buttons: Array.isArray(slot.buttons)
            ? slot.buttons.filter((x): x is number => typeof x === 'number' && x >= 0)
            : [],
          keys: Array.isArray(slot.keys)
            ? slot.keys.filter((x): x is string => typeof x === 'string' && x.length > 0)
            : [],
        }
      }
    }
    return out
  }
  const bindingKey = `editor.binding.${gamepadId || 'default'}`
  const [binding, setBinding] = useState<InputBinding>(DEFAULT_BINDING)
  // Reference snapshot of what's persisted on disk for the current gamepad id.
  // Used to surface the "modified" indicator + drive the Save button's
  // disabled state. NOT used for live changes — those live in `binding`.
  const [savedBinding, setSavedBinding] = useState<InputBinding>(DEFAULT_BINDING)
  // Load the persisted mapping whenever the selected device changes. Explicit
  // user-initiated save (button below) is the only path that writes back —
  // an earlier auto-save effect was racing with this load and clobbering the
  // stored mapping when the gamepad id resolved post-mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(bindingKey)
      const loaded = raw ? normaliseBinding(JSON.parse(raw)) : DEFAULT_BINDING
      setBinding(loaded)
      setSavedBinding(loaded)
    } catch {
      setBinding(DEFAULT_BINDING)
      setSavedBinding(DEFAULT_BINDING)
    }
  }, [bindingKey])
  const saveBinding = () => {
    try {
      localStorage.setItem(bindingKey, JSON.stringify(binding))
      setSavedBinding(binding)
    } catch {}
  }
  const bindingDirty = JSON.stringify(binding) !== JSON.stringify(savedBinding)

  // Imperative handle to the 3D gem mesh layer — used to trigger one-shot
  // explosion FX on successful live-mode hits.
  const gemMeshLayerRef = useRef<GemMeshLayerHandle>(null)

  // Per-frame state for the connected gamepad. heldFrets is a Set of lane
  // indices (0-4) currently held; updated by the poll loop. lastEdge tracks
  // press/release transitions so we can fire one-shot events on strum.
  const heldFretsRef = useRef<Set<number>>(new Set())
  // Keyboard pressed-keys mirror (event.code strings). Drives held-detection
  // alongside gamepad buttons so a player can use either input device — or
  // both at once.
  const pressedKeysRef = useRef<Set<string>>(new Set())
  // Strum button currently pressed (gamepad or keyboard), per direction.
  // Used by the held-strip indicator so users can verify their strum input
  // is firing. Refs track the live value; the React state is only updated
  // when the value actually changes — otherwise the poll loop would call
  // setState 60×/sec with the same value and cost reconciliation cycles.
  const [strumDownLit, setStrumDownLit] = useState(false)
  const [strumUpLit, setStrumUpLit] = useState(false)
  const strumDownLitRef = useRef(false)
  const strumUpLitRef = useRef(false)
  // Timestamp (performance.now()) of the most recent press transition per
  // button index. Used by the release-debounce in the poll loop: a button's
  // release within RELEASE_DEBOUNCE_MS of its last press is treated as a
  // controller anti-ghost flicker and ignored. Short enough that intentional
  // taps still register if the user releases after the window.
  const lastPressMsRef = useRef<Map<number, number>>(new Map())
  const buttonStateRef = useRef<boolean[]>([])
  // When non-null, the next input event is captured here instead of being
  // dispatched to the live-play logic. Used by the "Listen" button. Accepts
  // either a gamepad button press or a keyboard keydown.
  type CaptureInput = { kind: 'btn'; index: number } | { kind: 'key'; code: string }
  const captureNextPressRef = useRef<((input: CaptureInput) => void) | null>(null)
  // Fires when a strum button transitions to pressed. Set by the live-play
  // hit-detection effect; the poll loop calls it.
  const onStrumRef = useRef<(() => void) | null>(null)

  // Window keyboard listener — active when the Keyboard device is selected
  // OR when a capture is pending (so a user binding a key on a gamepad
  // device can still press a key to register one — but their gameplay
  // input still requires the keyboard device to be active to fire). Strums
  // fire on keydown; fret keys update pressedKeysRef and the rAF poll
  // picks them up.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when the user is typing into an input/textarea.
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      const code = e.code
      // Capture mode short-circuits before anything else interprets the key.
      const cap = captureNextPressRef.current
      if (cap) {
        captureNextPressRef.current = null
        cap({ kind: 'key', code })
        e.preventDefault()
        return
      }
      // Past this point, keyboard only drives gameplay when the Keyboard
      // device is selected — otherwise we let the page handle the keypress.
      if (!isKeyboardDevice) return
      if (pressedKeysRef.current.has(code)) return  // browser auto-repeat
      pressedKeysRef.current.add(code)
      if (binding.strumUp.keys.includes(code) || binding.strumDown.keys.includes(code)) {
        onStrumRef.current?.()
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      pressedKeysRef.current.delete(e.code)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [binding, isKeyboardDevice])

  // Poll loop — always runs so keyboard-only users still get held-state
  // updates. When no gamepad id is selected (or the device isn't found yet)
  // the gamepad-specific blocks are skipped but the held recompute over
  // pressedKeysRef still happens each frame.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const pads = navigator.getGamepads?.() || []
      let gp: Gamepad | null = null
      if (gamepadId) {
        for (const p of pads) { if (p && p.id === gamepadId) { gp = p; break } }
      }
      // No gamepad → fall through to held recompute (keyboard-only).
      if (!gp) {
        buttonStateRef.current = []
        const computeSlotHeld = (slot: BindingSlot): boolean => {
          for (const k of slot.keys) if (pressedKeysRef.current.has(k)) return true
          return false
        }
        const lanes: BindingSlot[] = [binding.fret1, binding.fret2, binding.fret3, binding.fret4, binding.fret5]
        for (let lane = 0; lane < 5; lane++) {
          if (computeSlotHeld(lanes[lane])) heldFretsRef.current.add(lane)
          else heldFretsRef.current.delete(lane)
        }
        {
          const dn = computeSlotHeld(binding.strumDown)
          const up = computeSlotHeld(binding.strumUp)
          if (dn !== strumDownLitRef.current) { strumDownLitRef.current = dn; setStrumDownLit(dn) }
          if (up !== strumUpLitRef.current)   { strumUpLitRef.current   = up; setStrumUpLit(up) }
        }
        return
      }
      if (buttonStateRef.current.length !== gp.buttons.length) {
        buttonStateRef.current = new Array(gp.buttons.length).fill(false)
      }
      // Two-pass: gather every transition this frame first, then apply fret
      // press/release updates BEFORE strum-edge handlers fire. This way a
      // simultaneous chord+strum (e.g. fret1 + fret2 + strum all transition
      // in the same poll frame) has the full held-frets set ready when the
      // strum handler reads it, regardless of the underlying button-index
      // ordering on the device.
      //
      // Release-debounce: many controllers (CRKD guitars, certain HID
      // gamepads) have input-matrix anti-ghosting that briefly drops the
      // 'pressed' state of one button when an adjacent button is pressed.
      // We suppress release transitions that arrive within RELEASE_DEBOUNCE_MS
      // of the last press for that button — chord flickers stay held, real
      // taps after the window release normally.
      const RELEASE_DEBOUNCE_MS = 40
      const nowMs = performance.now()
      const transitions: Array<{ index: number; pressed: boolean }> = []
      for (let i = 0; i < gp.buttons.length; i++) {
        const isPressed = gp.buttons[i].pressed
        const wasPressed = buttonStateRef.current[i]
        if (isPressed === wasPressed) continue
        if (isPressed) {
          buttonStateRef.current[i] = true
          lastPressMsRef.current.set(i, nowMs)
          transitions.push({ index: i, pressed: true })
        } else {
          const lastPress = lastPressMsRef.current.get(i) ?? 0
          if (nowMs - lastPress < RELEASE_DEBOUNCE_MS) {
            // Suspected anti-ghost flicker — leave button as still-pressed.
            // The next true release after the window expires will fire.
            continue
          }
          buttonStateRef.current[i] = false
          transitions.push({ index: i, pressed: false })
        }
      }
      // We DO NOT bail early on no-transition frames anymore — keyboard
      // input arrives via window listeners and needs heldFretsRef to be
      // recomputed from pressedKeysRef each frame too.

      // Pass 1: capture-mode short-circuit (first press only).
      for (const t of transitions) {
        if (!t.pressed) continue
        const cap = captureNextPressRef.current
        if (cap) {
          captureNextPressRef.current = null
          cap({ kind: 'btn', index: t.index })
          return  // Eat this entire frame so a paired strum doesn't fire too.
        }
      }
      // Pass 2: fret press/release — recompute heldFretsRef from the full
      // gamepad + keyboard state. A lane is considered "held" if any of its
      // bound buttons OR keys is currently pressed.
      const computeSlotHeld = (slot: BindingSlot): boolean => {
        for (const idx of slot.buttons) if (buttonStateRef.current[idx]) return true
        for (const k of slot.keys) if (pressedKeysRef.current.has(k)) return true
        return false
      }
      const laneSlots: BindingSlot[] = [
        binding.fret1, binding.fret2, binding.fret3, binding.fret4, binding.fret5,
      ]
      for (let lane = 0; lane < 5; lane++) {
        if (computeSlotHeld(laneSlots[lane])) heldFretsRef.current.add(lane)
        else heldFretsRef.current.delete(lane)
      }
      // Strum indicator state — lit while a bound strum input is held.
      // Refs track the live value; React state only changes on transitions.
      const dn = computeSlotHeld(binding.strumDown)
      const up = computeSlotHeld(binding.strumUp)
      if (dn !== strumDownLitRef.current) { strumDownLitRef.current = dn; setStrumDownLit(dn) }
      if (up !== strumUpLitRef.current)   { strumUpLitRef.current   = up; setStrumUpLit(up) }
      // Pass 3: strum edges — gamepad press transitions only (keyboard
      // strums fire from the keydown listener instead).
      for (const t of transitions) {
        if (!t.pressed) continue
        if (binding.strumUp.buttons.includes(t.index) || binding.strumDown.buttons.includes(t.index)) {
          onStrumRef.current?.()
        }
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [gamepadId, binding])

  // Auto-map wizard — steps the user through each binding in sequence.
  // null = idle; otherwise the binding key currently waiting on a press.
  const [autoMapStep, setAutoMapStep] = useState<keyof InputBinding | null>(null)
  const autoMapOrder: (keyof InputBinding)[] = useMemo(
    () => ['fret1', 'fret2', 'fret3', 'fret4', 'fret5', 'strumUp', 'strumDown'],
    [],
  )
  const startAutoMap = () => {
    if (!gamepadId) return
    setAutoMapStep(autoMapOrder[0])
  }
  // Each step: install a captureNextPress that REPLACES the binding's
  // appropriate side (button OR key) then advances to the next slot.
  useEffect(() => {
    if (!autoMapStep) return
    captureNextPressRef.current = (input: CaptureInput) => {
      setBinding((b) => {
        const slot = b[autoMapStep]
        const next: BindingSlot = input.kind === 'btn'
          ? { buttons: [input.index], keys: slot.keys }
          : { buttons: slot.buttons, keys: [input.code] }
        return { ...b, [autoMapStep]: next }
      })
      const idx = autoMapOrder.indexOf(autoMapStep)
      const next = idx >= 0 && idx + 1 < autoMapOrder.length ? autoMapOrder[idx + 1] : null
      setAutoMapStep(next)
    }
    return () => { captureNextPressRef.current = null }
  }, [autoMapStep, autoMapOrder])

  // Listen ADDS to the binding's array — supports secondary frets, keyboard
  // alternates, etc. Only the input type matching the selected device is
  // accepted (gamepad device → button presses; keyboard device → keys).
  const listenForBinding = (key: keyof InputBinding) => {
    setAutoMapStep(null)
    captureNextPressRef.current = (input: CaptureInput) => {
      // Filter to the active device kind so a stray keypress doesn't bind on
      // a gamepad device (and vice versa).
      if (isKeyboardDevice && input.kind !== 'key') return
      if (!isKeyboardDevice && input.kind !== 'btn') return
      setBinding((b) => {
        const slot = b[key]
        if (input.kind === 'btn') {
          if (slot.buttons.includes(input.index)) return b
          return { ...b, [key]: { ...slot, buttons: [...slot.buttons, input.index] } }
        }
        if (slot.keys.includes(input.code)) return b
        return { ...b, [key]: { ...slot, keys: [...slot.keys, input.code] } }
      })
    }
  }

  const BINDING_LABELS: Record<keyof InputBinding, string> = {
    fret1: 'Green',     fret2: 'Red',       fret3: 'Yellow',
    fret4: 'Blue',      fret5: 'Orange',
    strumUp: 'Strum ↑', strumDown: 'Strum ↓',
  }

  // Live mirror of heldFretsRef as React state, polled every animation frame.
  // Drives the small lane-indicator strip under the bindings list so the user
  // can verify multi-fret detection at a glance. Diff-checked so we only
  // re-render when the set actually changes. Also mirrors what the 3D ghost
  // renderer is reading (via __ghostHeld) so we can detect a ref/closure
  // mismatch between the input layer and the renderer.
  const [heldFretsView, setHeldFretsView] = useState<number[]>([])
  const [ghostHeldView, setGhostHeldView] = useState<number[]>([])
  // Throttle the diagnostic mirror to ~12 fps. The strip is a visual aid;
  // updating it 60×/sec triggers React reconciliation on the entire editor
  // tree four-five times more often than necessary and shows up as a frame
  // budget burn on the runway scroll.
  useEffect(() => {
    const DIAGNOSTIC_INTERVAL_MS = 80
    let raf = 0
    let lastUpdate = 0
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (now - lastUpdate < DIAGNOSTIC_INTERVAL_MS) return
      lastUpdate = now
      const cur = [...heldFretsRef.current].sort((a, b) => a - b)
      setHeldFretsView((prev) => {
        if (prev.length === cur.length && prev.every((v, i) => v === cur[i])) return prev
        return cur
      })
      const ghost = ((window as unknown as { __ghostHeld?: number[] }).__ghostHeld) || []
      setGhostHeldView((prev) => {
        if (prev.length === ghost.length && prev.every((v, i) => v === ghost[i])) return prev
        return ghost
      })
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  const [realNotesReady, setRealNotesReady] = useState(false)
  const realNotesCtxRef = useRef<AudioContext | null>(null)
  const realNotesGainRef = useRef<GainNode | null>(null)
  // Nested: "pack__scale" key → sample-name → AudioBuffer. A beatmap can use
  // multiple (pack, scale) combos within different sections, so the outer key
  // is the combo identifier; the resolver looks up the right one per note.
  const realNotesBuffersRef = useRef<Map<string, Map<string, AudioBuffer>> | null>(null)
  // Pre-computed list of (seconds, pack, scale, sample-name) for every real-
  // note in the chart, sorted by seconds. Rebuilt when the chart or tempo
  // map changes.
  const realNotesEntriesRef = useRef<Array<{ sec: number; pack: string; scale: string; sampleName: string }>>([])
  // Last currentTime we processed — used to detect playback range so we don't
  // re-fire samples on every animation frame.
  const realNotesLastTimeRef = useRef<number>(0)
  const clickGainRef = useRef<GainNode | null>(null)
  const audioSrc = audioSource === 'track-song'
    ? `/api/tracks/${trackId}/stems/song`
    : `/api/tracks/${trackId}/beatmaps/${beatmapId}/download/song.ogg`
  // Preserve the playhead across an audioSrc swap. Captured pre-swap, applied
  // once the new <audio> reports loaded metadata.
  const pendingSeekRef = useRef<number | null>(null)
  const switchAudioSource = (next: 'beatmap' | 'track-song') => {
    if (next === audioSource) return
    pendingSeekRef.current = currentTime
    setAudioSource(next)
  }

  // Transient rule-violation banner shown above the runway. Anything that
  // tries to commit an invalid chart state (placement, drag, paste, nudge)
  // calls flashRuleError instead of committing.
  const [ruleError, setRuleError] = useState('')
  const ruleErrorTimerRef = useRef<number | null>(null)
  const flashRuleError = useCallback((msg: string) => {
    setRuleError(msg)
    if (ruleErrorTimerRef.current) clearTimeout(ruleErrorTimerRef.current)
    ruleErrorTimerRef.current = window.setTimeout(() => setRuleError(''), 2500)
  }, [])

  // Push the current notes snapshot onto the undo stack and apply the new one.
  // Use this for any change the user would expect Ctrl+Z to revert: add, delete,
  // paste, drag-end, arrow-nudge, sustain-toggle. Avoid pushing on every frame
  // mid-drag (handleMouseMove writes through directly).
  const commitNotes = useCallback((nextNotes: ChartNote[]) => {
    let rejected = false
    setChart((prev) => {
      if (!prev) return prev
      const err = checkNoteRules(nextNotes, prev.resolution)
      if (err) {
        rejected = true
        flashRuleError(err)
        return prev
      }
      historyRef.current.push({ activeName: prev.activeName, notes: prev.notes })
      if (historyRef.current.length > 100) historyRef.current.shift()
      futureRef.current = []
      setHistoryTick((n) => n + 1)
      return { ...prev, notes: nextNotes }
    })
    if (!rejected) setDirty(true)
  }, [flashRuleError])

  const updateSections = useCallback((updater: (prev: ChartSection[]) => ChartSection[]) => {
    setChart((prev) => {
      if (!prev) return prev
      return { ...prev, sections: updater(prev.sections) }
    })
    setDirty(true)
  }, [])

  const addSectionAtPlayhead = useCallback(() => {
    if (!chart) return
    const tick = secToTick(tempoSegments, chart.resolution, currentTime)
    const id = `section-${tick}-${Date.now()}`
    updateSections((prev) => [...prev, { id, tick, name: 'New section' }].sort((a, b) => a.tick - b.tick))
  }, [chart, currentTime, updateSections, tempoSegments])

  // Tempo map editing. tempoMarkers must always have a tick=0 entry (the song
  // origin tempo) — we surface this by disabling the tick-0 delete button and
  // keeping the tick field read-only on that row.
  const updateTempoMarkerBpm = useCallback((idx: number, bpm: number) => {
    if (!Number.isFinite(bpm) || bpm <= 0) return
    const microBpm = Math.max(1, Math.round(bpm * 1000))
    setChart((prev) => {
      if (!prev) return prev
      const next = prev.tempoMarkers.slice()
      if (!next[idx]) return prev
      next[idx] = { ...next[idx], microBpm }
      // bpm/bpmRaw are legacy display fields keyed off tick 0
      const bpmRaw = next[0]?.microBpm ?? prev.bpmRaw
      return { ...prev, tempoMarkers: next, bpm: bpmRaw / 1000, bpmRaw }
    })
    setDirty(true)
  }, [])

  const updateTempoMarkerTick = useCallback((idx: number, tick: number) => {
    if (!Number.isFinite(tick) || tick < 0) return
    setChart((prev) => {
      if (!prev) return prev
      if (idx === 0) return prev  // tick-0 origin is fixed
      const next = prev.tempoMarkers.slice()
      if (!next[idx]) return prev
      next[idx] = { ...next[idx], tick: Math.round(tick) }
      next.sort((a, b) => a.tick - b.tick)
      return { ...prev, tempoMarkers: next }
    })
    setDirty(true)
  }, [])

  const deleteTempoMarker = useCallback((idx: number) => {
    setChart((prev) => {
      if (!prev) return prev
      if (idx === 0) return prev  // can't delete the song-origin marker
      const next = prev.tempoMarkers.filter((_, i) => i !== idx)
      if (next.length === 0) return prev
      const bpmRaw = next[0].microBpm
      return { ...prev, tempoMarkers: next, bpm: bpmRaw / 1000, bpmRaw }
    })
    setDirty(true)
  }, [])

  const addTempoMarkerAtPlayhead = useCallback(() => {
    if (!chart) return
    const tick = secToTick(tempoSegments, chart.resolution, currentTime)
    // No-op if there's already a marker at this tick — editing the existing
    // one is more discoverable than silently overwriting.
    if (chart.tempoMarkers.some((m) => m.tick === tick)) return
    // Default new tempo to the preceding segment's bpm so the timing line
    // doesn't jolt the instant you add a marker.
    let i = tempoSegments.length - 1
    while (i > 0 && tempoSegments[i].tick > tick) i--
    const microBpm = tempoSegments[i]?.microBpm ?? 120000
    setChart((prev) => {
      if (!prev) return prev
      const next = [...prev.tempoMarkers, { tick, microBpm }].sort((a, b) => a.tick - b.tick)
      const bpmRaw = next[0].microBpm
      return { ...prev, tempoMarkers: next, bpm: bpmRaw / 1000, bpmRaw }
    })
    setDirty(true)
  }, [chart, currentTime, tempoSegments])

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

  // Load chart, custom scene-event types, and beatmap meta in parallel. The
  // custom types must be resolved before parsing so the parser knows which
  // non-`onboard_*` event names to claim (vs. leave in passthrough).
  useEffect(() => {
    Promise.all([
      fetch(`/api/tracks/${trackId}/beatmaps/${beatmapId}/chart`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))),
      fetch('/api/scene-events/types')
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => []),
    ])
      .then(([data, types]) => {
        const adapted = (types as RawCustomType[]).map(adaptCustomType)
        setCustomSceneTypes(adapted)
        const customNames = new Set(adapted.map((t) => t.name))
        setChart(parseChart(data.chart, undefined, customNames))
      })
      .catch((e) => setLoadError((e as Error).message))

    fetch(`/api/tracks/${trackId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((track) => {
        if (!track) return
        const bm = (track.beatmaps || []).find((b: { id: string }) => b.id === beatmapId)
        // track.stems is a dict keyed by stem name; album_png is the cover-art
        // entry written when the track is published. If it's absent we skip
        // rendering the <img> entirely instead of triggering a 404 + onError.
        const hasAlbumArt = !!(track.stems && track.stems.album_png)
        if (bm) setMeta({ name: bm.song_name, stem: bm.stem, hasAlbumArt })
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

  // Apply playback rate + pitch correction to the audio element. preservesPitch
  // is supported in modern Chromium/Firefox/Safari; the prefixed variants are
  // there for older WebKit.
  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    a.playbackRate = playbackRate
    type WithPitch = HTMLAudioElement & {
      preservesPitch?: boolean
      mozPreservesPitch?: boolean
      webkitPreservesPitch?: boolean
    }
    const ap = a as WithPitch
    ap.preservesPitch = true
    ap.mozPreservesPitch = true
    ap.webkitPreservesPitch = true
  }, [playbackRate])

  // Live-update the click track output gain. Keeping it on a useEffect (vs.
  // reading clickVolume inside the scheduler) avoids restarting the scheduler
  // when the slider moves.
  useEffect(() => {
    if (clickGainRef.current) {
      clickGainRef.current.gain.value = clickVolume
    }
  }, [clickVolume])

  // Click track scheduler. While the transport is playing and the click is
  // enabled, schedule short oscillator blips at every beat boundary against
  // the AudioContext clock. Downbeats (every 4th beat, 4/4 assumed) get a
  // higher pitch so charters can hear bar lines. Walks the tempo map so beats
  // stay aligned through mid-song tempo changes; reseeds on seek drift or
  // playback-rate changes so the click never desyncs from the song.
  useEffect(() => {
    if (!clickEnabled || !playing || !chart) return
    const audio = audioRef.current
    if (!audio) return
    if (!clickCtxRef.current) {
      const AC = window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return
      clickCtxRef.current = new AC()
      const gain = clickCtxRef.current.createGain()
      gain.gain.value = clickVolume
      gain.connect(clickCtxRef.current.destination)
      clickGainRef.current = gain
    }
    const ctx = clickCtxRef.current
    const gain = clickGainRef.current!
    // Some browsers start the AudioContext suspended until user gesture; the
    // play button is one, so this should resume cleanly.
    if (ctx.state === 'suspended') ctx.resume().catch(() => undefined)

    const resolution = chart.resolution

    // Anchor: at time `anchorCtx` (AudioContext clock), the song was at
    // `anchorAudio` (audio.currentTime). Future beats convert to ctx time via
    //   ctxTime = anchorCtx + (beatSec - anchorAudio) / playbackRate
    let anchorAudio = audio.currentTime
    let anchorCtx = ctx.currentTime

    const reseedBeat = (): number => {
      // Walk beats from 0 until we pass the current audio position. Charts
      // top out around ~3000 beats for a 5-minute song at 120 BPM — fast.
      let i = 0
      while (i < 50000) {
        const t = tickToSec(tempoSegments, resolution, i * resolution)
        if (t >= anchorAudio - 0.001) break
        i++
      }
      return i
    }
    let nextBeat = reseedBeat()

    const LOOKAHEAD_SEC = 0.12
    const TICK_MS = 25
    const scheduleClick = (ctxTime: number, isDownbeat: boolean) => {
      const osc = ctx.createOscillator()
      osc.type = 'square'
      osc.frequency.value = isDownbeat ? 1600 : 1000
      const env = ctx.createGain()
      env.gain.setValueAtTime(0.0001, ctxTime)
      env.gain.exponentialRampToValueAtTime(1, ctxTime + 0.001)
      env.gain.exponentialRampToValueAtTime(0.0001, ctxTime + 0.04)
      osc.connect(env).connect(gain)
      osc.start(ctxTime)
      osc.stop(ctxTime + 0.05)
    }

    let timer: number | null = null
    const tick = () => {
      if (!audioRef.current) return
      const a = audioRef.current
      // Drift check: if the audio's currentTime no longer matches what the
      // anchor predicts (a seek happened, or the audio paused/buffered),
      // reseed both the anchor and the beat counter.
      const expected = anchorAudio + (ctx.currentTime - anchorCtx) * playbackRate
      if (Math.abs(a.currentTime - expected) > 0.06 || a.paused) {
        anchorAudio = a.currentTime
        anchorCtx = ctx.currentTime
        nextBeat = reseedBeat()
        if (a.paused) {
          timer = window.setTimeout(tick, TICK_MS)
          return
        }
      }
      const horizon = ctx.currentTime + LOOKAHEAD_SEC
      while (true) {
        const beatSec = tickToSec(tempoSegments, resolution, nextBeat * resolution)
        const beatCtxTime = anchorCtx + (beatSec - anchorAudio) / Math.max(0.01, playbackRate)
        if (beatCtxTime > horizon) break
        // Drop beats that are already in the past (post-seek) — they'd
        // either fire late or all at once.
        if (beatCtxTime >= ctx.currentTime - 0.01) {
          scheduleClick(beatCtxTime, nextBeat % 4 === 0)
        }
        nextBeat++
        if (nextBeat > 200000) break
      }
      timer = window.setTimeout(tick, TICK_MS)
    }
    tick()

    return () => {
      if (timer !== null) clearTimeout(timer)
    }
  }, [clickEnabled, playing, chart, tempoSegments, playbackRate, clickVolume])

  // Tear down the AudioContext on unmount so a backgrounded editor doesn't
  // hold onto audio resources.
  useEffect(() => {
    return () => {
      const ctx = clickCtxRef.current
      if (ctx) {
        ctx.close().catch(() => undefined)
        clickCtxRef.current = null
        clickGainRef.current = null
      }
      const rctx = realNotesCtxRef.current
      if (rctx) {
        rctx.close().catch(() => undefined)
        realNotesCtxRef.current = null
        realNotesGainRef.current = null
        realNotesBuffersRef.current = null
      }
    }
  }, [])

  // ── Sound pack picker ─────────────────────────────────────────────────────
  // Catalog is shared across all beatmaps, fetched once.
  useEffect(() => {
    let cancelled = false
    fetch('/api/sample-packs')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return
        setPackCatalog(data.packs || [])
        setScaleCatalog(data.scales || [])
        if (data.packs?.length) setPickedPackId((cur) => cur || data.packs[0].pack_id)
        if (data.scales?.length) setPickedScaleId((cur) => cur || data.scales[0].scale_id)
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  // Default the picker to whatever (pack, scale) is most-recently used by an
  // existing real-note in the current chart, so re-opening a beatmap puts the
  // user back where they left off. Falls through to the catalog's first entry
  // when nothing's been authored yet.
  useEffect(() => {
    if (!chart) return
    let lastPack: string | undefined
    let lastScale: string | undefined
    for (const n of chart.notes) {
      if (n.type === 'real') {
        if (n.pack) lastPack = n.pack
        if (n.scale) lastScale = n.scale
      }
    }
    if (lastPack) setPickedPackId((cur) => cur || lastPack)
    if (lastScale) setPickedScaleId((cur) => cur || lastScale)
  }, [chart])

  const playPackPreview = () => {
    if (!pickedPackId || !pickedScaleId) return
    if (packPreviewRef.current) {
      packPreviewRef.current.pause()
      packPreviewRef.current = null
      setPackPreviewing(false)
      return
    }
    const url = `/api/sample-packs/${encodeURIComponent(pickedPackId)}/${encodeURIComponent(pickedScaleId)}/preview`
    const a = new Audio(url)
    a.onended = () => { setPackPreviewing(false); packPreviewRef.current = null }
    a.onerror = () => { setPackPreviewing(false); packPreviewRef.current = null }
    packPreviewRef.current = a
    setPackPreviewing(true)
    a.play().catch(() => { setPackPreviewing(false); packPreviewRef.current = null })
  }

  // Cancel any in-flight preview when the user switches pack or scale.
  useEffect(() => {
    if (packPreviewRef.current) {
      packPreviewRef.current.pause()
      packPreviewRef.current = null
      setPackPreviewing(false)
    }
  }, [pickedPackId, pickedScaleId])

  // ── Real-notes sample playback ────────────────────────────────────────────
  // Resolve which sample a real-note at `tick` should play. Mirrors the
  // game-side rule:
  //   - lane 7 present → 'open'
  //   - exactly 1 fret lane → 'lane_{N+1}'
  //   - exactly 2 fret lanes → 'chord_{a}{b}' with adjacent-lane fallback
  //   - 3+ fret lanes → first lane's sample (defensive fallback)
  // Pack/scale come from the lowest-lane real-note at the tick — chord
  // members are expected to share pack/scale, but if they don't the lowest
  // one wins so the chord_xy lookup matches the lowest+next-lowest lane semantic.
  const _resolveRealNote = useCallback((tick: number): { pack: string; scale: string; sampleName: string } | null => {
    if (!chart) return null
    const fretLanes: number[] = []
    let hasOpen = false
    let pack: string | undefined
    let scale: string | undefined
    let lowestRealLane = Infinity
    for (const n of chart.notes) {
      if (n.tick !== tick) continue
      if (n.lane === 7) hasOpen = true
      else if (n.lane <= 4) fretLanes.push(n.lane)
      if (n.type === 'real' && n.lane <= 7 && n.lane < lowestRealLane) {
        lowestRealLane = n.lane
        pack = n.pack
        scale = n.scale
      }
    }
    if (!pack || !scale) return null
    let sampleName: string | null = null
    if (hasOpen) sampleName = 'open'
    else if (fretLanes.length === 1) sampleName = `lane_${fretLanes[0] + 1}`
    else if (fretLanes.length >= 2) {
      const sorted = [...fretLanes].sort((a, b) => a - b)
      // Only canonical adjacent-lane chords have a pre-rendered sample
      // (chord_12 / chord_23 / chord_34 / chord_45). Wider chords fall back
      // to the lower lane's solo sample.
      sampleName = (sorted[1] - sorted[0] === 1)
        ? `chord_${sorted[0] + 1}${sorted[1] + 1}`
        : `lane_${sorted[0] + 1}`
    }
    if (!sampleName) return null
    return { pack, scale, sampleName }
  }, [chart])

  // Decode every (pack, scale) combo referenced by the chart's R notes into
  // AudioBuffers. Re-fetches when the set of combos changes — fingerprint is
  // the sorted unique pack__scale list so adding/removing notes within an
  // already-loaded combo doesn't refetch.
  const usedComboFingerprint = (() => {
    if (!chart) return ''
    const set = new Set<string>()
    for (const n of chart.notes) {
      if (n.type === 'real' && n.pack && n.scale) set.add(`${n.pack}__${n.scale}`)
    }
    return [...set].sort().join('|')
  })()
  useEffect(() => {
    let cancelled = false
    setRealNotesReady(false)
    realNotesBuffersRef.current = null
    if (!usedComboFingerprint) return
    const combos = usedComboFingerprint.split('|').filter(Boolean)
    const SLOTS = ['lane_1', 'lane_2', 'lane_3', 'lane_4', 'lane_5',
                   'chord_12', 'chord_23', 'chord_34', 'chord_45', 'open']
    ;(async () => {
      if (!realNotesCtxRef.current) {
        const AC = window.AudioContext
          || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!AC) return
        // latencyHint: 'interactive' picks the smallest hardware buffer the
        // browser/OS can sustain, trading a bit of CPU for ~tens of ms less
        // input-to-sound delay. Critical when the user is strumming live.
        realNotesCtxRef.current = new AC({ latencyHint: 'interactive' })
        const gain = realNotesCtxRef.current.createGain()
        gain.gain.value = realNotesVolume
        gain.connect(realNotesCtxRef.current.destination)
        realNotesGainRef.current = gain
      }
      const ctx = realNotesCtxRef.current
      const outer = new Map<string, Map<string, AudioBuffer>>()
      for (const key of combos) {
        const [pack, scale] = key.split('__')
        if (!pack || !scale) continue
        const inner = new Map<string, AudioBuffer>()
        for (const sampleName of SLOTS) {
          try {
            const r = await fetch(
              `/api/sample-packs/${encodeURIComponent(pack)}/${encodeURIComponent(scale)}/${sampleName}.ogg`,
            )
            if (!r.ok) continue
            const ab = await r.arrayBuffer()
            const decoded = await ctx.decodeAudioData(ab)
            if (cancelled) return
            inner.set(sampleName, decoded)
          } catch {
            // Per-sample failure isn't fatal — others may still play.
          }
        }
        if (inner.size > 0) outer.set(key, inner)
      }
      if (cancelled) return
      if (outer.size === 0) return
      realNotesBuffersRef.current = outer
      setRealNotesReady(true)
    })()
    return () => { cancelled = true }
  }, [usedComboFingerprint])  // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the master gain in sync with the volume slider without restarting
  // any in-flight buffer sources.
  useEffect(() => {
    if (realNotesGainRef.current) {
      realNotesGainRef.current.gain.value = realNotesVolume
    }
  }, [realNotesVolume])

  // Rebuild the (sec, pack, scale, sampleName) entry list whenever the chart
  // or tempo map changes. Pre-sorted by sec so the fire-on-cross effect can
  // scan a bounded window in O(crossings).
  useEffect(() => {
    if (!chart) {
      realNotesEntriesRef.current = []
      return
    }
    const realTicks = new Set<number>()
    for (const n of chart.notes) if (n.type === 'real') realTicks.add(n.tick)
    const entries: Array<{ sec: number; pack: string; scale: string; sampleName: string }> = []
    for (const tick of realTicks) {
      const resolved = _resolveRealNote(tick)
      if (!resolved) continue
      entries.push({
        sec: tickToSec(tempoSegments, chart.resolution, tick),
        pack: resolved.pack,
        scale: resolved.scale,
        sampleName: resolved.sampleName,
      })
    }
    entries.sort((a, b) => a.sec - b.sec)
    realNotesEntriesRef.current = entries
  }, [chart, tempoSegments, _resolveRealNote])

  // Helper — fire a single decoded sample now via the AudioContext. Used by
  // both the autohit-mode cross effect and the live-mode strum handler.
  // Schedules with `start(0)` (= "as soon as possible" in the audio thread)
  // for the lowest hardware-buffered latency. Autohit batches fire on the
  // same rAF tick anyway, so they remain phase-locked without the old
  // 5 ms look-ahead.
  const fireSampleNow = useCallback((pack: string, scale: string, sampleName: string) => {
    const ctx = realNotesCtxRef.current
    const gain = realNotesGainRef.current
    const buffers = realNotesBuffersRef.current
    if (!ctx || !gain || !buffers) return
    if (ctx.state === 'suspended') ctx.resume().catch(() => undefined)
    const inner = buffers.get(`${pack}__${scale}`)
    const buf = inner?.get(sampleName)
    if (!buf) return
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(gain)
    src.start(0)
  }, [])

  // Fire matching samples as the playhead crosses real-notes during playback.
  // Only active in 'autohit' mode — in 'live' mode the player drives hits via
  // the gamepad. Detects seeks via a delta threshold and rebases without
  // firing.
  useEffect(() => {
    if (!playing || !realNotesEnabled || !realNotesReady || playMode !== 'autohit') {
      realNotesLastTimeRef.current = currentTime
      return
    }
    const prev = realNotesLastTimeRef.current
    const delta = currentTime - prev
    if (delta < 0 || delta > 0.5) {
      realNotesLastTimeRef.current = currentTime
      return
    }
    if (delta <= 0) return
    const entries = realNotesEntriesRef.current
    const liveEntries = liveEntriesRef.current
    for (const e of entries) {
      if (e.sec <= prev) continue
      if (e.sec > currentTime) break
      if (e.sampleName) fireSampleNow(e.pack, e.scale, e.sampleName)
      // Spawn explosions on the lanes the note covers. Look up the fret set
      // from the live-entry index (same set, same sec) so we don't have to
      // walk chart.notes here.
      const matched = liveEntries.find((l) => l.sec === e.sec)
      if (matched) {
        const lanes = matched.frets === null ? [0, 1, 2, 3, 4] : [...matched.frets]
        for (const lane of lanes) gemMeshLayerRef.current?.spawnExplosion(lane)
      }
    }
    realNotesLastTimeRef.current = currentTime
  }, [currentTime, playing, realNotesEnabled, realNotesReady, playMode, fireSampleNow])

  // ── Live play hit detection ───────────────────────────────────────────────
  // Per-tick fret requirement, computed once from the chart so the strum
  // handler can match held frets to the nearest real-note without walking
  // chart.notes every press. Each entry: { sec, pack, scale, sampleName,
  // frets: Set<lane>|null }. `frets === null` means open note (no frets held).
  // pack/scale are empty strings on ticks with no real-note (the hit still
  // registers silently for scoring).
  const liveEntriesRef = useRef<Array<{ sec: number; pack: string; scale: string; sampleName: string; frets: Set<number> | null }>>([])
  // Set of (real-note tick × seconds) already hit this play pass so a single
  // strum can't double-fire the same note. Cleared on seek/pause.
  const liveHitTicksRef = useRef<Set<number>>(new Set())

  useEffect(() => {
    if (!chart) { liveEntriesRef.current = []; return }
    // Live play scores EVERY playable tick (any lane 0-4 fret or lane 7
    // open), not only real-note flagged ticks. Real-note flags are about
    // pitched sample playback — they don't affect whether a note exists on
    // the highway. We resolve a sample for the tick when one is available;
    // otherwise the hit just registers silently.
    const tickGroups = new Map<number, { frets: Set<number>; open: boolean }>()
    for (const n of chart.notes) {
      if (n.lane > 4 && n.lane !== 7) continue   // skip mod-lanes 5/6
      const g = tickGroups.get(n.tick) ?? { frets: new Set<number>(), open: false }
      if (n.lane === 7) g.open = true
      else g.frets.add(n.lane)
      tickGroups.set(n.tick, g)
    }
    const out: typeof liveEntriesRef.current = []
    for (const [tick, g] of tickGroups) {
      const resolved = _resolveRealNote(tick)
      out.push({
        sec: tickToSec(tempoSegments, chart.resolution, tick),
        pack: resolved?.pack ?? '',
        scale: resolved?.scale ?? '',
        sampleName: resolved?.sampleName ?? '',
        frets: g.open ? null : g.frets,
      })
    }
    out.sort((a, b) => a.sec - b.sec)
    liveEntriesRef.current = out
  }, [chart, tempoSegments, _resolveRealNote])

  // Reset the per-pass hit set on seek / pause so notes can be re-attempted.
  useEffect(() => {
    if (!playing) {
      liveHitTicksRef.current = new Set()
    }
  }, [playing])

  // Install the strum handler — fired by the gamepad poll loop on every
  // strum-button press. Uses the asymmetric Unity hit window (200ms early
  // / 150ms late) and classifies each hit into one of 5 tolerance tiers.
  // Scoring rolls in via pointsPerPerfectHit × the tier's multiplier.
  useEffect(() => {
    if (!playing || playMode !== 'live') {
      onStrumRef.current = null
      return
    }
    onStrumRef.current = () => {
      const t = currentTimeRef.current
      const entries = liveEntriesRef.current
      const held = heldFretsRef.current
      let best: typeof entries[number] | null = null
      let bestDist = HIT_EARLY_OK_SEC + 0.001
      // Track whether ANY note was in the timing window — even if its fret
      // combo didn't match — so we can distinguish "no notes around" from
      // "wrong fingers" feedback.
      let anyInWindow = false
      for (const e of entries) {
        const key = Math.round(e.sec * 1000)
        if (liveHitTicksRef.current.has(key)) continue
        const delta = e.sec - t
        if (delta > HIT_EARLY_OK_SEC) break
        if (delta < -HIT_LATE_OK_SEC) continue
        anyInWindow = true
        const matches = e.frets === null
          ? held.size === 0
          : e.frets.size === held.size && [...e.frets].every((l) => held.has(l))
        if (!matches) continue
        const dist = Math.abs(delta)
        if (dist < bestDist) { best = e; bestDist = dist }
      }
      lastTierAtMsRef.current = performance.now()
      if (!best) {
        // No matching hit — surface why for the user. Strum still doesn't
        // break the streak (only a passively-missed note does).
        setLastTier(anyInWindow ? 'frets' : 'empty')
        return
      }
      {
        const key = Math.round(best.sec * 1000)
        liveHitTicksRef.current.add(key)
        liveMissedTicksRef.current.delete(key)  // a hit can't also be a miss
        const delta = best.sec - t
        const abs = Math.abs(delta)
        let tier: Tier
        if (abs <= HIT_PERFECT_SEC) tier = 'perfect'
        else if (abs <= HIT_GOOD_SEC) tier = delta >= 0 ? 'early' : 'late'
        else tier = delta >= 0 ? 'veryEarly' : 'veryLate'

        // Award points — non-realtime path so React state batches per tick.
        // Sample only fires when this tick is a real-note (R type) and
        // playback is enabled; regular gems hit silently with score only.
        if (realNotesEnabled && realNotesReady && best.sampleName && best.pack && best.scale) {
          fireSampleNow(best.pack, best.scale, best.sampleName)
        }
        const earned = Math.round(pointsPerPerfectHit * scoringSettings.multipliers[tier])
        setScore((s) => s + earned)
        setStreak((s) => {
          const next = s + 1
          setMaxStreak((m) => Math.max(m, next))
          return next
        })
        setLastTier(tier)
        lastTierAtMsRef.current = performance.now()

        const lanesToBoom = best.frets === null ? [0, 1, 2, 3, 4] : [...best.frets]
        for (const lane of lanesToBoom) gemMeshLayerRef.current?.spawnExplosion(lane)
      }
    }
    return () => { onStrumRef.current = null }
  }, [playing, playMode, realNotesEnabled, realNotesReady, fireSampleNow, pointsPerPerfectHit, scoringSettings])

  // Miss detection — scans for entries whose late-okay window has passed
  // without being hit and breaks the streak. Runs on currentTime change
  // (driven by the audio element's timeupdate / our rAF mirror) so it
  // catches missed notes shortly after they slide past the strike line.
  useEffect(() => {
    if (!playing || playMode !== 'live') return
    const t = currentTimeRef.current
    const cutoff = t - HIT_LATE_OK_SEC
    let brokeAny = false
    for (const e of liveEntriesRef.current) {
      if (e.sec > cutoff) break       // sorted — remaining are still hittable
      const key = Math.round(e.sec * 1000)
      if (liveHitTicksRef.current.has(key)) continue
      if (liveMissedTicksRef.current.has(key)) continue
      liveMissedTicksRef.current.add(key)
      brokeAny = true
    }
    if (brokeAny) {
      setStreak(0)
      setLastTier('miss')
      lastTierAtMsRef.current = performance.now()
    }
  }, [currentTime, playing, playMode])

  // currentTime mirrored in a ref so the strum handler (re-installed only when
  // play state flips) always sees the live playhead position.
  const currentTimeRef = useRef(currentTime)
  useEffect(() => { currentTimeRef.current = currentTime }, [currentTime])

  // Pre-warm the AudioContext on the first user gesture inside the editor.
  // Browsers boot AudioContexts in the 'suspended' state until they see a
  // user gesture, and resume() takes some ms the first time it's called.
  // Warming on first click means the first strum doesn't pay that cost.
  useEffect(() => {
    const warm = () => {
      const ctx = realNotesCtxRef.current
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => undefined)
    }
    window.addEventListener('click', warm)
    window.addEventListener('keydown', warm)
    return () => {
      window.removeEventListener('click', warm)
      window.removeEventListener('keydown', warm)
    }
  }, [])

  // Resolve the slot name a real-note SHOULD play given a held-frets set —
  // mirrors _resolveRealNote but driven by the player's input rather than
  // the chart. Used for free-play preview.
  const resolveSlotForHeldFrets = useCallback((held: Set<number>): string | null => {
    if (held.size === 0) return 'open'
    if (held.size === 1) return `lane_${[...held][0] + 1}`
    if (held.size === 2) {
      const sorted = [...held].sort((a, b) => a - b)
      if (sorted[1] - sorted[0] === 1) return `chord_${sorted[0] + 1}${sorted[1] + 1}`
      return `lane_${sorted[0] + 1}`  // non-adjacent → fall back to lower fret's solo sample
    }
    // 3+ frets — no canonical chord sample, fall back to the lowest fret
    return `lane_${Math.min(...held) + 1}`
  }, [])

  // Free-play preview: when the song isn't playing and the user has the
  // "Preview with guitar" toggle on, strums fire the matching sample from the
  // currently-selected pack/scale so the user can audition the patches.
  const [guitarPreview, setGuitarPreview] = useState(false)
  useEffect(() => {
    // Only wire when not playing — once playback starts, the live-mode strum
    // handler (installed elsewhere) takes precedence.
    if (playing || !guitarPreview || !realNotesReady) return
    if (!pickedPackId || !pickedScaleId) return
    onStrumRef.current = () => {
      const slotName = resolveSlotForHeldFrets(heldFretsRef.current)
      if (slotName) fireSampleNow(pickedPackId, pickedScaleId, slotName)
    }
    return () => { onStrumRef.current = null }
  }, [playing, guitarPreview, realNotesReady, pickedPackId, pickedScaleId, fireSampleNow, resolveSlotForHeldFrets])

  // Decode song.ogg → peaks for waveform overlay. Bucket size of 20ms gives
  // ~50 peaks/second, enough resolution to read transients on the runway
  // while keeping the array small (a 4-minute song needs ~12k floats).
  const WAVE_BUCKET_MS = 20
  useEffect(() => {
    if (!audioSrc) return
    const ctrl = new AbortController()
    let ctx: AudioContext | null = null
    fetch(audioSrc, { signal: ctrl.signal })
      .then((r) => r.arrayBuffer())
      .then(async (buf) => {
        ctx = new (window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!)()
        const audio = await ctx.decodeAudioData(buf)
        const sampleRate = audio.sampleRate
        const bucketSamples = Math.max(1, Math.floor((WAVE_BUCKET_MS / 1000) * sampleRate))
        const numBuckets = Math.ceil(audio.length / bucketSamples)
        const peaks = new Float32Array(numBuckets)
        const channelData = audio.getChannelData(0)
        for (let b = 0; b < numBuckets; b++) {
          const start = b * bucketSamples
          const end = Math.min(start + bucketSamples, channelData.length)
          let max = 0
          for (let i = start; i < end; i++) {
            const v = Math.abs(channelData[i])
            if (v > max) max = v
          }
          peaks[b] = max
        }
        // Normalize so the loudest peak fills the column — same trick the
        // stem player uses for quiet stems.
        let scaleMax = 0
        for (let i = 0; i < peaks.length; i++) if (peaks[i] > scaleMax) scaleMax = peaks[i]
        if (scaleMax > 0.01) {
          for (let i = 0; i < peaks.length; i++) peaks[i] = Math.min(1, peaks[i] / scaleMax)
        }
        wavePeaksRef.current = peaks
        setWaveLoaded(true)
      })
      .catch((e) => {
        if ((e as Error).name !== 'AbortError') console.error('waveform decode failed', e)
      })
      .finally(() => {
        try { ctx?.close() } catch { /* already closed */ }
      })
    return () => ctrl.abort()
  }, [audioSrc])

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
    // Left gutter holds the beat / bar / time ruler labels so they don't
    // collide with gems in lane 0 (Green).
    const GUTTER_W = 64
    // Sidecar carries VO1, VO2, EV1, EV2 to the right of the gem lanes. We
    // give the gem lanes ~64% of the canvas width minus the gutter so a
    // 5-lane chord still sits comfortably; the four sidecar lanes share
    // the remaining ~36%.
    const NUM_SIDECARS = 4
    const SIDECAR_FRAC = 0.36
    const SIDECAR_W_TOTAL = W * SIDECAR_FRAC
    const SIDECAR_W = SIDECAR_W_TOTAL / NUM_SIDECARS
    const GEM_X0 = GUTTER_W
    const GEM_W = W - SIDECAR_W_TOTAL - GUTTER_W
    const GEM_X1 = GEM_X0 + GEM_W
    const LANE_W = GEM_W / NUM_LANES
    const NOTE_R = Math.min(LANE_W * 0.32, 60)
    const SIDECAR_X0 = GEM_X1
    const SIDECAR_LABELS = ['VO1', 'VO2', 'EV1', 'EV2']

    ctx.fillStyle = '#0a0a0c'
    ctx.fillRect(0, 0, W, H)

    // Gutter background — very slightly different so the ruler reads as
    // its own strip without competing with the gem area.
    ctx.fillStyle = '#08090c'
    ctx.fillRect(0, 0, GUTTER_W, H)
    // Right divider for the gutter
    ctx.strokeStyle = '#1f2937'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(GEM_X0, 0)
    ctx.lineTo(GEM_X0, H)
    ctx.stroke()

    // Sidecar background (slightly darker so it reads as a separate column)
    ctx.fillStyle = '#06070a'
    ctx.fillRect(SIDECAR_X0, 0, SIDECAR_W_TOTAL, H)

    // Lane separators (gem lanes — start at the gutter)
    ctx.strokeStyle = '#1f2937'
    ctx.lineWidth = 1
    for (let i = 1; i < NUM_LANES; i++) {
      const x = GEM_X0 + i * LANE_W
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

    const t2s = (tick: number) => tickToSec(tempoSegments, chart.resolution, tick)
    const s2t = (sec: number) => secToTick(tempoSegments, chart.resolution, sec)
    const beatStep = chart.resolution
    const snapTicks = Math.max(1, Math.round(chart.resolution / snapDivisor))

    // Compute visible tick range (a bit beyond top/bottom so lines crossing edges still draw)
    const topSec = currentTime + (HIT + 200) / scrollSpeed
    const bottomSec = currentTime - (H - HIT + 200) / scrollSpeed
    const startTick = s2t(Math.max(0, bottomSec))
    const endTick = s2t(Math.max(0, topSec))
    const startBeat = Math.floor(startTick / beatStep) * beatStep

    // Snap subdivision lines (faint) — span gem area + sidecar; gutter is
    // reserved for labels.
    if (snapDivisor > 1) {
      ctx.strokeStyle = '#0f172a'
      ctx.lineWidth = 1
      for (let t = startBeat; t <= endTick; t += snapTicks) {
        if (t % beatStep === 0) continue
        const y = HIT - (t2s(t) - currentTime) * scrollSpeed
        if (y < -10 || y > H + 10) continue
        ctx.beginPath()
        ctx.moveTo(GEM_X0, y)
        ctx.lineTo(W, y)
        ctx.stroke()
      }
    }
    // Beat lines (stronger) + ruler labels. Bars are emphasised (brighter
    // stroke + timestamp label); every beat gets a small "bar.beat" mark
    // on the left edge. Tick number is shown next to bars to help when
    // discussing chart positions in absolute terms.
    //
    // Assumes 4/4 — that's the only time signature the editor surfaces
    // today; when chart.timeSigs is exposed in the future, swap `4` here
    // for the active TS numerator at this tick.
    const BEATS_PER_BAR = 4
    // Skip labels that would collide vertically — happens at high BPM or
    // very low scroll-speed. 14 px is roughly the rendered text height.
    const beatYStride = beatStep * (1 / chart.resolution) * (60 / Math.max(1, chart.bpm)) * scrollSpeed
    const labelEveryBeat = beatYStride >= 14
    const labelEveryBar = beatYStride * BEATS_PER_BAR >= 18

    ctx.textAlign = 'left'
    for (let t = startBeat; t <= endTick; t += beatStep) {
      const y = HIT - (t2s(t) - currentTime) * scrollSpeed
      if (y < -16 || y > H + 16) continue
      const beatIdx = Math.round(t / beatStep)
      const isBar = beatIdx % BEATS_PER_BAR === 0
      // Beat lines span the playable area only (gem + sidecar).
      ctx.strokeStyle = isBar ? '#374151' : '#1f2937'
      ctx.lineWidth = isBar ? 1.5 : 1
      ctx.beginPath()
      ctx.moveTo(GEM_X0, y)
      ctx.lineTo(W, y)
      ctx.stroke()
      // Ruler labels live in the gutter, well clear of any lane gem.
      if (isBar) {
        const bar = Math.floor(beatIdx / BEATS_PER_BAR) + 1
        ctx.font = 'bold 10px monospace'
        ctx.fillStyle = '#9ca3af'
        ctx.fillText(`${bar}`, 4, y - 2)
        if (labelEveryBar) {
          const sec = t2s(t)
          const m = Math.floor(sec / 60)
          const ss = Math.floor(sec % 60)
          const cs = Math.floor((sec % 1) * 100)
          const timeStr = `${m}:${ss.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`
          ctx.font = '9px monospace'
          ctx.fillStyle = '#6b7280'
          ctx.fillText(timeStr, 18, y - 2)
        }
      } else if (labelEveryBeat) {
        const bar = Math.floor(beatIdx / BEATS_PER_BAR) + 1
        const beatInBar = (beatIdx % BEATS_PER_BAR) + 1
        ctx.font = '9px monospace'
        ctx.fillStyle = '#4b5563'
        ctx.fillText(`${bar}.${beatInBar}`, 4, y - 2)
      }
    }

    // Hit line + lane circles. Hit line spans gem area + sidecar (skips
    // the gutter so the ruler stays clean).
    ctx.strokeStyle = '#374151'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(GEM_X0, HIT)
    ctx.lineTo(W, HIT)
    ctx.stroke()
    for (let lane = 0; lane < NUM_LANES; lane++) {
      const x = GEM_X0 + (lane + 0.5) * LANE_W
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
      id: string
      kind: 'tutorial' | 'scene'
    }

    // Local ticks/sec at the current playhead — only used for visual minimums
    // and music-segment width estimates, so an approximation against the
    // active tempo is fine. (Note positions still use the full piecewise map
    // via t2s/s2t above.)
    const localMicroBpm = (() => {
      let i = tempoSegments.length - 1
      while (i > 0 && tempoSegments[i].seconds > currentTime) i--
      return tempoSegments[i].microBpm
    })()
    const ticksPerSec = (localMicroBpm * chart.resolution) / 60000
    const tickFromSec = (sec: number) => Math.max(0, sec * ticksPerSec)
    // Minimum visual height for instantaneous events: ~8 px worth of ticks.
    const MIN_TICK_DUR = Math.max(1, Math.round((8 / scrollSpeed) * ticksPerSec))

    const voPills: Pill[] = []
    const evPills: Pill[] = []

    // STEP blocks span from this STEP's tick to the next STEP's tick — that's
    // the window the player has to meet the `required` count. Sorted once so
    // each STEP can binary-walk it without re-scanning.
    const stepTicks: number[] = []
    if (chart.tutorialEnabled) {
      for (const ev of chart.tutorial) {
        if (ev.kind === 'step') stepTicks.push(ev.tick)
      }
      stepTicks.sort((a, b) => a - b)
    }

    if (chart.tutorialEnabled) {
      for (const ev of chart.tutorial) {
        if (ev.kind === 'vo') {
          // Duration on the highway = the clip's actual length so the pill
          // visually covers the audio window. Fall back to MIN_TICK_DUR for
          // VOs without an embedded durationMs (legacy, or pre-collation).
          const voDurTicks = (ev.durationMs && ev.durationMs > 0)
            ? Math.max(MIN_TICK_DUR, Math.round(tickFromSec(ev.durationMs / 1000)))
            : MIN_TICK_DUR
          voPills.push({
            tickStart: ev.tick,
            tickEnd: ev.tick + voDurTicks,
            label: ev.text ? `▶ ${ev.text.slice(0, 60)}` : '▶ VO',
            fill: 'rgba(56, 189, 248, 0.22)',
            border: 'rgba(56, 189, 248, 0.7)',
            text: '#7dd3fc',
            id: ev.id,
            kind: 'tutorial',
          })
        } else if (ev.kind === 'step') {
          // Step span = until the next STEP. Last step gets a minimum-height
          // pill since "until end of song" would dominate the runway.
          const nextStep = stepTicks.find((t) => t > ev.tick)
          const stepDurTicks = nextStep !== undefined
            ? Math.max(MIN_TICK_DUR, nextStep - ev.tick)
            : MIN_TICK_DUR
          evPills.push({
            tickStart: ev.tick,
            tickEnd: ev.tick + stepDurTicks,
            label: `▌STEP ${ev.stepId || '?'}\n${ev.required || 0} ${ev.timing}`,
            fill: 'rgba(168, 85, 247, 0.22)',
            border: 'rgba(168, 85, 247, 0.7)',
            text: '#c4b5fd',
            id: ev.id,
            kind: 'tutorial',
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
            id: ev.id,
            kind: 'tutorial',
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
        id: ev.id,
        kind: 'scene',
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

    // Reset hit-test regions; drawPills repopulates them as it goes.
    pillRegionsRef.current = []

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
        const isSelected = (p.kind === 'tutorial' && p.id === selectedTutorialId)
          || (p.kind === 'scene' && p.id === sceneSelectedId)
        ctx.strokeStyle = isSelected ? '#ffffff' : p.border
        ctx.lineWidth = isSelected ? 2 : 1
        ctx.strokeRect(x + 0.5, yTop + 0.5, w - 1, h - 1)
        ctx.fillStyle = p.text
        // Label fits inside the pill, top-anchored. Truncate per line.
        const lines = p.label.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const ly = yTop + 11 + i * 11
          if (ly > yBottom - 2) break
          ctx.fillText(lines[i].slice(0, Math.max(2, Math.floor(w / 5))), x + 3, ly)
        }
        pillRegionsRef.current.push({ x, y: yTop, w, h, id: p.id, kind: p.kind })
      }
    }

    drawPills(assignLanes(voPills), 0)  // VO1, VO2
    drawPills(assignLanes(evPills), 2)  // EV1, EV2

    // Section markers: a horizontal rule across the gem area at each section
    // tick, with the name floating just above. Drawn before the waveform so
    // markers don't dominate visually.
    if (chart.sections.length > 0) {
      ctx.font = 'bold 11px sans-serif'
      ctx.textAlign = 'left'
      for (const sec of chart.sections) {
        const y = HIT - (t2s(sec.tick) - currentTime) * scrollSpeed
        if (y < -20 || y > H + 20) continue
        ctx.strokeStyle = 'rgba(244, 114, 182, 0.55)'  // pink-400 line
        ctx.lineWidth = 1
        ctx.setLineDash([4, 3])
        ctx.beginPath()
        ctx.moveTo(GEM_X0, y)
        ctx.lineTo(GEM_X1, y)
        ctx.stroke()
        ctx.setLineDash([])
        // Label background — sits at the top of the gem area.
        const labelW = ctx.measureText(sec.name).width + 8
        ctx.fillStyle = 'rgba(190, 24, 93, 0.85)'  // pink-700
        ctx.fillRect(GEM_X0 + 2, y - 14, labelW, 13)
        ctx.fillStyle = '#ffffff'
        ctx.fillText(sec.name, GEM_X0 + 6, y - 4)
      }
    }

    // Waveform: thin column down the LEFT edge of the gem area. Time runs
    // vertically with currentTime at HIT (the strike line); each bucket draws
    // a horizontal bar whose width is the normalized peak amplitude. Drawn
    // before notes so gems land on top. When the highway-overlay toggle is
    // on, render a second visualisation that spans the FULL gem width as a
    // mirrored bar around a centre spine — gems sit on top so charters can
    // line up note onsets with audio transients.
    const peaks = wavePeaksRef.current
    if (peaks && peaks.length > 0) {
      const bucketSec = WAVE_BUCKET_MS / 1000
      const tAtY = (y: number) => currentTime + (HIT - y) / scrollSpeed
      const topT = tAtY(0)
      const botT = tAtY(H)
      const startBucket = Math.max(0, Math.floor(Math.min(topT, botT) / bucketSec))
      const endBucket = Math.min(peaks.length - 1, Math.ceil(Math.max(topT, botT) / bucketSec))

      // Perceptual curve: raw PCM peaks compress everything quiet into a
      // razor-thin sliver at the bottom of the dynamic range. A √amp pre-curve
      // (≈ +6dB visual gain on quiet content) makes verses, fingerpicking, and
      // intros legible without blowing out loud sections. Skip rendering for
      // values under a small floor so silence stays silent — better than the
      // 1-px-wide "dot" minimum that drew even at 0.001 amplitude.
      const ampCurve = (a: number) => (a <= 0 ? 0 : Math.sqrt(a))
      const AMP_FLOOR = 0.02
      if (waveformOnHighway) {
        // Mirrored bar centred at the gem-area midline. Each bucket emits a
        // single 2px-tall horizontal line whose half-width tracks amplitude,
        // tinted cyan with low alpha so gems remain dominant.
        const centerX = GEM_X0 + GEM_W / 2
        const halfMax = GEM_W * 0.46  // leaves a little margin so loud peaks don't kiss the sidecar
        ctx.fillStyle = 'rgba(34, 211, 238, 0.28)'
        for (let b = startBucket; b <= endBucket; b++) {
          const a = ampCurve(peaks[b])
          if (a < AMP_FLOOR) continue
          const t = b * bucketSec
          const y = HIT - (t - currentTime) * scrollSpeed
          const halfW = a * halfMax
          ctx.fillRect(centerX - halfW, y - 1, halfW * 2, 2)
        }
        // Faint vertical centre line so the spine reads even during silence.
        ctx.fillStyle = 'rgba(34, 211, 238, 0.08)'
        ctx.fillRect(centerX - 0.5, 0, 1, H)
      } else {
        // Default: thin amplitude ribbon down the left edge of the gems.
        const COLUMN_W = 14
        ctx.fillStyle = 'rgba(34, 211, 238, 0.55)'
        for (let b = startBucket; b <= endBucket; b++) {
          const a = ampCurve(peaks[b])
          if (a < AMP_FLOOR) continue
          const t = b * bucketSec
          const y = HIT - (t - currentTime) * scrollSpeed
          const w = a * COLUMN_W
          ctx.fillRect(GEM_X0, y - 1, w, 2)
        }
        ctx.fillStyle = 'rgba(34, 211, 238, 0.12)'
        ctx.fillRect(GEM_X0, 0, 1, H)
      }
    }

    // Index modifiers by tick so each rendered note can pick up its HOPO/tap
    // companion (lane 5 / 6) without an O(n²) inner loop. Real-note status
    // is now intrinsic (n.type === 'real') so it goes into the same map for
    // a single-pass lookup. Open notes (lane 7) render as a runway-wide bar.
    const modByTick = new Map<number, { hopo: boolean; tap: boolean; real: boolean }>()
    const openIdsByTick = new Map<number, number[]>()
    for (let i = 0; i < chart.notes.length; i++) {
      const n = chart.notes[i]
      if (n.lane === 5 || n.lane === 6) {
        const cur = modByTick.get(n.tick) || { hopo: false, tap: false, real: false }
        if (n.lane === 5) cur.hopo = true
        else cur.tap = true
        modByTick.set(n.tick, cur)
      } else if (n.lane === 7) {
        const arr = openIdsByTick.get(n.tick) || []
        arr.push(i)
        openIdsByTick.set(n.tick, arr)
      }
      if (n.type === 'real') {
        const cur = modByTick.get(n.tick) || { hopo: false, tap: false, real: false }
        cur.real = true
        modByTick.set(n.tick, cur)
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
        ctx.fillRect(GEM_X0, y - tailLen, GEM_W, tailLen)
      }
      ctx.fillStyle = '#a855f7'
      ctx.fillRect(GEM_X0, y - barH / 2, GEM_W, barH)
      ctx.lineWidth = isSelected ? 3 : 1.5
      ctx.strokeStyle = isSelected ? '#ffffff' : '#3b0764'
      ctx.strokeRect(GEM_X0 + 0.5, y - barH / 2 + 0.5, GEM_W - 1, barH - 1)
      // Real-note indicator on opens: a cyan stripe near the right edge.
      const openMods = modByTick.get(tick)
      if (openMods?.real) {
        ctx.fillStyle = '#22d3ee'
        ctx.fillRect(GEM_X1 - 8, y - barH / 2 + 2, 4, barH - 4)
      }
      // Label
      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 10px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('OPEN', GEM_X0 + GEM_W / 2, y + 3)
    })

    // Slide ribbons sit beneath the gems.
    const selectedSlideIds = new Set<number>()
    for (const i of selectedIds) {
      const s = chart.notes[i]?.slideId
      if (s != null) selectedSlideIds.add(s)
    }
    drawSlideRibbons(ctx, chart.notes, {
      laneFill: LANE_FILL,
      gemX0: GEM_X0,
      laneW: LANE_W,
      hit: HIT,
      scrollSpeed,
      currentTime,
      t2s,
      selectedSlideIds,
    })

    // Single-lane notes
    for (let i = 0; i < chart.notes.length; i++) {
      const n = chart.notes[i]
      if (n.lane > 4) continue
      const noteSec = t2s(n.tick)
      const dy = (noteSec - currentTime) * scrollSpeed
      const y = HIT - dy
      if (y < -200 || y > H + 200) continue
      const x = GEM_X0 + (n.lane + 0.5) * LANE_W

      if (n.sustain > 0) {
        const sustainSec = t2s(n.sustain)
        const tailLen = sustainSec * scrollSpeed
        ctx.fillStyle = LANE_FILL[n.lane] + '88'
        ctx.fillRect(x - LANE_W * 0.1, y - tailLen, LANE_W * 0.2, tailLen)
      }

      const isSelected = selectedIds.has(i)
      const mods = modByTick.get(n.tick)
      // 3D mesh layer is rendering this gem on top — skip the 2D circle so the
      // mesh isn't competing with a flat disc behind it. Sustain tail above
      // still draws (it's a thin line, mesh covers the head).
      const meshActive = view3d.enabled && !!view3d.meshName
      if (!meshActive) {
        ctx.beginPath()
        ctx.arc(x, y, NOTE_R, 0, Math.PI * 2)
        ctx.fillStyle = LANE_FILL[n.lane]
        ctx.fill()
        ctx.lineWidth = isSelected ? 4 : 2
        ctx.strokeStyle = isSelected ? '#ffffff'
          : mods?.tap ? '#22d3ee'   // cyan ring on tap notes
          : '#000000'
        ctx.stroke()
      } else if (isSelected) {
        // Selection ring still useful in mesh mode — drawn larger so it haloes the gem.
        ctx.beginPath()
        ctx.arc(x, y, NOTE_R + 4, 0, Math.PI * 2)
        ctx.lineWidth = 3
        ctx.strokeStyle = '#ffffff'
        ctx.stroke()
      }

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
      // Real-note indicator: small cyan dot inside the gem signalling the
      // game will play a pitched sample on hit.
      if (mods?.real) {
        ctx.fillStyle = '#22d3ee'
        ctx.beginPath()
        ctx.arc(x, y, Math.max(3, NOTE_R * 0.28), 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = '#0e7490'
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }

    // Lane labels at bottom — drum-type or colour name + colour swatch underneath
    ctx.textAlign = 'center'
    for (let lane = 0; lane < NUM_LANES; lane++) {
      const x = GEM_X0 + (lane + 0.5) * LANE_W
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
        const realTag = sel.type === 'real' ? ' · real-note' : ''
        ctx.fillText(
          `selected: ${laneName} · tick ${sel.tick} · sustain ${sel.sustain}${realTag}`,
          12,
          42,
        )
      }
    } else if (selectedIds.size > 1) {
      ctx.fillText(`${selectedIds.size} notes selected`, 12, 42)
    }
    if (tool === 'note') {
      ctx.fillStyle = '#a78bfa'
      ctx.fillText('Play note · click a lane to drop a gem · shift-click for OPEN', 12, 62)
    } else if (tool === 'real') {
      ctx.fillStyle = '#67e8f9'
      ctx.fillText('Real note · click drops a gem with the real-note flag (cyan dot)', 12, 62)
    }
  }, [chart, currentTime, scrollSpeed, selectedIds, snapDivisor, isDrums, laneLabels, tool, waveformOnHighway, view3d.enabled, view3d.meshName, selectedTutorialId, sceneSelectedId])

  // Resize canvas backing store on container size change
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas) {
      canvas.width = canvasSize.w
      canvas.height = canvasSize.h
    }
  }, [canvasSize])

  // Drive draw loop. Skipped entirely when 3D + mesh mode hides the 2D
  // canvas — there's no point rasterising thousands of pixels into a
  // `display:none` surface, and that wasted work shows up as jank on the
  // Three.js highway scroll.
  const skip2DDraw = view3d.enabled && !!view3d.meshName
  useEffect(() => {
    if (skip2DDraw) return
    let raf: number
    const loop = () => {
      draw()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [draw, skip2DDraw])

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
    // Same geometry as draw(): 64-px label gutter, 64% of W for the gem
    // area (minus that gutter), 36% of W for the sidecar.
    const GUTTER_W = 64
    const GEM_X0 = GUTTER_W
    const GEM_W = canvas.width - canvas.width * 0.36 - GUTTER_W
    const GEM_X1 = GEM_X0 + GEM_W
    if (cx < GEM_X0 || cx >= GEM_X1) return null  // Gutter or sidecar — no hit
    const LANE_W = GEM_W / 5
    const lane = Math.floor((cx - GEM_X0) / LANE_W)
    let bestId: number | null = null
    let bestDist = 36
    for (let i = 0; i < chart.notes.length; i++) {
      const n = chart.notes[i]
      const noteSec = tickToSec(tempoSegments, chart.resolution, n.tick)
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
    // 3D preview disables editing — the canvas is CSS-tilted so click coords
    // don't map to the underlying pixel grid. Wheel scrub still works.
    if (view3d.enabled) return
    const { cx, cy } = canvasToCoords(e)

    // Click in the left timestamp gutter: seek the playhead to the tick
    // represented by the cursor's vertical position. Same y→tick mapping as
    // note placement, so a click next to a ruler label parks the playhead
    // exactly on that beat. Drag is not armed here so a plain click doesn't
    // clear the current selection.
    {
      const canvas = canvasRef.current!
      const GUTTER_W = 64
      if (cx < GUTTER_W) {
        const HIT = canvas.height - 110
        const targetSec = currentTime + (HIT - cy) / Math.max(1, scrollSpeed)
        const clamped = duration > 0
          ? Math.max(0, Math.min(duration, targetSec))
          : Math.max(0, targetSec)
        if (audioRef.current) audioRef.current.currentTime = clamped
        setCurrentTime(clamped)
        return
      }
    }

    // Click on a sidecar pill (VO / STEP / MUSIC / scene): select the
    // corresponding event so its editor opens in the side panel.
    {
      const regions = pillRegionsRef.current
      // Search top-down so the most-recently-drawn pill wins on overlap.
      for (let i = regions.length - 1; i >= 0; i--) {
        const r = regions[i]
        if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) {
          if (r.kind === 'tutorial') {
            setSelectedTutorialId(r.id)
            setSceneSelectedId(null)
          } else {
            setSceneSelectedId(r.id)
            setSelectedTutorialId(null)
          }
          return
        }
      }
    }

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

    // Note / Real-note tools: click drops a gem at the cursor — lane is
    // inferred from the x-position (gem area is split into five equal
    // lanes) and tick from the y-position snapped to the current grid.
    // Shift+click drops an Open note (lane 7) instead — full-width strum.
    // The Real-note tool emits R-typed notes carrying the sidebar-picked
    // (pack, scale) so the game fires the matching pitched sample on hit.
    // Clicks outside the gem area (sidecar) are ignored.
    if (tool === 'note' || tool === 'real') {
      const canvas = canvasRef.current!
      const HIT = canvas.height - 110
      const GUTTER_W = 64
      const GEM_X0 = GUTTER_W
      const GEM_W = canvas.width - canvas.width * 0.36 - GUTTER_W
      const GEM_X1 = GEM_X0 + GEM_W
      if (cx < GEM_X0 || cx >= GEM_X1) return  // gutter or sidecar — ignore
      const LANE_W = GEM_W / 5
      const lane = e.shiftKey ? 7 : Math.max(0, Math.min(4, Math.floor((cx - GEM_X0) / LANE_W)))
      const targetSec = currentTime + (HIT - cy) / scrollSpeed
      const targetTickRaw = secToTick(tempoSegments, chart.resolution, Math.max(0, targetSec))
      const snapTicks = Math.max(1, Math.round(chart.resolution / snapDivisor))
      const newTick = Math.round(targetTickRaw / snapTicks) * snapTicks
      const newNote: ChartNote = tool === 'real' && pickedPackId && pickedScaleId
        ? { tick: newTick, lane, sustain: 0, type: 'real', pack: pickedPackId, scale: pickedScaleId }
        : { tick: newTick, lane, sustain: 0 }
      const placed = [...chart.notes, newNote]
      const next = placed.sort((a, b) => a.tick - b.tick || a.lane - b.lane)
      const newIdx = next.findIndex((n) => n === newNote)
      commitNotes(next)
      setSelectedIds(new Set([newIdx]))
      // Stay engaged for a sustain-drag: if the user holds the mouse and drags
      // up before releasing, we extend the just-placed note's sustain live.
      placeRef.current = { idx: newIdx, noteTick: newTick, startCy: cy }
      return
    }

    // Empty click in the Select tool: arm a scrub-or-clear. The handler
    // resolves the gesture on mouseup — drag-of-significant-distance =
    // scrub (currentTime drifted by then), no-drag = treat as click and
    // clear the selection.
    scrubRef.current = { startCy: cy, startCurrentTime: currentTime, moved: false }
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!chart) return
    if (view3d.enabled) return
    const canvas = canvasRef.current!
    const { cx, cy } = canvasToCoords(e)

    // Cursor affordance: the ruler gutter is a click-to-seek target.
    if (!dragRef.current && !placeRef.current && !scrubRef.current) {
      canvas.style.cursor = cx < 64 ? 'ns-resize' : 'crosshair'
    }

    // Empty-area drag = scrub the playhead. Map y-delta (in canvas pixels)
    // through scrollSpeed back to a seconds-delta so 1 px of drag matches
    // 1 px of runway scroll. Dragging DOWN advances time (the runway
    // visually flows down toward the strike line as time progresses;
    // pulling the chart down is "look further ahead").
    if (scrubRef.current) {
      const s = scrubRef.current
      const dy = cy - s.startCy  // positive when dragging down
      if (!s.moved && Math.abs(dy) < 4) {
        // Below threshold — treat as still-a-click; don't shift time yet.
        return
      }
      s.moved = true
      const rect = canvas.getBoundingClientRect()
      // Convert canvas-space dy back to CSS-pixel velocity so the drag
      // tracks the cursor 1:1 regardless of canvas backing-store scale.
      const cssDy = dy * (rect.height / Math.max(1, canvas.height))
      const next = s.startCurrentTime + cssDy / Math.max(1, scrollSpeed)
      const clamped = duration > 0
        ? Math.max(0, Math.min(duration, next))
        : Math.max(0, next)
      if (Math.abs(clamped - currentTime) > 0.001) {
        if (audioRef.current) audioRef.current.currentTime = clamped
        setCurrentTime(clamped)
      }
      return
    }

    // Sustain-drag during note placement: convert the upward drag distance
    // from startCy to a snapped tick count and apply it to the just-placed
    // note's sustain. Quick clicks (dy small) leave sustain at 0.
    if (placeRef.current) {
      const p = placeRef.current
      const dyUp = p.startCy - cy   // positive when dragging up
      if (dyUp < 4) {
        // Below threshold — keep sustain at 0 (allow undo of accidental tiny drift)
        if (chart.notes[p.idx]?.sustain !== 0) {
          const next = chart.notes.slice()
          next[p.idx] = { ...next[p.idx], sustain: 0 }
          setChart({ ...chart, notes: next })
          setDirty(true)
        }
        return
      }
      const sustainSec = dyUp / scrollSpeed
      const targetEndSec = tickToSec(tempoSegments, chart.resolution, p.noteTick) + sustainSec
      const targetEndTick = secToTick(tempoSegments, chart.resolution, targetEndSec)
      const snapTicks = Math.max(1, Math.round(chart.resolution / snapDivisor))
      const snappedEnd = Math.round(targetEndTick / snapTicks) * snapTicks
      const sustainTicks = Math.max(0, snappedEnd - p.noteTick)
      const cur = chart.notes[p.idx]
      if (!cur || cur.sustain === sustainTicks) return
      const next = chart.notes.slice()
      next[p.idx] = { ...cur, sustain: sustainTicks }
      setChart({ ...chart, notes: next })
      setDirty(true)
      return
    }

    if (!dragRef.current) return
    const dx = cx - dragRef.current.startX
    const dy = cy - dragRef.current.startY
    if (!dragRef.current.moved && Math.hypot(dx, dy) < 4) return
    dragRef.current.moved = true

    const HIT = canvas.height - 110
    const GUTTER_W = 64
    const GEM_X0 = GUTTER_W
    const GEM_W = canvas.width - canvas.width * 0.36 - GUTTER_W
    const LANE_W = GEM_W / 5
    const anchor = dragRef.current.snapshot.get(dragRef.current.anchorId)
    if (!anchor) return

    const newAnchorLane = Math.max(0, Math.min(4, Math.floor((cx - GEM_X0) / LANE_W)))
    const targetSec = currentTime + (HIT - cy) / scrollSpeed
    const targetTickRaw = secToTick(tempoSegments, chart.resolution, Math.max(0, targetSec))
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

  // Mouse-wheel over the runway scrolls the playhead. The runway has time
  // flowing up (future is above the strike line) so natural-scroll
  // semantics map a wheel-down (positive deltaY) to "going back in time"
  // and wheel-up to "advancing forward" — matching how documents scroll.
  // Shift-wheel scrolls 4× faster for fast traversal.
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!chart) return
    const sensitivity = e.shiftKey ? 4 : 1
    const next = currentTime - (e.deltaY / Math.max(1, scrollSpeed)) * sensitivity
    const clamped = duration > 0
      ? Math.max(0, Math.min(duration, next))
      : Math.max(0, next)
    if (Math.abs(clamped - currentTime) < 0.001) return
    if (audioRef.current) audioRef.current.currentTime = clamped
    setCurrentTime(clamped)
  }

  const handleMouseUp = () => {
    if (dragRef.current?.moved) {
      // Validate the final drag position. If it violates the chart rules,
      // revert every dragged note to its pre-drag snapshot and flash an
      // error — otherwise push a history entry so undo returns the whole
      // drag to where it started.
      setChart((prev) => {
        if (!prev || !dragRef.current) return prev
        const err = checkNoteRules(prev.notes, prev.resolution)
        if (err) {
          const reverted = prev.notes.slice()
          dragRef.current.snapshot.forEach((orig, idx) => {
            const cur = reverted[idx]
            if (cur) reverted[idx] = { ...cur, tick: orig.tick, lane: orig.lane }
          })
          flashRuleError(err)
          return { ...prev, notes: reverted }
        }
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
    // The just-placed note is committed to chart.notes; any sustain extension
    // during this drag is folded into the original placement's history entry.
    // (commitNotes already pushed the pre-placement state onto the stack on
    // mousedown — one undo reverts the whole hold-note authoring stroke.)
    placeRef.current = null
    // Scrub gesture cleanup. A scrub that never moved past the 4-px
    // threshold counts as a plain click on empty space → clear selection.
    if (scrubRef.current) {
      const s = scrubRef.current
      if (!s.moved) setSelectedIds(new Set())
      scrubRef.current = null
    }
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
      if (e.key === '3' && !isCtrl) { setTool('real'); e.preventDefault(); return }

      if (e.code === 'Space') {
        e.preventDefault()
        const a = audioRef.current
        if (a) { if (a.paused) a.play(); else a.pause() }
        return
      }
      if (e.key === 'Home' && !isCtrl) {
        e.preventDefault()
        seekSeconds(0)
        return
      }
      if (e.key === 'End' && !isCtrl) {
        e.preventDefault()
        seekSeconds(duration || 0)
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
        const playheadTickRaw = secToTick(tempoSegments, chart.resolution, currentTime)
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

      // = quantizes every selected note's tick to the nearest snapDivisor
      // multiple. Single history entry so undo reverts the whole batch.
      // Modifiers (lane 5/6) and open notes ride along — they get snapped
      // too so they stay aligned with the gem notes they accompany.
      if (!isCtrl && (e.key === '=' || e.key === '+')) {
        if (selectedIds.size === 0) return
        e.preventDefault()
        const snapTicks = Math.max(1, Math.round(chart.resolution / snapDivisor))
        let anyChanged = false
        const next = chart.notes.slice()
        selectedIds.forEach((idx) => {
          const cur = next[idx]
          if (!cur) return
          const snapped = Math.max(0, Math.round(cur.tick / snapTicks) * snapTicks)
          if (snapped !== cur.tick) {
            next[idx] = { ...cur, tick: snapped }
            anyChanged = true
          }
        })
        if (anyChanged) commitNotes(next)
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
      // selection. The modifier (lane 5 / 6) lives at the same tick as the
      // affected gem note(s) — toggle = remove if present, add otherwise.
      //   F → lane 5 (force-HOPO)
      //   T → lane 6 (tap)
      // R toggles real-note status on every selected fret/open note in place
      // (flips n.type between 'real' and undefined). Newly-flagged notes
      // pick up the sidebar's current (pack, scale) selection.
      if (
        !isCtrl &&
        (e.key === 'f' || e.key === 'F' || e.key === 't' || e.key === 'T')
      ) {
        e.preventDefault()
        const modLane = (e.key === 'f' || e.key === 'F') ? 5 : 6
        const ticks = new Set<number>()
        selectedIds.forEach((idx) => {
          const n = chart.notes[idx]
          if (n && n.lane <= 4) ticks.add(n.tick)
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
      if (!isCtrl && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault()
        // Decide direction (toggle on/off) from whether ANY selected playable
        // note currently lacks the real flag — if so, turn them all on; else
        // strip them all. Mirrors how F/T toggles feel.
        let anyMissing = false
        selectedIds.forEach((idx) => {
          const n = chart.notes[idx]
          if (n && (n.lane <= 4 || n.lane === 7) && n.type !== 'real') anyMissing = true
        })
        const next = chart.notes.slice()
        let changed = false
        selectedIds.forEach((idx) => {
          const n = next[idx]
          if (!n || (n.lane > 4 && n.lane !== 7)) return
          if (anyMissing) {
            if (!pickedPackId || !pickedScaleId) return
            next[idx] = { ...n, type: 'real', pack: pickedPackId, scale: pickedScaleId }
          } else {
            const { type, pack, scale, ...rest } = n
            void type; void pack; void scale
            next[idx] = rest
          }
          changed = true
        })
        if (changed) commitNotes(next)
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
    newFull = applyTutorialToFullText(newFull, chart.tutorial, chart.tutorialEnabled, chart.musicSections, chart.importedSources, chart.clips)
    newFull = applySyncTrackToFullText(newFull, chart.tempoMarkers, chart.timeSigs, chart.syncOther)
    const passthroughWithSections = [...chart.sceneEventsPassthrough, ...sectionLines(chart.sections)]
    newFull = applySceneToFullText(
      newFull,
      chart.sceneFlags,
      chart.sceneFlagsUnknown,
      chart.sceneEvents,
      passthroughWithSections,
    )
    const newNotes = parseSectionNotes(newFull, name, chart.resolution)
    // Tutorial section is shared across difficulties — just keep current state.
    // Track the new section in availableSections so the dropdown reflects it as
    // "live" even before the first save creates the on-disk block.
    const nextAvailable = chart.availableSections.includes(name)
      ? chart.availableSections
      : [...chart.availableSections, name]
    setChart({ ...chart, fullText: newFull, activeName: name, notes: newNotes, availableSections: nextAvailable })
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
      newFull = applyTutorialToFullText(newFull, chart.tutorial, chart.tutorialEnabled, chart.musicSections, chart.importedSources, chart.clips)
      newFull = applySyncTrackToFullText(newFull, chart.tempoMarkers, chart.timeSigs, chart.syncOther)
      // Merge section markers back into passthrough so applySceneToFullText
      // re-emits them as standard `E "section ..."` rows in [Events].
      const passthroughWithSections = [...chart.sceneEventsPassthrough, ...sectionLines(chart.sections)]
      newFull = applySceneToFullText(
        newFull,
        chart.sceneFlags,
        chart.sceneFlagsUnknown,
        chart.sceneEvents,
        passthroughWithSections,
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

  // Dirty-aware exit guard. With the in-header Back button gone, the browser
  // back / tab close path needs its own warning so we don't silently drop
  // edits. beforeunload only fires for hard navigation (tab close, refresh) —
  // for in-app navigation we still warn via the React Router blocker further
  // down if/when it gets wired up.
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''  // legacy Chrome path
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

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

  const playheadTick = useMemo(() => {
    if (!chart) return 0
    const snap = Math.max(1, Math.round(chart.resolution / snapDivisor))
    const raw = secToTick(tempoSegments, chart.resolution, currentTime)
    return Math.max(0, Math.round(raw / snap) * snap)
  }, [chart, currentTime, snapDivisor, tempoSegments])

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
    setSelectedTutorialId(ev.id)
  }

  // Tutorial events render as a single editor panel — pick one from the
  // dropdown to edit it. Null means "nothing selected"; we auto-pick the
  // first event after add/delete so the panel doesn't go blank. Declared
  // up-top via lift so the canvas draw closure (above) can read them for
  // pill highlighting + click-to-select.

  // ── VO library — one modal with three paths:
  //   (a) Paste an ElevenLabs Studio URL; backend pulls the chapter's latest
  //       rendered audio + script.
  //   (b) Multi-file upload to the shared library. Each upload is tagged with
  //       a batch label (e.g. "Guitar Lesson 1 elevenlabs Ryan") so files can
  //       be browsed and re-used across tutorials. Filenames carry the
  //       narration script (the uploader names files by line); the derived
  //       text auto-fills the VO event when inserted.
  //   (c) Browse the library, preview clips, and insert one at the playhead.
  const [studioImportOpen, setStudioImportOpen] = useState(false)
  const [studioImportUrl, setStudioImportUrl] = useState('')
  const [studioImportBusy, setStudioImportBusy] = useState(false)
  const [studioImportError, setStudioImportError] = useState('')
  const [studioImportStatus, setStudioImportStatus] = useState('')

  // Multi-file upload to library
  const [libBatchTag, setLibBatchTag] = useState('')
  const [libUploadFiles, setLibUploadFiles] = useState<File[]>([])
  const libUploadRef = useRef<HTMLInputElement | null>(null)

  // Browse library
  interface LibBatch { batch: string; label: string; file_count: number }
  interface LibFile { name: string; text: string; size_bytes: number }
  const [libBatches, setLibBatches] = useState<LibBatch[]>([])
  const [libSelectedBatch, setLibSelectedBatch] = useState<string>('')
  const [libBatchFiles, setLibBatchFiles] = useState<LibFile[]>([])
  const [libBusyName, setLibBusyName] = useState<string>('')

  const runStudioImport = async () => {
    if (!chart) return
    const url = studioImportUrl.trim()
    if (!url) {
      setStudioImportError('Paste a Studio URL first')
      return
    }
    setStudioImportBusy(true)
    setStudioImportError('')
    try {
      const fd = new FormData()
      fd.append('track_id', trackId)
      fd.append('beatmap_id', beatmapId)
      fd.append('studio_url', url)
      const res = await fetch('/api/elevenlabs/studio/import', { method: 'POST', body: fd })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Import failed (${res.status})`)
      }
      const data = await res.json() as {
        rel_path: string
        name: string
        text: string
        project_id: string
        chapter_id: string
      }
      const ev: TutorialVoEvent = {
        kind: 'vo',
        id: `vo-${Date.now()}`,
        tick: playheadTick,
        file: data.rel_path,
        text: data.text || data.name,
        engine: 'elevenlabs',
        voiceId: '',
      }
      updateTutorial([...chart.tutorial, ev], true)
      setSelectedTutorialId(ev.id)
      setStudioImportOpen(false)
      setStudioImportUrl('')
    } catch (e) {
      setStudioImportError((e as Error).message)
    } finally {
      setStudioImportBusy(false)
    }
  }

  const loadLibBatches = useCallback(async () => {
    try {
      const res = await fetch('/api/tutorial/vo-library/batches')
      if (!res.ok) throw new Error(`Failed to list batches (${res.status})`)
      const data = await res.json() as LibBatch[]
      setLibBatches(data)
    } catch (e) {
      setStudioImportError((e as Error).message)
    }
  }, [])

  const loadLibBatchFiles = useCallback(async (batch: string) => {
    if (!batch) { setLibBatchFiles([]); return }
    try {
      const res = await fetch(`/api/tutorial/vo-library/batches/${encodeURIComponent(batch)}`)
      if (!res.ok) throw new Error(`Failed to list files (${res.status})`)
      const data = await res.json() as { files: LibFile[] }
      setLibBatchFiles(data.files || [])
    } catch (e) {
      setStudioImportError((e as Error).message)
      setLibBatchFiles([])
    }
  }, [])

  // Refresh batches whenever the modal opens; refresh the file list when the
  // selected batch changes.
  useEffect(() => {
    if (studioImportOpen) {
      loadLibBatches()
    }
  }, [studioImportOpen, loadLibBatches])

  useEffect(() => {
    loadLibBatchFiles(libSelectedBatch)
  }, [libSelectedBatch, loadLibBatchFiles])

  const runLibraryUpload = async () => {
    const tag = libBatchTag.trim()
    if (!tag) {
      setStudioImportError('Add a batch tag first (e.g. "Guitar Lesson 1 elevenlabs Ryan")')
      return
    }
    if (libUploadFiles.length === 0) {
      setStudioImportError('Pick at least one audio file')
      return
    }
    setStudioImportBusy(true)
    setStudioImportError('')
    setStudioImportStatus('')
    try {
      const fd = new FormData()
      fd.append('batch_tag', tag)
      for (const f of libUploadFiles) fd.append('files', f)
      const res = await fetch('/api/tutorial/vo-library/upload', { method: 'POST', body: fd })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Upload failed (${res.status})`)
      }
      const data = await res.json() as { batch: string; label: string; files: LibFile[] }
      setStudioImportStatus(`Saved ${data.files.length} VO${data.files.length === 1 ? '' : 's'} to "${data.label}".`)
      setLibUploadFiles([])
      if (libUploadRef.current) libUploadRef.current.value = ''
      await loadLibBatches()
      setLibSelectedBatch(data.batch)
    } catch (e) {
      setStudioImportError((e as Error).message)
    } finally {
      setStudioImportBusy(false)
    }
  }

  const insertLibraryFile = async (batch: string, file: LibFile) => {
    if (!chart) return
    setLibBusyName(file.name)
    setStudioImportError('')
    setStudioImportStatus('')
    try {
      const res = await fetch(
        `/api/tutorial/${trackId}/beatmaps/${beatmapId}/vo/from-library`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batch, name: file.name }),
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Insert failed (${res.status})`)
      }
      const data = await res.json() as { rel_path: string; text: string }
      const ev: TutorialVoEvent = {
        kind: 'vo',
        id: `vo-${Date.now()}`,
        tick: playheadTick,
        file: data.rel_path,
        text: data.text || file.text,
        engine: 'elevenlabs',
        voiceId: '',
      }
      updateTutorial([...chart.tutorial, ev], true)
      setSelectedTutorialId(ev.id)
      setStudioImportStatus(`Inserted "${ev.text.slice(0, 50)}${ev.text.length > 50 ? '…' : ''}" at ${fmtTick(playheadTick)}.`)
    } catch (e) {
      setStudioImportError((e as Error).message)
    } finally {
      setLibBusyName('')
    }
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
      setSelectedTutorialId(ev.id)
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
    setSelectedTutorialId((cur) => (cur === ev.id ? null : cur))
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
    setSelectedTutorialId(ev.id)
  }

  const removeTutorialEvent = (id: string) => {
    if (!chart) return
    updateTutorial(chart.tutorial.filter((e) => e.id !== id))
    setSelectedTutorialId((cur) => (cur === id ? null : cur))
  }

  const updateTutorialEvent = (id: string, patch: Partial<TutorialEvent>) => {
    if (!chart) return
    const next = chart.tutorial.map((e) =>
      e.id === id ? ({ ...e, ...patch } as TutorialEvent) : e,
    )
    updateTutorial(next)
  }

  const [scenePickerOpen, setScenePickerOpen] = useState(false)
  // User-registered scene event types fetched from the backend. Merged with
  // SCENE_EVENT_CATALOG via `mergedSceneCatalog` so picker / parser /
  // serializer / value editor all see the full set.
  const [customSceneTypes, setCustomSceneTypes] = useState<SceneEventCatalogEntry[]>([])
  const mergedSceneCatalog = useMemo<SceneEventCatalogEntry[]>(
    () => [...SCENE_EVENT_CATALOG, ...customSceneTypes],
    [customSceneTypes],
  )
  // Create-type modal + handover-doc modal state.
  const [typeModalOpen, setTypeModalOpen] = useState(false)
  const [handoverModal, setHandoverModal] = useState<{ name: string; md: string } | null>(null)
  // Form state lives on the parent so it survives unrelated re-renders.
  const [typeFormName, setTypeFormName] = useState('')
  const [typeFormLabel, setTypeFormLabel] = useState('')
  const [typeFormGroup, setTypeFormGroup] = useState('Custom')
  const [typeFormDesc, setTypeFormDesc] = useState('')
  const [typeFormParamKind, setTypeFormParamKind] = useState<SceneEventParam['type']>('duration')
  const [typeFormMin, setTypeFormMin] = useState('')
  const [typeFormMax, setTypeFormMax] = useState('')
  const [typeFormStep, setTypeFormStep] = useState('')
  const [typeFormOptions, setTypeFormOptions] = useState('')
  const [typeFormBusy, setTypeFormBusy] = useState(false)
  const [typeFormError, setTypeFormError] = useState('')

  const resetTypeForm = useCallback(() => {
    setTypeFormName(''); setTypeFormLabel(''); setTypeFormGroup('Custom')
    setTypeFormDesc(''); setTypeFormParamKind('duration')
    setTypeFormMin(''); setTypeFormMax(''); setTypeFormStep('')
    setTypeFormOptions(''); setTypeFormError('')
  }, [])

  const submitNewType = async () => {
    setTypeFormBusy(true)
    setTypeFormError('')
    try {
      let param: SceneEventParam
      if (typeFormParamKind === 'duration') param = { type: 'duration' }
      else if (typeFormParamKind === 'hex_color') param = { type: 'hex_color' }
      else if (typeFormParamKind === 'none') param = { type: 'none' }
      else if (typeFormParamKind === 'number') {
        param = {
          type: 'number',
          min: typeFormMin ? Number(typeFormMin) : undefined,
          max: typeFormMax ? Number(typeFormMax) : undefined,
          step: typeFormStep ? Number(typeFormStep) : undefined,
        }
      } else {
        const opts = typeFormOptions.split('|').map((s) => s.trim()).filter(Boolean)
        if (opts.length === 0) throw new Error('Enum needs at least one option (pipe-separated, e.g. slow|fast)')
        param = { type: 'enum', options: opts }
      }
      const body = {
        name: typeFormName.trim(),
        item_label: typeFormLabel.trim() || typeFormName.trim(),
        group_label: typeFormGroup.trim() || 'Custom',
        description: typeFormDesc.trim(),
        param,
      }
      const res = await fetch('/api/scene-events/types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Create failed (${res.status})`)
      }
      const data = await res.json() as { type: RawCustomType; handover_md: string }
      setCustomSceneTypes((prev) => [...prev, adaptCustomType(data.type)])
      setHandoverModal({ name: data.type.name, md: data.handover_md })
      setTypeModalOpen(false)
      resetTypeForm()
    } catch (e) {
      setTypeFormError((e as Error).message)
    } finally {
      setTypeFormBusy(false)
    }
  }

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

  const setSceneEventValue = (id: string, value: string) => {
    if (!chart) return
    updateScene(chart.sceneEvents.map((e) => (e.id === id ? { ...e, value } : e)))
  }

  const removeSceneEvent = (id: string) => {
    if (!chart) return
    updateScene(chart.sceneEvents.filter((e) => e.id !== id))
    if (sceneSelectedId === id) setSceneSelectedId(null)
  }

  const addSceneEvent = (name: string) => {
    if (!chart) return
    const entry = findCatalogEntry(name, customSceneTypes)
    const isDur = entry ? entryAcceptsDuration(entry) : false
    const ev: SceneEvent = {
      id: `scene-${Date.now()}`,
      tick: playheadTick,
      name,
      duration: isDur ? 384 : 0,
      value: defaultValueForParam(entry?.param),
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
    const sec = tickToSec(tempoSegments, chart.resolution, tick)
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
        const voSec = tickToSec(tempoSegments, chart.resolution, ev.tick)
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
      const voSec = tickToSec(tempoSegments, chart.resolution, ev.tick)
      if (currentTime < voSec) continue
      const a = voAudiosRef.current.get(ev.id)
      if (!a) continue
      const startSec = (ev.startMs ?? 0) / 1000
      const endSec = ev.durationMs && ev.durationMs > 0
        ? startSec + ev.durationMs / 1000
        : Infinity
      if (!firedVosRef.current.has(ev.id)) {
        // Collated-file VOs: seek into the slice the chart says this VO
        // occupies. If the playhead is already past voSec by some delta,
        // start that much further into the slice so a scrub-resume picks
        // up where it would have been.
        a.currentTime = startSec + Math.max(0, currentTime - voSec)
        a.play().catch(() => { /* autoplay blocked; user must interact again */ })
        firedVosRef.current.add(ev.id)
        // Auto-stop at the end of the slice so we don't bleed into the
        // next VO that lives further down the same collated file.
        if (Number.isFinite(endSec)) {
          const onTick = () => {
            if (a.currentTime >= endSec - 0.01) {
              a.pause()
              a.removeEventListener('timeupdate', onTick)
            }
          }
          a.addEventListener('timeupdate', onTick)
        }
      } else if (a.paused && a.currentTime >= startSec && a.currentTime < endSec - 0.05) {
        // Already fired but the user paused mid-clip — resume from where the
        // audio element was paused (don't re-seek; that would stutter).
        a.play().catch(() => undefined)
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
    // Attempt counters are NOT cleared on pause — doing so re-arms the
    // first-attempt failure for every section ahead of the playhead, which
    // causes a fresh retry loop after every pause/play. To re-test the
    // retry path, toggle the "Fail first attempt" checkbox off+on (clears
    // attempts below) or reload the editor.
    lastStepIdxRef.current = -1
  }, [playing])

  // Clear attempt counters whenever the simulation tickbox toggles — turning
  // it OFF wipes stale state, and turning it back ON gives every section a
  // fresh first attempt to fail.
  useEffect(() => {
    sectionAttemptsRef.current = new Map()
  }, [simulateRetryOnce])

  // STEP boundary pass/fail emulation — only meaningful in autohit + when
  // the chart carries STEPs with required>0 and a retry_vo path. Each frame
  // we track which step the playhead is inside; when it crosses forward by
  // exactly one step, we evaluate the section that just ended. If credited
  // hits fall short of required, fire retry VO and seek back to the section
  // start. Autohit normally hits every note, so the only way we fall short
  // is if the simulation tickbox is on AND this is the section's first
  // attempt; then we deduct one credit.
  useEffect(() => {
    if (!chart || !chart.tutorialEnabled || !playing || playMode !== 'autohit') return
    const steps = chart.tutorial
      .filter((e): e is TutorialStepEvent => e.kind === 'step')
      .sort((a, b) => a.tick - b.tick)
    if (steps.length < 2) return
    const curTick = secToTick(tempoSegments, chart.resolution, currentTime)
    let idx = -1
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].tick <= curTick) idx = i
      else break
    }
    const prevIdx = lastStepIdxRef.current
    if (idx === prevIdx + 1 && prevIdx >= 0) {
      const ending = steps[prevIdx]
      const next = steps[idx]
      if (ending.required > 0 && ending.retryVo) {
        // Count unique note ticks (chord = one note) in [ending.tick, next.tick).
        const noteTicks = new Set<number>()
        for (const n of chart.notes) {
          if (n.type !== 'real') continue
          if (n.lane > 4 && n.lane !== 7) continue
          if (n.tick >= ending.tick && n.tick < next.tick) noteTicks.add(n.tick)
        }
        const noteCount = noteTicks.size
        const attempts = sectionAttemptsRef.current.get(ending.id) || 0
        const credited = (simulateRetryOnce && attempts === 0)
          ? Math.max(0, noteCount - 1)
          : noteCount
        sectionAttemptsRef.current.set(ending.id, attempts + 1)
        if (credited < ending.required) {
          // FAIL — play retry clip and seek back to the section start.
          // retry_vo typically points at the collated vo/tutorial.ogg with
          // retry_start_ms / retry_duration_ms slice offsets so variants
          // can live alongside section VOs in the same file. Falls back to
          // whole-file playback when slice offsets aren't set.
          const url = `/api/tutorial/${trackId}/beatmaps/${beatmapId}/${ending.retryVo}`
          const a = new Audio(url)
          const startSec = (ending.retryStartMs ?? 0) / 1000
          const endSec = ending.retryDurationMs && ending.retryDurationMs > 0
            ? startSec + ending.retryDurationMs / 1000
            : Infinity
          const startPlayback = () => {
            if (startSec > 0) a.currentTime = startSec
            a.play().catch(() => undefined)
            if (Number.isFinite(endSec)) {
              const onTick = () => {
                if (a.currentTime >= endSec - 0.01) {
                  a.pause()
                  a.removeEventListener('timeupdate', onTick)
                }
              }
              a.addEventListener('timeupdate', onTick)
            }
          }
          // Need readyState >= HAVE_METADATA before seeking; if it isn't
          // there yet (cold network fetch), wait for loadedmetadata once.
          if (a.readyState >= 1) startPlayback()
          else a.addEventListener('loadedmetadata', startPlayback, { once: true })
          const seekSec = tickToSec(tempoSegments, chart.resolution, ending.tick)
          if (audioRef.current) audioRef.current.currentTime = seekSec
          setCurrentTime(seekSec)
          lastStepIdxRef.current = prevIdx  // we're back inside the failed step
          return
        }
      }
    }
    lastStepIdxRef.current = idx
  }, [currentTime, playing, playMode, chart, tempoSegments, simulateRetryOnce, trackId, beatmapId])
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
      // Re-synthesizing replaces the audio file, so any prior collated-slice
      // offsets no longer apply — clear them to fall back to whole-file
      // playback for this freshly minted clip.
      updateTutorialEvent(ev.id, { file: data.rel_path, startMs: undefined, durationMs: undefined })
    } catch (e) {
      window.alert((e as Error).message)
    } finally {
      setTtsBusy(null)
    }
  }

  const fmtTick = (tick: number) => {
    if (!chart) return ''
    const sec = tickToSec(tempoSegments, chart.resolution, tick)
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
      <header className={`${maxHighway ? 'hidden' : ''} h-20 shrink-0 border-b border-gray-800 bg-gray-950 flex items-center px-3 gap-3`}>
        {/* Title + cover live in the left sidebar now; use the browser back
            button to leave. The whole header is the timelines. */}
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <div className="h-7">
            {chart && duration > 0 ? (
              <TutorialTimeline
                duration={duration}
                currentTime={currentTime}
                tempoSegments={tempoSegments}
                resolution={chart.resolution}
                events={chart.tutorialEnabled ? chart.tutorial : []}
                snapDivisor={snapDivisor}
                onSeek={seekSeconds}
                onMoveEvent={(id, tick) => updateTutorialEvent(id, { tick } as Partial<TutorialEvent>)}
                view={timelineView}
                onViewChange={setTimelineView}
              />
            ) : (
              <div className="h-full bg-gray-950 border border-gray-800 rounded text-[11px] text-gray-700 flex items-center justify-center">
                {loadError ? '—' : 'loading audio…'}
              </div>
            )}
          </div>
          <WaveformStrip
            peaks={activePeaks}
            duration={activeDuration}
            bucketSec={peaksBucketSec}
            currentTime={currentTime}
            onSeek={(s) => {
              if (audioRef.current) audioRef.current.currentTime = s
              setCurrentTime(s)
            }}
            view={timelineView}
            onViewChange={setTimelineView}
            clips={(chart?.clips ?? []).filter((c) => c.endSec > c.startSec && c.sourceId === activeSourceId).map((c) => ({
              id: c.id,
              startSec: c.startSec,
              endSec: c.endSec,
              name: c.name,
              selected: c.id === selectedClipId,
            }))}
            onSelectClip={setSelectedClipId}
            onCommitDragRegion={activeSourceId ? (s, e) => setPendingClip({ startSec: s, endSec: e, name: '', sourceId: activeSourceId }) : undefined}
            emptyStateText={activeSourceId ? 'Loading source…' : 'No audio attached.'}
          />
          {pendingClip && (
            <div className="px-3 py-2 bg-gray-900 border-y border-gray-800 flex items-center gap-2">
              <span className="text-[10px] text-gray-500 uppercase tracking-wider">New clip</span>
              <input
                autoFocus
                type="text"
                value={pendingClip.name}
                onChange={(e) => setPendingClip({ ...pendingClip, name: e.target.value })}
                placeholder={`Clip name (${(pendingClip.endSec - pendingClip.startSec).toFixed(1)}s)`}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-200 w-48"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveClipFromPending()
                  if (e.key === 'Escape') setPendingClip(null)
                }}
              />
              <button onClick={() => void saveClipFromPending()}
                className="text-[11px] px-2 py-1 bg-cyan-700 hover:bg-cyan-600 rounded text-white">
                Save clip
              </button>
              <button onClick={() => setPendingClip(null)}
                className="text-[11px] px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded text-gray-300">
                Cancel
              </button>
            </div>
          )}
          <div className="h-6">
            {chart && duration > 0 ? (
              <SceneTimeline
                duration={duration}
                tempoSegments={tempoSegments}
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
        <aside className={`${maxHighway ? 'hidden' : ''} w-80 shrink-0 border-r border-gray-800 bg-gray-950 overflow-y-auto p-4 space-y-5`}>
          <section className="flex items-center gap-3">
            {meta?.hasAlbumArt && (
              <img
                src={`/api/tracks/${trackId}/stems/album_png`}
                alt="cover"
                className="shrink-0 h-14 w-14 rounded object-cover border border-gray-800 bg-gray-900"
              />
            )}
            <div className="min-w-0 flex-1">
              <h1 className="text-sm font-semibold text-gray-100 truncate">
                {meta?.name || (loadError ? 'Failed to load' : 'Beatmap editor')}
              </h1>
              <p className="text-[11px] text-gray-500 leading-tight truncate">
                {chart
                  ? `${chart.activeName || '—'} · ${noteCount} notes`
                  : loadError
                    ? `Error: ${loadError}`
                    : 'Loading…'}
              </p>
              {chart && (
                <p className="text-[11px] text-gray-500 leading-tight font-mono">
                  {chart.bpm.toFixed(1)} BPM · res {chart.resolution}
                </p>
              )}
            </div>
          </section>

          {chart && (() => {
            // Always offer the canonical 5-lane guitar set so the user can
            // start authoring on a fresh beatmap; layer in any extra sections
            // (drums, keyboard, etc.) the chart actually carries. Each option
            // shows its current note count so empty difficulties are obvious.
            const STANDARD = ['EasySingle', 'MediumSingle', 'HardSingle', 'ExpertSingle']
            const allNames = [...STANDARD]
            for (const s of chart.availableSections) {
              if (!allNames.includes(s)) allNames.push(s)
            }
            const noteCountOf = (name: string): number => {
              if (name === chart.activeName) return chart.notes.length
              if (!chart.availableSections.includes(name)) return 0
              return parseSectionNotes(chart.fullText, name, chart.resolution).length
            }
            return (
              <CollapsibleSection id="difficulty" title="Difficulty">
                <select
                  value={chart.activeName}
                  onChange={(e) => switchDifficulty(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-jam-500"
                >
                  {allNames.map((s) => {
                    const count = noteCountOf(s)
                    const exists = chart.availableSections.includes(s)
                    const tag = exists ? `${count} note${count === 1 ? '' : 's'}` : 'empty'
                    return <option key={s} value={s}>{`${s} · ${tag}`}</option>
                  })}
                </select>
              </CollapsibleSection>
            )
          })()}

          <CollapsibleSection id="transport" title="Transport">
            <div className="flex items-center gap-1 mb-2">
              <button
                onClick={() => seekSeconds(0)}
                className="w-7 h-7 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 flex items-center justify-center text-xs"
                aria-label="Rewind to start"
                title="Rewind to start (Home)"
              >
                ⏮
              </button>
              <button
                onClick={() => {
                  if (!chart) return
                  const stepTicks = Math.max(1, Math.round(chart.resolution / snapDivisor))
                  const curTick = secToTick(tempoSegments, chart.resolution, currentTime)
                  const newTick = Math.max(0, curTick - stepTicks)
                  seekSeconds(tickToSec(tempoSegments, chart.resolution, newTick))
                }}
                disabled={!chart}
                className="w-7 h-7 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-gray-200 flex items-center justify-center text-[10px] font-mono"
                aria-label="Nudge back one snap"
                title="Back one snap unit (current grid)"
              >
                −
              </button>
              <button
                onClick={togglePlay}
                className="w-9 h-9 rounded-full bg-jam-600 hover:bg-jam-500 text-white flex items-center justify-center text-sm"
                aria-label={playing ? 'Pause' : 'Play'}
                title={playing ? 'Pause (Space)' : 'Play (Space)'}
              >
                {playing ? '❚❚' : '▶'}
              </button>
              <button
                onClick={() => {
                  if (!chart) return
                  const stepTicks = Math.max(1, Math.round(chart.resolution / snapDivisor))
                  const curTick = secToTick(tempoSegments, chart.resolution, currentTime)
                  const newTick = curTick + stepTicks
                  const newSec = tickToSec(tempoSegments, chart.resolution, newTick)
                  seekSeconds(duration > 0 ? Math.min(duration, newSec) : newSec)
                }}
                disabled={!chart}
                className="w-7 h-7 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-gray-200 flex items-center justify-center text-[10px] font-mono"
                aria-label="Nudge forward one snap"
                title="Forward one snap unit (current grid)"
              >
                +
              </button>
              <button
                onClick={() => seekSeconds(duration || 0)}
                disabled={!duration}
                className="w-7 h-7 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-gray-200 flex items-center justify-center text-xs"
                aria-label="Skip to end"
                title="Skip to end (End)"
              >
                ⏭
              </button>
              <span className="ml-1 text-[11px] font-mono text-gray-400 tabular-nums">
                {Math.floor(currentTime / 60)}:{Math.floor(currentTime % 60).toString().padStart(2, '0')}
                <span className="text-gray-600"> / </span>
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
            <div className="mt-2 grid grid-cols-2 gap-1">
              <button
                onClick={() => switchAudioSource('beatmap')}
                className={`px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                  audioSource === 'beatmap'
                    ? 'bg-jam-600 text-white'
                    : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                }`}
                title="Play this beatmap's stem audio (default)"
              >
                Stem only
              </button>
              <button
                onClick={() => switchAudioSource('track-song')}
                className={`px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                  audioSource === 'track-song'
                    ? 'bg-jam-600 text-white'
                    : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                }`}
                title="Play the track's full mix while authoring this beatmap's chart"
              >
                Full mix
              </button>
            </div>
            <label className="mt-2 flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={waveformOnHighway}
                onChange={(e) => setWaveformOnHighway(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-gray-600 bg-gray-900 accent-cyan-500 cursor-pointer"
              />
              <span className="text-[11px] text-gray-300">Waveform on highway</span>
              <span className="text-[10px] text-gray-500 ml-auto" title="Useful for visually confirming gems are on transients">
                {waveformOnHighway ? 'on' : 'off'}
              </span>
            </label>
            <label className="mt-2 flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={clickEnabled}
                onChange={(e) => setClickEnabled(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-gray-600 bg-gray-900 accent-amber-500 cursor-pointer"
              />
              <span className="text-[11px] text-gray-300">Click track</span>
              <span className="text-[10px] text-gray-500 ml-auto" title="Square-wave click on every beat. Higher pitch every 4th beat (downbeat).">
                {clickEnabled ? 'on' : 'off'}
              </span>
            </label>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-[11px] text-gray-500 shrink-0">Click vol</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(clickVolume * 100)}
                onChange={(e) => setClickVolume(Number(e.target.value) / 100)}
                disabled={!clickEnabled}
                className="flex-1 accent-amber-500 disabled:opacity-40"
                title="Click volume"
              />
              <span className="text-[11px] font-mono text-gray-300 w-10 text-right shrink-0">
                {Math.round(clickVolume * 100)}%
              </span>
            </div>
            <label className="mt-2 flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={realNotesEnabled}
                onChange={(e) => setRealNotesEnabled(e.target.checked)}
                disabled={!realNotesReady}
                className="h-3.5 w-3.5 rounded border-gray-600 bg-gray-900 accent-cyan-500 cursor-pointer disabled:cursor-not-allowed"
              />
              <span className={`text-[11px] ${realNotesReady ? 'text-gray-300' : 'text-gray-600'}`}>
                Real-note playback
              </span>
              <span className="text-[10px] text-gray-500 ml-auto" title={realNotesReady ? 'Plays the sample pack on every real-note (cyan-dotted gem) as the playhead crosses it.' : 'Apply a sound pack on the track page to enable this.'}>
                {realNotesReady ? (realNotesEnabled ? 'on' : 'off') : 'no pack'}
              </span>
            </label>
            {/* Play mode — Autohit fires every real-note as the playhead
                crosses it. Live waits for the player to strum (gamepad input).
                Live works without an applied sound pack too (ghost gems
                still press, explosions still fire) — sample audio just
                doesn't play until a pack is added. */}
            <div className="mt-2 flex items-center gap-1">
              <span className="text-[11px] text-gray-500 mr-1 shrink-0">Mode</span>
              {(['autohit', 'live'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setPlayMode(m)}
                  className={`flex-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                    playMode === m
                      ? 'bg-cyan-700/70 text-white border border-cyan-500/60'
                      : 'bg-gray-800 hover:bg-gray-700 text-gray-300 border border-transparent'
                  }`}
                  title={
                    m === 'autohit'
                      ? 'Game auto-fires every real-note sample on cross.'
                      : 'Player drives hits — strum your guitar in time with held frets to fire each note.'
                  }
                >
                  {m === 'autohit' ? 'Autohit' : 'Live'}
                </button>
              ))}
            </div>
            {/* Retry-cue test: in autohit, drop one credited hit per section
                on its first attempt so the engine fires the retry VO and
                seeks back. Lets the user audition retry_vo without dropping
                to live mode and missing notes manually. */}
            <label className="mt-1 flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={simulateRetryOnce}
                onChange={(e) => setSimulateRetryOnce(e.target.checked)}
                disabled={playMode !== 'autohit'}
                className="h-3.5 w-3.5 rounded border-gray-600 bg-gray-900 accent-cyan-500 cursor-pointer disabled:cursor-not-allowed"
              />
              <span className={`text-[11px] ${playMode === 'autohit' ? 'text-gray-300' : 'text-gray-600'}`}>
                Fail first attempt
              </span>
              <span
                className="text-[10px] text-gray-500 ml-auto"
                title="Autohit otherwise hits every note. This makes each section short by 1 on its first pass so retry_vo plays and the playhead seeks back. Second pass counts normally."
              >
                {playMode === 'autohit' ? (simulateRetryOnce ? 'on' : 'off') : 'autohit only'}
              </span>
            </label>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-[11px] text-gray-500 shrink-0">Real vol</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(realNotesVolume * 100)}
                onChange={(e) => setRealNotesVolume(Number(e.target.value) / 100)}
                disabled={!realNotesReady || !realNotesEnabled}
                className="flex-1 accent-cyan-500 disabled:opacity-40"
                title="Real-note sample volume"
              />
              <span className="text-[11px] font-mono text-gray-300 w-10 text-right shrink-0">
                {Math.round(realNotesVolume * 100)}%
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[11px] text-gray-500 shrink-0">Speed</span>
              <input
                type="range"
                min={25}
                max={150}
                step={5}
                value={Math.round(playbackRate * 100)}
                onChange={(e) => setPlaybackRate(Number(e.target.value) / 100)}
                className="flex-1 accent-jam-500"
                title="Playback speed (pitch preserved)"
              />
              <span className="text-[11px] font-mono text-gray-300 w-10 text-right shrink-0">
                {Math.round(playbackRate * 100)}%
              </span>
              <button
                onClick={() => setPlaybackRate(1)}
                disabled={playbackRate === 1}
                className="text-[10px] px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-gray-400 rounded transition-colors"
                title="Reset to 100%"
              >
                1×
              </button>
            </div>
          </CollapsibleSection>

          <CollapsibleSection id="tools" title="Tools">
            <div className="grid grid-cols-3 gap-1 mb-2">
              <button
                onClick={() => setTool('select')}
                className={`px-1.5 py-1.5 rounded text-[11px] font-medium transition-colors ${
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
                className={`px-1.5 py-1.5 rounded text-[11px] font-medium transition-colors ${
                  tool === 'note'
                    ? 'bg-jam-600 text-white'
                    : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                }`}
                title="Play note (2) — click a lane to drop a normal gem · shift-click for OPEN"
              >
                ✚ Play <span className="text-[10px] opacity-60">(2)</span>
              </button>
              <button
                onClick={() => setTool('real')}
                className={`px-1.5 py-1.5 rounded text-[11px] font-medium transition-colors ${
                  tool === 'real'
                    ? 'bg-cyan-600 text-white'
                    : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                }`}
                title="Real note (3) — click drops a gem flagged to play a pitched sample on hit · shift-click for OPEN"
              >
                <span className="text-cyan-200">●</span> Real <span className="text-[10px] opacity-60">(3)</span>
              </button>
            </div>
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
            <details className="mt-1.5 group">
              <summary className="cursor-pointer text-[10px] text-gray-500 hover:text-gray-300 select-none flex items-center gap-1">
                <span className="text-[10px] text-gray-600 group-open:rotate-90 transition-transform inline-block w-2">▶</span>
                <span>? Help — shortcuts & note-tool quick reference</span>
              </summary>
              <p className="text-[10px] text-gray-600 mt-1 leading-snug pl-3">
                Shift-click to multi-select. Ctrl/Cmd + C/X/V copy, cut, paste at playhead. Ctrl+A selects all.
                <br />
                F = toggle force-HOPO · T = toggle tap · R = toggle real-note · O = toggle open · H = toggle 1-beat sustain · = quantize to grid.
                <br />
                <span className="text-gray-500">Note tool: click a lane to drop a gem · drag up while clicking to set a hold · shift-click for OPEN.</span>
              </p>
            </details>
            {chart && selectedIds.size >= 1 && (() => {
              // Sustain editor — visible whenever at least one gem/open is
              // selected. For multi-selection we show the value of the first
              // selected note as a representative; quick-set buttons apply
              // the same length to every selected gem/open.
              const ids = Array.from(selectedIds)
              const sustainable = ids
                .map((i) => chart.notes[i])
                .filter((n): n is ChartNote => !!n && (n.lane <= 4 || n.lane === 7))
              if (sustainable.length === 0) return null
              const first = sustainable[0]
              const setSustain = (ticks: number) => {
                const next = chart.notes.slice()
                let changed = false
                for (const idx of ids) {
                  const cur = next[idx]
                  if (!cur) continue
                  if (cur.lane > 4 && cur.lane !== 7) continue
                  if (cur.sustain !== ticks) {
                    next[idx] = { ...cur, sustain: Math.max(0, Math.round(ticks)) }
                    changed = true
                  }
                }
                if (changed) commitNotes(next)
              }
              const beatPresets: { label: string; beats: number }[] = [
                { label: '0', beats: 0 },
                { label: '¼', beats: 0.25 },
                { label: '½', beats: 0.5 },
                { label: '1', beats: 1 },
                { label: '2', beats: 2 },
                { label: '4', beats: 4 },
              ]
              return (
                <div className="mt-2 pt-2 border-t border-gray-800">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] text-gray-400 font-medium">
                      Sustain {sustainable.length > 1 ? `(${sustainable.length})` : ''}
                    </span>
                    <span className="text-[10px] text-gray-600 font-mono">
                      {(first.sustain / chart.resolution).toFixed(2)} beats
                    </span>
                  </div>
                  <div className="flex items-center gap-1 mb-1">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={first.sustain}
                      onChange={(e) => setSustain(Number(e.target.value) || 0)}
                      className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[11px] font-mono text-gray-200 focus:outline-none focus:border-jam-500"
                      title="Sustain length in ticks"
                    />
                    <span className="text-[10px] text-gray-500 font-mono shrink-0">ticks</span>
                  </div>
                  <div className="grid grid-cols-6 gap-1">
                    {beatPresets.map((p) => (
                      <button
                        key={p.label}
                        onClick={() => setSustain(Math.round(p.beats * chart.resolution))}
                        className={`px-1 py-1 rounded text-[10px] font-mono transition-colors ${
                          first.sustain === Math.round(p.beats * chart.resolution)
                            ? 'bg-jam-600 text-white'
                            : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                        }`}
                        title={`${p.beats === 0 ? 'Single hit' : `${p.beats} beat${p.beats === 1 ? '' : 's'}`}`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })()}
            {chart && selectedIds.size >= 1 && (() => {
              // Per-note pack/scale dropdowns. Visible when the selection
              // includes at least one real-note (R). Each dropdown rewrites
              // the chosen field on every selected R note in place — chord
              // members at the same tick should share (pack, scale), so the
              // tick-grouped real-notes get the same value too.
              const realIds = Array.from(selectedIds).filter((idx) => {
                const n = chart.notes[idx]
                return !!n && n.type === 'real'
              })
              if (realIds.length === 0) return null
              const realTicks = new Set<number>()
              for (const idx of realIds) realTicks.add(chart.notes[idx].tick)
              // Representative pack/scale = the first selected real-note's.
              const first = chart.notes[realIds[0]]
              const firstPack = first.pack || ''
              const firstScale = first.scale || ''
              const setField = (field: 'pack' | 'scale', value: string) => {
                const next = chart.notes.slice()
                let changed = false
                for (let i = 0; i < next.length; i++) {
                  const n = next[i]
                  if (n.type !== 'real' || !realTicks.has(n.tick)) continue
                  if ((field === 'pack' ? n.pack : n.scale) === value) continue
                  next[i] = field === 'pack' ? { ...n, pack: value } : { ...n, scale: value }
                  changed = true
                }
                if (changed) commitNotes(next)
              }
              return (
                <div className="mt-2 pt-2 border-t border-gray-800 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-cyan-300 font-medium">
                      Real-note pack {realTicks.size > 1 ? `(${realTicks.size} ticks)` : ''}
                    </span>
                  </div>
                  <select
                    value={firstPack}
                    onChange={(e) => setField('pack', e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-gray-200 focus:outline-none focus:border-cyan-500"
                  >
                    {!firstPack && <option value="">— pick a pack —</option>}
                    {packCatalog.map((p) => (
                      <option key={p.pack_id} value={p.pack_id}>{p.name} — {p.family}</option>
                    ))}
                  </select>
                  <select
                    value={firstScale}
                    onChange={(e) => setField('scale', e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-gray-200 focus:outline-none focus:border-cyan-500"
                  >
                    {!firstScale && <option value="">— pick a scale —</option>}
                    {scaleCatalog.map((s) => (
                      <option key={s.scale_id} value={s.scale_id}>{s.name}</option>
                    ))}
                  </select>
                  <p className="text-[10px] text-gray-600 leading-snug">
                    Stored on each R note. The published chart coalesces runs of same-(pack,scale) notes into one E-event declaration per change.
                  </p>
                </div>
              )
            })()}
          </CollapsibleSection>

          <CollapsibleSection
            id="input-device"
            title="Input device"
            right={
              <button
                onClick={refreshGamepads}
                className="text-[10px] px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded"
                title="Re-scan for connected gamepads"
              >
                ↻ scan
              </button>
            }
          >
            <select
              value={gamepadId}
              onChange={(e) => setGamepadId(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-md px-2 py-1.5 text-[11px] text-gray-200 focus:outline-none focus:border-jam-500"
            >
              <option value="">— no device —</option>
              <option value={KEYBOARD_DEVICE_ID}>Keyboard</option>
              {gamepadList.map((gp) => (
                <option key={gp.id} value={gp.id}>{gp.id.slice(0, 50)}</option>
              ))}
            </select>
            {gamepadList.length === 0 && (
              <div className="text-[10px] text-gray-500 mt-1 leading-snug space-y-1">
                <p>No gamepad detected. Try in this order:</p>
                <ol className="list-decimal pl-4 space-y-0.5 text-gray-500">
                  <li><span className="text-gray-300">Click anywhere in this page</span> first — Chrome won't enumerate Bluetooth gamepads until the page has had user input.</li>
                  <li>Press a button on the guitar.</li>
                  <li>If still nothing, switch the CRKD <span className="font-semibold">mode dial to 4 (Xinput)</span> — modes 1/2/3 (Switch/PS/generic) aren't always recognised by the browser's Gamepad API.</li>
                  <li>Verify the browser sees it at <a href="https://hardwaretester.com/gamepad" target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:text-emerald-300 underline">hardwaretester.com/gamepad</a> — if it's blank there too, it's a browser/OS pairing issue, not this app.</li>
                </ol>
                <p className="text-gray-600 pt-1">
                  Raw enumeration:{' '}
                  <span className="font-mono">
                    {(navigator.getGamepads?.() || []).map((g, i) => g ? `[${i}] ${g.id}` : `[${i}] null`).join(' · ') || 'getGamepads unavailable'}
                  </span>
                </p>
              </div>
            )}
            <div className="mt-2 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-gray-500 uppercase tracking-wider">Bindings</span>
                  <button
                    onClick={startAutoMap}
                    disabled={!!autoMapStep || !gamepadId}
                    className="text-[10px] px-1.5 py-0.5 bg-emerald-700/60 hover:bg-emerald-600/70 disabled:opacity-40 text-emerald-100 rounded"
                    title={gamepadId ? 'Walk through pressing each fret + strum in order' : 'Connect a gamepad to use auto-map'}
                  >
                    {autoMapStep ? 'mapping…' : 'auto-map'}
                  </button>
                </div>
                {(Object.keys(BINDING_LABELS) as (keyof InputBinding)[]).map((k) => {
                  const v = binding[k]
                  const listening = captureNextPressRef.current !== null && autoMapStep === k
                  const isCurrentWizardStep = autoMapStep === k
                  const btnLabel = v.buttons.length === 0 ? '—' : v.buttons.map((i) => `btn ${i}`).join(', ')
                  // Pretty key labels — strip leading "Key" / "Digit", show
                  // arrows etc as symbols. Falls back to raw code.
                  const prettyKey = (code: string) =>
                    code.startsWith('Key') ? code.slice(3)
                    : code.startsWith('Digit') ? code.slice(5)
                    : code === 'ArrowUp' ? '↑'
                    : code === 'ArrowDown' ? '↓'
                    : code === 'ArrowLeft' ? '←'
                    : code === 'ArrowRight' ? '→'
                    : code === 'Space' ? '␣'
                    : code
                  const keyLabel = v.keys.length === 0 ? '—' : v.keys.map(prettyKey).join('+')
                  const displayLabel = isKeyboardDevice ? keyLabel : btnLabel
                  const hasAny = isKeyboardDevice ? v.keys.length > 0 : v.buttons.length > 0
                  return (
                    <div key={k} className="flex items-center gap-1 text-[11px]">
                      <span className={`w-14 ${isCurrentWizardStep ? 'text-emerald-300' : 'text-gray-400'}`}>
                        {BINDING_LABELS[k]}
                      </span>
                      <span
                        className="flex-1 font-mono text-gray-500 truncate"
                        title={isKeyboardDevice
                          ? `Keyboard: ${v.keys.join(' / ') || 'none'}`
                          : `Gamepad: ${btnLabel}`}
                      >
                        {displayLabel}
                      </span>
                      <button
                        onClick={() => listenForBinding(k)}
                        disabled={listening || isCurrentWizardStep}
                        className="px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-300 rounded text-[10px]"
                        title={isKeyboardDevice
                          ? `Press a key to bind ${BINDING_LABELS[k]}. Multiple keys per lane allowed.`
                          : `Press a gamepad button to bind ${BINDING_LABELS[k]}. Multiple buttons per lane allowed.`}
                      >
                        {isCurrentWizardStep ? 'press…' : hasAny ? '+' : 'listen'}
                      </button>
                      <button
                        onClick={() => setBinding((b) => {
                          const slot = b[k]
                          // Only clear the active device's side so swapping
                          // devices preserves the other set.
                          return { ...b, [k]: isKeyboardDevice
                            ? { buttons: slot.buttons, keys: [] }
                            : { buttons: [], keys: slot.keys } }
                        })}
                        className="px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-500 rounded text-[10px]"
                        title={isKeyboardDevice
                          ? 'Clear all keys bound to this lane'
                          : 'Clear all gamepad buttons bound to this lane'}
                      >
                        ✕
                      </button>
                    </div>
                  )
                })}
                {autoMapStep && (
                  <p className="text-[10px] text-emerald-300 leading-snug pt-1">
                    Press the <span className="font-semibold">{BINDING_LABELS[autoMapStep]}</span> button on the guitar…
                    <button
                      onClick={() => setAutoMapStep(null)}
                      className="ml-2 underline text-gray-400 hover:text-gray-200"
                    >
                      cancel
                    </button>
                  </p>
                )}
                {/* Live held-frets indicator. One pill per lane lights up
                    when the corresponding fret button is currently in the
                    heldFretsRef set. If you press 2 frets and only one pill
                    lights, the device isn't reporting the second button as
                    pressed (could be anti-ghosting on the controller, a bad
                    binding, or two bindings sharing the same button index). */}
                <div className="flex items-center gap-1 pt-1">
                  <span className="text-[10px] text-gray-500 mr-1 w-12">Held:</span>
                  {[0, 1, 2, 3, 4].map((lane) => {
                    const on = heldFretsView.includes(lane)
                    const colors = ['bg-green-500', 'bg-red-500', 'bg-yellow-500', 'bg-blue-500', 'bg-orange-500']
                    return (
                      <div
                        key={lane}
                        className={`w-5 h-3 rounded ${on ? colors[lane] : 'bg-gray-800 border border-gray-700'}`}
                        title={`Lane ${lane}${on ? ' — pressed' : ''}`}
                      />
                    )
                  })}
                  <div
                    className={`w-3 h-3 rounded ${strumUpLit ? 'bg-fuchsia-400' : 'bg-gray-800 border border-gray-700'}`}
                    title={`Strum ↑${strumUpLit ? ' — pressed' : ''}`}
                  />
                  <div
                    className={`w-3 h-3 rounded ${strumDownLit ? 'bg-fuchsia-400' : 'bg-gray-800 border border-gray-700'}`}
                    title={`Strum ↓${strumDownLit ? ' — pressed' : ''}`}
                  />
                  <span className="ml-auto text-[10px] font-mono text-gray-500">
                    {heldFretsView.length}/5
                  </span>
                </div>
                {/* What the 3D ghost renderer is reading. If this strip
                    differs from the Held strip above, the GemMeshLayer has a
                    ref/closure problem (different held set). If they always
                    match, the issue is in the ghost animation logic. */}
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-gray-500 mr-1 w-12">3D sees:</span>
                  {[0, 1, 2, 3, 4].map((lane) => {
                    const on = ghostHeldView.includes(lane)
                    const colors = ['bg-green-500', 'bg-red-500', 'bg-yellow-500', 'bg-blue-500', 'bg-orange-500']
                    return (
                      <div
                        key={lane}
                        className={`w-5 h-3 rounded ${on ? colors[lane] : 'bg-gray-800 border border-gray-700'} opacity-70`}
                        title={`3D layer ${on ? 'is animating' : 'is NOT animating'} lane ${lane}`}
                      />
                    )
                  })}
                  <span className="ml-auto text-[10px] font-mono text-gray-500">
                    {ghostHeldView.length}/5
                  </span>
                </div>
                <div className="flex items-center gap-1 pt-1">
                  <button
                    onClick={saveBinding}
                    disabled={!bindingDirty}
                    className={`flex-1 px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                      bindingDirty
                        ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                        : 'bg-gray-800 text-gray-500 cursor-default'
                    }`}
                    title="Persist this mapping for the selected device (per-device, survives refresh)."
                  >
                    {bindingDirty ? '✓ Save config' : 'Saved'}
                  </button>
                  {bindingDirty && (
                    <button
                      onClick={() => setBinding(savedBinding)}
                      className="px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-[10px]"
                      title="Discard changes and revert to the saved mapping."
                    >
                      revert
                    </button>
                  )}
                </div>
              </div>
          </CollapsibleSection>

          <CollapsibleSection
            id="scoring"
            title="Scoring"
            right={
              <button
                onClick={resetScoring}
                className="text-[10px] px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded"
                title="Reset score, streak, and hit/miss tracking for this pass"
              >
                ↺ reset
              </button>
            }
          >
            <p className="text-[10px] text-gray-600 leading-snug mb-2">
              Hit windows lifted from <span className="font-mono">GuitarJudge.cs</span>:
              Perfect ±60ms · Good 60–120ms · Okay 120–200ms early / 120–150ms late.
              Streak holds on any tier; only a fully-missed note (past late-okay) breaks it.
            </p>
            <span className="text-[10px] uppercase tracking-wider text-gray-500 block mt-1 mb-1">Per-difficulty target</span>
            <div className="grid grid-cols-2 gap-1">
              {(['EasySingle', 'MediumSingle', 'HardSingle', 'ExpertSingle'] as const).map((d) => (
                <label key={d} className="block">
                  <span className="text-[10px] text-gray-500">{d.replace('Single', '')}</span>
                  <input
                    type="number"
                    min={0}
                    step={50000}
                    value={scoringSettings.targets[d] ?? 0}
                    onChange={(e) => setScoringSettings((s) => ({
                      ...s,
                      targets: { ...s.targets, [d]: Math.max(0, Number(e.target.value) || 0) },
                    }))}
                    className="w-full bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-[11px] font-mono text-gray-200"
                  />
                </label>
              ))}
            </div>
            {chart && (
              <p className="text-[10px] text-gray-500 mt-1">
                <span className="font-mono">{chart.activeName}</span>: {noteCountForScoring} scoreable notes ·
                <span className="text-emerald-300 font-mono"> {pointsPerPerfectHit.toLocaleString()}</span> pts / perfect
              </p>
            )}
            <span className="text-[10px] uppercase tracking-wider text-gray-500 block mt-2 mb-1">Tolerance multipliers</span>
            <div className="space-y-0.5">
              {(['veryEarly', 'early', 'perfect', 'late', 'veryLate'] as const).map((tier) => (
                <div key={tier} className="flex items-center gap-1 text-[11px]">
                  <span className={`w-20 ${
                    tier === 'perfect' ? 'text-emerald-300' :
                    tier === 'early' || tier === 'late' ? 'text-cyan-300' :
                    'text-amber-400'
                  }`}>
                    {tier === 'veryEarly' ? 'Very early' :
                     tier === 'veryLate' ? 'Very late' :
                     tier[0].toUpperCase() + tier.slice(1)}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1.5}
                    step={0.05}
                    value={scoringSettings.multipliers[tier]}
                    onChange={(e) => setScoringSettings((s) => ({
                      ...s,
                      multipliers: { ...s.multipliers, [tier]: Number(e.target.value) },
                    }))}
                    className="flex-1 accent-emerald-500"
                  />
                  <span className="w-10 text-right font-mono text-gray-500 tabular-nums">
                    {scoringSettings.multipliers[tier].toFixed(2)}×
                  </span>
                </div>
              ))}
            </div>
            <button
              onClick={() => setScoringSettings(DEFAULT_SCORING_SETTINGS)}
              className="w-full mt-2 px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-[10px]"
              title="Restore targets + multipliers to defaults"
            >
              ↺ Reset scoring defaults
            </button>
            {/* Battle mode debuffs — gimmick visual effects layered on the
                runway. Nested here rather than in 3D View because they're
                scoring/gameplay modifiers a chart can throw at the player. */}
            <details className="group mt-2 pt-2 border-t border-gray-800">
              <summary className="cursor-pointer text-[11px] text-red-400 hover:text-red-300 select-none flex items-center justify-between py-1 px-2 bg-gray-900 border border-gray-800 rounded">
                <span>⚔ Battle mode debuffs</span>
                <span className="text-[10px] text-gray-600 group-open:rotate-90 transition-transform">▶</span>
              </summary>
              <div className="pt-2">
                <p className="text-[10px] text-gray-600 leading-snug mb-2">
                  Gimmick visual effects to throw at the player. Stack freely.
                </p>
                <label className="flex items-center gap-2 cursor-pointer select-none mb-1">
                  <input
                    type="checkbox"
                    checked={view3d.battleReverseScroll}
                    onChange={(e) => setView3d((v) => ({ ...v, battleReverseScroll: e.target.checked }))}
                    className="h-3.5 w-3.5 rounded border-gray-600 bg-gray-900 accent-red-500 cursor-pointer"
                  />
                  <span className="text-[11px] text-gray-300">Reverse scroll</span>
                  <span className="text-[10px] text-gray-500 ml-auto" title="Highway texture flows AWAY from the camera instead of toward it. Disorienting on purpose.">
                    {view3d.battleReverseScroll ? 'on' : 'off'}
                  </span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={view3d.battleInkSplatter}
                    onChange={(e) => setView3d((v) => ({ ...v, battleInkSplatter: e.target.checked }))}
                    className="h-3.5 w-3.5 rounded border-gray-600 bg-gray-900 accent-red-500 cursor-pointer"
                  />
                  <span className="text-[11px] text-gray-300">Ink splatter</span>
                  <span className="text-[10px] text-gray-500 ml-auto" title="Jet-black highway, no lane separators, all gems become glossy black.">
                    {view3d.battleInkSplatter ? 'on' : 'off'}
                  </span>
                </label>
              </div>
            </details>
          </CollapsibleSection>

          <CollapsibleSection id="snap" title="Snap to grid">
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
          </CollapsibleSection>

          <CollapsibleSection
            id="scroll-speed"
            title="Scroll speed"
            right={<span className="text-[11px] font-mono text-gray-500 tabular-nums">{scrollSpeed} px/s</span>}
          >
            <input
              type="range"
              min={150}
              max={1200}
              step={25}
              value={scrollSpeed}
              onChange={(e) => setScrollSpeed(Number(e.target.value))}
              className="w-full accent-jam-500"
            />
          </CollapsibleSection>

          <CollapsibleSection
            id="view3d"
            title="3D view"
            right={
              <label className="flex items-center gap-1 text-[11px] text-gray-400">
                <input
                  type="checkbox"
                  checked={view3d.enabled}
                  onChange={(e) => setView3d((v) => ({ ...v, enabled: e.target.checked }))}
                  className="accent-emerald-500"
                />
                enabled
              </label>
            }
          >
            {view3d.enabled ? (
              <details className="group">
                <summary className="cursor-pointer text-[11px] text-gray-400 hover:text-gray-200 select-none flex items-center justify-between py-1 px-2 bg-gray-900 border border-gray-800 rounded mb-2">
                  <span>⚙ Camera / mesh / scene settings</span>
                  <span className="text-[10px] text-gray-600 group-open:rotate-90 transition-transform">▶</span>
                </summary>
                <p className="text-[10px] text-gray-600 leading-snug mb-2">
                  Tilts the runway with CSS perspective for an in-game preview. Note editing is off in this mode — toggle off to author.
                </p>
                {[
                  { key: 'angleDeg',      label: 'Tilt angle',         unit: '°',   min: 0,    max: 80,   step: 1   },
                  { key: 'perspectivePx', label: 'Perspective',        unit: 'px',  min: 400,  max: 2400, step: 50  },
                  { key: 'depthPx',       label: 'Camera distance',    unit: 'px',  min: -300, max: 300,  step: 5   },
                  { key: 'liftPx',        label: 'Strike line down',   unit: 'px',  min: -200, max: 400,  step: 5   },
                ].map(({ key, label, unit, min, max, step }) => {
                  const k = key as 'angleDeg' | 'perspectivePx' | 'depthPx' | 'liftPx'
                  return (
                    <div key={key} className="mb-1.5">
                      <div className="flex items-baseline justify-between">
                        <span className="text-[10px] text-gray-500">{label}</span>
                        <span className="text-[10px] font-mono text-gray-500 tabular-nums">{view3d[k]}{unit}</span>
                      </div>
                      <input
                        type="range"
                        min={min}
                        max={max}
                        step={step}
                        value={view3d[k]}
                        onChange={(e) => setView3d((v) => ({ ...v, [k]: Number(e.target.value) }))}
                        className="w-full accent-emerald-500"
                      />
                    </div>
                  )
                })}
                <div className="mb-1.5">
                  <div className="flex items-baseline justify-between">
                    <span className="text-[10px] text-gray-500">Horizon fade</span>
                    <span className="text-[10px] font-mono text-gray-500 tabular-nums">{view3d.horizonFade.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={view3d.horizonFade}
                    onChange={(e) => setView3d((v) => ({ ...v, horizonFade: Number(e.target.value) }))}
                    className="w-full accent-emerald-500"
                  />
                </div>
                <div className="pt-2 mt-2 border-t border-gray-800">
                  <span className="text-[10px] uppercase tracking-wider text-gray-500 block mb-1">Gem mesh</span>
                  <select
                    value={view3d.meshName}
                    onChange={(e) => setView3d((v) => ({ ...v, meshName: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200 font-mono"
                  >
                    <option value="">(2D circles)</option>
                    {gemMeshes.map((m) => (
                      <option key={m.name} value={m.name}>{m.stem}</option>
                    ))}
                  </select>
                  {gemMeshes.length === 0 && (
                    <p className="text-[10px] text-gray-600 mt-1 leading-snug">
                      No gem meshes found. Check the Unity project path in <span className="font-mono">JAMSESHQUEST_GEMS_DIR</span>.
                    </p>
                  )}
                  {view3d.meshName && (
                    <>
                      <div className="mt-2">
                        <div className="flex items-baseline justify-between">
                          <span className="text-[10px] text-gray-500">Gem size</span>
                          <span className="text-[10px] font-mono text-gray-500 tabular-nums">{view3d.meshScale.toFixed(2)}×</span>
                        </div>
                        <input
                          type="range"
                          min={0.3}
                          max={2.5}
                          step={0.05}
                          value={view3d.meshScale}
                          onChange={(e) => setView3d((v) => ({ ...v, meshScale: Number(e.target.value) }))}
                          className="w-full accent-emerald-500"
                        />
                      </div>
                      <div className="mt-1">
                        <div className="flex items-baseline justify-between">
                          <span className="text-[10px] text-gray-500">Spin speed</span>
                          <span className="text-[10px] font-mono text-gray-500 tabular-nums">{view3d.meshSpinDegPerSec}°/s</span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={360}
                          step={5}
                          value={view3d.meshSpinDegPerSec}
                          onChange={(e) => setView3d((v) => ({ ...v, meshSpinDegPerSec: Number(e.target.value) }))}
                          className="w-full accent-emerald-500"
                        />
                      </div>
                      <div className="mt-1">
                        <div className="flex items-baseline justify-between">
                          <span className="text-[10px] text-gray-500">Explosion size</span>
                          <span className="text-[10px] font-mono text-gray-500 tabular-nums">{view3d.explosionScale.toFixed(2)}×</span>
                        </div>
                        <input
                          type="range"
                          min={0.1}
                          max={2.0}
                          step={0.05}
                          value={view3d.explosionScale}
                          onChange={(e) => setView3d((v) => ({ ...v, explosionScale: Number(e.target.value) }))}
                          className="w-full accent-emerald-500"
                          title="Multiplier for the shard cluster size at hit time. <1.0 shrinks the burst."
                        />
                      </div>
                      <div className="mt-1">
                        <div className="flex items-baseline justify-between">
                          <span className="text-[10px] text-gray-500">Ghost rest height</span>
                          <span className="text-[10px] font-mono text-gray-500 tabular-nums">{view3d.ghostRestY.toFixed(2)}×</span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={4}
                          step={0.05}
                          value={view3d.ghostRestY}
                          onChange={(e) => setView3d((v) => ({ ...v, ghostRestY: Number(e.target.value) }))}
                          className="w-full accent-emerald-500"
                          title="Resting Y position of the ghost gems above the runway plane (× baseGemSize)"
                        />
                      </div>
                      <div className="mt-1">
                        <div className="flex items-baseline justify-between">
                          <span className="text-[10px] text-gray-500">Ghost drop range</span>
                          <span className="text-[10px] font-mono text-gray-500 tabular-nums">{view3d.ghostDropRange.toFixed(2)}×</span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={3}
                          step={0.05}
                          value={view3d.ghostDropRange}
                          onChange={(e) => setView3d((v) => ({ ...v, ghostDropRange: Number(e.target.value) }))}
                          className="w-full accent-emerald-500"
                          title="How far the ghost gem falls when the fret is pressed (× baseGemSize). Pressed Y = rest − drop range."
                        />
                      </div>
                    </>
                  )}
                </div>
                <div className="pt-2 mt-2 border-t border-gray-800">
                  <span className="text-[10px] uppercase tracking-wider text-gray-500 block mb-1">Highway texture</span>
                  <select
                    value={view3d.highwayTexture}
                    onChange={(e) => setView3d((v) => ({ ...v, highwayTexture: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200 font-mono"
                  >
                    <option value="">(none — dark plane)</option>
                    {highwayTextures.map((t) => (
                      <option key={t.name} value={t.name}>{t.stem}</option>
                    ))}
                  </select>
                  {highwayTextures.length === 0 && (
                    <p className="text-[10px] text-gray-600 mt-1 leading-snug">
                      No textures found. Check the path in <span className="font-mono">JAMSESHQUEST_HIGHWAYS_DIR</span>.
                    </p>
                  )}
                  <label className="mt-1 flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={view3d.highwayScroll}
                      onChange={(e) => setView3d((v) => ({ ...v, highwayScroll: e.target.checked }))}
                      className="h-3.5 w-3.5 rounded border-gray-600 bg-gray-900 accent-emerald-500 cursor-pointer"
                    />
                    <span className="text-[11px] text-gray-300">Scroll with gems</span>
                    <span className="text-[10px] text-gray-500 ml-auto" title="Animates the texture's V offset so the highway flows toward the camera at the same rate as falling gems.">
                      {view3d.highwayScroll ? 'on' : 'off'}
                    </span>
                  </label>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-[10px] text-gray-500">Tint</span>
                    <input
                      type="color"
                      value={view3d.highwayTint}
                      onChange={(e) => setView3d((v) => ({ ...v, highwayTint: e.target.value.toUpperCase() }))}
                      className="h-6 w-10 bg-gray-900 border border-gray-700 rounded cursor-pointer"
                    />
                    <input
                      type="text"
                      value={view3d.highwayTint}
                      onChange={(e) => setView3d((v) => ({ ...v, highwayTint: e.target.value }))}
                      className="flex-1 bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] font-mono text-gray-200"
                    />
                  </div>
                  <div className="mt-1">
                    <div className="flex items-baseline justify-between">
                      <span className="text-[10px] text-gray-500">Tint opacity</span>
                      <span className="text-[10px] font-mono text-gray-500 tabular-nums">{view3d.highwayTintOpacity.toFixed(2)}</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={view3d.highwayTintOpacity}
                      onChange={(e) => setView3d((v) => ({ ...v, highwayTintOpacity: Number(e.target.value) }))}
                      className="w-full accent-emerald-500"
                    />
                  </div>
                </div>
                <div className="pt-2 mt-2 border-t border-gray-800">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] uppercase tracking-wider text-gray-500">Lane separators</span>
                    <label className="flex items-center gap-1 text-[10px] text-gray-400">
                      <input
                        type="checkbox"
                        checked={view3d.laneSeparators}
                        onChange={(e) => setView3d((v) => ({ ...v, laneSeparators: e.target.checked }))}
                        className="accent-emerald-500"
                      />
                      on
                    </label>
                  </div>
                  {view3d.laneSeparators && (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-gray-500 w-10">Colour</span>
                        <input
                          type="color"
                          value={view3d.laneSeparatorColor}
                          onChange={(e) => setView3d((v) => ({ ...v, laneSeparatorColor: e.target.value.toUpperCase() }))}
                          className="h-6 w-10 bg-gray-900 border border-gray-700 rounded cursor-pointer"
                        />
                        <input
                          type="text"
                          value={view3d.laneSeparatorColor}
                          onChange={(e) => setView3d((v) => ({ ...v, laneSeparatorColor: e.target.value }))}
                          className="flex-1 bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] font-mono text-gray-200"
                        />
                      </div>
                      <div className="mt-1">
                        <div className="flex items-baseline justify-between">
                          <span className="text-[10px] text-gray-500">Width</span>
                          <span className="text-[10px] font-mono text-gray-500 tabular-nums">{(view3d.laneSeparatorWidth * 1000).toFixed(0)}px</span>
                        </div>
                        <input
                          type="range"
                          min={0.005}
                          max={0.15}
                          step={0.005}
                          value={view3d.laneSeparatorWidth}
                          onChange={(e) => setView3d((v) => ({ ...v, laneSeparatorWidth: Number(e.target.value) }))}
                          className="w-full accent-emerald-500"
                          title="Stripe thickness in world units (×1000 ≈ pixels at default zoom)."
                        />
                      </div>
                      <div className="mt-1">
                        <div className="flex items-baseline justify-between">
                          <span className="text-[10px] text-gray-500">Outer glow</span>
                          <span className="text-[10px] font-mono text-gray-500 tabular-nums">{view3d.laneSeparatorGlow.toFixed(2)}</span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={view3d.laneSeparatorGlow}
                          onChange={(e) => setView3d((v) => ({ ...v, laneSeparatorGlow: Number(e.target.value) }))}
                          className="w-full accent-emerald-500"
                          title="Halo opacity (×4 wider than the main stripe) for a soft outer glow."
                        />
                      </div>
                    </>
                  )}
                </div>
                <button
                  onClick={() => setView3d({ ...VIEW3D_DEFAULT, enabled: true })}
                  className="w-full mt-2 px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-[10px]"
                  title="Reset all sliders to their defaults"
                >
                  ↺ Reset 3D defaults
                </button>
              </details>
            ) : (
              <p className="text-[11px] text-gray-600 leading-snug">
                Off — flat 2D authoring view. Turn on for an in-game preview with tunable angle, perspective, and horizon fade.
              </p>
            )}
          </CollapsibleSection>

          <CollapsibleSection id="shortcuts" title="Shortcuts" defaultOpen={false}>
            <p className="text-[10px] text-gray-500 leading-snug">
              <span className="font-mono text-gray-300">Click</span> select ·
              <span className="font-mono text-gray-300"> Drag</span> move ·
              <span className="font-mono text-gray-300"> ←/→</span> nudge tick ·
              <span className="font-mono text-gray-300"> ↑/↓</span> lane ·
              <span className="font-mono text-gray-300"> H</span> hold ·
              <span className="font-mono text-gray-300"> Del</span> delete ·
              <span className="font-mono text-gray-300"> Space</span> play
            </p>
          </CollapsibleSection>

          <CollapsibleSection id="generate" title="Generate" defaultOpen={false}>
            <GenerateTab trackId={trackId} />
          </CollapsibleSection>
        </aside>

        <div
          className="flex-1 flex justify-center bg-black min-w-0 px-4 overflow-hidden relative"
          style={view3d.enabled ? { perspective: `${view3d.perspectivePx}px`, perspectiveOrigin: '50% 100%' } : undefined}
        >
          {/* Background video layer — sits behind the canvas wrapper. YouTube
              iframes can't be muted reliably via the API on every browser, so
              we lean on the URL params (mute=1) AND set the muted property
              via the <video> attribute for uploaded files. */}
          {bgKind !== 'none' && (
            <BackgroundLayer
              kind={bgKind}
              ytId={ytId}
              videoUrl={bgKind === 'video' && bgValue ? `/api/tracks/${trackId}/background-video?v=${encodeURIComponent(bgValue)}` : ''}
              currentTime={currentTime}
              playing={playing}
            />
          )}
          <div
            ref={containerRef}
            // In 3D + mesh mode the runway is rendered by Three.js with real
            // perspective, and the near-edge of the floor spreads outward
            // wider than the 660-px authoring cap. Drop the cap there so the
            // canvas fills the whole centre column and the runway doesn't
            // get clipped at the sidebar boundaries.
            className={`relative w-full z-10 ${view3d.enabled && view3d.meshName ? '' : 'max-w-[660px]'}`}
            style={view3d.enabled ? { transformStyle: 'preserve-3d' } : undefined}
          >
            <canvas
              ref={canvasRef}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              onWheel={handleWheel}
              className="absolute inset-0 w-full h-full cursor-crosshair"
              style={
                // True-3D mesh mode renders the runway entirely in three.js,
                // so hide the 2D layer to stop it from showing a redundant
                // (and possibly mis-aligned) tilted runway behind the gems.
                view3d.enabled && view3d.meshName
                  ? { display: 'none' }
                  : view3d.enabled
                    ? {
                        transform: `translateY(${view3d.liftPx}px) translateZ(${view3d.depthPx}px) rotateX(${view3d.angleDeg}deg)`,
                        transformOrigin: '50% 100%',
                        transition: 'transform 120ms ease-out',
                      }
                    : undefined
              }
            />
            {/* Horizon fade — gradient from black at top (far) to transparent
                near the strike line, so distant notes recede instead of
                fighting the foreground for attention. Sits above the canvas
                but below the badge / error toast. */}
            {view3d.enabled && view3d.horizonFade > 0 && (
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  background: `linear-gradient(to bottom, rgba(0,0,0,${view3d.horizonFade}) 0%, rgba(0,0,0,0) 55%)`,
                  transform: `translateY(${view3d.liftPx}px) translateZ(${view3d.depthPx}px) rotateX(${view3d.angleDeg}deg)`,
                  transformOrigin: '50% 100%',
                }}
              />
            )}
            {view3d.enabled && view3d.meshName && chart && (
              <GemMeshLayer
                ref={gemMeshLayerRef}
                meshUrl={`/api/gem-meshes/${encodeURIComponent(view3d.meshName)}`}
                explosionUrl="/api/gem-meshes/GemExplosion.fbx"
                notes={chart.notes}
                tempoSegments={tempoSegments}
                resolution={chart.resolution}
                currentTime={currentTime}
                scrollSpeed={scrollSpeed}
                canvasW={canvasSize.w}
                canvasH={canvasSize.h}
                scale={view3d.meshScale}
                spinDegPerSec={view3d.meshSpinDegPerSec}
                explosionScale={view3d.explosionScale}
                angleDeg={view3d.angleDeg}
                perspectivePx={view3d.perspectivePx}
                ghostRestY={view3d.ghostRestY}
                ghostDropRange={view3d.ghostDropRange}
                depthPx={view3d.depthPx}
                liftPx={view3d.liftPx}
                highwayTextureUrl={view3d.highwayTexture ? `/api/highway-textures/${encodeURIComponent(view3d.highwayTexture)}` : ''}
                highwayScroll={view3d.highwayScroll}
                highwayTint={view3d.highwayTint}
                highwayTintOpacity={view3d.highwayTintOpacity}
                laneSeparators={view3d.laneSeparators}
                laneSeparatorColor={view3d.laneSeparatorColor}
                laneSeparatorWidth={view3d.laneSeparatorWidth}
                laneSeparatorGlow={view3d.laneSeparatorGlow}
                battleReverseScroll={view3d.battleReverseScroll}
                battleInkSplatter={view3d.battleInkSplatter}
                heldFretsRef={heldFretsRef}
              />
            )}
            {view3d.enabled && (
              <div className="absolute top-3 right-3 bg-emerald-900/80 border border-emerald-700 text-emerald-100 text-[10px] font-mono px-2 py-0.5 rounded pointer-events-none uppercase tracking-wider">
                3D preview · editing off
              </div>
            )}
            {/* Floating fullscreen-highway toggle. Lives at the canvas's
                bottom-right so it stays clear of the score/streak HUD at the
                top. Esc also exits. */}
            <button
              onClick={() => setMaxHighway((v) => !v)}
              className={`absolute bottom-3 right-3 z-20 px-2 py-1 rounded text-[10px] font-mono uppercase tracking-wider transition-colors ${
                maxHighway
                  ? 'bg-gray-900/70 hover:bg-gray-800 text-gray-300 border border-gray-700'
                  : 'bg-gray-900/70 hover:bg-gray-800 text-gray-300 border border-gray-800'
              }`}
              title={maxHighway ? 'Exit highway-only view (Esc)' : 'Hide sidebars + top bar — maximise the highway'}
            >
              {maxHighway ? '↙ Exit' : '⛶ Max'}
            </button>
            {/* Compact transport — only shown when sidebars are hidden so the
                user can still play / pause / scrub / seek without restoring
                the chrome. Mirrors the sidebar's transport row, scaled for an
                overlay. */}
            {maxHighway && (
              <div className="absolute bottom-3 left-3 z-20 flex items-center gap-1 bg-gray-900/75 backdrop-blur-sm border border-gray-700 rounded px-2 py-1">
                <button
                  onClick={() => seekSeconds(0)}
                  className="w-7 h-7 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 flex items-center justify-center text-xs"
                  title="Rewind to start"
                >
                  ⏮
                </button>
                <button
                  onClick={() => {
                    if (!chart) return
                    const stepTicks = Math.max(1, Math.round(chart.resolution / snapDivisor))
                    const curTick = secToTick(tempoSegments, chart.resolution, currentTime)
                    const newTick = Math.max(0, curTick - stepTicks)
                    seekSeconds(tickToSec(tempoSegments, chart.resolution, newTick))
                  }}
                  disabled={!chart}
                  className="w-7 h-7 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-gray-200 flex items-center justify-center text-[10px] font-mono"
                  title="Back one snap unit"
                >
                  −
                </button>
                <button
                  onClick={togglePlay}
                  className="w-9 h-9 rounded-full bg-jam-600 hover:bg-jam-500 text-white flex items-center justify-center text-sm"
                  title={playing ? 'Pause (Space)' : 'Play (Space)'}
                >
                  {playing ? '❚❚' : '▶'}
                </button>
                <button
                  onClick={() => {
                    if (!chart) return
                    const stepTicks = Math.max(1, Math.round(chart.resolution / snapDivisor))
                    const curTick = secToTick(tempoSegments, chart.resolution, currentTime)
                    const newTick = curTick + stepTicks
                    const newSec = tickToSec(tempoSegments, chart.resolution, newTick)
                    seekSeconds(duration > 0 ? Math.min(duration, newSec) : newSec)
                  }}
                  disabled={!chart}
                  className="w-7 h-7 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-gray-200 flex items-center justify-center text-[10px] font-mono"
                  title="Forward one snap unit"
                >
                  +
                </button>
                <button
                  onClick={() => seekSeconds(duration || 0)}
                  disabled={!duration}
                  className="w-7 h-7 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-gray-200 flex items-center justify-center text-xs"
                  title="Skip to end"
                >
                  ⏭
                </button>
                <span className="ml-1 text-[11px] font-mono text-gray-300 tabular-nums">
                  {Math.floor(currentTime / 60)}:{Math.floor(currentTime % 60).toString().padStart(2, '0')}
                  <span className="text-gray-600"> / </span>
                  {Math.floor(duration / 60)}:{Math.floor(duration % 60).toString().padStart(2, '0')}
                </span>
                <input
                  type="range"
                  min={0}
                  max={duration || 0}
                  step={0.05}
                  value={currentTime}
                  onChange={(e) => seekSeconds(Number(e.target.value))}
                  className="w-40 ml-2 accent-jam-500"
                  title="Scrub"
                />
              </div>
            )}
            {/* Live-play HUD — streak (top-left) + score (top-right). Shown
                whenever Live mode is selected so the user can see scoring
                state even when paused; the values reset when playback
                rewinds to the start. */}
            {playMode === 'live' && (
              <>
                <div className="absolute top-3 left-3 pointer-events-none flex flex-col items-start">
                  <span className="uppercase tracking-wider text-gray-400 font-mono" style={{ fontSize: 50 }}>Streak</span>
                  <span
                    className={`font-bold font-mono leading-none ${
                      streak >= 50 ? 'text-fuchsia-300' :
                      streak >= 25 ? 'text-amber-300' :
                      streak >= 10 ? 'text-cyan-300' :
                      'text-white'
                    }`}
                    style={{ fontSize: 150, textShadow: '0 0 24px rgba(0,0,0,0.95)' }}
                  >
                    {streak}
                  </span>
                  {maxStreak > 0 && (
                    <span className="text-gray-500 font-mono" style={{ fontSize: 50 }}>best · {maxStreak}</span>
                  )}
                  {lastTier && (
                    <span
                      className={`font-bold font-mono mt-2 ${
                        lastTier === 'perfect' ? 'text-emerald-300' :
                        lastTier === 'early' || lastTier === 'late' ? 'text-cyan-300' :
                        lastTier === 'veryEarly' || lastTier === 'veryLate' ? 'text-amber-400' :
                        lastTier === 'miss' ? 'text-red-400' :
                        lastTier === 'frets' ? 'text-orange-400' :
                        'text-gray-400'
                      }`}
                      style={{ fontSize: 60, textShadow: '0 0 20px rgba(0,0,0,0.95)' }}
                      title={
                        lastTier === 'frets' ? 'A note was within timing window but the held fret combo didn\'t match.'
                        : lastTier === 'empty' ? 'No note within the timing window when you strummed.'
                        : undefined
                      }
                    >
                      {lastTier === 'perfect' ? 'PERFECT'
                        : lastTier === 'early' ? 'EARLY'
                        : lastTier === 'late' ? 'LATE'
                        : lastTier === 'veryEarly' ? 'VERY EARLY'
                        : lastTier === 'veryLate' ? 'VERY LATE'
                        : lastTier === 'miss' ? 'MISS'
                        : lastTier === 'frets' ? 'WRONG FRETS'
                        : 'NO NOTE'}
                    </span>
                  )}
                </div>
                <div className="absolute top-3 right-3 pointer-events-none flex flex-col items-end" style={{ marginTop: view3d.enabled ? 24 : 0 }}>
                  <span className="uppercase tracking-wider text-gray-400 font-mono" style={{ fontSize: 50 }}>Score</span>
                  <span
                    className="font-bold font-mono leading-none text-white tabular-nums"
                    style={{ fontSize: 150, textShadow: '0 0 24px rgba(0,0,0,0.95)' }}
                  >
                    {score.toLocaleString()}
                  </span>
                  <span className="text-gray-500 font-mono" style={{ fontSize: 50 }}>
                    {pointsPerPerfectHit.toLocaleString()} / perfect
                  </span>
                </div>
              </>
            )}
            {ruleError && (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-red-900/90 border border-red-700 text-red-100 text-[12px] font-medium px-3 py-1.5 rounded shadow-lg pointer-events-none max-w-[90%] text-center">
                ⚠ {ruleError}
              </div>
            )}
          </div>
        </div>

        <aside className={`${maxHighway ? 'hidden' : ''} w-80 shrink-0 border-l border-gray-800 bg-gray-950 overflow-y-auto p-4 space-y-5`}>
          <CollapsibleSection
            id="background"
            title="Background"
            right={
              bgKind !== 'none' && (
                <span className="text-[10px] text-emerald-400 font-mono">
                  {bgKind === 'youtube' ? 'YouTube' : 'video'}
                </span>
              )
            }
          >
            {!bgLoaded ? (
              <p className="text-[10px] text-gray-600">loading…</p>
            ) : (
              <>
                <p className="text-[10px] text-gray-600 leading-snug mb-2">
                  Plays a muted video behind the highway. YouTube embeds + uploaded files both supported.
                </p>
                <div className="grid grid-cols-3 gap-1 mb-2">
                  {(['none', 'youtube', 'video'] as const).map((k) => (
                    <button
                      key={k}
                      onClick={() => setBgKind(k)}
                      className={`px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                        bgKind === k
                          ? 'bg-emerald-700/60 text-white border border-emerald-500/60'
                          : 'bg-gray-800 hover:bg-gray-700 text-gray-300 border border-transparent'
                      }`}
                    >
                      {k === 'none' ? 'Off' : k === 'youtube' ? 'YouTube' : 'Upload'}
                    </button>
                  ))}
                </div>
                {bgKind === 'youtube' && (
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-1">YouTube URL</label>
                    <input
                      type="text"
                      value={bgValue}
                      onChange={(e) => setBgValue(e.target.value)}
                      placeholder="https://www.youtube.com/watch?v=…"
                      className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] font-mono text-gray-200"
                    />
                    {bgSourceUrl && bgSourceUrl !== bgValue && (
                      <button
                        onClick={() => setBgValue(bgSourceUrl)}
                        className="mt-1 text-[10px] text-emerald-400 hover:text-emerald-300 underline"
                        title={bgSourceUrl}
                      >
                        ↺ use source video ({bgSourceUrl.slice(0, 40)}…)
                      </button>
                    )}
                    {ytId && (
                      <p className="text-[10px] text-gray-600 mt-1 font-mono truncate">id: {ytId}</p>
                    )}
                  </div>
                )}
                {bgKind === 'video' && (
                  <div className="space-y-1">
                    <label className="block text-[10px] text-gray-500">Uploaded file</label>
                    <span className="block text-[11px] font-mono text-gray-300 truncate">
                      {bgValue || '— none —'}
                    </span>
                    <div className="flex items-center gap-1">
                      <label className="flex-1 px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-[10px] cursor-pointer text-center">
                        {bgValue ? 'Replace' : 'Upload video'}
                        <input
                          type="file"
                          accept="video/mp4,video/webm,video/quicktime,video/x-m4v,video/ogg,.mp4,.webm,.mov,.m4v,.ogv"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0]
                            if (f) uploadBackgroundVideo(f)
                            e.target.value = ''
                          }}
                        />
                      </label>
                      {bgValue && (
                        <button
                          onClick={async () => {
                            await fetch(`/api/tracks/${trackId}/background-video`, { method: 'DELETE' })
                            setBgValue('')
                          }}
                          className="px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-500 rounded text-[10px]"
                          title="Remove uploaded video"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                )}
                <button
                  onClick={saveBackground}
                  disabled={!bgDirty}
                  className={`w-full mt-2 px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                    bgDirty
                      ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                      : 'bg-gray-800 text-gray-500 cursor-default'
                  }`}
                  title="Persist the background config to song.ini"
                >
                  {bgDirty ? '✓ Save background' : 'Saved'}
                </button>
              </>
            )}
          </CollapsibleSection>

          <CollapsibleSection
            id="sections"
            title="Sections"
            right={
              <button
                onClick={addSectionAtPlayhead}
                disabled={!chart}
                className="text-[10px] px-1.5 py-0.5 bg-pink-700/40 hover:bg-pink-600/60 disabled:opacity-30 border border-pink-700/40 hover:border-pink-500 text-pink-200 hover:text-pink-100 rounded transition-colors"
                title="Add a section marker at the playhead"
              >
                + Add at playhead
              </button>
            }
          >
            {(!chart || chart.sections.length === 0) ? (
              <p className="text-[11px] text-gray-600">No section markers. Sections appear as labelled rules on the runway.</p>
            ) : (
              <ul className="space-y-1 max-h-44 overflow-y-auto">
                {chart.sections.map((sec) => (
                  <li key={sec.id} className="flex items-center gap-1">
                    <button
                      onClick={() => {
                        if (!audioRef.current || !chart) return
                        const sec_t = tickToSec(tempoSegments, chart.resolution, sec.tick)
                        audioRef.current.currentTime = sec_t
                        setCurrentTime(sec_t)
                      }}
                      className="shrink-0 px-1.5 py-1 bg-gray-800 hover:bg-gray-700 text-pink-200 rounded text-[10px] font-mono transition-colors"
                      title="Jump to this section"
                    >
                      ↶
                    </button>
                    <input
                      type="text"
                      value={sec.name}
                      onChange={(e) => updateSections((prev) =>
                        prev.map((s) => s.id === sec.id ? { ...s, name: e.target.value } : s),
                      )}
                      className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-gray-200 focus:outline-none focus:border-pink-500"
                    />
                    <button
                      onClick={() => updateSections((prev) => prev.filter((s) => s.id !== sec.id))}
                      className="shrink-0 px-1.5 py-1 bg-red-900/30 hover:bg-red-800/60 border border-red-800/40 hover:border-red-700 text-red-300 hover:text-red-200 rounded text-[10px] transition-colors"
                      title="Delete section"
                      aria-label="Delete section"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CollapsibleSection>

          <CollapsibleSection
            id="tempo-map"
            title="Tempo map"
            right={
              <button
                onClick={addTempoMarkerAtPlayhead}
                disabled={!chart}
                className="text-[10px] px-1.5 py-0.5 bg-amber-700/40 hover:bg-amber-600/60 disabled:opacity-30 border border-amber-700/40 hover:border-amber-500 text-amber-200 hover:text-amber-100 rounded transition-colors"
                title="Add a tempo change at the playhead"
              >
                + Add at playhead
              </button>
            }
          >
            {!chart ? null : (
              <ul className="space-y-1 max-h-44 overflow-y-auto">
                {chart.tempoMarkers.map((m, idx) => (
                  <li key={`${idx}-${m.tick}`} className="flex items-center gap-1">
                    <button
                      onClick={() => {
                        if (!audioRef.current || !chart) return
                        const sec_t = tickToSec(tempoSegments, chart.resolution, m.tick)
                        audioRef.current.currentTime = sec_t
                        setCurrentTime(sec_t)
                      }}
                      className="shrink-0 px-1.5 py-1 bg-gray-800 hover:bg-gray-700 text-amber-200 rounded text-[10px] font-mono transition-colors"
                      title="Jump to this tempo change"
                    >
                      ↶
                    </button>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={m.tick}
                      disabled={idx === 0}
                      onChange={(e) => updateTempoMarkerTick(idx, Number(e.target.value))}
                      className="w-16 bg-gray-800 border border-gray-700 rounded px-1 py-1 text-[10px] font-mono text-gray-300 disabled:opacity-50 focus:outline-none focus:border-amber-500"
                      title={idx === 0 ? 'The song-origin marker is locked at tick 0' : 'Tick'}
                    />
                    <input
                      type="number"
                      min={1}
                      step={0.001}
                      value={Number((m.microBpm / 1000).toFixed(3))}
                      onChange={(e) => updateTempoMarkerBpm(idx, Number(e.target.value))}
                      className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[11px] font-mono text-gray-200 focus:outline-none focus:border-amber-500"
                      title="BPM"
                    />
                    <span className="text-[10px] text-gray-500 font-mono shrink-0">bpm</span>
                    <button
                      onClick={() => deleteTempoMarker(idx)}
                      disabled={idx === 0}
                      className="shrink-0 px-1.5 py-1 bg-red-900/30 hover:bg-red-800/60 disabled:opacity-20 border border-red-800/40 hover:border-red-700 text-red-300 hover:text-red-200 rounded text-[10px] transition-colors"
                      title={idx === 0 ? 'The origin tempo can\'t be deleted' : 'Delete tempo change'}
                      aria-label="Delete tempo marker"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[10px] text-gray-600 mt-1.5 leading-snug">
              First marker fixed at tick 0. Tempo changes phase-lock everything
              downstream — notes, VOs, click track, timeline strips.
            </p>
          </CollapsibleSection>

          {chart && (() => {
            // Pack/scale picker — drives the default for newly-dropped real-
            // notes (Real-note tool, R keyboard shortcut). Per-note overrides
            // live in the selected-note dropdown above.
            // Tally how many distinct (pack, scale) combos the chart actually
            // uses, just so the user can see the scope of what'll ship in the
            // published realnotes/ folder.
            const usedCombos = new Set<string>()
            for (const n of chart.notes) {
              if (n.type === 'real' && n.pack && n.scale) usedCombos.add(`${n.pack}/${n.scale}`)
            }
            return (
              <CollapsibleSection
                id="sound-packs"
                title="Sound pack"
                right={usedCombos.size > 0 ? (
                  <span className="text-[10px] text-cyan-300 font-mono">
                    {usedCombos.size} combo{usedCombos.size === 1 ? '' : 's'} in chart
                  </span>
                ) : undefined}
              >
                <p className="text-[10px] text-gray-600 mb-2 leading-snug">
                  New real-notes (Real-note tool, R key) inherit this pack/scale. Change per-note via the selected-note dropdown above.
                </p>
                {/* Guitar preview — strum the connected gamepad while the song
                    is paused to audition the picker's pack/scale. Held frets
                    resolve to single-lane / chord / open samples the same way
                    the chart does on real-notes. */}
                <label className="flex items-center gap-2 mb-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={guitarPreview}
                    onChange={(e) => setGuitarPreview(e.target.checked)}
                    disabled={!realNotesReady || !gamepadId}
                    className="h-3.5 w-3.5 rounded border-gray-600 bg-gray-900 accent-cyan-500 cursor-pointer disabled:cursor-not-allowed"
                  />
                  <span className={`text-[11px] ${realNotesReady && gamepadId ? 'text-gray-300' : 'text-gray-600'}`}>
                    Preview with guitar
                  </span>
                  <span className="text-[10px] text-gray-500 ml-auto" title="Strum the connected gamepad while the song is paused to audition the picker's pack. Held frets pick the slot.">
                    {!gamepadId ? 'no device' : !realNotesReady ? 'no notes' : guitarPreview ? 'on' : 'off'}
                  </span>
                </label>

                <div className="space-y-2 p-2 bg-gray-900/50 rounded border border-gray-800">
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-1 uppercase tracking-wider">Pack</label>
                    <select
                      value={pickedPackId}
                      onChange={(e) => setPickedPackId(e.target.value)}
                      disabled={packCatalog.length === 0}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-200 focus:outline-none focus:border-cyan-500 disabled:opacity-50"
                    >
                      {packCatalog.map((p) => (
                        <option key={p.pack_id} value={p.pack_id}>{p.name} — {p.family}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-1 uppercase tracking-wider">Chord progression (scale)</label>
                    <select
                      value={pickedScaleId}
                      onChange={(e) => setPickedScaleId(e.target.value)}
                      disabled={scaleCatalog.length === 0}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-200 focus:outline-none focus:border-cyan-500 disabled:opacity-50"
                    >
                      {scaleCatalog.map((s) => (
                        <option key={s.scale_id} value={s.scale_id}>{s.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={playPackPreview}
                      disabled={!pickedPackId || !pickedScaleId}
                      className="shrink-0 px-2 py-1 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-200 rounded text-[11px]"
                      title="Audition the scale root (lane_1)"
                    >
                      {packPreviewing ? '❚❚' : '▶'} Audition
                    </button>
                  </div>
                </div>
              </CollapsibleSection>
            )
          })()}

          {chart && (
            <ImportedSourcesPanel
              rows={chart.importedSources.map((s) => ({
                id: s.id,
                name: s.name,
                spliceCount: chart.clips.filter((c) => c.sourceId === s.id).length,
                selected: s.id === activeSourceId,
              }))}
              onSelect={setActiveSourceId}
              onOpenPicker={() => setPickerOpen(true)}
              onRename={renameSource}
              onDelete={deleteSource}
              Wrapper={CollapsibleSection as any}
            />
          )}

          {chart && (
            <ClipsLibraryPanel
              clips={chart.clips.map((c) => ({
                id: c.id,
                name: c.name,
                sourceId: c.sourceId,
                sourceLabel: c.sourceId ?? '(upload)',
                startSec: c.startSec,
                endSec: c.endSec,
                notesCount: c.notesCount,
                isPlaced: chart.tutorial.some((e): e is TutorialMusicEvent => e.kind === 'music' && e.sectionName === c.sectionName),
              }))}
              selectedClipId={selectedClipId}
              onSelect={setSelectedClipId}
              onAudition={(id) => auditionClip(id)}
              onPlaceAtPlayhead={placeClipAtPlayhead}
              onRename={renameClip}
              onDelete={deleteClip}
              Wrapper={CollapsibleSection as any}
            />
          )}

          {chart && (
            <CollapsibleSection id="add-at-playhead" title="Add at playhead">
              <div className="grid grid-cols-4 gap-1 mb-1">
                <div className="relative">
                  <button
                    onClick={() => setScenePickerOpen((v) => !v)}
                    className="w-full px-1 py-1 bg-emerald-700/50 hover:bg-emerald-600/60 border border-emerald-700/60 text-emerald-100 rounded text-[11px] font-medium transition-colors"
                    title={`Add a scene event at the playhead (tick ${playheadTick})`}
                  >
                    + Scene
                  </button>
                  {scenePickerOpen && (
                    <ScenePicker
                      catalog={mergedSceneCatalog}
                      onPick={addSceneEvent}
                      onClose={() => setScenePickerOpen(false)}
                      onCreateType={() => { setScenePickerOpen(false); setTypeModalOpen(true) }}
                    />
                  )}
                </div>
                <button
                  onClick={addVo}
                  className="px-1 py-1 bg-sky-700/40 hover:bg-sky-600/60 border border-sky-700/60 text-sky-200 rounded text-[11px] font-medium transition-colors"
                  title={`Add a standalone VO at playhead (tick ${playheadTick}). VOs fire on their own tick — no STEP required.`}
                >
                  + VO
                </button>
                <button
                  onClick={addStep}
                  className="px-1 py-1 bg-purple-700/40 hover:bg-purple-600/60 border border-purple-700/60 text-purple-200 rounded text-[11px] font-medium transition-colors"
                  title={`Add a STEP pass/fail boundary at playhead (tick ${playheadTick}). Only used to gate note-hit criteria — VOs play independently.`}
                >
                  + STEP
                </button>
                <button
                  onClick={() => setMusicModal({ tick: playheadTick, difficulty: chart.activeName || 'ExpertSingle' })}
                  className="px-1 py-1 bg-orange-700/40 hover:bg-orange-600/60 border border-orange-700/60 text-orange-200 rounded text-[11px] font-medium transition-colors"
                  title={`Drop a music segment at playhead (tick ${playheadTick}) — auto-enables tutorial mode`}
                >
                  + MUSIC
                </button>
              </div>
              <p className="text-[11px] text-gray-600 mb-1">
                Adding at <span className="font-mono text-gray-400">{fmtTick(playheadTick)}</span>
              </p>
              <p className="text-[10px] text-gray-600 leading-snug mb-2">
                VOs fire on their own tick — STEPs only gate note pass/fail. Drop VOs anywhere; you don't need a STEP first.
              </p>
              <button
                onClick={() => { setStudioImportOpen(true); setStudioImportError(''); setStudioImportStatus('') }}
                className="w-full px-2 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-jam-600 text-gray-200 rounded text-[11px] font-medium transition-colors"
                title="Upload VO files to the shared library or insert a previously-uploaded clip at the playhead"
              >
                ↓ VO library (upload / insert)
              </button>
            </CollapsibleSection>
          )}

          {chart && sceneSelectedId && (() => {
            const ev = chart.sceneEvents.find((e) => e.id === sceneSelectedId)
            if (!ev) return null
            const entry = findCatalogEntry(ev.name, customSceneTypes)
            const param: SceneEventParam = entry?.param ?? { type: 'duration' }
            return (
              <CollapsibleSection
                id="selected-scene-event"
                title="Selected scene event"
                right={
                  <button
                    onClick={() => removeSceneEvent(ev.id)}
                    className="text-[10px] text-red-400 hover:text-red-300"
                    title="Delete this event"
                  >
                    delete
                  </button>
                }
              >
                <p className="text-[11px] text-gray-200 font-mono truncate" title={ev.name}>{entry?.itemLabel || ev.name}</p>
                <p className="text-[10px] text-gray-600 truncate">{ev.name} · tick {ev.tick}</p>
                {entry?.description && (
                  <p className="text-[10px] text-gray-500 mt-1 leading-snug">{entry.description}</p>
                )}
                <div className="mt-2">
                  {param.type === 'duration' && (
                    <label className="block">
                      <span className="text-[10px] text-gray-500">Duration (ticks)</span>
                      <input
                        type="number"
                        min={0}
                        step={chart.resolution}
                        value={ev.duration}
                        onChange={(e) => resizeSceneEvent(ev.id, Math.max(0, Number(e.target.value) || 0))}
                        className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200 font-mono"
                      />
                    </label>
                  )}
                  {param.type === 'hex_color' && (
                    <label className="block">
                      <span className="text-[10px] text-gray-500">Colour (#RRGGBB)</span>
                      <div className="flex items-center gap-2 mt-0.5">
                        <input
                          type="color"
                          value={/^#[0-9a-fA-F]{6}$/.test(ev.value) ? ev.value : '#ffffff'}
                          onChange={(e) => setSceneEventValue(ev.id, e.target.value.toUpperCase())}
                          className="h-7 w-12 bg-gray-900 border border-gray-700 rounded cursor-pointer"
                        />
                        <input
                          type="text"
                          value={ev.value}
                          onChange={(e) => setSceneEventValue(ev.id, e.target.value.trim())}
                          placeholder="#FF8800"
                          className="flex-1 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200 font-mono"
                        />
                      </div>
                    </label>
                  )}
                  {param.type === 'number' && (
                    <label className="block">
                      <span className="text-[10px] text-gray-500">
                        Value
                        {(param.min !== undefined || param.max !== undefined) &&
                          ` (${param.min ?? '−∞'} … ${param.max ?? '+∞'})`}
                      </span>
                      <input
                        type="number"
                        min={param.min}
                        max={param.max}
                        step={param.step ?? 'any'}
                        value={ev.value}
                        onChange={(e) => setSceneEventValue(ev.id, e.target.value)}
                        className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200 font-mono"
                      />
                    </label>
                  )}
                  {param.type === 'enum' && (
                    <label className="block">
                      <span className="text-[10px] text-gray-500">Option</span>
                      <select
                        value={ev.value}
                        onChange={(e) => setSceneEventValue(ev.id, e.target.value)}
                        className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200 font-mono"
                      >
                        {param.options.map((o) => (
                          <option key={o} value={o}>{o}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {param.type === 'none' && (
                    <p className="text-[10px] text-gray-600 italic">No parameter — fires as a bare cue.</p>
                  )}
                </div>
                {!entry?.builtin && entry && (
                  <button
                    onClick={() => {
                      fetch(`/api/scene-events/types/${encodeURIComponent(ev.name)}/handover`)
                        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
                        .then((d: { handover_md: string }) => setHandoverModal({ name: ev.name, md: d.handover_md }))
                        .catch(() => undefined)
                    }}
                    className="mt-2 w-full px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-[10px]"
                    title="Re-open the engineer handover doc for this custom event type"
                  >
                    ⤓ View handover doc
                  </button>
                )}
              </CollapsibleSection>
            )
          })()}

          {chart && (
            <CollapsibleSection
              id="tutorial"
              title="Tutorial"
              right={
                <label className="flex items-center gap-1 text-[11px] text-gray-400">
                  <input
                    type="checkbox"
                    checked={chart.tutorialEnabled}
                    onChange={(e) => updateTutorial(chart.tutorial, e.target.checked)}
                    className="accent-jam-500"
                  />
                  enabled
                </label>
              }
            >
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
                  {(() => {
                    const sorted = [...chart.tutorial].sort((a, b) => a.tick - b.tick)
                    const labelFor = (ev: TutorialEvent) => {
                      const t = fmtTick(ev.tick)
                      if (ev.kind === 'vo') {
                        const txt = ev.text ? ev.text.slice(0, 36) : (ev.file ? (ev.file.split('/').pop() || 'vo') : 'vo')
                        return `${t} · VO · ${txt}`
                      }
                      if (ev.kind === 'step') return `${t} · STEP · ${ev.stepId || '(unnamed)'}`
                      return `${t} · MUSIC · ${ev.file.split('/').pop() || ev.file}`
                    }
                    const selected = sorted.find((e) => e.id === selectedTutorialId) || null
                    return (
                      <>
                        {sorted.length > 0 && (
                          <select
                            value={selected?.id ?? ''}
                            onChange={(e) => setSelectedTutorialId(e.target.value || null)}
                            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-[11px] text-gray-200 font-mono mb-2 focus:outline-none focus:border-jam-500"
                          >
                            <option value="">— pick an event ({sorted.length}) —</option>
                            {sorted.map((ev) => (
                              <option key={ev.id} value={ev.id}>{labelFor(ev)}</option>
                            ))}
                          </select>
                        )}
                        {selected && selected.kind === 'music' && (() => {
                          const ev = selected
                          return (
                          <div
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
                          </div>
                          )
                        })()}
                        {selected && selected.kind === 'vo' && (() => {
                          const ev = selected
                          return (
                        <div
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
                          {/* Collated-file slice editor: when start_ms /
                              duration_ms are set, the engine plays only that
                              window of `file`. Shown when EITHER field is
                              present, plus a one-click "remove offsets"
                              shortcut so users can collapse back to whole-
                              file playback. */}
                          {(ev.startMs !== undefined || ev.durationMs !== undefined) && (
                            <div className="flex items-center gap-1.5 text-[10px] text-gray-400 font-mono">
                              <span className="text-sky-500/80 shrink-0">slice</span>
                              <input
                                type="number"
                                step={10}
                                min={0}
                                value={ev.startMs ?? 0}
                                onChange={(e) => updateTutorialEvent(ev.id, {
                                  startMs: Math.max(0, Number(e.target.value) || 0),
                                })}
                                className="w-16 bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-[10px] text-gray-300"
                                title="Start offset (ms) into the audio file"
                              />
                              <span>+</span>
                              <input
                                type="number"
                                step={10}
                                min={0}
                                value={ev.durationMs ?? 0}
                                onChange={(e) => updateTutorialEvent(ev.id, {
                                  durationMs: Math.max(0, Number(e.target.value) || 0),
                                })}
                                className="w-16 bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-[10px] text-gray-300"
                                title="Slice length (ms)"
                              />
                              <span className="text-gray-600">ms</span>
                              <span className="text-gray-500 ml-1">
                                ({((ev.startMs ?? 0) / 1000).toFixed(2)}s – {(((ev.startMs ?? 0) + (ev.durationMs ?? 0)) / 1000).toFixed(2)}s)
                              </span>
                              <button
                                onClick={() => updateTutorialEvent(ev.id, {
                                  startMs: undefined,
                                  durationMs: undefined,
                                })}
                                className="ml-auto px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-[10px] text-gray-400 hover:text-gray-200"
                                title="Drop the offsets and play the whole file"
                              >
                                clear
                              </button>
                            </div>
                          )}
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
                          </div>
                          {ev.engine === 'elevenlabs' && (
                            <select
                              value={ev.voiceId}
                              onChange={(e) => updateTutorialEvent(ev.id, { voiceId: e.target.value })}
                              className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-[10px] text-gray-200 truncate"
                              title="Voice for this VO — overrides the track default"
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
                        </div>
                          )
                        })()}
                        {selected && selected.kind === 'step' && (() => {
                          const ev = selected
                          return (
                        <div
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
                        </div>
                          )
                        })()}
                        {sorted.length > 0 && !selected && (
                          <p className="text-[11px] text-gray-600">
                            Pick an event from the dropdown to edit it.
                          </p>
                        )}
                        {sorted.length === 0 && (
                          <p className="text-[11px] text-gray-600">
                            No tutorial events yet. Add a STEP to gate progression and a VO to play narration.
                          </p>
                        )}
                      </>
                    )
                  })()}
                  <p className="text-[11px] text-gray-600 mt-2">
                    Set up the 10 instrument samples + voice clone reference on the
                    track detail page (Tutorial samples panel).
                  </p>
                </>
              )}
            </CollapsibleSection>
          )}
        </aside>
      </div>

      <audio
        ref={audioRef}
        src={audioSrc}
        preload="metadata"
        onLoadedMetadata={(e) => {
          setDuration(e.currentTarget.duration)
          // Restore the playhead after switching between the beatmap stem
          // and the full mix so the user keeps their place in the song.
          if (pendingSeekRef.current !== null) {
            const target = Math.min(pendingSeekRef.current, e.currentTarget.duration || pendingSeekRef.current)
            e.currentTarget.currentTime = target
            setCurrentTime(target)
            pendingSeekRef.current = null
          }
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />

      {pickerOpen && chart && (
        <SourcePickerModal
          existingIds={chart.importedSources.map((s) => s.id)}
          onCancel={() => setPickerOpen(false)}
          onPick={importSource}
        />
      )}

      {studioImportOpen && (
        <div
          className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[70] flex items-center justify-center px-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !studioImportBusy) setStudioImportOpen(false)
          }}
        >
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-xl max-h-[90vh] overflow-y-auto p-5 space-y-4">
            <div>
              <h3 className="text-lg font-semibold text-sky-300">VO library</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Pull from ElevenLabs Studio, batch-upload local files to the
                shared library, or insert a previously-uploaded clip at the
                playhead. Library files keep their original names — name each
                file as its script line so the narration text auto-fills.
              </p>
            </div>

            {/* Path A: Studio URL */}
            <details className="bg-gray-950/60 border border-gray-800 rounded">
              <summary className="px-3 py-2 text-xs uppercase tracking-wider text-gray-400 cursor-pointer">
                Fetch from ElevenLabs Studio
              </summary>
              <div className="p-3 space-y-1 border-t border-gray-800">
                <input
                  type="text"
                  value={studioImportUrl}
                  onChange={(e) => setStudioImportUrl(e.target.value)}
                  placeholder="https://elevenlabs.io/app/studio/<project>?chapterId=<chapter>"
                  disabled={studioImportBusy}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-[12px] font-mono text-gray-200 focus:outline-none focus:border-sky-500 disabled:opacity-50"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !studioImportBusy) runStudioImport()
                  }}
                />
                <button
                  onClick={runStudioImport}
                  disabled={studioImportBusy || !studioImportUrl.trim()}
                  className="w-full mt-1 px-3 py-1.5 bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white rounded text-xs font-medium"
                >
                  {studioImportBusy ? 'Fetching…' : 'Fetch + add VO at playhead'}
                </button>
              </div>
            </details>

            {/* Path B: Multi-file upload to library */}
            <details open className="bg-gray-950/60 border border-gray-800 rounded">
              <summary className="px-3 py-2 text-xs uppercase tracking-wider text-emerald-300 cursor-pointer">
                Upload files to library
              </summary>
              <div className="p-3 space-y-2 border-t border-gray-800">
                <label className="block text-xs text-gray-400">Batch tag</label>
                <input
                  type="text"
                  value={libBatchTag}
                  onChange={(e) => setLibBatchTag(e.target.value)}
                  placeholder='e.g. "Guitar Lesson 1 elevenlabs Ryan"'
                  disabled={studioImportBusy}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-[12px] text-gray-200 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
                />
                <label className="block text-xs text-gray-400 pt-1">Audio files (multi-select OK)</label>
                <input
                  ref={libUploadRef}
                  type="file"
                  multiple
                  accept=".ogg,.mp3,.wav,.flac,.m4a,audio/*"
                  onChange={(e) => setLibUploadFiles(Array.from(e.target.files || []))}
                  disabled={studioImportBusy}
                  className="w-full text-[11px] text-gray-300 file:mr-2 file:px-2 file:py-1 file:rounded file:border-0 file:bg-gray-700 file:hover:bg-gray-600 file:text-gray-100 file:text-[11px] file:cursor-pointer cursor-pointer disabled:opacity-50"
                />
                {libUploadFiles.length > 0 && (
                  <div className="text-[10px] text-gray-500 max-h-24 overflow-y-auto bg-gray-900 border border-gray-800 rounded p-1.5">
                    {libUploadFiles.map((f) => (
                      <div key={f.name} className="truncate font-mono">· {f.name}</div>
                    ))}
                  </div>
                )}
                <button
                  onClick={runLibraryUpload}
                  disabled={studioImportBusy || libUploadFiles.length === 0 || !libBatchTag.trim()}
                  className="w-full px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded text-xs font-medium"
                >
                  {studioImportBusy ? 'Uploading…' : `Upload ${libUploadFiles.length || ''} file${libUploadFiles.length === 1 ? '' : 's'} to library`}
                </button>
                <p className="text-[10px] text-gray-600 leading-snug">
                  Files are saved to the shared library only. Insert them into
                  this tutorial from the section below.
                </p>
              </div>
            </details>

            {/* Path C: Browse the library */}
            <details open className="bg-gray-950/60 border border-gray-800 rounded">
              <summary className="px-3 py-2 text-xs uppercase tracking-wider text-amber-300 cursor-pointer">
                Insert from library
              </summary>
              <div className="p-3 space-y-2 border-t border-gray-800">
                {libBatches.length === 0 ? (
                  <p className="text-[11px] text-gray-500">No batches in the library yet.</p>
                ) : (
                  <>
                    <label className="block text-xs text-gray-400">Batch</label>
                    <select
                      value={libSelectedBatch}
                      onChange={(e) => setLibSelectedBatch(e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-[12px] text-gray-200 focus:outline-none focus:border-amber-500"
                    >
                      <option value="">— pick a batch —</option>
                      {libBatches.map((b) => (
                        <option key={b.batch} value={b.batch}>
                          {b.label} ({b.file_count})
                        </option>
                      ))}
                    </select>
                    {libSelectedBatch && libBatchFiles.length > 0 && (
                      <div className="max-h-72 overflow-y-auto border border-gray-800 rounded divide-y divide-gray-800">
                        {libBatchFiles.map((f) => {
                          const busy = libBusyName === f.name
                          return (
                            <div key={f.name} className="flex items-center gap-2 px-2 py-1.5 bg-gray-900 hover:bg-gray-800">
                              <audio
                                src={`/api/tutorial/vo-library/file/${encodeURIComponent(libSelectedBatch)}/${encodeURIComponent(f.name)}`}
                                controls
                                preload="none"
                                className="h-7 flex-shrink-0"
                                style={{ width: 160 }}
                              />
                              <div className="flex-1 min-w-0">
                                <div className="text-[11px] text-gray-200 truncate" title={f.text}>{f.text || f.name}</div>
                                <div className="text-[10px] text-gray-600 truncate">{f.name}</div>
                              </div>
                              <button
                                onClick={() => insertLibraryFile(libSelectedBatch, f)}
                                disabled={busy || studioImportBusy}
                                className="px-2 py-1 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white rounded text-[11px] font-medium flex-shrink-0"
                                title={`Insert at ${fmtTick(playheadTick)}`}
                              >
                                {busy ? '…' : '+ insert'}
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    )}
                    {libSelectedBatch && libBatchFiles.length === 0 && (
                      <p className="text-[11px] text-gray-500">Empty batch.</p>
                    )}
                  </>
                )}
                <p className="text-[10px] text-gray-600 leading-snug">
                  Insert drops a VO event at the current playhead
                  (<span className="font-mono text-gray-400">{fmtTick(playheadTick)}</span>).
                  Advance the playhead between inserts to sequence them.
                </p>
              </div>
            </details>

            {studioImportStatus && (
              <p className="text-xs text-emerald-400 break-words">{studioImportStatus}</p>
            )}
            {studioImportError && (
              <p className="text-xs text-red-400 break-words">{studioImportError}</p>
            )}
            <div className="flex justify-end pt-1">
              <button
                onClick={() => setStudioImportOpen(false)}
                disabled={studioImportBusy}
                className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 rounded text-xs"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

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

      {typeModalOpen && (
        <div
          className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[70] flex items-center justify-center px-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !typeFormBusy) { setTypeModalOpen(false); resetTypeForm() }
          }}
        >
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-5 space-y-3">
            <div>
              <h3 className="text-lg font-semibold text-emerald-300">New scene event type</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Registers the type globally — every chart can use it. After saving you'll
                get a handover doc to send the Unity engineer.
              </p>
            </div>
            <label className="block">
              <span className="text-xs text-gray-400">Payload name (lowercase / underscores)</span>
              <input
                type="text"
                value={typeFormName}
                onChange={(e) => setTypeFormName(e.target.value)}
                placeholder="leftlasercolour"
                disabled={typeFormBusy}
                className="w-full mt-0.5 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-[12px] font-mono text-gray-200 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-400">Display label</span>
              <input
                type="text"
                value={typeFormLabel}
                onChange={(e) => setTypeFormLabel(e.target.value)}
                placeholder="Lasers · left colour"
                disabled={typeFormBusy}
                className="w-full mt-0.5 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-[12px] text-gray-200 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-400">Group</span>
              <input
                type="text"
                value={typeFormGroup}
                onChange={(e) => setTypeFormGroup(e.target.value)}
                placeholder="Custom"
                disabled={typeFormBusy}
                className="w-full mt-0.5 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-[12px] text-gray-200 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
              />
              <span className="text-[10px] text-gray-600">Picker section the event lands in.</span>
            </label>
            <label className="block">
              <span className="text-xs text-gray-400">Description</span>
              <textarea
                value={typeFormDesc}
                onChange={(e) => setTypeFormDesc(e.target.value)}
                placeholder="What this event drives on the game side — feeds the handover doc + the tooltip."
                rows={3}
                disabled={typeFormBusy}
                className="w-full mt-0.5 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-[12px] text-gray-200 focus:outline-none focus:border-emerald-500 resize-y disabled:opacity-50"
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-400">Parameter type</span>
              <select
                value={typeFormParamKind}
                onChange={(e) => setTypeFormParamKind(e.target.value as SceneEventParam['type'])}
                disabled={typeFormBusy}
                className="w-full mt-0.5 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-[12px] text-gray-200 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
              >
                <option value="duration">Duration (ticks)</option>
                <option value="hex_color">Hex colour (#RRGGBB)</option>
                <option value="number">Number (min/max/step)</option>
                <option value="enum">Enum (pipe-separated options)</option>
                <option value="none">No parameter</option>
              </select>
            </label>
            {typeFormParamKind === 'number' && (
              <div className="grid grid-cols-3 gap-2">
                <label className="block">
                  <span className="text-[10px] text-gray-500">min</span>
                  <input
                    type="number"
                    value={typeFormMin}
                    onChange={(e) => setTypeFormMin(e.target.value)}
                    placeholder="0"
                    disabled={typeFormBusy}
                    className="w-full bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] font-mono text-gray-200 disabled:opacity-50"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] text-gray-500">max</span>
                  <input
                    type="number"
                    value={typeFormMax}
                    onChange={(e) => setTypeFormMax(e.target.value)}
                    placeholder="1"
                    disabled={typeFormBusy}
                    className="w-full bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] font-mono text-gray-200 disabled:opacity-50"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] text-gray-500">step</span>
                  <input
                    type="number"
                    value={typeFormStep}
                    onChange={(e) => setTypeFormStep(e.target.value)}
                    placeholder="0.1"
                    disabled={typeFormBusy}
                    className="w-full bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] font-mono text-gray-200 disabled:opacity-50"
                  />
                </label>
              </div>
            )}
            {typeFormParamKind === 'enum' && (
              <label className="block">
                <span className="text-xs text-gray-400">Options (pipe-separated)</span>
                <input
                  type="text"
                  value={typeFormOptions}
                  onChange={(e) => setTypeFormOptions(e.target.value)}
                  placeholder="slow|medium|fast"
                  disabled={typeFormBusy}
                  className="w-full mt-0.5 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-[12px] font-mono text-gray-200 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
                />
              </label>
            )}
            {typeFormError && (
              <p className="text-xs text-red-400 break-words">{typeFormError}</p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => { setTypeModalOpen(false); resetTypeForm() }}
                disabled={typeFormBusy}
                className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 rounded text-xs"
              >
                Cancel
              </button>
              <button
                onClick={submitNewType}
                disabled={typeFormBusy || !typeFormName.trim()}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded text-xs font-medium"
              >
                {typeFormBusy ? 'Saving…' : 'Save + view handover doc'}
              </button>
            </div>
          </div>
        </div>
      )}

      {handoverModal && (
        <div
          className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[80] flex items-center justify-center px-4"
          onClick={(e) => { if (e.target === e.currentTarget) setHandoverModal(null) }}
        >
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-emerald-300">
                Handover doc · <span className="font-mono">{handoverModal.name}</span>
              </h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => navigator.clipboard.writeText(handoverModal.md)}
                  className="px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded text-[11px]"
                  title="Copy markdown to clipboard"
                >
                  Copy
                </button>
                <button
                  onClick={() => {
                    const blob = new Blob([handoverModal.md], { type: 'text/markdown' })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement('a')
                    a.href = url
                    a.download = `scene-event-${handoverModal.name}.md`
                    a.click()
                    URL.revokeObjectURL(url)
                  }}
                  className="px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded text-[11px]"
                  title="Download as .md"
                >
                  Download
                </button>
              </div>
            </div>
            <p className="text-[11px] text-gray-500">
              Send this to the Unity engineer so the runtime can subscribe to the
              new event. The payload format is the source of truth — match it on
              both sides.
            </p>
            <pre className="bg-gray-950 border border-gray-800 rounded p-3 text-[11px] text-gray-200 whitespace-pre-wrap break-words font-mono">{handoverModal.md}</pre>
            <div className="flex justify-end">
              <button
                onClick={() => setHandoverModal(null)}
                className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-xs"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
