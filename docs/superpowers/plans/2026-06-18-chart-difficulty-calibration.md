# Chart Difficulty Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user multi-select songs in the Studio Library and open a Compare screen showing per-`song×instrument×difficulty` chart metrics, plus per-difficulty summary stats and outlier highlighting, to calibrate difficulty tiers across the library.

**Architecture:** A pure-Python metrics module computes timing-aware chart statistics from a `notes.chart` section body. A calibration service walks selected tracks → *included* beatmaps → difficulty sections → flat metric rows (+ cross-difficulty ratios + per-tier summary). A thin FastAPI router exposes `POST /api/calibration/compare`. The frontend adds selection controls to `TracksPage` and a full-width `CalibrationPage` route that renders a sortable/filterable table with summary rows, IQR-based outlier highlighting, and CSV/clipboard export.

**Tech Stack:** Python 3.9+, FastAPI, pydantic; React 18 + TypeScript + Vite + Tailwind; react-router-dom.

## Global Constraints

- Backend Python style: Black line length 120, single quotes (`-S`), `from __future__ import annotations` at top of every new module.
- Frontend: TypeScript strict; Tailwind classes consistent with existing dark theme (`bg-gray-900`, `border-gray-800`, `text-jam-300` accents).
- Web tests run from the repo root: `pytest web/backend/tests/...`. `conftest.py` puts `web/backend/` on `sys.path`, so backend imports use `from app.services... import ...`.
- Only **included** beatmaps are analyzed: `bm.get('included', True)` (missing field ⇒ included, for backward compat).
- "difficulty tier" = the section-name prefix, one of `Expert` / `Hard` / `Medium` / `Easy`.
- A `total_gems` counts individual gem objects (a 2-fret chord = 2 gems); timing metrics (nps, gaps, runs) count note-groups (a chord = one hit).
- Module constants for run/window detection are fixed across songs so values stay comparable: `FAST_GAP_S = 0.25`, `PEAK_WINDOW_S = 1.0`, `BEATS_PER_MEASURE = 4`.

---

## File Structure

**Backend**
- Create: `web/backend/app/services/calibration_metrics.py` — pure functions: tempo map, tick→seconds, gem parsing, per-section metrics, summary stats. No I/O.
- Create: `web/backend/app/services/calibration.py` — walks tracks/beatmaps/charts, assembles rows + cross-difficulty ratios + summary. Reads disk via existing `tracks` service.
- Create: `web/backend/app/routers/calibration.py` — `POST /api/calibration/compare`.
- Modify: `web/backend/app/main.py` — import + mount the calibration router (auth-protected).
- Create tests: `web/backend/tests/test_calibration_metrics.py`, `web/backend/tests/test_calibration_service.py`, `web/backend/tests/test_calibration_endpoint.py`.

**Frontend**
- Modify: `web/frontend/src/pages/TracksPage.tsx` — per-row checkbox, header select-all, floating Compare button; navigate to `/compare` with selected ids in router state.
- Create: `web/frontend/src/pages/CalibrationPage.tsx` — fetch + table + sort/filter + summary + outliers + export.
- Modify: `web/frontend/src/App.tsx` — full-width `/compare` route (special-cased like `/edit/`).

---

## Task 1: Tempo map + tick→seconds (pure)

**Files:**
- Create: `web/backend/app/services/calibration_metrics.py`
- Test: `web/backend/tests/test_calibration_metrics.py`

**Interfaces:**
- Produces:
  - `build_tempo_map(chart_text: str) -> list[tuple[int, float]]` — sorted `(tick, bpm)` segments parsed from `[SyncTrack]` `B` events; always includes a segment at tick 0 (defaults to 120.0 BPM if none present).
  - `tick_to_seconds(tick: int, tempo_map: list[tuple[int, float]], resolution: int) -> float` — accumulated seconds from tick 0 to `tick` across tempo segments.

- [ ] **Step 1: Write the failing test**

```python
# web/backend/tests/test_calibration_metrics.py
from __future__ import annotations

from app.services.calibration_metrics import build_tempo_map, tick_to_seconds


def test_build_tempo_map_reads_b_events_and_divides_by_1000():
    chart = '[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n  384 = B 240000\n}\n'
    assert build_tempo_map(chart) == [(0, 120.0), (384, 240.0)]


def test_build_tempo_map_defaults_to_120_at_zero_when_missing():
    assert build_tempo_map('[Song]\n{\n  Resolution = 192\n}\n') == [(0, 120.0)]


def test_build_tempo_map_prepends_zero_when_first_b_is_later():
    chart = '[SyncTrack]\n{\n  384 = B 90000\n}\n'
    assert build_tempo_map(chart) == [(0, 120.0), (384, 90.0)]


def test_tick_to_seconds_single_tempo():
    tm = [(0, 120.0)]
    assert tick_to_seconds(0, tm, 192) == 0.0
    assert tick_to_seconds(192, tm, 192) == 0.5   # 1 beat at 120bpm
    assert tick_to_seconds(384, tm, 192) == 1.0


def test_tick_to_seconds_tempo_change():
    tm = [(0, 120.0), (384, 240.0)]   # 2 beats @120 then 240
    # 384 ticks = 2 beats @120 = 1.0s; +192 ticks = 1 beat @240 = 0.25s
    assert tick_to_seconds(576, tm, 192) == 1.25
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest web/backend/tests/test_calibration_metrics.py -v`
Expected: FAIL — `ModuleNotFoundError` / `ImportError: cannot import name 'build_tempo_map'`.

- [ ] **Step 3: Write minimal implementation**

```python
# web/backend/app/services/calibration_metrics.py
"""Pure chart-metric helpers for difficulty calibration.

No disk or network I/O — every function takes text/numbers in and returns
plain data, so the whole module is unit-testable in isolation.
"""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass

_SYNC_RE = re.compile(r'\[SyncTrack\]\s*\{([^}]*)\}')
_B_RE = re.compile(r'(\d+)\s*=\s*B\s+(\d+)')


def build_tempo_map(chart_text: str) -> list[tuple[int, float]]:
    """Parse `[SyncTrack]` BPM (`B`) events into sorted `(tick, bpm)` segments.

    The chart `B` value is BPM*1000. Always returns a segment at tick 0 so
    tick_to_seconds has a defined starting tempo (defaults to 120 BPM).
    """
    segments: list[tuple[int, float]] = []
    m = _SYNC_RE.search(chart_text)
    if m:
        for line in m.group(1).split('\n'):
            bm = _B_RE.match(line.strip())
            if bm:
                segments.append((int(bm.group(1)), int(bm.group(2)) / 1000.0))
    segments.sort(key=lambda s: s[0])
    if not segments or segments[0][0] != 0:
        segments.insert(0, (0, 120.0))
    return segments


def tick_to_seconds(tick: int, tempo_map: list[tuple[int, float]], resolution: int) -> float:
    """Seconds elapsed from tick 0 to `tick`, walking tempo segments."""
    if resolution <= 0:
        return 0.0
    seconds = 0.0
    for i, (seg_tick, bpm) in enumerate(tempo_map):
        if tick <= seg_tick:
            break
        next_tick = tempo_map[i + 1][0] if i + 1 < len(tempo_map) else None
        end = tick if (next_tick is None or tick < next_tick) else next_tick
        beats = (end - seg_tick) / resolution
        seconds += beats * 60.0 / bpm
        if next_tick is None or tick < next_tick:
            break
    return seconds
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest web/backend/tests/test_calibration_metrics.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add web/backend/app/services/calibration_metrics.py web/backend/tests/test_calibration_metrics.py
git commit -m "feat(calibration): tempo map + tick-to-seconds helpers"
```

