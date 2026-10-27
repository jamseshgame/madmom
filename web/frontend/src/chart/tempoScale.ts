/**
 * Whole-chart tempo scaling for the Audio-sync panel and Tap-sync.
 *
 * The tempo "fine-tune" used to read and write the tick-0 `B` marker and
 * scale every other marker by `target / tick0`. That is only right when the
 * tick-0 marker *is* the song's tempo — true of the old constant-BPM charts,
 * false of every beat-anchored (V3) chart, whose tick-0 marker is a lead-in
 * segment covering the audio before the first detected beat at some
 * arbitrary tempo. Setting that chart "to 152 BPM" (its real tempo, as Tap
 * sync correctly measured) computed ratio = 152 / 157.9 and dragged the
 * whole song from 152 down to 146 BPM — notes 3.7 % late and getting later
 * through the song, invisible at the start.
 *
 * These helpers work on the chart's *average* tempo over the charted span
 * instead: beats ÷ seconds. Setting it to X scales every marker by X / avg,
 * which leaves a constant-tempo chart's one marker at exactly X and keeps a
 * multi-marker map's shape. Tick 0 (and therefore `Offset`) is the pivot.
 */

export interface TempoMarkerLike {
  tick: number
  microBpm: number // BPM × 1000, the integer .chart "B" value
}

/** Seconds from tick 0 to `tick` under a piecewise-constant tempo map. */
export function secondsAtTick(markers: TempoMarkerLike[], resolution: number, tick: number): number {
  const sorted = [...markers].sort((a, b) => a.tick - b.tick)
  if (sorted.length === 0) return (tick / resolution) * 0.5
  let sec = 0
  for (let i = 0; i < sorted.length; i++) {
    const start = Math.max(0, sorted[i].tick)
    const end = i + 1 < sorted.length ? sorted[i + 1].tick : Infinity
    if (tick <= start) break
    const span = Math.min(tick, end) - start
    sec += (span / resolution) * (60000 / sorted[i].microBpm)
  }
  return sec
}

/**
 * Average tempo (BPM) over ticks 0…endTick — the number a player feels as
 * "the song's BPM" however many markers the map has. `endTick` should be the
 * last note (or the chart's end); it is clamped to at least one beat.
 */
export function averageBpm(markers: TempoMarkerLike[], resolution: number, endTick: number): number {
  const end = Math.max(resolution, endTick)
  const sec = secondsAtTick(markers, resolution, end)
  if (!(sec > 0)) return markers[0] ? markers[0].microBpm / 1000 : 120
  return (end / resolution) * 60 / sec
}

/**
 * Scale every marker so the average tempo over ticks 0…endTick becomes
 * `targetBpm`. Relative tempo structure (lead-in, ritardandi, section
 * changes) is preserved; only the overall rate changes. Returns a new array.
 */
export function scaleTempoMarkersToAverage(
  markers: TempoMarkerLike[],
  resolution: number,
  endTick: number,
  targetBpm: number,
): TempoMarkerLike[] {
  const avg = averageBpm(markers, resolution, endTick)
  const ratio = Math.max(1, targetBpm) / avg
  return markers.map((m) => ({ ...m, microBpm: Math.max(1000, Math.round(m.microBpm * ratio)) }))
}
