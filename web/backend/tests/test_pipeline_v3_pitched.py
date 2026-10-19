"""Tests for the pitched-instrument V3 engines: contour-dp lanes,
phrase-consistency filter, importance-score difficulty."""
from __future__ import annotations

from app.services.pipeline.engines.difficulty_importance import run_importance_score
from app.services.pipeline.engines.lanes_contour import assign_lanes_dp, run_contour_dp
from app.services.pipeline.engines.phrase_consistency import run_phrase_consistency, tokens_for
from app.services.pipeline.schemas.lanes import LaneEvents


def _noop(*a, **k):
    pass


_GRID = {
    'resolution': 192,
    'tempo_segments': [{'tick_start': 0, 'micro_bpm': 120000}],
    'time_sig_segments': [{'tick_start': 0, 'num': 4, 'denom_pow': 2}],
    'downbeats': [0, 768, 1536, 2304],
    'sections': [{'tick_start': 0, 'label': 'song'}],
}


def _quant(seq, **extra):
    """seq: list of (tick, midi) or (tick, midi, dict-of-extra-fields)."""
    events = []
    for item in seq:
        tick, midi = item[0], item[1]
        ev = {'tick': tick, 'metric_weight': 4 if tick % 768 == 0 else 3 if tick % 192 == 0 else 2,
              'dominant_midi': midi, 'polyphony': 1, 'dropped': False, 'time_s_post': tick / 192 * 0.5}
        if len(item) > 2:
            ev.update(item[2])
        ev.update(extra)
        events.append(ev)
    return {'events': events}


def _lanes(out):
    return [e['frets'] for e in out['lanes']]


def test_contour_up_means_up_and_repeated_pitch_keeps_lane():
    seq = [(i * 96, p) for i, p in enumerate([52, 55, 57, 59, 62, 62, 62, 59, 57, 55, 52])]
    out = run_contour_dp(None, {'grid': _GRID, 'quantized': _quant(seq)}, {}, _noop)
    lanes = [f[0] for f in _lanes(out)]
    # Ascending run never steps down, descending never steps up.
    for a, b, pa, pb in zip(lanes, lanes[1:], [p for _, p in seq], [p for _, p in seq][1:]):
        if pb > pa:
            assert b >= a
        elif pb < pa:
            assert b <= a
        else:
            assert a == b
    assert min(lanes) == 0 and max(lanes) == 4  # the riff spans the fretboard
    LaneEvents(**{'engine': 'x', 'params': {}, 'generated_at': 'now', 'lanes': out['lanes']})


def test_same_riff_in_same_register_maps_identically():
    riff = [52, 55, 57, 59, 62, 59, 57, 55]
    seq = [(i * 96, p) for i, p in enumerate(riff * 3)]
    out = run_contour_dp(None, {'grid': _GRID, 'quantized': _quant(seq)}, {}, _noop)
    lanes = [f[0] for f in _lanes(out)]
    assert lanes[0:8] == lanes[8:16]


def test_open_note_for_pitch_far_below_window():
    seq = [(i * 96, p) for i, p in enumerate([64, 66, 67, 69, 67, 66, 64, 40, 40, 64, 66, 67])]
    out = run_contour_dp(None, {'grid': _GRID, 'quantized': _quant(seq)}, {}, _noop)
    lanes = [f[0] for f in _lanes(out)]
    assert lanes[7] == 7 and lanes[8] == 7
    out2 = run_contour_dp(None, {'grid': _GRID, 'quantized': _quant(seq)}, {'allow_open': False}, _noop)
    assert 7 not in [f[0] for f in _lanes(out2)]


def test_chords_from_polyphony_and_sustains_from_duration():
    seq = [
        (0, 52, {'polyphony': 2, 'all_pitches_midi': [52, 59], 'duration_s': 0.9}),   # power chord, held ~1.8 beats
        (384, 55, {'duration_s': 0.1}),                                                 # short
        (576, 57, {'duration_s': 2.0}),                                                 # long, but next note at 768
        (768, 59, {}),
    ]
    out = run_contour_dp(None, {'grid': _GRID, 'quantized': _quant(seq)}, {}, _noop)
    ev0, ev1, ev2, ev3 = out['lanes']
    assert len(ev0['frets']) == 2 and ev0['frets'][1] - ev0['frets'][0] == 1
    assert ev0['sustain'] >= 192          # ≥ 1 beat
    assert ev1['sustain'] == 0            # too short
    assert ev2['sustain'] == 0            # would need ≥ 1 beat but only 192 - gap(48) available
    assert ev3['sustain'] == 0
    LaneEvents(**{'engine': 'x', 'params': {}, 'generated_at': 'now', 'lanes': out['lanes']})


