"""Tests for the beat-anchored grid builder (beat_grid.beats_to_grid).

The invariant that matters: every detected beat lands on a tick that is a
multiple of `resolution`, and the tempo map reproduces its wall-clock time
to within the merge tolerance — so downbeats are on the grid and the
quantizer's metric weights are meaningful."""
from __future__ import annotations

import numpy as np

from app.services.pipeline.beat_grid import beats_to_grid, positions_to_downbeat_indices, smooth_beat_times
from app.services.pipeline.engines.quantized_engines import _compute_metric_weight, _snap_to_grid
from app.services.pipeline.tempo_math import build_tempo_segments, tick_to_seconds


def _segments(grid):
    return build_tempo_segments(
        [{'tick': s['tick_start'], 'micro_bpm': s['micro_bpm']} for s in grid['tempo_segments']],
        grid['resolution'],
    )


def _max_beat_error_ms(grid, beat_times):
    segs = _segments(grid)
    errs = [abs(tick_to_seconds(t, segs, grid['resolution']) - bt) * 1000
            for t, bt in zip(grid['beat_ticks'], beat_times)]
    return max(errs)


def test_realistic_librosa_beats_land_on_grid():
    # 120 BPM song, first beat at 0.35 s, beat times frame-quantized the way
    # librosa reports them (hop 512 @ 22050), slightly jittered.
    hop = 512 / 22050
    true = 0.35 + np.arange(240) * 0.5
    beats = np.round(true / hop) * hop
    grid = beats_to_grid(beats, audio_duration_s=125.0)

    assert all(t % 192 == 0 for t in grid['beat_ticks'])
    assert all(t % 192 == 0 for t in grid['downbeats'])
    # Jitter smoothing (default 30 ms) lands the grid on the *true* beats,
    # closer than the frame-quantized input it was given.
    assert _max_beat_error_ms(grid, true) <= 5.0 + 1e-6
    assert _max_beat_error_ms(grid, beats) <= 30.0 + 1e-6
    raw = beats_to_grid(beats, audio_duration_s=125.0, smooth_tol_ms=0)
    assert _max_beat_error_ms(raw, beats) <= 5.0 + 1e-6
    assert len(grid['tempo_segments']) < len(raw['tempo_segments'])
    # Lead-in: 0.35 s ≈ 1 beat at 120 BPM → first beat at tick 192.
    assert grid['lead_in_beats'] == 1
    assert grid['beat_ticks'][0] == 192


def test_on_beat_onsets_get_beat_and_downbeat_weights():
    hop = 512 / 22050
    true = 0.35 + np.arange(240) * 0.5
    beats = np.round(true / hop) * hop
    grid = beats_to_grid(beats, audio_duration_s=125.0)
    segs = _segments(grid)
    weights = []
    for t in beats[:200]:
        tick, _ = _snap_to_grid(float(t), segs, 192, 16)
        weights.append(_compute_metric_weight(tick, grid))
    # Every real beat is a beat (3) or a downbeat (4) — never a 16th (1).
    assert set(weights) <= {3, 4}
    assert weights.count(4) == 50  # every 4th of 200


def test_tempo_ramp_tracks_each_beat():
    # Accelerando 100 → 140 BPM over 120 beats.
    bpms = np.linspace(100, 140, 120)
    beats = np.concatenate([[0.5], 0.5 + np.cumsum(60.0 / bpms[:-1])])
    grid = beats_to_grid(beats, audio_duration_s=beats[-1] + 2, merge_tol_ms=3.0, smooth_tol_ms=0)
    assert _max_beat_error_ms(grid, beats) <= 3.0 + 1e-6
    # A ramp cannot be merged into a single segment.
    assert len(grid['tempo_segments']) > 5
    # With smoothing the ramp is still a ramp, just approximated within tolerance.
    smooth = beats_to_grid(beats, audio_duration_s=beats[-1] + 2, merge_tol_ms=3.0, smooth_tol_ms=30)
    assert _max_beat_error_ms(smooth, beats) <= 30.0 + 1e-6
    assert len(smooth['tempo_segments']) > 3


def test_constant_tempo_merges_to_few_segments():
    beats = 0.5 + np.arange(200) * 0.5
    grid = beats_to_grid(beats, audio_duration_s=101.0)
    # lead-in + one main segment
    assert len(grid['tempo_segments']) <= 3
    assert grid['tempo_segments'][-1]['micro_bpm'] == 120000


def test_first_beat_near_zero_is_pinned_to_tick_zero():
    beats = 0.02 + np.arange(50) * 0.5
    grid = beats_to_grid(beats, audio_duration_s=26.0)
    assert grid['lead_in_beats'] == 0
    assert grid['beat_ticks'][0] == 0
    assert grid['tempo_segments'][0]['tick_start'] == 0
    # Beat 2 onward still exact.
    segs = _segments(grid)
    assert abs(tick_to_seconds(192, segs, 192) - beats[1]) < 0.005


