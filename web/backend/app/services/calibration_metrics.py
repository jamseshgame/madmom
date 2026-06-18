"""Pure chart-metric helpers for difficulty calibration.

No disk or network I/O — every function takes text/numbers in and returns
plain data, so the whole module is unit-testable in isolation.
"""
from __future__ import annotations

import re

_SYNC_RE = re.compile(r'\[SyncTrack\]\s*\{([^}]*)\}')
_B_RE = re.compile(r'(\d+)\s*=\s*B\s+(\d+)')


def build_tempo_map(chart_text: str) -> list[tuple[int, float]]:
    """Parse `[SyncTrack]` BPM (`B`) events into sorted `(tick, bpm)` segments.

    The chart `B` value is BPM*1000. Always returns a segment at tick 0 so
    tick_to_seconds has a defined starting tempo (defaults to 120 BPM).
    """
    segments: list[tuple[int, float]] = []
    m = _SYNC_RE.search(chart_text)
    if m:
        for line in m.group(1).split('\n'):
            bm = _B_RE.match(line.strip())
            if bm:
                segments.append((int(bm.group(1)), int(bm.group(2)) / 1000.0))
    segments.sort(key=lambda s: s[0])
    if not segments or segments[0][0] != 0:
        segments.insert(0, (0, 120.0))
    return segments


def tick_to_seconds(tick: int, tempo_map: list[tuple[int, float]], resolution: int) -> float:
    """Seconds elapsed from tick 0 to `tick`, walking tempo segments."""
    if resolution <= 0:
        return 0.0
    seconds = 0.0
    for i, (seg_tick, bpm) in enumerate(tempo_map):
        if tick <= seg_tick:
            break
        next_tick = tempo_map[i + 1][0] if i + 1 < len(tempo_map) else None
        end = tick if (next_tick is None or tick < next_tick) else next_tick
        beats = (end - seg_tick) / resolution
        seconds += beats * 60.0 / bpm
        if next_tick is None or tick < next_tick:
            break
    return seconds
