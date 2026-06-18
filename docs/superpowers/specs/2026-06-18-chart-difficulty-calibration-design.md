# Chart Difficulty Calibration — Design

**Date:** 2026-06-18
**Status:** Approved (design)

## Goal

Calibrate the game's difficulty tiers (Expert / Hard / Medium / Easy) consistently
across every song planned for the game. Provide a screen where multiple songs from the
Studio Library can be selected and their charts compared side-by-side on every metric we
can scrape, so thresholds for each difficulty tier can be set against real data.

## User flow

1. On the Studio Library page, the user checkbox-selects songs (with a "select all").
2. A **Compare (N)** button appears once ≥1 song is selected.
3. Clicking it opens a new **Calibration / Compare** screen.
4. The screen shows a tabulated, sortable/filterable list of every metric per
   `song × instrument × difficulty`, plus per-tier summary stats, outlier highlighting,
   and CSV/clipboard export.

## Architecture

- **Backend**
  - Extend `web/backend/app/services/chart_analyser.py` with timing-aware metrics. The
    current analyser reads a single BPM; calibration needs a real tempo map built from
    `[SyncTrack]` (charts may carry multiple `B` tempo changes) and a `tick → seconds`
    converter.
  - New service `web/backend/app/services/calibration.py` that walks selected tracks →
    **included** beatmaps → `notes.chart` → per-difficulty metric rows, and assembles the
    flat row list + per-tier summary.
  - New router `web/backend/app/routers/calibration.py` exposing
    `POST /api/calibration/compare` taking `{ "track_ids": [...] }` and returning
    `{ rows: [...], summary: {...}, skipped: [...] }`. Mounted in `app/main.py`.

- **Frontend**
  - `web/frontend/src/pages/TracksPage.tsx`: add per-row checkbox, header "Select all",
    and a floating **Compare (N)** button. Checkbox clicks must `stopPropagation` so they
    don't trigger the existing row → edit navigation.
  - New `web/frontend/src/pages/CalibrationPage.tsx` at route `/compare`. Receives the
    selected track ids (via router navigation state, with a query-param fallback so the URL
    is shareable/reloadable), fetches `/api/calibration/compare`, and renders the table.

## Row model

- Input: a list of selected `track_ids`.
- For each track, for each beatmap with `included == true`, parse its `notes.chart`.
- Instrument is derived from the beatmap's `stem` (guitar → Guitar, drums → Drums,
  bass → Bass, vocals → Vocals, etc.).
- Each present difficulty section (`{Expert,Hard,Medium,Easy}{suffix}`) becomes **one flat
  row**: `song × instrument × difficulty`.
- Row identity fields: `track_id`, `song_name`, `artist`, `instrument`, `difficulty`,
  `beatmap_id`, `preset`.

## Metrics per row

### Basic (from existing `analyse_chart_section` counts)
- `total_gems` — total playable note events (singles + holds + chords + slides + opens)
- `total_holds` — sustained single notes
- `total_chords` — multi-fret simultaneous hits
- `total_chord_holds` — sustained chords
- `total_slides` — single-fret slides
- `total_chord_slides` — chord slides ("slide chords")
- `open_notes` — open (fret 7) notes
- `hold_pct` — holds (incl. chord holds) ÷ total gems
- `chord_pct` — chords (incl. chord holds/slides) ÷ total gems
- `lane_range` — lowest–highest fret used (e.g. "0–4")
- `distinct_lanes` — count of distinct colored frets used

### Timing-derived (new; require tempo map + tick→seconds)
- `duration_s` — chart length in seconds (time of last note/sustain end)
- `gems_per_min` — `total_gems / (duration_s / 60)`
- `peak_nps` — max notes-per-second in a sliding window
- `busiest_measure` — measure index (or time) of peak density
- `min_gap_s` — shortest interval between consecutive gems
- `longest_run` — longest run of consecutive notes spaced below a "fast" threshold
- `avg_chord_size` — mean simultaneous gems per chord

### Cross-difficulty
- `pct_of_expert_gpm` — this row's `gems_per_min` as a % of the same chart's Expert tier
  `gems_per_min` (flags uneven Easy→Expert staircases). Computed after all rows for a
  given `(track, instrument)` are known.

## Calibration aids (frontend)

- **Summary block** — min / median / max / mean for each metric, grouped by difficulty
  tier (all Expert rows, all Hard rows, …). This is the baseline being calibrated against.
- **Outlier highlighting** — within each difficulty tier, color cells that fall outside a
  robust range (median ± 1.5×IQR): red = unusually high, amber = unusually low. Surfaces a
  chart miscalibrated relative to its tier (e.g. an "Easy" chart denser than most "Medium").
- **Sort + filter** — click a column header to sort; filter chips for instrument and
  difficulty.
- **Export** — copy-to-clipboard as TSV and download as CSV.

## Tempo map / timing details

- Parse `[SyncTrack]` for all `<tick> = B <microBPM>` entries (value is BPM × 1000).
- Build an ordered list of `(tick, bpm)` segments; `tick → seconds` accumulates time across
  segments using `resolution` (ticks per beat) and each segment's BPM.
- All timing-derived metrics use this converter so charts with tempo changes are measured
  accurately.

## Error handling

- Beatmaps with a missing or unparseable `notes.chart` are skipped and reported in a
  `skipped` list (shown as a small notice on the screen), not fatal to the comparison.
- A track with zero included beatmaps simply contributes no rows.
- A difficulty section with zero notes contributes a row with zeroed metrics (or is
  omitted — omit, to avoid divide-by-zero noise in summaries).

## Decisions / assumptions

- Instrument label is derived from the stem name.
- The cross-difficulty ratio is anchored to **Expert** within each chart.
- Outlier detection uses **median ± 1.5×IQR** (robust to small library sizes).
- Only **included** (publish-bound) beatmaps are analyzed.

## Out of scope (YAGNI)

- Persisting calibration scores back onto beatmap records.
- Auto-tuning difficulty thresholds or re-generating charts from the screen.
- Comparing alternate presets against each other (only included beatmaps are pulled).
