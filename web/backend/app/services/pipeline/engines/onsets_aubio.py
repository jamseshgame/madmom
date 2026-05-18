"""S2 engine: `aubio-complex` — fast C-backed onset detector."""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any, Callable

from ..registry import EngineSpec, Stage, register_engine


_PARAMS_SCHEMA = {
    'method': {'type': 'enum', 'options': ['complex', 'hfc', 'energy', 'specflux'],
               'default': 'complex', 'label': 'Onset method'},
    'threshold': {'type': 'number', 'min': 0.0, 'max': 1.0, 'step': 0.01, 'default': 0.3,
                  'label': 'Onset threshold'},
    'min_gap_ms': {'type': 'number', 'min': 0, 'max': 500, 'step': 5, 'default': 20,
                   'label': 'Minimum gap (ms)'},
}


def run_aubio_onsets(
    audio_path: Path,
    upstream: dict,
    params: dict[str, Any],
    on_progress: Callable[[str, int, str], None],
) -> dict[str, Any]:
    if audio_path is None:
        raise ValueError('aubio requires a stem audio file')
    import aubio
    method = params.get('method', 'complex')
    threshold = float(params.get('threshold', 0.3))
    min_gap_ms = float(params.get('min_gap_ms', 20))

    win_s = 1024
    hop_s = 512
    src = aubio.source(str(audio_path), 0, hop_s)
    sr = src.samplerate
    o = aubio.onset(method, win_s, hop_s, sr)
    o.set_threshold(threshold)
    o.set_minioi_ms(min_gap_ms)

    onsets: list[dict[str, Any]] = []
    on_progress('detect', 10, f'Running aubio ({method})…')
    while True:
        samples, read = src()
        if o(samples):
            onsets.append({
                'time_s': float(o.get_last_s()),
                'confidence': float(o.get_descriptor()),
                'source_note_id': None,
            })
        if read < hop_s:
            break

    on_progress('done', 100, f'{len(onsets)} onsets')
    return {
        'engine': 'aubio-complex',
        'params': params,
        'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
        'onsets': onsets,
    }


register_engine(Stage.ONSETS, EngineSpec(
    id='aubio-complex',
    display_name='aubio (C-backed, fast)',
    params_schema=_PARAMS_SCHEMA,
    runner=run_aubio_onsets,
))
