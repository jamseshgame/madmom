# Vocal Beatmaps — Unity Engineer Handover

**Author:** backend / studio team
**Date:** 2026-05-05
**Status:** Pipeline shipped end-to-end. Ready for the Unity client to render and score.

This document is what you (the Unity engineer) need to consume the new pitched-vocal data we ship in published songs, render it in-game with parity to the studio editor, and grade player input against it. Read top to bottom; every section is short.

---

## 1. TL;DR for the impatient

- Each published track now ships a `[JamseshVocals]` block in `notes.chart` and a sidecar `vocal_notes.json` next to `notes.chart` in the song folder.
- Each entry is a **per-syllable note** with: tick, MIDI pitch, duration, lyric text, voicing classification (`sung` / `spoken` / `whispered`), and optional sub-note pitch curve + dynamics envelope.
- The studio editor at **`/edit-vocals/:trackId`** renders these in the layout we want in-game: horizontal scroll, static center-line "now" marker, one row per chromatic semitone (no compression, no overlap), pitch-class colour wheel. Match that.
- Plan A's `[Events]` lyric/phrase entries are **stripped** when `[JamseshVocals]` is present. The new block is the single source of truth.
- Clone Hero **does not** parse `[JamseshVocals]`. Existing instrument tracks (`[ExpertSingle]`, `[ExpertDrums]`, etc.) are untouched. Don't expect CH to render this block — that's our job.

---

## 2. Authoritative file formats

### 2.1 `notes.chart` — `[JamseshVocals]` block

Lives in the published song folder alongside the existing `[ExpertSingle]`, `[ExpertDrums]`, `[Events]` blocks. The block is **idempotently rewritten** by the publish pipeline — every syllable is one line per data type, all sharing the same tick.

Tick math is the same as every other chart block: `Resolution` from `[Song]` × tempo segments from `[SyncTrack]`. We already share helpers for this in the studio backend (`web/backend/app/services/lyrics.py::seconds_to_tick`). Resolution is whatever `[Song].Resolution` says — **don't hard-code 192**.

Example (120 BPM, 192 PPQN, two syllables at 0.5 s and 1.0 s):

```
[JamseshVocals]
{
  Version = 1
  PitchModel = "torchcrepe-full"
  HopMs = 10
  192 = N 64 115 92
  192 = E lyric Hel
  192 = V sung
  192 = D -15.0,-14.5
  192 = C 64.00,64.10
  192 = P start
  384 = N 66 115 88
  384 = E lyric lo
  384 = V sung
  384 = D -14.0
  384 = C 66.00
  384 = P end
}
```

#### Header lines (always at the top, before any tick lines)

| Field | Type | Meaning |
| --- | --- | --- |
| `Version = <int>` | int | Schema version. Currently `1`. Bump on breaking format changes; consumers should treat unknown versions as forward-compatible if all the lines they understand are present. |
| `PitchModel = "<str>"` | quoted string | The pitch detector that produced these notes. Currently always `"torchcrepe-full"`. Useful for diagnostics if scoring tuning depends on detector quirks. |
| `HopMs = <int>` | int | Hop length used by the pitch detector, in milliseconds. Today: `10`. Drives the temporal resolution of `pitch_curve_st` and `dynamics_db`. |

#### Tick lines (one or more per syllable, all sharing the same tick)

| Marker | Format | Meaning | Required? |
| --- | --- | --- | --- |
| `N` | `<tick> = N <midi> <duration_ticks> <conf_int>` | The note. `midi` is a MIDI number (e.g. 64 = E4). `duration_ticks` is always ≥ 1. `conf_int` is the detector's confidence at this syllable, scaled to 0..100. | yes |
| `E lyric` | `<tick> = E lyric <text>` | The lyric text for this syllable. **Not** quoted — text is taken to end of line. Whitespace inside the lyric is preserved. Backslashes and quotes are escaped (`\\`, `\"`). | yes |
| `V` | `<tick> = V <voicing>` | One of `sung`, `spoken`, `whispered`. See §3 for what these mean. | yes |
| `D` | `<tick> = D <db1>,<db2>,...` | Down-sampled per-syllable dynamics envelope, in dBFS. Up to 5 floats with one decimal. Today this is a confidence-derived proxy, not real RMS — see §6.2. | optional |
| `C` | `<tick> = C <st1>,<st2>,...` | Down-sampled sub-note pitch curve in MIDI semitones (floats, two decimals). Up to 5 values. Lets you draw vibrato / portamento shading inside the bar. | optional |
| `P` | `<tick> = P start` or `<tick> = P end` | Phrase boundary marker. Maps 1:1 to `phrase_start` / `phrase_end` flags on the syllable. | optional |

