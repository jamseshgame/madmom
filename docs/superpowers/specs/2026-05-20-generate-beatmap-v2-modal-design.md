# Generate Beatmap modal — switch to V2 pipeline with compact engine knobs

**Date:** 2026-05-20
**Status:** Approved (brainstorming → ready for implementation plan)

## Problem

Two tangled issues with the current "Generate Beatmap" flow:

1. **No generation knobs in the modal.** `BeatmapPanel` in `web/frontend/src/pages/TracksPage.tsx` exposes only song.ini metadata — no engine choices, no thresholds, no min-gap. The user has to commit to a generation with whatever defaults the legacy code path bakes in.
2. **Inconsistent lane assignment for repeating phrases.** The legacy path (`generate_full_chart` → `bin/JamseshChartGenerator:centroid_to_frets`, line 106) bins frets by **whole-song percentiles** of spectral centroid. The same musical phrase at different times can land on different frets because the surrounding material shifts the percentile cutoffs. Concrete repro: at ~0:08.75 a bass phrase emits three Green notes; the same phrase at ~0:21.78 emits a Green hold + Red+Yellow chord.

Meanwhile a full V2 staged pipeline already exists (`web/backend/app/services/pipeline/`) with multiple engines per stage, including `section-sliding` and `key-relative` lane engines that don't have the global-percentile problem. The editor's *Generate* tab (`GenerateTab.tsx`) exposes those engines and knobs — but you only see that tab *after* a beatmap exists.

## Goal

Make the "Generate Beatmap" modal drive the V2 pipeline end-to-end with a compact, tweakable set of engine choices and knobs. After clicking Generate, the backend runs every V2 stage in sequence and writes the same on-disk artifacts the legacy path produces (`notes.chart`, `song.ogg`, `song.ini` inside `<artist> - <song_name>/`). User is redirected to the editor on success.

## Scope

- New "GENERATION" section in `BeatmapPanel` with 5 engine dropdowns + a handful of numeric knobs.
- New backend endpoint `POST /api/tracks/{track_id}/generate-beatmap-v2` that orchestrates all V2 stages then builds the chart, writes audio + song.ini, and registers a beatmap record.
- Refactor extractions: shared `ParamControl` React component; shared `run_stage` Python helper; shared `write_song_ini` helper.
- Drums stem keeps using the legacy endpoint (no V2 drum lane engine yet).

## Non-goals (YAGNI)

- Per-difficulty knob tweaking inside the modal — defaults are good; user iterates in editor's Generate tab.
- Preset save/load.
- Re-designing the editor's existing Generate tab.
- Multi-stem batch generation.
- Surfacing every V2 engine param.
- A V2 drum lane engine.

## Modal layout

New section "GENERATION" between *Metadata* and *Timing*:

| Stage | Engine choices | Default | Knobs surfaced |
|---|---|---|---|
| Onset detection | aubio / **librosa** / basic_pitch | librosa | `delta` (0-0.5, def 0.07), `min_gap_ms` (0-500, def 0) — only when librosa is selected |
| Pitch detection | **yin** / crepe / basic_pitch / passthrough | yin | — |
| Quantization | **nearest** / strong-beat / metric | nearest | `max_division` enum 4/8/16/32 (def 16) |
| Lane mapping | **section-sliding** / global-percentile / key-relative | section-sliding | `chord_polyphony_threshold` (2-6, def 3), `open_high_percentile` (80-100, def 100), `open_low_percentile` (0-20, def 0) |
| Playability filter | **chain** / spread-fretboard / avoid-cramps | chain | — |

Defaults rationale:
- `librosa-onset`: tunable, no extra model deps. Aubio requires the aubio C lib; basic_pitch loads a tflite model.
- `yin`: lightweight (CREPE pulls ~30 MB torch model on first call).
- `nearest @ 16`: matches editor's default 16th-note grid.
- `section-sliding`: per-section percentile windows — fixes the same-phrase-different-lanes bug. Recommended in the engine's own metadata.
- `chain`: applies spread-fretboard + avoid-cramps in sequence.

