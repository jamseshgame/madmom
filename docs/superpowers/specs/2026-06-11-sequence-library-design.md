# Design: Large gem selection + cross-track sequence library

**Date:** 2026-06-11
**Status:** Approved (pending spec review)
**Scope:** `web/frontend/src/components/BeatmapEditor.tsx`, new sequences panel component, new backend `sequences` router/service.

## Problem

The beatmap editor supports shift-click multi-select and Ctrl+C/V of gem sequences, but selecting a long run (e.g. 100 gems) requires clicking each one. Click-drag rectangle selection naively conflicts with click-to-place. Separately, there is no way to reuse a copied sequence in a *different* track — the clipboard is in-memory and per-session. Reused sequences must land correctly under the target track's BPM/tempo map, and users want to paste at double or half the original note spacing.

## Key existing facts (verified in code)

- Notes are `ChartNote { tick, lane, sustain, slideId?, type?, pack?, scale? }`; all times are **ticks** (musical units, `resolution` ticks per beat). Tick storage makes sequences inherently tempo-independent.
- `selectedIds: Set<number>` holds selection by note-array index. Shift+click and Ctrl/Cmd+click currently both toggle-add — redundant, so one can be repurposed.
- **Alt is unused** on the timeline; no gesture conflicts.
- Ctrl+C normalizes copied ticks relative to the earliest note; Ctrl+V anchors at the playhead snapped to the grid (`snapTicks = resolution / snapDivisor`), then auto-selects pasted notes.
- The Clips library panel (audio sections) is the UI precedent: rows with place-at-playhead, rename, delete.
- Generation presets persist server-side to `<upload_dir>/generation_presets.json` — the storage pattern to copy.

## Decisions (user-confirmed)

1. **Selection:** Shift+click range select + Alt+drag marquee.
2. **Library scope:** server-side, shared by all users (JSON file in upload dir).
3. **Paste flow:** place at playhead with snap, ×½/×1/×2 scale dropdown in the panel.

## 1. Selection upgrades

### Shift+click range select
- Plain-clicking a gem records it as the **selection anchor** (a ref holding the note's identity).
- Shift+clicking another gem selects every note whose `tick` lies in the inclusive range between anchor tick and clicked tick, **across all lanes**.
- Ctrl/Cmd+click keeps current toggle-add behavior. Shift+click loses its toggle-add role (acceptable: Ctrl+click does the same thing).
- Shift+click in *placement* tools keeps its existing meaning (drop OPEN note) — range select applies when clicking an existing gem / in the Select tool, matching current selection-click handling.

### Alt+drag marquee
- Alt+mousedown on the highway starts a marquee instead of placement/scrub, in **any tool**.
- While dragging, the rectangle is drawn in the canvas overlay (semi-transparent fill + border, consistent with editor styling).
- On mouseup, every gem whose rendered position (lane band × time) intersects the rectangle is selected. Plain Alt+drag **replaces** the selection; Alt+Ctrl+drag **adds** to it.
- A marquee below a small movement threshold (~4px, same as the sustain-drag threshold) is treated as a no-op, not a click.

## 2. Sequence library — backend

New router `web/backend/app/routers/sequences.py` + service, mirroring the generation-presets pattern (JSON file persistence, no DB).

**Storage:** `<upload_dir>/sequences.json` — a list of:

```json
{
  "id": "uuid",
  "name": "string",
  "created_at": "iso8601",
  "updated_at": "iso8601",
  "resolution": 192,
  "notes": [
    {"tick": 0, "lane": 2, "sustain": 0, "slideId": 1, "type": "real", "pack": "p", "scale": "s"}
  ]
}
```

- `notes` ticks are normalized so the earliest note is at tick 0 (the frontend normalizes before POSTing, the backend validates `min tick == 0` and non-empty notes).
- Full note data is preserved: sustains, modifier lanes (5 = force-HOPO, 6 = tap, 7 = open), slide groups, real-note fields. Real-note `pack`/`scale` are per-note fields and paste harmlessly.
- `resolution` records the source chart's ticks-per-beat so paste can rescale.

**Endpoints** (auth: same session auth as other studio routers):

| Method | Path | Body | Effect |
|---|---|---|---|
| GET | `/api/sequences` | — | list all |
| POST | `/api/sequences` | `{name, resolution, notes}` | create |
| PATCH | `/api/sequences/{id}` | `{name}` | rename |
| POST | `/api/sequences/{id}/clone` | — | duplicate with `"<name> (copy)"`, new id |
| DELETE | `/api/sequences/{id}` | — | delete |

Pydantic schemas validate note shape (tick ≥ 0 int, lane 0–7 int, sustain ≥ 0 int). Writes are atomic (write temp file, rename) like the presets service.

## 3. Sequence library — frontend panel

New `SequencesPanel` component alongside the Clips library panel (same visual language), wired into `BeatmapEditor.tsx`.

- **Save selection:** button enabled when `selectedIds` is non-empty. Prompts for a name, normalizes selected notes to tick 0, POSTs with the chart's `resolution`.
- **Sequence rows:** name, note count, length in beats. Actions: **Place**, **Rename** (inline edit), **Clone**, **Delete** (confirm).
- **Place:** inserts the sequence at the playhead — anchor tick = playhead seconds → tick via `secToTick`, rounded to the current snap grid — through `commitNotes` so undo/redo and autosave work. Pasted notes are auto-selected afterwards (same convention as Ctrl+V).
- **Scale selector:** ×½ / ×1 / ×2 dropdown in the panel header; multiplies note tick offsets **and** sustains at place time, after resolution rescale. Default ×1; resets per session, not persisted.
- Library state is fetched on panel open and refreshed after mutations; errors surface as the editor's existing toast/error style.

## 4. Tempo / BPM / time-signature correctness

- Tick-based offsets mean a pasted sequence automatically follows the target track's tempo map and time signature grid — a 1-bar groove at source stays beat-aligned at target regardless of BPM.
- **Resolution rescale on place:** `targetTickOffset = round(sourceOffset * targetResolution / sourceResolution)`; same for sustains. Applied before the ×½/×2 scale factor.
- **Slide re-id:** slide group ids in the pasted notes are re-issued to values above the target chart's current max `slideId`, preserving grouping within the sequence without colliding with existing slides.
- Rounding after rescale/scale may produce duplicate `(tick, lane)` pairs in degenerate cases (e.g. ×½ on a 1/32 pattern at coarse resolution); duplicates are dropped, keeping the first.

## 5. Error handling

- Place with an empty library / no sequence selected: button disabled.
- Backend file missing or unparsable: GET returns `[]` and the service rewrites a fresh file on next mutation (presets behavior).
- Network failure on save/place-list-fetch: editor toast, no chart mutation.
- Renaming to an empty string is rejected client- and server-side.

## 6. Testing

- **Frontend unit tests** (pure helpers extracted from the editor): range-select tick window, marquee hit-testing math, normalization to tick 0, resolution rescale + ×½/×1/×2 scaling (offsets and sustains), slide re-id, duplicate-drop after rounding.
- **Backend pytest** (repo root): sequences router CRUD — create/list/rename/clone/delete, validation failures (empty notes, bad lane), file-missing recovery.

## Out of scope

- Per-user libraries / ownership.
- Ghost-preview click-to-place.
- Triplet or swing snap grids.
- Auditioning a sequence's audio from the panel.