**Parser rules:**

- Lines within a tick group can appear in any order. We always emit them in the same order (`N`, `E lyric`, `V`, `D`, `C`, `P`) but parsers must not depend on this.
- Multiple syllables can share the same tick (e.g. fast melismatic runs at low resolution). Group by tick, then peel off each `N` line and its sibling `E lyric` / `V` / etc. Pair them by **emission order within the tick**: the n-th `N` line goes with the n-th `E lyric` line, and so on.
- Unknown markers (`X`, `Y`, …) must be ignored. We may add new optional markers for breath / rest / harmony in v2.

#### Cleanup the publish pipeline does for you

When `vocal_notes.json` exists, the publish-to-game step strips any prior `[Events]` lines that match the Plan A lyric-event format (`phrase_start`, `phrase_end`, `lyric ...` events). **You will not see those in a chart that has `[JamseshVocals]`.** Don't fall back to scanning `[Events]` for lyrics if `[JamseshVocals]` is present; the new block is the canonical source.

When `vocal_notes.json` does **not** exist (track only has `lyrics.json` from Plan A), the publish pipeline still injects the old `[Events]` lyric/phrase entries the way it always did, and there is no `[JamseshVocals]` block. The `vocals` field in the publish response payload tells you which path was taken.

### 2.2 `vocal_notes.json` — sidecar

Same data, same source of truth, but in a structured shape that's easier to load than parsing the chart. Lives next to `notes.chart` in published song folders. Useful if you ever want to render vocals from an unpublished track in some debug viewer.

