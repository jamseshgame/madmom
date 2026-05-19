# Hold & Slide Bars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render holds and slides as coloured bars in the beatmap editor's 2D view and 3D runway, and make slides a first-class, editable concept.

**Architecture:** Slides become note metadata — each `ChartNote` gains an optional `slideId`; a slide is the set of notes sharing that id. A new pure module `chart/slides.ts` parses `E slide` chart events into `slideId` tags (synthesizing the start gem) and serializes them back. The 2D canvas draws a per-segment diagonal ribbon; the 3D runway draws pooled emissive cylinder "tubes" for both hold sustains and slide segments. Editing is "tag-a-run": select notes, "Make slide".

**Tech Stack:** React 18 + TypeScript + Vite, HTML canvas 2D, three.js 0.184. Vitest (added by this plan) for unit tests.

**Spec:** `docs/superpowers/specs/2026-05-19-hold-slide-bars-design.md`

**Spec refinements made during planning (flag to reviewer):**
1. Spec §5.1 says ungroupable `E slide` events go "to passthrough". The plan instead **always forms a slide** from every `E slide` run (gap heuristic) — simpler and strictly lossless, since no event is ever dropped. No passthrough bucket is needed.
2. Spec §5.1's claim that `E slide` is "routed into `sceneEventsPassthrough`" was wrong about current behaviour: `E slide` lines live in the difficulty section and survive via `replaceSectionNotes` keeping unrecognized lines. The plan strips them there once the model owns them.
3. Spec §5.5's "clicking a slide ribbon selects the whole group" is **deferred** — it needs canvas point-to-segment hit-testing. Drag-select across a slide's notes works for all editing. Listed as a follow-up.
4. Spec §6 asks for an automated round-trip test on the real guitar chart. The chart parser/serializer is embedded in `BeatmapEditor.tsx` (a React component that pulls in three.js/canvas) and can't be imported into a node-environment unit test without a larger refactor. Instead, Task 4 has a **pure** round-trip test exercising the slide logic on the real chart's exact slide shape, and Task 6 includes a manual round-trip check on the live chart.

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `web/frontend/src/chart/slides.ts` | Create | Pure slide logic: parse `E slide` runs → `slideId` tags, serialize roles, grouping helpers. No React/canvas/three. |
| `web/frontend/src/chart/slides.test.ts` | Create | Vitest unit tests for `slides.ts`. |
| `web/frontend/vitest.config.ts` | Create | Vitest config (node environment, `src/**/*.test.ts`). |
| `web/frontend/package.json` | Modify | Add `vitest` devDependency + `test` script. |
| `web/frontend/src/components/BeatmapEditor.tsx` | Modify | `ChartNote.slideId`; wire slide parse/serialize; 2D ribbon draw; 3D tube meshes; "Make/Remove slide" UI. |

`BeatmapEditor.tsx` is ~5k lines; all *pure* slide logic goes in `slides.ts` to keep it testable and keep the editor file from growing further. Rendering and UI changes are inherently coupled to the editor's draw loops and stay in `BeatmapEditor.tsx`.

---

## Setup (before Task 1)

- [ ] **Create the feature branch**

```bash
cd /c/Users/Admin/Documents/GitHub/madmom
git checkout -b feat/hold-slide-bars
```

All task commits land on this branch. The branch is merged + deployed once, after the whole plan is verified — not after each task.

---

## Task 1: Add the Vitest test runner

**Files:**
- Modify: `web/frontend/package.json`
- Create: `web/frontend/vitest.config.ts`

- [ ] **Step 1: Install vitest**

Run:
```bash
cd web/frontend && npm install -D vitest@^2
```
Expected: `package.json` `devDependencies` gains `vitest`, `package-lock.json` updates.

- [ ] **Step 2: Add the `test` script**

In `web/frontend/package.json`, change the `scripts` block from:
```json
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
```
to:
```json
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
```

- [ ] **Step 3: Create the vitest config**

Create `web/frontend/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
```

- [ ] **Step 4: Verify the runner works**

Run:
```bash
cd web/frontend && npm test
```
Expected: vitest runs and reports `No test files found` (exit code 1 is fine here — no tests yet). The runner itself must start without error.

- [ ] **Step 5: Commit**

```bash
git add web/frontend/package.json web/frontend/package-lock.json web/frontend/vitest.config.ts
git commit -m "chore(editor): add vitest test runner for frontend unit tests"
```

---

## Task 2: `slides.ts` — types, `nextSlideId`, `groupSlides`

**Files:**
- Create: `web/frontend/src/chart/slides.ts`
- Create: `web/frontend/src/chart/slides.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/frontend/src/chart/slides.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { nextSlideId, groupSlides, type SlideNote } from './slides'

describe('nextSlideId', () => {
  it('returns 1 when no note has a slideId', () => {
    expect(nextSlideId([{ tick: 0, lane: 0, sustain: 0 }])).toBe(1)
  })
  it('returns the largest slideId plus one', () => {
    const notes: SlideNote[] = [
      { tick: 0, lane: 0, sustain: 0, slideId: 3 },
      { tick: 1, lane: 1, sustain: 0, slideId: 7 },
    ]
    expect(nextSlideId(notes)).toBe(8)
  })
})

describe('groupSlides', () => {
  it('groups notes by slideId, sorting each group by tick then lane', () => {
    const notes: SlideNote[] = [
      { tick: 200, lane: 2, sustain: 0, slideId: 1 },
      { tick: 100, lane: 1, sustain: 0, slideId: 1 },
      { tick: 50, lane: 0, sustain: 0 },
    ]
    const groups = groupSlides(notes)
    expect(groups.size).toBe(1)
    expect(groups.get(1)!.map((n) => n.tick)).toEqual([100, 200])
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd web/frontend && npm test -- src/chart/slides.test.ts`
Expected: FAIL — `Failed to resolve import "./slides"`.

