"""S1 engine: `librosa-anchored` — librosa beat tracking, but the beat
*times* drive a piecewise tempo map (see `beat_grid`) instead of a single
BPM anchored at t=0. Same detector as `librosa-beat`, so comparing the two
isolates the effect of the grid fix (preset `v12 — grid only`).

Downbeats are still assumed every N beats from the first detected beat;
use `madmom-downbeat` when bar positions matter.
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any, Callable

import numpy as np

from ..audio_io import load_audio
from ..beat_grid import beats_to_grid
from ..registry import EngineSpec, Stage, register_engine
from .grid_librosa import _detect_key, _detect_sections


_PARAMS_SCHEMA = {
    'time_sig_num': {'type': 'enum', 'options': [3, 4, 6], 'default': 4,
                     'label': 'Time signature numerator (assumed)'},
    'first_downbeat_beat': {'type': 'number', 'min': 0, 'max': 5, 'step': 1, 'default': 0,
                            'label': 'Index of the first downbeat among detected beats'},
    'resolution': {'type': 'enum', 'options': [192, 480], 'default': 192,
                   'label': 'Tick resolution'},
    'tightness': {'type': 'number', 'min': 50, 'max': 400, 'step': 10, 'default': 100,
                  'label': 'Beat tracker tightness (higher = steadier tempo)'},
    'merge_tol_ms': {'type': 'number', 'min': 1, 'max': 30, 'step': 1, 'default': 5,
                     'label': 'Tempo-map merge tolerance (ms)'},
    'max_sections': {'type': 'number', 'min': 0, 'max': 16, 'step': 1, 'default': 8,
                     'label': 'Max structural sections (0 = none)'},
}


def run_librosa_anchored_grid(
    audio_path: Path | None,
    upstream: dict,
    params: dict[str, Any],
    on_progress: Callable[[str, int, str], None],
) -> dict[str, Any]:
    if audio_path is None:
        raise ValueError('librosa-anchored requires a full-mix audio file')
    import librosa

    ts_num = int(params.get('time_sig_num') or 4)
    first_db = int(params.get('first_downbeat_beat') or 0)
    resolution = int(params.get('resolution') or 192)
    tightness = float(params.get('tightness') or 100)
    merge_tol_ms = float(params.get('merge_tol_ms') or 5)
    max_sections = int(params.get('max_sections') if params.get('max_sections') is not None else 8)

    on_progress('load', 5, 'Loading audio…')
    y, sr = load_audio(audio_path, target_sr=22050, mono=True)
    duration = float(len(y)) / sr

    on_progress('beats', 20, 'Tracking beats…')
    _tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units='frames', tightness=tightness)
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    if len(beat_times) == 0:
        raise ValueError('librosa found no beats in the audio')
    db_idx = list(range(first_db % ts_num, len(beat_times), ts_num))

    on_progress('sections', 60, 'Segmenting structure…')
    section_times = _detect_sections(y, sr, max_sections) if max_sections > 0 else []
    on_progress('key', 75, 'Detecting key…')
    key = _detect_key(y, sr)

    on_progress('grid', 90, 'Building beat-anchored tempo map…')
    core = beats_to_grid(
        beat_times, resolution=resolution, audio_duration_s=duration,
        downbeat_indices=db_idx, beats_per_bar=ts_num,
        merge_tol_ms=merge_tol_ms, section_times=section_times or None,
    )
    payload = {
        'engine': 'librosa-anchored',
        'params': params,
        'generated_at': dt.datetime.now(dt.UTC).isoformat().replace('+00:00', 'Z'),
        'detected_key': key,
        'beat_times_s': [float(t) for t in np.asarray(beat_times)],
        **core,
    }
    on_progress('done', 100, f'{len(beat_times)} beats, {len(core["tempo_segments"])} tempo segments')
    return payload


register_engine(Stage.GRID, EngineSpec(
    id='librosa-anchored',
    display_name='librosa beat_track, beat-anchored tempo map',
    params_schema=_PARAMS_SCHEMA,
    runner=run_librosa_anchored_grid,
))
