import { describe, it, expect } from 'vitest'
import { nextSlideId, groupSlides, importSlides, buildSlideEmitInfo, pruneSlides, type SlideNote, type SlideEvent } from './slides'

describe('nextSlideId', () => {
  it('returns 1 when no note has a slideId', () => {
    expect(nextSlideId([{ tick: 0, lane: 0, sustain: 0 }])).toBe(1)
  })
  it('returns the largest slideId plus one', () => {
    const notes: SlideNote[] = [
      { tick: 0, lane: 0, sustain: 0, slideId: 3 },
      { tick: 1, lane: 1, sustain: 0, slideId: 7 },
    ]
    expect(nextSlideId(notes)).toBe(8)
  })
})

describe('groupSlides', () => {
  it('groups notes by slideId, sorting each group by tick then lane', () => {
    const notes: SlideNote[] = [
      { tick: 200, lane: 2, sustain: 0, slideId: 1 },
      { tick: 100, lane: 1, sustain: 0, slideId: 1 },
      { tick: 50, lane: 0, sustain: 0 },
    ]
    const groups = groupSlides(notes)
    expect(groups.size).toBe(1)
    expect(groups.get(1)!.map((n) => n.tick)).toEqual([100, 200])
  })
})

describe('importSlides', () => {
  it('returns the input unchanged when there are no slide events', () => {
    const notes: SlideNote[] = [{ tick: 0, lane: 0, sustain: 0 }]
    expect(importSlides(notes, [], 192)).toEqual(notes)
  })

  it('tags a single-fret slide: synthesizes the start, tags middle and end', () => {
    // start  = E slide 1 at tick 100 (no N note in the chart)
    // middle = N 2 0 + E slide 2 at tick 200
    // end    = N 3 0 at tick 300 (no marker)
    const notes: SlideNote[] = [
      { tick: 200, lane: 2, sustain: 0 },
      { tick: 300, lane: 3, sustain: 0 },
    ]
    const events: SlideEvent[] = [
      { tick: 100, fret: 1 },
      { tick: 200, fret: 2 },
    ]
    const out = importSlides(notes, events, 192)
    const start = out.find((n) => n.tick === 100 && n.lane === 1)
    expect(start).toBeDefined()
    expect(start!.slideId).toBe(1)
    expect(out.find((n) => n.tick === 200 && n.lane === 2)!.slideId).toBe(1)
    expect(out.find((n) => n.tick === 300 && n.lane === 3)!.slideId).toBe(1)
  })

  it('tags a chord slide on both frets of each position', () => {
    const notes: SlideNote[] = [
      { tick: 200, lane: 2, sustain: 0 }, { tick: 200, lane: 3, sustain: 0 },
      { tick: 300, lane: 3, sustain: 0 }, { tick: 300, lane: 4, sustain: 0 },
    ]
    const events: SlideEvent[] = [
      { tick: 100, fret: 1 }, { tick: 100, fret: 2 },
      { tick: 200, fret: 2 }, { tick: 200, fret: 3 },
    ]
    const out = importSlides(notes, events, 192)
    const ids = new Set(out.filter((n) => n.slideId != null).map((n) => n.slideId))
    expect(ids.size).toBe(1)
    // 2 synthesized starts + 2 middles + 2 end notes
    expect(out.filter((n) => n.slideId != null).length).toBe(6)
  })

  it('splits two far-apart runs into separate slide ids', () => {
    const notes: SlideNote[] = [
      { tick: 200, lane: 1, sustain: 0 }, { tick: 300, lane: 2, sustain: 0 },
      { tick: 9000, lane: 1, sustain: 0 }, { tick: 9100, lane: 2, sustain: 0 },
    ]
    const events: SlideEvent[] = [
      { tick: 100, fret: 0 }, { tick: 200, fret: 1 },
      { tick: 8900, fret: 0 }, { tick: 9000, fret: 1 },
    ]
    const out = importSlides(notes, events, 192)
    const ids = [...new Set(out.filter((n) => n.slideId != null).map((n) => n.slideId))]
    expect(ids.length).toBe(2)
  })

  it('does not mutate the input notes', () => {
    const notes: SlideNote[] = [{ tick: 200, lane: 2, sustain: 0 }]
    importSlides(notes, [{ tick: 100, fret: 1 }, { tick: 200, fret: 2 }], 192)
    expect(notes[0].slideId).toBeUndefined()
  })
})

