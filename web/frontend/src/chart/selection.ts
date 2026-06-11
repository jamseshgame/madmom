// Pure selection math for the beatmap editor. Kept canvas-free so the
// range-select and marquee gestures are unit-testable.

export interface MarqueeRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface MarqueeGeom {
  gemX0: number   // left edge of the gem area (after the ruler gutter)
  gemX1: number   // right edge of the gem area (before the sidecar)
  laneW: number   // width of one of the five fret lanes
}

// Indices of every note whose tick lies between the two ticks, inclusive,
// across all lanes. Order matches the notes array (ascending index).
export function rangeSelectIds(notes: { tick: number }[], tickA: number, tickB: number): number[] {
  const lo = Math.min(tickA, tickB)
  const hi = Math.max(tickA, tickB)
  const out: number[] = []
  notes.forEach((n, i) => {
    if (n.tick >= lo && n.tick <= hi) out.push(i)
  })
  return out
}

// Indices of every note whose rendered position intersects the marquee.
// `items[i].y` is the note's canvas y (caller computes it from tick/tempo);
// fretted notes (lane 0-4) hit-test at their lane center x, while open
// notes and modifiers (lane > 4) span the gem area so any horizontal
// overlap with it counts.
export function marqueeHitIds(
  items: { lane: number; y: number }[],
  rect: MarqueeRect,
  geom: MarqueeGeom,
): number[] {
  const xLo = Math.min(rect.x0, rect.x1)
  const xHi = Math.max(rect.x0, rect.x1)
  const yLo = Math.min(rect.y0, rect.y1)
  const yHi = Math.max(rect.y0, rect.y1)
  const out: number[] = []
  items.forEach((it, i) => {
    if (it.y < yLo || it.y > yHi) return
    if (it.lane <= 4) {
      const x = geom.gemX0 + (it.lane + 0.5) * geom.laneW
      if (x < xLo || x > xHi) return
    } else if (xHi < geom.gemX0 || xLo > geom.gemX1) {
      return
    }
    out.push(i)
  })
  return out
}