```json
{
  "version": 1,
  "syllabified_from": "whisper",
  "pitch_model": "torchcrepe-full",
  "syllabifier": "ssp-en",
  "frame_hop_s": 0.01,
  "lyrics_etag": "11e9452d3937389800bef4b64406a52b...",
  "fetched_at": "2026-05-05T17:49:21Z",
  "syllables": [
    {
      "time_s": 18.0,
      "duration_s": 0.64,
      "text": "I",
      "midi_pitch": 60,
      "confidence": 0.0,
      "voicing": "spoken",
      "phrase_start": true
    },
    {
      "time_s": 19.15,
      "duration_s": 0.127,
      "text": "u",
      "midi_pitch": 58,
      "confidence": 0.925,
      "voicing": "sung",
      "pitch_curve_st": [58.0, 57.9, 58.1, 58.0, 58.2],
      "dynamics_db": [-12.4, -11.8, -11.9, -12.1, -12.5]
    }
  ]
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `version` | int | Schema version — currently 1. |
| `syllabified_from` | str | `lrclib`, `whisper`, or `unknown`. Provenance of the lyrics. |
| `pitch_model` | str | Always `torchcrepe-full` today. |
| `syllabifier` | str | `ssp-en` (Sonority Sequencing Principle, English) or `per-word` for non-English. |
| `frame_hop_s` | float | Pitch detector hop in seconds (today: `0.01`). |
| `lyrics_etag` | str (sha1 hex) | Hash of the source `lyrics.json` at generation time. Used by the editor to flag "lyrics changed since vocal beatmap was generated". You can ignore this. |
| `fetched_at` | ISO-8601 UTC | When the file was generated. |
| `syllables` | array | See below. |

`syllables[]` entry fields:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `time_s` | float | yes | Onset, seconds from track start. |
| `duration_s` | float | yes | Bar length, seconds. Always ≥ `frame_hop_s`. |
| `text` | str | yes | Lyric for this syllable. May contain hyphens or punctuation. |
| `midi_pitch` | int | yes | MIDI note number (e.g. 60 = C4). See §3 fallback rule. |
| `confidence` | float | yes | Median CREPE confidence over the syllable's voiced frames, 0..1. **0.0 means no voiced frames found** — the pitch is the previous note's value (or 60 if first), not real. |
| `voicing` | str | yes | `sung` / `spoken` / `whispered`. |
| `phrase_start` | bool | optional | True on the first syllable of a phrase. |
| `phrase_end` | bool | optional | True on the last syllable of a phrase. |
| `pitch_curve_st` | float[] | optional | Up to 5 MIDI semitone samples covering the syllable. Empty array if no voiced frames. |
| `dynamics_db` | float[] | optional | Up to 5 dBFS samples covering the syllable. Today: confidence-derived proxy, not real RMS — see §6.2. |

**Syllables are guaranteed sorted by `time_s` ascending.** Multiple syllables can share a `time_s` (rare). Two syllables with overlapping windows are valid and should be drawn as separate bars on different pitch rows — do **not** merge them.

---

## 3. Voicing classifier — what the three modes mean

Set per syllable from CREPE's pitch confidence and (proxy) dynamics:

- **`sung`** — high confidence (≥ 0.7), low pitch variance over the syllable window (< 1.5 semitones std). The pitch is reliable. Score on pitch accuracy.
- **`spoken`** — anything that isn't sung or whispered. Medium confidence, or high confidence but unsteady pitch (declamatory speech). The pitch is **best-effort**; treat it as "sing roughly here" rather than a hard target. Suggest scoring as pitch-accurate-or-rhythmic — give credit for either.
- **`whispered`** — very low confidence (≤ 0.4) AND very low energy (≤ −40 dBFS median). No real pitch. Pitch shown is the previous note carried forward. Score for **rhythm only** — do not penalise pitch.

**Important fallback rule:** When CREPE finds zero voiced frames in a syllable's time window (typical for short consonants or unvoiced fricatives like "sh", "t", "k"), the implementation sets:

- `midi_pitch` = previous syllable's pitch (or 60 / C4 if it's the first)
- `confidence` = 0.0
- `voicing` = `spoken`

So **`confidence == 0.0` is the signal that the pitch is not real**. Don't penalise the player on these. Either skip pitch grading entirely, or grade as `whispered` (rhythm only).

---

## 4. Visual rendering — match the studio editor

The studio editor at `/edit-vocals/:trackId` is the reference. Open it on the live site to see exactly what we want in-game. Source: `web/frontend/src/components/VocalEditor.tsx`. Key visual rules:

### 4.1 Layout

- **Horizontal highway**, time on the X axis. Bars flow **right → left** (just like guitar / drums, but rotated).
- **Static vertical "now" line in the centre** of the screen. Don't move the line; move the highway.
- **Y axis = chromatic pitch.** One row per semitone. Octave Cs get a faint label on the left edge.
- **Show every semitone in the displayed range, including empty rows.** Do not collapse low-and-high notes onto adjacent rows the way SingStar does — gaps are meaningful.
- **Vertical range** auto-fits to the song's min/max syllable pitch ± 2 semitones, with a minimum visible range of 18 semitones. Beyond that, scroll vertically (auto-follow the current syllable) so the active region stays centred.
- **In-game** you can show a smaller vertical window than the editor (game is performance, editor is overview), as long as you scroll vertically to follow the singer.

### 4.2 Colour synesthesia

12-step pitch-class wheel, Scriabin-ish. **Source of truth** is `PITCH_COLORS` in `VocalEditor.tsx`:

| Pitch class | Hex | Pitch class | Hex |
| --- | --- | --- | --- |
| C  | `#ff3b30` (red)    | F♯ | `#21c45d` (green)   |
| C♯ | `#ff7a00` (red-orange) | G  | `#08b3a3` (cyan)    |
| D  | `#ffae00` (orange) | G♯ | `#1f7ce0` (blue)    |
| D♯ | `#ffd400` (yellow-orange) | A  | `#5b3ee2` (indigo)  |
| E  | `#ffea00` (yellow) | A♯ | `#9b30dc` (violet)  |
| F  | `#a8d100` (yellow-green) | B  | `#e02bb6` (magenta) |

Voicing modulates **alpha** (not hue):

- `sung` → 100 % opacity
- `spoken` → ~60 % opacity
- `whispered` → ~33 % opacity

Phrase boundaries: render a thin white tick on the left edge of `phrase_start` syllables and the right edge of `phrase_end` syllables.

### 4.3 Lyric rendering

- **Inside each bar:** the syllable text, truncated with ellipsis if the bar is narrower than the text. The editor does this with CSS `text-overflow: ellipsis`.
- **Below the highway:** a single phrase line that shows all syllables between the surrounding `phrase_start` / `phrase_end`. Highlight the **current** syllable (the one the playhead is inside) with full colour; the rest stay muted. The editor has a working example.

### 4.4 Pitch curve overlay (optional polish)

If `pitch_curve_st` is present, draw a thin polyline inside the bar interpolating between the (up to 5) sample points. This gives the singer a target shape for vibrato / portamento. The studio editor doesn't render this yet — adding it would be a nice in-game polish.

---

## 5. Scoring suggestions (not prescriptive)

We have **not** committed to a scoring algorithm. The data supports several. Some sensible defaults:

### 5.1 Per-frame pitch grading

