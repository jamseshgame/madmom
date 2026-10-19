"""Tests for the serializer's Pro Drums mode (`drums=True`)."""
from __future__ import annotations

from app.services.pipeline.serialize import _clamp_drum_lanes, serialize_chart


_GRID = {
    'resolution': 192,
    'tempo_segments': [{'tick_start': 0, 'micro_bpm': 120000}],
    'time_sig_segments': [{'tick_start': 0, 'num': 4, 'denom_pow': 2}],
    'sections': [{'tick_start': 0, 'label': 'song'}],
    'downbeats': [0, 768],
    'audio_duration_s': 10.0,
}


def _section(text: str, name: str = 'ExpertSingle') -> list[str]:
    body = text.split(f'[{name}]')[1].split('}')[0]
    return [ln.strip() for ln in body.splitlines() if '=' in ln]


def test_hihat_and_cymbal_lanes_emit_modifiers():
    lanes = {'lanes': [
        {'tick': 0, 'frets': [2], 'sustain': 0},
        {'tick': 192, 'frets': [4], 'sustain': 0},
        {'tick': 384, 'frets': [3], 'sustain': 0},
    ]}
    rows = _section(serialize_chart(_GRID, {'ExpertSingle': lanes}, 'x', 192, drums=True))
    assert '0 = N 2 0' in rows and '0 = N 66 0' in rows
    assert '192 = N 4 0' in rows and '192 = N 68 0' in rows
    assert '384 = N 3 0' in rows
    assert not any(r.startswith('384 = N 6') for r in rows)  # tom: no modifier


def test_floor_tom_is_bare_green_pad():
    lanes = {'lanes': [{'tick': 0, 'frets': [5], 'sustain': 0}]}
    rows = _section(serialize_chart(_GRID, {'ExpertSingle': lanes}, 'x', 192, drums=True))
    assert rows == ['0 = N 4 0']


def test_same_tick_events_union_into_kick_plus_pads():
    lanes = {'lanes': [
        {'tick': 0, 'frets': [0], 'sustain': 0},
        {'tick': 0, 'frets': [1], 'sustain': 0},
        {'tick': 0, 'frets': [2], 'sustain': 0},
    ]}
    rows = _section(serialize_chart(_GRID, {'ExpertSingle': lanes}, 'x', 192, drums=True))
    assert set(rows) == {'0 = N 0 0', '0 = N 1 0', '0 = N 2 0', '0 = N 66 0'}


def test_more_than_two_pads_drops_hihat_first_and_keeps_kick():
    assert _clamp_drum_lanes([0, 1, 2, 4]) == [0, 1, 4]
    assert _clamp_drum_lanes([1, 2, 3, 4]) == [1, 4]  # hat then tom dropped
    assert len([l for l in _clamp_drum_lanes([0, 1, 2, 3, 4]) if l != 0]) == 2
    assert 0 in _clamp_drum_lanes([0, 1, 2, 3, 4])


def test_cymbal_beats_floor_tom_on_shared_green_pad():
    assert _clamp_drum_lanes([4, 5]) == [4]


def test_drum_sustains_are_dropped():
    lanes = {'lanes': [{'tick': 0, 'frets': [1], 'sustain': 192}]}
    rows = _section(serialize_chart(_GRID, {'ExpertSingle': lanes}, 'x', 192, drums=True))
    assert rows == ['0 = N 1 0']


def test_guitar_mode_unchanged_by_default():
    lanes = {'lanes': [{'tick': 0, 'frets': [2], 'sustain': 96}]}
    rows = _section(serialize_chart(_GRID, {'ExpertSingle': lanes}, 'x', 192))
    assert rows == ['0 = N 2 96']
