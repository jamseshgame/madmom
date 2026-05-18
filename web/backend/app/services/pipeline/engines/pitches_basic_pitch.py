"""S3 engine: `basic-pitch`. Pulls per-onset pitch + polyphony from the
cached inference produced by S2."""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any, Callable

from ..basic_pitch_runner import run_basic_pitch
from ..registry import EngineSpec, Stage, register_engine


_PARAMS_SCHEMA = {
    'polyphony_window_ms': {'type': 'number', 'min': 5, 'max': 100, 'step': 1, 'default': 30,
                            'label': 'Polyphony detection window (ms)'},
    'pitch_confidence_threshold': {'type': 'number', 'min': 0.1, 'max': 0.9, 'step': 0.05, 'default': 0.3,
                                   'label': 'Pitch confidence threshold'},
}


def run_basic_pitch_pitches(
    audio_path: Path,
    upstream: dict,
    params: dict[str, Any],
    on_progress: Callable[[str, int, str], None],
) -> dict[str, Any]:
    onsets_payload = upstream.get('onsets')
    if onsets_payload is None:
        raise ValueError('S3 requires upstream `onsets` from S2')

    on_progress('predict', 20, 'Reusing basic-pitch inference…')
    bp_params = {k: onsets_payload.get('params', {}).get(k)
                 for k in ('onset_threshold', 'min_note_length_ms')
                 if onsets_payload.get('params', {}).get(k) is not None}
    bp_params['pitch_confidence_threshold'] = params.get('pitch_confidence_threshold', 0.3)
    result = run_basic_pitch(audio_path, bp_params)

    poly_window_s = float(params.get('polyphony_window_ms', 30)) / 1000.0

    per_onset = []
    for onset in onsets_payload['onsets']:
        t = float(onset['time_s'])
        active = [
            n for n in result.note_events
            if abs(n['onset_s'] - t) <= poly_window_s / 2.0
        ]
        if not active:
            per_onset.append({
                'time_s': t,
                'dominant_midi': None,
                'dominant_confidence': None,
                'polyphony': 1,
                'all_pitches_midi': [],
            })
            continue
        leader = max(active, key=lambda n: n['amplitude'])
        per_onset.append({
            'time_s': t,
            'dominant_midi': int(leader['pitch_midi']),
            'dominant_confidence': float(min(1.0, leader['amplitude'])),
            'polyphony': len(active),
            'all_pitches_midi': [int(n['pitch_midi']) for n in active],
        })

    on_progress('done', 100, f'{len(per_onset)} per-onset entries')
    return {
        'engine': 'basic-pitch',
        'params': params,
        'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
        'per_onset': per_onset,
    }


register_engine(Stage.PITCHES, EngineSpec(
    id='basic-pitch',
    display_name='basic-pitch (reuses S2 inference)',
    params_schema=_PARAMS_SCHEMA,
    runner=run_basic_pitch_pitches,
))
