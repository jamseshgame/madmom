# Imported Sources & Splices — Design Spec

**Date:** 2026-05-14
**Scope:** Studio editor (frontend + backend) for the Jamsesh tutorial
authoring flow.

## Problem

A tutorial author wants to teach "the guitar solo from Stairway to
Heaven" or "the verse riff from Crashing Down". The audio + per-stem
chart for the source song already exists as a normal Studio beatmap
(produced by the existing Create flow: stem-split + per-stem chart-gen).
But there's no way to pull that source into a tutorial and use a
section of it as a playable drill.

Today the tutorial editor's only way to add a music block is the
external-clip upload modal — re-upload, re-generate notes, no way to
work against the rich chart that already exists for the source song.

## Solution

Two new in-editor capabilities:

1. **Import a source beatmap** into a tutorial. The tutorial chart
   gains an `[ImportedSources]` section that maps a stable local id to
   `(track_id, beatmap_id)`. The tutorial editor exposes a sidebar
   panel listing imported sources with a `+ Import beatmap…` picker
   that surfaces the user's Studio Library.

2. **Splice sections from the active source** via a waveform strip.
   Drag-region selects a window on the source's `song.ogg`; saving
   creates a `[MusicSeg_<id>]` chart section holding the trimmed slice
   of the source's chart (notes renormalised to start at 0, sustains
   trimmed, `(pack, scale)` state propagated). Saved splices appear in
   a clips library; placing one drops a `MUSIC` event in the tutorial
   that references the source + slice window.

Audio is **not** cut into separate files while authoring. Splices live
as `(source, start_ms, duration_ms)` references. At publish time the
backend copies each imported source's `song.ogg` into
`sources/<local_id>/song.ogg` in the published folder; the chart's
`MUSIC` events resolve to that path.

The existing `compute_audio_peaks` helper (madmom-backed, in
`web/backend/app/services/audio.py`) is the canonical waveform analyser
for this and any future feature that needs peak data.

## Chart format additions

### New top-level section: `[ImportedSources]`

```
[ImportedSources]
{
  src_a = track="dad74f011619" beatmap="09a78ac50b86" name="Crashing Down"
  src_b = track="abc..." beatmap="def..." name="Stairway"
}
```

- Local id is `[a-z][a-z0-9_]*` (e.g. `src_a`, `verse_riff`). Stable
  for the life of the tutorial chart — never renumbered or renamed by
  any automated path; the user can rename via the sidebar but the
  resulting chart edit is just a rename in this section + a
  search-and-replace across `MUSIC source="..."` references.
- `track` / `beatmap` are the Studio-side ids (12-char hex slugs).
- `name` is a display label, copied from the source beatmap's
  `song_name` at import time. Used for the sidebar list.

### Extended `MUSIC` event line

```
<tick> = MUSIC source="src_a" stem="song"
         start_ms=18300 duration_ms=24000
         section="MusicSeg_<id>"
         bpm=... resolution=... duration=... notes=...
         required=... timing=...
         [retry_vo=... retry_start_ms=... retry_duration_ms=... next=...]
```

New fields: `source`, `stem`, `start_ms`, `duration_ms`. Behaviour:

- `source` = the local id from `[ImportedSources]`. The engine resolves
  to `sources/<source>/<stem>.ogg` (default stem `song`).
- `start_ms` + `duration_ms` carry the slice window (mirrors `VO`'s
  pattern). Engine plays the windowed slice.
- The legacy `file="segments/<id>.ogg"` shape (existing upload-based
  music segments) remains supported. Parser distinguishes by which
  fields are present.

### `[MusicSeg_<id>]` sections

Unchanged shape (already used by today's upload-based music segments).
For source-based splices, the section body's optional comment header
records the source pointer + window so the editor can rebuild the clip
state on reload:

```
[MusicSeg_a3f8c2]
{
  ; source="src_a" start_sec=18.300 end_sec=42.300 name="Guitar solo"
  0   = E realnotes_pack ...
  0   = E realnotes_scale ...
  384 = R 1 0
  ...
}
```

A `[MusicSeg_<id>]` section without a `MUSIC` event referencing it is
"library-only" — kept across save/reload but not shipped at publish.

## Editor UI

### Top-of-editor: WaveformStrip (new)

A new horizontal strip directly below the existing TutorialTimeline.
Renders peak amplitudes for the **active source's** `song.ogg`. Active
source defaults to the tutorial's own track (no import). The
WaveformStrip's existing behaviour from the prior design carries over:

- Click → seek the playhead.
- Wheel → zoom (shared zoom + scroll state with TutorialTimeline).
- Drag → define a new clip region; release → name + Save popover.
- Library clips: render as ghosted regions; click to select.

When the active source is an imported one, the WaveformStrip displays
its waveform; the tutorial's own playhead still drives transport (the
two timelines are decoupled — the engine plays the tutorial's audio
during transport; the source's waveform is just a visual reference for
splicing).