- [ ] **Step 3: Create `slides.ts` with the minimal implementation**

Create `web/frontend/src/chart/slides.ts`:
```typescript
// Pure slide parsing / serialization helpers for the beatmap editor.
//
// A "slide" is a contiguous run of note positions stored in the chart as
// `E slide <fret>` events. See docs/superpowers/specs/2026-05-19-hold-slide-bars-design.md
//
// Chart spec for one slide:
//   start  -> `E slide <fret>` only (no N line)
//   middle -> `N <fret> 0` + `E slide <fret>`
//   end    -> `N <fret> 0` only (no marker)
// Chord slides apply the same pattern to a parallel adjacent fret pair.

/** Structural subset of ChartNote the slide logic needs. ChartNote (a
 *  superset) is assignable to this via structural typing. */
export interface SlideNote {
  tick: number
  lane: number
  sustain: number
  slideId?: number
}

/** A raw `<tick> = E slide <fret>` event from a difficulty section. */
export interface SlideEvent {
  tick: number
  fret: number
}

/** Role a slide-tagged note plays when serialized back to the chart. */
export type SlideRole = 'start' | 'middle' | 'end'

/** Largest slideId in use + 1 (1 if none). Deterministic, collision-free. */
export function nextSlideId(notes: SlideNote[]): number {
  let max = 0
  for (const n of notes) {
    if (n.slideId != null && n.slideId > max) max = n.slideId
  }
  return max + 1
}

/** Group notes by slideId. Each group is sorted by tick then lane. Notes
 *  without a slideId are skipped. */
export function groupSlides(notes: SlideNote[]): Map<number, SlideNote[]> {
  const groups = new Map<number, SlideNote[]>()
  for (const n of notes) {
    if (n.slideId == null) continue
    const g = groups.get(n.slideId)
    if (g) g.push(n)
    else groups.set(n.slideId, [n])
  }
  for (const g of groups.values()) {
    g.sort((a, b) => a.tick - b.tick || a.lane - b.lane)
  }
  return groups
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd web/frontend && npm test -- src/chart/slides.test.ts`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add web/frontend/src/chart/slides.ts web/frontend/src/chart/slides.test.ts
git commit -m "feat(editor): slides.ts skeleton — types, nextSlideId, groupSlides"
```

---

## Task 3: `slides.ts` — `importSlides`

Detects slide runs from `E slide` events, tags participating notes with a `slideId`, and synthesizes the start gem (the chart's start position has no `N` line).

**Files:**
- Modify: `web/frontend/src/chart/slides.ts`
- Modify: `web/frontend/src/chart/slides.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `web/frontend/src/chart/slides.test.ts`:
```typescript
import { importSlides, type SlideEvent } from './slides'

describe('importSlides', () => {
  it('returns the input unchanged when there are no slide events', () => {
    const notes: SlideNote[] = [{ tick: 0, lane: 0, sustain: 0 }]
    expect(importSlides(notes, [], 192)).toEqual(notes)
  })

  it('tags a single-fret slide: synthesizes the start, tags middle and end', () => {
    // start  = E slide 1 at tick 100 (no N note in the chart)
    // middle = N 2 0 + E slide 2 at tick 200
    // end    = N 3 0 at tick 300 (no marker)
    const notes: SlideNote[] = [
      { tick: 200, lane: 2, sustain: 0 },
      { tick: 300, lane: 3, sustain: 0 },
    ]
    const events: SlideEvent[] = [
      { tick: 100, fret: 1 },
      { tick: 200, fret: 2 },
    ]
    const out = importSlides(notes, events, 192)
    const start = out.find((n) => n.tick === 100 && n.lane === 1)
    expect(start).toBeDefined()
    expect(start!.slideId).toBe(1)
    expect(out.find((n) => n.tick === 200 && n.lane === 2)!.slideId).toBe(1)
    expect(out.find((n) => n.tick === 300 && n.lane === 3)!.slideId).toBe(1)
  })

  it('tags a chord slide on both frets of each position', () => {
    const notes: SlideNote[] = [
      { tick: 200, lane: 2, sustain: 0 }, { tick: 200, lane: 3, sustain: 0 },
      { tick: 300, lane: 3, sustain: 0 }, { tick: 300, lane: 4, sustain: 0 },
    ]
    const events: SlideEvent[] = [
      { tick: 100, fret: 1 }, { tick: 100, fret: 2 },
      { tick: 200, fret: 2 }, { tick: 200, fret: 3 },
    ]
    const out = importSlides(notes, events, 192)
    const ids = new Set(out.filter((n) => n.slideId != null).map((n) => n.slideId))
    expect(ids.size).toBe(1)
    // 2 synthesized starts + 2 middles + 2 end notes
    expect(out.filter((n) => n.slideId != null).length).toBe(6)
  })

  it('splits two far-apart runs into separate slide ids', () => {
    const notes: SlideNote[] = [
      { tick: 200, lane: 1, sustain: 0 }, { tick: 300, lane: 2, sustain: 0 },
      { tick: 9000, lane: 1, sustain: 0 }, { tick: 9100, lane: 2, sustain: 0 },
    ]
    const events: SlideEvent[] = [
      { tick: 100, fret: 0 }, { tick: 200, fret: 1 },
      { tick: 8900, fret: 0 }, { tick: 9000, fret: 1 },
    ]
    const out = importSlides(notes, events, 192)
    const ids = [...new Set(out.filter((n) => n.slideId != null).map((n) => n.slideId))]
    expect(ids.length).toBe(2)
  })

  it('does not mutate the input notes', () => {
    const notes: SlideNote[] = [{ tick: 200, lane: 2, sustain: 0 }]
    importSlides(notes, [{ tick: 100, fret: 1 }, { tick: 200, fret: 2 }], 192)
    expect(notes[0].slideId).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd web/frontend && npm test -- src/chart/slides.test.ts`
