/**
 * Tap-sync tempo fitting.
 *
 * Given a list of tap timestamps (audio seconds) collected while the user taps
 * along to the beat, estimate the underlying tempo in BPM. Robustness is the
 * whole point: human taps jitter by tens of milliseconds, the occasional beat
 * gets skipped or double-tapped, and the run can be 100+ taps long.
 *
 * The estimator:
 *   1. Sorts taps and takes the *median* inter-tap interval as a coarse, outlier
 *      -resistant period.
 *   2. Assigns each tap a beat index *incrementally* — rounding each gap to a
 *      whole number of beats relative to the previous tap. Indexing from the
 *      first tap instead lets a slightly-wrong period accumulate into off-by-one
 *      errors over a long run, which makes the fitted BPM lurch around.
 *   3. Least-squares fits time = a + b·index; the slope b is seconds/beat, so
 *      BPM = 60 / b. Using the full time span (not just the mean gap) keeps the
 *      estimate tight as taps accumulate.
 */
export function fitTapTempoBpm(taps: number[]): number | null {
  if (taps.length < 3) return null
  const sorted = [...taps].sort((a, b) => a - b)

  const intervals: number[] = []
  for (let i = 1; i < sorted.length; i++) intervals.push(sorted[i] - sorted[i - 1])
  const med = [...intervals].sort((a, b) => a - b)[Math.floor(intervals.length / 2)]
  if (!(med > 0.05)) return null // < ~50 ms median → not real beats

  // Incremental beat indices (see header). max(1, …) keeps indices strictly
  // increasing so a near-duplicate tap can't collapse two beats onto one index.
  const ks = [0]
  for (let i = 1; i < sorted.length; i++) {
    ks.push(ks[i - 1] + Math.max(1, Math.round((sorted[i] - sorted[i - 1]) / med)))
  }

  // Least-squares slope of time = a + b·index.
  const n = ks.length
  const sk = ks.reduce((a, b) => a + b, 0)
  const st = sorted.reduce((a, b) => a + b, 0)
  const skk = ks.reduce((a, b) => a + b * b, 0)
  const skt = ks.reduce((a, b, i) => a + b * sorted[i], 0)
  const den = n * skk - sk * sk
  if (den === 0) return null
  const slope = (n * skt - sk * st) / den
  if (!(slope > 0)) return null
  return 60 / slope
}
