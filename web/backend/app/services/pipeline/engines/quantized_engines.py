"""S4 engines: snap onsets to grid + assign metric weight."""
from __future__ import annotations

import datetime as dt
from typing import Any

from ..registry import EngineSpec, Stage, register_engine
from ..tempo_math import build_tempo_segments, seconds_to_tick, tick_to_seconds


_NEAREST_PARAMS = {
    'max_division': {'type': 'enum', 'options': [4, 8, 16, 32], 'default': 16,
                     'label': 'Max grid division'},
    'min_division': {'type': 'enum', 'options': [1, 2, 4, 8], 'default': 4,
                     'label': 'Min grid division'},
    'max_snap_distance_ms': {'type': 'number', 'min': 0, 'max': 500, 'step': 5, 'default': 80,
                             'label': 'Max snap distance (ms)'},
    'lock_to_downbeat': {'type': 'boolean', 'default': False,
                         'label': 'Lock first onset of each bar to bar start'},
}


def _grid_to_segments(grid_payload: dict) -> tuple[list[dict], int]:
    markers = [{'tick': t['tick_start'], 'micro_bpm': t['micro_bpm']}
               for t in grid_payload['tempo_segments']]
    segs = build_tempo_segments(markers, resolution=grid_payload['resolution'])
    return segs, int(grid_payload['resolution'])


def _ticks_per_division(division: int, resolution: int) -> int:
    return max(1, (resolution * 4) // division)


def _compute_metric_weight(tick: int, grid_payload: dict) -> int:
    """4=downbeat, 3=beat, 2=eighth offbeat, 1=sixteenth offbeat, 0=off-grid."""
    resolution = int(grid_payload['resolution'])
    downbeats = grid_payload.get('downbeats') or []
    if tick in set(downbeats):
        return 4
    if tick % resolution == 0:
        return 3
    if tick % (resolution // 2) == 0:
        return 2
    if tick % (resolution // 4) == 0:
        return 1
    return 0


def _snap_to_grid(t_s: float, segs: list, resolution: int, division: int) -> tuple[int, float]:
    raw_tick = seconds_to_tick(t_s, segs, resolution)
    grid = _ticks_per_division(division, resolution)
    snapped = round(raw_tick / grid) * grid
    post_s = tick_to_seconds(snapped, segs, resolution)
    return snapped, post_s


def _run_quant(engine_id: str, upstream, params, on_progress, scorer=None) -> dict[str, Any]:
    grid_payload = upstream.get('grid')
    if grid_payload is None:
        raise ValueError('S4 requires upstream grid')
    pitches_payload = upstream.get('pitches')
    if pitches_payload is None:
        raise ValueError('S4 requires upstream pitches')

    segs, resolution = _grid_to_segments(grid_payload)
    max_div = int(params.get('max_division', 16))
    max_snap_ms = float(params.get('max_snap_distance_ms', 80))

    events = []
    for entry in pitches_payload['per_onset']:
        t_pre = float(entry['time_s'])
        tick, t_post = _snap_to_grid(t_pre, segs, resolution, max_div)
        dist_ms = abs(t_post - t_pre) * 1000.0
        if scorer is not None:
            tick, t_post = scorer(tick, t_pre, segs, resolution, grid_payload, max_div)
            dist_ms = abs(t_post - t_pre) * 1000.0
        dropped = dist_ms > max_snap_ms
        weight = _compute_metric_weight(tick, grid_payload) if not dropped else 0
        events.append({
            'tick': int(tick),
            'time_s_pre': t_pre,
            'time_s_post': t_post,
            'snap_division': max_div,
            'metric_weight': weight,
            'dominant_midi': entry.get('dominant_midi'),
            'polyphony': int(entry.get('polyphony', 1)),
            'dropped': dropped,
        })

    on_progress('done', 100, f'{len(events)} events ({sum(1 for e in events if e["dropped"])} dropped)')
    return {
        'engine': engine_id, 'params': params,
        'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
        'events': events,
    }


def run_nearest_grid(audio_path, upstream, params, on_progress):
    return _run_quant('nearest-grid', upstream, params, on_progress, scorer=None)


def _strong_beat_scorer(default_tick, t_pre, segs, resolution, grid_payload, default_div):
    tol_s = 0.030
    candidates = []
    for div in (default_div, default_div // 2, max(1, default_div // 4)):
        tick, t_post = _snap_to_grid(t_pre, segs, resolution, div)
        if abs(t_post - t_pre) <= tol_s:
            candidates.append((_compute_metric_weight(tick, grid_payload), tick, t_post))
    if not candidates:
        return default_tick, tick_to_seconds(default_tick, segs, resolution)
    candidates.sort(reverse=True)
    return candidates[0][1], candidates[0][2]


def run_strong_beat_priority(audio_path, upstream, params, on_progress):
    return _run_quant('strong-beat-priority', upstream, params, on_progress, scorer=_strong_beat_scorer)


def _metric_weighted_scorer(default_tick, t_pre, segs, resolution, grid_payload, default_div):
    """Score = -distance_ms + 10*metric_weight; pick best within window."""
    candidates = []
    for div in (default_div, default_div // 2, max(1, default_div // 4)):
        tick, t_post = _snap_to_grid(t_pre, segs, resolution, div)
        d_ms = abs(t_post - t_pre) * 1000.0
        w = _compute_metric_weight(tick, grid_payload)
        score = -d_ms + 10 * w
        candidates.append((score, tick, t_post))
    candidates.sort(reverse=True)
    return candidates[0][1], candidates[0][2]


def run_metric_weighted(audio_path, upstream, params, on_progress):
    return _run_quant('metric-weighted', upstream, params, on_progress, scorer=_metric_weighted_scorer)


for _id, _name, _runner in (
    ('nearest-grid', 'Nearest grid (simple)', run_nearest_grid),
    ('strong-beat-priority', 'Strong beat priority', run_strong_beat_priority),
    ('metric-weighted', 'Metric weighted (recommended)', run_metric_weighted),
):
    register_engine(Stage.QUANTIZED, EngineSpec(
        id=_id, display_name=_name, params_schema=_NEAREST_PARAMS, runner=_runner,
    ))
