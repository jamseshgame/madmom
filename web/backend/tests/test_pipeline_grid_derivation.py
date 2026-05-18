"""Tests for time-sig derivation from beat + downbeat lists."""
from __future__ import annotations

import pytest

from app.services.pipeline.grid_derivation import (
    derive_time_signatures,
    derive_tempo_segments,
)


def test_steady_4_4():
    beats = [i * 0.5 for i in range(16)]
    downbeats = [beats[i] for i in range(0, 16, 4)]
    segments = derive_time_signatures(beats=beats, downbeats=downbeats, resolution=192, bpm_hint=120.0)
    assert len(segments) == 1
    assert segments[0]['num'] == 4


def test_three_four_waltz():
    beats = [i * 0.5 for i in range(15)]
    downbeats = [beats[i] for i in range(0, 15, 3)]
    segments = derive_time_signatures(beats=beats, downbeats=downbeats, resolution=192, bpm_hint=120.0)
    assert segments[0]['num'] == 3


def test_jitter_ignored():
    beats = [i * 0.5 for i in range(16)]
    downbeats = [beats[0], beats[4], beats[7], beats[12]]
    segments = derive_time_signatures(beats=beats, downbeats=downbeats, resolution=192, bpm_hint=120.0)
    assert segments[0]['num'] == 4


def test_tempo_segments_constant():
    beats = [i * 0.5 for i in range(20)]
    segs = derive_tempo_segments(beats=beats, downbeats=beats[::4], resolution=192,
                                 min_segment_beats=16)
    assert len(segs) == 1
    assert 119_000 <= segs[0]['micro_bpm'] <= 121_000


def test_tempo_segments_split_on_tempo_change():
    fast = [i * 0.5 for i in range(20)]
    slow_start = fast[-1] + 0.5
    slow = [slow_start + i * (60.0 / 90.0) for i in range(20)]
    beats = fast + slow
    downbeats = beats[::4]
    segs = derive_tempo_segments(beats=beats, downbeats=downbeats, resolution=192,
                                 min_segment_beats=8)
    assert len(segs) == 2
    assert 119_000 <= segs[0]['micro_bpm'] <= 121_000
    assert 88_000 <= segs[1]['micro_bpm'] <= 92_000
