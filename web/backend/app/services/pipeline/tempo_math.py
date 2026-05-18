"""Tempo math: ticks <-> seconds across a piecewise tempo map.

Ported from web/frontend/src/components/BeatmapEditor.tsx
(buildTempoSegments / secondsToTick / tickToSeconds). Backend and frontend
MUST agree to the tick; round-trip tests in test_pipeline_tempo_math.py
guard against drift.
"""
from __future__ import annotations

from typing import TypedDict


class TempoSegment(TypedDict):
    tick: int
    seconds: float
    micro_bpm: int


def build_tempo_segments(
    markers: list[dict],
    resolution: int,
) -> list[TempoSegment]:
    """Convert tempo markers (tick, micro_bpm) to segments with precomputed
    wall-clock `seconds` at each marker's tick."""
    if not markers:
        return [{'tick': 0, 'seconds': 0.0, 'micro_bpm': 120_000}]
    out: list[TempoSegment] = [{'tick': markers[0]['tick'], 'seconds': 0.0,
                                'micro_bpm': markers[0]['micro_bpm']}]
    cum = 0.0
    for i in range(1, len(markers)):
        prev = out[-1]
        dt_ticks = markers[i]['tick'] - prev['tick']
        cum += (dt_ticks / resolution) * (60000.0 / prev['micro_bpm'])
        out.append({'tick': markers[i]['tick'], 'seconds': cum,
                    'micro_bpm': markers[i]['micro_bpm']})
    return out


def _find_segment(segs: list[TempoSegment], *, tick: int | None = None, seconds: float | None = None) -> TempoSegment:
    if tick is not None:
        seg = segs[0]
        for s in segs:
            if s['tick'] <= tick:
                seg = s
            else:
                break
        return seg
    if seconds is not None:
        seg = segs[0]
        for s in segs:
            if s['seconds'] <= seconds:
                seg = s
            else:
                break
        return seg
    raise ValueError('tick or seconds required')


def seconds_to_tick(s: float, segs: list[TempoSegment], resolution: int) -> int:
    seg = _find_segment(segs, seconds=s)
    ds = s - seg['seconds']
    dt = ds * seg['micro_bpm'] * resolution / 60000.0
    return int(round(seg['tick'] + dt))


def tick_to_seconds(tick: int, segs: list[TempoSegment], resolution: int) -> float:
    seg = _find_segment(segs, tick=tick)
    dt = tick - seg['tick']
    return seg['seconds'] + (dt / resolution) * (60000.0 / seg['micro_bpm'])
