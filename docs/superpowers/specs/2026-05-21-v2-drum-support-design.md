# V2 pipeline drum support — design

Date: 2026-05-21
Status: Draft

## Problem

The V2 pipeline currently rejects the drums stem at the API boundary (`tracks.py:483`), so generating a drums beatmap on either the Create page or the Tracks-page modal falls back to the legacy single-shot pipeline. With Project A (Create-page preset cog) shipped, drums is now the only stem without preset/engine controls — visible inconsistency on every stem-result page.

This was deferred during Project A on the theory that V2-for-drums would require new chart-serializer code (drum-track sections, kick/snare/cymbal lane assignment). On closer inspection that's not necessary — see "Key prior misconception" below.

## Goal

Enable V2 for drums so the cog UI, presets, and per-stage engine selection work for drums identically to other stems. Match the lane-variation quality of the legacy drum pipeline by adding a spectral-centroid pitch engine, and ship a `drums-v1` built-in preset that bundles drum-friendly defaults.

**Non-goals:**
- Producing Clone Hero drum-instrument charts (`[ExpertDrums]` sections, kick/snare lane semantics, cymbal modifiers). The publish-time merger (`merge_beatmap_charts`, called from `tracks.py:1185-1190`) already renames per-stem `[ExpertSingle]` sections to `[ExpertDrums]` at publish time — generation produces guitar-format charts regardless of stem, which is what the legacy drum pipeline does today.
- Stem-specific user-saved presets. Built-in presets gain a `stems` field; the user-save UI in the modal does not surface stem selection.
- Auto-selecting `drums-v1` when the drums modal opens. Users discover the preset via the dropdown.

## Key prior misconception

Project A's spec noted that V2 drum support would need a new serializer emitting `[ExpertDrums]` sections plus a drum-classification engine. That's wrong on three counts:

1. **The V2 serializer emits `[ExpertSingle]` etc. for ALL stems.** The legacy drum pipeline does the same. Both produce guitar-format charts; the per-stem instrument routing happens at publish time, not at generation.
2. **V2 already produces single-hit output for all stems.** Every lane engine emits `sustain: 0`; the serializer outputs `N <fret> 0` with no slide notes. The legacy `single_hits_only` flag for drums is effectively the V2 default.
3. **The lane-variation gap is real but solvable with one new pitch engine.** The legacy drum pipeline uses spectral centroids (audio brightness — kick=low, snare=mid, cymbal=high) to vary fret assignment; V2's existing pitch engines (YIN, CREPE, basic-pitch) try to detect actual pitch and produce noisy results on drum audio. A new `pitches_centroid` engine wrapping the legacy generator's existing `compute_spectral_centroids` / `compute_onset_centroids` helpers closes the gap without touching the serializer.

## High-level design

```
                     ┌────────────────────────────────────────┐
                     │  POST /api/tracks/{id}/                │
                     │  generate-beatmap-v2                   │
                     │  (drums guard REMOVED)                 │
                     └────────────────┬───────────────────────┘
                                      │
                      ┌───────────────▼────────────────┐
                      │  V2 pipeline                   │
                      │   grid → onsets → pitches      │
                      │     ↑                          │
                      │     pitches_centroid (NEW)     │
                      │   → quantized → lanes_expert   │
                      │   → lanes_filtered             │
                      │   → {hard, medium, easy}       │
                      └────────────────────────────────┘

                      ┌────────────────────────────────┐
   Cog modal ────►    │  GET /api/generation-presets   │
   passes ?stem={s}   │   ?stem=drums                  │
                      │  → filter by preset.stems      │
                      └────────────────────────────────┘
```

**Component diffs:**

