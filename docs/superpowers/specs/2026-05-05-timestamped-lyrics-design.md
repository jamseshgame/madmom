# Timestamped Lyrics — Design

**Status:** Approved · ready for implementation plan
**Date:** 2026-05-05
**Owner:** Freshdex

## Goal

Let users attach time-synced lyrics to a track, surface them in the manual beatmap editor, and embed them in the published Clone Hero `notes.chart` so the song renders karaoke-style in-game.

Two source paths:

1. **LRClib** (free, community-sourced, line-level timestamps) — fast, fails on obscure tracks.
2. **Whisper transcription** (`faster-whisper`, `medium` model, word-level timestamps) — works on anything but is heavy and not always accurate on sung vocals.

LRClib and Whisper are exposed as **two separate user-initiated buttons**, side-by-side on the vocals stem card and the Studio Library track detail. Lyrics are normalized to a single shape regardless of source.

## Non-goals (deferred)

- Translation / localization
- Multi-language tracks
- Lyrics search across the library
- Auto-fetch on separation complete (always user-initiated)
- Karaoke-only mode toggles in-game

## Data model

Single normalized JSON file `lyrics.json`, persisted next to other per-track files (the demucs job's stems dir on first fetch; the published track folder on publish).

```json
{
  "source": "lrclib" | "whisper",
  "language": "en",
  "model": "medium",                    // present iff source = whisper
  "fetched_at": "2026-05-05T13:00:00Z",
  "words": [
    { "time_s": 12.34, "text": "Hello", "phrase_start": true },
    { "time_s": 12.62, "text": "world" },
    { "time_s": 13.10, "text": "tonight", "phrase_end": true },
    { "time_s": 14.80, "text": "the",     "phrase_start": true },
    ...
  ]
}
```

- `time_s` — seconds from track start. Single source of truth. Tick conversion happens at chart-write time using the chart's `[SyncTrack]` tempo map.
- `phrase_start` / `phrase_end` — booleans on the relevant word. LRClib emits one phrase per LRC line; Whisper emits one phrase per VAD segment. Always paired.
- For LRClib lines, individual word timestamps are interpolated linearly across the line:
  `t_word_i = t_line_start + (cumulative_chars_i / total_chars) × line_duration`
  Single-word lines get the line's start timestamp.

Everything downstream (chart writer, editor render, preview modal) works off this normalized shape — source is metadata, not behavior.

## Backend

### Service: `web/backend/app/services/lyrics.py` (new)

Public functions:

```python
async def fetch_from_lrclib(artist: str, title: str, album: str | None, duration_s: float | None) -> dict | None
async def transcribe_with_whisper(vocals_path: Path, progress_callback) -> dict
def write_lyrics(target_dir: Path, lyrics: dict) -> Path
def load_lyrics(target_dir: Path) -> dict | None
def inject_into_chart(chart_path: Path, lyrics: dict) -> int          # returns event_count
```

**LRClib client** — `GET https://lrclib.net/api/get?artist_name=&track_name=&album_name=&duration=`. If `syncedLyrics` is empty, return `None` (caller treats text-only as a miss). Parse standard LRC `[mm:ss.xx]` and `[mm:ss.xxx]` headers; tolerate blank lines, repeated timestamps, and duplicate sections (Karaoke `[ar:]/[ti:]` headers ignored). Map to the normalized shape with the interpolation above.

**Whisper** — `faster-whisper` (CPU-friendly install, same models as openai-whisper). Pin in `requirements.txt`. Lazy-load a module-level singleton on first call so backend startup stays fast. Settings: `model_size_or_path="medium"`, `compute_type="int8"`, `word_timestamps=True`, language auto-detect. Group words into phrases by VAD segment (one phrase per segment). Emit progress through the existing `progress_callback(step, percent, message)` shape.

**Tick conversion** — `inject_into_chart` parses `[Song] Resolution`, walks `[SyncTrack]` tempo events, and converts each word's `time_s` to a tick. Tempo segments are walked in order; for a word at time `t`, find the latest tempo at or before `t` and accumulate ticks from segment start. Handles tempo changes correctly even though most charts have a single BPM. Existing `[Events]` content (non-lyric events from `merge_beatmap_charts()`) is preserved; lyric events are appended and the whole block is re-sorted by tick.

### Routes: `web/backend/app/routers/lyrics.py` (new)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/lyrics/lrclib` | Body: `{ job_id?, track_id?, artist, title, album, duration_s }`. Returns the normalized JSON, 204 on miss, 502 on upstream failure. Persists on success. |
| `POST` | `/api/lyrics/whisper` | Body: `{ job_id?, track_id? }`. Resolves vocals stem path, kicks off a Whisper Job, returns `{ job_id }`. Progress streams via the existing `/api/jobs/{job_id}/events` SSE endpoint. Persists on completion. |
| `GET` | `/api/lyrics` | Query: `?job_id=` or `?track_id=`. Returns the saved `lyrics.json` or 404. |
| `PUT` | `/api/lyrics` | Query: `?track_id=`. Body: full normalized JSON. Replaces saved lyrics (manual editor save). |
| `DELETE` | `/api/lyrics` | Query: `?track_id=`. Removes the file. |

Whisper is dispatched through the same `Job` infrastructure that the demucs and pip-upgrade flows use, so the UI gets a real progress bar (steps: `init`, `model-load`, `transcribe`, `done`).

## Frontend — vocals stem card

Buttons stack vertically under the waveform (the 4-column grid is too narrow for side-by-side):

```
[ ▶  ─────────waveform───────── ]
0:00                         3:58
[ Get Lyrics ]            ← LRClib
[ Transcribe Vocals ]     ← Whisper, with SSE progress bar
[ Generate Beatmap ]      ← unchanged
```

On mount, the card calls `GET /api/lyrics?job_id=…` to hydrate state.

State machine (drives both buttons):

| State | "Get Lyrics" | "Transcribe Vocals" |
|---|---|---|
| `none` | `Get Lyrics` (idle) | `Transcribe Vocals` |
| `lrclib-loading` | `Searching…` (disabled) | `Transcribe Vocals` (disabled) |
| `lrclib-miss` | `No match — try again` | `Transcribe Vocals` |
| `whisper-running` | `Get Lyrics` (disabled) | `Transcribing… 42%` (with bar) |
| `have-lyrics` | `Preview Lyrics` | `Re-transcribe` (secondary) |
| `error` | retry chip + last error | retry chip + last error |

`Preview Lyrics` opens a modal: scrollable timestamp · word/phrase list, badged with source (`LRClib` / `Whisper · medium`), Close button. Read-only.

## Frontend — Studio Library track detail

The same two-button block lives next to the vocals stem player on `TracksPage.tsx`. Same state machine, scoped to `track_id` instead of `job_id`. Re-fetch overwrites and a banner reminds the user to re-publish to push the updated chart.

## Frontend — manual beatmap editor

A new **Lyrics layer** inside `BeatmapEditor.tsx`, rendered as its own horizontal lane above the note grid (height ~32px, full editing).

**Visual:**

```
─── tick grid ───────────────────────────────────────────────
[ phrase ]  hello  world  tonight   [ phrase ]  the  light…
─── note lanes (existing) ───────────────────────────────────
```

- **Word pills**: rounded rectangles at the word's tick. Width = ticks until next word (or 1 beat if last word in phrase). Color: jam-pink to match the vocals card.
- **Phrase bars**: thin underline spanning `phrase_start → phrase_end`, gray-400. Click selects all words in the phrase.
- **Toggle**: sidebar checkbox `[ ] Lyrics layer` (default on if `lyrics.json` exists for the track).

**Edit affordances** (matching how notes already work):

| Action | Effect |
|---|---|
| Drag word pill horizontally | retime; snaps to active grid divisor |
| Double-click pill | inline text input replaces pill (Enter commits, Esc cancels) |
| Right-click pill | context menu: *Mark phrase start*, *Mark phrase end*, *Delete word* |
| Click empty lane space | spawns an inline text input at the clicked tick (snap-aligned); typing + Enter creates a new word, Esc cancels |
| Drag phrase bar endpoints | retime phrase boundary |
| Cmd/Ctrl-click multiple pills | multi-select; arrow keys nudge by snap |
| Selected + Backspace | delete selected words |
| Cmd/Ctrl-Z / Y | undo / redo (integrates with editor's existing undo stack) |

**Save model**: lyrics edits are dirty-tracked alongside the chart's existing dirty buffer and saved together. If the editor's existing save uses a Save button, lyrics piggyback on it (`PUT /api/lyrics?track_id=…` fires alongside the chart save); if it auto-saves on edit, lyrics auto-save on the same trigger. Implementation pass should match whichever pattern is already in `BeatmapEditor.tsx`. Discard handled the same way as unsaved note edits.

Lyrics get their own slice in the editor's state so existing note-editing logic isn't entangled. They share the tick-grid math and the snap divisor but nothing else.

This is the biggest engineering chunk in the feature — roughly 50–60% of total time.

## Publish-to-Game integration

In `publish_track_to_game()` (`web/backend/app/routers/tracks.py`), after `merge_beatmap_charts()` produces `notes_fixed_slides.chart`:

1. `load_lyrics(track_dir)` — fall back to demucs job's stems dir on the first publish.
2. If lyrics exist:
   - Copy `lyrics.json` into the published folder (source of truth survives in SongInbox; useful for re-publish and debugging).
   - `inject_into_chart(chart_path, lyrics)` rewrites the `[Events]` block:

     ```
     [Events]
     {
       384 = E "phrase_start"
       384 = E "lyric Hello"
       480 = E "lyric world"
       576 = E "lyric tonight"
       576 = E "phrase_end"
       768 = E "phrase_start"
       ...
     }
     ```

   - Existing non-lyric events are preserved; lyric events are appended and the block is re-sorted.
3. If no lyrics, skip silently. `[Events]` stays as merge produced it.

Publish response gains `lyrics: { source, word_count, included: bool }` so the UI can show "✓ included 142 lyric events".

## Edge cases & error handling

| Case | Handling |
|---|---|
| LRClib network / 5xx | 502 to caller; UI shows retry chip; nothing saved. |
| LRClib returns text-only (no `syncedLyrics`) | Treated as miss. Text-only lyrics are not useful for chart events. |
| Whisper model download failure | Job ends in `error` step with underlying message; user can retry. |
| Track has no `vocals` stem (manual upload, mix only) | Transcribe button hidden; LRClib button still works. |
| Lyrics outlast publish (track edits ahead of last publish) | Publish always re-injects from current `lyrics.json` so SongInbox stays consistent. |
| User edits in editor and never saves | Discarded on close, same as unsaved notes. |
| Tempo changes mid-song | Tick conversion walks `[SyncTrack]` segment-by-segment; lyrics stay aligned. |
| Word with quote/backslash in text | Escaped per CH `.chart` rules before writing the event. |

## Testing

- **Unit**:
  - LRC parser variants: `[mm:ss.xx]`, `[mm:ss.xxx]`, blank lines, repeated timestamps, header tags.
  - Word interpolation: 1-word, 3-word, single-character lines.
  - Tick conversion: single tempo, mid-song tempo change, time before first tempo event.
  - `inject_into_chart` round-trip on a fixture chart with existing `[Events]` content.
- **Integration**:
  - Full pipeline against a known LRClib hit (e.g., "Mr. Brightside") — assert chart contains expected events at expected ticks.
  - Whisper smoke test against a short fixture vocal file — assert non-empty word list and monotone timestamps.
- **Manual**:
  - Publish a real popular track end-to-end, open in Clone Hero, confirm karaoke renders.
  - Edit lyrics in the manual editor, save, re-publish, re-open in CH, confirm changes propagated.

## Open questions

None.
