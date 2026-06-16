import { describe, expect, it } from 'vitest'

import { fitTapTempoBpm } from './tapsync'

// Deterministic pseudo-random jitter so the test is stable across runs.
function seeded(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296 - 0.5 // [-0.5, 0.5)
  }
}

function tapsAt(bpm: number, count: number, jitterSec = 0, seed = 1): number[] {
  const period = 60 / bpm
  const rnd = seeded(seed)
  const out: number[] = []
  for (let i = 0; i < count; i++) out.push(1.234 + i * period + (jitterSec ? rnd() * 2 * jitterSec : 0))
  return out
}

describe('fitTapTempoBpm', () => {
  it('returns null below 3 taps', () => {
    expect(fitTapTempoBpm([])).toBeNull()
    expect(fitTapTempoBpm([1])).toBeNull()
    expect(fitTapTempoBpm([1, 1.667])).toBeNull()
  })

  it('recovers an exact tempo', () => {
    expect(fitTapTempoBpm(tapsAt(90, 16))).toBeCloseTo(90, 3)
    expect(fitTapTempoBpm(tapsAt(128, 32))).toBeCloseTo(128, 3)
  })

  it('stays accurate with realistic jitter over many taps', () => {
    // ±25 ms human jitter, 130 taps — the case that exposed the old bug.
    const bpm = fitTapTempoBpm(tapsAt(90, 130, 0.025, 7))
    expect(bpm).not.toBeNull()
    expect(bpm as number).toBeGreaterThan(89)
    expect(bpm as number).toBeLessThan(91)
  })

  it('does not drift with a slightly-off period (no off-by-one accumulation)', () => {
    // Period that is not a round number — the regime where indexing from the
    // first tap accumulated rounding error and made the fit jump.
    const bpm = fitTapTempoBpm(tapsAt(93.7, 120, 0.02, 3))
    expect(bpm as number).toBeCloseTo(93.7, 0)
  })

  it('tolerates an occasional skipped beat', () => {
    const full = tapsAt(100, 40)
    // Drop a few interior taps (user missed those beats entirely).
    const withGaps = full.filter((_, i) => i !== 10 && i !== 21 && i !== 30)
    expect(fitTapTempoBpm(withGaps) as number).toBeCloseTo(100, 0)
  })

  it('is order-independent', () => {
    const t = tapsAt(110, 20, 0.01, 5)
    const shuffled = [...t].reverse()
    expect(fitTapTempoBpm(shuffled)).toBeCloseTo(fitTapTempoBpm(t) as number, 6)
  })
})
