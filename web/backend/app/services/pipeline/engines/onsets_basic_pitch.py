"""S2 engine: `basic-pitch`. Produces onsets + source_note_ids."""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any, Callable

from ..basic_pitch_runner import run_basic_pitch
from ..registry import EngineSpec, Stage, register_engine


_PARAMS_SCHEMA = {
    'onset_threshold': {'type': 'number', 'min': 0.1, 'max': 0.9, 'step': 0.05, 'default': 0.5,
                        'label': 'Onset threshold'},
    'min_note_length_ms': {'type': 'number', 'min': 10, 'max': 500, 'step': 5, 'default': 50,
                           'label': 'Min note length (ms)'},
}


def run_basic_pitch_onsets(
    audio_path: Path,
    upstream: dict,
    params: dict[str, Any],
    on_progress: Callable[[str, int, str], None],
) -> dict[str, Any]:
    if audio_path is None:
        raise ValueError('basic-pitch requires a stem audio file')
    on_progress('predict', 20, 'Running basic-pitch…')
    result = run_basic_pitch(audio_path, params)

    notes = sorted(result.note_events, key=lambda n: n['onset_s'])
    clusters: list[list[dict]] = []
    for n in notes:
        if clusters and (n['onset_s'] - clusters[-1][-1]['onset_s']) <= 0.015:
            clusters[-1].append(n)
        else:
            clusters.append([n])

    onsets = []
    for cluster in clusters:
        leader = max(cluster, key=lambda n: n['amplitude'])
        onsets.append({
            'time_s': leader['onset_s'],
            'confidence': min(1.0, leader['amplitude']),
            'source_note_id': leader['id'],
        })

    on_progress('done', 100, f'{len(onsets)} onsets')
    return {
        'engine': 'basic-pitch',
        'params': params,
        'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
        'onsets': onsets,
    }


register_engine(Stage.ONSETS, EngineSpec(
    id='basic-pitch',
    display_name='basic-pitch (polyphonic transcription)',
    params_schema=_PARAMS_SCHEMA,
    runner=run_basic_pitch_onsets,
))
