"""Schemas for S2..S5 outputs."""
from __future__ import annotations

import pytest

from app.services.pipeline.schemas.onsets import OnsetList
from app.services.pipeline.schemas.pitches import PitchList
from app.services.pipeline.schemas.quantized import QuantizedEvents
from app.services.pipeline.schemas.lanes import LaneEvents


def test_onset_list_strictly_monotonic():
    OnsetList(engine='basic-pitch', params={}, generated_at='2026-05-18T11:00:00Z',
              onsets=[{'time_s': 0.1}, {'time_s': 0.2}])
    with pytest.raises(ValueError, match='monotonic'):
        OnsetList(engine='basic-pitch', params={}, generated_at='2026-05-18T11:00:00Z',
                  onsets=[{'time_s': 0.2}, {'time_s': 0.1}])


def test_pitch_list_polyphony_min_1():
    PitchList(engine='basic-pitch', params={}, generated_at='2026-05-18T11:00:00Z',
              per_onset=[{'time_s': 0.1, 'dominant_midi': 60, 'polyphony': 1}])
    with pytest.raises(ValueError):
        PitchList(engine='basic-pitch', params={}, generated_at='2026-05-18T11:00:00Z',
                  per_onset=[{'time_s': 0.1, 'dominant_midi': 60, 'polyphony': 0}])


def test_quantized_metric_weight_range():
    QuantizedEvents(engine='nearest-grid', params={}, generated_at='2026-05-18T11:00:00Z',
                    events=[{'tick': 0, 'metric_weight': 4, 'dropped': False}])
    with pytest.raises(ValueError):
        QuantizedEvents(engine='nearest-grid', params={}, generated_at='2026-05-18T11:00:00Z',
                        events=[{'tick': 0, 'metric_weight': 5, 'dropped': False}])


def test_lane_events_valid_frets_only():
    LaneEvents(engine='section-sliding', params={}, generated_at='2026-05-18T11:00:00Z',
               lanes=[{'tick': 0, 'frets': [2], 'sustain': 0}])
    with pytest.raises(ValueError, match='frets'):
        LaneEvents(engine='section-sliding', params={}, generated_at='2026-05-18T11:00:00Z',
                   lanes=[{'tick': 0, 'frets': [5], 'sustain': 0}])  # fret 5 not allowed
    with pytest.raises(ValueError, match='adjacent'):
        LaneEvents(engine='section-sliding', params={}, generated_at='2026-05-18T11:00:00Z',
                   lanes=[{'tick': 0, 'frets': [0, 2], 'sustain': 0}])  # non-adjacent chord
