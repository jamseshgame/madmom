# Clip-from-full-song — Design Spec

**Date:** 2026-05-14
**Scope:** Studio editor (frontend + backend) for the Jamsesh tutorial
authoring flow.

## Problem

A tutorial author wants to drill the player on a section of a real song
(e.g. "the guitar solo from Track X"). Today the only way to add a
playable music block to a tutorial is to **upload a short standalone
audio clip**, which the backend then runs the chart generator over. That
flow has two problems for this use case:

1. The author already has the full song attached to the track and the
   full chart generated for it. Re-uploading and re-generating a sub-
   section is wasted work and breaks BPM continuity at the seams.
2. There's no way to visually mark "the solo starts here, ends here"
   against the song's audio waveform — the author has to chop the audio
   externally and guess at boundaries.

## Solution

Two new in-editor capabilities:

1. A **waveform strip** for the track's `song.ogg`, rendered directly
   below the existing tutorial-events timeline at the top of the editor.
2. **Drag-region clip authoring** on the waveform: select a span, name
   it, save it as a "clip". The clip pre-extracts the matching slice of
   notes from the already-generated full chart. Saved clips appear in a
   new sidebar **clip library** panel and can be placed (one or many
   times) onto the tutorial timeline by clicking "+ place at playhead".

Audio is **not** cut into separate files. A clip is a (start_ms,
duration_ms) window into `song.ogg`. The chart's `MUSIC` event line
carries those offsets the same way `VO` events already do.

## Data model

### Chart-level

A clip lives as an existing-shape `[MusicSeg_<id>]` chart section. The
section body holds the trimmed notes (ticks renormalised to start at 0,
sustains trimmed at the OUT boundary, with any active
`E realnotes_pack` / `E realnotes_scale` state at the IN boundary
prepended at tick 0).

A `MUSIC` event in `[TutorialScript]` references a section by name. A
section that no `MUSIC` event references is "library-only"; one with
≥ 1 referencing event is "placed". The same section can be referenced
by multiple `MUSIC` events at different ticks (e.g. teach pass + quiz
pass).

Slice-mode `MUSIC` events gain two new optional fields:

| Field          | Meaning                                                 |
| -------------- | ------------------------------------------------------- |
| `start_ms`     | Offset into `song.ogg` (or whatever `file=` points to). |
| `duration_ms`  | Slice length; engine stops playback at start+duration.  |

A `MUSIC` event with these fields and `file="song.ogg"` is a slice; a
`MUSIC` event with `file="segments/<id>.ogg"` and no slice fields is the
existing standalone-file shape, still supported.

### Frontend state

`ChartState` gains:

```ts
clips: Clip[]            // derived from [MusicSeg_*] sections on parse
```

```ts
interface Clip {
  id: string                 // matches the section name's id suffix
  sectionName: string        // 'MusicSeg_a3f8c2'
  name: string               // user-facing label, persisted as a `; name=...` comment in the section header
  startSec: number           // window into song.ogg
  endSec: number
  notesCount: number         // for the library panel display
  bpm: number                // local tempo at startSec, for display
}
```

Top-level component state adds `selectedClipId: string | null`, lifted
the same way `selectedTutorialId` already is.

### Persistence in `notes.chart`

A library clip's metadata (name, start_sec, end_sec) lives as a comment
line at the top of its section body so the existing chart save / load
roundtrip carries it without a new top-level section:

```
[MusicSeg_a3f8c2]
{
  ; name="Guitar solo" start_sec=18.300 end_sec=42.300
  0   = E realnotes_pack electric-distortion
  0   = E realnotes_scale e-minor-pentatonic
  384 = R 1 0
  ...
}
```

The `parseMusicSections` helper is extended to parse the comment line
into `Clip` fields; `serializeMusicSections` emits it.

## UI

### Waveform strip

A new `WaveformStrip` component, rendered directly below the existing
`TutorialTimeline` in the editor's top header. They share `view`
(zoom + pan) state so the same x-pixel = the same time across both
strips.

Behaviour:

- Renders `song.ogg`'s peaks horizontally.
- Click anywhere → seek the playhead to that time (same as
  TutorialTimeline).
- Click-drag → start a new clip region. Release shows a popover with a
  name input + Save / Cancel.
- Library clips render as lower-opacity translucent regions with a thin
  border. Click one → selects it; the drag-region UI snaps to its
  bounds; the popover lets the author rename, save edits, or delete.
- Upload-based clips (existing flow, no slice metadata) appear in the
  library panel but **not on the waveform** — they have no `startSec` /
  `endSec`. The library row shows them with an "(uploaded)" tag.
