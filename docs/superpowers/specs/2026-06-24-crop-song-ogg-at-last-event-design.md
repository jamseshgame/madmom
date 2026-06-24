# Crop song.ogg at last event — design

**Date:** 2026-06-24
**Status:** Approved, pending implementation plan

## Problem

The `song.ini` `song_length` field is pure metadata — it tells the game runtime
how long the track is supposed to be, but it does not modify `song.ogg`, the
chart, gems, or scene events. Setting it shorter than the real audio just makes
the game end early while the full audio still ships. There is no way, from the
beatmap editor, to actually trim the audio so it ends shortly after the last
charted content (a real need for short tutorials like "Guitar Lesson One",
where `song.ogg` is the full-length mix but the lesson ends after ~17s).

We need an editor button that crops `song.ogg` to end just after the last event,
with selectable trailing padding.

## Decisions (locked)

1. **Crop point = last of anything (max tick):** the latest of any note/gem
   across all difficulties (including sustain tails), scene events, VO clips,
   and tutorial steps.
2. **Scope = `song.ogg` only.** Stems under `sources/*/*.ogg` are left untouched.
3. **Overwrite, update length.** No backup file; overwrite `song.ogg` in place
   and rewrite `song_length` in the beatmap's `song.ini` to the new duration.
   Not reversible — the confirm UI says so.
4. **Padding presets = seconds: 0 / 0.5 / 1 / 2**, plus a custom-ms field.
   Tempo-independent.

## UI

A **Crop audio** button in the editor header (`web/frontend/src/components/
BeatmapEditor.tsx`, ~line 7458), immediately left of the **Save now** button.

Clicking opens a small popover anchored under the button:

- Read-only preview line: `Last event: 0:17.4 · Crop to: 0:18.4 (+1.0s pad)`.
  The "Last event" time is computed on the frontend from the in-memory chart via
  the existing `tickToSec(segs, resolution, tick)` helper, purely for display.
- Padding presets as a button row: **0s · 0.5s · 1s · 2s**, plus a
  `custom ___ ms` numeric field.
- A **Crop song.ogg** confirm button (with a one-line "overwrites song.ogg"
  note) and a status line for the result.

Button is disabled when there is no `song.ogg`. When `dirty`, clicking
auto-saves first (reusing `handleSave`) so the backend reads the authoritative
`notes.chart`, then crops.

## Data flow

The authoritative crop value is computed server-side from the saved
`notes.chart`, so we never depend on the editor's single-difficulty in-memory
note state.

```
[Crop song.ogg] click
  → if dirty: await handleSave()
  → POST /api/tracks/{tid}/beatmaps/{bid}/crop-audio  { padding_ms }
  → backend: parse notes.chart → max tick → ms → crop → update song.ini
  → returns { last_event_ms, crop_ms, duration_ms }
  → frontend: refetch song-peaks, reload <audio> src (cache-bust ?v=<ts>),
    update duration, show status
```

## Backend

New route in `web/backend/app/routers/tracks.py`:
`POST /{track_id}/beatmaps/{beatmap_id}/crop-audio`, body
`{ padding_ms: int = 0 }` (clamped to `>= 0`).

New helper module `web/backend/app/services/crop_audio.py` (kept separate from
`chart_analyser.analyse_chart_file`, which only reads a single BPM):

1. **`last_event_tick(content: str) -> int`** — scan every section body in
   `notes.chart` for the maximum leading integer `tick` on any event line
   (`<tick> = ...`), across all note difficulties, `[Events]`, scene-event
   sections, and tutorial/step sections. For note lines that carry a sustain
   length (`<tick> = N <fret> <length>`), consider `tick + length` so sustain
   tails are included.
2. **`tick_to_ms(sync_body: str, resolution: int, tick: int) -> float`** — walk
   the full `[SyncTrack]` `B` (BPM) entries as ordered tempo segments (not just
   `0 = B`), accumulating milliseconds across segment boundaries up to `tick`.
   Mirrors the frontend `tickToSec`.
3. `crop_ms = tick_to_ms(last_tick) + padding_ms`.
4. `actual_ms = ffprobe duration of song.ogg`; `crop_ms = min(crop_ms,
   actual_ms)` — we only trim, never extend with silence.
5. `ffmpeg -y -i song.ogg -t {crop_ms/1000:.3f} -c:a libvorbis -q:a 6 <tmp>`,
   then atomically replace `song.ogg`.
6. Re-ffprobe the output for its true duration; write
   `song_length = round(new_ms)` into the beatmap's `song.ini` `[song]` section,
   creating the line if absent.
7. Return `{ last_event_ms, crop_ms, duration_ms }`.

## Edge cases

- **Padding beyond file end:** clamped to the real duration; no silence is
  appended. Popover status notes `(file end reached)` when clamped so it is not
  silently confusing.
- **No events at all:** endpoint returns `400`; popover shows "No events to crop
  to."
- **`song.ogg` already shorter than the crop point:** nothing to trim; return
  the existing duration unchanged, status "Already ≤ crop length."
- **Concurrency with autosave:** crop awaits any in-flight save first; the
  dirty→save path reuses `handleSave`.
- **Stems untouched** (per decision 2); only `song.ogg` and `song.ini`'s
  `song_length` change.
- **Not reversible** (per decision 3); confirm button carries an overwrite note.

## Tests

- Backend unit (`crop_audio`): `last_event_tick` over notes vs sustain tail vs
  scene/tutorial sections; `tick_to_ms` across a multi-BPM `[SyncTrack]`;
  clamp-to-duration; `song.ini` `song_length` update (line present and absent).
- Endpoint test with a fixture beatmap dir, ffmpeg-gated like the existing audio
  tests (skip when ffmpeg/ffprobe unavailable).

## Out of scope (YAGNI)

- Cropping or padding the stems.
- Appending trailing silence to extend past the file end.
- Backups / undo of the crop.
- Cropping the start / leading trim.
- Musical (bar/beat) padding units.
