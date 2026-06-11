# Large Gem Selection + Sequence Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add shift-click range selection and Alt-drag marquee selection to the beatmap editor, plus a server-backed cross-track sequence library (save/rename/clone/delete gem sequences, place at playhead with BPM-correct tick rescaling and a ×½/×1/×2 scale option).

**Architecture:** Pure selection/sequence math lives in new `web/frontend/src/chart/` modules (vitest-tested); `BeatmapEditor.tsx` wires them into its existing gesture handlers and commit funnel (`commitNotes`). The library is a new FastAPI router persisting to `<upload_dir>/sequences.json` (same pattern as `generation_presets`), surfaced by a new `SequencesPanel` next to the existing Clips panel.

**Tech Stack:** React 18 + TypeScript + Vite + vitest (frontend), FastAPI + pydantic + pytest (backend).

**Spec:** `docs/superpowers/specs/2026-06-11-sequence-library-design.md`

**Key existing facts (verified, line numbers from current `main`):**
- `BeatmapEditor.tsx` (~9k lines): `ChartNote` interface at line 21; `selectedIds: Set<number>` (note array indices) at 2812; gesture refs `dragRef`/`placeRef`/`scrubRef` at 2754–2780; `commitNotes` (history + rule-gate funnel) at 3828; `draw()` useCallback 4688–5325 (rAF loop at 5341 calls it every frame, so refs read inside `draw` render without re-renders); `findNoteAt` at 5361; `handleMouseDown` at 5402 (note-click select/drag branch at 5486–5514, note placement at 5523, scrub arming at 5555); `handleMouseMove` at 5558; `handleMouseUp` at 5689; keyboard copy/paste at 5778–5816.
- Geometry used everywhere: `HIT = canvas.height - 110`, `GUTTER_W = 64`, `GEM_X0 = GUTTER_W`, `GEM_W = canvas.width - canvas.width * 0.36 - GUTTER_W`, `LANE_W = GEM_W / 5`. Note y on canvas: `y = HIT - (noteSec - currentTime) * scrollSpeed`.
- Snap: `snapTicks = Math.max(1, Math.round(chart.resolution / snapDivisor))`.
- `nextSlideId(notes)` from `../chart/slides` returns max slideId + 1.
- Backend test pattern: `tests/web_backend/test_elevenlabs_router.py` — TestClient + `app.dependency_overrides[require_auth]`. Run pytest **from repo root**.
- Routers mount in `web/backend/app/main.py` with `dependencies=_auth_dep` (lines 74–96).
- Frontend version constant: `web/frontend/src/version.ts` (`STUDIO_VERSION`, currently `1.10.0`).

---

### Task 1: Selection helpers (`src/chart/selection.ts`)

Pure math for range select and marquee hit-testing, so they're unit-testable without the canvas.

**Files:**
- Create: `web/frontend/src/chart/selection.ts`
- Test: `web/frontend/src/chart/selection.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// web/frontend/src/chart/selection.test.ts
import { describe, expect, it } from 'vitest'
import { marqueeHitIds, rangeSelectIds } from './selection'

describe('rangeSelectIds', () => {
  const notes = [
    { tick: 0 }, { tick: 192 }, { tick: 192 }, { tick: 384 }, { tick: 768 },
  ]

  it('selects every note between the two ticks inclusive, across lanes', () => {
    expect(rangeSelectIds(notes, 192, 384)).toEqual([1, 2, 3])
  })

  it('is direction-agnostic (anchor after click)', () => {
    expect(rangeSelectIds(notes, 384, 192)).toEqual([1, 2, 3])
  })

  it('same tick selects just the notes on that tick', () => {
    expect(rangeSelectIds(notes, 192, 192)).toEqual([1, 2])
  })

  it('covers the whole chart when the range spans it', () => {
    expect(rangeSelectIds(notes, 0, 768)).toEqual([0, 1, 2, 3, 4])
  })
})

describe('marqueeHitIds', () => {
  // Geometry: gem area x ∈ [64, 564], 5 lanes of 100px.
  // Lane centers: 114, 214, 314, 414, 514.
  const geom = { gemX0: 64, gemX1: 564, laneW: 100 }

  it('selects fretted notes whose lane center and y fall inside the rect', () => {
    const items = [
      { lane: 0, y: 100 },  // center x=114 — inside
      { lane: 2, y: 150 },  // center x=314 — inside
      { lane: 4, y: 120 },  // center x=514 — outside x range
      { lane: 1, y: 500 },  // below rect
    ]
    const rect = { x0: 80, y0: 50, x1: 350, y1: 200 }
    expect(marqueeHitIds(items, rect, geom)).toEqual([0, 1])
  })

  it('normalizes an inverted drag (drag up-left)', () => {
    const items = [{ lane: 0, y: 100 }]
    const rect = { x0: 350, y0: 200, x1: 80, y1: 50 }
    expect(marqueeHitIds(items, rect, geom)).toEqual([0])
  })

  it('treats open notes and modifiers (lane > 4) as full-width: any x overlap with the gem area counts', () => {
    const items = [
      { lane: 7, y: 100 },  // open note — y inside, rect overlaps gem area
      { lane: 5, y: 100 },  // HOPO modifier — same
      { lane: 7, y: 999 },  // y outside
    ]
    const rect = { x0: 500, y0: 50, x1: 560, y1: 200 }
    expect(marqueeHitIds(items, rect, geom)).toEqual([0, 1])
  })

  it('returns empty when the rect sits entirely left of the gem area', () => {
    const items = [{ lane: 7, y: 100 }]
    const rect = { x0: 0, y0: 50, x1: 60, y1: 200 }
    expect(marqueeHitIds(items, rect, geom)).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `web/frontend/`): `npx vitest run src/chart/selection.test.ts`
Expected: FAIL — cannot resolve `./selection`.

- [ ] **Step 3: Implement**

```typescript
// web/frontend/src/chart/selection.ts
// Pure selection math for the beatmap editor. Kept canvas-free so the
// range-select and marquee gestures are unit-testable.

