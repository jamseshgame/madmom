"""Deterministic .chart serialization from grid + lane events."""
from __future__ import annotations

from typing import Any


def _serialize_song(song_name: str, resolution: int) -> str:
    return (
        '[Song]\n{\n'
        f'  Name = "{song_name}"\n'
        f'  Resolution = {resolution}\n'
        '  Offset = 0\n'
        '}\n'
    )


def _serialize_synctrack(grid: dict[str, Any]) -> str:
    rows: list[tuple[int, str]] = []
    for ts in grid['time_sig_segments']:
        if ts.get('denom_pow', 2) == 2:
            rows.append((int(ts['tick_start']), f'TS {ts["num"]}'))
        else:
            rows.append((int(ts['tick_start']), f'TS {ts["num"]} {ts["denom_pow"]}'))
    for tempo in grid['tempo_segments']:
        rows.append((int(tempo['tick_start']), f'B {int(tempo["micro_bpm"])}'))
    rows.sort(key=lambda x: (x[0], 0 if x[1].startswith('TS') else 1))
    body = '\n'.join(f'  {tick} = {expr}' for tick, expr in rows)
    return f'[SyncTrack]\n{{\n{body}\n}}\n'


def _serialize_events(grid: dict[str, Any]) -> str:
    rows = [(int(s['tick_start']), f'E "section {s["label"]}"') for s in grid['sections']]
    rows.sort()
    body = '\n'.join(f'  {tick} = {expr}' for tick, expr in rows) or '  '
    return f'[Events]\n{{\n{body}\n}}\n'


def _serialize_difficulty(section_name: str, lanes_payload: dict[str, Any]) -> str:
    lanes = lanes_payload.get('lanes', [])
    rows = []
    for ev in lanes:
        tick = int(ev['tick'])
        sustain = int(ev.get('sustain', 0))
        for fret in ev['frets']:
            rows.append((tick, fret, f'N {fret} {sustain}'))
    rows.sort()
    body = '\n'.join(f'  {tick} = {expr}' for tick, _f, expr in rows) or '  '
    return f'[{section_name}]\n{{\n{body}\n}}\n'


def serialize_chart(
    grid: dict[str, Any],
    lanes_per_difficulty: dict[str, dict[str, Any]],
    song_name: str,
    resolution: int,
) -> str:
    parts = [
        _serialize_song(song_name, resolution),
        _serialize_synctrack(grid),
        _serialize_events(grid),
    ]
    for section in ('ExpertSingle', 'HardSingle', 'MediumSingle', 'EasySingle'):
        if section in lanes_per_difficulty:
            parts.append(_serialize_difficulty(section, lanes_per_difficulty[section]))
    return ''.join(parts)
