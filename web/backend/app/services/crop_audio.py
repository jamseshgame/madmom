"""Crop a beatmap's song.ogg to end just after its last charted event."""
from __future__ import annotations

import re

# Matches a chart event line: "<tick> = <rest>" with an integer left-hand side.
_EVENT_RE = re.compile(r'^\s*(\d+)\s*=\s*(.*)$', re.MULTILINE)
# Note/star-power lines carry a trailing sustain length: "N <fret> <length>".
_NOTE_RE = re.compile(r'^[NSR]\s+\d+\s+(\d+)\s*$')


def last_event_tick(content: str) -> int:
    """Largest event tick across every section, including sustain tails."""
    max_tick = 0
    for m in _EVENT_RE.finditer(content):
        tick = int(m.group(1))
        rest = m.group(2).strip()
        note = _NOTE_RE.match(rest)
        if note:
            tick += int(note.group(1))
        if tick > max_tick:
            max_tick = tick
    return max_tick


def _resolution(content: str) -> int:
    m = re.search(r'Resolution\s*=\s*(\d+)', content)
    return int(m.group(1)) if m else 192


def _tempo_segments(content: str) -> list[tuple[int, float]]:
    """Ordered (tick, micro_bpm) BPM markers from [SyncTrack]. micro_bpm is the
    raw `B` value (bpm * 1000). Always starts at tick 0."""
    sync = re.search(r'\[SyncTrack\]\s*\n\{([^}]*)\}', content)
    markers: list[tuple[int, float]] = []
    if sync:
        for line in sync.group(1).splitlines():
            bm = re.match(r'\s*(\d+)\s*=\s*B\s+(\d+)', line)
            if bm:
                markers.append((int(bm.group(1)), float(bm.group(2))))
    markers.sort(key=lambda x: x[0])
    if not markers or markers[0][0] != 0:
        markers.insert(0, (0, 120000.0))
    return markers


def tick_to_ms(content: str, tick: int) -> float:
    """Convert a tick to milliseconds using the chart's tempo map.

    ms-per-beat = 60_000_000 / micro_bpm; ms-per-tick = ms-per-beat / resolution.
    Mirrors the editor's frontend tickToSec helper.
    """
    resolution = _resolution(content)
    segs = _tempo_segments(content)
    ms = 0.0
    for i, (seg_tick, micro_bpm) in enumerate(segs):
        next_tick = segs[i + 1][0] if i + 1 < len(segs) else None
        ms_per_tick = (60_000_000.0 / micro_bpm) / resolution
        if next_tick is not None and tick >= next_tick:
            ms += (next_tick - seg_tick) * ms_per_tick
        else:
            ms += (tick - seg_tick) * ms_per_tick
            break
    return ms


def update_song_length(ini_text: str, length_ms: int) -> str:
    """Set song_length under [song], replacing an existing line or inserting one."""
    if re.search(r'(?im)^\s*song_length\s*=.*$', ini_text):
        return re.sub(r'(?im)^\s*song_length\s*=.*$', f'song_length = {length_ms}', ini_text)
    # No song_length line — insert right after the [song] header (case-insensitive).
    m = re.search(r'(?im)^\s*\[song\]\s*$', ini_text)
    if m:
        idx = m.end()
        return ini_text[:idx] + f'\nsong_length = {length_ms}' + ini_text[idx:]
    # No [song] section at all — prepend one.
    return f'[song]\nsong_length = {length_ms}\n' + ini_text