export interface MarqueeRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface MarqueeGeom {
  gemX0: number   // left edge of the gem area (after the ruler gutter)
  gemX1: number   // right edge of the gem area (before the sidecar)
  laneW: number   // width of one of the five fret lanes
}

// Indices of every note whose tick lies between the two ticks, inclusive,
// across all lanes. Order matches the notes array (ascending index).
export function rangeSelectIds(notes: { tick: number }[], tickA: number, tickB: number): number[] {
  const lo = Math.min(tickA, tickB)
  const hi = Math.max(tickA, tickB)
  const out: number[] = []
  notes.forEach((n, i) => {
    if (n.tick >= lo && n.tick <= hi) out.push(i)
  })
  return out
}

// Indices of every note whose rendered position intersects the marquee.
// `items[i].y` is the note's canvas y (caller computes it from tick/tempo);
// fretted notes (lane 0-4) hit-test at their lane center x, while open
// notes and modifiers (lane > 4) span the gem area so any horizontal
// overlap with it counts.
export function marqueeHitIds(
  items: { lane: number; y: number }[],
  rect: MarqueeRect,
  geom: MarqueeGeom,
): number[] {
  const xLo = Math.min(rect.x0, rect.x1)
  const xHi = Math.max(rect.x0, rect.x1)
  const yLo = Math.min(rect.y0, rect.y1)
  const yHi = Math.max(rect.y0, rect.y1)
  const out: number[] = []
  items.forEach((it, i) => {
    if (it.y < yLo || it.y > yHi) return
    if (it.lane <= 4) {
      const x = geom.gemX0 + (it.lane + 0.5) * geom.laneW
      if (x < xLo || x > xHi) return
    } else if (xHi < geom.gemX0 || xLo > geom.gemX1) {
      return
    }
    out.push(i)
  })
  return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `web/frontend/`): `npx vitest run src/chart/selection.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add web/frontend/src/chart/selection.ts web/frontend/src/chart/selection.test.ts
git commit -m "feat(editor): pure helpers for range-select and marquee hit-testing"
```

---

### Task 2: Sequence helpers (`src/chart/sequences.ts`)

Normalization (save side) and materialization (paste side: resolution rescale, ×½/×1/×2 scale, base tick, slide re-id, duplicate drop).

**Files:**
- Create: `web/frontend/src/chart/sequences.ts`
- Test: `web/frontend/src/chart/sequences.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// web/frontend/src/chart/sequences.test.ts
import { describe, expect, it } from 'vitest'
import { materializeSequence, normalizeSequence } from './sequences'

describe('normalizeSequence', () => {
  it('shifts ticks so the earliest note is at 0 and sorts by tick then lane', () => {
    const out = normalizeSequence([
      { tick: 960, lane: 2, sustain: 0 },
      { tick: 768, lane: 3, sustain: 96 },
      { tick: 768, lane: 1, sustain: 0 },
    ])
    expect(out).toEqual([
      { tick: 0, lane: 1, sustain: 0 },
      { tick: 0, lane: 3, sustain: 96 },
      { tick: 192, lane: 2, sustain: 0 },
    ])
  })

  it('preserves modifiers, slide ids, and real-note fields', () => {
    const out = normalizeSequence([
      { tick: 100, lane: 0, sustain: 48, slideId: 3, type: 'real', pack: 'p1', scale: 'minor' },
    ])
    expect(out).toEqual([
      { tick: 0, lane: 0, sustain: 48, slideId: 3, type: 'real', pack: 'p1', scale: 'minor' },
    ])
  })

  it('returns [] for empty input', () => {
    expect(normalizeSequence([])).toEqual([])
  })
})

describe('materializeSequence', () => {
  const base = { sourceResolution: 192, targetResolution: 192, scale: 1, baseTick: 0, slideIdStart: 1 }

  it('offsets every note by baseTick', () => {
    const out = materializeSequence(
      [{ tick: 0, lane: 0, sustain: 0 }, { tick: 192, lane: 1, sustain: 96 }],
      { ...base, baseTick: 768 },
    )
    expect(out).toEqual([
      { tick: 768, lane: 0, sustain: 0 },
      { tick: 960, lane: 1, sustain: 96 },
    ])
  })

  it('rescales ticks and sustains across resolutions (192 → 480)', () => {
    const out = materializeSequence(
      [{ tick: 96, lane: 0, sustain: 48 }],
      { ...base, sourceResolution: 192, targetResolution: 480 },
    )
    expect(out).toEqual([{ tick: 240, lane: 0, sustain: 120 }])
  })

  it('applies the x2 / x0.5 paste scale to offsets and sustains', () => {
    const notes = [{ tick: 192, lane: 0, sustain: 96 }]
    expect(materializeSequence(notes, { ...base, scale: 2 }))
      .toEqual([{ tick: 384, lane: 0, sustain: 192 }])
    expect(materializeSequence(notes, { ...base, scale: 0.5 }))
      .toEqual([{ tick: 96, lane: 0, sustain: 48 }])
  })

  it('re-issues slide ids starting at slideIdStart, preserving grouping', () => {
    const out = materializeSequence(
      [
        { tick: 0, lane: 0, sustain: 0, slideId: 9 },
        { tick: 192, lane: 1, sustain: 0, slideId: 9 },
        { tick: 384, lane: 2, sustain: 0, slideId: 12 },
      ],
      { ...base, slideIdStart: 5 },
    )
    expect(out.map((n) => n.slideId)).toEqual([5, 5, 6])
  })

  it('drops duplicate (tick, lane) collisions produced by rounding, keeping the first', () => {
    // x0.5 on two notes 1 tick apart in the same lane collapses them.
    const out = materializeSequence(
      [
        { tick: 0, lane: 3, sustain: 0 },
        { tick: 1, lane: 3, sustain: 0 },
      ],
      { ...base, scale: 0.5 },
    )
    expect(out).toEqual([{ tick: 0, lane: 3, sustain: 0 }])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `web/frontend/`): `npx vitest run src/chart/sequences.test.ts`
Expected: FAIL — cannot resolve `./sequences`.

- [ ] **Step 3: Implement**

```typescript
// web/frontend/src/chart/sequences.ts
// Save/paste math for the cross-track sequence library. Ticks are musical
// units (resolution ticks per beat), so a sequence pasted into a chart with
// a different BPM/tempo map lands on the right beats automatically — only
// the tick *resolution* needs rescaling, which happens here.