Drums special case: when `stem === 'drums'`, hide the GENERATION section and fall back to legacy `/generate-beatmap`. The existing `generate_full_chart` already handles `single_hits_only` for drums.

## Frontend changes

**`web/frontend/src/pages/TracksPage.tsx`** (`BeatmapPanel`):
- Add `GENERATION` to `FIELD_GROUPS` rendering, *but* it doesn't use `schema[key]` — render it as a custom block with engine dropdowns and knobs from the engines catalog.
- Fetch engines catalog on mount (`fetchEnginesCatalog()` already exists in `api/pipelineClient.ts`).
- Track per-stage selected engine + params in state (`generation` field on values).
- When `stem === 'drums'`, skip the GENERATION block.
- On submit:
  - If drums → POST to existing `/generate-beatmap` (no behavior change).
  - Else → POST to `/generate-beatmap-v2` with all song.ini fields + per-stage engine ids + per-stage params as form fields.

**Extract `ParamControl`:** Move the `ParamControl` function from `web/frontend/src/components/pipeline/StageCard.tsx:144-185` to a new file `web/frontend/src/components/pipeline/ParamControl.tsx`. `StageCard` imports from there. `BeatmapPanel` reuses the same component.

## Backend changes

**New endpoint `POST /api/tracks/{track_id}/generate-beatmap-v2`** in `web/backend/app/routers/tracks.py`.

Form params:
- `stem` (str, required)
- All existing song.ini overrides (unchanged from legacy endpoint)
- `onsets_engine`, `onsets_params` (JSON string)
- `pitches_engine`, `pitches_params`
- `quantized_engine`, `quantized_params`
- `lanes_engine`, `lanes_params`
- `playability_engine`, `playability_params`

Orchestration (async background task, single job):

1. Resolve `track_dir`, `stem_path`. 404 if missing.
2. **Grid (S1)** — if `stage_path(track_dir, Stage.GRID, None)` doesn't exist or is stale, run `librosa-beat` with defaults. Otherwise skip.
3. **Onsets (S2)** — `run_stage(Stage.ONSETS, ...)`.
4. **Pitches (S3)** — `run_stage(Stage.PITCHES, ...)`.
5. **Quantized (S4)**.
6. **Lanes expert (S5)**.
7. **Lanes filtered (S6)**.
8. **Difficulties (S7)** — `lanes_hard`, `lanes_medium`, `lanes_easy` using the default difficulty engine + default params (no modal knob for these).
9. **Build chart (S8)** — call `serialize_chart(...)` from `services/pipeline/serialize.py`. Write to job's output_dir as `<artist> - <song_name>/notes.chart` — *not* the per-stem V2 layout. This matches what publish/zip flow expects.
10. **Audio convert** — `convert_to_ogg(stem_path, out_dir / 'song.ogg')`.
11. **song.ini** — call extracted helper `write_song_ini(out_dir, song_name, artist, album, genre, year, ini_overrides, chart_path)`.
12. **Register beatmap** — `add_beatmap_record(..., model='madmom', model_version=f'{madmom_pkg_version}+v2')`. The existing function signature only has `model` and `model_version` (see `services/tracks.py:196`), so the `+v2` suffix in `model_version` is how we encode pipeline provenance. The picker badge logic in `BEATMAP_MODEL_BADGE` still matches on `model='madmom'`, so the badge color is unchanged; the suffix is visible in the version label tooltip.

SSE progress (single job, same envelope as legacy):
- grid: 0-10%
- onsets: 10-25%
- pitches: 25-45%
- quantized: 45-55%
- lanes_expert: 55-70%
- lanes_filtered: 70-78%
- difficulties: 78-90%
- build + audio + ini: 90-100%

**Refactor extraction — `run_stage(...)`** in `web/backend/app/services/pipeline/runner.py` (new file):

Signature:
```python
def run_stage(
    stage: Stage,
    track_dir: Path,
    stem: str | None,
    engine_id: str,
    params: dict,
    on_progress: Callable[[str, int, str], None],
) -> dict
```