---

## Task 2: Gem parsing + per-section metrics (pure)

**Files:**
- Modify: `web/backend/app/services/calibration_metrics.py`
- Test: `web/backend/tests/test_calibration_metrics.py`

**Interfaces:**
- Consumes: `tick_to_seconds` (Task 1).
- Produces:
  - `GemTick` dataclass: `tick: int`, `frets: tuple[int, ...]` (sorted unique playable frets 0–4 and 7), `max_sustain: int`, `is_slide: bool`.
  - `parse_gem_ticks(body: str) -> list[GemTick]` — one entry per tick that carries a playable hit, sorted by tick. Unions `N`/`R` note lines with `E slide` lines (slide-middle ticks carry both); a tick is `is_slide` if any `E slide` line referenced it. Modifier frets (5, 6, 66–68) are ignored.
  - `section_metrics(body: str, resolution: int, tempo_map: list[tuple[int, float]]) -> dict | None` — all per-section metrics, or `None` when the section has zero gems.
  - Module constant `NUMERIC_METRICS: list[str]` — the metric keys eligible for summary/outlier stats.

The `section_metrics` return dict has exactly these keys:
`total_gems, total_notes, total_holds, total_chords, total_chord_holds, total_slides, total_chord_slides, open_notes, hold_pct, chord_pct, lane_lo, lane_hi, distinct_lanes, duration_s, gems_per_min, peak_nps, busiest_measure, min_gap_s, longest_run, avg_chord_size`.
`lane_lo`/`lane_hi` are `None` when no colored frets; `min_gap_s` is `None` when fewer than 2 note-groups.

- [ ] **Step 1: Write the failing test**

```python
# append to web/backend/tests/test_calibration_metrics.py
from app.services.calibration_metrics import GemTick, parse_gem_ticks, section_metrics


def test_parse_gem_ticks_groups_chord_and_marks_slide():
    body = '\n'.join([
        '  0 = N 0 0',
        '  0 = N 1 0',          # chord at tick 0 (frets 0,1)
        '  192 = N 2 96',       # hold at tick 192
        '  384 = E slide 3',    # slide-start (no N)
        '  384 = N 5 0',        # modifier fret ignored
    ])
    gems = parse_gem_ticks(body)
    assert gems[0] == GemTick(tick=0, frets=(0, 1), max_sustain=0, is_slide=False)
    assert gems[1] == GemTick(tick=192, frets=(2,), max_sustain=96, is_slide=False)
    assert gems[2] == GemTick(tick=384, frets=(3,), max_sustain=0, is_slide=True)


def test_section_metrics_counts_and_timing():
    # tick 0 chord(0,1); 192 single hold(2); 384 single(0); resolution 192 @120bpm
    body = '\n'.join([
        '  0 = N 0 0',
        '  0 = N 1 0',
        '  192 = N 2 96',
        '  384 = N 0 0',
    ])
    tm = [(0, 120.0)]
    m = section_metrics(body, 192, tm)
    assert m['total_gems'] == 4          # chord = 2 gems + 2 singles
    assert m['total_notes'] == 3         # 3 note-groups
    assert m['total_chords'] == 1
    assert m['total_holds'] == 1
    assert m['distinct_lanes'] == 3      # frets 0,1,2
    assert m['lane_lo'] == 0 and m['lane_hi'] == 2
    assert m['avg_chord_size'] == 2.0
    # duration = end of last note-group. tick 384 = 1.0s
    assert m['duration_s'] == 1.0
    assert m['gems_per_min'] == 240.0    # 4 gems / (1.0/60)


def test_section_metrics_returns_none_when_empty():
    assert section_metrics('\n  \n', 192, [(0, 120.0)]) is None


def test_section_metrics_min_gap_and_runs():
    # four 16th notes @120bpm: gap = 0.125s each (resolution/4 ticks = 48)
    body = '\n'.join(f'  {t} = N 0 0' for t in (0, 48, 96, 144))
    m = section_metrics(body, 192, [(0, 120.0)])
    assert round(m['min_gap_s'], 3) == 0.125
    assert m['longest_run'] == 4         # all gaps <= FAST_GAP_S (0.25)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest web/backend/tests/test_calibration_metrics.py -k "gem or section" -v`
Expected: FAIL — `ImportError: cannot import name 'GemTick'`.

- [ ] **Step 3: Write minimal implementation**

