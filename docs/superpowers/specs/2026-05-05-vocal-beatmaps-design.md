# Vocal Beatmaps — Design

**Status:** Approved · ready for implementation plan
**Date:** 2026-05-05
**Owner:** Freshdex
**Predecessor spec:** `docs/superpowers/specs/2026-05-05-timestamped-lyrics-design.md`

## Goal

Produce a per-syllable, pitched vocal beatmap from any track's vocals stem and embed it in the published Jamsesh `notes.chart`. The output supersedes UltraStar's data model: every syllable carries pitch, duration, lyric text, voicing classification, dynamics envelope, and an optional sub-note pitch curve.

The user-facing flow: **Generate Beatmap on the vocals stem card** runs the full pipeline (lyrics → syllabification → CREPE pitch detection → alignment → write `vocal_notes.json`). Publish-to-Game injects a new `[JamseshVocals]` block alongside the existing instruments, slide notes, and tutorial events.

## Non-goals

- UltraStar `.txt` export. Dropped — out of scope.
- Backwards compatibility with the legacy `[ExpertVocals]` block format used by the 64 existing SongInbox charts. Those charts stay as authored; new publishes use `[JamseshVocals]`.
- Phoneme-level alignment for lipsync. Defer.
- Harmony track separation. Demucs doesn't split harmonies from lead vocals; needs new ML.
- Real-time pitch correction / autotune for live scoring.
- Editing pitches in the manual beatmap editor. Lyrics-only editing is Plan B for the predecessor spec; pitched-note editing is its own future workstream.

## Data model

Two on-disk artifacts per track, both rebuildable from audio + lyrics:

- **`lyrics.json`** — already exists from the predecessor spec.
- **`vocal_notes.json`** — new, written by this spec.

```json
{
  "version": 1,
  "syllabified_from": "whisper" | "lrclib",
  "pitch_model": "torchcrepe-full",
  "syllabifier": "pyphen-en",
  "frame_hop_s": 0.01,
  "lyrics_etag": "<sha1 of source lyrics.json>",
  "syllables": [
    {
      "time_s": 12.34,
      "duration_s": 0.28,
      "text": "Hel-",
      "midi_pitch": 64,
      "confidence": 0.92,
      "voicing": "sung",
      "phrase_start": true,
      "pitch_curve_st": [64.0, 64.1, 64.3, 64.2, 63.9],
      "dynamics_db": [-18.2, -16.5, -15.1, -16.8, -17.5]
    }
  ]
}
```

`syllables[i].text` is the per-syllable text. For LRClib (line-level) source, syllabification splits each word via `pyphen[en]`. For Whisper (word-level) source, each word's timestamp is split across its syllables proportional to character count. Words in unsyllabifiable languages stay one note per word.

