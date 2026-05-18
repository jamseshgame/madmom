"""Tests for S4 quantization engines."""
from __future__ import annotations

import pytest

from app.services.pipeline.engines.quantized_engines import (
    run_nearest_grid,
    run_strong_beat_priority,
    run_metric_weighted,
)


def _noop(*a, **k): pass


_GRID_120BPM = {
    'resolution': 192,
    'tempo_segments': [{'tick_start': 0, 'micro_bpm': 120000}],
    'time_sig_segments': [{'tick_start': 0, 'num': 4, 'denom_pow': 2}],
    'downbeats': [0, 768, 1536, 2304, 3072, 3840],
    'sections': [{'tick_start': 0, 'label': 'song'}],
    'audio_duration_s': 20.0,
}


def _pitches(times_s):
    return {'per_onset': [{'time_s': t, 'dominant_midi': 60, 'polyphony': 1, 'all_pitches_midi': [60]}
                          for t in times_s]}


def test_nearest_grid_snaps_to_16th():
    out = run_nearest_grid(
        audio_path=None,
        upstream={'grid': _GRID_120BPM, 'pitches': _pitches([0.01, 0.51, 1.02])},
        params={'max_division': 16},
        on_progress=_noop,
    )
    ticks = [e['tick'] for e in out['events']]
    assert ticks == [0, 192, 384]


def test_nearest_grid_drops_far_from_grid():
    out = run_nearest_grid(
        audio_path=None,
        upstream={'grid': _GRID_120BPM, 'pitches': _pitches([0.41])},
        params={'max_division': 16, 'max_snap_distance_ms': 20},
        on_progress=_noop,
    )
    kept = [e for e in out['events'] if not e['dropped']]
    assert kept == []


def test_metric_weight_assignment():
    out = run_metric_weighted(
        audio_path=None,
        upstream={'grid': _GRID_120BPM, 'pitches': _pitches([
            0.0,    # downbeat → 4
            0.5,    # beat → 3
            0.75,   # 8th offbeat → 2
            0.625,  # 16th → 1
        ])},
        params={'max_division': 16},
        on_progress=_noop,
    )
    weights = [e['metric_weight'] for e in out['events']]
    assert weights == [4, 3, 2, 1]