- Two edge handles on the active region for fine-tune nudging.

Empty state: when `song.ogg` has no decodable audio (silent test
benches), the strip is hidden and replaced by an inline note that
clipping is unavailable.

### Clips library panel

A new `CollapsibleSection` in the right sidebar, alongside Tutorial
events / Scene events / Sound packs. Each row:

```
⏵ Guitar solo  · 24.0s · 18 R notes        [+ place]   ✎ rename   × delete
```

- `⏵` audition — slice-plays `song.ogg` windowed via the same WebAudio
  pattern VO uses today.
- Selecting a row scrolls and selects the matching region on the
  waveform strip.
- `+ place` adds a `MUSIC` event at the current playhead tick referencing
  the clip's section (no new section, no duplication).
- Rename → updates the comment line in the section header on next chart
  save.
- Delete → removes the section AND any `MUSIC` events referencing it,
  with a confirmation dialog.

The existing `+ MUSIC` sidebar button stays untouched for the
external-clip upload flow.

## Backend

### New endpoint: `GET /api/tracks/<tid>/song-peaks?stem=song`

Returns a normalised `Float32Array` of audio peaks (one bucket per
~20 ms) so the WaveformStrip can render immediately on editor open
instead of waiting for client-side WebAudio decode (~1–2s on a 5-min
song).

- Caches output to `<track>/stems/song.peaks.f32` (a binary
  Float32Array dump). Invalidated on `song.ogg` mtime change.
- Response: `Content-Type: application/octet-stream`; the frontend reads
  it directly into a `Float32Array`. Saves bandwidth and parse cost
  versus a JSON array.

### Existing endpoints unchanged

- `PUT /api/tracks/<tid>/beatmaps/<bid>/chart` — the full chart text
  round-trip continues to carry `[MusicSeg_*]` sections and `MUSIC`
  event lines including the new `start_ms` / `duration_ms` fields. No
  new save endpoint needed.
- `POST /api/tutorial/<tid>/<bid>/music-segment` — the upload-based
  standalone-clip path stays as-is for external audio.

### Publish flow change

`_bundle_tutorial_assets` (in `routers/tracks.py`) gains one step:
after the chart is merged into `tmp_dir/notes_fixed_slides.chart`, walk
its sections and **drop any `[MusicSeg_<id>]` section whose name is not
referenced by any `MUSIC` event in `[TutorialScript]`**. Library-only
clips don't ship.

No other publish-side change. Slice-mode MUSIC events emit with
`start_ms` / `duration_ms`; `song.ogg` already ships.

## Slice computation

A new pure function `sliceChartForClip(notes, tempoSegments, resolution,
startSec, endSec): {sectionBody, notesCount, bpm}` next to
`parseSectionNotes`. Lives in the editor's TS code (frontend computes
the slice; backend just persists via the existing chart save).

Algorithm:

1. Convert (`startSec`, `endSec`) to ticks via `secToTick`.
2. Walk active `(pack, scale)` state from the start of the source
   section forward to `inTick`. Record the values.
3. For each `R` / `N` note with `tick ∈ [inTick, outTick)`:
   - `newTick = tick - inTick`
   - if `tick + sustain > outTick`, `newSustain = outTick - tick`,
     else `newSustain = sustain`
   - emit accordingly
4. If active `(pack, scale)` from step 2 is non-empty, emit prepended
   `0 = E realnotes_pack <p>` and `0 = E realnotes_scale <s>` at tick 0.
5. For any `E realnotes_pack/scale` events in `[inTick, outTick)`, emit
   them with `newTick = tick - inTick`.
6. Serialize as a section body string.
7. Return `{sectionBody, notesCount = count of R/N lines, bpm = local
   tempo at startSec}`.

## Save action flow

1. User finishes drag-region on the waveform, types a name in the
   popover, clicks Save.
2. Frontend calls `sliceChartForClip(...)` to get section body.
3. Generates `sectionName = 'MusicSeg_' + uuid().slice(0, 8)` (collide
   check against existing sections).
4. Adds the section to `chart.musicSections` and the corresponding
   `Clip` entry to `chart.clips`.
5. Sets `dirty = true`. Existing chart-save flow persists on next user
   save.

No backend round-trip on Save Clip — the frontend has everything.

## Place-at-playhead flow

1. User clicks "+ place" on a library clip (or future: drags it onto
   the runway sidecar).
2. Frontend constructs a `TutorialMusicEvent`:
   - `tick = playheadTick`
   - `file = 'song.ogg'`
   - `sectionName = clip.sectionName`
   - `startMs = round(clip.startSec * 1000)`
   - `durationMs = round((clip.endSec - clip.startSec) * 1000)`
   - other fields default (`required = min(5, notesCount)`, `timing = 'any'`).
