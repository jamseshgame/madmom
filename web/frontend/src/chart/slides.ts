// Pure slide parsing / serialization helpers for the beatmap editor.
//
// A "slide" is a contiguous run of note positions stored in the chart as
// `E slide <fret>` events. See docs/superpowers/specs/2026-05-19-hold-slide-bars-design.md
//
// Chart spec for one slide:
//   start  -> `E slide <fret>` only (no N line)
//   middle -> `N <fret> 0` + `E slide <fret>`
//   end    -> `N <fret> 0` only (no marker)
// Chord slides apply the same pattern to a parallel adjacent fret pair.

/** Structural subset of ChartNote the slide logic needs. ChartNote (a
 *  superset) is assignable to this via structural typing. */
export interface SlideNote {
  tick: number
  lane: number
  sustain: number
  slideId?: number
}

/** A raw `<tick> = E slide <fret>` event from a difficulty section. */
export interface SlideEvent {
  tick: number
  fret: number
}

/** Role a slide-tagged note plays when serialized back to the chart. */
export type SlideRole = 'start' | 'middle' | 'end'

/** Largest slideId in use + 1 (1 if none). Deterministic, collision-free. */
export function nextSlideId(notes: SlideNote[]): number {
  let max = 0
  for (const n of notes) {
    if (n.slideId != null && n.slideId > max) max = n.slideId
  }
  return max + 1
}

/** Group notes by slideId. Each group is sorted by tick then lane. Notes
 *  without a slideId are skipped. */
export function groupSlides(notes: SlideNote[]): Map<number, SlideNote[]> {
  const groups = new Map<number, SlideNote[]>()
  for (const n of notes) {
    if (n.slideId == null) continue
    const g = groups.get(n.slideId)
    if (g) g.push(n)
    else groups.set(n.slideId, [n])
  }
  for (const g of groups.values()) {
    g.sort((a, b) => a.tick - b.tick || a.lane - b.lane)
  }
  return groups
}

// A run breaks when the gap between consecutive E-slide positions exceeds
// resolution * this factor (~2 beats). Heuristic — see spec section 5.1.
const SLIDE_GAP_FACTOR = 2

/**
 * Detect slides from a difficulty section's `E slide` events and return a NEW
 * note array with the participating notes tagged with a `slideId`. Start
 * positions (which carry no `N` line in the chart) are synthesized as new
 * zero-sustain notes so they render and can be selected.
 *
 * Pure: the input `notes` array and its objects are never mutated.
 */
export function importSlides(
  notes: SlideNote[],
  slideEvents: SlideEvent[],
  resolution: number,
): SlideNote[] {
  if (slideEvents.length === 0) return notes
  const result: SlideNote[] = notes.map((n) => ({ ...n }))
  const threshold = resolution * SLIDE_GAP_FACTOR

  // Slide positions: tick -> sorted unique frets.
  const byTick = new Map<number, number[]>()
  for (const ev of slideEvents) {
    const frets = byTick.get(ev.tick)
    if (frets) {
      if (!frets.includes(ev.fret)) frets.push(ev.fret)
    } else {
      byTick.set(ev.tick, [ev.fret])
    }
  }
  for (const frets of byTick.values()) frets.sort((a, b) => a - b)
  const posTicks = [...byTick.keys()].sort((a, b) => a - b)

  // Chain positions into runs, breaking when the gap is too large.
  const runs: number[][] = []
  let cur: number[] = []
  for (const t of posTicks) {
    if (cur.length > 0 && t - cur[cur.length - 1] > threshold) {
      runs.push(cur)
      cur = []
    }
    cur.push(t)
  }
  if (cur.length > 0) runs.push(cur)

  let sid = nextSlideId(result)
  for (const run of runs) {
    const id = sid++
    let maxFrets = 1
    // Tag (or synthesize) the start + middle positions.
    for (const t of run) {
      const frets = byTick.get(t)!
      if (frets.length > maxFrets) maxFrets = frets.length
      for (const fret of frets) {
        const existing = result.find(
          (n) => n.tick === t && n.lane === fret && n.slideId == null,
        )
        if (existing) {
          existing.slideId = id
        } else {
          result.push({ tick: t, lane: fret, sustain: 0, slideId: id })
        }
      }
    }
    // End position: the nearest later note tick within the gap threshold.
    const lastTick = run[run.length - 1]
    const laterTicks = result
      .filter((n) => n.tick > lastTick && n.slideId == null)
      .map((n) => n.tick)
    if (laterTicks.length > 0) {
      const endTick = Math.min(...laterTicks)
      if (endTick - lastTick <= threshold) {
        const endNotes = result
          .filter((n) => n.tick === endTick && n.slideId == null)
          .sort((a, b) => a.lane - b.lane)
        for (const n of endNotes.slice(0, maxFrets)) {
          n.slideId = id
        }
      }
    }
  }
  return result
}

/** Distinct ticks in a group, ascending. */
function distinctTicks(group: SlideNote[]): number[] {
  return [...new Set(group.map((n) => n.tick))].sort((a, b) => a - b)
}

/**
 * Compute each slide-tagged note's serialization role. Groups with fewer than
 * two distinct ticks are not real slides and are omitted (their notes
 * serialize as plain notes).
 */
export function buildSlideEmitInfo(notes: SlideNote[]): Map<SlideNote, SlideRole> {
  const roles = new Map<SlideNote, SlideRole>()
  for (const group of groupSlides(notes).values()) {
    const ticks = distinctTicks(group)
    if (ticks.length < 2) continue
    const first = ticks[0]
    const last = ticks[ticks.length - 1]
    for (const n of group) {
      roles.set(n, n.tick === first ? 'start' : n.tick === last ? 'end' : 'middle')
    }
  }
  return roles
}

/**
 * Clear slideId from any slide group that is no longer a valid slide (fewer
 * than two distinct ticks). Call after edits that delete notes. Returns the
 * same array reference when nothing changed.
 */
export function pruneSlides(notes: SlideNote[]): SlideNote[] {
  const toClear = new Set<number>()
  for (const [id, group] of groupSlides(notes)) {
    if (distinctTicks(group).length < 2) toClear.add(id)
  }
  if (toClear.size === 0) return notes
  return notes.map((n) =>
    n.slideId != null && toClear.has(n.slideId) ? { ...n, slideId: undefined } : n,
  )
}