def test_unpitched_events_still_get_lanes():
    seq = [(0, None), (96, None), (192, 60), (288, None)]
    out = run_contour_dp(None, {'grid': _GRID, 'quantized': _quant(seq)}, {}, _noop)
    assert len(out['lanes']) == 4
    assert all(len(e['frets']) == 1 for e in out['lanes'])


def test_assign_lanes_dp_fast_jumps_penalised():
    # Alternating low/high 16ths: without the movement cost the DP would
    # jump 0↔4 every note; with it the spread narrows.
    notes = [{'tick': i * 48, 'midi': 50 if i % 2 == 0 else 62, 'pitches': [50 if i % 2 == 0 else 62],
              'polyphony': 1} for i in range(16)]
    wide = assign_lanes_dp(notes, {'w_move': 0.0, 'allow_open': False}, 192)
    tight = assign_lanes_dp(notes, {'w_move': 6.0, 'allow_open': False}, 192)
    assert max(abs(a - b) for a, b in zip(wide, wide[1:])) >= 3
    assert max(abs(a - b) for a, b in zip(tight, tight[1:])) <= 2


def test_phrase_consistency_copies_earlier_lanes():
    riff = [52, 55, 57, 59, 62, 59, 57, 55]
    seq = [(i * 96, p) for i, p in enumerate(riff + riff + [p + 12 for p in riff])]
    dp = run_contour_dp(None, {'grid': _GRID, 'quantized': _quant(seq)}, {}, _noop)
    # Scramble the second and third occurrences to prove the copy happens.
    for ev in dp['lanes'][8:]:
        ev['frets'] = [(ev['frets'][0] + 2) % 5]
    out = run_phrase_consistency(None, {'grid': _GRID, 'lanes_expert': dp}, {}, _noop)
    lanes = [e['frets'] for e in out['lanes']]
    assert lanes[0:8] == lanes[8:16] == lanes[16:24]
    assert len(out['edits']) > 0 and out['edits'][0]['reason'] == 'repeated_phrase'
    assert out['metric_weights'] == dp['metric_weights']


def test_phrase_consistency_is_noop_without_pitch_or_repeats():
    lanes = {'lanes': [{'tick': i * 96, 'frets': [i % 5], 'sustain': 0} for i in range(12)], 'metric_weights': {}}
    out = run_phrase_consistency(None, {'grid': _GRID, 'lanes_expert': lanes}, {}, _noop)
    assert out['edits'] == [] and [e['frets'] for e in out['lanes']] == [[i % 5] for i in range(12)]
    toks = tokens_for(lanes['lanes'], 192, True)
    assert all(t is None for t in toks)


def test_importance_score_respects_density_targets_and_floors():
    # 16th-note run for 4 bars = 64 notes over 8 s at 120 BPM.
    lanes = [{'tick': i * 48, 'frets': [i % 5], 'sustain': 0, 'velocity': 0.5 + 0.5 * (i % 4 == 0)}
             for i in range(64)]
    weights = {str(i * 48): (4 if i % 16 == 0 else 3 if i % 4 == 0 else 2 if i % 2 == 0 else 1) for i in range(64)}
    out = run_importance_score(None, {'grid': _GRID, 'lanes_filtered': {'lanes': lanes, 'metric_weights': weights}},
                               {}, _noop)
    bd = out['by_difficulty']
    n_easy, n_med, n_hard = (len(bd[d]['lanes']) for d in ('easy', 'medium', 'hard'))
    assert n_easy < n_med < n_hard <= 64
    assert n_easy <= 1.8 * 8 + 1 and n_med <= 3.5 * 8 + 1 and n_hard <= 6.0 * 8 + 1
    # Easy keeps only beats (weight ≥ 3), medium only 8ths and stronger.
    assert all(int(weights[str(e['tick'])]) >= 3 for e in bd['easy']['lanes'])
    assert all(int(weights[str(e['tick'])]) >= 2 for e in bd['medium']['lanes'])
    # Downbeats (highest importance) survive into Easy.
    easy_ticks = {e['tick'] for e in bd['easy']['lanes']}
    assert {0, 768, 1536, 2304} <= easy_ticks


def test_importance_score_caps_chords_on_easy():
    lanes = [{'tick': 0, 'frets': [1, 2], 'sustain': 0}, {'tick': 768, 'frets': [2, 3], 'sustain': 0}]
    upstream = {'grid': _GRID, 'lanes_filtered': {'lanes': lanes, 'metric_weights': {'0': 4, '768': 4}}}
    out = run_importance_score(None, upstream, {}, _noop)
    assert all(len(e['frets']) == 1 for e in out['by_difficulty']['easy']['lanes'])
    assert all(len(e['frets']) == 2 for e in out['by_difficulty']['hard']['lanes'])
