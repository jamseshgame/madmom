import { describe, it, expect } from 'vitest'
import { checkNoteRules, autoCleanNotes, ruleRemovalCount, type RuleNote } from './noteRules'

const RES = 192
const n = (tick: number, lane: number, extra: Partial<RuleNote> = {}): RuleNote => ({ tick, lane, ...extra })

describe('checkNoteRules', () => {
  it('passes a clean chart (single notes + a legal 2-note chord)', () => {
    expect(checkNoteRules([n(0, 0), n(192, 1), n(384, 0), n(384, 2)], RES)).toBeNull()
  })

  it('flags a tick with 3 gem notes', () => {
    const msg = checkNoteRules([n(528, 0), n(528, 1), n(528, 2)], RES)
    expect(msg).toMatch(/Max 2 notes per beat \(tick 528 has 3\)/)
  })

  it('flags an open note chorded with a gem', () => {
    expect(checkNoteRules([n(0, 7), n(0, 2)], RES)).toMatch(/Open notes can't be chorded/)
  })

  it('flags a misaligned (near-miss) chord', () => {
    expect(checkNoteRules([n(0, 0), n(2, 1)], RES)).toMatch(/Chord notes must share a tick/)
  })

  it('ignores modifiers (lanes 5/6) and slide-tagged notes for R1', () => {
    expect(checkNoteRules([n(0, 0), n(0, 5), n(0, 6)], RES)).toBeNull()
    expect(checkNoteRules([n(0, 0, { slideId: 1 }), n(0, 1, { slideId: 1 }), n(0, 2, { slideId: 1 })], RES)).toBeNull()
  })
})

describe('autoCleanNotes', () => {
  it('returns null for an already-clean chart', () => {
    expect(autoCleanNotes([n(0, 0), n(192, 1)], RES)).toBeNull()
  })

  it('trims an over-full tick down to 2 notes', () => {
    const cleaned = autoCleanNotes([n(528, 0), n(528, 1), n(528, 2)], RES)
    expect(cleaned).toHaveLength(2)
    expect(checkNoteRules(cleaned!, RES)).toBeNull()
  })

  it('drops the open note when chorded with a gem', () => {
    const cleaned = autoCleanNotes([n(0, 7), n(0, 2)], RES)
    expect(cleaned).toEqual([n(0, 2)])
  })

  it('always produces a chart that passes checkNoteRules', () => {
    const dirty: RuleNote[] = [
      n(528, 0), n(528, 1), n(528, 2), n(528, 3), // 4-note pile-up
      n(700, 0), n(702, 1), // misaligned chord
      n(900, 7), n(900, 0), // open + gem
      n(1100, 4), // clean single
    ]
    const cleaned = autoCleanNotes(dirty, RES)
    expect(cleaned).not.toBeNull()
    expect(checkNoteRules(cleaned!, RES)).toBeNull()
    // The clean single survives untouched.
    expect(cleaned).toContainEqual(n(1100, 4))
  })

  it('preserves extra note fields on survivors (generic passthrough)', () => {
    type RichNote = RuleNote & { sustain: number }
    const rich: RichNote[] = [
      { tick: 0, lane: 0, sustain: 96 },
      { tick: 0, lane: 1, sustain: 0 },
      { tick: 0, lane: 2, sustain: 0 },
    ]
    const cleaned = autoCleanNotes(rich, RES)
    expect(cleaned).toHaveLength(2)
    expect(cleaned![0]).toMatchObject({ tick: 0, lane: 0, sustain: 96 })
  })
})

describe('ruleRemovalCount — the commit-gate dirtiness score', () => {
  it('is 0 for a clean chart', () => {
    expect(ruleRemovalCount([n(0, 0), n(192, 1)], RES)).toBe(0)
  })

  it('counts the notes that must be stripped', () => {
    expect(ruleRemovalCount([n(528, 0), n(528, 1), n(528, 2)], RES)).toBe(1)
  })

  it('lets a user delete out of an already-dirty chart (score never rises)', () => {
    const dirty = [n(528, 0), n(528, 1), n(528, 2), n(700, 0)]
    const before = ruleRemovalCount(dirty, RES)
    // Delete one of the over-full tick's notes → 2 remain at tick 528.
    const after = ruleRemovalCount([n(528, 0), n(528, 1), n(700, 0)], RES)
    expect(before).toBe(1)
    expect(after).toBe(0)
    expect(after).toBeLessThanOrEqual(before) // gate allows the edit
  })

  it('blocks adding a fresh violation to a clean chart', () => {
    const before = ruleRemovalCount([n(0, 0), n(0, 1)], RES)
    const after = ruleRemovalCount([n(0, 0), n(0, 1), n(0, 2)], RES)
    expect(before).toBe(0)
    expect(after).toBeGreaterThan(before) // gate rejects the edit
  })

  it('allows an unrelated edit on a dirty chart (score unchanged)', () => {
    const before = ruleRemovalCount([n(528, 0), n(528, 1), n(528, 2)], RES)
    // Add a clean note far away — dirtiness stays the same.
    const after = ruleRemovalCount([n(528, 0), n(528, 1), n(528, 2), n(2000, 0)], RES)
    expect(after).toBe(before)
  })
})

describe('drum kick exception (isDrums)', () => {
  it('allows kick + 2 hand gems (3 total) on one tick', () => {
    // Kick(0) + Snare(1) + Hi-hat(2): illegal for guitar, legal for drums.
    expect(checkNoteRules([n(0, 0), n(0, 1), n(0, 2)], RES)).toMatch(/Max 2 notes/)
    expect(checkNoteRules([n(0, 0), n(0, 1), n(0, 2)], RES, true)).toBeNull()
  })

  it('still blocks 3 hand gems even with no kick', () => {
    // Snare+Hi-hat+Tom = 3 hands, no kick → over the limit.
    expect(checkNoteRules([n(0, 1), n(0, 2), n(0, 3)], RES, true)).toMatch(/Max 2 drum notes/)
  })

  it('still blocks 4 notes even with a kick (only 2 hands)', () => {
    expect(checkNoteRules([n(0, 0), n(0, 1), n(0, 2), n(0, 3)], RES, true)).toMatch(/Max 2 drum notes/)
  })

  it('autoClean keeps the kick + 2 hands, drops the extra hand', () => {
    const cleaned = autoCleanNotes([n(0, 0), n(0, 1), n(0, 2), n(0, 3)], RES, true)
    expect(cleaned).toHaveLength(3)
    expect(cleaned!.some((x) => x.lane === 0)).toBe(true) // kick survives
    expect(checkNoteRules(cleaned!, RES, true)).toBeNull()
  })

  it('a kick+2-hand drum tick is clean (no removals)', () => {
    expect(ruleRemovalCount([n(0, 0), n(0, 1), n(0, 2)], RES, true)).toBe(0)
  })

  it('counts Floor Tom (lane 5) as a hand gem in drums', () => {
    // kick + snare + floor-tom = kick + 2 hands → legal
    expect(checkNoteRules([n(0, 0), n(0, 1), n(0, 5)], RES, true)).toBeNull()
    // snare + cymbal + floor-tom = 3 hands, no kick → illegal
    expect(checkNoteRules([n(0, 1), n(0, 4), n(0, 5)], RES, true)).toMatch(/Max 2 drum notes/)
  })

  it('for guitar, lane 5 stays a modifier (not a gem)', () => {
    expect(checkNoteRules([n(0, 1), n(0, 4), n(0, 5)], RES, false)).toBeNull()
  })
})