Expected: FAIL — `importSlides is not a function` / not exported.

- [ ] **Step 3: Implement `importSlides`**

Append to `web/frontend/src/chart/slides.ts`:
```typescript
// A run breaks when the gap between consecutive E-slide positions exceeds
// resolution * this factor (~2 beats). Heuristic — see spec section 5.1.
const SLIDE_GAP_FACTOR = 2

/**
 * Detect slides from a difficulty section's `E slide` events and return a NEW
 * note array with the participating notes tagged with a `slideId`. Start
 * positions (which carry no `N` line in the chart) are synthesized as new
 * zero-sustain notes so they render and can be selected.
 *
 * Pure: the input `notes` array and its objects are never mutated.
 */
export function importSlides(
  notes: SlideNote[],
  slideEvents: SlideEvent[],
  resolution: number,
): SlideNote[] {
  if (slideEvents.length === 0) return notes
  const result: SlideNote[] = notes.map((n) => ({ ...n }))
  const threshold = resolution * SLIDE_GAP_FACTOR

  // Slide positions: tick -> sorted unique frets.
  const byTick = new Map<number, number[]>()
  for (const ev of slideEvents) {
    const frets = byTick.get(ev.tick)
    if (frets) {
      if (!frets.includes(ev.fret)) frets.push(ev.fret)
    } else {
      byTick.set(ev.tick, [ev.fret])
    }
  }
  for (const frets of byTick.values()) frets.sort((a, b) => a - b)
  const posTicks = [...byTick.keys()].sort((a, b) => a - b)

  // Chain positions into runs, breaking when the gap is too large.
  const runs: number[][] = []
  let cur: number[] = []
  for (const t of posTicks) {
    if (cur.length > 0 && t - cur[cur.length - 1] > threshold) {
      runs.push(cur)
      cur = []
    }
    cur.push(t)
  }
  if (cur.length > 0) runs.push(cur)

  let sid = nextSlideId(result)
  for (const run of runs) {
    const id = sid++
    let maxFrets = 1
    // Tag (or synthesize) the start + middle positions.
    for (const t of run) {
      const frets = byTick.get(t)!
      if (frets.length > maxFrets) maxFrets = frets.length
      for (const fret of frets) {
        const existing = result.find(
          (n) => n.tick === t && n.lane === fret && n.slideId == null,
        )
        if (existing) {
          existing.slideId = id
        } else {
          result.push({ tick: t, lane: fret, sustain: 0, slideId: id })
        }
      }
    }
    // End position: the nearest later note tick within the gap threshold.
    const lastTick = run[run.length - 1]
    const laterTicks = result
      .filter((n) => n.tick > lastTick && n.slideId == null)
      .map((n) => n.tick)
    if (laterTicks.length > 0) {
      const endTick = Math.min(...laterTicks)
      if (endTick - lastTick <= threshold) {
        const endNotes = result
          .filter((n) => n.tick === endTick && n.slideId == null)
          .sort((a, b) => a.lane - b.lane)
        for (const n of endNotes.slice(0, maxFrets)) {
          n.slideId = id
        }
      }
    }
  }
  return result
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd web/frontend && npm test -- src/chart/slides.test.ts`
Expected: PASS — all `importSlides` tests green.

- [ ] **Step 5: Commit**

```bash
git add web/frontend/src/chart/slides.ts web/frontend/src/chart/slides.test.ts
git commit -m "feat(editor): importSlides — detect E-slide runs, tag notes, synthesize start gems"
```

---

## Task 4: `slides.ts` — `buildSlideEmitInfo` and `pruneSlides`

`buildSlideEmitInfo` derives each slide note's serialization role (start/middle/end). `pruneSlides` clears `slideId` from groups that are no longer valid slides (used after deletes).

**Files:**
- Modify: `web/frontend/src/chart/slides.ts`
- Modify: `web/frontend/src/chart/slides.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `web/frontend/src/chart/slides.test.ts`:
```typescript
import { buildSlideEmitInfo, pruneSlides } from './slides'

describe('buildSlideEmitInfo', () => {
  it('assigns start / middle / end by tick order', () => {
    const notes: SlideNote[] = [
      { tick: 100, lane: 1, sustain: 0, slideId: 1 },
      { tick: 200, lane: 2, sustain: 0, slideId: 1 },
      { tick: 300, lane: 3, sustain: 0, slideId: 1 },
    ]
    const roles = buildSlideEmitInfo(notes)
    expect(roles.get(notes[0])).toBe('start')
    expect(roles.get(notes[1])).toBe('middle')
    expect(roles.get(notes[2])).toBe('end')
  })

  it('marks every note at the first tick as start (chord slide)', () => {
    const notes: SlideNote[] = [
      { tick: 100, lane: 1, sustain: 0, slideId: 1 },
      { tick: 100, lane: 2, sustain: 0, slideId: 1 },
      { tick: 200, lane: 2, sustain: 0, slideId: 1 },
      { tick: 200, lane: 3, sustain: 0, slideId: 1 },
    ]
    const roles = buildSlideEmitInfo(notes)
    expect(roles.get(notes[0])).toBe('start')
    expect(roles.get(notes[1])).toBe('start')
    expect(roles.get(notes[2])).toBe('end')
    expect(roles.get(notes[3])).toBe('end')
  })

  it('ignores groups with fewer than two distinct ticks', () => {
    const notes: SlideNote[] = [
      { tick: 100, lane: 1, sustain: 0, slideId: 1 },
      { tick: 100, lane: 2, sustain: 0, slideId: 1 },
    ]
    expect(buildSlideEmitInfo(notes).size).toBe(0)
  })
})

