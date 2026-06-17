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

describe('drum Pro Drums mapping', () => {
  const lanesByTick = (notes: ChartNote[]) =>
    notes.slice().sort((a, b) => a.tick - b.tick || a.lane - b.lane).map((n) => [n.tick, n.lane])

  it('serializes hi-hat and cymbal lanes with their cymbal modifier notes', () => {
    const text = replaceSectionNotes(BASE, 'ExpertDrums', [
      { tick: 0, lane: 2, sustain: 0 }, // hi-hat
      { tick: 0, lane: 4, sustain: 0 }, // cymbal
    ])
    expect(text).toContain('0 = N 2 0')
    expect(text).toContain('0 = N 66 0') // yellow cymbal flag → Hats
    expect(text).toContain('0 = N 4 0')
    expect(text).toContain('0 = N 68 0') // green cymbal flag → Crash
  })

  it('round-trips all five editor drum lanes losslessly', () => {
    const notes: ChartNote[] = [
      { tick: 0, lane: 0, sustain: 0 }, // kick
      { tick: 0, lane: 2, sustain: 0 }, // hi-hat
      { tick: 192, lane: 1, sustain: 0 }, // snare
      { tick: 192, lane: 4, sustain: 0 }, // cymbal
      { tick: 384, lane: 3, sustain: 0 }, // tom
    ]
    expect(lanesByTick(roundTrip(notes, 'ExpertDrums'))).toEqual([
      [0, 0], [0, 2], [192, 1], [192, 4], [384, 3],
    ])
  })

  it('legacy drum charts (no modifiers) keep note-number = lane', () => {
    const legacy = `[ExpertDrums]
{
  0 = N 2 0
  192 = N 4 0
  384 = N 3 0
}
`
    expect(lanesByTick(parseSectionNotes(legacy, 'ExpertDrums', RES))).toEqual([[0, 2], [192, 4], [384, 3]])
  })

  it('Pro Drums charts: modifiers promote pads, bare pads stay toms', () => {
    const pro = `[ExpertDrums]
{
  0 = N 2 0
  0 = N 66 0
  192 = N 3 0
  384 = N 4 0
  384 = N 68 0
}
`
    // 0: yellow+flag → hi-hat(2); 192: bare blue pad → tom(3); 384: green+flag → cymbal(4)
    expect(lanesByTick(parseSectionNotes(pro, 'ExpertDrums', RES))).toEqual([[0, 2], [192, 3], [384, 4]])
  })

  it('numbered drum sections are detected too', () => {
    const text = replaceSectionNotes(BASE, 'ExpertDrums2', [{ tick: 0, lane: 2, sustain: 0 }])
    expect(text).toContain('0 = N 66 0')
  })

  it('Floor Tom (lane 5) is the bare green pad; Cymbal keeps the flag', () => {
    const text = replaceSectionNotes(BASE, 'ExpertDrums', [
      { tick: 0, lane: 5, sustain: 0 }, // floor tom → bare N4
      { tick: 192, lane: 4, sustain: 0 }, // cymbal → N4 + N68
    ])
    // tick 0: bare green pad, no flag
    expect(text).toMatch(/0 = N 4 0/)
    expect(text).not.toMatch(/0 = N 68 0/)
    // tick 192: green pad + crash flag
    expect(text).toMatch(/192 = N 4 0/)
    expect(text).toMatch(/192 = N 68 0/)
    // round-trips: floor tom on 5, cymbal on 4
    expect(lanesByTick(parseSectionNotes(text, 'ExpertDrums', RES))).toEqual([[0, 5], [192, 4]])
  })

  it('explicit isDrums applies Pro Drums mapping to a [*Single] section', () => {
    // The editor stores drum beatmaps in [*Single] sections, so name-based
    // detection is false — the isDrums arg must drive the translation.
    const text = replaceSectionNotes(BASE, 'ExpertSingle', [
      { tick: 0, lane: 2, sustain: 0 }, // hi-hat
      { tick: 192, lane: 5, sustain: 0 }, // floor tom
    ], true)
    expect(text).toContain('0 = N 66 0') // hi-hat cymbal flag emitted
    expect(text).toMatch(/192 = N 4 0/) // floor tom = bare green pad
    // Without the flag, parsing back as drums recovers the lanes:
    expect(lanesByTick(parseSectionNotes(text, 'ExpertSingle', RES, true))).toEqual([[0, 2], [192, 5]])
    // And the same text parsed as guitar (isDrums=false) does NOT translate:
    expect(parseSectionNotes(text, 'ExpertSingle', RES, false).some((n) => n.lane === 66)).toBe(true)
  })

  it('round-trips all six drum lanes', () => {
    const notes: ChartNote[] = [
      { tick: 0, lane: 0, sustain: 0 },
      { tick: 0, lane: 2, sustain: 0 },
      { tick: 192, lane: 1, sustain: 0 },
      { tick: 192, lane: 3, sustain: 0 },
      { tick: 384, lane: 4, sustain: 0 },
      { tick: 576, lane: 5, sustain: 0 },
    ]
    expect(lanesByTick(roundTrip(notes, 'ExpertDrums'))).toEqual([
      [0, 0], [0, 2], [192, 1], [192, 3], [384, 4], [576, 5],
    ])
  })
})
