"""S1 engine: `librosa-beat`.

Uses librosa.beat.beat_track for beat positions, derives downbeats by
assuming the param-specified time signature, generates sections via
librosa.segment.agglomerative on MFCC self-similarity, and infers
key via Krumhansl-Schmuckler over chroma_cqt.

Lightweight alternative to all-in-one — runs in seconds on CPU, no
model download. Accuracy is genre-dependent.
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any, Callable

import numpy as np

from ..audio_io import load_audio
from ..registry import EngineSpec, Stage, register_engine


_PARAMS_SCHEMA = {
    'time_sig_num': {'type': 'enum', 'options': [3, 4, 6], 'default': 4,
                     'label': 'Time signature numerator (assumed)'},
    'resolution': {'type': 'enum', 'options': [192, 480], 'default': 192,
                   'label': 'Tick resolution'},
    'max_sections': {'type': 'number', 'min': 2, 'max': 16, 'step': 1, 'default': 8,
                     'label': 'Max sections'},
}


def _seconds_to_ticks_constant(t_s: float, bpm: float, resolution: int) -> int:
    return int(round(t_s * bpm / 60.0 * resolution))


def _detect_key(y: np.ndarray, sr: int) -> dict[str, Any]:
    import librosa
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    major = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    minor = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
    keys = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    best = ('C', 'major', -1.0)
    for shift in range(12):
        rotated = np.roll(chroma, -shift)
        for mode, profile in (('major', major), ('minor', minor)):
            r = np.corrcoef(rotated, profile)[0, 1]
            if r > best[2]:
                best = (keys[shift], mode, float(r))
    return {'tonic': best[0], 'mode': best[1], 'confidence': max(0.0, min(1.0, (best[2] + 1) / 2))}


def _detect_sections(y: np.ndarray, sr: int, max_sections: int) -> list[float]:
    """Return section boundary times in seconds (start of each section)."""
    import librosa
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
    boundaries = librosa.segment.agglomerative(mfcc, k=min(max_sections, max(2, mfcc.shape[1] // 50)))
    times = librosa.frames_to_time(boundaries, sr=sr)
    if len(times) == 0 or times[0] > 0.5:
        times = np.insert(times, 0, 0.0)
    return [float(t) for t in times]


def run_librosa_grid(
    audio_path: Path,
    upstream: dict,
    params: dict[str, Any],
    on_progress: Callable[[str, int, str], None],
) -> dict[str, Any]:
    if audio_path is None:
        raise ValueError('librosa-beat requires a full-mix audio file')
    import librosa
    ts_num = int(params.get('time_sig_num') or 4)
    resolution = int(params.get('resolution') or 192)
    max_sections = int(params.get('max_sections') or 8)

    on_progress('load', 5, 'Loading audio…')
    y, sr = load_audio(audio_path, target_sr=22050, mono=True)
    duration = float(len(y)) / sr

    on_progress('beats', 20, 'Tracking beats…')
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units='frames')
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    bpm = float(np.atleast_1d(tempo)[0])

    on_progress('downbeats', 50, 'Inferring downbeats (assuming N/4-like)…')
    downbeat_times = beat_times[::ts_num] if len(beat_times) else np.array([0.0])
    downbeat_ticks = [_seconds_to_ticks_constant(t, bpm, resolution) for t in downbeat_times]

    on_progress('sections', 75, 'Segmenting structure…')
    section_times = _detect_sections(y, sr, max_sections)
    section_ticks: list[dict] = []
    for i, t in enumerate(section_times):
        section_ticks.append({
            'tick_start': _seconds_to_ticks_constant(t, bpm, resolution),
            'label': f'section_{i}',
        })

    on_progress('key', 90, 'Detecting key…')
    key = _detect_key(y, sr)

    payload = {
        'engine': 'librosa-beat',
        'params': params,
        'audio_duration_s': duration,
        'resolution': resolution,
        'tempo_segments': [{'tick_start': 0, 'micro_bpm': int(round(bpm * 1000)), 'label': 'main'}],
        'time_sig_segments': [{'tick_start': 0, 'num': ts_num, 'denom_pow': 2}],
        'downbeats': downbeat_ticks,
        'sections': section_ticks or [{'tick_start': 0, 'label': 'song'}],
        'detected_key': key,
        'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
    }
    on_progress('done', 100, f'BPM={bpm:.1f} sections={len(section_ticks)}')
    return payload


register_engine(Stage.GRID, EngineSpec(
    id='librosa-beat',
    display_name='librosa beat_track (lightweight)',
    params_schema=_PARAMS_SCHEMA,
    runner=run_librosa_grid,
))
