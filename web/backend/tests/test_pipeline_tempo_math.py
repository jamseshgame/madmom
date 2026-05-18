"""Tests for seconds_to_tick — must match editor's frontend math exactly."""
from __future__ import annotations

import pytest

from app.services.pipeline.tempo_math import (
    build_tempo_segments,
    seconds_to_tick,
    tick_to_seconds,
)


def test_constant_120bpm_zero_offset():
    segs = build_tempo_segments(
        [{'tick': 0, 'micro_bpm': 120000}], resolution=192,
    )
    assert seconds_to_tick(0.5, segs, 192) == 192
    assert seconds_to_tick(1.0, segs, 192) == 384
    assert seconds_to_tick(0.0, segs, 192) == 0


def test_tempo_change_at_bar2():
    segs = build_tempo_segments(
        [{'tick': 0, 'micro_bpm': 120000}, {'tick': 768, 'micro_bpm': 60000}],
        resolution=192,
    )
    assert seconds_to_tick(2.0, segs, 192) == 768
    assert seconds_to_tick(3.0, segs, 192) == 960


def test_round_trip_tick_seconds():
    segs = build_tempo_segments(
        [{'tick': 0, 'micro_bpm': 120000}, {'tick': 768, 'micro_bpm': 60000}],
        resolution=192,
    )
    for tick in (0, 100, 768, 1000, 5000):
        s = tick_to_seconds(tick, segs, 192)
        back = seconds_to_tick(s, segs, 192)
        assert abs(back - tick) <= 1
