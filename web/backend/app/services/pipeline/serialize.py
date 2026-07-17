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


def _clamp_frets(frets: list[int], collapse_wide: bool = True) -> list[int]:
    """Reduce a tick's frets to at most two gems (lanes 0-4).

    With ``collapse_wide`` (guitar, the default): keep at most two *adjacent*
    gems. The lane engines only ever emit adjacent chord pairs, so a gap-spanning
    set on a tick is a quantization collision of separate onsets, not a real
    chord. Keeping the outer two frets turned those collisions into awkward wide
    chords like yellow+orange (2,4) that reviewers flagged, so instead we keep
    the lowest adjacent pair; a set with no adjacent pair collapses to its root
    (lowest) gem.

    Without ``collapse_wide`` (drums): a same-tick set is a real simultaneous
    multi-pad hit (kick+cymbal etc.), not an artifact, so keep the outer two
    frets and allow non-adjacent pairs — only the 3-fret cap is enforced.

    Either way an open note (lane 7) yields to any gem (individual gems carry
    more detail); a lone open survives. Mirrors the editor's R1 rule so no chart
    ever ships a 3-fret chord.
    """
    gems = sorted({f for f in frets if 0 <= f <= 4})
    if gems:
        if not collapse_wide:
            return [gems[0], gems[-1]] if len(gems) > 2 else gems
        for lo, hi in zip(gems, gems[1:]):
            if hi - lo == 1:
                return [lo, hi]
        return [gems[0]]
    if any(f == 7 for f in frets):
        return [7]
    return sorted(set(frets))


def _serialize_difficulty(section_name: str, lanes_payload: dict[str, Any],
                          collapse_wide: bool = True) -> str:
    lanes = lanes_payload.get('lanes', [])
    # Merge every event on a tick before emitting: polyphonic presets stack
    # several events on one tick, and only the union tells us the true chord.
    frets_by_tick: dict[int, set[int]] = {}
    sustain_by_tick: dict[int, int] = {}
    for ev in lanes:
        tick = int(ev['tick'])
        sustain = int(ev.get('sustain', 0))
        frets_by_tick.setdefault(tick, set()).update(ev['frets'])
        sustain_by_tick[tick] = max(sustain_by_tick.get(tick, 0), sustain)
    rows = []
    for tick, frets in frets_by_tick.items():
        sustain = sustain_by_tick[tick]
        for fret in _clamp_frets(list(frets), collapse_wide):
            rows.append((tick, fret, f'N {fret} {sustain}'))
    rows.sort()
    body = '\n'.join(f'  {tick} = {expr}' for tick, _f, expr in rows) or '  '
    return f'[{section_name}]\n{{\n{body}\n}}\n'


def serialize_chart(
    grid: dict[str, Any],
    lanes_per_difficulty: dict[str, dict[str, Any]],
    song_name: str,
    resolution: int,
    collapse_wide: bool = True,
) -> str:
    """Serialize lanes to a .chart. ``collapse_wide`` enforces adjacent-only
    chords (guitar); pass False for drums, whose simultaneous kick+cymbal hits
    are real non-adjacent chords, not artifacts to collapse."""
    parts = [
        _serialize_song(song_name, resolution),
        _serialize_synctrack(grid),
        _serialize_events(grid),
    ]
    for section in ('ExpertSingle', 'HardSingle', 'MediumSingle', 'EasySingle'):
        if section in lanes_per_difficulty:
            parts.append(_serialize_difficulty(section, lanes_per_difficulty[section], collapse_wide))
    return ''.join(parts)
