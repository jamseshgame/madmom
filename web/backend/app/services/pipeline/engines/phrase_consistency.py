"""S6 engine: `phrase-consistency` — repeated phrases get repeated lanes.

"Feels random" feedback mostly comes from the same riff being charted
differently each time it comes round. This filter tokenises the note
sequence as (pitch interval, IOI class) pairs, finds every later window
that exactly repeats an earlier one, and copies the earlier occurrence's
lane pattern onto it. It needs the `midi` field the `contour-dp` lanes
engine attaches to each event; without pitch information it is a no-op.

Only the lane *pattern* is copied (fret numbers, chord partner offset);
sustains and ticks stay as they are. Edits are recorded like the other
playability filters so the editor can show what moved.
"""
from __future__ import annotations

import datetime as dt
from typing import Any

from ..registry import EngineSpec, Stage, register_engine


_PARAMS = {
    'min_phrase_notes': {'type': 'number', 'min': 3, 'max': 16, 'step': 1, 'default': 6,
                         'label': 'Notes a repeat must span to be copied'},
    'ioi_classes': {'type': 'boolean', 'default': True,
                    'label': 'Require matching rhythm (IOI class) as well as intervals'},
    'max_passes': {'type': 'number', 'min': 1, 'max': 4, 'step': 1, 'default': 2,
                   'label': 'Propagation passes'},
}


def _now() -> str:
    return dt.datetime.now(dt.UTC).isoformat().replace('+00:00', 'Z')


def _ioi_class(d_ticks: int, resolution: int) -> int:
    """Quantise an inter-onset interval to a coarse rhythmic class."""
    if d_ticks <= 0:
        return 0
    beats = d_ticks / resolution
    for k, edge in enumerate((0.1875, 0.375, 0.75, 1.5, 3.0)):
        if beats < edge:
            return k + 1
    return 6


def tokens_for(lanes: list[dict], resolution: int, use_ioi: bool) -> list[tuple[int, int] | None]:
    """Token i describes the step *into* note i (interval, IOI class).
    None marks positions with no pitch (never part of a match)."""
    out: list[tuple[int, int] | None] = [None] * len(lanes)
    for i in range(1, len(lanes)):
        a, b = lanes[i - 1], lanes[i]
        if a.get('midi') is None or b.get('midi') is None:
            continue
        interval = int(b['midi']) - int(a['midi'])
        ioi = _ioi_class(int(b['tick']) - int(a['tick']), resolution) if use_ioi else 0
        out[i] = (interval, ioi)
    return out


def _pattern(ev: dict) -> tuple[int, int]:
    """(anchor fret, partner offset) — the copyable part of a lane event."""
    frets = sorted(int(f) for f in ev['frets'])
    if len(frets) == 1:
        return frets[0], 0
    return frets[0], frets[1] - frets[0]


def _apply(ev: dict, pat: tuple[int, int]) -> list[int]:
    anchor, off = pat
    if off == 0 or anchor == 7:
        return [anchor]
    return sorted([anchor, anchor + off]) if 0 <= anchor + off <= 4 else [anchor]


def propagate(lanes: list[dict], resolution: int, min_len: int, use_ioi: bool,
              passes: int) -> tuple[list[dict], list[dict]]:
    lanes = [dict(ev) for ev in lanes]
    edits: list[dict[str, Any]] = []
    tokens = tokens_for(lanes, resolution, use_ioi)
    n = len(lanes)
    if n < min_len + 1:
        return lanes, edits

    # Index every window of `min_len` tokens by its content → first start.
    first: dict[tuple, int] = {}
    for start in range(1, n - min_len + 1):
        win = tuple(tokens[start:start + min_len])
        if any(t is None for t in win):
            continue
        first.setdefault(win, start)

    for _ in range(passes):
        changed = 0
        start = 1
        while start <= n - min_len:
            win = tuple(tokens[start:start + min_len])
            src = first.get(win) if not any(t is None for t in win) else None
            if src is None or src >= start:
                start += 1
                continue
            # Extend the match greedily beyond min_len.
            length = min_len
            while (start + length < n and src + length < start
                   and tokens[start + length] is not None
                   and tokens[start + length] == tokens[src + length]):
                length += 1
            # Copy lanes for notes start-1 .. start+length-1 (the token at
            # `start` describes the step into note `start`, so the phrase
            # begins one note earlier).
            for k in range(-1, length):
                i, j = start + k, src + k
                if j < 0 or j >= start + k or i >= n:
                    continue
                pat = _pattern(lanes[j])
                new_frets = _apply(lanes[i], pat)
                if new_frets != sorted(int(f) for f in lanes[i]['frets']):
                    edits.append({'tick': lanes[i]['tick'], 'kind': 'copy', 'from': lanes[i]['frets'],
                                  'to': new_frets, 'reason': 'repeated_phrase', 'source_tick': lanes[j]['tick']})
                    lanes[i]['frets'] = new_frets
                    changed += 1
            start += length
        if not changed:
            break
    return lanes, edits


def run_phrase_consistency(audio_path, upstream, params, on_progress):
    inp = upstream.get('lanes_expert')
    if inp is None:
        raise ValueError('S6 requires upstream lanes_expert')
    grid = upstream.get('grid') or {}
    resolution = int(grid.get('resolution', 192))
    min_len = int(params.get('min_phrase_notes', 6))
    use_ioi = bool(params.get('ioi_classes', True))
    passes = int(params.get('max_passes', 2))
    lanes, edits = propagate(inp['lanes'], resolution, min_len, use_ioi, passes)
    on_progress('done', 100, f'{len(edits)} notes re-laned to match earlier phrases')
    return {'engine': 'phrase-consistency', 'params': params, 'generated_at': _now(),
            'lanes': lanes, 'edits': edits, 'metric_weights': inp.get('metric_weights', {})}


register_engine(Stage.LANES_FILTERED, EngineSpec(
    id='phrase-consistency', display_name='Phrase consistency (repeats copy earlier lanes)',
    params_schema=_PARAMS, runner=run_phrase_consistency,
))