export interface SequenceNote {
  tick: number
  lane: number
  sustain: number
  slideId?: number
  type?: 'real'
  pack?: string
  scale?: string
}

export interface MaterializeOpts {
  sourceResolution: number   // ticks-per-beat the sequence was saved at
  targetResolution: number   // ticks-per-beat of the chart being pasted into
  scale: number              // paste-time stretch: 0.5, 1, or 2
  baseTick: number           // snapped playhead tick the sequence anchors to
  slideIdStart: number       // first free slideId in the target chart
}

// Shift ticks so the earliest note sits at 0 and sort (tick, lane) — the
// canonical stored form of a library sequence.
export function normalizeSequence(notes: SequenceNote[]): SequenceNote[] {
  if (notes.length === 0) return []
  const minTick = Math.min(...notes.map((n) => n.tick))
  return notes
    .map((n) => ({ ...n, tick: n.tick - minTick }))
    .sort((a, b) => a.tick - b.tick || a.lane - b.lane)
}

// Turn a stored sequence into notes ready to merge into the target chart.
// Rounding after rescale/scale can collapse two notes onto the same
// (tick, lane); duplicates are dropped, keeping the first.
export function materializeSequence(seqNotes: SequenceNote[], opts: MaterializeOpts): SequenceNote[] {
  const ratio = (opts.targetResolution / opts.sourceResolution) * opts.scale
  const slideMap = new Map<number, number>()
  let nextSlide = opts.slideIdStart
  const seen = new Set<string>()
  const out: SequenceNote[] = []
  for (const n of seqNotes) {
    const tick = opts.baseTick + Math.round(n.tick * ratio)
    const sustain = Math.round(n.sustain * ratio)
    const key = `${tick}:${n.lane}`
    if (seen.has(key)) continue
    seen.add(key)
    const placed: SequenceNote = { ...n, tick, sustain }
    if (n.slideId != null) {
      if (!slideMap.has(n.slideId)) slideMap.set(n.slideId, nextSlide++)
      placed.slideId = slideMap.get(n.slideId)
    }
    out.push(placed)
  }
  return out.sort((a, b) => a.tick - b.tick || a.lane - b.lane)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `web/frontend/`): `npx vitest run src/chart/sequences.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add web/frontend/src/chart/sequences.ts web/frontend/src/chart/sequences.test.ts
git commit -m "feat(editor): sequence normalize/materialize helpers (resolution rescale, paste scale, slide re-id)"
```

---

### Task 3: Shift+click range select in the editor

Repurpose Shift+click on a gem from toggle-add (Ctrl/Cmd+click keeps that) to range select from the last plainly-clicked anchor. Shift+click in the note/real placement tools still drops an OPEN note (that branch only runs when the click is NOT on an existing gem, so there is no conflict).

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx` (imports ~line 17, refs ~line 2780, mousedown note-click branch lines 5486–5514)

- [ ] **Step 1: Add the import**

At line 17, next to the other `../chart/` imports:

```typescript
import { marqueeHitIds, rangeSelectIds, type MarqueeRect } from '../chart/selection'
```

(`marqueeHitIds`/`MarqueeRect` are used in Task 4; importing once here keeps the diff simple. If TS `noUnusedLocals` fails the build between tasks, do Tasks 3 and 4 in one commit — see Step 5.)

- [ ] **Step 2: Add the anchor ref**

After `scrubRef` (line 2780), before `const [canvasSize, ...]`:

```typescript
  // Range-select anchor: the note index last plainly-clicked (or
  // ctrl-toggled). Shift+click selects every note between this anchor's
  // tick and the clicked note's tick, file-manager style.
  const selectAnchorRef = useRef<number | null>(null)
