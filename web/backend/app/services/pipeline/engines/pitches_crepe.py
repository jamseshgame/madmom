"""S3 engine: `crepe` — monophonic pitch via torchcrepe."""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any, Callable

import numpy as np

from ..audio_io import load_audio
from ..registry import EngineSpec, Stage, register_engine


_PARAMS_SCHEMA = {
    # Only `tiny.pth` and `full.pth` ship inside torchcrepe — the other
    # sizes need a manual checkpoint download, so listing them as default
    # options just traps users. Stick to the two that work out of the box.
    'model_size': {'type': 'enum', 'options': ['tiny', 'full'],
                   'default': 'full', 'label': 'CREPE model size'},
    'window_ms': {'type': 'number', 'min': 5, 'max': 100, 'step': 1, 'default': 30,
                  'label': 'Window around onset (ms)'},
}


def _hz_to_midi(hz: float) -> int:
    return int(round(69 + 12 * np.log2(max(1e-6, hz) / 440.0)))


def run_crepe(audio_path: Path, upstream, params, on_progress):
    if audio_path is None:
        raise ValueError('crepe requires a stem audio file')
    onsets_payload = upstream.get('onsets')
    if onsets_payload is None:
        raise ValueError('S3 requires upstream onsets')
    import torch
    import torchcrepe

    y, sr = load_audio(audio_path, target_sr=16000, mono=True)
    audio = torch.from_numpy(y).unsqueeze(0)

    model_size = str(params.get('model_size', 'small'))
    window_s = float(params.get('window_ms', 30)) / 1000.0

    on_progress('analyse', 30, f'Running CREPE ({model_size})…')
    hop = 160  # 10 ms at 16 kHz
    pitch_hz, periodicity = torchcrepe.predict(
        audio, sr, hop,
        fmin=50.0, fmax=2000.0,
        model=model_size, return_periodicity=True,
        batch_size=1024,
        device='cuda' if torch.cuda.is_available() else 'cpu',
    )
    pitch_hz = pitch_hz[0].cpu().numpy()
    periodicity = periodicity[0].cpu().numpy()
    frame_times = np.arange(len(pitch_hz)) * hop / sr

    per_onset = []
    for o in onsets_payload['onsets']:
        t = float(o['time_s'])
        mask = (frame_times >= t) & (frame_times <= t + window_s)
        if not mask.any():
            per_onset.append({'time_s': t, 'dominant_midi': None,
                              'dominant_confidence': None, 'polyphony': 1, 'all_pitches_midi': []})
            continue
        hz = pitch_hz[mask]
        per = periodicity[mask]
        w = per / max(1e-6, per.sum())
        med_hz = float(np.average(hz, weights=w))
        midi = _hz_to_midi(med_hz)
        per_onset.append({
            'time_s': t,
            'dominant_midi': midi,
            'dominant_confidence': float(per.mean()),
            'polyphony': 1,
            'all_pitches_midi': [midi],
        })

    on_progress('done', 100, f'{len(per_onset)} per-onset entries')
    return {
        'engine': 'crepe', 'params': params,
        'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
        'per_onset': per_onset,
    }


register_engine(Stage.PITCHES, EngineSpec(
    id='crepe', display_name='CREPE (monophonic, DL)',
    params_schema=_PARAMS_SCHEMA, runner=run_crepe,
))
