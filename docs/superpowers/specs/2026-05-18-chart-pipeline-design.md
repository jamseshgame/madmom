# Chart Generation Pipeline V2 — Design

**Status:** spec draft, awaiting review.
**Replaces:** `web/backend/app/services/chart_generator.py` (madmom-based) for
pitched stems. Drums stem continues to use the legacy generator until
Phase 4.

## 1. Problem

The current chart generator (`generate_full_chart`) uses madmom for beat
tracking, onset detection, and a spectral-centroid heuristic for lane
assignment. Three concrete failures:

1. **BPM detection is single-tempo and frequently half/double-tracks.**
   The band-aid `_normalise_bpm` snaps obvious octave errors back into
   `[70, 180]` BPM, but real songs with tempo changes (slow intro, half-
   time breakdown) drift away from the grid after the first segment.
2. **No time-signature detection.** `[SyncTrack]` always defaults to 4/4
   even though the editor already parses multi-marker `TS` rows.
3. **Lane assignment isn't musical.** Spectral centroid percentile
   binning maps a brighter onset to a higher fret — it has no notion of
   pitch, so the same musical phrase played up an octave doesn't produce
   the same lane sequence, and chords are triggered by spectral spread
   rather than by detected polyphony.

Plus an architectural failure: each per-stem chart detects its own grid
independently, so the merged song's `[SyncTrack]` is whichever stem's
generator ran first. Stems can disagree on tempo.

## 2. Goals

- Replace madmom entirely in the new pipeline.
- One canonical tempo + time-sig + structural-section grid per song,
  reused across every stem's chart generation.
- Pitch-driven lane assignment per stem; chord-vs-single decided by
  measured polyphony, not spectral spread.
- Difficulty reduction by musical-metric weight (downbeats survive
  Easy; sixteenth offbeats drop first).
- Whole pipeline is **modular** — every stage has a registered set of
  engines with tunable parameters, persisted outputs per version, and
  per-engine UI controls. Mirrors the existing lyrics workflow.
- Existing per-stem generation surface continues to work; V2 is a new
  `model='v2'` alongside today's `model='madmom'`, selectable per
  beatmap and made default once proven.

## 3. Non-goals

- Drum chart generation. The drums stem keeps the existing madmom path
  until a dedicated kit-aware pipeline is built (Phase 4, separate spec).
- Real-Notes sample playback. The pipeline produces `N` notes; `R` notes
  + `realnotes_pack`/`realnotes_scale` events are out of scope. The
  per-pitch detection work here makes a future Real-Notes integration
  trivial, but the chart output stays vanilla Jamsesh.
- Hold-note and slide-note generation. Sustains computed by the existing
  generator's `compute_sustain_ticks` rule are preserved (gap-to-next-
  onset > threshold), but no new sustain or slide logic is introduced.
  Slide detection is deferred.
- Tutorial-mode integration. The pipeline writes a plain `notes.chart`;
  tutorial scripting remains the editor's manual workflow.

## 4. Architecture overview

Three layers, with a clean cut between song-level analysis (runs once
per Track) and per-stem chart generation (runs once per beatmap):

```
            SONG-LEVEL  (full mix in, runs once per Track)
            ┌─────────────────────────────────────────────────────────┐
            │  S1.  Grid detection      grid.json                     │
            │       engines: all-in-one | librosa-beat | manual       │
            │       out: tempo segments, downbeats, time-sig, sections│
            └────────────────────────┬────────────────────────────────┘
                                     │
            STEM-LEVEL  (one run per pitched stem; consumes grid.json)
            ┌────────────────────────▼────────────────────────────────┐
            │  S2.  Onset detection      onsets.json                  │
            │       engines: basic-pitch | aubio | librosa-onset      │
            └────────────────────────┬────────────────────────────────┘
                                     │
            ┌────────────────────────▼────────────────────────────────┐
            │  S3.  Pitch + polyphony   pitches.json                  │
            │       engines: basic-pitch | crepe | yin | passthrough  │
            └────────────────────────┬────────────────────────────────┘
                                     │
            ┌────────────────────────▼────────────────────────────────┐
            │  S4.  Quantization        quantized.json                │
            │       engines: nearest-grid | strong-beat-priority |    │
            │                metric-weighted                          │
            │       params: max_division, min_division, swing,        │
            │               lock_to_downbeat, max_snap_distance_ms    │
            └────────────────────────┬────────────────────────────────┘
                                     │
            ┌────────────────────────▼────────────────────────────────┐
            │  S5.  Lane mapping        lanes_expert.json             │
            │       engines: section-sliding | global-percentile |    │
            │                key-relative                             │
            │       params: open_high_percentile, open_low_percentile,│
            │               chord_polyphony_threshold                 │
            └────────────────────────┬────────────────────────────────┘
                                     │
            ┌────────────────────────▼────────────────────────────────┐
            │  S6.  Playability filter  lanes_expert_filtered.json    │
            │       engines: identity (DEFAULT) | spread-fretboard |  │
            │                avoid-cramps                             │
            │       params: max_same_fret_run, max_jump,              │
            │               shuffle_strength                          │
            └────────────────────────┬────────────────────────────────┘
                                     │
            ┌────────────────────────▼────────────────────────────────┐
            │  S7.  Difficulty reduce   lanes_{hard,medium,easy}.json │
            │       engines: metric-weight | density-target | none    │
            └────────────────────────┬────────────────────────────────┘
                                     │
            ┌────────────────────────▼────────────────────────────────┐
            │  S8.  Chart serialize     notes.chart                   │
            │       (single deterministic option)                     │
            └─────────────────────────────────────────────────────────┘

            LEGACY (unchanged, but consumes grid.json from S1)
            ┌─────────────────────────────────────────────────────────┐
            │  Drums chart generator (existing madmom path)           │
            └─────────────────────────────────────────────────────────┘
```