| Path | Action |
|---|---|
| `web/backend/app/services/pipeline/engines/pitches_centroid.py` | Create — new pitch engine wrapping legacy centroid helpers |
| `web/backend/app/services/pipeline/engines/__init__.py` | Modify — register the new engine (no `try/except` wrapper; madmom is mandatory) |
| `web/backend/app/routers/generation_presets.py` | Modify — add `stems: list[str] \| None` field; add `drums-v1` built-in preset; add `?stem=` query filter on GET endpoint |
| `web/backend/app/routers/tracks.py` | Modify — remove V2 drums guard (lines 483-484); update docstring |
| `web/backend/tests/test_pitches_centroid.py` | Create — unit tests with synthesized audio |
| `web/backend/tests/test_generation_presets.py` | Create or extend — stem filter tests |
| `web/frontend/src/components/pipeline/generationTypes.ts` | Modify — add `stems?: string[]` to `GenerationPreset` |
| `web/frontend/src/components/pipeline/GenerationSettings.tsx` | Modify — accept `stem` prop; include `?stem=...` in presets fetch URL |
| `web/frontend/src/components/StemGenerationModal.tsx` | Modify — pass `stem` to `<GenerationSettings>` |
| `web/frontend/src/pages/TracksPage.tsx` | Modify — BeatmapPanel: pass `stem` to GenerationSettings; remove `stem !== 'drums'` from render gate |
| `web/frontend/src/components/StemResult.tsx` | Modify — remove `stem !== 'drums'` from cog gate, badge gate, and `useV2` condition |

## The `pitches_centroid` engine

`web/backend/app/services/pipeline/engines/pitches_centroid.py` (~80 LOC).

**Schema parity** with existing pitch engines. Receives `audio_path`, `upstream` (with `onsets`), `params`, `on_progress`. Emits `per_onset` with the same shape (`time_s`, `dominant_midi`, `dominant_confidence`, `polyphony`, `all_pitches_midi`).

**Centroid extraction** reuses the legacy generator's helpers via `_load_generator()` (already used by `chart_generator.py`):
```python
gen = _load_generator()
spec = Spectrogram(audio_path, frame_size=4096, fps=100, num_channels=1, sample_rate=44100)
centroids, spreads = gen.compute_spectral_centroids(spec, 100)
onset_centroids, onset_spreads = gen.compute_onset_centroids(onsets_arr, centroids, spreads, 100)
```

**Centroid → fake-MIDI mapping** uses a log scale across the configured range so kick/snare/cymbal spread usefully across the MIDI space the lane engine bins:
```python
def _centroid_to_fake_midi(c_hz: float, min_hz: float, max_hz: float) -> int:
    c = max(min_hz, min(max_hz, c_hz))
    span_log = log2(max_hz / min_hz)
    frac = log2(c / min_hz) / span_log
    return int(40 + frac * 50)  # 40..90 MIDI range
```

The exact mapping doesn't matter much because `lanes_engines.run_section_sliding` uses `np.percentile` — the binning normalizes whatever distribution it gets. What matters is monotonicity (higher centroid → higher fake-MIDI).

**Params schema:**
```python
_PARAMS_SCHEMA = {
    'min_centroid_hz': {'type': 'number', 'min': 50, 'max': 500, 'step': 10, 'default': 100,
                        'label': 'Min expected centroid (Hz)'},
    'max_centroid_hz': {'type': 'number', 'min': 2000, 'max': 12000, 'step': 100, 'default': 8000,
                        'label': 'Max expected centroid (Hz)'},
    'window_ms': {'type': 'number', 'min': 5, 'max': 200, 'step': 5, 'default': 30,
                  'label': 'Window around onset (ms)'},
}
```

**Edge cases:**
- Empty onsets upstream → `per_onset: []`
- Onset time past end of audio → `dominant_midi: None` for that entry
- Centroid is NaN or zero (silent window) → `dominant_midi: None`
- All onsets land in silent windows → all-None output (lane engine handles this via the `if midi is None: anchor = 2` fallback at `lanes_engines.py:58`)

**Registration** in `engines/__init__.py`:
```python
from . import pitches_centroid  # noqa: F401  (side-effect: register_engine)
```
No `try/except ImportError` wrapper — madmom is a hard dependency and the centroid helpers are part of the bundled `bin/JamseshChartGenerator`.

## `drums-v1` built-in preset + stem filter

**Schema change** (`GenerationPreset` in `generation_presets.py` and `generationTypes.ts`):
- Add optional `stems: list[str] | None` field.
- `None` (or absent) → preset is universal (current behavior for all existing presets).
- Non-empty list → preset is shown only when the current stem matches one of the listed values.

