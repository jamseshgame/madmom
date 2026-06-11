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

/** Inner lines of `[name] { ... }`, or null when the section is absent. */
function sectionInner(text: string, name: string): string | null {
  const start = text.indexOf(`[${name}]`)
  if (start === -1) return null
  const open = text.indexOf('{', start)
  const close = text.indexOf('}', open)
  if (open === -1 || close === -1) return null
  return text.slice(open + 1, close)
}

export function parseSectionNotes(text: string, name: string, resolution: number): ChartNote[] {
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

export function emitNoteSectionLines(notes: ChartNote[]): string[] {
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

export function replaceSectionNotes(text: string, name: string, notes: ChartNote[]): string {
  const start = text.indexOf(`[${name}]`)
  // Section doesn't exist yet — empty difficulties fall through here. Append
  // the new block (with whatever notes have been authored) to the end so a
  // fresh-difficulty edit survives the round-trip.
  if (start === -1) {
    if (notes.length === 0) return text
    const block = `[${name}]\n{\n${emitNoteSectionLines(notes).join('\n')}\n}\n`
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
  const newLines = emitNoteSectionLines(notes)
  const combined = [...keptLines, ...newLines].sort((a, b) => {
    const ta = Number(a.match(/^\s*(\d+)/)?.[1] ?? 0)
    const tb = Number(b.match(/^\s*(\d+)/)?.[1] ?? 0)
    return ta - tb
  })
  const spliced = text.slice(0, open + 1) + '\n' + combined.join('\n') + '\n' + text.slice(close)
  return replaceSlideMeta(spliced, name, notes)
}
