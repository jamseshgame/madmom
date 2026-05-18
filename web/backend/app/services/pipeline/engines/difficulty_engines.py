"""S7 engines: difficulty reduction."""
from __future__ import annotations

import datetime as dt
from typing import Any

from ..registry import EngineSpec, Stage, register_engine


_PARAMS = {
    'easy': {'type': 'enum', 'options': [],
             'default': {'min_weight': 4, 'demote_chord_size': 1, 'max_density_per_sec': 2},
             'label': 'Easy params'},
    'medium': {'type': 'enum', 'options': [],
               'default': {'min_weight': 3, 'demote_chord_size': 1, 'max_density_per_sec': 4},
               'label': 'Medium params'},
    'hard': {'type': 'enum', 'options': [],
             'default': {'min_weight': 2, 'demote_chord_size': None, 'max_density_per_sec': None},
             'label': 'Hard params'},
}


def _weight_for(ev: dict, metric_weights: dict[str, int]) -> int:
    w = metric_weights.get(str(ev['tick']))
    if w is None:
        return 2 if len(ev['frets']) == 1 else 3
    return int(w)


def _filter_for_difficulty(
    lanes: list[dict], metric_weights: dict[str, int], cfg: dict[str, Any],
) -> list[dict]:
    min_w = int(cfg.get('min_weight', 0))
    demote = cfg.get('demote_chord_size')
    out: list[dict] = []
    for ev in lanes:
        w = _weight_for(ev, metric_weights)
        is_open = ev['frets'] == [7]
        threshold = min_w - (1 if is_open else 0)
        if w < threshold:
            continue
        new_ev = dict(ev)
        if demote is not None and len(new_ev['frets']) > demote:
            new_ev['frets'] = sorted(new_ev['frets'])[:int(demote)]
        out.append(new_ev)
    return out


def run_metric_weight(audio_path, upstream, params, on_progress):
    inp = upstream.get('lanes_filtered')
    if inp is None:
        raise ValueError('S7 requires upstream lanes_filtered')
    metric_weights = inp.get('metric_weights') or {}
    by_difficulty = {}
    for diff in ('easy', 'medium', 'hard'):
        cfg = params.get(diff) or _PARAMS[diff]['default']
        by_difficulty[diff] = {
            'engine': 'metric-weight', 'params': cfg,
            'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
            'lanes': _filter_for_difficulty(inp['lanes'], metric_weights, cfg),
        }
    return {
        'engine': 'metric-weight', 'params': params,
        'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
        'by_difficulty': by_difficulty,
    }


def run_density_target(audio_path, upstream, params, on_progress):
    inp = upstream.get('lanes_filtered')
    if inp is None:
        raise ValueError('S7 requires upstream lanes_filtered')
    metric_weights = inp.get('metric_weights') or {}
    targets = params.get('targets') or {'easy': 2.0, 'medium': 4.0, 'hard': 0.0}
    by_difficulty = {}
    for diff in ('easy', 'medium', 'hard'):
        tgt = float(targets.get(diff) or 0)
        if tgt <= 0:
            kept = inp['lanes']
        else:
            with_weights = [(ev, _weight_for(ev, metric_weights)) for ev in inp['lanes']]
            with_weights.sort(key=lambda x: x[1])
            duration = max(1, inp['lanes'][-1]['tick']) / 192.0
            max_count = int(tgt * duration)
            with_weights = with_weights[-max_count:] if len(with_weights) > max_count else with_weights
            kept = [e for e, _w in sorted(with_weights, key=lambda x: x[0]['tick'])]
        by_difficulty[diff] = {
            'engine': 'density-target', 'params': {'target_per_sec': tgt},
            'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
            'lanes': kept,
        }
    return {
        'engine': 'density-target', 'params': params,
        'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
        'by_difficulty': by_difficulty,
    }


def run_none(audio_path, upstream, params, on_progress):
    inp = upstream.get('lanes_filtered')
    if inp is None:
        raise ValueError('S7 requires upstream lanes_filtered')
    base = {
        'engine': 'none', 'params': {},
        'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
        'lanes': inp['lanes'],
    }
    return {
        'engine': 'none', 'params': params,
        'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
        'by_difficulty': {'easy': base, 'medium': base, 'hard': base},
    }


# Register against all three lanes_{hard,medium,easy} stages — each gets the
# same engine list since they're produced together.
for _stage in (Stage.LANES_HARD, Stage.LANES_MEDIUM, Stage.LANES_EASY):
    for _id, _name, _runner in (
        ('metric-weight', 'Metric-weight thinning (recommended)', run_metric_weight),
        ('density-target', 'Density target', run_density_target),
        ('none', 'No reduction (mirror Expert)', run_none),
    ):
        register_engine(_stage, EngineSpec(
            id=_id, display_name=_name, params_schema=_PARAMS, runner=_runner,
        ))