describe('pruneSlides', () => {
  it('clears slideId from a group with only one distinct tick', () => {
    const notes: SlideNote[] = [
      { tick: 100, lane: 1, sustain: 0, slideId: 1 },
      { tick: 100, lane: 2, sustain: 0, slideId: 1 },
    ]
    expect(pruneSlides(notes).every((n) => n.slideId === undefined)).toBe(true)
  })

  it('leaves a valid multi-tick slide intact (same array reference)', () => {
    const notes: SlideNote[] = [
      { tick: 100, lane: 1, sustain: 0, slideId: 1 },
      { tick: 200, lane: 2, sustain: 0, slideId: 1 },
    ]
    expect(pruneSlides(notes)).toBe(notes)
  })
})

describe('slide round-trip (spec section 6)', () => {
  it('imports a real chord slide and re-emits the original chart lines', () => {
    // Exact shape from the Ben Chango guitar chart (frets 2 & 3):
    //   16464 = E slide 2 / E slide 3                  (start, no N)
    //   16560 = N 2 0 + E slide 2 / N 3 0 + E slide 3  (middle)
    //   16608 = N 2 0 / N 3 0                          (end)
    const notes: SlideNote[] = [
      { tick: 16560, lane: 2, sustain: 0 }, { tick: 16560, lane: 3, sustain: 0 },
      { tick: 16608, lane: 2, sustain: 0 }, { tick: 16608, lane: 3, sustain: 0 },
    ]
    const events: SlideEvent[] = [
      { tick: 16464, fret: 2 }, { tick: 16464, fret: 3 },
      { tick: 16560, fret: 2 }, { tick: 16560, fret: 3 },
    ]
    const tagged = importSlides(notes, events, 192)
    const roles = buildSlideEmitInfo(tagged)
    // Reconstruct chart lines exactly as emitNoteSectionLines (Task 6) will.
    const lines: string[] = []
    for (const n of [...tagged].sort((a, b) => a.tick - b.tick || a.lane - b.lane)) {
      const role = roles.get(n)
      if (!role) { lines.push(`${n.tick} = N ${n.lane} ${n.sustain}`); continue }
      if (role !== 'start') lines.push(`${n.tick} = N ${n.lane} 0`)
      if (role !== 'end') lines.push(`${n.tick} = E slide ${n.lane}`)
    }
    expect(lines).toEqual([
      '16464 = E slide 2',
      '16464 = E slide 3',
      '16560 = N 2 0',
      '16560 = E slide 2',
      '16560 = N 3 0',
      '16560 = E slide 3',
      '16608 = N 2 0',
      '16608 = N 3 0',
    ])
  })
})
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd web/frontend && npm test -- src/chart/slides.test.ts`
Expected: FAIL — `buildSlideEmitInfo` / `pruneSlides` not exported.

- [ ] **Step 3: Implement both functions**

Append to `web/frontend/src/chart/slides.ts`:
```typescript
/** Distinct ticks in a group, ascending. */
function distinctTicks(group: SlideNote[]): number[] {
  return [...new Set(group.map((n) => n.tick))].sort((a, b) => a - b)
}

/**
 * Compute each slide-tagged note's serialization role. Groups with fewer than
 * two distinct ticks are not real slides and are omitted (their notes
 * serialize as plain notes).
 */
export function buildSlideEmitInfo(notes: SlideNote[]): Map<SlideNote, SlideRole> {
  const roles = new Map<SlideNote, SlideRole>()
  for (const group of groupSlides(notes).values()) {
    const ticks = distinctTicks(group)
    if (ticks.length < 2) continue
    const first = ticks[0]
    const last = ticks[ticks.length - 1]
    for (const n of group) {
      roles.set(n, n.tick === first ? 'start' : n.tick === last ? 'end' : 'middle')
    }
  }
  return roles
}

/**
 * Clear slideId from any slide group that is no longer a valid slide (fewer
 * than two distinct ticks). Call after edits that delete notes. Returns the
 * same array reference when nothing changed.
 */
