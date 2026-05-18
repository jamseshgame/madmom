"""Tests for the SongGrid pydantic schema."""
from __future__ import annotations

import pytest

from app.services.pipeline.schemas.grid import (
    SongGrid,
    TempoSegment,
    TimeSigSegment,
    Section,
    DetectedKey,
)


def _valid_payload():
    return {
        'engine': 'manual',
        'params': {},
        'audio_duration_s': 213.4,
        'resolution': 192,
        'tempo_segments': [{'tick_start': 0, 'micro_bpm': 120000, 'label': 'main'}],
        'time_sig_segments': [{'tick_start': 0, 'num': 4, 'denom_pow': 2}],
        'downbeats': [0, 768, 1536, 2304],
        'sections': [{'tick_start': 0, 'label': 'intro'}],
        'detected_key': None,
        'generated_at': '2026-05-18T11:22:03Z',
    }


def test_parses_valid_payload():
    g = SongGrid(**_valid_payload())
    assert g.tempo_segments[0].micro_bpm == 120000
    assert g.time_sig_segments[0].num == 4


def test_rejects_decreasing_tempo_segments():
    p = _valid_payload()
    p['tempo_segments'] = [
        {'tick_start': 100, 'micro_bpm': 120000},
        {'tick_start': 50,  'micro_bpm': 130000},
    ]
    with pytest.raises(ValueError, match='tick_start must be strictly increasing'):
        SongGrid(**p)


def test_rejects_micro_bpm_out_of_range():
    p = _valid_payload()
    p['tempo_segments'][0]['micro_bpm'] = 39_999
    with pytest.raises(ValueError, match='micro_bpm'):
        SongGrid(**p)


def test_rejects_tempo_segment_not_on_downbeat():
    p = _valid_payload()
    p['tempo_segments'] = [
        {'tick_start': 0,   'micro_bpm': 120000},
        {'tick_start': 500, 'micro_bpm': 130000},  # not a downbeat
    ]
    with pytest.raises(ValueError, match='downbeat'):
        SongGrid(**p)


def test_detected_key_optional():
    p = _valid_payload()
    p['detected_key'] = {'tonic': 'E', 'mode': 'minor', 'confidence': 0.84}
    g = SongGrid(**p)
    assert g.detected_key.tonic == 'E'
