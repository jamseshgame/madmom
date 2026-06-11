import { describe, expect, it } from 'vitest'
import { parseSectionNotes, replaceSectionNotes, type ChartNote } from './chartio'

const RES = 192

const BASE = `[Song]
{
  Resolution = 192
}
[ExpertSingle]
{
  0 = N 0 0
  192 = N 1 0
}
[HardSingle]
{
  0 = N 0 0
  192 = N 1 0
}
`

function roundTrip(notes: ChartNote[], name = 'ExpertSingle'): ChartNote[] {
  const text = replaceSectionNotes(BASE, name, notes)
  return parseSectionNotes(text, name, RES)
}

function groups(notes: ChartNote[]): Map<number, { tick: number; lane: number }[]> {
  const g = new Map<number, { tick: number; lane: number }[]>()
  for (const n of notes) {
    if (n.slideId == null) continue
    const arr = g.get(n.slideId) ?? []
    arr.push({ tick: n.tick, lane: n.lane })
    g.set(n.slideId, arr)
  }
  for (const arr of g.values()) arr.sort((a, b) => a.tick - b.tick || a.lane - b.lane)
  return g
}

describe('slide round-trip via SlideMeta', () => {
  it('a 3-position slide survives exactly', () => {
    const rt = roundTrip([
      { tick: 0, lane: 0, sustain: 0, slideId: 1 },
      { tick: 192, lane: 1, sustain: 0, slideId: 1 },
      { tick: 384, lane: 2, sustain: 0, slideId: 1 },
    ])
    expect([...groups(rt).values()]).toEqual([[
      { tick: 0, lane: 0 }, { tick: 192, lane: 1 }, { tick: 384, lane: 2 },
    ]])
  })

  it('an unrelated note between the last marker and the end no longer steals the end', () => {
    const rt = roundTrip([
      { tick: 0, lane: 0, sustain: 0, slideId: 1 },
      { tick: 192, lane: 1, sustain: 0, slideId: 1 },
      { tick: 384, lane: 4, sustain: 0, slideId: 1 },   // true end
      { tick: 288, lane: 0, sustain: 0 },               // innocent bystander
    ])
    const g = groups(rt)
    expect(g.size).toBe(1)
    expect([...g.values()][0]).toEqual([
      { tick: 0, lane: 0 }, { tick: 192, lane: 1 }, { tick: 384, lane: 4 },
    ])
    // The bystander stays a plain note.
    expect(rt.find((n) => n.tick === 288)?.slideId).toBeUndefined()
  })

  it('two slides within two beats of each other stay separate', () => {
    const rt = roundTrip([
      { tick: 0, lane: 0, sustain: 0, slideId: 1 },
      { tick: 192, lane: 1, sustain: 0, slideId: 1 },
      { tick: 384, lane: 3, sustain: 0, slideId: 2 },
      { tick: 576, lane: 4, sustain: 0, slideId: 2 },
    ])
    const g = groups(rt)
    expect(g.size).toBe(2)
    expect([...g.values()]).toEqual([
      [{ tick: 0, lane: 0 }, { tick: 192, lane: 1 }],
      [{ tick: 384, lane: 3 }, { tick: 576, lane: 4 }],
    ])
  })

  it('a slide end keeps its sustain (slide into a hold)', () => {
    const rt = roundTrip([
      { tick: 0, lane: 0, sustain: 0, slideId: 1 },
      { tick: 192, lane: 1, sustain: 384, slideId: 1 },
    ])
    expect(rt.find((n) => n.tick === 192)).toMatchObject({ lane: 1, sustain: 384, slideId: 1 })
  })

  it('round trip is a fixed point (parse → serialize → parse is stable)', () => {
    const notes: ChartNote[] = [
      { tick: 0, lane: 0, sustain: 0, slideId: 3 },
      { tick: 96, lane: 1, sustain: 0, slideId: 3 },
      { tick: 192, lane: 2, sustain: 96, slideId: 3 },
      { tick: 480, lane: 4, sustain: 0 },
    ]
    const t1 = replaceSectionNotes(BASE, 'ExpertSingle', notes)
    const n1 = parseSectionNotes(t1, 'ExpertSingle', RES)
    const t2 = replaceSectionNotes(t1, 'ExpertSingle', n1)
    expect(t2).toBe(t1)
  })

  it('rewriting one difficulty leaves another difficulty and its SlideMeta untouched', () => {
    // Author slides on Hard, flush them to text.
    const hardNotes: ChartNote[] = [
      { tick: 0, lane: 0, sustain: 0, slideId: 1 },
      { tick: 192, lane: 1, sustain: 0, slideId: 1 },
      { tick: 384, lane: 2, sustain: 0, slideId: 1 },
    ]
    const withHard = replaceSectionNotes(BASE, 'HardSingle', hardNotes)
    // Now edit Expert (e.g. make a slide there too) and rewrite it.
    const expertNotes: ChartNote[] = [
      { tick: 0, lane: 0, sustain: 0, slideId: 1 },
      { tick: 192, lane: 1, sustain: 0, slideId: 1 },
    ]
    const after = replaceSectionNotes(withHard, 'ExpertSingle', expertNotes)
    // Hard parses back with its slide fully intact.
    const hardBack = parseSectionNotes(after, 'HardSingle', RES)
    expect([...groups(hardBack).values()]).toEqual([[
      { tick: 0, lane: 0 }, { tick: 192, lane: 1 }, { tick: 384, lane: 2 },
    ]])
  })

  it('legacy charts without SlideMeta still import slides heuristically', () => {
    const legacy = `[ExpertSingle]
{
  0 = E slide 0
  192 = N 1 0
  192 = E slide 1
  384 = N 2 0
}
`
    const notes = parseSectionNotes(legacy, 'ExpertSingle', RES)
    expect(groups(notes).size).toBe(1)
  })

  it('an empty SlideMeta block is authoritative: stray E slide lines do not resurrect slides', () => {
    const text = `[ExpertSingle]
{
  0 = E slide 0
  192 = N 1 0
}
[SlideMeta_ExpertSingle]
{
}
`
    const notes = parseSectionNotes(text, 'ExpertSingle', RES)
    expect(groups(notes).size).toBe(0)
  })

  it('removing all slides rewrites an existing SlideMeta block to empty', () => {
    const withSlide = replaceSectionNotes(BASE, 'ExpertSingle', [
      { tick: 0, lane: 0, sustain: 0, slideId: 1 },
      { tick: 192, lane: 1, sustain: 0, slideId: 1 },
    ])
    const cleared = replaceSectionNotes(withSlide, 'ExpertSingle', [
      { tick: 0, lane: 0, sustain: 0 },
      { tick: 192, lane: 1, sustain: 0 },
    ])
    expect(cleared).toContain('[SlideMeta_ExpertSingle]')
    expect(parseSectionNotes(cleared, 'ExpertSingle', RES).every((n) => n.slideId == null)).toBe(true)
  })

  it('real-note fields and star power passthrough survive alongside slides', () => {
    const text = `[ExpertSingle]
{
  0 = S 2 192
  0 = E realnotes_pack guitar1
  0 = E realnotes_scale minor
  0 = R 0 0
}
`
    const notes = parseSectionNotes(text, 'ExpertSingle', RES)
    expect(notes[0]).toMatchObject({ type: 'real', pack: 'guitar1', scale: 'minor' })
    const out = replaceSectionNotes(text, 'ExpertSingle', notes)
    expect(out).toContain('0 = S 2 192')
    expect(out).toContain('0 = E realnotes_pack guitar1')
  })
})
