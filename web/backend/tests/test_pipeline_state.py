"""Tests for pipeline_state.json read/write + stale-marking."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services.pipeline.registry import Stage
from app.services.pipeline.state import (
    PipelineState,
    StemState,
    StageState,
    mark_downstream_stale,
    load_pipeline_state,
    save_pipeline_state,
)


@pytest.fixture
def tmp_track(tmp_path: Path) -> Path:
    return tmp_path / 'track'


def test_load_missing_returns_empty_state(tmp_track):
    state = load_pipeline_state(tmp_track)
    assert state.schema_version == 1
    assert state.grid is None
    assert state.stems == {}


def test_save_then_load_roundtrip(tmp_track):
    tmp_track.mkdir()
    s = PipelineState(
        schema_version=1,
        grid=StageState(active_version='v.json', engine='manual', stale=False),
        stems={'guitar': StemState()},
    )
    save_pipeline_state(tmp_track, s)
    loaded = load_pipeline_state(tmp_track)
    assert loaded.grid.engine == 'manual'
    assert 'guitar' in loaded.stems


def test_mark_downstream_stale_from_grid(tmp_track):
    tmp_track.mkdir()
    s = PipelineState(
        schema_version=1,
        grid=StageState(active_version='v.json', engine='all-in-one', stale=False),
        stems={
            'guitar': StemState(
                onsets=StageState(active_version='o.json', engine='basic-pitch', stale=False),
                pitches=StageState(active_version='p.json', engine='basic-pitch', stale=False),
                quantized=StageState(active_version='q.json', engine='nearest-grid', stale=False),
            ),
        },
    )
    save_pipeline_state(tmp_track, s)
    mark_downstream_stale(tmp_track, changed_stage=Stage.GRID, stem=None)
    s2 = load_pipeline_state(tmp_track)
    guitar = s2.stems['guitar']
    assert guitar.onsets.stale is True
    assert guitar.pitches.stale is True
    assert guitar.quantized.stale is True
    # grid itself is not stale — it's what changed
    assert s2.grid.stale is False


def test_mark_downstream_stale_from_pitches(tmp_track):
    tmp_track.mkdir()
    s = PipelineState(
        schema_version=1,
        grid=StageState(active_version='v.json', engine='all-in-one', stale=False),
        stems={
            'guitar': StemState(
                onsets=StageState(active_version='o.json', engine='basic-pitch', stale=False),
                pitches=StageState(active_version='p.json', engine='basic-pitch', stale=False),
                quantized=StageState(active_version='q.json', engine='nearest-grid', stale=False),
            ),
        },
    )
    save_pipeline_state(tmp_track, s)
    mark_downstream_stale(tmp_track, changed_stage=Stage.PITCHES, stem='guitar')
    s2 = load_pipeline_state(tmp_track)
    guitar = s2.stems['guitar']
    assert guitar.onsets.stale is False  # upstream of pitches
    assert guitar.pitches.stale is False  # is the one that changed
    assert guitar.quantized.stale is True