export function pruneSlides(notes: SlideNote[]): SlideNote[] {
  const toClear = new Set<number>()
  for (const [id, group] of groupSlides(notes)) {
    if (distinctTicks(group).length < 2) toClear.add(id)
  }
  if (toClear.size === 0) return notes
  return notes.map((n) =>
    n.slideId != null && toClear.has(n.slideId) ? { ...n, slideId: undefined } : n,
  )
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd web/frontend && npm test -- src/chart/slides.test.ts`
Expected: PASS — all tests across the file green.

- [ ] **Step 5: Commit**

```bash
git add web/frontend/src/chart/slides.ts web/frontend/src/chart/slides.test.ts
git commit -m "feat(editor): buildSlideEmitInfo + pruneSlides for slide serialization"
```

---

## Task 5: Add `slideId` to `ChartNote` and parse slides on load

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx` (`ChartNote` ~L18-29; `parseSectionNotes` ~L415-458; `parseChart` ~L1030-1086)

- [ ] **Step 1: Add the import**

Near the top of `BeatmapEditor.tsx`, with the other imports, add:
```typescript
import { importSlides, type SlideEvent } from '../chart/slides'
```
Later tasks extend this one import line as they need more from the module — this keeps each task's `npm run build` clean under `noUnusedLocals`.

- [ ] **Step 2: Add `slideId` to `ChartNote`**

In the `ChartNote` interface (~L18-29), add the field after `sustain`:
```typescript
interface ChartNote {
  tick: number
  lane: number       // 0-4 colored frets, 5 force-hopo, 6 tap, 7 open
  sustain: number    // sustain length in ticks (0 = single hit)
  // Slide membership. Notes sharing a slideId form one slide run; see
  // chart/slides.ts. The earliest tick is the start, the latest is the end.
  slideId?: number
  // Real-note: emit as `R` instead of `N`. Pack/scale are propagated from the
  // most recent E realnotes_pack / realnotes_scale event in the section at
  // parse time, and re-emitted as E events at serialize time when the active
  // (pack, scale) changes.
  type?: 'real'
  pack?: string
  scale?: string
}
```

- [ ] **Step 3: Collect `E slide` events in `parseSectionNotes` and call `importSlides`**

`parseSectionNotes` currently takes `(text, name)`. Change its signature to accept `resolution`, collect `E slide` lines, and run `importSlides` before returning.

Change the signature line (~L415):
```typescript
function parseSectionNotes(text: string, name: string, resolution: number): ChartNote[] {
```

Inside the `for (const raw of inner.split('\n'))` loop, after the existing `realnotes_scale` match block and before the loop's closing brace, add a collector. First declare the array just above the loop (next to `const raws ...`):
```typescript
  const slideEvents: SlideEvent[] = []
```
Then inside the loop, after the `realnotes_scale` match `continue`, add:
```typescript
    m = t.match(/^(\d+)\s*=\s*E\s+slide\s+(\d+)/)
    if (m) { slideEvents.push({ tick: Number(m[1]), fret: Number(m[2]) }); continue }
```

Change the final `return notes` line to:
```typescript
  return importSlides(notes, slideEvents, resolution)
```

- [ ] **Step 4: Pass `resolution` at every `parseSectionNotes` call site**

Run: `cd web/frontend && grep -rn "parseSectionNotes(" src/`
For each call, add the `resolution` argument. The known call site is in `parseChart` (~L1052):
```typescript
  const notes = activeName ? parseSectionNotes(text, activeName, resolution) : []
```
`resolution` is already in scope in `parseChart`. Update any other call site to pass the chart's resolution (use `192` only if no resolution value is reachable).

- [ ] **Step 5: Verify the build compiles**

Run: `cd web/frontend && npm run build`
Expected: PASS — `tsc` reports no errors, `vite build` completes.

- [ ] **Step 6: Manual check — slides import on load**

Run the dev server (`cd web/frontend && npm run dev`), open the Ben Chango guitar beatmap (`/edit/510d8cc1f215/6116e4bba7c2`).
Expected: the chart loads with no console errors. There is no visual change yet — slide rendering arrives in Task 7. This step only confirms the parser changes didn't break chart loading.

- [ ] **Step 7: Commit**

```bash
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): parse E-slide events into slideId-tagged notes on chart load"
```

---

## Task 6: Serialize slides on save

`emitNoteSectionLines` must emit the `E slide` / `N` lines for slide-tagged notes; `replaceSectionNotes` must stop keeping the old verbatim `E slide` lines (the model now owns them).

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx` (`emitNoteSectionLines` ~L530-554; `replaceSectionNotes` ~L556-589)

- [ ] **Step 1: Make `emitNoteSectionLines` slide-aware**

First extend the slides import added in Task 5 to include `buildSlideEmitInfo`:
```typescript
import { importSlides, buildSlideEmitInfo, type SlideEvent } from '../chart/slides'
```
Then, in `emitNoteSectionLines` (~L530), immediately after `const sorted = ...`, add:
```typescript
  const slideRoles = buildSlideEmitInfo(notes)
```
Then, inside the `for (const n of sorted)` loop, as the FIRST statement of the loop body (before `if (n.type === 'real')`), add:
```typescript
    const role = slideRoles.get(n)
    if (role) {
      // start -> E slide only · middle -> N + E slide · end -> N only
      if (role !== 'start') out.push(`  ${n.tick} = N ${n.lane} 0`)
      if (role !== 'end') out.push(`  ${n.tick} = E slide ${n.lane}`)
      continue
    }
```
This produces `N` then `E slide` interleaved per fret at a shared tick — matching the generator's output order.

- [ ] **Step 2: Strip old `E slide` lines in `replaceSectionNotes`**

In `replaceSectionNotes` (~L556), the `keptLines` filter currently drops `[NR]` and `realnotes` lines. Add an `E slide` rule. Change the filter body from:
```typescript
      if (/^\d+\s*=\s*[NR]\s+/.test(t)) return false
      if (/^\d+\s*=\s*E\s+realnotes_(pack|scale)\b/.test(t)) return false
      return true
```
to:
```typescript
      if (/^\d+\s*=\s*[NR]\s+/.test(t)) return false
      if (/^\d+\s*=\s*E\s+realnotes_(pack|scale)\b/.test(t)) return false
      // E slide lines are now owned by the model (emitted by emitNoteSectionLines).
      if (/^\d+\s*=\s*E\s+slide\b/.test(t)) return false
      return true
```
Also update the comment above the filter — change `// Other E events (slides, etc.), S star power, and A anchors pass through.` to `// Other E events, S star power, and A anchors pass through. E slide is owned by the model.`

- [ ] **Step 3: Verify the build compiles**

Run: `cd web/frontend && npm run build`
Expected: PASS.

- [ ] **Step 4: Manual round-trip check**

Dev server running, open the Ben Chango guitar beatmap. Without making changes, hit **Save**. Then re-open the beatmap. Expected: it loads identically — no error, slides still present. (For a deeper check: before saving, copy the chart text via the editor's export/download; after save+reload, compare — the `E slide` / `N` lines for each slide should be unchanged in count and content.)

- [ ] **Step 5: Commit**

```bash
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): serialize slideId-tagged notes back to E-slide chart events"
```

---

## Task 7: 2D slide ribbons

Draws a per-segment diagonal ribbon for each slide, beneath the gems.

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx` (new module-level `drawSlideRibbons`; `draw` callback ~L4478, note loop ~L4976)

- [ ] **Step 1: Add the `drawSlideRibbons` helper**

First extend the slides import to include `groupSlides`:
```typescript
import { importSlides, buildSlideEmitInfo, groupSlides, type SlideEvent } from '../chart/slides'
```
Then add this module-level function near the other module-level draw helpers in `BeatmapEditor.tsx` (above the `BeatmapEditor` component, after the `parseChart`/`replaceSectionNotes` functions):
```typescript
// Draw each slide as a diagonal ribbon: a thick, semi-transparent segment
// between consecutive slide positions, coloured by the lane it leaves.
function drawSlideRibbons(
  ctx: CanvasRenderingContext2D,
  notes: ChartNote[],
  o: {
    laneFill: string[]
    gemX0: number
    laneW: number
    hit: number
    scrollSpeed: number
    currentTime: number
    t2s: (tick: number) => number
    selectedSlideIds: Set<number>
  },
): void {
  const laneX = (lane: number) => o.gemX0 + (lane + 0.5) * o.laneW
  const tickY = (tick: number) => o.hit - (o.t2s(tick) - o.currentTime) * o.scrollSpeed
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const [sid, group] of groupSlides(notes)) {
    const byTick = new Map<number, number[]>()
    for (const n of group) {
      const f = byTick.get(n.tick)
      if (f) f.push(n.lane)
      else byTick.set(n.tick, [n.lane])
    }
    const ticks = [...byTick.keys()].sort((a, b) => a - b)
    if (ticks.length < 2) continue
    for (const f of byTick.values()) f.sort((a, b) => a - b)
    const maxFrets = Math.max(...ticks.map((t) => byTick.get(t)!.length))
    const selected = o.selectedSlideIds.has(sid)
    for (let r = 0; r < maxFrets; r++) {
      for (let i = 0; i + 1 < ticks.length; i++) {
        const fa = byTick.get(ticks[i])!
        const fb = byTick.get(ticks[i + 1])!
        const laneA = fa[Math.min(r, fa.length - 1)]
        const laneB = fb[Math.min(r, fb.length - 1)]
        ctx.beginPath()
        ctx.moveTo(laneX(laneA), tickY(ticks[i]))
        ctx.lineTo(laneX(laneB), tickY(ticks[i + 1]))
        ctx.strokeStyle = o.laneFill[laneA] + (selected ? 'ff' : '88')
        ctx.lineWidth = o.laneW * (selected ? 0.46 : 0.4)
        ctx.stroke()
      }
    }
  }
}
```

- [ ] **Step 2: Call it from `draw`, before the note-gem loop**

In the `draw` callback, locate the `for` loop that iterates `chart.notes` to draw gems (the loop containing the hold-sustain rectangle at ~L4986). Immediately BEFORE that loop, add:
```typescript
    // Slide ribbons sit beneath the gems.
    const selectedSlideIds = new Set<number>()
    for (const i of selectedIds) {
      const s = chart.notes[i]?.slideId
      if (s != null) selectedSlideIds.add(s)
    }
    drawSlideRibbons(ctx, chart.notes, {
      laneFill: LANE_FILL,
      gemX0: GEM_X0,
      laneW: LANE_W,
      hit: HIT,
      scrollSpeed,
      currentTime,
      t2s,
      selectedSlideIds,
    })
```
`LANE_FILL`, `GEM_X0`, `LANE_W`, `HIT`, `scrollSpeed`, `t2s`, `currentTime`, and `selectedIds` are all already in scope at that point in `draw` (used by the existing gem/hold drawing).

- [ ] **Step 3: Verify the build compiles**

Run: `cd web/frontend && npm run build`
Expected: PASS.

- [ ] **Step 4: Manual visual check**

Dev server running, open the Ben Chango guitar beatmap. Expected: slide runs now show a diagonal coloured ribbon connecting their gems in the 2D editor; each segment takes the colour of the lane it leaves. The existing hold bars are unchanged. Select a slide's notes (drag-select) — its ribbon brightens.

- [ ] **Step 5: Commit**

```bash
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): render slides as diagonal ribbons in the 2D view"
```

---

## Task 8: 3D hold tubes

Adds an emissive cylinder "tube" pool to the 3D runway and renders hold sustains as bars.

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx` (3D layer: pool ref near `lanePoolRef`; per-frame loop ~L2108-2180; module-scope geometry)