Tick conversion happens at chart-write time (same pattern as the predecessor spec's `inject_into_chart`).

## Backend service — `app/services/vocals.py` (new)

Public functions:

```python
def detect_pitches(vocals_path: Path) -> tuple[np.ndarray, np.ndarray]
def syllabify(words: list[dict], language: str) -> list[dict]
def voicing_classify(curve: list[float], confidence: float, dynamics_db: list[float]) -> str
def build_vocal_notes(vocals_path: Path, lyrics: dict, progress_callback=None) -> dict
def write_vocal_notes(target_dir: Path, notes: dict) -> Path
def load_vocal_notes(target_dir: Path) -> dict | None
def inject_vocals_into_chart(chart_path: Path, notes: dict) -> int
```

- **`detect_pitches`** — `torchcrepe.predict(audio, sample_rate, model='full', hop_length=hop_samples_for_10ms, device='cpu', batch_size=128, decoder=torchcrepe.decode.viterbi)` where `hop_samples_for_10ms = round(sample_rate * 0.010)`. Returns f0 in Hz (NaN where unvoiced) plus per-frame confidence in [0, 1]. 10 ms hop. Lazy-loads the CREPE model into a module-level singleton (same pattern as the predecessor spec's Whisper wrapper).
- **`syllabify`** — `pyphen` with English by default. For each word in `lyrics["words"]`, split into syllables; distribute the word's `[time_s, time_s + duration]` proportional to syllable character count. Non-English (Whisper's detected language ≠ "en") falls back to per-word notes (one note per Whisper word).
- **`voicing_classify`** — heuristic per syllable. Sung: median confidence ≥ 0.7 AND pitch std-dev ≤ 1.5 semitones. Whispered: median dynamics ≤ −40 dB AND median confidence ≤ 0.4. Spoken: anything else with confidence in [0.4, 0.7]. Thresholds defaulted but easy to tune.
- **`build_vocal_notes`** — orchestrator. Pitch-detect on the vocals stem → syllabify the lyrics → for each syllable, slice the f0 frames inside its time window → take median of voiced frames as `midi_pitch`, store the trimmed curve and the RMS envelope (5 down-sampled frames per syllable), classify voicing, copy `phrase_start`/`phrase_end` from the underlying word. Calls `progress_callback(step, percent, message)` for SSE updates.
- **`inject_vocals_into_chart`** — emits the `[JamseshVocals]` block (format below). Idempotent: strips any prior `[JamseshVocals]` block before reinserting. Also clears any prior `[Events]` lyric/phrase events authored by the predecessor spec — reuses the predecessor's `_is_lyric_event_line` helper from `app/services/lyrics.py` to identify them. Single source of truth — when vocal notes are present, all karaoke text lives in `[JamseshVocals]` only.

Pitch detection runs in `loop.run_in_executor` (CPU-bound, ~30-90 s per track). Same SSE Job pattern as Whisper.

New dependencies: `torchcrepe`, `pyphen`. torchcrepe pulls a 30 MB model from HuggingFace on first call.

## Backend routes — `app/routers/vocals.py` (new)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/vocals?job_id=&track_id=` | Returns saved `vocal_notes.json` or 404 |
| `POST` | `/api/vocals/generate?job_id=&track_id=` | Kicks off the full vocals pipeline as an SSE Job. Returns `{job_id}` |
| `PUT` | `/api/vocals?track_id=` | Accepts edited `vocal_notes.json` (future editor) |
| `DELETE` | `/api/vocals?track_id=` | Removes the file |

The `POST /api/vocals/generate` job pipeline:

```
step           pct      message
init            2       "Resolving track..."
lyrics-fetch   10       "Fetching synced lyrics from LRClib..."
lyrics-fetch   25       "No LRClib match — transcribing with Whisper (medium)..."
whisper        25→55    forwarded from existing whisper service
syllabify      60       "Splitting into syllables..."
crepe-load     65       "Loading pitch model..."
crepe          70→90    "Detecting pitch..."
align          92       "Aligning pitch to syllables..."
write          96       "Building vocal notes..."
done          100       {syllable_count, voicing_breakdown, source}
```

`lyrics-fetch` is conditional: if `lyrics.json` already exists, skip straight to `crepe-load`. If LRClib hits, skip the Whisper segment. If LRClib misses, fall through to Whisper inside the same job (no second click).

## Chart format — `[JamseshVocals]` block

Lives in the same `notes.chart` as `[ExpertSingle]`, slide notes, tutorial events. One block per chart. Idempotent: re-publishing rewrites it cleanly.

```
[JamseshVocals]
{
  Version = 1
  PitchModel = "torchcrepe-full"
  HopMs = 10
  17520 = N 64 30 92
  17520 = E lyric Hel-
  17520 = V sung
  17520 = D -18.2,-16.5,-15.1,-16.8,-17.5
  17520 = C 64.0,64.1,64.3,64.2,63.9
  17520 = P start
  17565 = N 66 30 88
  17565 = E lyric lo
  17565 = V sung
  17565 = D -15.1,-14.0,-13.5,-14.2,-15.8
  17565 = C 66.1,66.0,65.9,66.0,66.1
  17565 = P end
}
```

Line format follows existing CH `<tick> = <letter> <args>` per line. Multiple lines per syllable, all keyed to the same start tick.

| Letter | Args | Required | Meaning |
|---|---|---|---|
| `N` | `pitch duration confidence` | yes | MIDI pitch (int), duration in ticks (int), confidence 0-100 (int) |
| `E lyric` | `<text>` | yes | Per-syllable lyric text (escaped per CH .chart rules) |
| `V` | `sung` \| `spoken` \| `whispered` | yes | Voicing classification |
| `D` | comma-separated dB values | optional | Dynamics envelope (typically 5 frames per syllable) |
| `C` | comma-separated semitone values | optional | Pitch curve (float MIDI semitones; unvoiced frames elided) |
| `P` | `start` \| `end` | optional | Phrase boundary marker |

The header lines `Version`, `PitchModel`, `HopMs` enable forward-compatible parsing.

When `[JamseshVocals]` is being written, `inject_vocals_into_chart` clears any prior `phrase_start`/`phrase_end`/`E "lyric ..."` events from the `[Events]` block. Single source of truth — no duplicate karaoke events in two places.

Backwards compat with the 64 existing `[ExpertVocals]` charts in SongInbox: out of scope. Those charts stay as authored; new publishes from Jamsesh Studio use `[JamseshVocals]`.

## Frontend — vocals card UX

The vocals card today has three buttons: Get Lyrics, Transcribe Vocals, Generate Beatmap. **For the vocals stem only**, Generate Beatmap rewires from `/api/beatmap/from-stem` (instrument onset/beat tracking) to `/api/vocals/generate` (this spec's pipeline). Generate Beatmap on non-vocal stems is unchanged.

```
[ ▶  ─────────waveform───────── ]
0:00                         3:58
[ Get Lyrics ]
[ Transcribe Vocals ]
[ Generate Beatmap ]    ← runs the full vocals pipeline
```

Vocals-card Generate Beatmap state machine:

| State | Generate Beatmap label |
|---|---|
| no `vocal_notes.json` | `Generate Beatmap` |
| LRClib + CREPE running | `Generating… 47%` (with progress bar) |
| Whisper fallback firing | `Transcribing… 32%` then `Detecting pitch… 78%` |
| have `vocal_notes.json` | `Re-generate` (secondary style) + a small disclosure showing syllable count, voicing breakdown, source |
| error | retry chip + last error |

When Whisper fires and the model isn't already cached, the SSE message gets surfaced as a passive banner: *"Whisper model downloading (1.5 GB). First run only — future tracks reuse the cached model."* No blocking confirmation modal — the user already clicked Generate Beatmap, the banner just informs them about the wait.

Get Lyrics and Transcribe Vocals stay as-is for users who want lyrics-only without pitch detection.

## Publish-to-Game integration

Predecessor spec already injects `[Events]` lyric events. This spec replaces that path when richer data is available. After `merge_beatmap_charts` produces the merged chart:

1. Try `load_vocal_notes(track.stems_dir)` (fall back to the demucs job's stems dir).
2. **If vocal notes exist:** call `inject_vocals_into_chart(chart_path, vocal_notes)` — writes `[JamseshVocals]` and clears any prior `[Events]` lyric/phrase events. Skip the predecessor's `inject_into_chart` call entirely. Copy `vocal_notes.json` into the published folder.
3. **If only `lyrics.json` exists:** call the predecessor's `inject_into_chart(chart_path, lyrics)` — writes `[Events]` lyric/phrase events as before. (Lyrics-only fallback for tracks where the user fetched lyrics but never clicked Generate Beatmap on the vocals card.)
4. **If neither exists:** skip both — chart `[Events]` block stays as `merge_beatmap_charts` produced it.

Always copy whichever source-of-truth file exists (`vocal_notes.json` and/or `lyrics.json`) into the published folder.

The publish response gains a `vocals` field:

```json
{
  "commit_url": "...",
  "folder": "Artist - Title",
  "chart": { ... },
  "tutorial": { ... },
  "lyrics": { ... },
  "vocals": {
    "syllable_count": 412,
    "voicing": { "sung": 380, "spoken": 22, "whispered": 10 },
    "pitch_model": "torchcrepe-full",
    "included": true
  }
}
```

If only `lyrics.json` exists (user clicked Get Lyrics but not Generate Beatmap on vocals), publish still writes the predecessor's `[Events]` lyric/phrase events — that path is preserved as the lyrics-only fallback. Once `vocal_notes.json` exists, it takes precedence and the `[Events]` lyric events are skipped.

## Edge cases

| Case | Handling |
|---|---|
| CREPE confidence collapses (instrumental-only stretch, vocals stem still gets some noise) | Skip syllables in that range; mark `voicing="whispered"` with `confidence=0` so renderer can ghost them. |
| Pitch curve has NaN frames (unvoiced) | Median computed over voiced frames only. If a syllable has no voiced frames, `midi_pitch` is the nearest-neighbor's pitch and `confidence=0`. |
| Whisper word boundary disagrees with LRClib (lyrics re-fetched after vocals generated) | `vocal_notes.json` carries `lyrics_etag` (sha1 of source `lyrics.json`). UI compares against current `lyrics.json` etag and shows "lyrics changed — re-generate" prompt. |
| User edits vocal notes via PUT (future editor) | `PUT /api/vocals` writes the whole file; no merge. |
| Track has no vocals stem (manual-stems mode without vocals upload) | Generate Beatmap on vocals card hidden / disabled with tooltip "no vocals stem". |
| CREPE / pyphen import fails on prod | Publish still works (lyrics fall back to predecessor's `[Events]` events). Generate Beatmap on vocals returns 503 with install instructions. |
| Track is in a non-English language | Syllabifier falls back to per-word notes. Pitch detection still runs. UI shows "syllabification: per-word (language: fr)" hint. |
| User edits underlying lyrics after vocals generated | Stale-lyrics banner; one-click "Re-generate" rebuilds vocal_notes.json. |

## Testing

- **Unit:**
  - `syllabify` — English single/multi-syllable words, edge punctuation, hyphenated compound words, non-English fallback path.
  - `voicing_classify` — synthetic inputs spanning each branch (high-conf-flat → sung; low-conf-low-energy → whispered; mid → spoken).
  - `inject_vocals_into_chart` — round-trip + idempotency on a fixture chart that already has slide notes and tutorial events.
- **Integration:**
  - `build_vocal_notes` against a 30-second clip with known lyrics. Assert: median pitch within ±1 semitone of ground truth on a sustained note, syllable count matches lyric input, durations sum to the clip duration ± 5%.
- **Manual:**
  - End-to-end on "The Fate of Ophelia" (lyrics already present from the predecessor spec's smoke). Click Generate Beatmap on vocals → publish → grep the published `notes.chart` for `[JamseshVocals]`. Verify pitch curves look musically plausible (not pinned to a single pitch, vibrato visible on sustained notes).
  - Verify the SSE progress bar advances through all expected steps.
  - Verify the publish response payload contains the `vocals` summary.

## Out of scope

- UltraStar `.txt` export.
- Manual editor lyrics layer (predecessor's Plan B) and vocal-pitch editing in the editor.
- Phoneme alignment for lipsync.
- Harmony track separation.
- Backfilling the 64 existing `[ExpertVocals]` charts into `[JamseshVocals]` (a separate one-shot migration script if desired).
- Real-time pitch correction / autotune.

## Open questions

None.
