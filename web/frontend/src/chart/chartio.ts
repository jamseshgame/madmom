// Pure .chart section I/O for the beatmap editor: parsing a difficulty
// section into notes, serializing notes back, and splicing a section into
// the full chart text. Extracted from BeatmapEditor.tsx so the round trip
// is unit-testable — slide grouping survives it exactly via the sidecar
// [SlideMeta_<section>] block (see chart/slides.ts).

import {
  applySlideMeta, buildSlideEmitInfo, emitSlideMetaLines, importSlides,
  parseSlideMetaRows, type SlideEvent,
} from './slides'

export interface ChartNote {
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

// ── Drum notation ──────────────────────────────────────────────────────────
// The editor models drums as 5 fixed lanes (0 Kick, 1 Snare, 2 Hi-hat, 3 Tom,
// 4 Cymbal). The game (JamseshQuest DrumChartParser) reads Clone Hero "Pro
// Drums": notes 1–4 are pads that default to toms and only become cymbals when
// a same-tick modifier note (66 yellow / 67 blue / 68 green; 69 = open hat) is
// present. So we translate at this I/O boundary: lanes → pads + cymbal flags on
// the way out, and pads/flags → lanes on the way in.
//
// Legacy self-migration: editor charts written before this change used the raw
// note number as the lane (2 = hi-hat, 4 = cymbal) and never emitted modifiers.
// A drum section with NO modifier note is therefore parsed with that legacy
// 1:1 mapping so existing work loads as authored; re-saving emits the modifiers
// and upgrades it to Pro Drums notation.

function isDrumSection(name: string): boolean {
  return /drums/i.test(name)
}

// editor lane → [base pad note, optional cymbal-modifier note]. Lanes:
// 0 Kick, 1 Snare, 2 Hi-hat, 3 Tom (rack), 4 Cymbal (crash), 5 Floor Tom.
// Floor Tom and Cymbal both ride the green pad (note 4): Floor Tom is the bare
// pad (a tom), Cymbal is the pad + cymbal flag (a crash). The game's per-tick
// promotion means they can't share a tick, but they're distinct notes.
const DRUM_LANE_EMIT: Record<number, [number, number?]> = {
  0: [0],       // Kick      → Bass
  1: [1],       // Snare     → Snare
  2: [2, 66],   // Hi-hat    → yellow pad + cymbal flag (Hats)
  3: [3],       // Tom       → blue pad (Medium Tom)
  4: [4, 68],   // Cymbal    → green pad + cymbal flag (Crash)
  5: [4],       // Floor Tom → green pad, bare (Floor Tom)
}

// Mirror of the game's BaseMap + PromoteToCymbal, collapsed straight to an
// editor lane. Bare blue/yellow pads are toms → the Tom lane; the bare green
// pad is the Floor Tom lane; promoted pads land on Hi-hat or Cymbal.
function drumNoteToLane(note: number, promoted: boolean): number | null {
  switch (note) {
    case 0: return 0 // Bass
    case 1: return 1 // Snare
    case 2: return promoted ? 2 : 3 // Hats (hi-hat) else Small Tom → Tom
    case 3: return promoted ? 4 : 3 // Ride (cymbal) else Medium Tom → Tom
    case 4: return promoted ? 4 : 5 // Crash (cymbal) else Floor Tom
    case 32: return 4 // legacy green cymbal
    default: return null
  }
}

/** Translate raw drum N rows (chart note numbers) into editor lane notes. */
function drumRowsToLanes(rows: { tick: number; note: number; sustain: number }[]): ChartNote[] {
  const hasModifier = rows.some((r) => r.note >= 66 && r.note <= 69)
  if (!hasModifier) {
    // Legacy editor chart — note number is already the lane (0-4).
    return rows.filter((r) => r.note >= 0 && r.note <= 4).map((r) => ({ tick: r.tick, lane: r.note, sustain: r.sustain }))
  }
  // Pro Drums: a cymbal modifier (66-68) at a tick promotes every tom there
  // (matching the game's per-tick promotion). 69 (open hat) doesn't change lane.
  const byTick = new Map<number, { note: number; sustain: number }[]>()
  for (const r of rows) {
    const g = byTick.get(r.tick)
    if (g) g.push({ note: r.note, sustain: r.sustain })
    else byTick.set(r.tick, [{ note: r.note, sustain: r.sustain }])
  }
  const out: ChartNote[] = []
  for (const [tick, group] of byTick) {
    const promoted = group.some((g) => g.note >= 66 && g.note <= 68)
    for (const g of group) {
      if (g.note >= 66) continue // modifier note — consumed, not a gem
      const lane = drumNoteToLane(g.note, promoted)
      if (lane !== null) out.push({ tick, lane, sustain: g.sustain })
    }
  }
  return out
}

/** Serialize drum lanes into Pro Drums N rows (base pad + cymbal modifier). */
function emitDrumSectionLines(notes: ChartNote[]): string[] {
  const sorted = [...notes].sort((a, b) => a.tick - b.tick || a.lane - b.lane)
  const out: string[] = []
  for (const n of sorted) {
    const spec = DRUM_LANE_EMIT[n.lane]
    if (!spec) { out.push(`  ${n.tick} = N ${n.lane} ${n.sustain}`); continue }
    out.push(`  ${n.tick} = N ${spec[0]} ${n.sustain}`)
    if (spec[1] !== undefined) out.push(`  ${n.tick} = N ${spec[1]} 0`) // cymbal flag (length 0)
  }
  return out
}

/** Inner lines of `[name] { ... }`, or null when the section is absent. */
function sectionInner(text: string, name: string): string | null {
  const start = text.indexOf(`[${name}]`)
  if (start === -1) return null
  const open = text.indexOf('{', start)
  const close = text.indexOf('}', open)
  if (open === -1 || close === -1) return null
  return text.slice(open + 1, close)
}

// Drum-ness can't always be read from the section name: the editor stores drum
// beatmaps in [*Single] sections (the publish merge renames them to [*Drums]),
// so callers that know the stem pass `isDrums` explicitly. When omitted we fall
// back to the section name (true for already-merged/published [*Drums] charts).
export function parseSectionNotes(
  text: string, name: string, resolution: number, isDrums?: boolean,
): ChartNote[] {
  const drums = isDrums ?? isDrumSection(name)
  const inner = sectionInner(text, name)
  if (inner === null) return []
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
  // Drum sections use Pro Drums notation (pads + cymbal modifiers), not the
  // guitar lane/slide/real-note model — translate and return early.
  if (drums) {
    const drumRows: { tick: number; note: number; sustain: number }[] = []
    for (const { line: l } of raws) {
      if (l.kind === 'note') drumRows.push({ tick: l.tick, note: l.lane, sustain: l.sustain })
    }
    return drumRowsToLanes(drumRows)
  }
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
  // Exact slide grouping from the editor-owned sidecar when present (even an
  // empty block is authoritative — it means "no slides"); the lossy E-slide
  // heuristic only runs for legacy charts that predate SlideMeta.
  const meta = sectionInner(text, `SlideMeta_${name}`)
  if (meta !== null) return applySlideMeta(notes, parseSlideMetaRows(meta.split('\n'))) as ChartNote[]
  return importSlides(notes, slideEvents, resolution) as ChartNote[]
}

export function emitNoteSectionLines(notes: ChartNote[], isDrums = false): string[] {
  if (isDrums) return emitDrumSectionLines(notes)
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
      // start -> E slide only · middle -> N(0) + E slide · end -> N only.
      // The end is a plain note to the game, so its real sustain is kept.
      if (role === 'middle') out.push(`  ${n.tick} = N ${n.lane} 0`)
      if (role === 'end') out.push(`  ${n.tick} = N ${n.lane} ${n.sustain}`)
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

/** Splice the `[SlideMeta_<name>]` block: replace when present, append when
 *  it has rows, leave the text untouched when absent and empty. An existing
 *  block is always rewritten (even to empty) so it stays authoritative. */
function replaceSlideMeta(text: string, name: string, notes: ChartNote[]): string {
  const metaName = `SlideMeta_${name}`
  const rows = emitSlideMetaLines(notes)
  const start = text.indexOf(`[${metaName}]`)
  if (start === -1) {
    if (rows.length === 0) return text
    return text.trimEnd() + `\n[${metaName}]\n{\n${rows.join('\n')}\n}\n`
  }
  const open = text.indexOf('{', start)
  const close = text.indexOf('}', open)
  if (open === -1 || close === -1) return text
  return text.slice(0, open + 1) + '\n' + rows.join('\n') + (rows.length ? '\n' : '') + text.slice(close)
}

export function replaceSectionNotes(
  text: string, name: string, notes: ChartNote[], isDrums?: boolean,
): string {
  const drums = isDrums ?? isDrumSection(name)
  const start = text.indexOf(`[${name}]`)
  // Section doesn't exist yet — empty difficulties fall through here. Append
  // the new block (with whatever notes have been authored) to the end so a
  // fresh-difficulty edit survives the round-trip.
  if (start === -1) {
    if (notes.length === 0) return text
    const block = `[${name}]\n{\n${emitNoteSectionLines(notes, drums).join('\n')}\n}\n`
    return replaceSlideMeta(text.trimEnd() + '\n' + block, name, notes)
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
  const newLines = emitNoteSectionLines(notes, drums)
  const combined = [...keptLines, ...newLines].sort((a, b) => {
    const ta = Number(a.match(/^\s*(\d+)/)?.[1] ?? 0)
    const tb = Number(b.match(/^\s*(\d+)/)?.[1] ?? 0)
    return ta - tb
  })
  const spliced = text.slice(0, open + 1) + '\n' + combined.join('\n') + '\n' + text.slice(close)
  return replaceSlideMeta(spliced, name, notes)
}
