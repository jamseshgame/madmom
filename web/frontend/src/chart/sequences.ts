// Save/paste math for the cross-track sequence library. Ticks are musical
// units (resolution ticks per beat), so a sequence pasted into a chart with
// a different BPM/tempo map lands on the right beats automatically — only
// the tick *resolution* needs rescaling, which happens here.

export interface SequenceNote {
  tick: number
  lane: number
  sustain: number
  slideId?: number
  type?: 'real'
  pack?: string
  scale?: string
}

export interface MaterializeOpts {
  sourceResolution: number   // ticks-per-beat the sequence was saved at
  targetResolution: number   // ticks-per-beat of the chart being pasted into
  scale: number              // paste-time stretch: 0.5, 1, or 2
  baseTick: number           // snapped playhead tick the sequence anchors to
  slideIdStart: number       // first free slideId in the target chart
}

// Shift ticks so the earliest note sits at 0 and sort (tick, lane) — the
// canonical stored form of a library sequence.
export function normalizeSequence(notes: SequenceNote[]): SequenceNote[] {
  if (notes.length === 0) return []
  let minTick = notes[0].tick
  for (const n of notes) if (n.tick < minTick) minTick = n.tick
  return notes
    .map((n) => ({ ...n, tick: n.tick - minTick }))
    .sort((a, b) => a.tick - b.tick || a.lane - b.lane)
}

// Turn a stored sequence into notes ready to merge into the target chart.
// Rounding after rescale/scale can collapse two notes onto the same
// (tick, lane); duplicates are dropped, keeping the first.
// Sustains that scale below 1 tick truncate to 0 (the note becomes a tap).
// `sourceResolution` must be > 0 (validated upstream at save time).
export function materializeSequence(seqNotes: SequenceNote[], opts: MaterializeOpts): SequenceNote[] {
  const ratio = (opts.targetResolution / opts.sourceResolution) * opts.scale
  const slideMap = new Map<number, number>()
  let nextSlide = opts.slideIdStart
  const seen = new Set<string>()
  const out: SequenceNote[] = []
  for (const n of seqNotes) {
    const tick = opts.baseTick + Math.floor(n.tick * ratio)
    const sustain = Math.floor(n.sustain * ratio)
    const key = `${tick}:${n.lane}`
    if (seen.has(key)) continue
    seen.add(key)
    const placed: SequenceNote = { ...n, tick, sustain }
    if (n.slideId != null) {
      if (!slideMap.has(n.slideId)) slideMap.set(n.slideId, nextSlide++)
      placed.slideId = slideMap.get(n.slideId)
    }
    out.push(placed)
  }
  return out.sort((a, b) => a.tick - b.tick || a.lane - b.lane)
}