- [ ] **Step 1: Add module-scope bar geometry and the `BarSeg` type**

Near the 3D constants (`Z_PER_SECOND` / `LANE_UNIT`, ~L2054), at module scope, add:
```typescript
// Unit cylinder reused for every hold/slide bar — scaled per segment.
const BAR_GEOMETRY = new THREE.CylinderGeometry(1, 1, 1, 12)

// One straight bar segment in runway space (endpoints share Y).
interface BarSeg {
  ax: number
  az: number
  bx: number
  bz: number
  colorHex: number
}
```

- [ ] **Step 2: Add the bar mesh pool ref**

Find the declaration of `lanePoolRef` (the gem-mesh pool, a `useRef`). Immediately after it, add:
```typescript
  const barPoolRef = useRef<THREE.Mesh[]>([])
```

- [ ] **Step 3: Build hold segments and sync the pool**

In the per-frame render function, AFTER the existing gem-pool positioning loop (the `for (let i = 0; i < visible.length; i++)` block, ~L2157-2180) and BEFORE `renderer.render(scene, camera)`, add:
```typescript
    // --- Hold & slide bars (glowing tubes) ---
    const barSegs: BarSeg[] = []
    const barRadius = baseGemSize * 0.22
    const barY = baseGemSize * 0.5
    const inWindow = (s1: number, s2: number) =>
      Math.min(s1, s2) <= topSec && Math.max(s1, s2) >= bottomSec

    // Holds: a bar from the head gem back along the runway for the sustain.
    for (const n of props.notes) {
      if (n.lane > 4 || n.sustain <= 0) continue
      const sHead = t2s(n.tick)
      const sTail = t2s(n.tick + n.sustain)
      if (!inWindow(sHead, sTail)) continue
      const x = (n.lane - 2) * LANE_UNIT
      barSegs.push({
        ax: x,
        az: -(sHead - props.currentTime) * Z_PER_SECOND,
        bx: x,
        bz: -(sTail - props.currentTime) * Z_PER_SECOND,
        colorHex: LANE_COLOR_HEX[n.lane],
      })
    }

    // Sync the bar mesh pool to barSegs.
    const barPool = barPoolRef.current
    while (barPool.length < barSegs.length) {
      const mesh = new THREE.Mesh(
        BAR_GEOMETRY,
        new THREE.MeshStandardMaterial({
          color: 0xffffff,
          emissive: 0xffffff,
          emissiveIntensity: 0.55,
          metalness: 0.2,
          roughness: 0.5,
        }),
      )
      barPool.push(mesh)
      scene.add(mesh)
    }
    while (barPool.length > barSegs.length) {
      const m = barPool.pop()!
      scene.remove(m)
    }
    const barUp = new THREE.Vector3(0, 1, 0)
    const barA = new THREE.Vector3()
    const barB = new THREE.Vector3()
    const barDir = new THREE.Vector3()
    for (let i = 0; i < barSegs.length; i++) {
      const seg = barSegs[i]
      const mesh = barPool[i]
      barA.set(seg.ax, barY, seg.az)
      barB.set(seg.bx, barY, seg.bz)
      barDir.subVectors(barB, barA)
      const len = Math.max(barDir.length(), 0.0001)
      mesh.position.copy(barA).add(barB).multiplyScalar(0.5)
      mesh.quaternion.setFromUnitVectors(barUp, barDir.normalize())
      mesh.scale.set(barRadius, len, barRadius)
      const mat = mesh.material as THREE.MeshStandardMaterial
      mat.color.setHex(seg.colorHex)
      mat.emissive.setHex(seg.colorHex)
    }
```
`topSec`, `bottomSec`, `t2s`, `baseGemSize`, `Z_PER_SECOND`, `LANE_UNIT`, `LANE_COLOR_HEX`, `scene`, and `props` are all in scope in this function (used by the gem rendering above).