3. Append to `chart.tutorial`.

Existing pill-rendering, side-panel editor, and editor playback all
already handle the `MUSIC` kind — no further changes needed for
placement display or playback.

## Audition / preview playback

Mirror the existing VO playback pattern (`useEffect` + `voAudiosRef`):

- **Slice clips** (`startSec` / `endSec` set): one `HTMLAudioElement` for
  `song.ogg` shared across all slice-clip auditions + slice-mode MUSIC
  playback. On audition: `audio.currentTime = startSec; audio.play()`. A
  `timeupdate` listener pauses at `endSec - 0.01s` and removes itself.
- **Upload-based clips** (no slice metadata): one `HTMLAudioElement` per
  clip, sourced at `/api/tutorial/<tid>/<bid>/segments/<file>`. Plays
  the whole file. Identical to today's behaviour for upload-based MUSIC
  events.

## Error handling and edge cases

- **Missing `song.ogg`**: WaveformStrip hides; inline notice replaces it;
  rest of editor works.
- **Backend song-peaks 503 / fails**: client-side WebAudio fallback
  (existing decode path).
- **Drag region with `endSec ≤ startSec`**: rejected in UI before
  popover opens.
- **Region extends past song duration**: clamped to song duration on
  Save.
- **Tempo changes inside a slice**: source-side tick math is correct
  (uses full tempo map). Renormalised clip ticks (starting at 0) won't
  perfectly recover wall-clock time at variable tempo unless the slice
  also includes a scaled SyncTrack — out of scope for v1; clips are
  treated as locally constant tempo. Code comment in
  `sliceChartForClip`.
- **Library clip references a hand-deleted section**: drops out of
  `chart.clips` on parse. No crash.
- **`MUSIC` event with `start_ms` / `duration_ms` AND a non-`song.ogg`
  file**: log a warning, fall back to whole-file playback. Defensive
  against hand-edited charts.
- **Two clips with the same name**: allowed — addressed by section id.
- **Discarding an unsaved drag-region**: drop local state.

## Testing

- **Backend**: pytest for the song-peaks endpoint (golden output
  against a known-length silent ogg; cache hit / miss; 404 for missing
  stem).
- **Frontend**: no existing test scaffold. Cover via manual smoke:
  1. Open Realnote Test v1 (silent song) → strip shows empty-state.
  2. Open a real generated track → strip renders peaks.
  3. Drag-region → save → clip appears in library panel.
  4. Audition → playback within slice window.
  5. + place at playhead → `MUSIC` event appears on sidecar pill +
     side-panel editor.
  6. Save chart → reopen → clip + placement survive.
  7. Publish to game repo → `notes_fixed_slides.chart` contains the
     placed `[MusicSeg_*]` section AND the `MUSIC` event with
     `start_ms` / `duration_ms`. Library-only clips don't appear.
  8. Delete a placed clip → both section and event disappear.

## Out of scope (deliberately not in v1)

- Snapping clip boundaries to beat / bar / note onsets.
- Fade-in / fade-out at slice boundaries.
- Re-editing the slice's notes after creation (the `MusicSeg` section is
  hand-editable in the chart text but no UI affordance).
- Per-clip BPM override.
- Tempo-change-aware slicing (variable tempo within a clip).
- Drag-and-drop from clip library directly onto the runway sidecar
  (placement is via "+ place at playhead" only in v1).

## Files affected

Backend:

- `web/backend/app/routers/tracks.py` — new song-peaks endpoint;
  publish-time orphan-section strip in `_bundle_tutorial_assets`.
- `web/backend/app/services/audio.py` — peaks extraction helper added
  here (existing module already houses image-resize + other media
  utilities).

Frontend (`web/frontend/src/components/`):

- `BeatmapEditor.tsx` — extend `ChartState` with `clips`; lift
  `selectedClipId`; new `sliceChartForClip` helper; extended
  `parseMusicSections` / `serializeMusicSections`; layout slot for the
  WaveformStrip; "+ place at playhead" wiring.
- `WaveformStrip.tsx` (new) — peaks rendering, drag-region, edge
  handles, popover.
- `ClipsLibraryPanel.tsx` (new) — sidebar list + actions.

Spec:

- `web/docs/REALNOTES_SPEC.md` — already documents `MUSIC` events;
  append a paragraph on the new slice fields and the editor-only nature
  of library clips.

Testing:

- `web/backend/tests/test_song_peaks.py` (new).
