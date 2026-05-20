"""Pure stage runner shared by the per-stage HTTP endpoints and the
top-level generate-beatmap-v2 orchestrator. Loads upstream JSONs from
disk, invokes the engine, writes the result back as a new active
version, and updates pipeline_state.json. No FastAPI or async deps."""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any, Callable

from ...routers.pipeline_order import upstream_for
from .registry import Stage, get_engine
from .state import (
    StageState,
    StemState,
    load_pipeline_state,
    mark_downstream_stale,
    save_pipeline_state,
)
from .storage import (
    _TRACK_LEVEL_STAGES,
    list_versions,
    save_version_and_activate,
    stage_path,
)


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
    for s in upstream_for(stage):
        p = stage_path(track_dir, s, stem)
        if p.exists():
            upstream[s.value] = json.loads(p.read_text())
    return upstream


def _audio_path_for(track_dir: Path, stage: Stage, stem: str | None) -> Path | None:
    """Locate the audio file for a stage's engine.

    For S1 (Stage.GRID) we use the full-mix audio at the track root. For
    stem-scoped stages we accept two layouts:
      - subfolder: <track_dir>/stems/<stem>/*.ogg|wav (V2 pipeline native)
      - flat:     <track_dir>/stems/<stem>.ogg|wav   (Tracks service)
    Returns None if no candidate is found.
    """
    if stage == Stage.GRID:
        for cand in ['song.ogg', 'song.wav', 'mix.ogg', 'mix.wav']:
            p = track_dir / cand
            if p.exists():
                return p
        return None
    if stem is None:
        return None

    # Subfolder layout first (V2 native).
    sdir = track_dir / 'stems' / stem
    candidates = list(sdir.glob('*.ogg')) + list(sdir.glob('*.wav'))
    if candidates:
        return candidates[0]

    # Flat layout fallback (real Tracks).
    stems_dir = track_dir / 'stems'
    for ext in ('.ogg', '.wav', '.mp3', '.flac'):
        flat = stems_dir / f'{stem}{ext}'
        if flat.exists():
            return flat
    return None


def update_state_after_run(
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
    payload.setdefault(
        'generated_at',
        dt.datetime.now(dt.UTC).isoformat().replace('+00:00', 'Z'),
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
                update_state_after_run(track_dir, diff_stage, stem, engine_id)
        mark_downstream_stale(track_dir, changed_stage=stage, stem=stem)
        return payload

    save_version_and_activate(track_dir, stage, stem, payload)
    update_state_after_run(track_dir, stage, stem, engine_id)
    mark_downstream_stale(track_dir, changed_stage=stage, stem=stem)
    return payload