**Architectural decisions baked into the shape:**

- The grid is a Track-level concept (`<track_dir>/grid.json`), stems are
  Track-scoped (`<track_dir>/stems/<stem>/v2/`).
- Every stage persists JSON; downstream re-runs are cheap.
- Re-running stage Sn moves Sn+1..S8 active files to `_stale/` (forces
  re-run; user can restore from stale).
- Per-stem engine selection is independent — guitar can use
  basic-pitch while bass uses aubio.
- `model='v2'` is the new value in `add_beatmap_record`; existing
  `model='madmom'` continues to work untouched.
- Settings flag `BEATMAP_MODEL_DEFAULT=v2|madmom` controls the UI
  default after V2 is proven.

## 5. Model lineup

| Job | Today (madmom) | V2 replacement |
| --- | --- | --- |
| Beat / downbeat / time-sig / sections | `RNNBeatProcessor` + `TempoEstimationProcessor` (no downbeats) | **All-In-One Music Analyzer** (`mir-aidj/all-in-one`); `librosa.beat.beat_track` + librosa segmentation as a lighter alternative |
| Onset detection (per stem) | `RNNOnsetProcessor` + `OnsetPeakPickingProcessor` | **basic-pitch (PyTorch port)** for pitched stems; `aubio.onset` and `librosa.onset.onset_detect` as lighter alternatives |
| Pitch per onset | (centroid percentile, not real pitch) | basic-pitch dominant note in onset window; CREPE/yin as alternatives |
| Polyphony flag | spectral spread heuristic | basic-pitch note count within ±15 ms |
| Audio decoding | `madmom.audio.signal.Signal` | librosa.load |
| Waveform peaks (`compute_audio_peaks`) | madmom Signal | librosa.load |

**Risks flagged:**

- All-In-One model is ~150 MB; first-call download adds noticeable
  cold-start latency. UI streams download progress as a normal job
  step.
- All-In-One is trained on full mixes; V2 contract explicitly passes
  the full mix (not a stem) to S1.
- basic-pitch ships originally as TensorFlow; we use the active
  PyTorch port to stay within the existing torch stack. Pin a known-
  good commit/release in `requirements.txt`. If the PyTorch port
  proves unmaintained, fall back to the TF version with documented
  cost.
- basic-pitch onset times are quantized to its frame rate (~11 ms hop).
  Adequate for grid snapping; not surgical. Sub-frame refinement
  deferred.
- madmom remains installed only because the legacy drums generator
  imports it. No V2 engine depends on madmom. Uninstall is Phase 4
  alongside the drums pipeline migration.

## 6. Per-stage specifications

### 6.1 S1 — Grid detection (track-level)

**In:** full-mix audio path.
**Out:** `<track_dir>/grid.json`.

