"""Unit tests for the class-aware drum detector and the drum engines."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from synth_drums import render_pattern, rock_beat  # noqa: E402

from app.services.pipeline.drum_detect import GM_FOR_CLASS, detect_drum_hits, merge_hits
from app.services.pipeline.engines.drums_engines import (
    DEFAULT_DRUM_DIFFICULTY, gm_to_lane, run_drum_class, run_drum_class_removal, run_drum_gm_lanes,
)


def _noop(*a, **k):
    pass


def _score(ref: list[float], got: list[float], tol: float = 0.03) -> tuple[int, int, int]:
    tp = sum(1 for r in ref if any(abs(r - g) <= tol for g in got))
    fp = sum(1 for g in got if not any(abs(r - g) <= tol for r in ref))
    return tp, len(ref), fp


def test_detector_separates_simultaneous_kick_and_hat():
    hits = rock_beat(bars=4, bpm=120)
    det = detect_drum_hits(render_pattern(hits), 22050)
    kick_tp, kick_n, kick_fp = _score([t for t, c in hits if c == 'kick'], [h.time_s for h in det['kick']])
    snare_tp, snare_n, snare_fp = _score([t for t, c in hits if c == 'snare'], [h.time_s for h in det['snare']])
    hat_tp, hat_n, _hat_fp = _score([t for t, c in hits if c == 'hihat'], [h.time_s for h in det['hihat']])
    cym_tp, cym_n, _ = _score([t for t, c in hits if c == 'cymbal'], [h.time_s for h in det['cymbal']])
    assert kick_tp == kick_n and kick_fp == 0
    assert snare_tp == snare_n and snare_fp <= 1
    assert hat_tp / hat_n >= 0.75
    assert cym_tp == cym_n
    # The old single-onset path could not produce this: a kick and a hat at
    # the same instant as two separate hits.
    assert any(abs(h.time_s - 1.5) <= 0.03 for h in det['kick'])
    assert any(abs(h.time_s - 1.5) <= 0.03 for h in det['hihat'])


def test_detector_handles_silence_and_short_input():
    assert detect_drum_hits(np.zeros(10, dtype=np.float32), 22050) == {c: [] for c in GM_FOR_CLASS}
    det = detect_drum_hits(np.zeros(22050 * 3, dtype=np.float32), 22050)
    assert sum(len(v) for v in det.values()) == 0


def test_merge_hits_is_strictly_monotonic_and_keeps_classes():
    det = detect_drum_hits(render_pattern(rock_beat(bars=2)), 22050)
    merged = merge_hits(det, merge_ms=15)
    times = [m['time_s'] for m in merged]
    assert all(b > a for a, b in zip(times, times[1:]))
    first = merged[0]
    assert abs(first['time_s'] - 0.5) <= 0.03
    assert 'kick' in first['classes'] and 'cymbal' in first['classes']


def test_drum_class_attaches_gm_numbers():
    onsets = {'onsets': [{'time_s': 1.0}, {'time_s': 2.0}, {'time_s': 3.0}],
              'drum_classes': {'kick': [{'time_s': 1.01, 'velocity': 0.9}],
                               'hihat': [{'time_s': 0.99, 'velocity': 0.4}, {'time_s': 2.0, 'velocity': 0.5}],
                               'snare': [], 'tom': [], 'cymbal': []}}
    out = run_drum_class(None, {'onsets': onsets}, {}, _noop)
    a, b, c = out['per_onset']
    assert a['all_pitches_midi'] == [36, 42] and a['dominant_midi'] == 36 and a['polyphony'] == 2
    assert b['all_pitches_midi'] == [42]
    assert c['dominant_midi'] is None and c['all_pitches_midi'] == []


def test_gm_to_lane_mapping():
    assert gm_to_lane(36) == 0 and gm_to_lane(38) == 1 and gm_to_lane(42) == 2
    assert gm_to_lane(45) == 3 and gm_to_lane(49) == 4 and gm_to_lane(51) == 4
    assert gm_to_lane(41) == 5 and gm_to_lane(41, floor_tom_lane5=False) == 3  # floor tom → green pad
    assert gm_to_lane(60) is None


def test_drum_gm_lanes_emits_one_event_per_class_per_tick():
    quant = {'events': [
        {'tick': 0, 'metric_weight': 4, 'all_pitches_midi': [36, 42, 49], 'polyphony': 3, 'dropped': False},
        {'tick': 96, 'metric_weight': 2, 'all_pitches_midi': [42], 'polyphony': 1, 'dropped': False},
        {'tick': 192, 'metric_weight': 3, 'dominant_midi': 38, 'polyphony': 1, 'dropped': False},
        {'tick': 288, 'metric_weight': 2, 'all_pitches_midi': [], 'polyphony': 1, 'dropped': False},
        {'tick': 300, 'metric_weight': 0, 'all_pitches_midi': [36], 'dropped': True},
    ]}
    out = run_drum_gm_lanes(None, {'quantized': quant}, {}, _noop)
    got = [(e['tick'], e['frets']) for e in out['lanes']]
    assert got == [(0, [0]), (0, [2]), (0, [4]), (96, [2]), (192, [1])]
    assert out['metric_weights']['0'] == 4
    out2 = run_drum_gm_lanes(None, {'quantized': quant}, {'unknown_to_snare': True}, _noop)
    assert (288, [1]) in [(e['tick'], e['frets']) for e in out2['lanes']]


def test_drum_class_removal_steps_down_like_a_human_chart():
    lanes = []
    weights = {}
    # Bar of 4/4 at res 192: kick on 1&3, snare 2&4, hats on 8ths, crash on 1.
    for beat in range(4):
        tick = beat * 192
        weights[str(tick)] = 4 if beat == 0 else 3
        weights[str(tick + 96)] = 2
        lanes.append({'tick': tick, 'frets': [0 if beat % 2 == 0 else 1], 'sustain': 0})
        lanes.append({'tick': tick, 'frets': [2], 'sustain': 0})
        lanes.append({'tick': tick + 96, 'frets': [2], 'sustain': 0})
    lanes.append({'tick': 0, 'frets': [4], 'sustain': 0})
    lanes.sort(key=lambda e: e['tick'])
    out = run_drum_class_removal(None, {'lanes_filtered': {'lanes': lanes, 'metric_weights': weights}}, {}, _noop)
    bd = out['by_difficulty']
    easy = [(e['tick'], e['frets'][0]) for e in bd['easy']['lanes']]
    medium = [(e['tick'], e['frets'][0]) for e in bd['medium']['lanes']]
    hard = [(e['tick'], e['frets'][0]) for e in bd['hard']['lanes']]
    # Harmonix-derived policy: Easy keeps snare + hats + crash on beats, kick
    # only on downbeats; Medium keeps beat-position notes of every class;
    # Hard keeps 8ths but drops 16ths.
    assert (0, 0) in easy and (384, 0) not in easy          # kick: downbeat only
    assert (192, 1) in easy and (576, 1) in easy            # snares on beats
    assert (0, 2) in easy and (96, 2) not in easy           # hats on beats, not 8ths
    assert (0, 4) in easy                                   # crash on the downbeat
    assert (96, 2) not in medium and (0, 2) in medium and (384, 0) in medium
    assert len(hard) == len(lanes)                          # nothing here is a 16th
    assert DEFAULT_DRUM_DIFFICULTY['easy']['2'] == 3 and DEFAULT_DRUM_DIFFICULTY['hard']['0'] == 2


def test_hard_drops_sixteenths():
    lanes = [{'tick': 0, 'frets': [2], 'sustain': 0}, {'tick': 48, 'frets': [2], 'sustain': 0},
             {'tick': 96, 'frets': [2], 'sustain': 0}]
    weights = {'0': 4, '48': 1, '96': 2}
    out = run_drum_class_removal(None, {'lanes_filtered': {'lanes': lanes, 'metric_weights': weights}}, {}, _noop)
    assert [e['tick'] for e in out['by_difficulty']['hard']['lanes']] == [0, 96]
    assert [e['tick'] for e in out['by_difficulty']['medium']['lanes']] == [0]


def test_tom_fundamentals_and_floor_split():
    from app.services.pipeline.engines.drums_engines import split_floor_toms, tom_fundamentals
    sr = 22050
    y = np.zeros(sr * 2, dtype=np.float32)
    hits = [(0.2, 80.0), (0.6, 80.0), (1.0, 180.0), (1.4, 180.0)]
    for t, f in hits:
        n = int(0.25 * sr)
        i = int(t * sr)
        y[i:i + n] += (0.8 * np.sin(2 * np.pi * f * np.arange(n) / sr) * np.exp(-np.arange(n) / (0.12 * sr))).astype(np.float32)
    f0s = tom_fundamentals(y, sr, [t for t, _ in hits] + [1.9])
    assert f0s[4] is None  # silence
    for (_, f), got in zip(hits, f0s):
        assert abs(got - f) < 6
    assert split_floor_toms(f0s[:4], 115) == [True, True, False, False]
    # Adaptive: a bimodal set is split between the modes even with an off threshold.
    many = [78.0, 82.0, 80.0, 79.0, 81.0, 83.0] * 2 + [170.0, 175.0, 180.0, 172.0, 178.0, 176.0] * 2
    assert split_floor_toms(many, 250) == [True] * 12 + [False] * 12


def test_drum_class_assigns_floor_tom_gm(tmp_path, monkeypatch):
    from app.services.pipeline.engines import drums_engines
    monkeypatch.setattr(drums_engines, 'load_audio', lambda p, target_sr=22050, mono=True: (np.zeros(10), 22050))
    monkeypatch.setattr(drums_engines, 'tom_fundamentals', lambda y, sr, times: [80.0, 190.0])
    onsets = {'onsets': [{'time_s': 1.0}, {'time_s': 2.0}],
              'drum_classes': {'tom': [{'time_s': 1.0, 'velocity': 1}, {'time_s': 2.0, 'velocity': 1}],
                               'kick': [], 'snare': [], 'hihat': [], 'cymbal': []}}
    out = run_drum_class(Path('drums.ogg'), {'onsets': onsets}, {}, _noop)
    assert out['per_onset'][0]['all_pitches_midi'] == [41]   # floor tom
    assert out['per_onset'][1]['all_pitches_midi'] == [45]   # rack tom
    quant = {'events': [{'tick': 0, 'metric_weight': 3, 'all_pitches_midi': [41], 'dropped': False},
                        {'tick': 192, 'metric_weight': 3, 'all_pitches_midi': [45], 'dropped': False}]}
    lanes = run_drum_gm_lanes(None, {'quantized': quant}, {}, _noop)['lanes']
    assert [e['frets'][0] for e in lanes] == [5, 3]
