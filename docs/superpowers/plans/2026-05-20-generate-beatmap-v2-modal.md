# Generate Beatmap modal — V2 pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the "Generate Beatmap" modal (`BeatmapPanel` in `TracksPage.tsx`) to drive the existing V2 staged pipeline through a new orchestration endpoint, exposing 5 engine dropdowns + a handful of numeric knobs in a new "Generation" section.

**Architecture:** Refactor first — extract a pure `run_stage()` helper out of the existing per-stage subrouter so both per-stage POST handlers and the new orchestrator share one implementation. Extract `write_chart_song_ini()` and `ParamControl` likewise. Then add the V2 orchestration endpoint that calls those helpers in sequence and writes the same on-disk artifacts the legacy `generate_full_chart` produces. Finally, update the modal to fetch the engines catalog, render the generation section, and POST to the new endpoint (with a fallback to the legacy endpoint for the drums stem).

**Tech Stack:** FastAPI (Python), pydantic, asyncio; React 18 + TypeScript + Vite (frontend). Existing V2 pipeline lives in `web/backend/app/services/pipeline/` with engine registry + per-stage helpers.

**Spec:** `docs/superpowers/specs/2026-05-20-generate-beatmap-v2-modal-design.md`

**Reference — engine IDs that exist today (verified by reading registry):**

| Stage           | Engine IDs                                                |
|-----------------|-----------------------------------------------------------|
| `grid`          | `librosa-beat`, `manual`, `all-in-one`                    |
| `onsets`        | `librosa-onset`, `aubio-complex`, `basic-pitch`           |
| `pitches`       | `yin`, `crepe`, `basic-pitch`, `passthrough`              |
| `quantized`     | `nearest-grid`, `strong-beat-priority`, `metric-weighted` |
| `lanes_expert`  | `section-sliding`, `global-percentile`, `key-relative`    |
| `lanes_filtered`| `identity`, `spread-fretboard`, `avoid-cramps`, `chain`   |
| `lanes_hard/medium/easy` | `metric-weight`, `density-target`, `none`        |

---

## File Structure

**Created files**
- `web/backend/app/services/pipeline/runner.py` — pure `run_stage(stage, track_dir, stem, engine_id, params, on_progress)` helper.
- `web/backend/tests/test_pipeline_runner.py` — unit tests for the helper.
- `web/backend/tests/test_write_chart_song_ini.py` — unit test for the extracted ini helper.
- `web/backend/tests/test_generate_beatmap_v2.py` — integration test for the new endpoint.
- `web/frontend/src/components/pipeline/ParamControl.tsx` — extracted shared component.

**Modified files**
- `web/backend/app/services/chart_generator.py` — extract `write_chart_song_ini()` as a public helper; call it from `generate_full_chart`.
- `web/backend/app/routers/pipeline.py` — `_make_stage_subrouter` calls the new `run_stage` helper instead of inlining the run loop.
- `web/backend/app/routers/tracks.py` — add `POST /api/tracks/{track_id}/generate-beatmap-v2` endpoint.
- `web/frontend/src/components/pipeline/StageCard.tsx` — import `ParamControl` from the new file instead of defining it inline.
- `web/frontend/src/pages/TracksPage.tsx` — add GENERATION section to `BeatmapPanel`, fetch engines catalog, wire submit to new endpoint with drums fallback.
- `web/frontend/src/api/pipelineClient.ts` — if needed, add a `generateBeatmapV2()` helper that POSTs the form.

---

## Task 1: Extract `run_stage()` helper (with tests)

**Files:**
- Create: `web/backend/app/services/pipeline/runner.py`
- Create: `web/backend/tests/test_pipeline_runner.py`

- [ ] **Step 1: Write the failing test**

```python
# web/backend/tests/test_pipeline_runner.py
"""Unit tests for the extracted run_stage helper."""
from __future__ import annotations

from pathlib import Path

import pytest

from app.services.pipeline.registry import EngineSpec, Stage, register_engine, _REGISTRY
from app.services.pipeline.runner import run_stage


@pytest.fixture
def fake_track_dir(tmp_path):
    td = tmp_path / 'track'
    td.mkdir()
    (td / 'stems' / 'guitar').mkdir(parents=True)
    return td


def test_run_stage_writes_active_file_and_updates_state(fake_track_dir):
    progress = []

    def fake_runner(audio_path, upstream, params, on_progress):
        on_progress('step', 50, 'halfway')
        return {'beats': [{'tick': 0}], 'resolution': 192,
                'tempo_segments': [{'tick_start': 0, 'micro_bpm': 120000}]}

    register_engine(Stage.GRID, EngineSpec(
        id='__test_runner__', display_name='test', params_schema={}, runner=fake_runner,
    ))
    try:
        result = run_stage(
            stage=Stage.GRID,
            track_dir=fake_track_dir,
            stem=None,
            engine_id='__test_runner__',
            params={},
            on_progress=lambda step, pct, msg: progress.append((step, pct, msg)),
        )
    finally:
        _REGISTRY[Stage.GRID] = {k: v for k, v in _REGISTRY[Stage.GRID].items()
                                  if k != '__test_runner__'}

    # Active file exists and contains payload
    from app.services.pipeline.storage import stage_path
    active = stage_path(fake_track_dir, Stage.GRID, None)
    assert active.exists()
    import json as _json
    body = _json.loads(active.read_text())
    assert body['engine'] == '__test_runner__'
    assert body['beats'] == [{'tick': 0}]

    # State reflects the run
    from app.services.pipeline.state import load_pipeline_state
    state = load_pipeline_state(fake_track_dir)
    assert state.grid is not None
    assert state.grid.engine == '__test_runner__'
    assert state.grid.stale is False

    # Progress callback was invoked
    assert ('step', 50, 'halfway') in progress

    # Return value mirrors the persisted payload
    assert result['engine'] == '__test_runner__'


def test_run_stage_requires_stem_for_non_grid(fake_track_dir):
    with pytest.raises(ValueError, match='stem'):
        run_stage(
            stage=Stage.ONSETS, track_dir=fake_track_dir, stem=None,
            engine_id='librosa-onset', params={}, on_progress=lambda *_: None,
        )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest web/backend/tests/test_pipeline_runner.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.pipeline.runner'`

- [ ] **Step 3: Implement `run_stage()`**

Create `web/backend/app/services/pipeline/runner.py`:

```python
"""Pure stage runner shared by the per-stage HTTP endpoints and the
top-level generate-beatmap-v2 orchestrator. Loads upstream JSONs from
disk, invokes the engine, writes the result back as a new active
version, and updates pipeline_state.json. No FastAPI or async deps."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

from .registry import Stage, get_engine
from .state import (
    StageState,
    StemState,
    load_pipeline_state,
    mark_downstream_stale,
    save_pipeline_state,
)
from .storage import (
    list_versions,
    save_version_and_activate,
    stage_path,
)


_TRACK_LEVEL_STAGES = {Stage.GRID}
_S7_STAGES = {Stage.LANES_HARD, Stage.LANES_MEDIUM, Stage.LANES_EASY}


def _gather_upstream(track_dir: Path, stage: Stage, stem: str | None) -> dict[str, dict]:
    if stage == Stage.GRID:
        return {}
    upstream: dict[str, dict] = {}
    grid_p = stage_path(track_dir, Stage.GRID, None)
    if grid_p.exists():
        upstream['grid'] = json.loads(grid_p.read_text())
    if stem is None:
        return upstream
    from ...routers.pipeline_order import upstream_for
    for s in upstream_for(stage):
        p = stage_path(track_dir, s, stem)
        if p.exists():
            upstream[s.value] = json.loads(p.read_text())
    return upstream


def _audio_path_for(track_dir: Path, stage: Stage, stem: str | None) -> Path | None:
    if stage == Stage.GRID:
        for cand in ['song.ogg', 'song.wav', 'mix.ogg', 'mix.wav']:
            p = track_dir / cand
            if p.exists():
                return p
        return None
    if stem is None:
        return None
    sdir = track_dir / 'stems' / stem
    candidates = list(sdir.glob('*.ogg')) + list(sdir.glob('*.wav'))
    return candidates[0] if candidates else None


def _update_state_after_run(
    track_dir: Path,
    stage: Stage,
    stem: str | None,
    engine_id: str,
) -> None:
    state = load_pipeline_state(track_dir)
    new_state = StageState(active_version=None, engine=engine_id, stale=False)
    versions = list_versions(track_dir, stage, stem)
    if versions:
        new_state.active_version = versions[0]['filename']
    if stage == Stage.GRID:
        state.grid = new_state
    else:
        if stem is None:
            raise ValueError('stem required for non-grid stage')
        ss = state.stems.setdefault(stem, StemState())
        setattr(ss, stage.value, new_state)
    save_pipeline_state(track_dir, state)


def run_stage(
    stage: Stage,
    track_dir: Path,
    stem: str | None,
    engine_id: str,
    params: dict[str, Any],
    on_progress: Callable[[str, int, str], None],
) -> dict[str, Any]:
    """Synchronously run one pipeline stage. Returns the persisted payload.

    S7 stages (lanes_hard / lanes_medium / lanes_easy) return
    {'by_difficulty': {...}}; this helper splits and writes each
    sub-stage's active file. The returned dict in that case is the
    original by_difficulty payload — callers usually don't need it.
    """
    if stage not in _TRACK_LEVEL_STAGES and stem is None:
        raise ValueError(f'stem required for non-grid stage {stage.value!r}')

    spec = get_engine(stage, engine_id)

    upstream = _gather_upstream(track_dir, stage, stem)
    payload = spec.runner(
        audio_path=_audio_path_for(track_dir, stage, stem),
        upstream=upstream,
        params=params,
        on_progress=on_progress,
    )
    payload.setdefault('engine', engine_id)
    payload.setdefault('params', params)
    import datetime as _dt
    payload.setdefault(
        'generated_at',
        _dt.datetime.now(_dt.UTC).isoformat().replace('+00:00', 'Z'),
    )

    if stage in _S7_STAGES and 'by_difficulty' in payload:
        bd = payload['by_difficulty']
        for diff_key, diff_stage in (
            ('hard', Stage.LANES_HARD),
            ('medium', Stage.LANES_MEDIUM),
            ('easy', Stage.LANES_EASY),
        ):
            if diff_key in bd:
                diff_payload = dict(bd[diff_key])
                diff_payload.setdefault('engine', engine_id)
                diff_payload.setdefault('params', params)
                save_version_and_activate(track_dir, diff_stage, stem, diff_payload)
                _update_state_after_run(track_dir, diff_stage, stem, engine_id)
        mark_downstream_stale(track_dir, changed_stage=stage, stem=stem)
        return payload

    save_version_and_activate(track_dir, stage, stem, payload)
    _update_state_after_run(track_dir, stage, stem, engine_id)
    mark_downstream_stale(track_dir, changed_stage=stage, stem=stem)
    return payload
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest web/backend/tests/test_pipeline_runner.py -v`
Expected: PASS (both tests)

- [ ] **Step 5: Commit**

```bash
git add web/backend/app/services/pipeline/runner.py web/backend/tests/test_pipeline_runner.py
git commit -m "feat(pipeline): extract pure run_stage helper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Refactor `_make_stage_subrouter` to call `run_stage`

**Files:**
- Modify: `web/backend/app/routers/pipeline.py:101-202` (the `_make_stage_subrouter` factory's POST handler), and the helpers `_gather_upstream` / `_audio_path_for` / `_update_state_after_run` defined later in the same file.

- [ ] **Step 1: Run existing tests to capture baseline**

Run: `pytest web/backend/tests/test_pipeline_router_basics.py web/backend/tests/test_pipeline_phase3_e2e.py -v`
Expected: PASS (these will be the safety net for the refactor)

- [ ] **Step 2: Replace the POST handler body with a call to `run_stage`**

In `web/backend/app/routers/pipeline.py`, find the `run_stage` *route handler* defined inside `_make_stage_subrouter` (line ~115) and replace its `_do_run` closure plus the post-run state writes with a single call to the shared helper.

Old (lines 152-196):
```python
        async def _run():
            try:
                loop = asyncio.get_running_loop()

                def on_progress(step: str, pct: int, msg: str) -> None:
                    asyncio.run_coroutine_threadsafe(job.send(step, pct, msg), loop)

                def _do_run():
                    upstream = _gather_upstream(td, stage, stem_ or None)
                    return spec.runner(
                        audio_path=_audio_path_for(td, stage, stem_ or None),
                        upstream=upstream,
                        params=params,
                        on_progress=on_progress,
                    )

                payload = await loop.run_in_executor(None, _do_run)
                payload.setdefault('engine', engine_id)
                payload.setdefault('params', params)
                payload.setdefault('generated_at',
                                   __import__('datetime').datetime.utcnow().isoformat() + 'Z')

                # S7 engines return {'by_difficulty': {'easy': {...}, 'medium': {...}, 'hard': {...}}}
                # Write each as a separate stage's active file.
                if stage in _S7_STAGES and 'by_difficulty' in payload:
                    bd = payload['by_difficulty']
                    for diff_key, diff_stage in (
                        ('hard', Stage.LANES_HARD), ('medium', Stage.LANES_MEDIUM), ('easy', Stage.LANES_EASY)
                    ):
                        if diff_key in bd:
                            diff_payload = dict(bd[diff_key])
                            diff_payload.setdefault('engine', engine_id)
                            diff_payload.setdefault('params', params)
                            save_version_and_activate(td, diff_stage, stem_ or None, diff_payload)
                            _update_state_after_run(td, diff_stage, stem_ or None,
                                                    diff_payload.get('engine', 'unknown'), diff_payload)
                    mark_downstream_stale(td, changed_stage=stage, stem=stem_ or None)
                    await job.send_done({'stage': 'lanes_(hard|medium|easy)', 'engine': engine_id})
                    return

                save_version_and_activate(td, stage, stem_ or None, payload)
                _update_state_after_run(td, stage, stem_ or None, engine_id, payload)
                mark_downstream_stale(td, changed_stage=stage, stem=stem_ or None)

                await job.send_done({'stage': stage_id, 'engine': engine_id})
            except Exception as e:  # noqa: BLE001
                if not job.cancelled:
                    await job.send_error(str(e) or 'pipeline stage failed')