```json
{
  "engine": "all-in-one",
  "params": {"min_segment_beats": 16},
  "audio_duration_s": 213.4,
  "resolution": 192,
  "tempo_segments": [
    {"tick_start": 0,       "micro_bpm": 92000, "label": "intro"},
    {"tick_start": 6144,    "micro_bpm": 124000, "label": "main"},
    {"tick_start": 161280,  "micro_bpm": 62000, "label": "outro"}
  ],
  "time_sig_segments": [{"tick_start": 0, "num": 4, "denom_pow": 2}],
  "downbeats": [0, 768, 1536, 2304],
  "sections": [
    {"tick_start": 0,     "label": "intro"},
    {"tick_start": 6144,  "label": "verse"},
    {"tick_start": 18432, "label": "chorus"}
  ],
  "detected_key": {"tonic": "E", "mode": "minor", "confidence": 0.84},
  "generated_at": "2026-05-18T11:22:03Z"
}
```

**Engines:**

| id | source | gives | use case |
| --- | --- | --- | --- |
| `all-in-one` | `mir-aidj/all-in-one` | beats + downbeats + tempo + sections | recommended default |
| `librosa-beat` | `librosa.beat.beat_track` | beats only; downbeats/sections via fallbacks below | lightweight alternative when the All-In-One model isn't available |
| `manual` | user-supplied | BPM + offset | escape hatch for known-tempo songs |

For non-`all-in-one` engines:

- Sections fallback: `librosa.segment.agglomerative` over MFCC self-
  similarity, k auto-chosen by silhouette score (capped at 8).
- Key fallback: `librosa.feature.chroma_cqt` + Krumhansl-Schmuckler
  profile correlation.
- Time-signature derivation: count beats between consecutive downbeats.
  Stable mode of `{3, 4, 6}` over a 32-beat window → segment's `TS`.
  Switch only when the mode flips for ≥2 consecutive windows (prevents
  jitter).

**Validation:**

- `tempo_segments[i].tick_start < tempo_segments[i+1].tick_start`
- Every `tick_start` is on a downbeat
- `micro_bpm ∈ [40_000, 250_000]`
- Sections cover `[0, last_downbeat]`
- Schema validates against `pydantic.SongGrid`

### 6.2 S2 — Onset detection (per stem)

**In:** stem audio path, active `grid.json`.
**Out:** `<track_dir>/stems/<stem>/v2/onsets.json`.

```json
{
  "engine": "basic-pitch",
  "params": {"onset_threshold": 0.5, "min_note_length_ms": 50},
  "onsets": [
    {"time_s": 0.235, "confidence": 0.88, "source_note_id": 17},
    {"time_s": 0.482, "confidence": 0.91, "source_note_id": 18}
  ]
}
```

`source_note_id` is an opaque handle into the engine's internal note
table — S3 uses it to look up pitches that fired at this onset without
re-running the model. Engines that can't expose this leave it `null`.

**Engines:**

| id | gives | notes |
| --- | --- | --- |
| `basic-pitch` | onsets + pitches in one pass | default for pitched stems |
| `aubio-complex` | onsets only (complex spectral flux) | C-backed, very fast |
| `librosa-onset` | onsets only (`onset_detect` + backtracking) | pure-Python fallback |

**Tunable params (per engine, exposed via `params_schema`):**
`onset_threshold`, `min_gap_ms`, `min_note_length_ms`, `backtrack`.

**Validation:** strictly monotonic `time_s`; all within
`[0, audio_duration_s]` from S1; no duplicates within 5 ms.

### 6.3 S3 — Pitch + polyphony (per stem)

**In:** stem audio, active `onsets.json`, optional engine note table.
**Out:** `<track_dir>/stems/<stem>/v2/pitches.json`.

```json
{
  "engine": "basic-pitch",
  "params": {"pitch_confidence_threshold": 0.3, "polyphony_window_ms": 30},
  "per_onset": [
    {"time_s": 0.235, "dominant_midi": 64, "dominant_confidence": 0.92,
     "polyphony": 1, "all_pitches_midi": [64]},
    {"time_s": 0.482, "dominant_midi": 60, "dominant_confidence": 0.81,
     "polyphony": 3, "all_pitches_midi": [60, 64, 67]}
  ]
}
```

**Engines:**

| id | gives | notes |
| --- | --- | --- |
| `basic-pitch` | dominant = highest-velocity in window; polyphony = note count | free re-use of S2 output when S2 was also basic-pitch |
| `crepe` | dominant pitch via torchcrepe; polyphony = 1 | for mono stems (vocals melody) |
| `yin` | dominant pitch via librosa `pyin`; polyphony = 1 | lightweight fallback |
| `passthrough` | `dominant_midi=null`, `polyphony=1` for every onset | drums or non-pitched downstream |

**Tunable params:** `pitch_confidence_threshold`,
`polyphony_window_ms`, `octave_fold` (bool).