- [ ] **Step 4: Verify the build compiles**

Run: `cd web/frontend && npm run build`
Expected: PASS.

- [ ] **Step 5: Manual visual check**

Dev server running, open the Ben Chango guitar beatmap, switch to the 3D runway view. Expected: hold notes now show a glowing, lane-coloured tube extending back down the runway for the sustain length. Single hits show no tube.

- [ ] **Step 6: Commit**

```bash
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): render hold sustains as glowing tubes on the 3D runway"
```

---

## Task 9: 3D slide tubes

Adds slide segments to the same bar pool built in Task 8.

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx` (per-frame render function, in the bar-building block from Task 8)

- [ ] **Step 1: Build slide segments**

In the per-frame render function, in the block added in Task 8, insert this immediately AFTER the holds `for` loop and BEFORE the `// Sync the bar mesh pool to barSegs.` line:
```typescript
    // Slides: a bar per segment between consecutive slide positions.
    for (const group of groupSlides(props.notes).values()) {
      const byTick = new Map<number, number[]>()
      for (const n of group) {
        const f = byTick.get(n.tick)
        if (f) f.push(n.lane)
        else byTick.set(n.tick, [n.lane])
      }
      const ticks = [...byTick.keys()].sort((x, y) => x - y)
      if (ticks.length < 2) continue
      for (const f of byTick.values()) f.sort((x, y) => x - y)
      const maxFrets = Math.max(...ticks.map((t) => byTick.get(t)!.length))
      for (let r = 0; r < maxFrets; r++) {
        for (let i = 0; i + 1 < ticks.length; i++) {
          const sA = t2s(ticks[i])
          const sB = t2s(ticks[i + 1])
          if (!inWindow(sA, sB)) continue
          const fa = byTick.get(ticks[i])!
          const fb = byTick.get(ticks[i + 1])!
          const laneA = fa[Math.min(r, fa.length - 1)]
          const laneB = fb[Math.min(r, fb.length - 1)]
          barSegs.push({
            ax: (laneA - 2) * LANE_UNIT,
            az: -(sA - props.currentTime) * Z_PER_SECOND,
            bx: (laneB - 2) * LANE_UNIT,
            bz: -(sB - props.currentTime) * Z_PER_SECOND,
            colorHex: LANE_COLOR_HEX[laneA],
          })
        }
      }
    }
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd web/frontend && npm run build`
Expected: PASS.

- [ ] **Step 3: Manual visual check**

Dev server running, open the Ben Chango guitar beatmap, 3D runway view. Expected: slide runs now show glowing tubes that angle across lanes as they recede — matching the 2D ribbons. Chord slides show two parallel tubes.

- [ ] **Step 4: Commit**

```bash
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): render slides as glowing tubes on the 3D runway"
```

---

## Task 10: "Make slide" / "Remove slide" editing

