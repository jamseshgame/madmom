"""Pure chart-metric helpers for difficulty calibration.

No disk or network I/O — every function takes text/numbers in and returns
plain data, so the whole module is unit-testable in isolation.
"""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass

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


FAST_GAP_S = 0.25
PEAK_WINDOW_S = 1.0
BEATS_PER_MEASURE = 4

_PLAYABLE = set(range(0, 5)) | {7}
_NOTE_RE = re.compile(r'(\d+)\s*=\s*[NR]\s+(\d+)\s+(\d+)')
_SLIDE_RE = re.compile(r'(\d+)\s*=\s*E\s+slide\s+(\d+)')

NUMERIC_METRICS = [
    'total_gems', 'total_notes', 'total_holds', 'total_chords', 'total_chord_holds',
    'total_slides', 'total_chord_slides', 'open_notes', 'hold_pct', 'chord_pct',
    'distinct_lanes', 'duration_s', 'gems_per_min', 'peak_nps', 'min_gap_s',
    'longest_run', 'avg_chord_size',
]


@dataclass
class GemTick:
    tick: int
    frets: tuple[int, ...]
    max_sustain: int
    is_slide: bool


def parse_gem_ticks(body: str) -> list[GemTick]:
    """One GemTick per tick carrying a playable hit, sorted by tick.

    Unions N/R note lines with E-slide lines so a slide-middle tick (which the
    chart writes as N + E slide) is a single gem, not two. Modifier frets
    (5, 6, and drum cymbal modifiers 66-68) are not playable gems — ignored.
    """
    frets_by_tick: dict[int, set[int]] = defaultdict(set)
    sustain_by_tick: dict[int, int] = defaultdict(int)
    slide_ticks: set[int] = set()
    for raw in body.split('\n'):
        line = raw.strip()
        if not line:
            continue
        m = _NOTE_RE.match(line)
        if m:
            tick, fret, sustain = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if fret in _PLAYABLE:
                frets_by_tick[tick].add(fret)
                if sustain > sustain_by_tick[tick]:
                    sustain_by_tick[tick] = sustain
            continue
        m = _SLIDE_RE.match(line)
        if m:
            tick, fret = int(m.group(1)), int(m.group(2))
            if fret in _PLAYABLE:
                frets_by_tick[tick].add(fret)
                slide_ticks.add(tick)
    out: list[GemTick] = []
    for tick in sorted(frets_by_tick):
        out.append(
            GemTick(
                tick=tick,
                frets=tuple(sorted(frets_by_tick[tick])),
                max_sustain=sustain_by_tick.get(tick, 0),
                is_slide=tick in slide_ticks,
            )
        )
    return out


def section_metrics(body: str, resolution: int, tempo_map: list[tuple[int, float]]) -> dict | None:
    """Compute every per-section calibration metric, or None if no gems."""
    gems = parse_gem_ticks(body)
    if not gems:
        return None

    singles = holds = chords = chord_holds = slides = chord_slides = 0
    open_normal = open_hold = open_slide = 0
    total_gems = 0
    chord_sizes: list[int] = []
    lanes: set[int] = set()

    for g in gems:
        colored = [f for f in g.frets if 0 <= f <= 4]
        total_gems += len(g.frets)
        lanes.update(colored)
        is_hold = g.max_sustain > 0
        has_open = 7 in g.frets
        if len(g.frets) >= 2:
            chord_sizes.append(len(g.frets))
        if has_open:
            if g.is_slide:
                open_slide += 1
            elif is_hold:
                open_hold += 1
            else:
                open_normal += 1
            continue
        if g.is_slide:
            if len(colored) == 2 and colored[1] - colored[0] == 1:
                chord_slides += 1
            else:
                slides += 1
            continue
        if len(colored) == 1:
            holds += 1 if is_hold else 0
            singles += 0 if is_hold else 1
        elif len(colored) == 2:
            chord_holds += 1 if is_hold else 0
            chords += 0 if is_hold else 1
        # 3+ colored frets: counted in total_gems only

    total_notes = len(gems)
    hold_count = holds + chord_holds + open_hold
    chord_count = chords + chord_holds + chord_slides
    open_notes = open_normal + open_hold + open_slide

    times = [tick_to_seconds(g.tick, tempo_map, resolution) for g in gems]
    end_times = [tick_to_seconds(g.tick + g.max_sustain, tempo_map, resolution) for g in gems]
    duration_s = max(end_times) if end_times else 0.0

    gems_per_min = (total_gems / (duration_s / 60.0)) if duration_s > 0 else 0.0

    # Peak density: max note-groups inside any PEAK_WINDOW_S window.
    peak_nps = 0
    busiest_tick = gems[0].tick
    for i in range(len(times)):
        count = 0
        j = i
        while j < len(times) and times[j] < times[i] + PEAK_WINDOW_S:
            count += 1
            j += 1
        if count > peak_nps:
            peak_nps = count
            busiest_tick = gems[i].tick
    busiest_measure = busiest_tick // (resolution * BEATS_PER_MEASURE) + 1

    gaps = [times[i + 1] - times[i] for i in range(len(times) - 1)]
    min_gap_s = min(gaps) if gaps else None

    longest_run = 1 if gems else 0
    run = 1
    for gap in gaps:
        if gap <= FAST_GAP_S:
            run += 1
            longest_run = max(longest_run, run)
        else:
            run = 1

    avg_chord_size = (sum(chord_sizes) / len(chord_sizes)) if chord_sizes else 0.0

    return {
        'total_gems': total_gems,
        'total_notes': total_notes,
        'total_holds': hold_count,
        'total_chords': chords,
        'total_chord_holds': chord_holds,
        'total_slides': slides,
        'total_chord_slides': chord_slides,
        'open_notes': open_notes,
        'hold_pct': round(100.0 * hold_count / total_notes, 1) if total_notes else 0.0,
        'chord_pct': round(100.0 * chord_count / total_notes, 1) if total_notes else 0.0,
        'lane_lo': min(lanes) if lanes else None,
        'lane_hi': max(lanes) if lanes else None,
        'distinct_lanes': len(lanes),
        'duration_s': round(duration_s, 2),
        'gems_per_min': round(gems_per_min, 1),
        'peak_nps': peak_nps,
        'busiest_measure': busiest_measure,
        'min_gap_s': round(min_gap_s, 3) if min_gap_s is not None else None,
        'longest_run': longest_run,
        'avg_chord_size': round(avg_chord_size, 2),
    }