```

- [ ] **Step 3: Replace the note-click selection branch**

Replace lines 5486–5514 (the whole `if (id !== null) { ... return }` block inside `handleMouseDown`) with:

```typescript
    // Click on existing note: select (plain), range-select (shift),
    // toggle (ctrl/cmd) — then start a group drag of the result.
    if (id !== null) {
      const orig = chart.notes[id]
      if (!orig) return
      let nextSel: Set<number>
      const anchorNote = selectAnchorRef.current !== null ? chart.notes[selectAnchorRef.current] : undefined
      if (e.shiftKey && anchorNote) {
        // Range select: everything between the anchor's tick and this
        // note's tick, inclusive, across all lanes. Anchor stays put so a
        // further shift+click re-extends from the same origin.
        nextSel = new Set(rangeSelectIds(chart.notes, anchorNote.tick, orig.tick))
      } else if (!e.shiftKey && (e.ctrlKey || e.metaKey)) {
        nextSel = new Set(selectedIds)
        if (nextSel.has(id)) nextSel.delete(id)
        else nextSel.add(id)
        selectAnchorRef.current = id
      } else {
        // Plain click (or shift with no anchor yet): single-select unless
        // the note is already part of the selection (keep it for dragging).
        nextSel = selectedIds.has(id) ? new Set(selectedIds) : new Set([id])
        selectAnchorRef.current = id
      }
      setSelectedIds(nextSel)
      // Build the drag snapshot from the post-update selection — state
      // hasn't flushed yet, so use nextSel directly. A ctrl-toggled-OFF
      // note is absent, which also disables the drag (anchor not in
      // snapshot → mousemove no-ops), matching the old behavior.
      const snapshot = new Map<number, { tick: number; lane: number }>()
      nextSel.forEach((i) => {
        const n = chart.notes[i]
        if (n) snapshot.set(i, { tick: n.tick, lane: n.lane })
      })
      dragRef.current = { anchorId: id, snapshot, startX: cx, startY: cy, moved: false }
      return
    }
```

- [ ] **Step 4: Type-check**

Run (from `web/frontend/`): `npx tsc --noEmit`
Expected: no errors (if `marqueeHitIds`/`MarqueeRect` unused-import errors appear, proceed to Task 4 before committing).

- [ ] **Step 5: Manual smoke test + commit**

Quick check in the dev UI if a dev server is running (optional — `npm run dev`, open a beatmap: click a gem, shift+click a gem 20 rows later → everything between highlights; ctrl+click removes one). Then:

```bash
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): shift+click range select (ctrl+click keeps toggle-add)"
```

---

### Task 4: Alt+drag marquee selection

Alt+mousedown anywhere in the gem area starts a marquee in any tool; Alt+Ctrl adds to the existing selection. The rect lives in a ref (the rAF draw loop reads it every frame — no re-render churn) and is drawn at the end of `draw()`.

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx` (refs ~2780, `draw()` end ~5324, `handleMouseDown` ~5410, `handleMouseMove` ~5560, `handleMouseUp` ~5689)

- [ ] **Step 1: Add the marquee ref**

Directly below the `selectAnchorRef` added in Task 3:

```typescript
  // Alt+drag marquee selection. Lives in a ref (not state): the rAF draw
  // loop reads it every frame, so dragging renders without re-rendering
  // React. additive = ctrl/cmd held at mousedown (add to selection).
  const marqueeRef = useRef<(MarqueeRect & { additive: boolean; moved: boolean }) | null>(null)
```

- [ ] **Step 2: Arm the marquee in `handleMouseDown`**

Insert immediately after `setInspectPopup(null)` (line ~5410), BEFORE the gutter-seek block — Alt must win over every other gesture so it can never drop a gem:

```typescript
    // Alt+drag = marquee selection, in any tool. Handled before everything
    // else so Alt can never place a gem, seek, or start a scrub. Alt+Ctrl
    // adds the marquee contents to the existing selection.
    if (e.altKey) {
      e.preventDefault()
      const GUTTER_W = 64
      if (cx < GUTTER_W) return
      marqueeRef.current = {
        x0: cx, y0: cy, x1: cx, y1: cy,
        additive: e.ctrlKey || e.metaKey,
        moved: false,
      }
      return
    }
```

- [ ] **Step 3: Track movement in `handleMouseMove`**

Insert right after the cursor-affordance block (after line 5567, before the `if (scrubRef.current)` branch):

```typescript
    // Marquee in progress: stretch the rect to the cursor. Drawing happens
    // in draw(); selection resolves on mouseup.
    if (marqueeRef.current) {
      const m = marqueeRef.current
      m.x1 = cx
      m.y1 = cy
      if (!m.moved && Math.hypot(cx - m.x0, cy - m.y0) >= 4) m.moved = true
      return
    }
```

- [ ] **Step 4: Resolve the selection in `handleMouseUp`**

Insert at the top of `handleMouseUp` (line 5689, before the `if (dragRef.current?.moved)` block):

```typescript
    // Marquee release: select everything inside the rect. A sub-threshold
    // drag is a no-op (don't clear the selection on a stray alt-click).
    if (marqueeRef.current) {
      const m = marqueeRef.current
      marqueeRef.current = null
      const canvas = canvasRef.current
      if (m.moved && chart && canvas) {
        const HIT = canvas.height - 110
        const GUTTER_W = 64
        const GEM_X0 = GUTTER_W
        const GEM_W = canvas.width - canvas.width * 0.36 - GUTTER_W
        const items = chart.notes.map((n) => ({
          lane: n.lane,
          y: HIT - (tickToSec(tempoSegments, chart.resolution, n.tick) - currentTime) * scrollSpeed,
        }))
        const hits = marqueeHitIds(items, m, { gemX0: GEM_X0, gemX1: GEM_X0 + GEM_W, laneW: GEM_W / 5 })
        setSelectedIds((prev) => {
          const next = m.additive ? new Set(prev) : new Set<number>()
          hits.forEach((i) => next.add(i))
          return next
        })
      }
      return
    }
```

- [ ] **Step 5: Draw the rect at the end of `draw()`**

Insert just before the closing `}, [chart, currentTime, ...])` of the `draw` useCallback (line ~5324, after the tool-hint `ctx.fillText` block):