**Validation:** every onset in S2 maps to an entry (or is explicitly
filtered with `_dropped` reason); `polyphony ≥ 1`;
`dominant_midi ∈ [21, 108]`.

### 6.4 S4 — Quantization (per stem)

**In:** active `grid.json`, active `pitches.json`.
**Out:** `<track_dir>/stems/<stem>/v2/quantized.json`.

```json
{
  "engine": "metric-weighted",
  "params": {"max_division": 16, "min_division": 4, "swing": 0.0,
             "lock_to_downbeat": true, "max_snap_distance_ms": 80},
  "events": [
    {"tick": 192, "time_s_pre": 0.482, "time_s_post": 0.484,
     "snap_division": 8, "metric_weight": 3,
     "dominant_midi": 60, "polyphony": 3, "dropped": false}
  ]
}
```

Quantization converts seconds → ticks via the piecewise tempo map in
the active `grid.json`. The same `secondsToTick` math the editor uses
for tempo-map rendering ports server-side (it's already canonical in
`web/frontend/src/components/BeatmapEditor.tsx`'s
`buildTempoSegments` / `secondsToTick`).

**Engines:**

| id | behavior |
| --- | --- |
| `nearest-grid` | snap to nearest tick at `max_division` |
| `strong-beat-priority` | nearest-grid then re-snap within tolerance to a stronger position (downbeat > beat > 8th > 16th) |
| `metric-weighted` | scoring combines snap distance + metric importance; tunable strength |

**Tunable params:** `max_division` (8/16/32), `min_division` (4/8),
`swing` (0.0–0.66), `lock_to_downbeat` (bool),
`max_snap_distance_ms` (drop onsets beyond this).

`metric_weight`: 4 (downbeat), 3 (beat), 2 (8th), 1 (16th), 0 (off-grid).