```

New:
```python
        async def _run():
            try:
                loop = asyncio.get_running_loop()

                def on_progress(step: str, pct: int, msg: str) -> None:
                    asyncio.run_coroutine_threadsafe(job.send(step, pct, msg), loop)

                from ..services.pipeline.runner import run_stage as _run_stage

                def _do_run():
                    return _run_stage(
                        stage=stage,
                        track_dir=td,
                        stem=stem_ or None,
                        engine_id=engine_id,
                        params=params,
                        on_progress=on_progress,
                    )

                await loop.run_in_executor(None, _do_run)

                if stage in _S7_STAGES:
                    await job.send_done({'stage': 'lanes_(hard|medium|easy)', 'engine': engine_id})
                else:
                    await job.send_done({'stage': stage_id, 'engine': engine_id})
            except Exception as e:  # noqa: BLE001
                if not job.cancelled:
                    await job.send_error(str(e) or 'pipeline stage failed')
```

- [ ] **Step 3: Delete now-duplicate helpers in pipeline.py and fix remaining call site**

The helpers `_gather_upstream`, `_audio_path_for`, and `_update_state_after_run` defined in `pipeline.py` are now duplicated in `runner.py`. The version-activate endpoint (`pipeline.py:240`) still calls `_update_state_after_run(td, stage, stem, engine_id, payload)` — but the new runner version drops the unused `payload` arg.

a. Delete the three helper definitions at the bottom of `pipeline.py` (the `_gather_upstream`, `_audio_path_for`, `_update_state_after_run` functions, lines ~263-326 in the original).

b. Add an import near the top: `from ..services.pipeline.runner import _update_state_after_run`.

c. Update the call site in `activate_version` (around line 240). Old:
```python
        _update_state_after_run(td, stage, stem_ or None,
                                payload.get('engine', 'unknown'), payload)
```
New (drop the unused `payload` arg):
```python
        _update_state_after_run(td, stage, stem_ or None,
                                payload.get('engine', 'unknown'))
```

d. Confirm nothing else in `pipeline.py` references the deleted helpers:
```bash
grep -n "_gather_upstream\|_audio_path_for" web/backend/app/routers/pipeline.py
```
Expected: no matches.

- [ ] **Step 4: Run pipeline tests to confirm behavior unchanged**

Run: `pytest web/backend/tests/test_pipeline_router_basics.py web/backend/tests/test_pipeline_phase3_e2e.py web/backend/tests/test_pipeline_runner.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/backend/app/routers/pipeline.py
git commit -m "refactor(pipeline): per-stage POST handler delegates to run_stage helper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Extract `write_chart_song_ini()` helper

**Files:**
- Modify: `web/backend/app/services/chart_generator.py:402-468`
- Create: `web/backend/tests/test_write_chart_song_ini.py`

- [ ] **Step 1: Write the failing test**

```python
# web/backend/tests/test_write_chart_song_ini.py
"""Unit test for the extracted write_chart_song_ini helper. Round-trips a
captured notes.chart through the helper and asserts the produced
song.ini contains the expected sections."""
from __future__ import annotations

from pathlib import Path

import pytest

from app.services.chart_generator import write_chart_song_ini


SAMPLE_CHART = """[Song]
{
  Resolution = 192
}
[SyncTrack]
{
  0 = TS 4
  0 = B 120000
}
[Events]
{
}
[ExpertSingle]
{
  0 = N 0 0
  192 = N 1 0
}
"""


def test_write_chart_song_ini_writes_metadata_and_stats(tmp_path):
    chart_path = tmp_path / 'notes.chart'
    chart_path.write_text(SAMPLE_CHART)

    ini_path = write_chart_song_ini(
        out_dir=tmp_path,
        chart_path=str(chart_path),
        song_name='Hello',
        artist='World',
        album='Test',
        genre='Rock',
        year='2026',
        ini_overrides={'charter': 'Tester', 'diff_guitar': 4},
    )

    text = Path(ini_path).read_text()
    assert '[song]' in text
    assert 'name = Hello' in text
    assert 'artist = World' in text
    assert 'charter = Tester' in text
    assert 'diff_guitar = 4' in text
    # stats section emitted for the difficulty present in the chart
    assert '[expert_stats]' in text
    assert 'total_events = 2' in text


def test_write_chart_song_ini_uses_defaults_for_missing_overrides(tmp_path):
    chart_path = tmp_path / 'notes.chart'
    chart_path.write_text(SAMPLE_CHART)

    ini_path = write_chart_song_ini(
        out_dir=tmp_path,
        chart_path=str(chart_path),
        song_name='X',
        artist='Y',
        album='Z',
        genre='G',
        year='',
        ini_overrides=None,
    )
    text = Path(ini_path).read_text()
    assert 'charter = Jamsesh' in text
    assert 'diff_guitar = -1' in text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest web/backend/tests/test_write_chart_song_ini.py -v`
Expected: FAIL — `ImportError: cannot import name 'write_chart_song_ini' from 'app.services.chart_generator'`

- [ ] **Step 3: Extract `write_chart_song_ini()` and call it from `generate_full_chart`**

In `web/backend/app/services/chart_generator.py`, add this function above `generate_full_chart`:

```python
def write_chart_song_ini(
    out_dir: Path | str,
    *,
    chart_path: str,
    song_name: str,
    artist: str,
    album: str,
    genre: str,
    year: str,
    ini_overrides: dict | None = None,
) -> str:
    """Write song.ini next to a notes.chart, including [<diff>_stats]
    sections derived from the chart.

    Returns the path to the written ini.
    """
    from .chart_analyser import analyse_chart_file

    out_dir = Path(out_dir)
    with open(chart_path, 'r') as f:
        chart_content = f.read()
    analysis = analyse_chart_file(chart_content)

    pair_names = ['0+1', '1+2', '2+3', '3+4']
    ini_path = str(out_dir / 'song.ini')
    ov = ini_overrides or {}
    with open(ini_path, 'w') as f:
        f.write('[song]\n')
        f.write(f'name = {song_name}\n')
        f.write(f'artist = {artist}\n')
        f.write(f'album = {album}\n')
        f.write(f'genre = {genre}\n')
        f.write(f'year = {year}\n')
        f.write(f'charter = {ov.get("charter", "Jamsesh")}\n')
        f.write(f'loading_phrase = {ov.get("loading_phrase", "")}\n')
        if ov.get('icon'):
            f.write(f'icon = {ov["icon"]}\n')
        f.write(f'album_track = {ov.get("album_track", 0)}\n')
        f.write(f'playlist_track = {ov.get("playlist_track", 0)}\n')
        f.write(f'delay = {ov.get("delay", 0)}\n')
        f.write(f'preview_start_time = {ov.get("preview_start_time", 0)}\n')
        if ov.get('video_start_time'):
            f.write(f'video_start_time = {ov["video_start_time"]}\n')
        if ov.get('song_length'):
            f.write(f'song_length = {ov["song_length"]}\n')
        for diff_key in (
            'diff_guitar', 'diff_rhythm', 'diff_bass', 'diff_guitar_coop',
            'diff_drums', 'diff_drums_real', 'diff_keys',
            'diff_guitarghl', 'diff_bassghl',
        ):
            val = ov.get(diff_key, -1)
            f.write(f'{diff_key} = {val}\n')
        if ov.get('hopo_frequency'):
            f.write(f'hopo_frequency = {ov["hopo_frequency"]}\n')
        if ov.get('sustain_cutoff_threshold'):
            f.write(f'sustain_cutoff_threshold = {ov["sustain_cutoff_threshold"]}\n')
        if ov.get('five_lane_drums'):
            f.write('five_lane_drums = True\n')
        if ov.get('modchart'):
            f.write('modchart = True\n')

        for section_name, stats in analysis.get('difficulties', {}).items():
            prefix = section_name.replace('Single', '').lower()
            f.write(f'\n[{prefix}_stats]\n')
            f.write(f'total_events = {stats["total_events"]}\n')
            for fret in range(5):
                f.write(f'single_{fret} = {stats["singles"].get(str(fret), 0)}\n')
            for fret in range(5):
                f.write(f'hold_{fret} = {stats["holds"].get(str(fret), 0)}\n')
            for fret in range(5):
                f.write(f'slide_{fret} = {stats["slides"].get(str(fret), 0)}\n')
            for pname in pair_names:
                f.write(f'chord_{pname} = {stats["chords"].get(pname, 0)}\n')
            for pname in pair_names:
                f.write(f'chord_hold_{pname} = {stats["chord_holds"].get(pname, 0)}\n')
            for pname in pair_names:
                f.write(f'chord_slide_{pname} = {stats["chord_slides"].get(pname, 0)}\n')
            f.write(f'open_normal = {stats["open_normal"]}\n')
            f.write(f'open_hold = {stats["open_hold"]}\n')
            f.write(f'open_slide = {stats["open_slide"]}\n')

    return ini_path
```

Then replace the inline ini-writing block in `generate_full_chart` (lines 402-468 of the original) with a single call:

```python
    # ── Step 5: Write song.ini with note type summaries ──
    await report('finalize', 97, 'Writing song.ini...')
    ini_path = write_chart_song_ini(
        out_dir=out_dir,
        chart_path=chart_output,
        song_name=song_name,
        artist=artist,
        album=album,
        genre=genre,
        year=year,
        ini_overrides=ini_overrides,
    )
```

- [ ] **Step 4: Run new test + smoke-test the legacy flow**

Run: `pytest web/backend/tests/test_write_chart_song_ini.py -v`
Expected: PASS (2 tests)

