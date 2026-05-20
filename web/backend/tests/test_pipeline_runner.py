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