describe('buildSlideEmitInfo', () => {
  it('assigns start / middle / end by tick order', () => {
    const notes: SlideNote[] = [
      { tick: 100, lane: 1, sustain: 0, slideId: 1 },
      { tick: 200, lane: 2, sustain: 0, slideId: 1 },
      { tick: 300, lane: 3, sustain: 0, slideId: 1 },
    ]
    const roles = buildSlideEmitInfo(notes)
    expect(roles.get(notes[0])).toBe('start')
    expect(roles.get(notes[1])).toBe('middle')
    expect(roles.get(notes[2])).toBe('end')
  })

  it('marks every note at the first tick as start (chord slide)', () => {
    const notes: SlideNote[] = [
      { tick: 100, lane: 1, sustain: 0, slideId: 1 },
      { tick: 100, lane: 2, sustain: 0, slideId: 1 },
      { tick: 200, lane: 2, sustain: 0, slideId: 1 },
      { tick: 200, lane: 3, sustain: 0, slideId: 1 },
    ]
    const roles = buildSlideEmitInfo(notes)
    expect(roles.get(notes[0])).toBe('start')
    expect(roles.get(notes[1])).toBe('start')
    expect(roles.get(notes[2])).toBe('end')
    expect(roles.get(notes[3])).toBe('end')
  })

  it('assigns middle to chord notes at an intermediate tick', () => {
    const notes: SlideNote[] = [
      { tick: 100, lane: 1, sustain: 0, slideId: 1 },
      { tick: 100, lane: 2, sustain: 0, slideId: 1 },
      { tick: 200, lane: 2, sustain: 0, slideId: 1 },
      { tick: 200, lane: 3, sustain: 0, slideId: 1 },
      { tick: 300, lane: 3, sustain: 0, slideId: 1 },
      { tick: 300, lane: 4, sustain: 0, slideId: 1 },
    ]
    const roles = buildSlideEmitInfo(notes)
    expect(roles.get(notes[2])).toBe('middle')
    expect(roles.get(notes[3])).toBe('middle')
  })

  it('ignores groups with fewer than two distinct ticks', () => {
    const notes: SlideNote[] = [
      { tick: 100, lane: 1, sustain: 0, slideId: 1 },
      { tick: 100, lane: 2, sustain: 0, slideId: 1 },
    ]
    expect(buildSlideEmitInfo(notes).size).toBe(0)
  })
})

describe('pruneSlides', () => {
  it('clears slideId from a group with only one distinct tick', () => {
    const notes: SlideNote[] = [
      { tick: 100, lane: 1, sustain: 0, slideId: 1 },
      { tick: 100, lane: 2, sustain: 0, slideId: 1 },
    ]
    expect(pruneSlides(notes)).toEqual([
      { tick: 100, lane: 1, sustain: 0, slideId: undefined },
      { tick: 100, lane: 2, sustain: 0, slideId: undefined },
    ])
  })

  it('leaves a valid multi-tick slide intact (same array reference)', () => {
    const notes: SlideNote[] = [
      { tick: 100, lane: 1, sustain: 0, slideId: 1 },
      { tick: 200, lane: 2, sustain: 0, slideId: 1 },
    ]
    expect(pruneSlides(notes)).toBe(notes)
  })
})

describe('slide round-trip (spec section 6)', () => {
  it('imports a real chord slide and re-emits the original chart lines', () => {
    // Exact shape from the Ben Chango guitar chart (frets 2 & 3):
    //   16464 = E slide 2 / E slide 3                  (start, no N)
    //   16560 = N 2 0 + E slide 2 / N 3 0 + E slide 3  (middle)
    //   16608 = N 2 0 / N 3 0                          (end)
    const notes: SlideNote[] = [
      { tick: 16560, lane: 2, sustain: 0 }, { tick: 16560, lane: 3, sustain: 0 },
      { tick: 16608, lane: 2, sustain: 0 }, { tick: 16608, lane: 3, sustain: 0 },
    ]
    const events: SlideEvent[] = [
      { tick: 16464, fret: 2 }, { tick: 16464, fret: 3 },
      { tick: 16560, fret: 2 }, { tick: 16560, fret: 3 },
    ]
    const tagged = importSlides(notes, events, 192)
    const roles = buildSlideEmitInfo(tagged)
    // Reconstruct chart lines exactly as emitNoteSectionLines (Task 6) will.
    const lines: string[] = []
    for (const n of [...tagged].sort((a, b) => a.tick - b.tick || a.lane - b.lane)) {
      const role = roles.get(n)
      if (!role) { lines.push(`${n.tick} = N ${n.lane} ${n.sustain}`); continue }
      if (role !== 'start') lines.push(`${n.tick} = N ${n.lane} 0`)
      if (role !== 'end') lines.push(`${n.tick} = E slide ${n.lane}`)
    }
    expect(lines).toEqual([
      '16464 = E slide 2',
      '16464 = E slide 3',
      '16560 = N 2 0',
      '16560 = E slide 2',
      '16560 = N 3 0',
      '16560 = E slide 3',
      '16608 = N 2 0',
      '16608 = N 3 0',
    ])
  })
})
