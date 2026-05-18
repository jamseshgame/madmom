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