Tag-a-run editing: select notes, make them a slide; remove a slide; prune invalid slides on delete.

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx` (new `makeSlide`/`removeSlide`; keyboard handler ~L5470-5722; toolbar ~L6998-7028)

- [ ] **Step 1: Add `makeSlide` and `removeSlide`**

First extend the slides import to its final form, adding `nextSlideId` and `pruneSlides`:
```typescript
import { importSlides, buildSlideEmitInfo, groupSlides, nextSlideId, pruneSlides, type SlideEvent } from '../chart/slides'
```
Then, in the `BeatmapEditor` component, near the other note-editing callbacks (close to where `commitNotes` is defined/used), add:
```typescript
  const makeSlide = useCallback(() => {
    if (!chart || selectedIds.size < 2) return
    const id = nextSlideId(chart.notes)
    const next = chart.notes.map((n, i) =>
      selectedIds.has(i) ? { ...n, slideId: id } : n,
    )
    commitNotes(next)
  }, [chart, selectedIds, commitNotes])

  const removeSlide = useCallback(() => {
    if (!chart || selectedIds.size === 0) return
    const ids = new Set<number>()
    for (const i of selectedIds) {
      const s = chart.notes[i]?.slideId
      if (s != null) ids.add(s)
    }
    if (ids.size === 0) return
    const next = chart.notes.map((n) =>
      n.slideId != null && ids.has(n.slideId) ? { ...n, slideId: undefined } : n,
    )
    commitNotes(next)
  }, [chart, selectedIds, commitNotes])
```

- [ ] **Step 2: Prune invalid slides on delete**

In the keyboard handler (~L5470), the Delete/Backspace branch currently does:
```typescript
    const next = chart.notes.filter((_, i) => !selectedIds.has(i))
    commitNotes(next)
```
Change the first line to wrap the result in `pruneSlides`:
```typescript
    const next = pruneSlides(chart.notes.filter((_, i) => !selectedIds.has(i)))
    commitNotes(next)
```

- [ ] **Step 3: Add the `s` keyboard shortcut for "Make slide"**

First confirm `s` is free: `cd web/frontend && grep -n "e.key === 's'" src/components/BeatmapEditor.tsx` — expect no match. In the keyboard handler, after the tool-selection keys (`if (e.key === '3' ...)`), add:
```typescript
  if ((e.key === 's' || e.key === 'S') && !isCtrl) { makeSlide(); e.preventDefault(); return }
```
Add `makeSlide` to the dependency array of the `useEffect` that registers this `keydown` handler (find the `}, [...])` closing that effect and append `makeSlide`).

- [ ] **Step 4: Add the toolbar buttons**

After the closing `</div>` of the tool-selection button group (~L7028, the `<div className="flex items-stretch gap-1">` containing Select/Play/Real), add a second button group:
```tsx
        <div className="flex items-stretch gap-1">
          <button
            onClick={makeSlide}
            disabled={selectedIds.size < 2}
            className={`px-1.5 py-1.5 rounded text-[11px] font-medium transition-colors ${
              selectedIds.size < 2
                ? 'bg-gray-800 text-gray-600 cursor-not-allowed'
                : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
            }`}
            title="Make slide (s) — tag the selected notes (2+) as one slide run"
          >
            ⤢ Make slide
          </button>
          <button
            onClick={removeSlide}
            className="px-1.5 py-1.5 rounded text-[11px] font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors"
            title="Remove slide — untag the selected notes' slide"
          >
            ⤢✕ Remove slide
          </button>
        </div>
```

- [ ] **Step 5: Verify the build compiles**

Run: `cd web/frontend && npm run build`
Expected: PASS.

- [ ] **Step 6: Manual editing check**

Dev server running, open any beatmap. Select 3+ notes across different lanes (drag-select). Click **Make slide** (or press `s`). Expected: a ribbon appears connecting them (2D) and a tube (3D). Select a slide note, click **Remove slide** — the ribbon disappears. Delete a slide's notes until one remains — the slide auto-dissolves (no ribbon). Save, reload — slides persist.

- [ ] **Step 7: Commit**

```bash
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): Make slide / Remove slide editing actions"
```

---

## Task 11: Full verification & changelog

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx` (only if verification finds defects)

- [ ] **Step 1: Run the unit test suite**

Run: `cd web/frontend && npm test`
Expected: PASS — all `slides.test.ts` tests green.

- [ ] **Step 2: Production build**

Run: `cd web/frontend && npm run build`
Expected: PASS — `tsc` clean, `vite build` succeeds.

- [ ] **Step 3: End-to-end manual verification**

Dev server, open the Ben Chango guitar beatmap (`/edit/510d8cc1f215/6116e4bba7c2`):
- 2D: slides render as diagonal ribbons; holds keep their existing bars.
- 3D: holds and slides render as glowing tubes.
- Make a new slide from selected notes; remove it; delete-to-dissolve.
- Save, reload — the chart round-trips (slide count unchanged).

Fix any defect found, re-running the relevant task's checks. Use the systematic-debugging skill for any failure.

- [ ] **Step 4: Commit any fixes, then summarize**

If fixes were needed:
```bash
git add -A && git commit -m "fix(editor): <describe the fix>"
```

The branch `feat/hold-slide-bars` is now ready to merge. Merge to `main`, push, and deploy to the droplet per the project's deploy process (frontend change → `git pull && npm run build`; no backend restart needed). Confirm `.superpowers/` stays untracked.

---

## Notes for the implementer

- **TypeScript strictness:** `tsconfig.json` has `noUnusedLocals` / `noUnusedParameters`. Don't leave unused imports/vars.
- **Single quotes:** the codebase uses single quotes; match it.
- **`SlideNote` vs `ChartNote`:** `slides.ts` operates on the structural `SlideNote`. `ChartNote` is a superset and is assignable — no casts needed.
- **Follow-up (out of scope):** click-a-ribbon-to-select-the-whole-slide needs canvas point-to-segment hit-testing; deferred. Drag-select handles all editing in the meantime.