For each player audio frame (suggest 10 ms hop to match `frame_hop_s`):

1. Run a pitch detector on the player's input (any will do — CREPE-tiny, Aubio, YIN, even a simple autocorrelator). Get player MIDI pitch + confidence.
2. Find the active syllable: the one where `time_s ≤ player_time < time_s + duration_s`.
3. If no active syllable → no scoring for this frame.
4. If `voicing == "whispered"` or `confidence < 0.05` on the syllable → **rhythm credit only**: award if the player is voicing at all (energy above a noise floor). Don't grade pitch.
5. Otherwise compare `|player_midi - syllable_midi_pitch| modulo 12` (octave-tolerant) and award:
   - within ±1 semitone → "Perfect"
   - within ±3 semitones → "Good"
   - else → "Miss"
6. If `pitch_curve_st` is present and the syllable is long (> 0.3 s), grade against the curve sample at the player's frame's offset within the syllable, not the median.

### 5.2 Syllable rhythm grading

Independently of pitch, give credit for vocal energy crossing a threshold within ±100 ms of `time_s`. Helps non-pitched singers still score.

### 5.3 Phrase scoring

Show a phrase-level summary at each `phrase_end` boundary. The boundaries are reliable because they come from sentence-level lyric structure (LRClib lines or whisper sentence segmentation), not from automatic phrase detection on the audio.

### 5.4 Octave handling

CREPE outputs absolute pitch, so very low or very high singers will read as "wrong octave". Modulo-12 comparison fixes this for free. Do this by default.

---

## 6. Pitfalls and edge cases that will bite you

### 6.1 The first few syllables often have no real pitch

Songs commonly start with consonants (e.g. "I", "the", "you") that have no voiced harmonic content. CREPE returns no usable pitch for those windows. Our pipeline fills in `midi_pitch = previous_pitch (or 60)`, `confidence = 0.0`, `voicing = "spoken"`. **Always check `confidence == 0.0` before trusting `midi_pitch`.**

### 6.2 `dynamics_db` is a proxy, not real RMS

`dynamics_db` is currently derived from CREPE's confidence (`-30 + 30 × confidence` per frame), **not** from real RMS energy. The values are shape-stable (one per frame, same length as the curve) so consumers don't break, but they should not be used for absolute loudness comparisons. A future task will plug in `librosa.feature.rms` or equivalent. If you build scoring around dynamics, design it so swapping in real RMS later doesn't change your scoring tuning much (i.e. compare deltas, not absolute values).

### 6.3 Lyrics may diverge from the audio

When LRClib doesn't have synced lyrics for a track, we fall back to Whisper transcription. Whisper word-level timestamps drift by 50–200 ms from the actual vocal onset. The pipeline aligns syllable times to those (drifted) word times. **Don't expect frame-perfect onset accuracy.** Suggest a ±150 ms scoring window on rhythm grading.

`syllabified_from` tells you where the lyrics came from. `lrclib` is more accurate than `whisper`.

### 6.4 Whisper sometimes mangles or merges words

