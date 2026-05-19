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
