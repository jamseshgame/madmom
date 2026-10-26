"""S2 engine: `madmom-onset` — note onsets from madmom's CNN/RNN onset
detector, with peak picking.

Why: on four Harmonix guitar references, charts whose onsets came from
basic-pitch's note starts were a wall of 16ths — 74 % of consecutive gaps
exactly one 16th, 1.1–1.8× Harmonix's note count, precision 0.48–0.62 —
because the transcriber re-triggers on ringing distorted chords string by
string. Onset *timing* should come from a detector trained on real music
attacks; the transcriber is then only asked *what pitches* sound at each
onset (`pitches: basic-pitch` matches its note events to these onsets).

madmom's `CNNOnsetProcessor` (Schlüter & Böck 2014) is the stronger of the
two and ships in this repo's models submodule. Peak picking uses madmom's
`OnsetPeakPickingProcessor`; `combine_ms` merges onsets closer than a
16th at fast tempos, which is what stops strum splitting.
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any, Callable

import numpy as np

from ..registry import EngineSpec, Stage, register_engine


_PARAMS_SCHEMA = {
    'model': {'type': 'enum', 'options': ['cnn', 'rnn'], 'default': 'cnn',
              'label': 'Onset model'},
    'threshold': {'type': 'number', 'min': 0.1, 'max': 0.9, 'step': 0.02, 'default': 0.54,
                  'label': 'Peak threshold (madmom default 0.54)'},
    'combine_ms': {'type': 'number', 'min': 10, 'max': 150, 'step': 5, 'default': 60,
                   'label': 'Merge onsets closer than (ms)'},
    'smooth_ms': {'type': 'number', 'min': 0, 'max': 100, 'step': 5, 'default': 0,
                  'label': 'Activation smoothing (ms)'},
    'min_gap_ms': {'type': 'number', 'min': 0, 'max': 300, 'step': 5, 'default': 0,
                   'label': 'Extra minimum gap after peak picking (ms)'},
}


def detect_onsets_madmom(audio_path: Path, model: str, threshold: float, combine_s: float,
                         smooth_s: float) -> tuple[np.ndarray, np.ndarray]:
    """Return (onset_times_s, activation_at_onset). Split out for tests."""
    from madmom.features.onsets import CNNOnsetProcessor, OnsetPeakPickingProcessor, RNNOnsetProcessor

    proc = CNNOnsetProcessor() if model == 'cnn' else RNNOnsetProcessor()
    act = np.asarray(proc(str(audio_path)), dtype=np.float64)
    picker = OnsetPeakPickingProcessor(threshold=threshold, combine=combine_s, smooth=smooth_s, fps=100)
    times = np.asarray(picker(act), dtype=np.float64)
    idx = np.clip((times * 100).round().astype(int), 0, max(0, len(act) - 1))
    conf = act[idx] if len(act) else np.zeros_like(times)
    return times, conf


def run_madmom_onsets(audio_path: Path | None, upstream: dict, params: dict[str, Any],
                      on_progress: Callable[[str, int, str], None]) -> dict[str, Any]:
    if audio_path is None:
        raise ValueError('madmom-onset requires a stem audio file')
    model = str(params.get('model', 'cnn'))
    threshold = float(params.get('threshold', 0.54))
    combine_s = float(params.get('combine_ms', 60)) / 1000.0
    smooth_s = float(params.get('smooth_ms', 0)) / 1000.0
    min_gap_s = float(params.get('min_gap_ms', 0)) / 1000.0

    on_progress('detect', 20, f'Running madmom {model.upper()} onset detector…')
    times, conf = detect_onsets_madmom(audio_path, model, threshold, combine_s, smooth_s)
    onsets = []
    last = -1e9
    for t, c in zip(times, conf):
        if t - last < min_gap_s:
            continue
        onsets.append({'time_s': float(t), 'confidence': float(min(1.0, max(0.0, c))), 'source_note_id': None})
        last = t
    on_progress('done', 100, f'{len(onsets)} onsets')
    return {
        'engine': 'madmom-onset', 'params': params,
        'generated_at': dt.datetime.now(dt.UTC).isoformat().replace('+00:00', 'Z'),
        'onsets': onsets,
    }


register_engine(Stage.ONSETS, EngineSpec(
    id='madmom-onset',
    display_name='madmom CNN onsets (recommended for pitched stems)',
    params_schema=_PARAMS_SCHEMA,
    runner=run_madmom_onsets,
))