Run the existing chart_generator tests to make sure the inline replacement didn't regress:
```bash
pytest web/backend/tests -k "chart_generator or beatmap" -v
```
Expected: existing tests pass (some may not exist; that's OK).

- [ ] **Step 5: Commit**

```bash
git add web/backend/app/services/chart_generator.py web/backend/tests/test_write_chart_song_ini.py
git commit -m "refactor(chart): extract write_chart_song_ini helper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Add `POST /api/tracks/{track_id}/generate-beatmap-v2` endpoint

**Files:**
- Modify: `web/backend/app/routers/tracks.py` (add new endpoint after the existing `/generate-beatmap`)
- Create: `web/backend/tests/test_generate_beatmap_v2.py`

- [ ] **Step 1: Write the failing integration test**

```python
# web/backend/tests/test_generate_beatmap_v2.py
"""Integration test for the V2 generate-beatmap endpoint."""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
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
    upload_dir = tmp_path / 'uploads'
    tracks_dir = upload_dir / '_tracks'
    upload_dir.mkdir(parents=True)
    tracks_dir.mkdir(parents=True)
    monkeypatch.setattr(settings, 'upload_dir', str(upload_dir))
    # TRACKS_DIR is computed at import time from settings.upload_dir, so it's
    # already frozen. Override it directly in every module that imported it.
    monkeypatch.setattr('app.services.tracks.TRACKS_DIR', tracks_dir)
    monkeypatch.setattr(
        'app.routers.pipeline._resolve_track_dir',
        lambda track_id: tracks_dir / track_id,
    )
    from app.main import app
    with TestClient(app) as c:
        yield c


def _wait(client, job_id, timeout_s=60):
    for _ in range(timeout_s * 10):
        r = client.get(f'/api/jobs/{job_id}')
        if r.json().get('status') in ('done', 'failed'):
            return r.json()
        time.sleep(0.1)
    raise TimeoutError(job_id)


@pytest.fixture
def fake_track(client, tmp_path):
    """Create a Track on disk with a single Bass stem of impulse audio.

    Depends on `client` so the TRACKS_DIR monkeypatch is in effect before
    we instantiate Track (Track.save() writes to TRACKS_DIR / id).
    """
    from app.services.tracks import Track
    tid = 'tracktest'
    td = tmp_path / 'uploads' / '_tracks' / tid
    (td / 'stems').mkdir(parents=True)

    sr = 22050
    n = sr * 6
    y = np.zeros(n, dtype=np.float32)
    burst = (0.4 * np.sin(2 * np.pi * 110 * np.linspace(0, 0.15, int(sr * 0.15)))).astype(np.float32)
    for s in np.arange(0, 6, 0.5):
        i = int(s * sr)
        y[i:i + burst.shape[0]] += burst
    sf.write(td / 'song.ogg', y, sr)
    sf.write(td / 'stems' / 'bass.ogg', y, sr)
    sf.write(td / 'stems' / 'guitar.ogg', y, sr)

    t = Track(
        id=tid, name='Test', created_at=time.time(), stems={'bass': 'bass.ogg'},
        model='demucs', output_format='ogg',
        artist='A', album='B', genre='G', year='2026',
    )
    t.save()
    return tid


def test_generate_beatmap_v2_runs_all_stages(client, fake_track):
    tid = fake_track
    form = {
        'stem': 'bass',
        'name': 'Bass Test',
        'artist': 'A',
        'album': 'B',
        'genre': 'G',
        'year': '2026',
        'onsets_engine': 'librosa-onset',
        'onsets_params': json.dumps({}),
        'pitches_engine': 'yin',
        'pitches_params': json.dumps({}),
        'quantized_engine': 'metric-weighted',
        'quantized_params': json.dumps({}),
        'lanes_engine': 'section-sliding',
        'lanes_params': json.dumps({}),
        'playability_engine': 'identity',
        'playability_params': json.dumps({}),
    }
    r = client.post(f'/api/tracks/{tid}/generate-beatmap-v2', data=form)
    assert r.status_code == 200, r.text
    job_id = r.json()['job_id']

    final = _wait(client, job_id)
    assert final.get('status') == 'done', final

    # Verify on-disk artifacts inside the job's output_dir
    from app.config import settings
    job_dir = Path(settings.upload_dir) / job_id
    # The endpoint creates "<artist> - <song_name>/" under the job dir
    subdirs = [p for p in job_dir.iterdir() if p.is_dir()]
    assert len(subdirs) == 1, f'expected one folder, got {subdirs}'
    out = subdirs[0]
    assert (out / 'notes.chart').exists()
    assert (out / 'song.ogg').exists()
    assert (out / 'song.ini').exists()

    ini = (out / 'song.ini').read_text()
    assert 'name = Bass Test' in ini


def test_generate_beatmap_v2_rejects_drums(client, fake_track):
    """Drums stem must be rejected — drums use legacy endpoint."""
    r = client.post(
        f'/api/tracks/{fake_track}/generate-beatmap-v2',
        data={
            'stem': 'drums',
            'name': 'D', 'artist': 'A', 'album': 'B', 'genre': 'G', 'year': '2026',
            'onsets_engine': 'librosa-onset', 'onsets_params': '{}',
            'pitches_engine': 'yin', 'pitches_params': '{}',
            'quantized_engine': 'metric-weighted', 'quantized_params': '{}',
            'lanes_engine': 'section-sliding', 'lanes_params': '{}',
            'playability_engine': 'identity', 'playability_params': '{}',
        },
    )
    assert r.status_code == 400
    assert 'drum' in r.json()['detail'].lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest web/backend/tests/test_generate_beatmap_v2.py -v`
Expected: FAIL — endpoint returns 404 (route not yet mounted)

- [ ] **Step 3: Implement the endpoint**

In `web/backend/app/routers/tracks.py`, add the following near the existing `/generate-beatmap` route (after the existing `generate_beatmap_from_track` function):

```python
@router.post('/{track_id}/generate-beatmap-v2')
async def generate_beatmap_v2(
    track_id: str,
    stem: str = Form(...),
    # song.ini fields (same shape as legacy endpoint)
    name: str = Form(''),
    artist: str = Form(''),
    album: str = Form(''),
    genre: str = Form(''),
    year: str = Form(''),
    charter: str = Form('Jamsesh'),
    loading_phrase: str = Form(''),
    icon: str = Form(''),
    album_track: int = Form(0),
    playlist_track: int = Form(0),
    delay: int = Form(0),
    preview_start_time: int = Form(0),
    video_start_time: int = Form(0),
    song_length: int = Form(0),
    diff_guitar: int = Form(-1),
    diff_rhythm: int = Form(-1),
    diff_bass: int = Form(-1),
    diff_guitar_coop: int = Form(-1),
    diff_drums: int = Form(-1),
    diff_drums_real: int = Form(-1),
    diff_keys: int = Form(-1),
    diff_guitarghl: int = Form(-1),
    diff_bassghl: int = Form(-1),
    hopo_frequency: int = Form(0),
    sustain_cutoff_threshold: int = Form(0),
    five_lane_drums: bool = Form(True),
    modchart: bool = Form(False),
    # V2 pipeline engine selections
    onsets_engine: str = Form('librosa-onset'),
    onsets_params: str = Form('{}'),
    pitches_engine: str = Form('yin'),
    pitches_params: str = Form('{}'),
    quantized_engine: str = Form('metric-weighted'),
    quantized_params: str = Form('{}'),
    lanes_engine: str = Form('section-sliding'),
    lanes_params: str = Form('{}'),
    playability_engine: str = Form('identity'),
    playability_params: str = Form('{}'),
):
    """Generate a beatmap by driving the V2 staged pipeline end-to-end.

    Unlike `/generate-beatmap` (legacy), this endpoint runs each V2 stage in
    sequence with the caller-selected engines and writes the final
    notes.chart via the V2 serializer. Drums stem is rejected — drums use
    the legacy endpoint for single-hit output.
    """
    import asyncio
    import json as _json

    if stem == 'drums':
        raise HTTPException(400, 'Drums stem is not supported by V2 pipeline; use /generate-beatmap')

    track = get_track(track_id)
    if not track:
        raise HTTPException(404, 'Track not found')
    filename = track.stems.get(stem)
    if not filename:
        raise HTTPException(404, f'Stem not found: {stem}')
    stem_path = track.stems_dir / filename
    if not stem_path.exists():
        raise HTTPException(404, 'Stem file not found on disk')

    # Parse JSON param blobs
    def _parse(name: str, raw: str) -> dict:
        try:
            return _json.loads(raw or '{}')
        except _json.JSONDecodeError as e:
            raise HTTPException(400, f'{name} is not valid JSON: {e}')

    engine_params = {
        'onsets': (onsets_engine, _parse('onsets_params', onsets_params)),
        'pitches': (pitches_engine, _parse('pitches_params', pitches_params)),
        'quantized': (quantized_engine, _parse('quantized_params', quantized_params)),
        'lanes_expert': (lanes_engine, _parse('lanes_params', lanes_params)),
        'lanes_filtered': (playability_engine, _parse('playability_params', playability_params)),
    }

    song_name = name or f'{track.name} ({stem})'
    song_artist = artist or track.artist or 'Unknown'
    song_album = album or track.album or 'Unknown'
    song_genre = genre or track.genre or 'Unknown'
    song_year = year or track.year or ''

    ini_overrides = {
        'charter': charter, 'loading_phrase': loading_phrase, 'icon': icon,
        'album_track': album_track, 'playlist_track': playlist_track,
        'delay': delay, 'preview_start_time': preview_start_time,
        'video_start_time': video_start_time, 'song_length': song_length,
        'diff_guitar': diff_guitar, 'diff_rhythm': diff_rhythm,
        'diff_bass': diff_bass, 'diff_guitar_coop': diff_guitar_coop,
        'diff_drums': diff_drums, 'diff_drums_real': diff_drums_real,
        'diff_keys': diff_keys, 'diff_guitarghl': diff_guitarghl,
        'diff_bassghl': diff_bassghl, 'hopo_frequency': hopo_frequency,
        'sustain_cutoff_threshold': sustain_cutoff_threshold,
        'five_lane_drums': five_lane_drums, 'modchart': modchart,
    }

    upload_dir = Path(settings.upload_dir)
    bm_title = f'{song_artist} — {song_name} ({stem})' if song_artist and song_artist != 'Unknown' else f'{song_name} ({stem})'
    job = create_job(kind=JobKind.BEATMAP, title=bm_title)
    job.track_id = track_id
    job.metadata['track_id'] = track_id
    job.metadata['stem'] = stem
    job.metadata['pipeline'] = 'v2'
    job_dir = upload_dir / job.id
    job_dir.mkdir(parents=True)
    job.output_dir = job_dir

    safe_artist = song_artist.replace('/', '-').replace('\\', '-').replace(':', '-').strip()
    safe_title = song_name.replace('/', '-').replace('\\', '-').replace(':', '-').strip()
    folder_name = f'{safe_artist} - {safe_title}'
    job.metadata['folder_name'] = folder_name
    output_dir = job_dir / folder_name

    async def _run():
        from ..services.pipeline.registry import Stage
        from ..services.pipeline.runner import run_stage
        from ..services.pipeline.storage import stage_path
        from ..services.pipeline.serialize import serialize_chart
        from ..services.audio import convert_to_ogg
        from ..services.chart_generator import write_chart_song_ini

        job.status = JobStatus.RUNNING
        loop = asyncio.get_running_loop()

        def make_on_progress(stage_lo: int, stage_hi: int):
            def cb(step: str, pct: int, msg: str) -> None:
                mapped = int(stage_lo + (stage_hi - stage_lo) * (max(0, min(100, pct)) / 100))
                asyncio.run_coroutine_threadsafe(job.send(step, mapped, msg), loop)
            return cb

        try:
            # Track-level dir is where the pipeline stores grid + per-stem stage state
            from ..services.tracks import TRACKS_DIR
            td = TRACKS_DIR / track_id

            # ── S1: Grid (track-level) — reuse if active.json exists ──
            grid_p = stage_path(td, Stage.GRID, None)
            if not grid_p.exists():
                await job.send('grid', 2, 'Computing tempo grid…')
                await loop.run_in_executor(None, lambda: run_stage(
                    Stage.GRID, td, None, 'librosa-beat', {},
                    make_on_progress(2, 10),
                ))

            # ── Stem-scoped stages ──
            stages = [
                (Stage.ONSETS, *engine_params['onsets'], 10, 25, 'Detecting onsets'),
                (Stage.PITCHES, *engine_params['pitches'], 25, 45, 'Estimating pitches'),
                (Stage.QUANTIZED, *engine_params['quantized'], 45, 55, 'Quantising to grid'),
                (Stage.LANES_EXPERT, *engine_params['lanes_expert'], 55, 70, 'Mapping lanes (Expert)'),
                (Stage.LANES_FILTERED, *engine_params['lanes_filtered'], 70, 78, 'Filtering for playability'),
            ]
            for st, eng, params, lo, hi, label in stages:
                await job.send(st.value, lo, label + '…')
                await loop.run_in_executor(None, lambda st=st, eng=eng, params=params, lo=lo, hi=hi: run_stage(
                    st, td, stem, eng, params, make_on_progress(lo, hi),
                ))

            # ── S7: difficulties — defaults, run once (writes all three sub-stages) ──
            await job.send('lanes_hard', 78, 'Building Hard/Medium/Easy…')
            await loop.run_in_executor(None, lambda: run_stage(
                Stage.LANES_HARD, td, stem, 'metric-weight', {},
                make_on_progress(78, 90),
            ))

            # ── S8: build chart ──
            await job.send('build', 90, 'Writing notes.chart…')
            grid = _json.loads(grid_p.read_text())
            lanes_per_difficulty: dict[str, dict] = {}
            filtered_p = stage_path(td, Stage.LANES_FILTERED, stem)
            expert_p = stage_path(td, Stage.LANES_EXPERT, stem)
            lanes_per_difficulty['ExpertSingle'] = _json.loads(
                (filtered_p if filtered_p.exists() else expert_p).read_text()
            )
            for diff_section, st in (
                ('HardSingle', Stage.LANES_HARD),
                ('MediumSingle', Stage.LANES_MEDIUM),
                ('EasySingle', Stage.LANES_EASY),
            ):
                p = stage_path(td, st, stem)
                if p.exists():
                    lanes_per_difficulty[diff_section] = _json.loads(p.read_text())

            chart_text = serialize_chart(
                grid=grid, lanes_per_difficulty=lanes_per_difficulty,
                song_name=song_name, resolution=int(grid['resolution']),
            )
            output_dir.mkdir(parents=True, exist_ok=True)
            chart_path = str(output_dir / 'notes.chart')
            Path(chart_path).write_text(chart_text, encoding='utf-8')

            # ── Audio ──
            await job.send('convert', 94, 'Converting audio to song.ogg…')
            ogg_path = str(output_dir / 'song.ogg')
            await loop.run_in_executor(None, lambda: convert_to_ogg(str(stem_path), ogg_path))

            # ── song.ini ──
            await job.send('finalize', 97, 'Writing song.ini…')
            write_chart_song_ini(
                out_dir=output_dir, chart_path=chart_path,
                song_name=song_name, artist=song_artist, album=song_album,
                genre=song_genre, year=song_year, ini_overrides=ini_overrides,
            )

            # ── Register beatmap record ──
            try:
                from importlib.metadata import version as _pkg_version
                _madmom_version = _pkg_version('madmom')
            except Exception:
                _madmom_version = None
            model_version = f'{_madmom_version}+v2' if _madmom_version else 'v2'
            add_beatmap_record(
                track_id=track_id, beatmap_id=job.id, stem=stem,
                folder_name=folder_name, song_name=song_name,
                source_dir=output_dir,
                model='madmom', model_version=model_version,
            )
            await job.send_done({
                'chart_path': chart_path, 'ogg_path': ogg_path,
                'song_name': song_name, 'artist': song_artist,
                'folder_name': folder_name,
            })
        except asyncio.CancelledError:
            return
        except Exception as e:  # noqa: BLE001
            if not job.cancelled:
                await job.send_error(str(e) or 'V2 pipeline failed')

    job.task = asyncio.create_task(_run())
    return {'job_id': job.id}
```

- [ ] **Step 4: Run the integration test**

Run: `pytest web/backend/tests/test_generate_beatmap_v2.py -v`
Expected: PASS (both tests). If the V2 pipeline times out on the impulse audio, increase `timeout_s` to 90 in the `_wait` helper.

- [ ] **Step 5: Commit**

```bash
git add web/backend/app/routers/tracks.py web/backend/tests/test_generate_beatmap_v2.py
git commit -m "feat(tracks): /generate-beatmap-v2 endpoint drives V2 pipeline

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Extract `ParamControl` to its own file

**Files:**
- Create: `web/frontend/src/components/pipeline/ParamControl.tsx`
- Modify: `web/frontend/src/components/pipeline/StageCard.tsx`

- [ ] **Step 1: Create `ParamControl.tsx`**

Copy the existing `ParamControl` function (currently `StageCard.tsx:144-185`) into a new file:

```tsx
// web/frontend/src/components/pipeline/ParamControl.tsx
import type { ParamSpec } from '../../api/pipelineClient'

export function ParamControl({
  keyName, spec, value, onChange,
}: {
  keyName: string
  spec: ParamSpec
  value: unknown
  onChange: (v: unknown) => void
}) {
  const label = ('label' in spec && spec.label) || keyName
  if (spec.type === 'number') {
    return (
      <label className="block text-xs">
        {label}: <span className="text-indigo-300">{String(value ?? spec.default ?? '')}</span>
        <input type="range"
          min={spec.min ?? 0} max={spec.max ?? 1} step={spec.step ?? 0.01}
          value={Number(value ?? spec.default ?? 0)}
          onChange={e => onChange(Number(e.target.value))}
          className="w-full" />
      </label>
    )
  }
  if (spec.type === 'boolean') {
    return (
      <label className="block text-xs">
        <input type="checkbox" checked={Boolean(value ?? spec.default)}
          onChange={e => onChange(e.target.checked)} />
        <span className="ml-2">{label}</span>
      </label>
    )
  }
  if (spec.type === 'enum') {
    return (
      <label className="block text-xs">
        {label}:
        <select value={String(value ?? spec.default ?? '')}
          onChange={e => onChange(e.target.value)}
          className="ml-2 bg-zinc-800 border border-zinc-600 rounded px-1">
          {spec.options.map(o => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
        </select>
      </label>
    )
  }
  return <div className="text-xs text-zinc-500">[unsupported param type]</div>
}
```

- [ ] **Step 2: Update `StageCard.tsx` to import from the new file**

In `web/frontend/src/components/pipeline/StageCard.tsx`:

1. Add the import near the top: `import { ParamControl } from './ParamControl'`
2. Delete the local `function ParamControl(...)` definition at the bottom (lines 144-185 in the current file).

- [ ] **Step 3: Build to verify no regression**

Run: `cd web/frontend && npm run build`
Expected: build succeeds without errors.

- [ ] **Step 4: Commit**

```bash
git add web/frontend/src/components/pipeline/ParamControl.tsx web/frontend/src/components/pipeline/StageCard.tsx
git commit -m "refactor(editor): hoist ParamControl into shared component

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Add GENERATION section + V2 submit to `BeatmapPanel`

**Files:**
- Modify: `web/frontend/src/pages/TracksPage.tsx` (BeatmapPanel: lines ~84-354)

- [ ] **Step 1: Define the GENERATION knob model & defaults**

At the top of `TracksPage.tsx` (near `FIELD_GROUPS`), add:

```tsx
type GenerationStage = 'onsets' | 'pitches' | 'quantized' | 'lanes_expert' | 'lanes_filtered'

const GENERATION_STAGE_LABELS: Record<GenerationStage, string> = {
  onsets: 'Onset detection',
  pitches: 'Pitch detection',
  quantized: 'Quantization',
  lanes_expert: 'Lane mapping',
  lanes_filtered: 'Playability filter',
}

const GENERATION_DEFAULTS: Record<GenerationStage, { engine: string; params: Record<string, unknown> }> = {
  onsets: { engine: 'librosa-onset', params: {} },
  pitches: { engine: 'yin', params: {} },
  quantized: { engine: 'metric-weighted', params: {} },
  lanes_expert: { engine: 'section-sliding', params: {} },
  lanes_filtered: { engine: 'identity', params: {} },
}
```

- [ ] **Step 2: Add state + engines catalog fetch to `BeatmapPanel`**

Inside the `BeatmapPanel` component, add new state and a fetch effect alongside the existing `useEffect`:

```tsx
const [engines, setEngines] = useState<Record<string, EngineSpec[]> | null>(null)
const [generation, setGeneration] = useState<Record<GenerationStage, { engine: string; params: Record<string, unknown> }>>(GENERATION_DEFAULTS)

useEffect(() => {
  fetch('/api/pipeline/engines')
    .then(r => r.json())
    .then((catalog: Record<string, EngineSpec[]>) => {
      setEngines(catalog)
      // Reset params to engine defaults so the modal opens in a sensible state
      setGeneration(prev => {
        const next = { ...prev }
        ;(Object.keys(next) as GenerationStage[]).forEach(stage => {
          const spec = catalog[stage]?.find(e => e.engine_id === next[stage].engine)
          if (!spec) return
          const defaults: Record<string, unknown> = {}
          for (const [k, p] of Object.entries(spec.params_schema || {})) {
            if ('default' in p && p.default !== undefined) defaults[k] = p.default
          }
          next[stage] = { engine: next[stage].engine, params: defaults }
        })
        return next
      })
    })
    .catch(console.error)
}, [])
```

Add the imports near the top of the file:
```tsx
import { ParamControl } from '../components/pipeline/ParamControl'
import type { EngineSpec } from '../api/pipelineClient'
```

- [ ] **Step 3: Render the GENERATION section in the modal body**

Inside the modal body, between the Metadata group and the Timing group (the `FIELD_GROUPS.map` block), add:

```tsx
{stem !== 'drums' && engines && (
  <div>
    <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Generation</h4>
    <div className="space-y-3">
      {(Object.keys(GENERATION_STAGE_LABELS) as GenerationStage[]).map(stage => {
        const stageEngines = engines[stage] || []
        const selected = generation[stage]
        const spec = stageEngines.find(e => e.engine_id === selected.engine)
        return (
          <div key={stage} className="border border-gray-700 rounded-lg p-3 space-y-2">
            <label className="block text-xs">
              <span className="text-gray-500">{GENERATION_STAGE_LABELS[stage]}</span>
              <select
                value={selected.engine}
                onChange={e => {
                  const nextEngineId = e.target.value
                  const nextSpec = stageEngines.find(s => s.engine_id === nextEngineId)
                  const nextParams: Record<string, unknown> = {}
                  for (const [k, p] of Object.entries(nextSpec?.params_schema || {})) {
                    if ('default' in p && p.default !== undefined) nextParams[k] = p.default
                  }
                  setGeneration(prev => ({
                    ...prev,
                    [stage]: { engine: nextEngineId, params: nextParams },
                  }))
                }}
                className="ml-2 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm"
              >
                {stageEngines.map(s => (
                  <option key={s.engine_id} value={s.engine_id}>{s.display_name}</option>
                ))}
              </select>
            </label>
            {spec && Object.keys(spec.params_schema || {}).length > 0 && (
              <div className="pl-3 border-l border-gray-700 space-y-2">
                {Object.entries(spec.params_schema).map(([key, pspec]) => (
                  <ParamControl
                    key={key} keyName={key} spec={pspec}
                    value={selected.params[key]}
                    onChange={v => setGeneration(prev => ({
                      ...prev,
                      [stage]: { ...prev[stage], params: { ...prev[stage].params, [key]: v } },
                    }))}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  </div>
)}
```

- [ ] **Step 4: Wire `handleGenerate` to the V2 endpoint with drums fallback**

Replace the existing `handleGenerate` function body (currently `TracksPage.tsx:131-185`):

```tsx
const handleGenerate = async () => {
  setGenerating(true)
  setError('')
  setDone(false)

  const formData = new FormData()
  formData.append('stem', stem)
  for (const [key, val] of Object.entries(values)) {
    formData.append(key, String(val ?? ''))
  }

  const useV2 = stem !== 'drums'
  if (useV2) {
    for (const stage of Object.keys(GENERATION_STAGE_LABELS) as GenerationStage[]) {
      const sel = generation[stage]
      formData.append(`${stage === 'lanes_expert' ? 'lanes' : stage === 'lanes_filtered' ? 'playability' : stage}_engine`, sel.engine)
      formData.append(`${stage === 'lanes_expert' ? 'lanes' : stage === 'lanes_filtered' ? 'playability' : stage}_params`, JSON.stringify(sel.params))
    }
  }

  const endpoint = useV2
    ? `/api/tracks/${track.id}/generate-beatmap-v2`
    : `/api/tracks/${track.id}/generate-beatmap`

  try {
    const res = await fetch(endpoint, { method: 'POST', body: formData })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.detail || 'Failed')
    }
    const { job_id } = await res.json()
    setBeatmapJobId(job_id)
    setJobId(job_id)

    const evtSource = new EventSource(`/api/beatmap/${job_id}/status`)
    evtSource.onmessage = (e) => {
      const data = JSON.parse(e.data)
      if (data.progress >= 0) setProgress(data.progress)
      setMessage(data.message)
      if (data.step === 'done') {
        evtSource.close()
        setDone(true)
        setGenerating(false)
        if (onGenerated) onGenerated()
      } else if (data.step === 'error') {
        evtSource.close()
        setError(data.message)
        setGenerating(false)
      } else if (data.step === 'cancelled') {
        evtSource.close()
        setGenerating(false)
        setProgress(0)
        setMessage('')
        setJobId('')
        setBeatmapJobId('')
      }
    }
    evtSource.onerror = () => {
      evtSource.close()
      setError('Connection lost')
      setGenerating(false)
    }
  } catch (e) {
    setError((e as Error).message)
    setGenerating(false)
  }
}
```

- [ ] **Step 5: Build & lint**

Run: `cd web/frontend && npm run build`
Expected: build succeeds; no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add web/frontend/src/pages/TracksPage.tsx
git commit -m "feat(tracks): GENERATION section drives V2 pipeline from modal

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Manual verification + deploy

**Files:** none (verification only)

- [ ] **Step 1: Start backend + frontend dev servers**

In one shell:
```bash
cd web/backend && venv/Scripts/python.exe run.py
```

In another:
```bash
cd web/frontend && npm run dev
```

Open `http://localhost:5173`.

- [ ] **Step 2: Run the consistency-bug regression check**

1. Navigate to the Tracks page and find the track from the original report (the one whose Bass stem produced different lanes for the same phrase at ~0:08.75 vs ~0:21.78).
2. Click **Generate Beatmap** on the **Bass** stem.
3. Verify the modal shows the new **GENERATION** section with 5 engine dropdowns.
4. Leave defaults (`librosa-onset / yin / metric-weighted / section-sliding / identity`).
5. Click **Generate Beatmap**. Watch SSE progress run through all stages.
6. On completion, click into the editor.
7. Compare the two timestamps: ~0:08.75 and ~0:21.78. The same musical phrase should now land on the same lane(s).

- [ ] **Step 3: Run the drums fallback check**

1. From the same track, click **Generate Beatmap** on the **Drums** stem.
2. Verify the GENERATION section is hidden.
3. Click **Generate Beatmap**. Confirm the request goes to `/generate-beatmap` (legacy) — DevTools Network panel.
4. Drum chart generates without errors.

- [ ] **Step 4: Run the full backend test suite once**

```bash
pytest web/backend/tests -q
```
Expected: all tests pass (or only previously-failing unrelated tests).

- [ ] **Step 5: Commit anything left, push, deploy**

```bash
git status                      # confirm clean
git push origin main
ssh -i ~/.ssh/id_ed25519_beatmap root@beatmap.jamsesh.co \
  'cd /opt/madmom && git pull && cd web/frontend && npm run build && systemctl restart beatmap-backend'
```

(Backend restart is needed this time because backend code changed.)

---

## Self-Review Notes

**Spec coverage check:**
- Modal GENERATION section with 5 dropdowns + knobs → Task 6 ✓
- New `/generate-beatmap-v2` endpoint orchestrating all stages → Task 4 ✓
- `run_stage` helper extraction → Task 1 + Task 2 ✓
- `write_chart_song_ini` helper extraction → Task 3 ✓
- `ParamControl` shared component → Task 5 ✓
- Drums stem fallback to legacy → Task 6, Step 4 + Task 4 (400 reject) ✓
- `model_version` ends with `+v2` → Task 4 (line `model_version = f'{_madmom_version}+v2'`) ✓
- Backward compat — legacy endpoint untouched → Task 4 (new endpoint, no change to `/generate-beatmap`) ✓
- Manual verification: same phrase same lane → Task 7, Step 2 ✓
- Unit tests for `write_chart_song_ini` and `run_stage` → Tasks 1 & 3 ✓
- Integration test for V2 endpoint → Task 4 ✓