def test_downbeat_indices_and_time_signature_changes():
    beats = 0.5 + np.arange(28) * 0.5
    # 3 bars of 4/4 then 4 bars of 3/4 (beats 0,4,8,12 then 15,18,21,24,27)
    db = [0, 4, 8, 12, 15, 18, 21, 24, 27]
    grid = beats_to_grid(beats, audio_duration_s=16.0, downbeat_indices=db)
    assert grid['downbeats'] == [grid['beat_ticks'][i] for i in db]
    ts = grid['time_sig_segments']
    nums = [(s['tick_start'], s['num']) for s in ts]
    # pickup bar (1 lead-in beat), then 4/4 at first downbeat, then 3/4 at beat 12
    assert nums[0][0] == 0
    assert any(n == 4 for _, n in nums)
    assert any(n == 3 for _, n in nums)
    first_three = next(t for t, n in nums if n == 3)
    assert first_three == grid['beat_ticks'][12]


def test_sections_snap_to_downbeats_and_start_at_zero():
    beats = 0.5 + np.arange(64) * 0.5
    grid = beats_to_grid(beats, audio_duration_s=33.0,
                         section_times=[0.0, 8.7, 16.4], section_labels=['intro', 'verse', 'chorus'])
    ticks = [s['tick_start'] for s in grid['sections']]
    assert ticks[0] == 0
    assert all(t in set(grid['downbeats']) or t == 0 for t in ticks)
    assert [s['label'] for s in grid['sections']][1:] == ['verse', 'chorus']


def test_positions_to_downbeat_indices():
    assert positions_to_downbeat_indices([1, 2, 3, 4, 1, 2, 3, 4, 1]) == [0, 4, 8]
    assert positions_to_downbeat_indices([3, 4, 1, 2, 3]) == [2]


# ── beat-tracker jitter smoothing ────────────────────────────────────────

def test_smoothing_collapses_frame_jitter_to_one_tempo():
    # Steady 146 BPM, beats reported on madmom's 10 ms frame grid plus a
    # little per-beat noise: the raw map needs a B marker every beat or two.
    rng = np.random.default_rng(0)
    true = 0.4 + np.arange(400) * (60 / 146)
    beats = np.round(true / 0.01) * 0.01 + rng.normal(0, 0.003, len(true))
    raw = beats_to_grid(beats, audio_duration_s=170.0, smooth_tol_ms=0)
    grid = beats_to_grid(beats, audio_duration_s=170.0)
    assert len(raw['tempo_segments']) > 50
    assert len(grid['tempo_segments']) <= 3          # lead-in + one song tempo
    main = grid['tempo_segments'][-1]['micro_bpm'] / 1000
    assert abs(main - 146.0) < 0.05
    # And it is *closer* to the true beats than the raw map.
    assert _max_beat_error_ms(grid, true) < _max_beat_error_ms(raw, true)
    assert _max_beat_error_ms(grid, true) < 4.0
    assert grid['beat_times_s'] != [float(b) for b in beats]


def test_smoothing_keeps_a_real_tempo_change():
    # 120 BPM for 60 beats, then a hard cut to 100 BPM — a new section.
    a = 0.5 + np.arange(60) * 0.5
    b = a[-1] + 0.6 + np.arange(60) * 0.6
    true = np.concatenate([a, b])
    beats = np.round(true / 0.01) * 0.01
    grid = beats_to_grid(beats, audio_duration_s=80.0)
    bpms = [round(s['micro_bpm'] / 1000) for s in grid['tempo_segments'] if s.get('label') != 'lead-in']
    assert 120 in bpms and 100 in bpms
    assert len(grid['tempo_segments']) <= 4
    assert _max_beat_error_ms(grid, true) <= 8.0
    # The change lands on the right beat.
    change = next(s['tick_start'] for s in grid['tempo_segments'] if round(s['micro_bpm'] / 1000) == 100)
    assert abs(change - grid['beat_ticks'][59]) <= 192


def test_smoothing_keeps_a_ritardando():
    steady = 0.5 + np.arange(100) * 0.5
    rit = steady[-1] + np.cumsum([0.56, 0.63, 0.72, 0.85, 1.0])
    true = np.concatenate([steady, rit])
    grid = beats_to_grid(true, audio_duration_s=60.0)
    assert _max_beat_error_ms(grid, true) <= 30.0 + 1e-6
    # Last beats slower than the body of the song.
    assert grid['tempo_segments'][-1]['micro_bpm'] < 90_000


def test_smooth_beat_times_edge_cases():
    beats = [0.5, 1.0, 1.5]
    assert smooth_beat_times(beats, 30) == beats
    assert smooth_beat_times([0.5, 1.01, 1.5, 2.0, 2.49], 0) == [0.5, 1.01, 1.5, 2.0, 2.49]
    out = smooth_beat_times([0.5, 1.01, 1.5, 2.0, 2.49, 3.0, 3.51, 4.0], 30)
    assert all(b > a for a, b in zip(out, out[1:]))
    assert max(abs(o - r) for o, r in zip(out, [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0])) < 0.006
