"""Engine-wrapper tests for `madmom-downbeat`. The RNN/DBN tracker is
monkeypatched (it needs the models submodule and a real audio file); what
is under test is the mapping from tracker output to a SongGrid."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from app.services.pipeline.engines import grid_madmom
from app.services.pipeline.schemas.grid import SongGrid


def _noop(*a, **k):
    pass


@pytest.fixture
def fake_tracker(monkeypatch):
    # 3/4 for two bars, then 4/4 — 0.5 s beats starting at 0.3 s.
    positions = [1, 2, 3, 1, 2, 3, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4]
    times = 0.3 + np.arange(len(positions)) * 0.5
    arr = np.column_stack([times, positions]).astype(np.float64)
    monkeypatch.setattr(grid_madmom, 'track_beats_madmom', lambda *a, **k: arr)
    monkeypatch.setattr(grid_madmom, 'audio_duration_s', lambda p: 12.0)
    monkeypatch.setattr(grid_madmom, 'optional_structure', lambda p, n, want_key=True: ([0.0, 4.8], {'tonic': 'A', 'mode': 'minor', 'confidence': 0.7}))
    return arr


def test_madmom_engine_builds_valid_anchored_grid(fake_tracker):
    out = grid_madmom.run_madmom_grid(Path('song.ogg'), {}, {}, _noop)
    grid = SongGrid(**out)  # schema-valid
    assert out['engine'] == 'madmom-downbeat'
    beat_ticks = out['beat_ticks']
    assert all(t % 192 == 0 for t in beat_ticks)
    # Downbeats come from bar positions: beat indices 0, 3, 6, 10, 14.
    assert out['downbeats'] == [beat_ticks[i] for i in (0, 3, 6, 10, 14)]
    nums = [s.num for s in grid.time_sig_segments]
    assert 3 in nums and 4 in nums
    assert out['detected_key']['tonic'] == 'A'
    assert [s['label'] for s in out['sections']][0] == 'section_0'


def test_madmom_engine_parses_beats_per_bar_param():
    assert grid_madmom._parse_bpb('3,4') == [3, 4]
    assert grid_madmom._parse_bpb([4]) == [4]
    assert grid_madmom._parse_bpb('garbage') == [3, 4]


def test_madmom_engine_requires_audio():
    with pytest.raises(ValueError):
        grid_madmom.run_madmom_grid(None, {}, {}, _noop)
