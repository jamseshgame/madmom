"""Tests for S5 lane mapping engines."""
from __future__ import annotations

import pytest

from app.services.pipeline.engines.lanes_engines import (
    run_section_sliding, run_global_percentile, run_key_relative,
)


def _noop(*a, **k): pass

_GRID = {
    'resolution': 192,
    'sections': [{'tick_start': 0, 'label': 'verse'}],
    'tempo_segments': [{'tick_start': 0, 'micro_bpm': 120000}],
    'time_sig_segments': [{'tick_start': 0, 'num': 4, 'denom_pow': 2}],
    'downbeats': [0, 768],
    'audio_duration_s': 10.0,
    'detected_key': {'tonic': 'E', 'mode': 'minor', 'confidence': 0.8},
}


def _quantized(midis_at_ticks):
    return {'events': [
        {'tick': t, 'metric_weight': 3, 'dominant_midi': m, 'polyphony': 1, 'dropped': False}
        for t, m in midis_at_ticks
    ]}


def test_section_sliding_spans_lanes_0_to_4():
    out = run_section_sliding(
        audio_path=None,
        upstream={'grid': _GRID, 'quantized': _quantized([(0, 50), (192, 55), (384, 60), (576, 65), (768, 70)])},
        params={},
        on_progress=_noop,
    )
    frets = [tuple(l['frets']) for l in out['lanes']]
    flat = [f for tup in frets for f in tup]
    assert set(flat) == {0, 1, 2, 3, 4}


def test_chord_pair_when_polyphony_3_plus():
    quant = {'events': [
        {'tick': 0, 'metric_weight': 4, 'dominant_midi': 60, 'polyphony': 3, 'dropped': False},
    ]}
    out = run_section_sliding(
        audio_path=None,
        upstream={'grid': _GRID, 'quantized': quant},
        params={'chord_polyphony_threshold': 3},
        on_progress=_noop,
    )
    assert len(out['lanes']) == 1
    assert len(out['lanes'][0]['frets']) == 2


def test_open_lane_for_outliers():
    quant = _quantized([(0, 40), (192, 60), (384, 60), (576, 60), (768, 100)])
    out = run_section_sliding(
        audio_path=None,
        upstream={'grid': _GRID, 'quantized': quant},
        params={'open_low_percentile': 10, 'open_high_percentile': 90},
        on_progress=_noop,
    )
    frets = [tuple(l['frets']) for l in out['lanes']]
    assert (7,) in frets