**New built-in preset added to `BUILTIN_PRESETS`:**
```python
{
    'name': 'drums-v1',
    'description': 'Drum-friendly defaults — spectral centroid pitch + raised chord threshold',
    'builtin': True,
    'stems': ['drums'],
    'generation': {
        'onsets': {'engine': 'librosa-onset', 'params': {}},
        'pitches': {'engine': 'centroid', 'params': {}},
        'quantized': {'engine': 'metric-weighted', 'params': {}},
        'lanes_expert': {'engine': 'section-sliding',
                         'params': {'chord_polyphony_threshold': 6}},
        'lanes_filtered': {'engine': 'identity', 'params': {}},
    },
}
```

The `chord_polyphony_threshold: 6` (vs default `3`) effectively disables chord-promotion. Drum hits are almost always single events; 2-fret chords don't make sense from pitch-noise on percussion.

**Stem-filter endpoint change:**
```python
@router.get('')
async def list_presets(stem: str | None = Query(default=None)) -> list[dict]:
    user = _load_user_presets()
    all_presets = BUILTIN_PRESETS + user
    if stem is None:
        return all_presets
    return [p for p in all_presets if not p.get('stems') or stem in p['stems']]
```

User-saved presets don't carry a `stems` field today; they stay universal. A future enhancement could surface stem selection in the Save-as UI; out of scope here.

## Frontend changes

**`GenerationSettings` gains a `stem` prop.** It threads into the presets fetch URL:
```ts
const url = stem
  ? `/api/generation-presets?stem=${encodeURIComponent(stem)}`
  : '/api/generation-presets'
fetch(url, { signal: ctrl.signal })
```
No other behavior change — preset list still drives the dropdown; v1-fallback effect still snaps `activePreset` to `'v1'` when the current value is empty or out-of-list (drums users still default to `v1` until they explicitly switch to `drums-v1`).

**Call sites pass `stem` through:**
- `BeatmapPanel` in `TracksPage.tsx` already has `stem` as a prop → passes to `<GenerationSettings stem={stem} ... />`
- `StemGenerationModal` already has `stem` as a prop → passes through to `<GenerationSettings>` inside the modal body

**`stem !== 'drums'` exclusions removed in 4 places:**

`StemResult.tsx`:
- Cog button gate: `{!bm && stem !== 'song' && stem !== 'drums' && trackId && (...)` → `{!bm && stem !== 'song' && trackId && (...)`
- Preset badge gate: `{stem !== 'vocals' && stem !== 'drums' && stem !== 'song' && ...}` → `{stem !== 'vocals' && stem !== 'song' && ...}`
- `useV2 = stem !== 'drums' && !!trackId` → `useV2 = !!trackId`

`TracksPage.tsx` BeatmapPanel:
- `{idx === 0 && stem !== 'drums' && (<GenerationSettings ... />)}` → `{idx === 0 && (<GenerationSettings stem={stem} ... />)}` (also passes the new prop)

## Backend changes

**`tracks.py` (V2 endpoint):**

Remove lines 483-484:
```python
if stem == 'drums':
    raise HTTPException(400, 'Drums stem is not supported by V2 pipeline; use /generate-beatmap')
```

Update the function docstring's drum rejection note to: "All stems including drums go through V2 with single-hit semantics (V2 produces sustain=0, no slides, by design)."

No other tracks-router changes. The V2 endpoint's form schema, FormData parsing, and SSE plumbing all stay identical for drums.

## Error handling

| Scenario | Behavior |
|---|---|
| Centroid engine called with `audio_path=None` | Raise `ValueError('centroid requires a stem audio file')` — same pattern as YIN |
| Centroid engine: madmom fails to load audio | Exception bubbles up; pipeline marks the stage failed; user sees the error via the existing SSE error path |
| Stem filter on `GET /api/generation-presets?stem=<bogus>` | Returns universal presets (no error). The filter is permissive — unknown stem name just means no stem-specific presets match. |
| Frontend passes `stem` prop with empty string | URL omits the `?stem=` param (the `stem ? ... : ...` ternary in the fetch URL). Effectively unfiltered. |
| `drums-v1` preset is missing from BUILTIN_PRESETS (e.g., user deleted from generation_presets.json) | User-saved presets file is independent of built-ins; `BUILTIN_PRESETS` is the source of truth in code so a missing entry can't happen unless the file is edited. If it did happen, the dropdown just wouldn't show it; v1 stays as the fallback. |

