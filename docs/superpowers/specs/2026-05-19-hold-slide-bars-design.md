# Hold & Slide Bars — 2D Editor + 3D Runway

- **Date:** 2026-05-19
- **Status:** Approved design — ready for implementation planning
- **Area:** `web/frontend/src/components/BeatmapEditor.tsx` and new sibling modules

## 1. Overview

The in-browser beatmap editor renders single notes as gems in both a 2D editor
view and a 3D three.js "runway" preview. Two note features are under-rendered:

- **Holds** (notes with a non-zero `sustain`) render as a translucent bar in 2D
  but are **not drawn at all in 3D** — only the head gem shows.
- **Slides** (`E slide` chart events) are **not rendered anywhere**, and are not
  even represented in the editor's data model — the chart parser drops them into
  a verbatim passthrough bucket.

This feature renders holds and slides as coloured bars across both views, and
makes slides a first-class, editable concept in the editor.

## 2. Goals & non-goals

### In scope

- **3D holds** — render hold sustains as bars on the 3D runway.
- **2D slides** — render slides as coloured bars in the 2D editor.
- **3D slides** — render slides as coloured bars on the 3D runway.
- **Editable slides** — parse slides from the chart into the data model, allow
  authoring/removing them in the 2D editor, and serialize them back out.

### Out of scope

- The **existing 2D hold bar** stays exactly as-is — not restyled.
- The 3D runway remains a **read-only preview**: all editing happens in the 2D
  editor; 3D simply reflects the current chart.
- No new chart event types — slides use the existing `E slide` format.
- No strict enforcement of the generator's "parallel chord slide" rule (see 5.5).

## 3. Background — current state

References below point at `BeatmapEditor.tsx` and are point-in-time (the file is
~5k lines and moves); treat them as starting points, not exact addresses.

- **Note model** (`ChartNote`, ~L18-29): `{ tick, lane, sustain, type?, pack?,
  scale? }`. `lane` 0-4 are coloured frets, 5/6 are force-hopo/tap modifiers, 7
  is an open note. `sustain` is in ticks (0 = single hit). **No slide field.**
- **Slides in the chart** are emitted by `bin/JamseshChartGenerator`'s
  `apply_slide_conversion`. A slide is a contiguous run of note positions:
  - **start** → `E slide <fret>` only (no `N` line)
  - **middle** → `N <fret> 0` + `E slide <fret>`
  - **end** → `N <fret> 0` only (no marker — indistinguishable from a plain note)
  - Chord slides apply the same pattern to a parallel adjacent fret pair.
  - Real example (Expert, chord slide on frets 2+3):
    ```
    16464 = E slide 2 / E slide 3      (start)
    16560 = N 2 0 + E slide 2 / N 3 0 + E slide 3   (middle)
    16608 = N 2 0 / N 3 0              (end)
    ```
- **Chart parsing** currently routes `E slide` lines into `sceneEventsPassthrough`
  — preserved verbatim on save but never parsed or rendered.
- **2D rendering:** notes draw on a canvas as `ctx.arc` gems. Hold sustains
  already draw as a translucent vertical rectangle above the gem head. Slides:
  nothing.
- **3D rendering:** notes draw as pooled FBX gem meshes; lane → `worldX`, time →
  `worldZ` (`Z_PER_SECOND = 4`), gems sit at gem-height `Y`. Holds: nothing.
  Slides: nothing. The 3D loop skips `lane > 4`.
- **Constants:** `LANE_FILL` (2D CSS hex per lane), `LANE_COLOR_HEX` (3D hex per
  lane). Tick↔seconds conversion via the piecewise tempo map (`tickToSec` /
  `secToTick`).

## 4. Design decisions (brainstorming outcomes)

| Decision | Choice |
|----------|--------|
| Scope | 3D holds, 2D slides, 3D slides. Existing 2D hold bar untouched. |
| Slide editability | Editable (parse, author, remove, serialize). |
| Slide storage | Chart-spec-native — the `E slide` run is the source of truth; no sidecar. |
| 2D slide look | **Diagonal ribbon** — continuous band tracing the slide path, per-segment lane colour. |
| 3D bar look (holds + slides) | **Glowing tube** — rounded emissive bar with a bright core. |
| Slide creation UX | **Tag-a-run** — multi-select existing notes, "Make slide". |
| In-memory model | **Note-tagged** — an optional `slideId` on `ChartNote`; a slide is the set of notes sharing an id. |

## 5. Detailed design

### 5.1 Data model & importing slides

- `ChartNote` gains an optional **`slideId: number`**. Notes sharing a `slideId`
  form one slide. Within the group, **earliest tick = start, latest tick = end,
  the rest = middles**. A chord slide is simply two notes at the same tick that
  share the `slideId`.
- On chart load, the parser stops routing `E slide` lines into
  `sceneEventsPassthrough`. Per difficulty section it groups `E slide` events
  into runs and tags the participating notes:
  - Collect `E slide` events; group those sharing a tick into a **slide
    position**. Chain consecutive slide positions into a **run** while the gap to
    the next slide position is within a threshold (mirror the generator's
    `max_gap_sec = 1.5` s, evaluated through the tempo map).
  - The **start** position is an `E slide` with no `N` line — the parser
    **synthesizes a `ChartNote`** there (`sustain = 0`, `lane` = the `E slide`
    fret) so it renders as a gem and is selectable.
  - **Middle** positions already have `N` notes — locate and tag them.
  - The **end** is the nearest `N` note after the last `E slide` tick on each
    fret of the run — locate and tag it.
  - Each successfully grouped run gets a fresh unique `slideId`.
