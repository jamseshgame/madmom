import { describe, expect, it } from 'vitest'

import { averageBpm, scaleTempoMarkersToAverage, secondsAtTick } from './tempoScale'

const RES = 192

describe('secondsAtTick', () => {
  it('walks a piecewise map', () => {
    const m = [{ tick: 0, microBpm: 120000 }, { tick: 384, microBpm: 60000 }]
    expect(secondsAtTick(m, RES, 0)).toBe(0)
    expect(secondsAtTick(m, RES, 192)).toBeCloseTo(0.5, 9)
    expect(secondsAtTick(m, RES, 384)).toBeCloseTo(1.0, 9)
    expect(secondsAtTick(m, RES, 576)).toBeCloseTo(2.0, 9)
  })
})

describe('averageBpm', () => {
  it('is the marker for a constant-tempo chart', () => {
    expect(averageBpm([{ tick: 0, microBpm: 128000 }], RES, 192 * 400)).toBeCloseTo(128, 6)
  })

  it('is the song tempo, not the lead-in, for a beat-anchored chart', () => {
    // 1 lead-in beat at 157.9 BPM, then 400 beats at 152.
    const m = [{ tick: 0, microBpm: 157885 }, { tick: 192, microBpm: 152000 }]
    const avg = averageBpm(m, RES, 192 * 401)
    expect(avg).toBeGreaterThan(151.99)
    expect(avg).toBeLessThan(152.03)
  })
})

describe('scaleTempoMarkersToAverage', () => {
  it('sets a constant-tempo chart to exactly the target', () => {
    const out = scaleTempoMarkersToAverage([{ tick: 0, microBpm: 128000 }], RES, 192 * 100, 130)
    expect(out).toEqual([{ tick: 0, microBpm: 130000 }])
  })

  it('does not drag a beat-anchored chart down to the lead-in ratio (the drift bug)', () => {
    // The regression: Tap sync measured 152 (correct), and the old code
    // scaled everything by 152 / 157.9, turning the song into 146 BPM.
    const m = [{ tick: 0, microBpm: 157885 }, { tick: 192, microBpm: 152000 }]
    const out = scaleTempoMarkersToAverage(m, RES, 192 * 401, 151.996)
    expect(out[1].microBpm).toBeGreaterThan(151900)
    expect(out[1].microBpm).toBeLessThan(152100)
    expect(averageBpm(out, RES, 192 * 401)).toBeCloseTo(151.996, 2)
  })

  it('keeps the shape of a multi-marker map', () => {
    const m = [{ tick: 0, microBpm: 100000 }, { tick: 192 * 16, microBpm: 120000 }, { tick: 192 * 32, microBpm: 90000 }]
    const out = scaleTempoMarkersToAverage(m, RES, 192 * 48, 110)
    const ratios = out.map((o, i) => o.microBpm / m[i].microBpm)
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeLessThan(1e-4)
    expect(averageBpm(out, RES, 192 * 48)).toBeCloseTo(110, 2)
    expect(out.map((o) => o.tick)).toEqual(m.map((x) => x.tick))
  })

  it('never produces a marker below 1 BPM', () => {
    const out = scaleTempoMarkersToAverage([{ tick: 0, microBpm: 120000 }], RES, 192, 0)
    expect(out[0].microBpm).toBeGreaterThanOrEqual(1000)
  })
})
