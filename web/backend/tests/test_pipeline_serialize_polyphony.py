"""The serializer must never emit more than 2 gem notes on a single tick, and
never a gap-spanning ("wide") chord.

Lane engines emit one event per quantized onset, and polyphonic presets
(basic-pitch) quantize several onsets onto the same tick — each contributing
1-2 frets. Stacked, that produced 3-/4-fret chords in published guitar maps;
clamping to the outer two frets then produced gap-spanning chords like
yellow+orange (2,4) that content reviewers flagged as awkward/unplayable.

The final invariant for guitar is now: every tick keeps at most the *lowest
adjacent pair* of gems (the genuine chords the lane engine emits are already
adjacent). A same-tick set with no adjacent pair is a quantization collision,
not a real chord, so it collapses to its root (lowest) gem.

Drums are the exception: a same-tick set there is a real simultaneous multi-pad
hit (kick+cymbal etc.), not an artifact, so with collapse_wide=False the clamp
only caps the tick at two gems (outer two) and allows non-adjacent pairs.
"""
from __future__ import annotations

from app.services.pipeline.serialize import _clamp_frets, serialize_chart


def test_clamp_keeps_lowest_adjacent_pair_of_three():
    assert _clamp_frets([0, 1, 3]) == [0, 1]


def test_clamp_keeps_lowest_adjacent_pair_of_four():
    assert _clamp_frets([1, 2, 3, 4]) == [1, 2]


def test_clamp_collapses_gapped_pair_to_root():
    assert _clamp_frets([2, 4]) == [2]


def test_clamp_collapses_wide_pair_to_root():
    assert _clamp_frets([0, 4]) == [0]


def test_clamp_collapses_all_gapped_set_to_root():
    assert _clamp_frets([0, 2, 4]) == [0]


def test_clamp_leaves_adjacent_pair_untouched():
    assert _clamp_frets([1, 2]) == [1, 2]


def test_clamp_leaves_single_untouched():
    assert _clamp_frets([2]) == [2]


def test_clamp_drops_open_when_gems_present():
    assert _clamp_frets([7, 2]) == [2]


def test_clamp_keeps_lone_open():
    assert _clamp_frets([7]) == [7]


def test_clamp_dedupes_repeated_lane():
    assert _clamp_frets([3, 3]) == [3]


# Drum branch (collapse_wide=False): cap at two gems, allow non-adjacent pairs.
def test_clamp_drums_keeps_gapped_pair():
    assert _clamp_frets([2, 4], collapse_wide=False) == [2, 4]


def test_clamp_drums_keeps_wide_pair():
    assert _clamp_frets([0, 4], collapse_wide=False) == [0, 4]


def test_clamp_drums_caps_three_to_outer_two():
    assert _clamp_frets([0, 2, 4], collapse_wide=False) == [0, 4]


def test_clamp_drums_leaves_adjacent_pair_untouched():
    assert _clamp_frets([1, 2], collapse_wide=False) == [1, 2]


def test_clamp_drums_still_dedupes_and_handles_open():
    assert _clamp_frets([3, 3], collapse_wide=False) == [3]
    assert _clamp_frets([7], collapse_wide=False) == [7]


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
    # Union {0,1,3} keeps the lowest adjacent pair -> N 0 and N 1 only, no N 3.
    lanes = {'lanes': [
        {'tick': 100, 'frets': [0, 1], 'sustain': 0},
        {'tick': 100, 'frets': [3], 'sustain': 0},
    ]}
    text = serialize_chart(grid=_grid(), lanes_per_difficulty={'ExpertSingle': lanes},
                           song_name='X', resolution=192)
    n_lines = [ln.strip() for ln in text.splitlines() if '= N ' in ln and ln.strip().startswith('100')]
    assert n_lines == ['100 = N 0 0', '100 = N 1 0']


def test_serialize_collapses_wide_collision_to_single_gem():
    # Three lone gems collide on tick 50 spanning {0,2,4} with no adjacent pair.
    # This is a quantization collision, not a chord -> collapse to the root.
    lanes = {'lanes': [
        {'tick': 50, 'frets': [0], 'sustain': 0},
        {'tick': 50, 'frets': [2], 'sustain': 0},
        {'tick': 50, 'frets': [4], 'sustain': 0},
    ]}
    text = serialize_chart(grid=_grid(), lanes_per_difficulty={'ExpertSingle': lanes},
                           song_name='X', resolution=192)
    n50 = [ln.strip() for ln in text.splitlines() if ln.strip().startswith('50 = N ')]
    assert n50 == ['50 = N 0 0']


def test_serialize_preserves_sustain_on_kept_frets():
    lanes = {'lanes': [{'tick': 384, 'frets': [0, 1], 'sustain': 96}]}
    text = serialize_chart(grid=_grid(), lanes_per_difficulty={'ExpertSingle': lanes},
                           song_name='X', resolution=192)
    assert '384 = N 0 96' in text
    assert '384 = N 1 96' in text


def test_serialize_drums_keep_simultaneous_hits():
    # collapse_wide=False (drums): a kick+cymbal {0,3} collision on one tick is a
    # real simultaneous hit and must survive as a two-gem non-adjacent chord.
    lanes = {'lanes': [
        {'tick': 200, 'frets': [0], 'sustain': 0},
        {'tick': 200, 'frets': [3], 'sustain': 0},
    ]}
    text = serialize_chart(grid=_grid(), lanes_per_difficulty={'ExpertSingle': lanes},
                           song_name='X', resolution=192, collapse_wide=False)
    n200 = [ln.strip() for ln in text.splitlines() if ln.strip().startswith('200 = N ')]
    assert n200 == ['200 = N 0 0', '200 = N 3 0']
