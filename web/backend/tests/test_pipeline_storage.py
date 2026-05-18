"""Tests for pipeline on-disk storage layout + versioning helpers."""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from app.services.pipeline.registry import Stage
from app.services.pipeline.storage import (
    archive_dir,
    list_versions,
    save_version_and_activate,
    stage_path,
    stale_dir,
    stem_v2_dir,
    track_dir,
    versions_dir,
)


@pytest.fixture
def tmp_track(tmp_path: Path) -> Path:
    d = tmp_path / 'track-abc'
    (d / 'stems').mkdir(parents=True)
    return d


def test_track_dir_returns_input(tmp_track):
    assert track_dir(tmp_track) == tmp_track


def test_stem_v2_dir_creates_path(tmp_track):
    p = stem_v2_dir(tmp_track, 'guitar')
    assert p == tmp_track / 'stems' / 'guitar' / 'v2'


def test_stage_path_track_level(tmp_track):
    p = stage_path(tmp_track, Stage.GRID, stem=None)
    assert p == tmp_track / 'grid.json'


def test_stage_path_stem_level(tmp_track):
    p = stage_path(tmp_track, Stage.ONSETS, stem='guitar')
    assert p == tmp_track / 'stems' / 'guitar' / 'v2' / 'onsets.json'


def test_versions_dir_track_level(tmp_track):
    assert versions_dir(tmp_track, Stage.GRID, stem=None) == tmp_track / 'grid_versions'


def test_versions_dir_stem_level(tmp_track):
    p = versions_dir(tmp_track, Stage.ONSETS, stem='guitar')
    assert p == tmp_track / 'stems' / 'guitar' / 'v2' / 'onsets_versions'


def test_save_version_and_activate(tmp_track):
    payload = {'engine': 'manual', 'params': {}, 'generated_at': '2026-05-18T11:00:00Z', 'micro_bpm': 120000}
    filename = save_version_and_activate(tmp_track, Stage.GRID, stem=None, payload=payload)
    active = json.loads((tmp_track / 'grid.json').read_text())
    assert active['engine'] == 'manual'
    assert filename.endswith('_manual.json')
    snapshot = json.loads((tmp_track / 'grid_versions' / filename).read_text())
    assert snapshot == active


def test_list_versions_newest_first(tmp_track):
    for engine in ['a', 'b', 'c']:
        save_version_and_activate(
            tmp_track, Stage.GRID, stem=None,
            payload={'engine': engine, 'params': {}, 'generated_at': '2026-05-18T11:00:00Z'},
        )
        time.sleep(0.01)
    versions = list_versions(tmp_track, Stage.GRID, stem=None)
    assert [v['engine'] for v in versions] == ['c', 'b', 'a']
    assert versions[0]['active'] is True
    assert all(not v['active'] for v in versions[1:])


def test_save_creates_parent_dirs_for_stem(tmp_track):
    # stems/<stem>/v2/ may not exist yet for a new stem
    save_version_and_activate(
        tmp_track, Stage.ONSETS, stem='guitar',
        payload={'engine': 'basic-pitch', 'params': {}, 'generated_at': '2026-05-18T11:00:00Z'},
    )
    assert (tmp_track / 'stems' / 'guitar' / 'v2' / 'onsets.json').exists()


def test_move_active_to_stale_for_grid(tmp_track):
    from app.services.pipeline.storage import move_active_to_stale
    # Set up a track-level active file
    save_version_and_activate(
        tmp_track, Stage.GRID, stem=None,
        payload={'engine': 'manual', 'params': {}, 'generated_at': '2026-05-18T11:00:00Z'},
    )
    moved = move_active_to_stale(tmp_track, Stage.GRID, stem=None)
    assert moved is not None
    assert moved.exists()
    assert not (tmp_track / 'grid.json').exists()
    assert moved.parent == tmp_track / '_stale'


def test_move_active_to_stale_for_stem_stage(tmp_track):
    from app.services.pipeline.storage import move_active_to_stale
    save_version_and_activate(
        tmp_track, Stage.ONSETS, stem='guitar',
        payload={'engine': 'basic-pitch', 'params': {}, 'generated_at': '2026-05-18T11:00:00Z'},
    )
    moved = move_active_to_stale(tmp_track, Stage.ONSETS, stem='guitar')
    assert moved is not None
    assert not (tmp_track / 'stems' / 'guitar' / 'v2' / 'onsets.json').exists()
    assert moved.parent == tmp_track / 'stems' / 'guitar' / 'v2' / '_stale'


def test_move_active_to_stale_noop_when_no_active(tmp_track):
    from app.services.pipeline.storage import move_active_to_stale
    moved = move_active_to_stale(tmp_track, Stage.GRID, stem=None)
    assert moved is None