### Right sidebar: Imported sources panel (new)

```
┌─ Imported sources (2) ────────────────────┐
│  ◉ src_a — Crashing Down · 4 splices       │ ← currently active
│  ○ src_b — Stairway · 0 splices            │
│  [+ Import beatmap…]                        │
└────────────────────────────────────────────┘
```

- Radio-style: one source is "active" at a time. The WaveformStrip
  follows the active source.
- A pseudo-row at the top represents the tutorial's own track ("(this
  tutorial — no splicing)"). Selecting it just shows the tutorial's
  own song waveform; it can't be spliced from (it's the tutorial
  itself).
- `+ Import beatmap…` opens a Studio Library picker (modal). Picker
  lists every track + beatmap (uses existing `/api/tracks` + per-track
  beatmap data). On pick: editor adds a new `[ImportedSources]` entry
  with auto-generated local id + the source's `song_name`.
- Per-row inline rename → updates the chart's `[ImportedSources]`
  entry + rewrites every `MUSIC source="..."` reference on save.
- Per-row delete → confirms ("removes the imported source AND any
  splices that reference it") then removes the `[ImportedSources]`
  entry, all referencing `MUSIC` events, and the corresponding
  `[MusicSeg_<id>]` sections.

### Right sidebar: Clips library panel (existing)

Already designed; unchanged shape. Each row gains a small
`(src_a)` badge so the author can see which source a splice came
from at a glance.

## Slice computation

A new pure helper in `BeatmapEditor.tsx`:
`sliceSourceChartForClip(sourceNotes, sourceTempoSegments, sourceResolution, startSec, endSec)`.

Identical algorithm to the previous design's `sliceChartForClip` (hard
clip with sustain trim + `(pack, scale)` state propagation). The
difference is the input: the source beatmap's notes + tempo map +
resolution, fetched on import (not the tutorial's own).

The fetched source chart is cached client-side per source id so
multiple splices from the same source don't re-fetch.

## Backend additions

### Reuse: `compute_audio_peaks`

Already in `web/backend/app/services/audio.py` (Task 1 work,
already on main). Used as-is.

### New endpoint: `GET /api/tracks/<tid>/beatmaps/<bid>/song-peaks`

Returns per-bucket Float32 peak data for the named beatmap's
`song.ogg`. Mirrors the previously-designed track-level endpoint,
scoped to a beatmap. Cached on disk as `<beatmap>/song.peaks.f32`,
invalidated on `song.ogg` mtime change. Same `application/octet-stream`
binary response format.

Why per-beatmap rather than per-track: an imported source might be a
beatmap whose stem isn't the unsplit `song.ogg` of its track. We want
the audio that this beatmap is associated with. Most beatmaps have
their own `song.ogg` (a copy of the track's); fetching by beatmap id
keeps the URL self-contained without needing two ids.

### Publish flow — bundle imported sources

`_bundle_tutorial_assets` in `routers/tracks.py` gains a step. After
the merged chart lands at `tmp_dir/notes_fixed_slides.chart`:

1. Parse the `[ImportedSources]` section.
2. For each `(local_id, track_id, beatmap_id)`: copy the source's
   `song.ogg` (from `<UPLOAD_DIR>/_tracks/<track_id>/beatmaps/<beatmap_id>/song.ogg`,
   or fall back to `<UPLOAD_DIR>/_tracks/<track_id>/stems/song.ogg`)
   to `tmp_dir/sources/<local_id>/song.ogg`.
3. Drop the `[ImportedSources]` section from the published chart
   (Unity doesn't need the studio-side ids — `MUSIC source="..."`
   resolves directly to `sources/<source>/song.ogg`).
4. Strip orphan `[MusicSeg_<id>]` sections (sections no `MUSIC`
   event references) — same as the previously-designed publish
   change, no longer source-aware.

If a referenced source's audio is missing on disk, log a warning and
skip; the publish doesn't fail (Unity will play silence for that
event).

## Editor playback

Mirrors the existing VO pattern.

### Audition (preview button on a clip)

Slice clips: create an `<audio>` for the source's `song.ogg`, seek to
`startSec`, play, auto-stop at `endSec`. URL =
`/api/tracks/<src_track>/beatmaps/<src_beatmap>/download/song.ogg`
(this endpoint already exists for the editor's main playback path).

Upload-based clips: existing per-segment URL.

### Transport-time MUSIC playback

When the playhead crosses a `MUSIC` event during tutorial transport:

- Source-based: same as audition — fetch source song.ogg, slice it.
- Upload-based: existing behaviour.

The clip plays "alongside" the tutorial's own backing track during
preview. (At Unity runtime the engine will probably pause the backing
track during the splice; that's a runtime concern, not chart-format.)

## Studio Library picker (modal)

A new component `SourcePickerModal` rendered when the user clicks
`+ Import beatmap…`. Two-column layout:

```
┌─ Pick a beatmap to import ─────────────────────────────────┐
│  Tracks (12)                Beatmaps                       │
│  ┌──────────────────┐       ┌────────────────────────────┐ │
│  │ Crashing Down    │ ─→    │ song · 14:30 · 1248 notes   │ │
│  │ Stairway         │       │ guitar · 03:21 · 564 notes  │ │
│  │ ...              │       │ drums · 03:21 · 322 notes   │ │
│  └──────────────────┘       └────────────────────────────┘ │
│                                                             │
│  Local id: [src_a       ]   [Cancel]  [Import]              │
└────────────────────────────────────────────────────────────┘
```

- Tracks pulled from existing `GET /api/tracks`.
- Beatmaps pulled from the per-track entry (`GET /api/tracks/<id>`
  already returns `beatmaps[]`).
- Local id auto-suggested as `src_<n>` where n is the next free
  integer. Editable.
- Validates the local id matches `[a-z][a-z0-9_]*` and isn't already
  taken in the tutorial's `[ImportedSources]`.

## Error handling and edge cases

- **Imported source's track or beatmap deleted from Studio**: the
  `[ImportedSources]` entry stays; the editor flags the row as
  "missing" and disables the WaveformStrip when it's selected. Splices
  still exist in the chart and can be removed manually.
- **Source's `song.ogg` is missing at publish time**: log a warning and
  copy nothing for that source. The chart's `MUSIC` events still
  reference the path; Unity will play silence. (No cascading publish
  failure.)
- **Local id collision on import**: picker rejects the import with an
  inline error.
- **Renaming a local id**: search-and-replace across all
  `MUSIC source="<old>"` references on save.
- **Cross-tempo splices**: the slice helper renormalises ticks
  linearly using the source's tempo at `startSec`. Variable-tempo
  inside a splice isn't supported in v1 (notes drift if source has
  internal tempo changes); flagged in code comment.
- **Dragging on the WaveformStrip when no source is active or the
  active source is the tutorial itself**: drag-region disabled (you
  can't splice from the tutorial's own audio).
- **Library-only splices for an unimported source** (e.g. user
  imported, splaced, then deleted the import): on parse, splices whose
  `source` doesn't appear in `[ImportedSources]` get flagged in the
  library panel as "orphaned"; user can delete or re-import the source
  to revive them.

## Out of scope (deliberately not in v1)

- Snapping clip boundaries to beat / bar / note onsets.
- Fade-in / fade-out at slice boundaries.
- Per-stem splicing (always uses the source's full mix `song.ogg`,
  never a single stem).
- Variable-tempo within a clip.
- Cross-source clip merging (e.g. crossfade between source A's verse
  and source B's chorus into one MUSIC event).
- Re-editing a splice's notes after creation (the `MusicSeg` section
  is hand-editable in the chart text but no UI affordance).

## Files affected

Backend:
- `web/backend/app/routers/tracks.py` — new per-beatmap `song-peaks`
  endpoint; publish-time `[ImportedSources]` copy + strip + orphan
  `MusicSeg` strip in `_bundle_tutorial_assets`.

Frontend (`web/frontend/src/components/`):
- `BeatmapEditor.tsx` — extend `ChartState` with `importedSources`,
  `clips` (re-derived to be source-aware), `activeSourceId`; lift
  `selectedClipId`; new `parseImportedSources` /
  `serializeImportedSources` helpers; extended MUSIC parsing /
  serialization (new `source`/`stem`/`start_ms`/`duration_ms` fields);
  new `sliceSourceChartForClip` helper; layout slot for
  WaveformStrip + ImportedSourcesPanel; place-at-playhead wiring;
  source-fetch cache.
- `WaveformStrip.tsx` (new) — peaks rendering, drag-region, edge
  handles, popover. Same component as the previous design (no
  source-awareness; the parent picks which peaks/clips to feed it).
- `ImportedSourcesPanel.tsx` (new) — sidebar list, +import button,
  rename, delete.
- `SourcePickerModal.tsx` (new) — Studio Library picker.
- `ClipsLibraryPanel.tsx` (new, mostly as before) — sidebar list with
  source badges, audition, +place, rename, delete.

Spec:
- `web/docs/REALNOTES_SPEC.md` — append a paragraph on
  `[ImportedSources]`, MUSIC `source=`/`start_ms`/`duration_ms` fields,
  and the `sources/<id>/song.ogg` published-folder layout.

Testing:
- `web/backend/tests/test_song_peaks.py` (existing, from Task 1) —
  extend with a per-beatmap variant for the new endpoint.
- `web/backend/tests/test_publish_imported_sources.py` (new) — pytest
  for the `[ImportedSources]` parse + copy + strip behaviour.