Body extracts the per-stage execution loop currently inside `_make_stage_subrouter` in `routers/pipeline.py`:
- Loads upstream stage outputs from disk.
- Looks up engine in `_REGISTRY`.
- Invokes runner with `(audio_path, upstream, params, on_progress)`.
- Writes the result to `stage_path(track_dir, stage, stem)` and updates `pipeline_state.json`.

Both the existing per-stage POST handlers and the new V2 endpoint then call `run_stage`.

**Refactor extraction — `write_song_ini(...)`** in `web/backend/app/services/chart_generator.py`:

Move the song.ini writing block currently at `chart_generator.py:413-468` into a public helper. Both `generate_full_chart` and the new V2 endpoint call it.

**Backward compat:** Legacy `/generate-beatmap` endpoint stays untouched. Only the frontend switches the call (and only when `stem !== 'drums'`). Existing beatmap records unaffected.

## Drums fallback

Drums stem goes to legacy endpoint. The V2 lanes engines bin onsets by MIDI percentile across the song — that's the wrong shape for percussion (kicks, snares, toms, cymbals are categorical, not pitched). Until a drum-specific lane engine exists, falling back to `generate_full_chart` with `single_hits_only=True` is correct. Out of scope for this spec.

## Testing

**Unit:**
- `test_write_song_ini` — round-trip the existing legacy output through the extracted helper; assert byte-for-byte match against a captured fixture.
- `test_run_stage` — feed a minimal fake `_REGISTRY` and assert it writes to the right path and updates state correctly.

**Integration:**
- `test_generate_beatmap_v2.py` — POST to new endpoint with a small fixture audio, assert: job completes; `notes.chart` exists; `song.ini` has the expected sections; beatmap record is created with `model_variant='v2'`.

**Manual verification (golden path):**
1. Open the user's reported track in TracksPage.
2. Click Generate Beatmap on the Bass stem.
3. Confirm GENERATION section is visible with the 5 dropdowns + knobs at their defaults.
4. Generate with `section-sliding` lane engine.
5. Open the editor and confirm the same musical phrase at ~0:08.75 and ~0:21.78 lands on the same lane(s).

**Backward compat smoke test:**
- POST to legacy `/generate-beatmap` with a guitar stem; assert it still produces the same output it produced pre-refactor.

## Acceptance criteria

- [ ] Modal shows the GENERATION section with 5 engine dropdowns + the listed knobs at their defaults.
- [ ] Submitting the modal hits `/generate-beatmap-v2` and runs all V2 stages in sequence with SSE progress.
- [ ] On success, modal redirects to `/edit/<track>/<beatmap>`.
- [ ] Regenerated Bass beatmap using `section-sliding` produces the same lane assignment for the same musical phrase at different timestamps in the song.
- [ ] Drums stem keeps using legacy endpoint and produces unchanged output.
- [ ] Legacy `/generate-beatmap` endpoint still works for non-drum stems if invoked directly.
- [ ] `ParamControl` is shared between `StageCard` and `BeatmapPanel`.
- [ ] `write_song_ini` and `run_stage` are extracted helpers, each with a unit test.
- [ ] Beatmap records produced by V2 have `model_version` ending in `+v2` (so the picker can distinguish them in the version-label tooltip).

## Risks

- **First-time generation on a fresh track is ~15-30 s slower** because grid (S1) runs once. One-time cost per track; subsequent stem generations reuse the grid.
- **Partial-failure state.** If a stage fails partway, intermediate V2 stage outputs remain on disk. The legacy path is atomic. Mitigation: catch any stage failure and emit `error` SSE event with the failing stage name; the user can resume from the editor's Generate tab. Intermediate state is also useful for debugging.
- **Stage runner extraction.** `_make_stage_subrouter` currently couples the runner to FastAPI request/response handling. The extracted `run_stage` needs to be pure (no FastAPI types). Existing per-stage POST handlers must be updated to call the new helper — that's the main mechanical refactor risk. Cover with the new `test_run_stage` unit test before swapping callers.
