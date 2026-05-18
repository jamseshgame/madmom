"""S6 engines: post-process Expert lanes for playability."""
from __future__ import annotations

import datetime as dt
from typing import Any

from ..registry import EngineSpec, Stage, register_engine


_SPREAD_PARAMS = {
    'max_same_fret_run': {'type': 'number', 'min': 2, 'max': 16, 'step': 1, 'default': 4,
                          'label': 'Max consecutive same-fret notes'},
}

_CRAMP_PARAMS = {
    'max_jump': {'type': 'number', 'min': 1, 'max': 4, 'step': 1, 'default': 3,
                 'label': 'Max lanes between consecutive notes'},
    'min_gap_ticks': {'type': 'number', 'min': 1, 'max': 384, 'step': 1, 'default': 96,
                      'label': 'Min ticks between notes to skip enforcement'},
}


def run_identity(audio_path, upstream, params, on_progress):
    inp = upstream.get('lanes_expert')
    if inp is None:
        raise ValueError('S6 requires upstream lanes_expert')
    return {
        'engine': 'identity', 'params': params,
        'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
        'lanes': inp['lanes'],
        'edits': [],
    }


def run_spread_fretboard(audio_path, upstream, params, on_progress):
    inp = upstream.get('lanes_expert')
    if inp is None:
        raise ValueError('S6 requires upstream lanes_expert')
    max_run = int(params.get('max_same_fret_run', 4))
    lanes = [dict(l) for l in inp['lanes']]
    edits: list[dict[str, Any]] = []
    run_count = 0
    run_fret = None
    for i, ev in enumerate(lanes):
        if len(ev['frets']) != 1:
            run_count = 0
            run_fret = None
            continue
        f = ev['frets'][0]
        if f == run_fret:
            run_count += 1
            if run_count > max_run:
                new_f = f + 1 if f < 4 else f - 1
                edits.append({'tick': ev['tick'], 'kind': 'displace',
                              'from': [f], 'to': [new_f], 'reason': 'same_fret_run'})
                ev['frets'] = [new_f]
                run_count = 0
                run_fret = new_f
        else:
            run_count = 1
            run_fret = f
    on_progress('done', 100, f'{len(edits)} displacements')
    return {
        'engine': 'spread-fretboard', 'params': params,
        'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
        'lanes': lanes, 'edits': edits,
    }


def run_avoid_cramps(audio_path, upstream, params, on_progress):
    inp = upstream.get('lanes_expert')
    if inp is None:
        raise ValueError('S6 requires upstream lanes_expert')
    max_jump = int(params.get('max_jump', 3))
    min_gap_ticks = int(params.get('min_gap_ticks', 96))
    lanes = [dict(l) for l in inp['lanes']]
    edits: list[dict[str, Any]] = []
    for i in range(1, len(lanes)):
        prev = lanes[i - 1]
        curr = lanes[i]
        if len(prev['frets']) != 1 or len(curr['frets']) != 1:
            continue
        if prev['frets'][0] == 7 or curr['frets'][0] == 7:
            continue
        if curr['tick'] - prev['tick'] >= min_gap_ticks:
            continue
        jump = abs(curr['frets'][0] - prev['frets'][0])
        if jump <= max_jump:
            continue
        direction = 1 if curr['frets'][0] > prev['frets'][0] else -1
        new_f = curr['frets'][0] - direction * (jump - max_jump)
        new_f = max(0, min(4, new_f))
        edits.append({'tick': curr['tick'], 'kind': 'displace',
                      'from': curr['frets'], 'to': [new_f],
                      'reason': 'max_jump_exceeded'})
        curr['frets'] = [new_f]
    on_progress('done', 100, f'{len(edits)} demotions')
    return {
        'engine': 'avoid-cramps', 'params': params,
        'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
        'lanes': lanes, 'edits': edits,
    }


for _id, _name, _schema, _runner in (
    ('identity', 'Identity (pass-through, default)', {}, run_identity),
    ('spread-fretboard', 'Spread fretboard (anti-repetition)', _SPREAD_PARAMS, run_spread_fretboard),
    ('avoid-cramps', 'Avoid hand cramps (max jump)', _CRAMP_PARAMS, run_avoid_cramps),
):
    register_engine(Stage.LANES_FILTERED, EngineSpec(
        id=_id, display_name=_name, params_schema=_schema, runner=_runner,
    ))