```typescript
    // Marquee selection rectangle (Alt+drag) — ref-driven so it animates
    // under the rAF loop without React re-renders.
    const mq = marqueeRef.current
    if (mq && mq.moved) {
      const mx = Math.min(mq.x0, mq.x1)
      const my = Math.min(mq.y0, mq.y1)
      ctx.fillStyle = 'rgba(56, 189, 248, 0.12)'
      ctx.fillRect(mx, my, Math.abs(mq.x1 - mq.x0), Math.abs(mq.y1 - mq.y0))
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.8)'
      ctx.lineWidth = 1
      ctx.strokeRect(mx, my, Math.abs(mq.x1 - mq.x0), Math.abs(mq.y1 - mq.y0))
    }
```

- [ ] **Step 6: Type-check, run all frontend tests**

Run (from `web/frontend/`): `npx tsc --noEmit && npx vitest run`
Expected: clean type-check; all vitest suites pass (noteRules, slides, generationStorage, selection, sequences).

- [ ] **Step 7: Commit**

```bash
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): alt+drag marquee selection with canvas overlay"
```

---

### Task 5: Backend sequences router

CRUD persisting to `<upload_dir>/sequences.json`, mirroring `generation_presets.py`, with pydantic validation and atomic writes. TDD with the established `tests/web_backend/` TestClient pattern.

