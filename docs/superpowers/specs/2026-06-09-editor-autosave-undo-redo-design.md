# BeatmapEditor — Autosave + Undo/Redo

**Date:** 2026-06-09
**Component:** `web/frontend/src/components/BeatmapEditor.tsx`

## Goal

Add (1) autosave that persists after every change and (2) undo/redo with
effectively unlimited steps, to the in-browser beatmap editor.

## Enabling insight

Every edit already mutates `chart: ChartState` immutably
(`setChart({ ...chart, notes: next })`). The undo stack therefore stores
**references to past `chart` objects** — unchanged sub-trees (`fullText`,
`tutorial`, `tempoMarkers`, …) are structurally shared, so each history entry
costs only the diff. No deep cloning required; "infinite steps" is cheap.

**Correctness caveat:** any *in-place* mutation of chart sub-objects
(`notes.push()`, `note.tick = …`, `.sort()`) would corrupt a shared past
snapshot. Audit for these during implementation and clone-on-write where found.

## Component 1 — Undo/Redo controller

In-component history: `past: ChartState[]`, `future: ChartState[]`, funneled
through a single entry point.

- **`commitChart(next, coalesceKey?)`** — replaces the discrete-edit
  `setChart(...) + setDirty(true)` pairs (~20 sites). Pushes current `chart`
  onto `past`, clears `future`, applies `next` (value or `prev => next`), sets
  dirty. Accepts both a value and an updater function.
- **Coalescing via `coalesceKey`** — continuous gestures (note drag-move,
  sustain/placement drag, VO runway drag) call `commitChart(next, 'drag')` each
  frame; only the first frame pushes history. One gesture = one undo step.
  Same mechanism coalesces rapid text typing. Coalesce is keyed + time-windowed
  (consecutive same-key commits within a short window merge).
- **Raw `setChart` (no history)** — initial load/reload, post-save `fullText`
  sync, difficulty-switch navigation.
- **`undo()` / `redo()`** — move snapshots between stacks; set dirty so the
  result autosaves.
- **UI** — Undo/Redo buttons in the toolbar by Save (disabled when stack empty,
  tooltips show shortcuts). Keyboard: `Ctrl/⌘+Z`, `Ctrl/⌘+Shift+Z`, `Ctrl+Y`,
  ignored when a text input/textarea/select is focused (reuse existing guard).
- Unbounded by request, with a safety cap (~500) to bound pathological sessions.

## Component 2 — Autosave (debounced)

- Effect watches `dirty`; each change (re)arms a **1.5s** timer that calls the
  existing `handleSave`. Rapid edits coalesce into one PUT.
- **Manual "Save chart" button stays** as a force-flush (cancels pending timer,
  saves now).
- Status: reuse the existing `saveMsg` slot — `Saving…` / `All changes saved`.
- In-flight safety: if a change lands mid-save, re-arm afterward.
- **`beforeunload` guard tightened** to fire only when a save is pending or
  in-flight, not on every dirty state.
- Guarded against firing during initial load / when `chart` is null.

## Out of scope (YAGNI)

No server-side revision history. No undo for separately-persisted side-states
(background video, gamepad binding, view3d) — they keep their own save buttons.
Undo/redo covers the `ChartState` model only.