```python
# append to web/backend/app/services/calibration_metrics.py

FAST_GAP_S = 0.25
PEAK_WINDOW_S = 1.0
BEATS_PER_MEASURE = 4

_PLAYABLE = set(range(0, 5)) | {7}
_NOTE_RE = re.compile(r'(\d+)\s*=\s*[NR]\s+(\d+)\s+(\d+)')
_SLIDE_RE = re.compile(r'(\d+)\s*=\s*E\s+slide\s+(\d+)')

NUMERIC_METRICS = [
    'total_gems', 'total_notes', 'total_holds', 'total_chords', 'total_chord_holds',
    'total_slides', 'total_chord_slides', 'open_notes', 'hold_pct', 'chord_pct',
    'distinct_lanes', 'duration_s', 'gems_per_min', 'peak_nps', 'min_gap_s',
    'longest_run', 'avg_chord_size',
]


@dataclass
class GemTick:
    tick: int
    frets: tuple[int, ...]
    max_sustain: int
    is_slide: bool


def parse_gem_ticks(body: str) -> list[GemTick]:
    """One GemTick per tick carrying a playable hit, sorted by tick.

    Unions N/R note lines with E-slide lines so a slide-middle tick (which the
    chart writes as N + E slide) is a single gem, not two. Modifier frets
    (5, 6, and drum cymbal modifiers 66-68) are not playable gems — ignored.
    """
    frets_by_tick: dict[int, set[int]] = defaultdict(set)
    sustain_by_tick: dict[int, int] = defaultdict(int)
    slide_ticks: set[int] = set()
    for raw in body.split('\n'):
        line = raw.strip()
        if not line:
            continue
        m = _NOTE_RE.match(line)
        if m:
            tick, fret, sustain = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if fret in _PLAYABLE:
                frets_by_tick[tick].add(fret)
                if sustain > sustain_by_tick[tick]:
                    sustain_by_tick[tick] = sustain
            continue
        m = _SLIDE_RE.match(line)
        if m:
            tick, fret = int(m.group(1)), int(m.group(2))
            if fret in _PLAYABLE:
                frets_by_tick[tick].add(fret)
                slide_ticks.add(tick)
    out: list[GemTick] = []
    for tick in sorted(frets_by_tick):
        out.append(
            GemTick(
                tick=tick,
                frets=tuple(sorted(frets_by_tick[tick])),
                max_sustain=sustain_by_tick.get(tick, 0),
                is_slide=tick in slide_ticks,
            )
        )
    return out


def section_metrics(body: str, resolution: int, tempo_map: list[tuple[int, float]]) -> dict | None:
    """Compute every per-section calibration metric, or None if no gems."""
    gems = parse_gem_ticks(body)
    if not gems:
        return None

    singles = holds = chords = chord_holds = slides = chord_slides = 0
    open_normal = open_hold = open_slide = 0
    total_gems = 0
    chord_sizes: list[int] = []
    lanes: set[int] = set()

    for g in gems:
        colored = [f for f in g.frets if 0 <= f <= 4]
        total_gems += len(g.frets)
        lanes.update(colored)
        is_hold = g.max_sustain > 0
        has_open = 7 in g.frets
        if len(g.frets) >= 2:
            chord_sizes.append(len(g.frets))
        if has_open:
            if g.is_slide:
                open_slide += 1
            elif is_hold:
                open_hold += 1
            else:
                open_normal += 1
            continue
        if g.is_slide:
            if len(colored) == 2 and colored[1] - colored[0] == 1:
                chord_slides += 1
            else:
                slides += 1
            continue
        if len(colored) == 1:
            holds += 1 if is_hold else 0
            singles += 0 if is_hold else 1
        elif len(colored) == 2:
            chord_holds += 1 if is_hold else 0
            chords += 0 if is_hold else 1
        # 3+ colored frets: counted in total_gems only

    total_notes = len(gems)
    hold_count = holds + chord_holds + open_hold
    chord_count = chords + chord_holds + chord_slides
    open_notes = open_normal + open_hold + open_slide

    times = [tick_to_seconds(g.tick, tempo_map, resolution) for g in gems]
    end_times = [tick_to_seconds(g.tick + g.max_sustain, tempo_map, resolution) for g in gems]
    duration_s = max(end_times) if end_times else 0.0

    gems_per_min = (total_gems / (duration_s / 60.0)) if duration_s > 0 else 0.0

    # Peak density: max note-groups inside any PEAK_WINDOW_S window.
    peak_nps = 0
    busiest_tick = gems[0].tick
    for i in range(len(times)):
        count = 0
        j = i
        while j < len(times) and times[j] < times[i] + PEAK_WINDOW_S:
            count += 1
            j += 1
        if count > peak_nps:
            peak_nps = count
            busiest_tick = gems[i].tick
    busiest_measure = busiest_tick // (resolution * BEATS_PER_MEASURE) + 1

    gaps = [times[i + 1] - times[i] for i in range(len(times) - 1)]
    min_gap_s = min(gaps) if gaps else None

    longest_run = 1 if gems else 0
    run = 1
    for gap in gaps:
        if gap <= FAST_GAP_S:
            run += 1
            longest_run = max(longest_run, run)
        else:
            run = 1

    avg_chord_size = (sum(chord_sizes) / len(chord_sizes)) if chord_sizes else 0.0

    return {
        'total_gems': total_gems,
        'total_notes': total_notes,
        'total_holds': hold_count,
        'total_chords': chords,
        'total_chord_holds': chord_holds,
        'total_slides': slides,
        'total_chord_slides': chord_slides,
        'open_notes': open_notes,
        'hold_pct': round(100.0 * hold_count / total_notes, 1) if total_notes else 0.0,
        'chord_pct': round(100.0 * chord_count / total_notes, 1) if total_notes else 0.0,
        'lane_lo': min(lanes) if lanes else None,
        'lane_hi': max(lanes) if lanes else None,
        'distinct_lanes': len(lanes),
        'duration_s': round(duration_s, 2),
        'gems_per_min': round(gems_per_min, 1),
        'peak_nps': peak_nps,
        'busiest_measure': busiest_measure,
        'min_gap_s': round(min_gap_s, 3) if min_gap_s is not None else None,
        'longest_run': longest_run,
        'avg_chord_size': round(avg_chord_size, 2),
    }
```

Note: in `test_section_metrics_counts_and_timing` the `total_chords` value is 1 (the chord at tick 0); `chords` here means the count of 2-fret simultaneous note-groups, matching the existing `chart_analyser` convention.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest web/backend/tests/test_calibration_metrics.py -v`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add web/backend/app/services/calibration_metrics.py web/backend/tests/test_calibration_metrics.py
git commit -m "feat(calibration): gem parsing + per-section metrics"
```

---

## Task 3: Summary stats helper (pure)

**Files:**
- Modify: `web/backend/app/services/calibration_metrics.py`
- Test: `web/backend/tests/test_calibration_metrics.py`

