import { describe, it, expect } from 'vitest'
import { nextSlideId, groupSlides, type SlideNote } from './slides'

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
