"""S1 engine: `all-in-one` (mir-aidj/all-in-one).

Joint beat + downbeat + tempo + structural segmentation in one model.
Recommended default. First-call downloads the checkpoint (~150 MB).
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any, Callable

from ..audio_io import load_audio
from ..grid_derivation import derive_tempo_segments, derive_time_signatures
from ..registry import EngineSpec, Stage, register_engine


_PARAMS_SCHEMA = {
    'min_segment_beats': {'type': 'number', 'min': 4, 'max': 64, 'step': 1, 'default': 16,
                          'label': 'Minimum beats per tempo segment'},
    'resolution': {'type': 'enum', 'options': [192, 480], 'default': 192,
                   'label': 'Tick resolution'},
}


def run_allinone_grid(
    audio_path: Path,
    upstream: dict,
    params: dict[str, Any],
    on_progress: Callable[[str, int, str], None],
) -> dict[str, Any]:
    if audio_path is None:
        raise ValueError('all-in-one requires a full-mix audio file')
    import allin1

    resolution = int(params.get('resolution') or 192)
    min_segment_beats = int(params.get('min_segment_beats') or 16)

    on_progress('load', 5, 'Loading audio…')
    y, sr = load_audio(audio_path, target_sr=44100, mono=False)
    duration = (y.shape[-1] if y.ndim > 1 else len(y)) / sr

    on_progress('analyze', 20, 'Running all-in-one (may download model on first call)…')
    result = allin1.analyze(str(audio_path))

    beats = list(result.beats)
    downbeats = list(result.downbeats)
    raw_segments = list(getattr(result, 'segments', []) or [])

    on_progress('derive', 70, 'Deriving tempo & TS segments…')
    if not beats:
        beats = [0.0]
    bpm_hint = (60.0 / ((beats[-1] - beats[0]) / max(1, len(beats) - 1))) if len(beats) > 1 else 120.0
    tempo_segments = derive_tempo_segments(beats=beats, downbeats=downbeats,
                                            resolution=resolution,
                                            min_segment_beats=min_segment_beats)
    time_sig_segments = derive_time_signatures(beats=beats, downbeats=downbeats,
                                                resolution=resolution, bpm_hint=bpm_hint)

    downbeat_ticks = [
        int(round(t * bpm_hint / 60.0 * resolution)) for t in downbeats
    ]

    sections: list[dict] = []
    for s in raw_segments:
        sections.append({
            'tick_start': int(round(float(s.start) * bpm_hint / 60.0 * resolution)),
            'label': str(getattr(s, 'label', 'section')),
        })
    if not sections:
        sections = [{'tick_start': 0, 'label': 'song'}]

    payload = {
        'engine': 'all-in-one',
        'params': params,
        'audio_duration_s': duration,
        'resolution': resolution,
        'tempo_segments': tempo_segments,
        'time_sig_segments': time_sig_segments,
        'downbeats': downbeat_ticks,
        'sections': sections,
        'detected_key': None,
        'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
    }
    on_progress('done', 100,
                f'tempo_segments={len(tempo_segments)} sections={len(sections)}')
    return payload


register_engine(Stage.GRID, EngineSpec(
    id='all-in-one',
    display_name='All-In-One (joint beat/downbeat/segment)',
    params_schema=_PARAMS_SCHEMA,
    runner=run_allinone_grid,
))


# ── Beat-anchored variant ────────────────────────────────────────────────
# Same all-in-one inference; the beat/downbeat *times* drive a piecewise
# tempo map via beat_grid instead of the constant-BPM tick mapping above.

def run_allinone_anchored_grid(
    audio_path: Path,
    upstream: dict,
    params: dict[str, Any],
    on_progress: Callable[[str, int, str], None],
) -> dict[str, Any]:
    if audio_path is None:
        raise ValueError('all-in-one requires a full-mix audio file')
    import numpy as np
    import allin1

    from ..beat_grid import beats_to_grid

    resolution = int(params.get('resolution') or 192)
    merge_tol_ms = float(params.get('merge_tol_ms') or 5)
    smooth_tol_ms = float(params['smooth_tol_ms']) if params.get('smooth_tol_ms') is not None else 30.0

    on_progress('load', 5, 'Loading audio…')
    y, sr = load_audio(audio_path, target_sr=44100, mono=False)
    duration = (y.shape[-1] if y.ndim > 1 else len(y)) / sr

    on_progress('analyze', 20, 'Running all-in-one (may download model on first call)…')
    result = allin1.analyze(str(audio_path))
    beats = np.asarray(list(result.beats), dtype=np.float64)
    downbeats = np.asarray(list(result.downbeats), dtype=np.float64)
    raw_segments = list(getattr(result, 'segments', []) or [])
    if len(beats) == 0:
        raise ValueError('all-in-one found no beats in the audio')

    # Downbeat indices = nearest beat to each downbeat time.
    db_idx = sorted({int(np.argmin(np.abs(beats - d))) for d in downbeats}) if len(downbeats) else None

    on_progress('derive', 70, 'Building beat-anchored tempo map…')
    core = beats_to_grid(
        beats, resolution=resolution, audio_duration_s=duration,
        downbeat_indices=db_idx, merge_tol_ms=merge_tol_ms, smooth_tol_ms=smooth_tol_ms,
        section_times=[float(s.start) for s in raw_segments] or None,
        section_labels=[str(getattr(s, 'label', 'section')) for s in raw_segments] or None,
    )
    payload = {
        'engine': 'all-in-one-anchored',
        'params': params,
        'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
        'detected_key': None,
        'beat_times_s': [float(t) for t in beats],
        **core,
    }
    on_progress('done', 100, f'{len(beats)} beats, {len(core["tempo_segments"])} tempo segments')
    return payload


register_engine(Stage.GRID, EngineSpec(
    id='all-in-one-anchored',
    display_name='All-In-One, beat-anchored tempo map',
    params_schema={
        'resolution': _PARAMS_SCHEMA['resolution'],
        'merge_tol_ms': {'type': 'number', 'min': 1, 'max': 30, 'step': 1, 'default': 5,
                         'label': 'Tempo-map merge tolerance (ms)'},
        'smooth_tol_ms': {'type': 'number', 'min': 0, 'max': 60, 'step': 1, 'default': 30,
                          'label': 'Smooth beat-tracker jitter (ms, 0 = raw beats, one B marker per beat)'},
    },
    runner=run_allinone_anchored_grid,
))
