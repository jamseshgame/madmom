"""S3 engine: `yin` — monophonic pitch via librosa.pyin."""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any, Callable

import numpy as np

from ..audio_io import load_audio
from ..registry import EngineSpec, Stage, register_engine


_PARAMS_SCHEMA = {
    'fmin_hz': {'type': 'number', 'min': 30, 'max': 200, 'step': 1, 'default': 65,
                'label': 'Min pitch (Hz)'},
    'fmax_hz': {'type': 'number', 'min': 1000, 'max': 4000, 'step': 10, 'default': 2000,
                'label': 'Max pitch (Hz)'},
    'window_ms': {'type': 'number', 'min': 5, 'max': 100, 'step': 1, 'default': 30,
                  'label': 'Window around onset (ms)'},
}


def _hz_to_midi(hz: float) -> int:
    return int(round(69 + 12 * np.log2(hz / 440.0)))


def run_yin(audio_path: Path, upstream, params, on_progress):
    if audio_path is None:
        raise ValueError('yin requires a stem audio file')
    onsets_payload = upstream.get('onsets')
    if onsets_payload is None:
        raise ValueError('S3 requires upstream onsets')
    import librosa
    y, sr = load_audio(audio_path, target_sr=22050, mono=True)

    fmin = float(params.get('fmin_hz', 65))
    fmax = float(params.get('fmax_hz', 2000))
    window_s = float(params.get('window_ms', 30)) / 1000.0

    on_progress('analyse', 30, 'Running pyin…')
    f0, voiced, voiced_prob = librosa.pyin(y, fmin=fmin, fmax=fmax, sr=sr)
    frame_times = librosa.times_like(f0, sr=sr)

    per_onset = []
    for o in onsets_payload['onsets']:
        t = float(o['time_s'])
        mask = (frame_times >= t) & (frame_times <= t + window_s)
        if not mask.any():
            per_onset.append({'time_s': t, 'dominant_midi': None,
                              'dominant_confidence': None, 'polyphony': 1, 'all_pitches_midi': []})
            continue
        hz = f0[mask]
        prob = voiced_prob[mask]
        valid = ~np.isnan(hz)
        if not valid.any():
            per_onset.append({'time_s': t, 'dominant_midi': None,
                              'dominant_confidence': None, 'polyphony': 1, 'all_pitches_midi': []})
            continue
        med_hz = float(np.median(hz[valid]))
        midi = _hz_to_midi(med_hz)
        per_onset.append({
            'time_s': t,
            'dominant_midi': midi,
            'dominant_confidence': float(np.mean(prob[valid])),
            'polyphony': 1,
            'all_pitches_midi': [midi],
        })

    on_progress('done', 100, f'{len(per_onset)} per-onset entries')
    return {
        'engine': 'yin', 'params': params,
        'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
        'per_onset': per_onset,
    }


register_engine(Stage.PITCHES, EngineSpec(
    id='yin', display_name='pyin (monophonic)',
    params_schema=_PARAMS_SCHEMA, runner=run_yin,
))