You will occasionally see weird syllables (`Ophe`, `lia` instead of `O`, `phe`, `lia`, or even hallucinated words where Whisper invented something the singer didn't say). The studio editor exists partly to fix these. Treat `vocal_notes.json` as a **best-first-pass**, not ground truth. If a published track has been edited, the edit lives in the chart's `[JamseshVocals]` block and the sidecar `vocal_notes.json`, both rewritten on publish.

### 6.5 Long durations between sparse Whisper words

Whisper sometimes emits one word every 2–3 seconds during a long melismatic phrase. Our pipeline caps inferred durations at 2.0 s, then falls back to a 0.6 s default for the final word. Watch for unusually long bars in published charts; they're a known artefact of sparse word timing, not deliberate sustained notes.

### 6.6 Multiple syllables at the exact same tick

Rare but possible (rapid melisma at low resolution). The chart's tick-grouping rule (§2.1) handles this: pair lines by emission order within a tick group. Don't assume one-syllable-per-tick.

### 6.7 Missing `vocal_notes.json` on older songs

Tracks published before this feature shipped won't have `[JamseshVocals]` — only the legacy Plan A `[Events]` lyric block (which is just `phrase_start` / `phrase_end` / `lyric <word>` entries with no pitch). The 64 existing `[ExpertVocals]` charts in SongInbox **are not being backfilled** to the new format. Render those with whatever fallback you already have; they're outside the scope of this feature.

### 6.8 Existing Clone Hero `[ExpertVocals]` blocks

Some legacy charts have an `[ExpertVocals]` block (Phase Shift's vocal track format). **This is unrelated to `[JamseshVocals]`.** Both can exist in the same chart. Don't try to merge them; pick one source. New publishes from this pipeline ship `[JamseshVocals]` and either don't touch `[ExpertVocals]` or it isn't present.

### 6.9 Don't trust "16 minutes per 4-min song" as steady-state

The pitch detection step is offline and slow (uses CREPE-full on CPU). That's a backend concern, not yours, but it means tracks may take a while to gain `vocal_notes.json` after the user clicks Generate Beatmap. Don't ship code that polls for the file expecting it within seconds.

---

## 7. Feature flags and graceful degradation

We don't ship feature flags for the chart format itself. The recommended client behaviour:

- **No `[JamseshVocals]` block + no `lyrics`-style `[Events]` lines** → no vocals UI for this song.
- **No `[JamseshVocals]` block + Plan A `[Events]` lyric/phrase lines** → render lyrics-only karaoke (static text scrolling, no pitch bars). This is the legacy fallback. We strip these when `[JamseshVocals]` is present, so they only co-exist on legacy songs.
- **`[JamseshVocals]` block present** → full pitched-vocal rendering. The `[Events]` lines have already been cleaned up by the publish pipeline.

---

## 8. Testing

Reference fixtures live in the repo:

- `web/backend/tests/fixtures/sample_vocal_chart.chart` — minimal fixture with both legacy `[Events]` lyric entries and a placeholder `[ExpertSingle]` block. The injection round-trip test in `web/backend/tests/test_vocals.py` verifies that injecting `[JamseshVocals]` strips the Plan A entries and is byte-identical on re-inject.
- `web/backend/tests/test_vocals.py::test_inject_vocals_writes_block_and_clears_old_lyric_events` — shows the exact expected `[JamseshVocals]` body for a 2-syllable input. Read this test if you want unambiguous example output.

For end-to-end testing on a real song:

- "Taylor Swift — The Fate of Ophelia" (Track ID `51bfb862866c` on the studio droplet) is our golden test track. It has Whisper-derived lyrics, real CREPE pitches across MIDI 53-95, mixed sung/spoken voicing.
- The studio editor at `/edit-vocals/51bfb862866c` shows you what good output looks like.

---

## 9. Source of truth — repo paths

If something here disagrees with the code, the code wins. Here's where to look:

| What | Path |
| --- | --- |
| Chart injection (the canonical `[JamseshVocals]` writer) | `web/backend/app/services/vocals.py::inject_vocals_into_chart` |
| `vocal_notes.json` shape | `web/backend/app/services/vocals.py::build_vocal_notes` |
| Voicing classifier | `web/backend/app/services/vocals.py::voicing_classify` |
| Studio editor (visual reference) | `web/frontend/src/components/VocalEditor.tsx` |
| Pitch-class colour wheel | `PITCH_COLORS` in `VocalEditor.tsx` |
| Original feature spec | `docs/superpowers/specs/2026-05-05-vocal-beatmaps-design.md` |
| Implementation plan | `docs/superpowers/plans/2026-05-05-vocal-beatmaps-plan.md` |
| Round-trip injection test | `web/backend/tests/test_vocals.py::test_inject_vocals_writes_block_and_clears_old_lyric_events` |

---

## 10. Open questions / decisions punted to your team

- **Scoring algorithm.** §5 has suggestions; pick what fits the gameplay loop.
- **Player pitch detection.** Up to you. CREPE-tiny is the same family as the offline detector and is fast enough to run live on phones; YIN / Aubio are simpler if you want to ship without ONNX.
- **Vibrato / pitch-curve scoring.** Whether to use `pitch_curve_st` for sub-note scoring or just for visual polish.
- **Octave-flexible vs strict pitch matching.** §5.4 suggests modulo-12 by default. Could be a difficulty setting.
- **Harmony track.** Out of scope for now — Demucs doesn't separate harmony from lead. If the gameplay needs harmonies, that's a future ML workstream.
- **What to do with `voicing == "spoken"`.** §3 suggests "credit for either pitch or rhythm". Could be tightened to only-rhythm, or only-pitch on Hard. Your call.

---

## 11. Who to ping

- Backend / data pipeline questions — the studio team. The data shape and chart format are fixed by §2; everything else is open to discussion.
- Studio editor UX (your visual reference) — same team. The colour wheel, voicing alpha, phrase boundary glyphs are all defined in `VocalEditor.tsx`; any visual change there should propagate to your in-game renderer.