## Testing

**Backend:**

- `web/backend/tests/test_pitches_centroid.py` — unit tests for the new engine:
  - Empty onsets → `per_onset: []`
  - All-silent audio (synthesized as zeros) → every entry has `dominant_midi: None`
  - Kick pattern (synthesized as 100 Hz pulses) → `dominant_midi` values cluster in the low half of the configured MIDI range
  - Cymbal pattern (synthesized as 5 kHz noise bursts) → `dominant_midi` values cluster in the high half
  - Mixed pattern → distribution spans the range
  - Bogus `min_centroid_hz > max_centroid_hz` params → engine clamps gracefully (or raises a clear error if we prefer)

  Synthesized audio follows the pattern in `tests/test_pipeline_phase2_e2e.py` (numpy + soundfile, no committed fixtures).

- `web/backend/tests/test_generation_presets.py` — endpoint tests (extend if file exists, otherwise create):
  - `GET /api/generation-presets` → returns all presets including `drums-v1`
  - `GET /api/generation-presets?stem=drums` → universal presets + `drums-v1`
  - `GET /api/generation-presets?stem=guitar` → universal presets, no `drums-v1`
  - `GET /api/generation-presets?stem=bogus` → universal presets only
  - User-saved presets (no `stems` field) appear in all stem queries

**Frontend:** no React component test infrastructure. Manual smoke checklist:

- [ ] Open Create page after a Demucs job with a drums stem
- [ ] Drums row now shows a ⚙ cog next to Generate Beatmap (same as other stems)
- [ ] Click cog → modal opens; dropdown shows `v1` selected by default; `drums-v1` appears in the list
- [ ] Switch to `drums-v1` → engine selectors flip (pitches becomes "Spectral centroid (drum-friendly)", lanes_expert's `chord_polyphony_threshold` becomes 6)
- [ ] Generate from modal → completes successfully; chart appears in the row
- [ ] Open the modal on a guitar row → `drums-v1` is NOT in the dropdown
- [ ] Click the main Generate Beatmap button on drums row → Network tab confirms `POST /api/tracks/{id}/generate-beatmap-v2` (no longer `/api/beatmap/from-stem`)
- [ ] Generated drum chart published to the game still appears under the drums instrument (existing publish-time section rename still works)
- [ ] Tracks-page Generate Beatmap modal: opening it on drums now shows the generation section (previously hidden); `drums-v1` available
- [ ] Generation of guitar/bass/other stems still works identically (no regression)
- [ ] Saved preset choice persists across page reload (localStorage from Project A still works)

## Deploy

Mixed change (backend + frontend) per the deploy memory:

```
ssh beatmap 'cd /opt/madmom && git pull --ff-only && cd web/frontend && npm run build && systemctl restart beatmap-backend'
```

No new pip deps. No new system deps. madmom + the bundled `bin/JamseshChartGenerator` are already on the droplet — the centroid engine just imports through them.

## Open follow-ups

- **Stem-specific user-saved presets.** The Save-as UI in the modal could expose a "save for drums only" checkbox. Would write `stems: [<current stem>]` into the user preset record. Skipped for now since the built-in preset addresses the main use case.
- **Auto-select `drums-v1` for drums.** Considered and explicitly deferred (per Q3 answer). If users find the default-`v1`-for-drums confusing, revisit.
- **Centroid engine for non-drum stems.** The engine is registered globally, so users can pick it for any stem. It's listed as "drum-friendly" in the display name but works on any audio. Worth observing whether anyone uses it for guitar — no action needed either way.
- **V2 drum-chart-format engine (Approach 2 from brainstorming).** Producing actual `[ExpertDrums]` sections with kick/snare/cymbal lane assignment would be a much bigger lift requiring serializer changes, a new note-payload schema, and a drum-classification engine. Out of scope; tracked here in case the existing publish-time section rename ever becomes insufficient.