**Validation:** all `tick ≥ 0` and within
`[0, max(downbeats) + bar_length]`; no duplicates at the same tick
after snapping (sustain merging is S8's job).

### 6.5 S5 — Lane mapping (per stem)

**In:** active `grid.json`, active `quantized.json`.
**Out:** `<track_dir>/stems/<stem>/v2/lanes_expert.json`.

```json
{
  "engine": "section-sliding",
  "params": {"open_high_percentile": 95, "open_low_percentile": 5,
             "chord_polyphony_threshold": 3},
  "lanes": [
    {"tick": 0,    "frets": [2],    "sustain": 0, "section": "intro"},
    {"tick": 192,  "frets": [0, 1], "sustain": 0, "section": "intro"},
    {"tick": 384,  "frets": [7],    "sustain": 0, "section": "intro"}
  ]
}
```

**Engines:**

| id | behavior |
| --- | --- |
| `section-sliding` | per section, compute pitch percentiles over that section's onsets; bin into 5 lane edges; outliers above/below open thresholds → lane 7 |
| `global-percentile` | one set of bin edges over the whole song |
| `key-relative` | tonic of detected key → fixed lane (default 2); other scale degrees by interval-from-tonic; chromatic → nearest scale degree's lane; octave-fold |

**Chord-vs-single decision (every engine):**

- `polyphony >= chord_polyphony_threshold` (default 3) → chord pair
- Pair = `(F, F+1)` if F < 4 else `(F-1, F)` where F is the engine's
  single-fret assignment for the dominant pitch (anchor + adjacent)
- Polyphony 1 or 2 → single fret only

**Open-vs-colored (every engine):** independent of pitch% — if
dominant pitch < `open_low_percentile` (drone-low) OR >
`open_high_percentile` (accent-high) for that section, lane = 7.

**Tunable params:** `open_high_percentile`, `open_low_percentile`,
`chord_polyphony_threshold`, `lane_count` (fixed at 5 today; exposed
for future 6-button modes).

**Validation:** frets ⊆ `{0,1,2,3,4,7}`; chord pairs always adjacent;
no event mixes open with colored.

### 6.6 S6 — Playability filter (per stem)

**In:** active `lanes_expert.json`.
**Out:** `<track_dir>/stems/<stem>/v2/lanes_expert_filtered.json`.

```json
{
  "engine": "identity",
  "params": {},
  "lanes": [...],
  "edits": []
}
```

For non-identity engines:

```json
{
  "engine": "spread-fretboard",
  "params": {"max_same_fret_run": 4, "max_jump": 3, "shuffle_strength": 0.3},
  "lanes": [...],
  "edits": [
    {"tick": 768,  "kind": "displace", "from": [2], "to": [3], "reason": "same_fret_run"},
    {"tick": 1152, "kind": "drop", "frets": [0, 1], "reason": "max_jump_exceeded"}
  ]
}
```

**Engines:**

| id | behavior | default? |
| --- | --- | --- |
| `identity` | pass-through; for A/B testing raw S5 | **yes** |
| `spread-fretboard` | if N consecutive onsets share a fret (default N=4), jitter every other one ±1 | |
| `avoid-cramps` | consecutive onsets ≥ `max_jump` lanes apart at <80 ms gap → demote second toward first | |

Engines can be chained via `chain: ['spread-fretboard', 'avoid-cramps']`
when both are wanted.

`edits` lets the editor highlight what changed vs. S5 for QA.

### 6.7 S7 — Difficulty reduction (per stem)

**In:** active `lanes_expert_filtered.json`.
**Out:** `lanes_hard.json`, `lanes_medium.json`, `lanes_easy.json`.

```json
{
  "engine": "metric-weight",
  "params": {
    "hard":   {"min_weight": 2, "demote_chord_size": null,             "max_density_per_sec": null},
    "medium": {"min_weight": 3, "demote_chord_size": 1, "max_density_per_sec": 4},
    "easy":   {"min_weight": 4, "demote_chord_size": 1, "max_density_per_sec": 2}
  }
}
```

The output JSON is per difficulty; each file has the same `lanes`
schema as S5/S6.

**Engines:**

| id | behavior |
| --- | --- |
| `metric-weight` | keep events with `metric_weight >= min_weight`; chord events with size > `demote_chord_size` keep only the lower fret |
| `density-target` | greedy drop to target notes/sec, prioritizing low metric_weight first |
| `none` | per-difficulty file mirrors expert |

**Open-note rule (every engine):** open notes count as anchors —
they survive thinning one weight-step longer than colored singles
(Easy keeps open notes that fell on beats even when those beats
wouldn't survive for colored notes).

### 6.8 S8 — Chart serialization (per stem)

**In:** active `grid.json`, active `lanes_expert_filtered.json`,
active `lanes_{hard,medium,easy}.json`.
**Out:** `<track_dir>/stems/<stem>/v2/notes.chart`.

Deterministic transformation, no engine choice:

- `[Song]` block from Track metadata + `grid.resolution`
- `[SyncTrack]`:
  - One `B <micro_bpm>` per tempo segment
  - One `TS <num> <denom_pow>` per time-sig segment
- `[Events]`: one `E "section <label>"` per `grid.sections` entry
- `[ExpertSingle]` from active `lanes_expert_filtered.json`
- `[HardSingle]`, `[MediumSingle]`, `[EasySingle]` from each
  `lanes_<diff>.json`

The existing `chart_generator.write_chart` is the reference;
extension covers multi-marker `[SyncTrack]` and multi-segment
`[TimeSig]`. The chord-sustain-unify and validate-frets rules
already in the generator are reused (those rules are correct, just
the inputs were wrong).

## 7. Storage model

**Track-level files** (`<track_dir>/`):

- `grid.json` — active S1 output
- `grid_versions/<iso_timestamp>_<engine>.json` — every Run snapshot
- `grid_versions/_meta.json` — index:
  `[{filename, engine, params, created_at, label?, starred}]`

**Stem-level files** (`<track_dir>/stems/<stem>/v2/`):

- `<stage>.json` — active output
- `<stage>_versions/` — snapshots
- `<stage>_versions/_meta.json` — index
- `notes.chart` — final S8 output
- `notes_chart_versions/<iso>_<digest>.chart` — snapshots; digest =
  short hash of `(engine, params)` tuple producing it

**Stale handling:**

- Re-running stage Sn moves active files of Sn+1..S8 to a sibling
  `_stale/` folder with timestamp suffix.
- UI flags those stages as "Out of date — re-run required."
- "Restore from stale" affordance per stage if the user judges the
  previous output still good for the new upstream.
- `_stale/` files are cleared on the next successful re-run of that
  stage.

**Retention:**

- Last 10 versions per stage in `<stage>_versions/`; older ones move
  to `<stage>_versions/_archive/` and aren't rendered by default
  (`?include_archive=true` lists them).
- Starred versions are never archived.

**Pipeline state file** (`<track_dir>/pipeline_state.json`):

```json
{
  "schema_version": 1,
  "grid": {
    "active_version": "2026-05-18T11-22-03_all-in-one.json",
    "engine": "all-in-one",
    "stale": false
  },
  "stems": {
    "guitar": {
      "onsets":            {"active_version": "...basic-pitch.json", "engine": "basic-pitch", "stale": false},
      "pitches":           {"active_version": "...basic-pitch.json", "engine": "basic-pitch", "stale": false},
      "quantized":         {"active_version": "...metric-weighted.json", "engine": "metric-weighted", "stale": false},
      "lanes_expert":      {"active_version": "...section-sliding.json", "engine": "section-sliding", "stale": false},
      "lanes_filtered":    {"active_version": "...identity.json", "engine": "identity", "stale": false},
      "lanes_hard":        {"active_version": "...metric-weight.json", "engine": "metric-weight", "stale": false},
      "lanes_medium":      {"active_version": "...metric-weight.json", "engine": "metric-weight", "stale": false},
      "lanes_easy":        {"active_version": "...metric-weight.json", "engine": "metric-weight", "stale": false},
      "last_chart_built_at": "2026-05-18T11:30:14Z"
    }
  }
}
```

This is the single source of truth for the editor UI: one fetch
renders all stage panels, knows which engines are selected, knows
which stages need re-running. `schema_version` enables future
migration.

## 8. API surface

Mirrors `/api/lyrics/*`. Flat namespace under `/api/pipeline/*`;
`track_id` and (where applicable) `stem` are query params.

**Per-stage endpoints** (eight stages, identical shape; `grid` as
example):

```
GET    /api/pipeline/grid?track_id=<id>
  → active grid.json contents

POST   /api/pipeline/grid?track_id=<id>
  body: { engine: "all-in-one", params: {...} }
  → creates background job (JobKind.PIPELINE_STAGE), returns { job_id }
  → SSE progress via existing /api/jobs/<id>/events
  → on completion: writes grid_versions/<iso>_<engine>.json, activates
    it, downstream stages flagged stale in pipeline_state.json
  → 409 Conflict if an in-flight run for this (track, stage[, stem])
    already exists; new request is refused (not auto-cancelled)

GET    /api/pipeline/grid/versions?track_id=<id>
GET    /api/pipeline/grid/versions/<filename>?track_id=<id>
POST   /api/pipeline/grid/versions/<filename>/activate?track_id=<id>
POST   /api/pipeline/grid/versions/<filename>/star?track_id=<id>
  body: { starred: bool }
DELETE /api/pipeline/grid/versions/<filename>?track_id=<id>
  → 409 if it's the currently-active version
DELETE /api/pipeline/grid?track_id=<id>
  → clears grid.json + flags downstream stale; preserves versions
```

S2–S7 take an additional `stem` query parameter:

```
GET    /api/pipeline/onsets?track_id=<id>&stem=guitar
POST   /api/pipeline/onsets?track_id=<id>&stem=guitar
... etc
```

**Meta endpoints:**

```
GET    /api/pipeline/state?track_id=<id>
  → pipeline_state.json (UI primary source)

GET    /api/pipeline/engines
  → static catalog:
    { stage_id: [{engine_id, display_name, params_schema}] }
  → params_schema is a small JSON-schema-like object the UI uses to
    render sliders/dropdowns generically

POST   /api/pipeline/run-from?track_id=<id>&stem=guitar
  body: { stages: ["lanes_expert", "lanes_filtered", "lanes_hard", ...] }
  → runs the listed stages in order with each one's currently active
    engine + params, atomically (one job, sequential subtasks)
  → for "Run all stale stages" button in UI

POST   /api/pipeline/build-chart?track_id=<id>&stem=guitar
  → runs S8 from current actives; returns { chart_path }

GET    /api/pipeline/stems?track_id=<id>
  → auto-detected stems from <track_dir>/stems/ directory contents
  → response: [{name, audio_path, has_v2_pipeline_state}]
```

`JobKind` enum gains one value: `PIPELINE_STAGE` with metadata
`{track_id, stem | null, stage, engine}`. SSE progress events keep
the existing `{step, progress, message}` shape.

## 9. Editor UI

New tab in `web/frontend/src/components/BeatmapEditor.tsx` titled
**"Generate"**, next to existing tabs.

```
┌─ Generate ────────────────────────────────────────────────┐
│  Stem: [guitar ▾]    [bass]  [piano]  [vocals]           │
│  (auto-populated from GET /api/pipeline/stems)            │
│                                                            │
│  ┌─ S1 · Grid (Track-level) ─────  [up-to-date]  [Run] │
│  │  Engine: [all-in-one ▾]                              │
│  │   ▸ min_segment_beats:  [-- 16 --]                  │
│  │  Status: ✓ Active — all-in-one, 11:22 today         │
│  │  Versions: [▾ 4 saved]                              │
│  └────────────────────────────────────────────────────────│
│                                                            │
│  ┌─ S2 · Onset detection ─────  [stale ▾]  [Run]      │
│  │  Engine: [basic-pitch ▾]                            │
│  │   ▸ onset_threshold:    [-- 0.5 --]                 │
│  │   ▸ min_note_length_ms: [-- 50 --]                  │
│  │  Status: ⚠ Stale (grid changed)                     │
│  └────────────────────────────────────────────────────────│
│                                                            │
│  ... (S3..S7 same pattern) ...                            │
│                                                            │
│  ┌─ S8 · Chart serialization ────────  [Build]         │
│  │  Builds notes.chart from all active stage outputs.  │
│  │  Last built: 11:30 today                            │
│  └────────────────────────────────────────────────────────│
│                                                            │
│  [Run all stale stages]  [Reset to defaults]              │
└────────────────────────────────────────────────────────────┘
```

**Per-stage card affordances:**

- Engine dropdown populated from `/api/pipeline/engines`
- Param controls rendered from each engine's `params_schema`:
  - `number` → slider with range/step
  - `boolean` → toggle
  - `enum` → dropdown
  - `range` → dual-handle slider
- Status badge: `up-to-date` (green), `stale` (orange),
  `never run` (grey), `running` (blue, with progress from SSE)
- Versions dropdown shows last 10. Each row:
  `2026-05-18 11:22 · all-in-one · ⭐ pin · activate · ⬇ download`

**Coexistence with existing editor:**

- "Notes" tab still shows the edited chart (reads `notes.chart`).
- After S8 build, Notes tab shows a one-click "Reload from generated"
  button.
- Editing tempo markers in the Notes tab creates a new
  `grid_versions/` entry tagged `engine: "manual"`, activates it,
  and marks downstream stale.
- Stem switcher in the Generate tab is the same control as elsewhere
  in the editor; switching stems just re-reads stage cards for that
  stem (Track-level S1 stays unchanged).

**Deferred visualizations (optional in Phase 2/3):**

- S1: waveform with detected downbeats + colored section bands
- S2: waveform with onset markers
- S3: scatter (time, midi pitch) colored by polyphony
- S4: scatter over grid lines, arrows showing snap delta
- S5–S7: existing runway preview rendered from in-progress lanes

## 10. Phased delivery

**Phase 0 — Foundation (1 PR)**

- `web/backend/app/pipeline/` package; empty stage scaffolds; engine
  registration mechanism
- `pipeline_state.json` read/write helpers; stale-marking logic
- Generic stage sub-router (shared by all 8 stages); meta endpoints
  scaffolded
- `GET /api/pipeline/engines` returns empty catalog
- `JobKind.PIPELINE_STAGE` enum addition
- No UI changes
- Locks in shape so engines can be added in parallel

**Phase 1 — Grid (S1) end-to-end**

- Engines: `all-in-one`, `librosa-beat`, `manual`
- Time-sig derivation; section fallback via librosa; key detection
- S1 sub-router endpoints; version handling; pipeline_state writes
- New "Generate" tab in editor; only S1 card functional
- Existing per-stem generation unchanged (still uses madmom path);
  not yet wired to consume S1 output. The grid is detectable +
  editable but no chart yet consumes it.
- Track API response gains a derived `has_grid: bool` field (computed
  from `grid.json` file existence) so the UI can show whether a grid
  has been generated without a separate request. No DB schema change.

**Phase 2 — Pitched-stem pipeline (S2–S5 + S8) + drums grid integration**

- S2 engines: `basic-pitch`, `aubio-complex`, `librosa-onset`
- S3 engines: `basic-pitch`, `crepe`, `yin`, `passthrough`
- S4 engines: `nearest-grid`, `strong-beat-priority`, `metric-weighted`
- S5 engines: `section-sliding`, `global-percentile`, `key-relative`
- S8 deterministic serializer (extends `chart_generator.write_chart`)
- All remaining stage cards added to Generate tab
- `model='v2'` enum value in `add_beatmap_record`; UI gains model
  selector per beatmap; old `model='madmom'` continues to work
- `librosa.load`-based audio loading replaces `madmom.audio.signal.Signal`
  in pipeline code; `compute_audio_peaks` migrated to librosa
- **Legacy drums generator gets a small modification:** when
  `<track_dir>/grid.json` exists, the drums generator emits its
  `[SyncTrack]` from the grid instead of its own per-stem tempo
  detection. Onset/lane logic stays unchanged. Ensures grid
  consistency across stems from Phase 2 onwards, even before the
  drums pipeline is fully migrated in Phase 4.
- At end of Phase 2 a user can generate an Expert-only chart end-to-end
  via V2 for any pitched stem, and every stem (drums included) shares
  one canonical SyncTrack when a grid exists.

**Phase 3 — Playability + difficulty (S6 + S7)**

- S6 engines: `identity` (default), `spread-fretboard`, `avoid-cramps`;
  chaining support
- S7 engines: `metric-weight`, `density-target`, `none`
- S8 now serializes 4-difficulty chart
- Settings flag `BEATMAP_MODEL_DEFAULT=v2|madmom` introduced; once
  stable, defaults to `v2`

**Phase 4 — Drums stem migration (out of scope; called out)**

- Drum-aware S2/S3/S5 engines (kit-piece classifier, lane-by-piece)
- Legacy `chart_generator.py` retires; madmom uninstalls from web
  backend `requirements.txt`
- Separate spec when scheduled

## 11. Testing & validation

**Stage-level unit tests** (`web/tests/pipeline/test_<stage>.py`):

- Each engine for each stage has a fixture audio clip + expected output
  JSON snapshot
- Synthetic signals:
  - S1: click-track at known BPM
  - S3: pure sine at known pitch
  - S3 polyphony: hand-crafted 1-/2-/3-note chord stacks
- Schema validation: every engine output validates against the stage's
  pydantic model

**Pipeline-level integration tests** (`web/tests/pipeline/test_e2e.py`):

- Three real songs spanning genres (rock, electronic, acoustic)
  committed to a fixture directory
- For each: run S1–S8 with default engines; assert chart parses and
  per-difficulty event counts staircase by ≥30% each step
- Regression baseline: `notes.chart` SHA compared against last-known-
  good per fixture. Failing assertion = either improvement (commit new
  baseline) or regression (investigate)

**Cross-stage validation** (pipeline enforces, returns 422 from POST,
never writes a bad active file):

- Per-stage `Validation` rules from §6 above
- When activating a stage's version, validate compatibility with
  upstream actives (e.g. `quantized.json`'s tick range fits inside
  `grid.json`'s `last_downbeat + 1 bar`)

**Manual QA bench:**

- Patterned on the existing Realnote Test v1 workflow
- New fixture song in `JamseshSongContent/` named "Pipeline QA v1"
  with known-correct values in `song.ini`:
  `bpm_truth = 124000`, `time_sig_truth = 4/4`, `key_truth = E minor`,
  `expert_event_count_truth = ...`
- Pipeline output compared against truth values

**Performance budgets** (CI asserts):

- S1 (cold cache, full mix ~3 min): <30 s on 4-core CPU
- S2+S3 combined (basic-pitch, 3 min stem): <15 s CPU, <5 s GPU
- S4–S7 each: <1 s
- S8: <100 ms

## 12. Out-of-scope clarifications

- **Real-Notes integration:** the pipeline produces `N` notes only; no
  `R` notes, no `realnotes_pack`/`realnotes_scale` events. The pitch
  data captured in S3 could feed a future Real-Notes pack/scale
  selector — but that's a separate spec.
- **Hold/slide note generation:** sustains preserved via the existing
  `compute_sustain_ticks` rule; no new sustain logic. Slide detection
  deferred entirely (the existing slide code in
  `chart_generator.py` remains usable from the legacy path).
- **Drums:** unchanged path; drums consume `grid.json` only.
- **Vocals:** vocals can be charted via S2/S3 with `crepe` engine in S3
  (mono-friendly), but the existing vocal beatmap pipeline
  (`VocalEditor.tsx` + `vocals.py` service) stays the primary surface
  for vocals. V2's vocal lane assignment is a secondary path.
- **Editor's manual chart editing:** unchanged. The pipeline writes
  `notes.chart`; the editor opens it. Round-trip preservation is
  the editor's responsibility, as today.

## 13. Open items deferred to implementation plan

- Exact pydantic model definitions for each stage's JSON schema
- `params_schema` shape (small JSON-schema-like dict — needs concrete
  format pinned)
- All-In-One model checkpoint URL / mirror strategy if the upstream
  Hugging Face host is unreliable
- basic-pitch PyTorch port — pin specific commit/release
- librosa version pin (avoid SciPy break that affects librosa <0.10.x)
- Per-engine default `params` values (hand-tuned during Phase 1/2)
- Whether `pipeline_state.json` schema needs a migration helper (it
  doesn't yet; Phase 0 introduces v1 and migration is YAGNI until v2)