**Interfaces:**
- Produces:
  - `summarize_rows(rows: list[dict]) -> dict[str, dict[str, dict]]` — keyed by difficulty tier (`Expert`/`Hard`/`Medium`/`Easy`), then by metric key (from `NUMERIC_METRICS` plus `pct_of_expert_gpm`), each value `{min, q1, median, q3, max, mean, count}`. `None` metric values are skipped; a metric with zero non-None values is omitted. Quartiles use linear interpolation (the same method as numpy's default).

- [ ] **Step 1: Write the failing test**

```python
# append to web/backend/tests/test_calibration_metrics.py
from app.services.calibration_metrics import summarize_rows


def test_summarize_rows_groups_by_tier_and_computes_quartiles():
    rows = [
        {'difficulty': 'Expert', 'gems_per_min': 100.0, 'min_gap_s': None},
        {'difficulty': 'Expert', 'gems_per_min': 200.0, 'min_gap_s': 0.2},
        {'difficulty': 'Expert', 'gems_per_min': 300.0, 'min_gap_s': 0.4},
        {'difficulty': 'Easy', 'gems_per_min': 50.0, 'min_gap_s': 1.0},
    ]
    s = summarize_rows(rows)
    assert s['Expert']['gems_per_min']['min'] == 100.0
    assert s['Expert']['gems_per_min']['max'] == 300.0
    assert s['Expert']['gems_per_min']['median'] == 200.0
    assert s['Expert']['gems_per_min']['mean'] == 200.0
    assert s['Expert']['gems_per_min']['count'] == 3
    # None values are skipped: only 2 of 3 Expert rows have min_gap_s
    assert s['Expert']['min_gap_s']['count'] == 2
    assert s['Easy']['gems_per_min']['count'] == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest web/backend/tests/test_calibration_metrics.py -k summarize -v`
Expected: FAIL — `ImportError: cannot import name 'summarize_rows'`.

- [ ] **Step 3: Write minimal implementation**

```python
# append to web/backend/app/services/calibration_metrics.py

_SUMMARY_TIERS = ('Expert', 'Hard', 'Medium', 'Easy')
_SUMMARY_METRICS = NUMERIC_METRICS + ['pct_of_expert_gpm']


def _quantile(sorted_vals: list[float], q: float) -> float:
    """Linear-interpolation quantile (matches numpy's default 'linear')."""
    if not sorted_vals:
        return 0.0
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    pos = q * (len(sorted_vals) - 1)
    lo = int(pos)
    frac = pos - lo
    if lo + 1 >= len(sorted_vals):
        return sorted_vals[lo]
    return sorted_vals[lo] + frac * (sorted_vals[lo + 1] - sorted_vals[lo])


def summarize_rows(rows: list[dict]) -> dict:
    """Per-tier min/q1/median/q3/max/mean/count for each numeric metric."""
    out: dict = {}
    for tier in _SUMMARY_TIERS:
        tier_rows = [r for r in rows if r.get('difficulty') == tier]
        if not tier_rows:
            continue
        metrics: dict = {}
        for key in _SUMMARY_METRICS:
            vals = sorted(
                float(r[key]) for r in tier_rows if r.get(key) is not None
            )
            if not vals:
                continue
            metrics[key] = {
                'min': vals[0],
                'q1': round(_quantile(vals, 0.25), 3),
                'median': round(_quantile(vals, 0.5), 3),
                'q3': round(_quantile(vals, 0.75), 3),
                'max': vals[-1],
                'mean': round(sum(vals) / len(vals), 3),
                'count': len(vals),
            }
        if metrics:
            out[tier] = metrics
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest web/backend/tests/test_calibration_metrics.py -v`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add web/backend/app/services/calibration_metrics.py web/backend/tests/test_calibration_metrics.py
git commit -m "feat(calibration): per-tier summary stats helper"
```

---

## Task 4: Calibration service (rows + cross-difficulty + summary)

**Files:**
- Create: `web/backend/app/services/calibration.py`
- Test: `web/backend/tests/test_calibration_service.py`

**Interfaces:**
- Consumes: `app.services.tracks.Track`, `app.services.chart_generator.chart_difficulties` and `_extract_section_body`; `calibration_metrics.build_tempo_map`, `section_metrics`, `summarize_rows`.
- Produces:
  - `DIFFICULTY_PREFIXES = ('Expert', 'Hard', 'Medium', 'Easy')`
  - `compute_calibration(track_ids: list[str]) -> dict` returning `{'rows': [...], 'summary': {...}, 'skipped': [...]}`.

Each **row** dict carries identity fields `track_id, song_name, artist, stem, instrument, beatmap_id, preset, difficulty, section` plus all `section_metrics` keys plus `pct_of_expert_gpm` (float % or `None`).
`difficulty` is the section prefix; `pct_of_expert_gpm` = this row's `gems_per_min` as a % of the Expert-tier row's `gems_per_min` within the **same (track, beatmap)**, or `None` when there is no Expert row or its gpm is 0.
Each **skipped** entry is `{'track_id', 'beatmap_id', 'reason'}`.

- [ ] **Step 1: Write the failing test**

```python
# web/backend/tests/test_calibration_service.py
from __future__ import annotations

import time

import pytest


@pytest.fixture
def two_tracks(tmp_path, monkeypatch):
    from app.config import settings
    from app.services import tracks as tracks_mod
    from app.services.tracks import Track

    upload_dir = tmp_path / 'uploads'
    tracks_dir = upload_dir / '_tracks'
    tracks_dir.mkdir(parents=True)
    monkeypatch.setattr(settings, 'upload_dir', str(upload_dir))
    monkeypatch.setattr(tracks_mod, 'TRACKS_DIR', tracks_dir)

    expert = '\n'.join(f'  {t} = N 0 0' for t in range(0, 192 * 8, 48))  # dense
    hard = '\n'.join(f'  {t} = N 0 0' for t in range(0, 192 * 8, 192))   # sparse
    chart = (
        '[Song]\n{\n  Name = "T"\n  Resolution = 192\n}\n'
        '[SyncTrack]\n{\n  0 = B 120000\n}\n'
        f'[ExpertSingle]\n{{\n{expert}\n}}\n'
        f'[HardSingle]\n{{\n{hard}\n}}\n'
    )

    t = Track(id='trk1', name='Song One', created_at=time.time(),
              stems={'guitar': 'guitar.ogg'}, artist='Artist A')
    # one included beatmap + one excluded beatmap (must be ignored)
    t.beatmaps = [
        {'id': 'bm_inc', 'stem': 'guitar', 'preset': 'v1', 'included': True, 'generated_at': 1.0},
        {'id': 'bm_exc', 'stem': 'guitar', 'preset': 'v2', 'included': False, 'generated_at': 2.0},
    ]
    t.save()
    for bid in ('bm_inc', 'bm_exc'):
        d = t.beatmaps_dir / bid
        d.mkdir(parents=True)
        (d / 'notes.chart').write_text(chart, encoding='utf-8')
    return ['trk1']


def test_compute_calibration_rows_only_included(two_tracks):
    from app.services.calibration import compute_calibration
    res = compute_calibration(two_tracks)
    beatmap_ids = {r['beatmap_id'] for r in res['rows']}
    assert beatmap_ids == {'bm_inc'}             # excluded beatmap dropped
    difficulties = {r['difficulty'] for r in res['rows']}
    assert difficulties == {'Expert', 'Hard'}
    assert all(r['instrument'] == 'Guitar' for r in res['rows'])


def test_compute_calibration_cross_difficulty_ratio(two_tracks):
    from app.services.calibration import compute_calibration
    res = compute_calibration(two_tracks)
    expert = next(r for r in res['rows'] if r['difficulty'] == 'Expert')
    hard = next(r for r in res['rows'] if r['difficulty'] == 'Hard')
    assert expert['pct_of_expert_gpm'] == 100.0
    assert hard['pct_of_expert_gpm'] < 100.0     # Hard is sparser


def test_compute_calibration_summary_present(two_tracks):
    from app.services.calibration import compute_calibration
    res = compute_calibration(two_tracks)
    assert 'Expert' in res['summary']
    assert 'gems_per_min' in res['summary']['Expert']


def test_compute_calibration_skips_missing_chart(two_tracks):
    from app.services.calibration import compute_calibration
    from app.services.tracks import Track
    (Track.load('trk1').beatmaps_dir / 'bm_inc' / 'notes.chart').unlink()
    res = compute_calibration(two_tracks)
    assert res['rows'] == []
    assert res['skipped'] and res['skipped'][0]['beatmap_id'] == 'bm_inc'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest web/backend/tests/test_calibration_service.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.calibration'`.

- [ ] **Step 3: Write minimal implementation**

```python
# web/backend/app/services/calibration.py
"""Difficulty-calibration service: walk selected tracks' included beatmaps and
produce a flat metric row per song x instrument x difficulty, plus per-tier
summary stats. Read-only; never mutates charts."""
from __future__ import annotations

from .calibration_metrics import build_tempo_map, section_metrics, summarize_rows
from .chart_generator import _extract_section_body, _read_resolution, chart_difficulties
from .tracks import Track

DIFFICULTY_PREFIXES = ('Expert', 'Hard', 'Medium', 'Easy')

# Stem -> display instrument label (mirrors the frontend STEM_LABELS spirit).
_INSTRUMENT = {
    'guitar': 'Guitar', 'bass': 'Bass', 'rhythm': 'Rhythm', 'drums': 'Drums',
    'piano': 'Keys', 'vocals': 'Vocals', 'other': 'Other', 'song': 'Song',
}


def _difficulty_of(section: str) -> str | None:
    for p in DIFFICULTY_PREFIXES:
        if section.startswith(p):
            return p
    return None


def compute_calibration(track_ids: list[str]) -> dict:
    rows: list[dict] = []
    skipped: list[dict] = []

    for track_id in track_ids:
        track = Track.load(track_id)
        if not track:
            skipped.append({'track_id': track_id, 'beatmap_id': '', 'reason': 'track not found'})
            continue
        song_name = track.name
        artist = track.artist

        for bm in track.beatmaps:
            if not bm.get('included', True):
                continue
            beatmap_id = bm.get('id', '')
            stem = bm.get('stem', '')
            chart_path = track.beatmaps_dir / beatmap_id / 'notes.chart'
            if not chart_path.exists():
                skipped.append({'track_id': track_id, 'beatmap_id': beatmap_id, 'reason': 'no notes.chart'})
                continue
            try:
                text = chart_path.read_text(encoding='utf-8', errors='replace')
            except OSError as exc:
                skipped.append({'track_id': track_id, 'beatmap_id': beatmap_id, 'reason': f'read error: {exc}'})
                continue

            resolution = _read_resolution(text) or 192
            tempo_map = build_tempo_map(text)

            # rows produced for this single beatmap, so we can compute the
            # cross-difficulty ratio against its own Expert tier.
            bm_rows: list[dict] = []
            for diff in chart_difficulties(text):
                section = diff['name']
                difficulty = _difficulty_of(section)
                if difficulty is None:
                    continue
                body = _extract_section_body(text, section)
                if body is None:
                    continue
                metrics = section_metrics(body, resolution, tempo_map)
                if metrics is None:
                    continue
                row = {
                    'track_id': track_id,
                    'song_name': song_name,
                    'artist': artist,
                    'stem': stem,
                    'instrument': _INSTRUMENT.get(stem, stem.title() if stem else 'Unknown'),
                    'beatmap_id': beatmap_id,
                    'preset': bm.get('preset'),
                    'difficulty': difficulty,
                    'section': section,
                    'pct_of_expert_gpm': None,
                    **metrics,
                }
                bm_rows.append(row)

            # Cross-difficulty ratio anchored to this beatmap's Expert tier.
            expert = next((r for r in bm_rows if r['difficulty'] == 'Expert'), None)
            expert_gpm = expert['gems_per_min'] if expert else 0.0
            if expert_gpm > 0:
                for r in bm_rows:
                    r['pct_of_expert_gpm'] = round(100.0 * r['gems_per_min'] / expert_gpm, 1)
            rows.extend(bm_rows)

    return {'rows': rows, 'summary': summarize_rows(rows), 'skipped': skipped}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest web/backend/tests/test_calibration_service.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/backend/app/services/calibration.py web/backend/tests/test_calibration_service.py
git commit -m "feat(calibration): rows + cross-difficulty ratios + summary service"
```

---

## Task 5: Calibration router + mount

**Files:**
- Create: `web/backend/app/routers/calibration.py`
- Modify: `web/backend/app/main.py` (import list lines 17-39; mount block lines 78-96)
- Test: `web/backend/tests/test_calibration_endpoint.py`

**Interfaces:**
- Consumes: `app.services.calibration.compute_calibration`.
- Produces: `POST /api/calibration/compare` with body `{"track_ids": ["..."]}` → `200` `{rows, summary, skipped}`. Empty `track_ids` ⇒ `{rows: [], summary: {}, skipped: []}`.

- [ ] **Step 1: Write the failing test**

```python
# web/backend/tests/test_calibration_endpoint.py
from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _bypass_auth():
    from app.main import app
    from app.routers.auth import require_auth
    app.dependency_overrides[require_auth] = lambda: None
    yield
    app.dependency_overrides.pop(require_auth, None)


@pytest.fixture
def client(tmp_path, monkeypatch):
    from app.config import settings
    from app.services import tracks as tracks_mod
    from app.services.tracks import Track

    upload_dir = tmp_path / 'uploads'
    tracks_dir = upload_dir / '_tracks'
    tracks_dir.mkdir(parents=True)
    monkeypatch.setattr(settings, 'upload_dir', str(upload_dir))
    monkeypatch.setattr(tracks_mod, 'TRACKS_DIR', tracks_dir)

    chart = (
        '[Song]\n{\n  Name = "T"\n  Resolution = 192\n}\n'
        '[SyncTrack]\n{\n  0 = B 120000\n}\n'
        '[ExpertSingle]\n{\n  0 = N 0 0\n  192 = N 1 0\n}\n'
    )
    t = Track(id='trk1', name='Song One', created_at=time.time(), stems={'guitar': 'g.ogg'})
    t.beatmaps = [{'id': 'bm1', 'stem': 'guitar', 'included': True, 'generated_at': 1.0}]
    t.save()
    d = t.beatmaps_dir / 'bm1'
    d.mkdir(parents=True)
    (d / 'notes.chart').write_text(chart, encoding='utf-8')

    from app.main import app
    with TestClient(app) as c:
        yield c


def test_compare_returns_rows(client):
    r = client.post('/api/calibration/compare', json={'track_ids': ['trk1']})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body['rows']) == 1
    assert body['rows'][0]['section'] == 'ExpertSingle'
    assert 'summary' in body and 'skipped' in body


def test_compare_empty_track_ids(client):
    r = client.post('/api/calibration/compare', json={'track_ids': []})
    assert r.status_code == 200, r.text
    assert r.json() == {'rows': [], 'summary': {}, 'skipped': []}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest web/backend/tests/test_calibration_endpoint.py -v`
Expected: FAIL — 404 on `/api/calibration/compare` (router not mounted).

- [ ] **Step 3: Write minimal implementation**

Create the router:

```python
# web/backend/app/routers/calibration.py
"""Chart difficulty calibration — compare metrics across selected tracks."""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..services.calibration import compute_calibration

router = APIRouter(prefix='/api/calibration', tags=['calibration'])


class CompareRequest(BaseModel):
    track_ids: list[str] = Field(default_factory=list, max_length=2000)


@router.post('/compare')
def compare(req: CompareRequest) -> dict:
    return compute_calibration(req.track_ids)
```

Add to the router import block in `web/backend/app/main.py` (keep alphabetical order — insert `calibration` right after `beatmap`):

```python
from .routers import (
    auth,
    beatmap,
    calibration,
    elevenlabs,
    feedback,
    ...
)
```

Mount it alongside the other auth-protected routers (after the `beatmap` line at ~78):

```python
app.include_router(beatmap.router, dependencies=_auth_dep)
app.include_router(calibration.router, dependencies=_auth_dep)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest web/backend/tests/test_calibration_endpoint.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full calibration backend suite + commit**

Run: `pytest web/backend/tests/test_calibration_metrics.py web/backend/tests/test_calibration_service.py web/backend/tests/test_calibration_endpoint.py -v`
Expected: PASS (all).

```bash
git add web/backend/app/routers/calibration.py web/backend/app/main.py web/backend/tests/test_calibration_endpoint.py
git commit -m "feat(calibration): POST /api/calibration/compare endpoint"
```

---

## Task 6: Library selection UI + Compare button

**Files:**
- Modify: `web/frontend/src/pages/TracksPage.tsx`
  - state hooks block (~line 1069)
  - track-list `.map` row (~lines 2378-2438)
  - return wrapper header (~line 2258)

**Interfaces:**
- Consumes: existing `tracks` state, `useNavigate`.
- Produces: navigation to `/compare` carrying `{ trackIds: string[] }` in router state, with `?ids=<comma-joined>` query fallback so the page is reloadable.

This task has no unit-test harness on the frontend; the gate is a clean `npm run build` (tsc typecheck) plus a manual smoke check.

- [ ] **Step 1: Add selection state**

In `TracksPageInner` after the `confirmDelete` state (~line 1069), add:

```tsx
  const [selectedForCompare, setSelectedForCompare] = useState<Set<string>>(new Set())
  const toggleCompare = useCallback((id: string) => {
    setSelectedForCompare((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
```

- [ ] **Step 2: Add a checkbox to each track row**

In the track-list `.map` (the `<div key={track.id} ...>` row at ~line 2384), insert a checkbox as the first child of the inner `flex items-center gap-3 min-w-0` div (before the album-art div at ~line 2399). The `stopPropagation` keeps the row's `onClick={() => setSelectedId(track.id)}` from firing when the box is clicked:

```tsx
                  <input
                    type="checkbox"
                    checked={selectedForCompare.has(track.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleCompare(track.id)}
                    aria-label={`Select ${track.name} for compare`}
                    className="w-4 h-4 shrink-0 accent-jam-500 cursor-pointer"
                  />
```

- [ ] **Step 3: Add select-all + Compare button to the header**

Replace the header `<div>` block (the one containing `<h1>Studio Library</h1>`, ~lines 2259-2266) with a version that adds a select-all control and a Compare button. `allTrackIds`/`allSelected` derive from current `tracks`:

```tsx
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Studio Library</h1>
          <p className="text-gray-500 mt-1">
            Tracks in progress and finished maps. Click any track to edit metadata, generate beatmaps, or publish.
            {' '}
            <Link to="/create" className="text-jam-300 hover:text-jam-200">+ Create a new track →</Link>
          </p>
        </div>
        {tracks.length > 0 && (
          <div className="flex items-center gap-3 shrink-0">
            <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                className="w-4 h-4 accent-jam-500 cursor-pointer"
                checked={tracks.length > 0 && tracks.every((t) => selectedForCompare.has(t.id))}
                onChange={(e) =>
                  setSelectedForCompare(e.target.checked ? new Set(tracks.map((t) => t.id)) : new Set())
                }
              />
              Select all
            </label>
            <button
              type="button"
              disabled={selectedForCompare.size === 0}
              onClick={() => {
                const ids = tracks.map((t) => t.id).filter((id) => selectedForCompare.has(id))
                navigate(`/compare?ids=${ids.join(',')}`, { state: { trackIds: ids } })
              }}
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-jam-600/20 text-jam-300 hover:bg-jam-600/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Compare{selectedForCompare.size > 0 ? ` (${selectedForCompare.size})` : ''}
            </button>
          </div>
        )}
      </div>
```

- [ ] **Step 4: Typecheck**

Run (from `web/frontend/`): `npm run build`
Expected: build succeeds, no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add web/frontend/src/pages/TracksPage.tsx
git commit -m "feat(calibration): multi-select + Compare button on Studio Library"
```

---

## Task 7: CalibrationPage (table, sort, filter, summary, outliers, export)

**Files:**
- Create: `web/frontend/src/pages/CalibrationPage.tsx`
- Modify: `web/frontend/src/App.tsx` (special-case `/compare` like `/edit/`, ~lines 47-66, and the route block ~lines 139-149)

**Interfaces:**
- Consumes: `POST /api/calibration/compare`; selected ids via router `location.state.trackIds` with `?ids=` query fallback; `STEM_LABELS` from `../components/stemDisplay` for instrument labels (optional — backend already provides `instrument`).
- Produces: a route component `CalibrationPage`.

Gate: clean `npm run build` + manual smoke.

- [ ] **Step 1: Special-case the `/compare` route for full width in `App.tsx`**

The default layout caps content at `max-w-5xl`, which is too narrow for the wide table. Add this block right after the `/edit-vocals/` block (~line 66), before the final `return`:

```tsx
  if (location.pathname.startsWith('/compare')) {
    return (
      <>
        <UpdateNudge />
        <Routes>
          <Route path="/compare" element={<CalibrationPage />} />
        </Routes>
      </>
    )
  }
```

And add the import near the other page imports (~line 10):

```tsx
import CalibrationPage from './pages/CalibrationPage.tsx'
```

- [ ] **Step 2: Create the page component**

```tsx
// web/frontend/src/pages/CalibrationPage.tsx
import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'

interface Row {
  track_id: string
  song_name: string
  artist: string
  stem: string
  instrument: string
  beatmap_id: string
  preset: string | null
  difficulty: string
  section: string
  pct_of_expert_gpm: number | null
  total_gems: number
  total_notes: number
  total_holds: number
  total_chords: number
  total_chord_holds: number
  total_slides: number
  total_chord_slides: number
  open_notes: number
  hold_pct: number
  chord_pct: number
  lane_lo: number | null
  lane_hi: number | null
  distinct_lanes: number
  duration_s: number
  gems_per_min: number
  peak_nps: number
  busiest_measure: number
  min_gap_s: number | null
  longest_run: number
  avg_chord_size: number
}

type MetricSummary = { min: number; q1: number; median: number; q3: number; max: number; mean: number; count: number }
type Summary = Record<string, Record<string, MetricSummary>>

interface CompareResponse {
  rows: Row[]
  summary: Summary
  skipped: { track_id: string; beatmap_id: string; reason: string }[]
}

const DIFFICULTY_ORDER = ['Expert', 'Hard', 'Medium', 'Easy']

// Columns: [key, header, formatter]. Numeric keys also drive sort + outliers.
const COLUMNS: { key: keyof Row; label: string; numeric: boolean; fmt?: (r: Row) => string }[] = [
  { key: 'song_name', label: 'Song', numeric: false, fmt: (r) => (r.artist ? `${r.artist} — ${r.song_name}` : r.song_name) },
  { key: 'instrument', label: 'Instrument', numeric: false },
  { key: 'difficulty', label: 'Difficulty', numeric: false },
  { key: 'total_gems', label: 'Gems', numeric: true },
  { key: 'gems_per_min', label: 'Gems/min', numeric: true },
  { key: 'pct_of_expert_gpm', label: '% of Expert', numeric: true, fmt: (r) => (r.pct_of_expert_gpm == null ? '—' : `${r.pct_of_expert_gpm}%`) },
  { key: 'peak_nps', label: 'Peak NPS', numeric: true },
  { key: 'busiest_measure', label: 'Busy bar', numeric: false },
  { key: 'total_notes', label: 'Notes', numeric: true },
  { key: 'total_holds', label: 'Holds', numeric: true },
  { key: 'total_chords', label: 'Chords', numeric: true },
  { key: 'total_chord_holds', label: 'Chord holds', numeric: true },
  { key: 'total_slides', label: 'Slides', numeric: true },
  { key: 'total_chord_slides', label: 'Slide chords', numeric: true },
  { key: 'open_notes', label: 'Opens', numeric: true },
  { key: 'avg_chord_size', label: 'Avg chord', numeric: true },
  { key: 'hold_pct', label: 'Hold %', numeric: true },
  { key: 'chord_pct', label: 'Chord %', numeric: true },
  { key: 'distinct_lanes', label: 'Lanes', numeric: true },
  { key: 'lane_lo', label: 'Range', numeric: false, fmt: (r) => (r.lane_lo == null ? '—' : `${r.lane_lo}–${r.lane_hi}`) },
  { key: 'min_gap_s', label: 'Min gap (s)', numeric: true, fmt: (r) => (r.min_gap_s == null ? '—' : r.min_gap_s.toFixed(3)) },
  { key: 'longest_run', label: 'Run', numeric: true },
  { key: 'duration_s', label: 'Dur (s)', numeric: true },
]

// Outlier: cell value vs its difficulty tier's IQR fence. Needs >=4 samples.
function outlierClass(row: Row, key: keyof Row, summary: Summary): string {
  const tier = summary[row.difficulty]
  const s = tier?.[key as string]
  const v = row[key]
  if (!s || s.count < 4 || typeof v !== 'number') return ''
  const iqr = s.q3 - s.q1
  if (iqr <= 0) return ''
  if (v > s.q3 + 1.5 * iqr) return 'bg-red-900/40 text-red-200'
  if (v < s.q1 - 1.5 * iqr) return 'bg-amber-900/30 text-amber-200'
  return ''
}

function fmtCell(r: Row, col: (typeof COLUMNS)[number]): string {
  if (col.fmt) return col.fmt(r)
  const v = r[col.key]
  return v == null ? '—' : String(v)
}

export default function CalibrationPage() {
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const stateIds = (location.state as { trackIds?: string[] } | null)?.trackIds
  const queryIds = (searchParams.get('ids') || '').split(',').filter(Boolean)
  const trackIds = stateIds && stateIds.length ? stateIds : queryIds

  const [data, setData] = useState<CompareResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sortKey, setSortKey] = useState<keyof Row>('gems_per_min')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [instrumentFilter, setInstrumentFilter] = useState<string>('')
  const [difficultyFilter, setDifficultyFilter] = useState<string>('')

  useEffect(() => {
    if (!trackIds.length) {
      setError('No tracks selected.')
      setLoading(false)
      return
    }
    setLoading(true)
    fetch('/api/calibration/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ track_ids: trackIds }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((d: CompareResponse) => setData(d))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackIds.join(',')])

  const instruments = useMemo(
    () => Array.from(new Set((data?.rows || []).map((r) => r.instrument))).sort(),
    [data],
  )

  const rows = useMemo(() => {
    let rs = data?.rows || []
    if (instrumentFilter) rs = rs.filter((r) => r.instrument === instrumentFilter)
    if (difficultyFilter) rs = rs.filter((r) => r.difficulty === difficultyFilter)
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rs].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv)) * dir
    })
  }, [data, instrumentFilter, difficultyFilter, sortKey, sortDir])

  function setSort(key: keyof Row) {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  function toTSV(): string {
    const header = COLUMNS.map((c) => c.label).join('\t')
    const body = rows.map((r) => COLUMNS.map((c) => fmtCell(r, c)).join('\t')).join('\n')
    return `${header}\n${body}`
  }

  function copyTSV() {
    navigator.clipboard.writeText(toTSV()).catch(() => {})
  }

  function downloadCSV() {
    const csv = [
      COLUMNS.map((c) => `"${c.label}"`).join(','),
      ...rows.map((r) => COLUMNS.map((c) => `"${fmtCell(r, c).replace(/"/g, '""')}"`).join(',')),
    ].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'calibration.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200 p-6 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Difficulty Calibration</h1>
          <p className="text-gray-500 text-sm mt-1">
            {rows.length} chart{rows.length === 1 ? '' : 's'} across {trackIds.length} song
            {trackIds.length === 1 ? '' : 's'}. Cells far outside their difficulty tier are highlighted.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={copyTSV} className="px-3 py-1.5 rounded-md text-sm bg-gray-800 hover:bg-gray-700">Copy TSV</button>
          <button onClick={downloadCSV} className="px-3 py-1.5 rounded-md text-sm bg-gray-800 hover:bg-gray-700">Download CSV</button>
          <Link to="/" className="px-3 py-1.5 rounded-md text-sm bg-gray-800 hover:bg-gray-700">← Library</Link>
        </div>
      </div>

      <div className="flex items-center gap-3 text-sm">
        <select
          value={instrumentFilter}
          onChange={(e) => setInstrumentFilter(e.target.value)}
          className="bg-gray-900 border border-gray-800 rounded-md px-2 py-1"
        >
          <option value="">All instruments</option>
          {instruments.map((i) => (<option key={i} value={i}>{i}</option>))}
        </select>
        <select
          value={difficultyFilter}
          onChange={(e) => setDifficultyFilter(e.target.value)}
          className="bg-gray-900 border border-gray-800 rounded-md px-2 py-1"
        >
          <option value="">All difficulties</option>
          {DIFFICULTY_ORDER.map((d) => (<option key={d} value={d}>{d}</option>))}
        </select>
      </div>

      {loading && <p className="text-gray-400">Loading…</p>}
      {error && <p className="text-red-400">{error}</p>}

      {data && !loading && (
        <>
          <div className="overflow-x-auto border border-gray-800 rounded-lg">
            <table className="text-xs whitespace-nowrap w-full">
              <thead className="bg-gray-900 sticky top-0">
                <tr>
                  {COLUMNS.map((c) => (
                    <th
                      key={String(c.key)}
                      onClick={() => setSort(c.key)}
                      className="px-2 py-2 text-left font-semibold cursor-pointer hover:text-jam-300 border-b border-gray-800"
                    >
                      {c.label}{sortKey === c.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.beatmap_id}-${r.section}-${i}`} className="odd:bg-gray-900/40 hover:bg-gray-800/40">
                    {COLUMNS.map((c) => (
                      <td key={String(c.key)} className={`px-2 py-1 ${c.numeric ? outlierClass(r, c.key, data.summary) : ''}`}>
                        {fmtCell(r, c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <SummaryTables summary={data.summary} />

          {data.skipped.length > 0 && (
            <p className="text-amber-400/80 text-xs">
              {data.skipped.length} beatmap(s) couldn't be analyzed (missing/unreadable chart).
            </p>
          )}
        </>
      )}
    </div>
  )
}

// Per-difficulty summary (median / min / max) for the key calibration metrics.
function SummaryTables({ summary }: { summary: Summary }) {
  const metricKeys: { key: string; label: string }[] = [
    { key: 'gems_per_min', label: 'Gems/min' },
    { key: 'peak_nps', label: 'Peak NPS' },
    { key: 'avg_chord_size', label: 'Avg chord' },
    { key: 'hold_pct', label: 'Hold %' },
    { key: 'min_gap_s', label: 'Min gap (s)' },
    { key: 'distinct_lanes', label: 'Lanes' },
  ]
  const tiers = DIFFICULTY_ORDER.filter((t) => summary[t])
  if (!tiers.length) return null
  return (
    <div className="space-y-2">
      <h2 className="text-lg font-semibold">Per-difficulty baselines (median · min–max)</h2>
      <div className="overflow-x-auto border border-gray-800 rounded-lg">
        <table className="text-xs w-full">
          <thead className="bg-gray-900">
            <tr>
              <th className="px-2 py-2 text-left border-b border-gray-800">Tier</th>
              {metricKeys.map((m) => (<th key={m.key} className="px-2 py-2 text-left border-b border-gray-800">{m.label}</th>))}
            </tr>
          </thead>
          <tbody>
            {tiers.map((t) => (
              <tr key={t} className="odd:bg-gray-900/40">
                <td className="px-2 py-1 font-medium">{t}</td>
                {metricKeys.map((m) => {
                  const s = summary[t][m.key]
                  return (
                    <td key={m.key} className="px-2 py-1">
                      {s ? `${s.median} · ${s.min}–${s.max}` : '—'}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Typecheck**

Run (from `web/frontend/`): `npm run build`
Expected: build succeeds, no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add web/frontend/src/pages/CalibrationPage.tsx web/frontend/src/App.tsx
git commit -m "feat(calibration): Compare screen with table, summary, outliers, export"
```

---

## Task 8: End-to-end manual verification

**Files:** none (verification only).

- [ ] **Step 1: Start backend + frontend**

Backend (from `web/backend/`): `venv/Scripts/python.exe run.py`
Frontend (from `web/frontend/`): `npm run dev`

- [ ] **Step 2: Smoke the flow**

1. Open the Studio Library, tick 2–3 songs that have published/included beatmaps, click **Compare (N)**.
2. Confirm the table shows one row per `song × instrument × difficulty`, with gems, gems/min, peak NPS, holds, chords, slide chords, lane range populated.
3. Click a numeric column header — confirm sort toggles; change the instrument/difficulty filters — confirm rows filter.
4. Confirm the per-difficulty baseline table renders and that any extreme cell is color-highlighted.
5. Click **Copy TSV** and paste into a spreadsheet; click **Download CSV** and confirm the file opens.
6. Reload `/compare?ids=...` directly — confirm it still loads (query-param fallback).

- [ ] **Step 3: Run the full backend suite once more**

Run: `pytest web/backend/tests/test_calibration_metrics.py web/backend/tests/test_calibration_service.py web/backend/tests/test_calibration_endpoint.py -v`
Expected: all PASS.

---

## Self-Review Notes (already addressed)

- **Spec coverage:** table shape (song×instrument×difficulty) → Task 4 rows + Task 7 table; included-only → Task 4; all basic + 4 advanced metrics → Task 2; cross-difficulty ratio → Task 4; summary + outliers + sort/filter + export → Task 7; selection + Compare → Task 6; tempo-map timing → Task 1; error handling/skipped → Task 4 + Task 7.
- **Type consistency:** `section_metrics` keys (Task 2) ⊆ `Row` interface (Task 7) and `NUMERIC_METRICS`/`summarize_rows` (Tasks 2–3); `compute_calibration` return shape matches the router (Task 5) and `CompareResponse` (Task 7).
- **Decisions locked:** instrument from stem; ratio anchored to Expert within the same beatmap; outliers median±1.5×IQR with a ≥4-sample floor; zero-note sections omitted (`section_metrics` returns `None`).
