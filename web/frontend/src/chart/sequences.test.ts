import { describe, expect, it } from 'vitest'
import { materializeSequence, normalizeSequence } from './sequences'

describe('normalizeSequence', () => {
  it('shifts ticks so the earliest note is at 0 and sorts by tick then lane', () => {
    const out = normalizeSequence([
      { tick: 960, lane: 2, sustain: 0 },
      { tick: 768, lane: 3, sustain: 96 },
      { tick: 768, lane: 1, sustain: 0 },
    ])
    expect(out).toEqual([
      { tick: 0, lane: 1, sustain: 0 },
      { tick: 0, lane: 3, sustain: 96 },
      { tick: 192, lane: 2, sustain: 0 },
    ])
  })

  it('preserves modifiers, slide ids, and real-note fields', () => {
    const out = normalizeSequence([
      { tick: 100, lane: 0, sustain: 48, slideId: 3, type: 'real', pack: 'p1', scale: 'minor' },
    ])
    expect(out).toEqual([
      { tick: 0, lane: 0, sustain: 48, slideId: 3, type: 'real', pack: 'p1', scale: 'minor' },
    ])
  })

  it('returns [] for empty input', () => {
    expect(normalizeSequence([])).toEqual([])
  })
})

describe('materializeSequence', () => {
  const base = { sourceResolution: 192, targetResolution: 192, scale: 1, baseTick: 0, slideIdStart: 1 }

  it('offsets every note by baseTick', () => {
    const out = materializeSequence(
      [{ tick: 0, lane: 0, sustain: 0 }, { tick: 192, lane: 1, sustain: 96 }],
      { ...base, baseTick: 768 },
    )
    expect(out).toEqual([
      { tick: 768, lane: 0, sustain: 0 },
      { tick: 960, lane: 1, sustain: 96 },
    ])
  })

  it('rescales ticks and sustains across resolutions (192 → 480)', () => {
    const out = materializeSequence(
      [{ tick: 96, lane: 0, sustain: 48 }],
      { ...base, sourceResolution: 192, targetResolution: 480 },
    )
    expect(out).toEqual([{ tick: 240, lane: 0, sustain: 120 }])
  })

  it('applies the x2 / x0.5 paste scale to offsets and sustains', () => {
    const notes = [{ tick: 192, lane: 0, sustain: 96 }]
    expect(materializeSequence(notes, { ...base, scale: 2 }))
      .toEqual([{ tick: 384, lane: 0, sustain: 192 }])
    expect(materializeSequence(notes, { ...base, scale: 0.5 }))
      .toEqual([{ tick: 96, lane: 0, sustain: 48 }])
  })

  it('re-issues slide ids starting at slideIdStart, preserving grouping', () => {
    const out = materializeSequence(
      [
        { tick: 0, lane: 0, sustain: 0, slideId: 9 },
        { tick: 192, lane: 1, sustain: 0, slideId: 9 },
        { tick: 384, lane: 2, sustain: 0, slideId: 12 },
      ],
      { ...base, slideIdStart: 5 },
    )
    expect(out.map((n) => n.slideId)).toEqual([5, 5, 6])
  })

  it('drops duplicate (tick, lane) collisions produced by rounding, keeping the first', () => {
    // x0.5 on two notes 1 tick apart in the same lane collapses them.
    const out = materializeSequence(
      [
        { tick: 0, lane: 3, sustain: 0 },
        { tick: 1, lane: 3, sustain: 0 },
      ],
      { ...base, scale: 0.5 },
    )
    expect(out).toEqual([{ tick: 0, lane: 3, sustain: 0 }])
  })
})