**Files:**
- Create: `web/backend/app/routers/sequences.py`
- Modify: `web/backend/app/main.py` (import list line 17–38, mounts line 94)
- Test: `tests/web_backend/test_sequences_router.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/web_backend/test_sequences_router.py
"""CRUD tests for the sequence-library router.

Persists to <upload_dir>/sequences.json; upload_dir is pointed at tmp_path
and auth is bypassed via the require_auth dependency-override pattern used
by the other web_backend tests.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


NOTES = [
    {'tick': 768, 'lane': 1, 'sustain': 0},
    {'tick': 960, 'lane': 3, 'sustain': 96, 'slideId': 2},
]


@pytest.fixture
def client(tmp_path, monkeypatch):
    from web.backend.app.config import settings
    monkeypatch.setattr(settings, 'upload_dir', str(tmp_path))
    from web.backend.app.main import app
    from web.backend.app.routers.auth import require_auth
    app.dependency_overrides[require_auth] = lambda: None
    yield TestClient(app)
    app.dependency_overrides.clear()


def _create(client, name='Riff A'):
    resp = client.post('/api/sequences', json={'name': name, 'resolution': 192, 'notes': NOTES})
    assert resp.status_code == 200
    return resp.json()


def test_create_normalizes_ticks_and_lists(client):
    rec = _create(client)
    assert rec['name'] == 'Riff A'
    assert rec['resolution'] == 192
    # Earliest note shifted to tick 0; relative spacing preserved.
    assert [n['tick'] for n in rec['notes']] == [0, 192]
    assert rec['notes'][1]['slideId'] == 2
    listed = client.get('/api/sequences').json()
    assert [s['id'] for s in listed] == [rec['id']]


def test_create_rejects_blank_name_and_empty_notes(client):
    assert client.post('/api/sequences', json={'name': '  ', 'resolution': 192, 'notes': NOTES}).status_code == 400
    assert client.post('/api/sequences', json={'name': 'x', 'resolution': 192, 'notes': []}).status_code == 422


def test_create_rejects_bad_lane(client):
    bad = [{'tick': 0, 'lane': 9, 'sustain': 0}]
    assert client.post('/api/sequences', json={'name': 'x', 'resolution': 192, 'notes': bad}).status_code == 422


def test_rename(client):
    rec = _create(client)
    resp = client.patch(f"/api/sequences/{rec['id']}", json={'name': 'Riff B'})
    assert resp.status_code == 200
    assert resp.json()['name'] == 'Riff B'
    assert client.get('/api/sequences').json()[0]['name'] == 'Riff B'


def test_rename_blank_400_and_missing_404(client):
    rec = _create(client)
    assert client.patch(f"/api/sequences/{rec['id']}", json={'name': ' '}).status_code == 400
    assert client.patch('/api/sequences/nope', json={'name': 'x'}).status_code == 404


def test_clone_copies_notes_with_new_identity(client):
    rec = _create(client)
    resp = client.post(f"/api/sequences/{rec['id']}/clone")
    assert resp.status_code == 200
    copy = resp.json()
    assert copy['id'] != rec['id']
    assert copy['name'] == 'Riff A (copy)'
    assert copy['notes'] == rec['notes']
    assert len(client.get('/api/sequences').json()) == 2


def test_clone_missing_404(client):
    assert client.post('/api/sequences/nope/clone').status_code == 404


def test_delete(client):
    rec = _create(client)
    assert client.delete(f"/api/sequences/{rec['id']}").status_code == 200
    assert client.get('/api/sequences').json() == []
    assert client.delete(f"/api/sequences/{rec['id']}").status_code == 404


def test_corrupt_file_lists_empty(client, tmp_path):
    (tmp_path / 'sequences.json').write_text('not json', encoding='utf-8')
    assert client.get('/api/sequences').json() == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from repo root): `pytest tests/web_backend/test_sequences_router.py -v`
Expected: FAIL — all tests 404 (router not mounted / module missing).

- [ ] **Step 3: Implement the router**

```python
# web/backend/app/routers/sequences.py
"""Cross-track gem-sequence library.

A sequence is a named, tick-normalized run of notes saved from the beatmap
editor's selection. Sequences are shared by all users and persist to
`<upload_dir>/sequences.json` (same file-backed pattern as
generation_presets). Ticks are stored at the source chart's resolution; the
client rescales on paste, so a sequence works in any track regardless of
BPM or tick resolution.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..config import settings


router = APIRouter(prefix='/api/sequences', tags=['sequences'])


class SequenceNote(BaseModel):
    tick: int = Field(ge=0)
    lane: int = Field(ge=0, le=7)
    sustain: int = Field(default=0, ge=0)
    slideId: int | None = None
    type: str | None = None
    pack: str | None = None
    scale: str | None = None


class SequenceCreate(BaseModel):
    name: str
    resolution: int = Field(gt=0)
    notes: list[SequenceNote] = Field(min_length=1)


class SequenceRename(BaseModel):
    name: str


def _sequences_path() -> Path:
    return Path(settings.upload_dir) / 'sequences.json'


def _load() -> list[dict[str, Any]]:
    p = _sequences_path()
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding='utf-8'))
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    return [x for x in data if isinstance(x, dict) and 'id' in x and 'name' in x and 'notes' in x]


def _save(seqs: list[dict[str, Any]]) -> None:
    p = _sequences_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(seqs, indent=2), encoding='utf-8')
    tmp.replace(p)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@router.get('')
async def list_sequences() -> list[dict[str, Any]]:
    return _load()


@router.post('')
async def create_sequence(body: SequenceCreate) -> dict[str, Any]:
    name = body.name.strip()
    if not name:
        raise HTTPException(400, '`name` is required')
    # Normalize so the earliest note sits at tick 0 regardless of what the
    # client sent — paste math assumes a zero-based sequence. None-valued
    # optional fields are dropped to keep the stored JSON compact.
    min_tick = min(n.tick for n in body.notes)
    notes = [
        {k: v for k, v in {**n.model_dump(), 'tick': n.tick - min_tick}.items() if v is not None}
        for n in sorted(body.notes, key=lambda n: (n.tick, n.lane))
    ]
    record: dict[str, Any] = {
        'id': uuid.uuid4().hex[:12],
        'name': name,
        'created_at': _now(),
        'updated_at': _now(),
        'resolution': body.resolution,
        'notes': notes,
    }
    seqs = _load()
    seqs.append(record)
    _save(seqs)
    return record


@router.patch('/{seq_id}')
async def rename_sequence(seq_id: str, body: SequenceRename) -> dict[str, Any]:
    name = body.name.strip()
    if not name:
        raise HTTPException(400, '`name` is required')
    seqs = _load()
    for s in seqs:
        if s['id'] == seq_id:
            s['name'] = name
            s['updated_at'] = _now()
            _save(seqs)
            return s
    raise HTTPException(404, f'No sequence `{seq_id}`')


@router.post('/{seq_id}/clone')
async def clone_sequence(seq_id: str) -> dict[str, Any]:
    seqs = _load()
    for s in seqs:
        if s['id'] == seq_id:
            copy = json.loads(json.dumps(s))
            copy['id'] = uuid.uuid4().hex[:12]
            copy['name'] = f"{s['name']} (copy)"
            copy['created_at'] = _now()
            copy['updated_at'] = _now()
            seqs.append(copy)
            _save(seqs)
            return copy
    raise HTTPException(404, f'No sequence `{seq_id}`')


@router.delete('/{seq_id}')
async def delete_sequence(seq_id: str) -> dict[str, str]:
    seqs = _load()
    kept = [s for s in seqs if s['id'] != seq_id]
    if len(kept) == len(seqs):
        raise HTTPException(404, f'No sequence `{seq_id}`')
    _save(kept)
    return {'id': seq_id, 'deleted': 'true'}
```

- [ ] **Step 4: Mount the router**

In `web/backend/app/main.py`: add `sequences,` to the import list (alphabetical — between `scene_events` and `stems`, line ~30), and add the mount after the `generation_presets` line (94):

```python
app.include_router(sequences.router, dependencies=_auth_dep)
```

- [ ] **Step 5: Run tests to verify they pass**

Run (from repo root): `pytest tests/web_backend/test_sequences_router.py -v`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add web/backend/app/routers/sequences.py web/backend/app/main.py tests/web_backend/test_sequences_router.py
git commit -m "feat(backend): sequence-library CRUD router persisting to sequences.json"
```

---

### Task 6: SequencesPanel component

Presentational panel matching `ClipsLibraryPanel.tsx`'s visual language. Rename commits on blur/Enter (server-backed — don't PATCH per keystroke).

**Files:**
- Create: `web/frontend/src/components/SequencesPanel.tsx`

- [ ] **Step 1: Implement the component**

```tsx
// web/frontend/src/components/SequencesPanel.tsx
import { useState, type ReactNode } from 'react'
import type { SequenceNote } from '../chart/sequences'

export interface SequenceRowData {
  id: string
  name: string
  resolution: number
  notes: SequenceNote[]
}

export type PasteScale = 0.5 | 1 | 2

interface Props {
  sequences: SequenceRowData[]
  scale: PasteScale
  canSave: boolean            // a non-empty gem selection exists
  selectionCount: number
  onScaleChange: (s: PasteScale) => void
  onSaveSelection: (name: string) => void
  onPlace: (id: string) => void
  onRename: (id: string, newName: string) => void
  onClone: (id: string) => void
  onDelete: (id: string) => void
  Wrapper: ({ children, title, right }: { children: ReactNode; title: string; right?: ReactNode }) => ReactNode
}

const SCALES: { value: PasteScale; label: string }[] = [
  { value: 0.5, label: '×½' },
  { value: 1, label: '×1' },
  { value: 2, label: '×2' },
]

function lengthBeats(s: SequenceRowData): number {
  if (s.notes.length === 0) return 0
  const endTick = Math.max(...s.notes.map((n) => n.tick + n.sustain))
  return endTick / s.resolution
}

// One row's rename field: edits locally, commits on blur/Enter so the
// server isn't PATCHed per keystroke.
function NameField({ name, onCommit }: { name: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft !== null && draft.trim() && draft.trim() !== name) onCommit(draft.trim())
    setDraft(null)
  }
  return (
    <input
      type="text"
      value={draft ?? name}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      className="flex-1 min-w-0 bg-transparent border-0 text-[11px] text-gray-200 truncate focus:outline-none focus:bg-gray-800 rounded px-1"
      title={name}
    />
  )
}

export function SequencesPanel({
  sequences, scale, canSave, selectionCount,
  onScaleChange, onSaveSelection, onPlace, onRename, onClone, onDelete, Wrapper,
}: Props) {
  return (
    <Wrapper
      title="Sequences"
      right={sequences.length > 0 ? (
        <span className="text-[10px] text-cyan-300 font-mono">{sequences.length}</span>
      ) : undefined}
    >
      <div className="flex items-center gap-1 mb-1.5">
        <button
          disabled={!canSave}
          onClick={() => {
            const name = window.prompt('Sequence name?')
            if (name && name.trim()) onSaveSelection(name.trim())
          }}
          className="flex-1 text-[10px] px-1.5 py-1 bg-violet-800/50 hover:bg-violet-700/60 disabled:opacity-40 disabled:cursor-not-allowed border border-violet-700/60 text-violet-100 rounded font-medium"
          title={canSave ? `Save the ${selectionCount} selected notes as a reusable sequence` : 'Select some gems first'}
        >
          + Save selection{canSave ? ` (${selectionCount})` : ''}
        </button>
        <div className="flex rounded overflow-hidden border border-gray-700" title="Paste scale — stretch or compress note spacing when placing">
          {SCALES.map((s) => (
            <button
              key={s.value}
              onClick={() => onScaleChange(s.value)}
              className={`px-1.5 py-1 text-[10px] font-mono ${
                scale === s.value ? 'bg-cyan-700/60 text-cyan-100' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {sequences.length === 0 ? (
        <p className="text-[10px] text-gray-600 leading-snug">
          Select gems on the highway (shift+click range, alt+drag marquee) and save them as a reusable sequence.
        </p>
      ) : (
        <ul className="space-y-1">
          {sequences.map((s) => (
            <li key={s.id} className="px-2 py-1.5 rounded border border-gray-800 bg-gray-900/40">
              <div className="flex items-center gap-1">
                <NameField name={s.name} onCommit={(v) => onRename(s.id, v)} />
                <button
                  onClick={() => onClone(s.id)}
                  className="shrink-0 px-1 py-0.5 bg-gray-800 hover:bg-gray-700 rounded text-[10px] text-gray-200"
                  title="Clone this sequence"
                >
                  ⧉
                </button>
                <button
                  onClick={() => { if (window.confirm(`Delete sequence “${s.name}”?`)) onDelete(s.id) }}
                  className="shrink-0 px-1 py-0.5 bg-red-900/30 hover:bg-red-800/60 border border-red-800/40 rounded text-[10px] text-red-300"
                  title="Delete this sequence"
                >
                  ×
                </button>
              </div>
              <div className="text-[10px] text-gray-500 font-mono mt-0.5">
                {s.notes.length}n · {lengthBeats(s).toFixed(1)} beats
              </div>
              <button
                onClick={() => onPlace(s.id)}
                className="mt-1 w-full text-[10px] px-1.5 py-1 bg-gray-800 hover:bg-gray-700 rounded text-gray-200"
                title="Insert at the playhead, snapped to the grid, scaled by the selector above"
              >
                + place at playhead {scale !== 1 ? SCALES.find((x) => x.value === scale)!.label : ''}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Wrapper>
  )
}
```

- [ ] **Step 2: Type-check**

Run (from `web/frontend/`): `npx tsc --noEmit`
Expected: no errors (the component is not yet imported anywhere; that's fine).

- [ ] **Step 3: Commit**

```bash
git add web/frontend/src/components/SequencesPanel.tsx
git commit -m "feat(editor): SequencesPanel component for the sequence library"
```

---

### Task 7: Wire the panel into BeatmapEditor

State, API calls, and the place-at-playhead path (reuses the Ctrl+V merge/reselect pattern and `commitNotes` so undo/autosave work).

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx` (imports ~12–17, state near `clipboardRef` ~2823, handlers near `makeSlide` ~3851, JSX after `ClipsLibraryPanel` ~9004)

- [ ] **Step 1: Add imports**

Next to the `ClipsLibraryPanel` import (line 12):

```typescript
import { SequencesPanel, type PasteScale, type SequenceRowData } from './SequencesPanel'
```

Next to the `slides` import (line 16):

```typescript
import { materializeSequence, normalizeSequence } from '../chart/sequences'
```

- [ ] **Step 2: Add state**

After `const clipboardRef = useRef<ChartNote[]>([])` (line 2823):

```typescript
  // Cross-track sequence library (server-backed, shared by all users).
  const [sequences, setSequences] = useState<SequenceRowData[]>([])
  const [seqScale, setSeqScale] = useState<PasteScale>(1)
```

- [ ] **Step 3: Add the API handlers**

After the `removeSlide` callback (ends ~line 3875, before the next handler):

```typescript
  // Sequence library — list/save/rename/clone/delete against /api/sequences,
  // plus place-at-playhead which goes through the normal commitNotes funnel
  // so undo/redo and autosave behave like any other edit.
  const refreshSequences = useCallback(() => {
    fetch('/api/sequences')
      .then((r) => (r.ok ? r.json() : []))
      .then((data: SequenceRowData[]) => setSequences(Array.isArray(data) ? data : []))
      .catch(() => undefined)
  }, [])

  useEffect(() => { refreshSequences() }, [refreshSequences])

  const seqRequest = useCallback((path: string, init: RequestInit, errLabel: string) => {
    fetch(path, init)
      .then((r) => { if (!r.ok) throw new Error(`${errLabel} failed (${r.status})`) })
      .then(() => refreshSequences())
      .catch((err) => flashRuleError(String(err?.message ?? err)))
  }, [refreshSequences, flashRuleError])

  const saveSelectionAsSequence = useCallback((name: string) => {
    if (!chart || selectedIds.size === 0) return
    const sel = Array.from(selectedIds).map((i) => chart.notes[i]).filter(Boolean)
    seqRequest('/api/sequences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, resolution: chart.resolution, notes: normalizeSequence(sel) }),
    }, 'Save sequence')
  }, [chart, selectedIds, seqRequest])

  const renameSequence = useCallback((id: string, newName: string) => {
    seqRequest(`/api/sequences/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    }, 'Rename sequence')
  }, [seqRequest])

  const cloneSequence = useCallback((id: string) => {
    seqRequest(`/api/sequences/${id}/clone`, { method: 'POST' }, 'Clone sequence')
  }, [seqRequest])

  const deleteSequence = useCallback((id: string) => {
    seqRequest(`/api/sequences/${id}`, { method: 'DELETE' }, 'Delete sequence')
  }, [seqRequest])

  const placeSequenceAtPlayhead = useCallback((seqId: string) => {
    if (!chart) return
    const seq = sequences.find((s) => s.id === seqId)
    if (!seq || seq.notes.length === 0) return
    // Anchor = playhead snapped to the current grid — same convention as
    // Ctrl+V and the clips library.
    const playheadTickRaw = secToTick(tempoSegments, chart.resolution, currentTime)
    const snapTicks = Math.max(1, Math.round(chart.resolution / snapDivisor))
    const baseTick = Math.max(0, Math.round(playheadTickRaw / snapTicks) * snapTicks)
    const pasted = materializeSequence(seq.notes, {
      sourceResolution: seq.resolution,
      targetResolution: chart.resolution,
      scale: seqScale,
      baseTick,
      slideIdStart: nextSlideId(chart.notes),
    }) as ChartNote[]
    const merged = [...chart.notes, ...pasted].sort((a, b) => a.tick - b.tick || a.lane - b.lane)
    const pastedSet = new Set<ChartNote>(pasted)
    commitNotes(merged)
    const newSel = new Set<number>()
    merged.forEach((n, i) => { if (pastedSet.has(n)) newSel.add(i) })
    setSelectedIds(newSel)
  }, [chart, sequences, tempoSegments, currentTime, snapDivisor, seqScale, commitNotes])
```

- [ ] **Step 4: Render the panel**

After the `ClipsLibraryPanel` JSX block (closes line ~9004), insert:

```tsx
          {chart && (
            <SequencesPanel
              sequences={sequences}
              scale={seqScale}
              canSave={selectedIds.size > 0}
              selectionCount={selectedIds.size}
              onScaleChange={setSeqScale}
              onSaveSelection={saveSelectionAsSequence}
              onPlace={placeSequenceAtPlayhead}
              onRename={renameSequence}
              onClone={cloneSequence}
              onDelete={deleteSequence}
              Wrapper={CollapsibleSection as any}
            />
          )}
```

- [ ] **Step 5: Type-check and build**

Run (from `web/frontend/`): `npx tsc --noEmit && npm run build`
Expected: clean. (`materializeSequence(...) as ChartNote[]` is sound — `SequenceNote` is structurally identical to `ChartNote`; the cast narrows `type?: 'real'`.)

- [ ] **Step 6: Manual end-to-end check (needs backend + frontend dev servers)**

With `web/backend/venv/Scripts/python.exe run.py` and `npm run dev` running: open a beatmap → alt-drag across ~10 gems → "+ Save selection" → name it → place at playhead in the same track → switch to a different track/beatmap → panel lists it → place at ×2 → notes land at double spacing on the grid; rename inline; clone; delete with confirm.

- [ ] **Step 7: Commit**

```bash
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): sequence library panel — save/place/rename/clone/delete with paste scale"
```

---

### Task 8: Version bump, docs, full verification, deploy

**Files:**
- Modify: `web/frontend/src/version.ts` (`STUDIO_VERSION` `'1.10.0'` → `'1.11.0'`)
- Modify: `CLAUDE.md` (two spots: the frontend paragraph that says `currently \`1.10.0\`` → `1.11.0`, and append to the BeatmapEditor.tsx feature list: `, shift-click range select + alt-drag marquee selection, and a cross-track sequence library (SequencesPanel + the backend `sequences` router persisting to `<upload_dir>/sequences.json`)`)

- [ ] **Step 1: Apply the two edits above**

- [ ] **Step 2: Full verification**

Run (from `web/frontend/`): `npx vitest run && npm run build`
Run (from repo root): `pytest tests/web_backend/ -v`
Expected: all green. Do not claim success without seeing the output.

- [ ] **Step 3: Commit and push**

```bash
git add web/frontend/src/version.ts CLAUDE.md
git commit -m "chore: release 1.11.0 — large selection + sequence library"
git push
```

- [ ] **Step 4: Deploy to the droplet (backend changed → restart service)**

```bash
ssh -i ~/.ssh/id_ed25519_beatmap root@beatmap.jamsesh.co 'cd /opt/madmom && git pull && cd web/frontend && npm run build && systemctl restart beatmap-backend'
```

Expected: git pull fast-forwards, vite build succeeds, service restarts. Verify with:

```bash
ssh -i ~/.ssh/id_ed25519_beatmap root@beatmap.jamsesh.co 'systemctl is-active beatmap-backend && curl -s http://localhost:8000/api/health'
```

Expected: `active` and a healthy JSON response.
