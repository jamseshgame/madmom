"""S1 engine: `madmom-downbeat` — beat-anchored grid from madmom's RNN +
DBN downbeat tracker.

This repo *is* madmom; its `RNNDownBeatProcessor` → `DBNDownBeatTrackingProcessor`
is a far stronger beat/downbeat tracker than `librosa.beat.beat_track`, and
unlike the earlier S1 engines it gives bar positions, so downbeats and the
time signature come from the model rather than "every 4th beat from the
first one". The result is fed through `beat_grid.beats_to_grid`, which puts
every beat on a tick multiple and emits a piecewise tempo map, so the
quantizer's metric weights are real.

Requires the `madmom/models` submodule (the RNN weights). Structural
sections and key use librosa when available and are otherwise omitted.
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any, Callable

import numpy as np

from ..beat_grid import beats_to_grid, positions_to_downbeat_indices
from ..grid_support import audio_duration_s, calibrate_beats, optional_structure
from ..registry import EngineSpec, Stage, register_engine


_PARAMS_SCHEMA = {
    'beats_per_bar': {'type': 'enum', 'options': ['3,4', '4', '3', '2,3,4', '6'], 'default': '3,4',
                      'label': 'Allowed beats per bar (DBN searches these)'},
    'resolution': {'type': 'enum', 'options': [192, 480], 'default': 192,
                   'label': 'Tick resolution'},
    'merge_tol_ms': {'type': 'number', 'min': 1, 'max': 30, 'step': 1, 'default': 5,
                     'label': 'Tempo-map merge tolerance (ms)'},
    'smooth_tol_ms': {'type': 'number', 'min': 0, 'max': 60, 'step': 1, 'default': 30,
                      'label': 'Smooth beat-tracker jitter (ms, 0 = raw beats, one B marker per beat)'},
    'max_sections': {'type': 'number', 'min': 0, 'max': 16, 'step': 1, 'default': 8,
                     'label': 'Max structural sections (0 = none)'},
    'min_bpm': {'type': 'number', 'min': 40, 'max': 150, 'step': 1, 'default': 55,
                'label': 'Min tempo (BPM)'},
    'max_bpm': {'type': 'number', 'min': 120, 'max': 300, 'step': 1, 'default': 215,
                'label': 'Max tempo (BPM)'},
    'snap_to_transients': {'type': 'boolean', 'default': True,
                           'label': 'Shift grid to drum transients (beat trackers run ~25 ms early)'},
    'beat_offset_ms': {'type': 'number', 'min': -100, 'max': 100, 'step': 1, 'default': 0,
                       'label': 'Extra manual grid offset (ms, + = later)'},
}


def _parse_bpb(raw: Any) -> list[int]:
    items = raw if isinstance(raw, (list, tuple)) else str(raw).replace(' ', '').split(',')
    vals = []
    for v in items:
        try:
            vals.append(int(v))
        except (TypeError, ValueError):
            continue
    return sorted({v for v in vals if 1 <= v <= 16}) or [3, 4]


def track_beats_madmom(audio_path: Path, beats_per_bar: list[int],
                       min_bpm: float, max_bpm: float) -> np.ndarray:
    """Return an (N, 2) array of (beat_time_s, bar_position)."""
    from madmom.features.downbeats import DBNDownBeatTrackingProcessor, RNNDownBeatProcessor

    act = RNNDownBeatProcessor()(str(audio_path))
    dbn = DBNDownBeatTrackingProcessor(
        beats_per_bar=beats_per_bar, fps=100, min_bpm=min_bpm, max_bpm=max_bpm,
    )
    out = dbn(act)
    return np.asarray(out, dtype=np.float64).reshape(-1, 2)


def run_madmom_grid(
    audio_path: Path | None,
    upstream: dict,
    params: dict[str, Any],
    on_progress: Callable[[str, int, str], None],
) -> dict[str, Any]:
    if audio_path is None:
        raise ValueError('madmom-downbeat requires a full-mix audio file')
    resolution = int(params.get('resolution') or 192)
    merge_tol_ms = float(params.get('merge_tol_ms') or 5)
    smooth_tol_ms = float(params['smooth_tol_ms']) if params.get('smooth_tol_ms') is not None else 30.0
    max_sections = int(params.get('max_sections') if params.get('max_sections') is not None else 8)
    bpb = _parse_bpb(params.get('beats_per_bar', '3,4'))
    min_bpm = float(params.get('min_bpm') or 55)
    max_bpm = float(params.get('max_bpm') or 215)

    on_progress('beats', 10, 'Tracking beats + downbeats (madmom RNN/DBN)…')
    beats = track_beats_madmom(audio_path, bpb, min_bpm, max_bpm)
    duration = audio_duration_s(audio_path)
    if len(beats) == 0:
        raise ValueError('madmom found no beats in the audio')
    db_idx = positions_to_downbeat_indices(beats[:, 1])
    on_progress('calibrate', 55, 'Calibrating grid to transients…')
    beat_times, calib = calibrate_beats(beats[:, 0], audio_path, params, on_progress)

    on_progress('structure', 60, 'Detecting sections/key…')
    section_times, key = optional_structure(audio_path, max_sections)

    on_progress('grid', 80, 'Building beat-anchored tempo map…')
    core = beats_to_grid(
        beat_times, resolution=resolution, audio_duration_s=duration,
        downbeat_indices=db_idx or None, beats_per_bar=bpb[-1],
        merge_tol_ms=merge_tol_ms, smooth_tol_ms=smooth_tol_ms, section_times=section_times or None,
    )
    payload = {
        'engine': 'madmom-downbeat',
        'params': params,
        'generated_at': dt.datetime.now(dt.UTC).isoformat().replace('+00:00', 'Z'),
        'detected_key': key,
        'beat_times_s': [float(t) for t in beat_times],
        'calibration': calib,
        **core,
    }
    n_seg = len(core['tempo_segments'])
    on_progress('done', 100, f'{len(beat_times)} beats, {len(core["downbeats"])} downbeats, {n_seg} tempo segments')
    return payload


register_engine(Stage.GRID, EngineSpec(
    id='madmom-downbeat',
    display_name='madmom RNN/DBN downbeats (beat-anchored, recommended)',
    params_schema=_PARAMS_SCHEMA,
    runner=run_madmom_grid,
))
