// Pure helpers behind the stem-crop modal: the time format its fields use and
// the clamping that keeps a dragged range legal before it reaches the backend.

export interface CropRange {
  start: number
  end: number
}

/** `m:ss.mmm` — the format the crop fields both render and accept. */
export function formatTime(sec: number): string {
  const t = Math.max(0, sec)
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  const ms = Math.round((t - Math.floor(t)) * 1000)
  // Rounding 4.9999 up to 5000 ms would print "0:04.1000".
  const carry = ms === 1000
  return `${m}:${String(carry ? s + 1 : s).padStart(2, '0')}.${String(carry ? 0 : ms).padStart(3, '0')}`
}

/** Parse `m:ss.mmm` or a bare seconds value. Returns null for anything else. */
export function parseTime(text: string): number | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const parts = trimmed.split(':')
  if (parts.length > 2) return null
  const nums = parts.map((p) => (/^\d*\.?\d*$/.test(p) && p !== '' ? Number(p) : NaN))
  if (nums.some((n) => !isFinite(n))) return null
  return nums.length === 2 ? nums[0] * 60 + nums[1] : nums[0]
}

/**
 * Force a dragged range inside [0, duration] while keeping at least `minSpan`
 * between the handles — an empty or inverted range is rejected by the backend,
 * so it never gets to leave the modal.
 */
export function clampRange(range: CropRange, duration: number, minSpan = 0.25): CropRange {
  if (duration <= minSpan) return range
  let start = Math.min(Math.max(0, range.start), duration)
  let end = Math.min(Math.max(0, range.end), duration)
  if (end - start < minSpan) {
    // Prefer moving the end; fall back to the start when there's no room right.
    end = start + minSpan
    if (end > duration) {
      end = duration
      start = duration - minSpan
    }
  }
  return { start, end }
}
