"""Unit tests for the extracted run_stage helper."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services.pipeline.registry import EngineSpec, Stage, _REGISTRY, register_engine
from app.services.pipeline.runner import run_stage
from app.services.pipeline.state import load_pipeline_state
from app.services.pipeline.storage import stage_path


@pytest.fixture
def fake_track_dir(tmp_path):
    td = tmp_path / 'track'
    td.mkdir()
    (td / 'stems' / 'guitar').mkdir(parents=True)
    return td


@pytest.fixture
def fake_engine():
    """Register a fake engine for the test, clean up after."""
    registered: list[tuple[Stage, str]] = []

    def _register(stage: Stage, engine_id: str, runner):
        register_engine(stage, EngineSpec(
            id=engine_id, display_name='test', params_schema={}, runner=runner,
        ))
        registered.append((stage, engine_id))

    yield _register

    for stage, engine_id in registered:
        _REGISTRY[stage] = {k: v for k, v in _REGISTRY[stage].items() if k != engine_id}


def test_run_stage_writes_active_file_and_updates_state(fake_track_dir, fake_engine):
    progress = []

    def fake_runner(audio_path, upstream, params, on_progress):
        on_progress('step', 50, 'halfway')
        return {'beats': [{'tick': 0}], 'resolution': 192,
                'tempo_segments': [{'tick_start': 0, 'micro_bpm': 120000}]}

    fake_engine(Stage.GRID, '__test_runner__', fake_runner)
    result = run_stage(
        stage=Stage.GRID,
        track_dir=fake_track_dir,
        stem=None,
        engine_id='__test_runner__',
        params={},
        on_progress=lambda step, pct, msg: progress.append((step, pct, msg)),
    )

    # Active file exists and contains payload
    active = stage_path(fake_track_dir, Stage.GRID, None)
    assert active.exists()
    body = json.loads(active.read_text())
    assert body['engine'] == '__test_runner__'
    assert body['beats'] == [{'tick': 0}]

    # State reflects the run
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
            engine_id='__not_a_real_engine__', params={}, on_progress=lambda *_: None,
        )


def test_run_stage_splits_by_difficulty_into_three_active_files(fake_track_dir, fake_engine):
    """S7 lanes_hard engines may return {'by_difficulty': {...}} which the
    runner must fan out to lanes_hard / lanes_medium / lanes_easy active files."""
    def fake_runner(audio_path, upstream, params, on_progress):
        return {
            'by_difficulty': {
                'hard': {'lanes': [{'tick': 0, 'frets': [0]}], 'metric_weights': {}},
                'medium': {'lanes': [{'tick': 0, 'frets': [0]}], 'metric_weights': {}},
                'easy': {'lanes': [{'tick': 0, 'frets': [0]}], 'metric_weights': {}},
            },
        }

    engine_id = '__test_s7_split__'
    fake_engine(Stage.LANES_HARD, engine_id, fake_runner)

    run_stage(
        stage=Stage.LANES_HARD,
        track_dir=fake_track_dir,
        stem='guitar',
        engine_id=engine_id,
        params={},
        on_progress=lambda *_: None,
    )

    # All three sub-stages got active files
    for sub_stage in (Stage.LANES_HARD, Stage.LANES_MEDIUM, Stage.LANES_EASY):
        active = stage_path(fake_track_dir, sub_stage, 'guitar')
        assert active.exists(), f'expected active file for {sub_stage.value}'
        body = json.loads(active.read_text())
        assert body['engine'] == engine_id, (
            f'expected engine {engine_id!r} on {sub_stage.value}, got {body.get("engine")!r}'
        )
        assert body['lanes'] == [{'tick': 0, 'frets': [0]}]

    # Pipeline state reflects all three sub-stages
    state = load_pipeline_state(fake_track_dir)
    guitar = state.stems.get('guitar')
    assert guitar is not None
    assert guitar.lanes_hard is not None and guitar.lanes_hard.engine == engine_id
    assert guitar.lanes_medium is not None and guitar.lanes_medium.engine == engine_id
    assert guitar.lanes_easy is not None and guitar.lanes_easy.engine == engine_id
