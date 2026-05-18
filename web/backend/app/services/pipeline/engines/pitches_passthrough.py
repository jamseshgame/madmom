"""S3 engine: `passthrough` — emit null pitches, polyphony=1."""
from __future__ import annotations

import datetime as dt

from ..registry import EngineSpec, Stage, register_engine


def run_passthrough(audio_path, upstream, params, on_progress):
    onsets_payload = upstream.get('onsets')
    if onsets_payload is None:
        raise ValueError('S3 requires upstream onsets')
    per_onset = [
        {'time_s': float(o['time_s']), 'dominant_midi': None,
         'dominant_confidence': None, 'polyphony': 1, 'all_pitches_midi': []}
        for o in onsets_payload['onsets']
    ]
    return {
        'engine': 'passthrough', 'params': params,
        'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
        'per_onset': per_onset,
    }


register_engine(Stage.PITCHES, EngineSpec(
    id='passthrough', display_name='Passthrough (no pitch)',
    params_schema={}, runner=run_passthrough,
))
