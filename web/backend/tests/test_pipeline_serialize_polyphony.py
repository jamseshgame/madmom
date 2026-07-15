"""The serializer must never emit more than 2 gem notes on a single tick.

Lane engines emit one event per quantized onset, and polyphonic presets
(basic-pitch) quantize several onsets onto the same tick — each contributing
1-2 frets. Stacked, that produced 3-/4-fret chords in published guitar maps.
The serializer clamps every tick to the outer two frets (lowest + highest) as
the final invariant, regardless of which engine produced the events.
"""
from __future__ import annotations

from app.services.pipeline.serialize import _clamp_frets, serialize_chart


def test_clamp_keeps_outer_two_of_three():
    assert _clamp_frets([0, 1, 3]) == [0, 3]


def test_clamp_keeps_outer_two_of_four():
    assert _clamp_frets([1, 2, 3, 4]) == [1, 4]


def test_clamp_leaves_pair_untouched():
    assert _clamp_frets([2, 4]) == [2, 4]


def test_clamp_leaves_single_untouched():
    assert _clamp_frets([2]) == [2]


def test_clamp_drops_open_when_gems_present():
    assert _clamp_frets([7, 2]) == [2]


def test_clamp_keeps_lone_open():
    assert _clamp_frets([7]) == [7]


def test_clamp_dedupes_repeated_lane():
    assert _clamp_frets([3, 3]) == [3]


def _grid():
    return {
        'resolution': 192,
        'tempo_segments': [{'tick_start': 0, 'micro_bpm': 120000}],
        'time_sig_segments': [{'tick_start': 0, 'num': 4, 'denom_pow': 2}],
        'sections': [{'tick_start': 0, 'label': 'song'}],
        'downbeats': [0],
        'audio_duration_s': 5.0,
    }


def test_serialize_clamps_stacked_events_on_same_tick():
    # Two separate events land on tick 100: a [0,1] chord pair + a stray [3].
    # Union {0,1,3} must collapse to the outer two -> N 0 and N 3 only, no N 1.
    lanes = {'lanes': [
        {'tick': 100, 'frets': [0, 1], 'sustain': 0},
        {'tick': 100, 'frets': [3], 'sustain': 0},
    ]}
    text = serialize_chart(grid=_grid(), lanes_per_difficulty={'ExpertSingle': lanes},
                           song_name='X', resolution=192)
    n_lines = [ln.strip() for ln in text.splitlines() if '= N ' in ln and ln.strip().startswith('100')]
    assert n_lines == ['100 = N 0 0', '100 = N 3 0']


def test_serialize_never_exceeds_two_gems_per_tick():
    lanes = {'lanes': [
        {'tick': 50, 'frets': [0], 'sustain': 0},
        {'tick': 50, 'frets': [2], 'sustain': 0},
        {'tick': 50, 'frets': [4], 'sustain': 0},
    ]}
    text = serialize_chart(grid=_grid(), lanes_per_difficulty={'ExpertSingle': lanes},
                           song_name='X', resolution=192)
    n50 = [ln for ln in text.splitlines() if ln.strip().startswith('50 = N ')]
    assert len(n50) == 2


def test_serialize_preserves_sustain_on_kept_frets():
    lanes = {'lanes': [{'tick': 384, 'frets': [0, 1], 'sustain': 96}]}
    text = serialize_chart(grid=_grid(), lanes_per_difficulty={'ExpertSingle': lanes},
                           song_name='X', resolution=192)
    assert '384 = N 0 96' in text
    assert '384 = N 1 96' in text
