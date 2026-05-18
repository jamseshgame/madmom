"""Derive tempo & time-signature segments from raw beat/downbeat times."""
from __future__ import annotations

import statistics
from collections import Counter
from typing import Any


def derive_time_signatures(
    beats: list[float],
    downbeats: list[float],
    resolution: int,
    bpm_hint: float,
    window: int = 32,
    min_stable_windows: int = 2,
) -> list[dict[str, Any]]:
    """Walk the beat list in `window`-beat chunks. For each chunk count the
    distinct downbeat-interval mode (in beats). Emit a TS segment when the
    mode changes for ≥ `min_stable_windows` consecutive chunks.

    Returns segments tagged with `tick_start` (the first beat tick of the
    chunk where the mode took hold).
    """
    if not beats:
        return [{'tick_start': 0, 'num': 4, 'denom_pow': 2}]
    db_set = sorted(set(downbeats))
    if len(db_set) < 2:
        return [{'tick_start': 0, 'num': 4, 'denom_pow': 2}]
    db_intervals_beats = []
    for i in range(1, len(db_set)):
        n = sum(1 for b in beats if db_set[i - 1] <= b < db_set[i])
        db_intervals_beats.append(n)

    chunks = []
    for i in range(0, len(db_intervals_beats), max(1, window // 4)):
        chunk = db_intervals_beats[i: i + max(2, window // 4)]
        if not chunk:
            continue
        mode = Counter(chunk).most_common(1)[0][0]
        chunks.append((i, mode))

    segments: list[dict[str, Any]] = []
    stable_mode = None
    streak = 0
    for idx, mode in chunks:
        if mode == stable_mode:
            streak += 1
            continue
        streak = 1
        stable_mode = mode
        if streak >= min_stable_windows or not segments:
            tick = int(round(beats[min(len(beats) - 1, idx)] * bpm_hint / 60.0 * resolution))
            if not segments:
                tick = 0
            if not segments or segments[-1]['num'] != mode:
                segments.append({'tick_start': tick, 'num': int(mode), 'denom_pow': 2})

    if not segments:
        segments = [{'tick_start': 0, 'num': 4, 'denom_pow': 2}]
    return segments


def derive_tempo_segments(
    beats: list[float],
    downbeats: list[float],
    resolution: int,
    min_segment_beats: int = 16,
) -> list[dict[str, Any]]:
    """Compute BPM from beat-to-beat intervals. Cluster the beat sequence into
    segments where average BPM is stable (within 5% of the segment's median).

    Segment boundaries snap to the nearest downbeat. Each segment is at least
    `min_segment_beats` beats long.
    """
    if len(beats) < 3:
        return [{'tick_start': 0, 'micro_bpm': 120_000, 'label': 'main'}]

    intervals = [b - a for a, b in zip(beats, beats[1:])]
    bpms = [60.0 / max(1e-6, dt) for dt in intervals]

    db_set = sorted(set(downbeats))
    segments: list[dict[str, Any]] = []
    seg_start = 0
    seg_bpms = [bpms[0]]
    for i in range(1, len(bpms)):
        median = statistics.median(seg_bpms)
        if abs(bpms[i] - median) / median > 0.05 and (i - seg_start) >= min_segment_beats:
            split_time = beats[i]
            nearest_db = min(db_set, key=lambda d: abs(d - split_time)) if db_set else split_time
            tick = int(round(beats[seg_start] * median / 60.0 * resolution))
            if not segments:
                tick = 0
            segments.append({
                'tick_start': tick,
                'micro_bpm': int(round(median * 1000)),
                'label': f'seg_{len(segments)}',
            })
            seg_start = i
            seg_bpms = [bpms[i]]
        else:
            seg_bpms.append(bpms[i])

    median = statistics.median(seg_bpms)
    tick = (
        0 if not segments
        else int(round(beats[seg_start] * statistics.median(bpms[:seg_start] or [median]) / 60.0 * resolution))
    )
    segments.append({
        'tick_start': tick,
        'micro_bpm': int(round(median * 1000)),
        'label': f'seg_{len(segments)}',
    })
    return segments
