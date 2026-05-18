"""Tests for the manual grid engine."""
from __future__ import annotations

from pathlib import Path

import pytest

from app.services.pipeline.engines.grid_manual import run_manual_grid
from app.services.pipeline.schemas.grid import SongGrid


def _noop(step, pct, msg):
    pass


def test_manual_grid_constant_120bpm():
    payload = run_manual_grid(
        audio_path=None,
        upstream={},
        params={'bpm': 120.0, 'audio_duration_s': 60.0, 'time_sig_num': 4},
        on_progress=_noop,
    )
    g = SongGrid(**payload)
    assert g.tempo_segments[0].micro_bpm == 120000
    assert g.time_sig_segments[0].num == 4
    # 120 BPM, 60s → 120 beats → 30 bars in 4/4 → 30 downbeats (incl. 0)
    assert len(g.downbeats) == 30


def test_manual_grid_offset_shifts_first_downbeat():
    payload = run_manual_grid(
        audio_path=None,
        upstream={},
        params={'bpm': 120.0, 'audio_duration_s': 60.0, 'time_sig_num': 4, 'offset_s': 0.5},
        on_progress=_noop,
    )
    # Offset 0.5s at 120BPM (0.5s/beat) → first downbeat is at beat 1, not 0
    # We expect downbeats to start at the offset translated to ticks.
    assert payload['downbeats'][0] > 0


def test_manual_grid_requires_bpm():
    with pytest.raises(ValueError, match='bpm'):
        run_manual_grid(
            audio_path=None, upstream={},
            params={'audio_duration_s': 60.0},
            on_progress=_noop,
        )
