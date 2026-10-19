"""S7 engine: `importance-score` — difficulty by note importance against a
density target, the way charters actually reduce a part.

`metric-weight` keeps every note above a fixed metric weight, so Easy is
"downbeats only" regardless of the song and Hard can still be a wall of
16ths. Here each note gets an importance score

    metric weight (0–4)  × w_metric
  + velocity (0–1)       × w_velocity
  + sustained note       + w_sustain
  + chord                + w_chord
  + first note of a bar  + w_bar_start
  + repeated-phrase note + w_phrase   (events the phrase filter marked)

and each difficulty keeps the top notes per window of `window_bars` bars
until its notes-per-second target is met, with a floor on metric weight
and a cap on chord size. Density targets are per-difficulty parameters so
the preset proposer has something continuous to tune.
"""
from __future__ import annotations

import datetime as dt
from typing import Any

from ..registry import EngineSpec, Stage, register_engine
from ..tempo_math import build_tempo_segments, tick_to_seconds


DEFAULT_TARGETS: dict[str, dict[str, Any]] = {
    'hard':   {'max_per_sec': 6.0, 'min_weight': 1, 'max_chord': 2},
    'medium': {'max_per_sec': 3.5, 'min_weight': 2, 'max_chord': 2},
    'easy':   {'max_per_sec': 1.8, 'min_weight': 3, 'max_chord': 1},
}

_PARAMS = {
    'hard': {'type': 'enum', 'options': [], 'default': DEFAULT_TARGETS['hard'], 'label': 'Hard targets'},
    'medium': {'type': 'enum', 'options': [], 'default': DEFAULT_TARGETS['medium'], 'label': 'Medium targets'},
    'easy': {'type': 'enum', 'options': [], 'default': DEFAULT_TARGETS['easy'], 'label': 'Easy targets'},
    'window_bars': {'type': 'number', 'min': 1, 'max': 16, 'step': 1, 'default': 4,
                    'label': 'Density window (bars)'},
    'w_metric': {'type': 'number', 'min': 0, 'max': 5, 'step': 0.25, 'default': 1.0,
                 'label': 'Weight: metric position'},
    'w_velocity': {'type': 'number', 'min': 0, 'max': 5, 'step': 0.25, 'default': 1.5, 'label': 'Weight: loudness'},
    'w_sustain': {'type': 'number', 'min': 0, 'max': 5, 'step': 0.25, 'default': 1.0, 'label': 'Bonus: sustained note'},
    'w_chord': {'type': 'number', 'min': 0, 'max': 5, 'step': 0.25, 'default': 0.5, 'label': 'Bonus: chord'},
    'w_bar_start': {'type': 'number', 'min': 0, 'max': 5, 'step': 0.25, 'default': 1.0,
                    'label': 'Bonus: first note in bar'},
}


def _now() -> str:
    return dt.datetime.now(dt.UTC).isoformat().replace('+00:00', 'Z')


def _bar_ticks(grid: dict | None, resolution: int) -> int:
    if grid and grid.get('time_sig_segments'):
        return int(grid['time_sig_segments'][0].get('num', 4)) * resolution
    return 4 * resolution


def score_events(lanes: list[dict], metric_weights: dict[str, int], params: dict[str, Any],
                 bar_ticks: int) -> list[float]:
    w_metric = float(params.get('w_metric', 1.0))
    w_vel = float(params.get('w_velocity', 1.5))
    w_sus = float(params.get('w_sustain', 1.0))
    w_chord = float(params.get('w_chord', 0.5))
    w_bar = float(params.get('w_bar_start', 1.0))
    scores = []
    seen_bars: set[int] = set()
    for ev in lanes:
        w = metric_weights.get(str(ev['tick']))
        w = 2 if w is None else int(w)
        vel = ev.get('velocity')
        s = w_metric * w + w_vel * (float(vel) if vel is not None else 0.5)
        if int(ev.get('sustain', 0)) > 0:
            s += w_sus
        if len(ev['frets']) > 1:
            s += w_chord
        bar = int(ev['tick']) // max(1, bar_ticks)
        if bar not in seen_bars:
            seen_bars.add(bar)
            s += w_bar
        scores.append(s)
    return scores


def reduce_to_target(lanes: list[dict], scores: list[float], target: dict[str, Any],
                     metric_weights: dict[str, int], segs, resolution: int,
                     window_ticks: int) -> list[dict]:
    max_per_sec = float(target.get('max_per_sec') or 0)
    min_w = int(target.get('min_weight', 0))
    max_chord = int(target.get('max_chord', 2))
    # Hard floor first.
    cands = []
    for ev, s in zip(lanes, scores):
        w = metric_weights.get(str(ev['tick']))
        w = 2 if w is None else int(w)
        if w < min_w:
            continue
        cands.append((ev, s))
    if max_per_sec <= 0:
        kept = [ev for ev, _ in cands]
    else:
        kept = []
        by_window: dict[int, list[tuple[dict, float]]] = {}
        for ev, s in cands:
            by_window.setdefault(int(ev['tick']) // max(1, window_ticks), []).append((ev, s))
        for win_idx, items in by_window.items():
            t0 = tick_to_seconds(win_idx * window_ticks, segs, resolution)
            t1 = tick_to_seconds((win_idx + 1) * window_ticks, segs, resolution)
            budget = max(1, int(round(max_per_sec * max(0.1, t1 - t0))))
            if len(items) > budget:
                ranked = sorted(items, key=lambda x: (-x[1], x[0]['tick']))
                items = ranked[:budget]
            kept.extend(ev for ev, _ in items)
        kept.sort(key=lambda e: (e['tick'], e['frets'][0]))
    out = []
    for ev in kept:
        new_ev = dict(ev)
        if len(new_ev['frets']) > max_chord:
            new_ev['frets'] = sorted(new_ev['frets'])[:max_chord]
        out.append(new_ev)
    return out


def run_importance_score(audio_path, upstream, params, on_progress):
    inp = upstream.get('lanes_filtered')
    if inp is None:
        raise ValueError('S7 requires upstream lanes_filtered')
    grid = upstream.get('grid') or {}
    resolution = int(grid.get('resolution', 192))
    tempo = grid.get('tempo_segments') or [{'tick_start': 0, 'micro_bpm': 120000}]
    segs = build_tempo_segments([{'tick': t['tick_start'], 'micro_bpm': t['micro_bpm']} for t in tempo], resolution)
    metric_weights = inp.get('metric_weights') or {}
    bar_ticks = _bar_ticks(grid, resolution)
    window_ticks = int(params.get('window_bars', 4)) * bar_ticks
    scores = score_events(inp['lanes'], metric_weights, params, bar_ticks)
    by_difficulty = {}
    for diff in ('easy', 'medium', 'hard'):
        target = {**DEFAULT_TARGETS[diff], **(params.get(diff) or {})}
        by_difficulty[diff] = {
            'engine': 'importance-score', 'params': target, 'generated_at': _now(),
            'lanes': reduce_to_target(inp['lanes'], scores, target, metric_weights, segs, resolution, window_ticks),
        }
    on_progress('done', 100, ' / '.join(f'{d}={len(v["lanes"])}' for d, v in by_difficulty.items()))
    return {'engine': 'importance-score', 'params': params, 'generated_at': _now(),
            'by_difficulty': by_difficulty}


for _stage in (Stage.LANES_HARD, Stage.LANES_MEDIUM, Stage.LANES_EASY):
    register_engine(_stage, EngineSpec(
        id='importance-score', display_name='Importance score → density target',
        params_schema=_PARAMS, runner=run_importance_score,
    ))
