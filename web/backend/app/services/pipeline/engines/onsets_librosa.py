"""S2 engine: `librosa-onset` — pure-Python fallback."""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any, Callable

from ..audio_io import load_audio
from ..registry import EngineSpec, Stage, register_engine


_PARAMS_SCHEMA = {
    'delta': {'type': 'number', 'min': 0.0, 'max': 0.5, 'step': 0.01, 'default': 0.07,
              'label': 'Onset strength delta'},
    'backtrack': {'type': 'boolean', 'default': True,
                  'label': 'Backtrack to nearest local energy minimum'},
    'min_gap_ms': {'type': 'number', 'min': 0, 'max': 500, 'step': 5, 'default': 0,
                   'label': 'Minimum gap between onsets (ms)'},
}


def run_librosa_onsets(
    audio_path: Path,
    upstream: dict,
    params: dict[str, Any],
    on_progress: Callable[[str, int, str], None],
) -> dict[str, Any]:
    if audio_path is None:
        raise ValueError('librosa-onset requires a stem audio file')
    import librosa
    on_progress('load', 10, 'Loading audio…')
    y, sr = load_audio(audio_path, target_sr=22050, mono=True)
    on_progress('detect', 50, 'Detecting onsets…')
    frames = librosa.onset.onset_detect(
        y=y, sr=sr,
        delta=float(params.get('delta', 0.07)),
        backtrack=bool(params.get('backtrack', True)),
        units='frames',
    )
    times = librosa.frames_to_time(frames, sr=sr).tolist()
    min_gap = float(params.get('min_gap_ms', 0)) / 1000.0
    filtered: list[float] = []
    for t in times:
        if filtered and (t - filtered[-1]) < min_gap:
            continue
        filtered.append(t)
    onsets = [{'time_s': float(t), 'confidence': None, 'source_note_id': None} for t in filtered]
    on_progress('done', 100, f'{len(onsets)} onsets')
    return {
        'engine': 'librosa-onset',
        'params': params,
        'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
        'onsets': onsets,
    }


register_engine(Stage.ONSETS, EngineSpec(
    id='librosa-onset',
    display_name='librosa onset_detect',
    params_schema=_PARAMS_SCHEMA,
    runner=run_librosa_onsets,
))