- **Best-effort import:** any `E slide` event that cannot be confidently grouped
  into a run (or whose end note cannot be located) is **left in
  `sceneEventsPassthrough` untouched** — slides are never silently lost.
- Loading an existing generated chart (e.g. the Ben Chango guitar map) therefore
  auto-imports its slides as tagged groups.

### 5.2 Serialization & round-trip

- On chart save, each `slideId` group emits the chart-spec run, computed from
  tick order within the group:
  - start → `E slide <fret>` only (the synthesized note emits **no** `N` line)
  - middles → `N <fret> 0` + `E slide <fret>`
  - end → `N <fret> 0` only
  - per fret for chord slides.
- Events emitted from the model are **removed from `sceneEventsPassthrough`** so
  nothing is double-written.
- Load → tag → save → reload is stable.

### 5.3 2D rendering — slide ribbons

- A new `drawSlideRibbons` step in the canvas draw loop, drawn **beneath** the
  gems so heads stay legible.
- For each slide: order positions by tick, compute each `(x, y)` from lane centre
  and the time→pixel mapping, and connect consecutive positions with a thick
  (≈ lane width × 0.4), semi-transparent segment. **Each segment is coloured by
  the lane it leaves.** Round joins.
- Chord slide → one ribbon per fret.
- A selected slide draws a brightened ribbon with a white edge.
- The existing 2D hold bar is not modified.

### 5.4 3D rendering — hold & slide tubes

- **Holds:** for every note with `sustain > 0` on lanes 0-4, render a stretched,
  emissive **tube** from the head gem extending back along `worldZ` for
  `sustainSeconds × Z_PER_SECOND`. Lane-coloured body with a bright core.
- **Slides:** render a tube following the slide path through 3D space — each
  position at `(lane → worldX, tick → worldZ)`, gem-height `Y` — with per-segment
  lane colour and a bright core.
- Both bar types use a **mesh pool**, mirroring the existing gem-mesh pooling.
- Visibility culling is extended so a bar still renders while only part of its
  length is inside the view window.

### 5.5 Editing flow

- **Make slide:** with **≥2 notes selected**, a "Make slide" action stamps a
  fresh `slideId` onto every selected note.
- **Remove slide:** with a slide (or any member note) selected, "Remove slide"
  clears `slideId` from the whole group; notes revert to plain notes.
- Because a slide is just tagged notes, moving / adding / deleting member notes
  needs no special handling — the slide re-derives from the group. A slide that
  drops below 2 positions **auto-dissolves** (remaining note's `slideId` cleared).
- Clicking a slide ribbon selects the whole slide group.
- Undo/redo is covered by the editor's existing note-snapshot undo, since
  `slideId` is a field on `ChartNote`.
- **Chord slides:** tag-a-run accepts a chord run naturally (two notes per tick
  sharing the id) and renders parallel ribbons/tubes. The generator's HARD RULE
  that chord slides stay parallel is **not enforced** in the editor for v1 —
  manual tagging is trusted.

### 5.6 Code structure

`BeatmapEditor.tsx` is already ~5k lines; this feature must not pile more bulk
into it. New isolated, independently testable modules:

- **`chart/slides.ts`** — pure functions `parseSlides()` (chart events + notes →
  `slideId`-tagged notes + leftover passthrough) and `serializeSlides()` (tagged
  notes → `E slide`/`N` chart lines). No React, no canvas, no three.js.
- **A 3D bars module** — builds and pools the hold/slide tube meshes; consumes
  notes/slides and the existing lane/time mapping.
- The 2D ribbon drawing is small enough to live as a function alongside the
  editor's existing canvas draw code.

## 6. Testing

- **Unit tests for `chart/slides.ts`:**
  - `parseSlides()` on a known `E slide` run → expected `slideId` grouping, with
    start/middle/end roles correct.
  - `serializeSlides()` on a tagged model → exact expected `E slide` / `N` lines.
  - **Round-trip the real Ben Chango guitar chart** (608 holds, slides in all
    four difficulties) → parse then serialize → output is stable/equivalent.
  - Chord-slide parse + serialize.
  - Degenerate `E slide` runs → left in passthrough, not lost.
- 2D ribbon and 3D tube rendering verified manually in the editor.

## 7. Risks & notes

- **Slide-run import is heuristic.** The chart format has no explicit slide
  start/end markers; the end note is indistinguishable from a plain note. The
  gap-threshold grouping is best-effort; un-groupable events fall back to
  passthrough rather than being misimported. This was accepted in design (the
  chart file is the source of truth).
- **Synthesized start notes.** The slide-start `E slide` position has no `N` line
  in the chart; the editor synthesizes a `ChartNote` for it. On save it must emit
  `E slide` only (no `N`) — verified by the round-trip test.
- This is a frontend-only change to the editor; no backend or chart-generator
  changes are required.
