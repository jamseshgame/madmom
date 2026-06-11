import { describe, expect, it } from 'vitest'
import { marqueeHitIds, rangeSelectIds } from './selection'

describe('rangeSelectIds', () => {
  const notes = [
    { tick: 0 }, { tick: 192 }, { tick: 192 }, { tick: 384 }, { tick: 768 },
  ]

  it('selects every note between the two ticks inclusive, across lanes', () => {
    expect(rangeSelectIds(notes, 192, 384)).toEqual([1, 2, 3])
  })

  it('is direction-agnostic (anchor after click)', () => {
    expect(rangeSelectIds(notes, 384, 192)).toEqual([1, 2, 3])
  })

  it('same tick selects just the notes on that tick', () => {
    expect(rangeSelectIds(notes, 192, 192)).toEqual([1, 2])
  })

  it('covers the whole chart when the range spans it', () => {
    expect(rangeSelectIds(notes, 0, 768)).toEqual([0, 1, 2, 3, 4])
  })
})

describe('marqueeHitIds', () => {
  // Geometry: gem area x ∈ [64, 564], 5 lanes of 100px.
  // Lane centers: 114, 214, 314, 414, 514.
  const geom = { gemX0: 64, gemX1: 564, laneW: 100 }

  it('selects fretted notes whose lane center and y fall inside the rect', () => {
    const items = [
      { lane: 0, y: 100 },  // center x=114 — inside
      { lane: 2, y: 150 },  // center x=314 — inside
      { lane: 4, y: 120 },  // center x=514 — outside x range
      { lane: 1, y: 500 },  // below rect
    ]
    const rect = { x0: 80, y0: 50, x1: 350, y1: 200 }
    expect(marqueeHitIds(items, rect, geom)).toEqual([0, 1])
  })

  it('normalizes an inverted drag (drag up-left)', () => {
    const items = [{ lane: 0, y: 100 }]
    const rect = { x0: 350, y0: 200, x1: 80, y1: 50 }
    expect(marqueeHitIds(items, rect, geom)).toEqual([0])
  })

  it('treats open notes and modifiers (lane > 4) as full-width: any x overlap with the gem area counts', () => {
    const items = [
      { lane: 7, y: 100 },  // open note — y inside, rect overlaps gem area
      { lane: 5, y: 100 },  // HOPO modifier — same
      { lane: 7, y: 999 },  // y outside
    ]
    const rect = { x0: 500, y0: 50, x1: 560, y1: 200 }
    expect(marqueeHitIds(items, rect, geom)).toEqual([0, 1])
  })

  it('returns empty when the rect sits entirely left of the gem area', () => {
    const items = [{ lane: 7, y: 100 }]
    const rect = { x0: 0, y0: 50, x1: 60, y1: 200 }
    expect(marqueeHitIds(items, rect, geom)).toEqual([])
  })
})
