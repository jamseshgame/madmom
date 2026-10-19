"""Tests for the beat-anchored grid builder (beat_grid.beats_to_grid).

The invariant that matters: every detected beat lands on a tick that is a
multiple of `resolution`, and the tempo map reproduces its wall-clock time
to within the merge tolerance — so downbeats are on the grid and the
quantizer's metric weights are meaningful."""
from __future__ import annotations

import numpy as np

from app.services.pipeline.beat_grid import beats_to_grid, positions_to_downbeat_indices
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
    assert _max_beat_error_ms(grid, beats) <= 5.0 + 1e-6
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
    grid = beats_to_grid(beats, audio_duration_s=beats[-1] + 2, merge_tol_ms=3.0)
    assert _max_beat_error_ms(grid, beats) <= 3.0 + 1e-6
    # A ramp cannot be merged into a single segment.
    assert len(grid['tempo_segments']) > 5


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
