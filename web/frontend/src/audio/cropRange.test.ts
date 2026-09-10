import { describe, expect, it } from 'vitest'

import { clampRange, formatTime, parseTime } from './cropRange'

describe('formatTime', () => {
  it('renders minutes, seconds and milliseconds', () => {
    expect(formatTime(83.456)).toBe('1:23.456')
  })

  it('pads seconds and milliseconds', () => {
    expect(formatTime(4.2)).toBe('0:04.200')
  })

  it('handles times past ten minutes without truncating', () => {
    expect(formatTime(725.01)).toBe('12:05.010')
  })

  it('clamps a negative time to zero rather than printing a minus', () => {
    expect(formatTime(-3)).toBe('0:00.000')
  })
})

describe('parseTime', () => {
  it('reads back what formatTime writes', () => {
    expect(parseTime('1:23.456')).toBeCloseTo(83.456, 3)
  })

  it('accepts a bare seconds value', () => {
    expect(parseTime('83.456')).toBeCloseTo(83.456, 3)
  })

  it('accepts minutes and seconds with no fraction', () => {
    expect(parseTime('2:05')).toBe(125)
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseTime('  0:04.200 ')).toBeCloseTo(4.2, 3)
  })

  it('rejects nonsense instead of guessing', () => {
    expect(parseTime('later')).toBeNull()
    expect(parseTime('')).toBeNull()
    expect(parseTime('1:2:3')).toBeNull()
  })
})

describe('clampRange', () => {
  const duration = 100

  it('leaves a valid range alone', () => {
    expect(clampRange({ start: 10, end: 90 }, duration)).toEqual({ start: 10, end: 90 })
  })

  it('pulls a negative start up to zero', () => {
    expect(clampRange({ start: -5, end: 90 }, duration).start).toBe(0)
  })

  it('pulls an end past the audio back to the duration', () => {
    expect(clampRange({ start: 10, end: 150 }, duration).end).toBe(100)
  })

  it('keeps the end at least a minimum span above the start', () => {
    // Dragging the end handle onto the start would otherwise produce an empty
    // crop the backend rejects.
    const { start, end } = clampRange({ start: 50, end: 50 }, duration, 0.25)
    expect(end - start).toBeCloseTo(0.25, 6)
  })

  it('pushes the start back when the handles collide at the very end', () => {
    // No room to move the end right, so the start has to give instead.
    const { start, end } = clampRange({ start: 100, end: 100 }, duration, 0.25)
    expect(end).toBe(100)
    expect(start).toBeCloseTo(99.75, 6)
  })

  it('gives up on a duration too short for the minimum span', () => {
    expect(clampRange({ start: 0, end: 0.1 }, 0.1, 0.25)).toEqual({ start: 0, end: 0.1 })
  })
})
