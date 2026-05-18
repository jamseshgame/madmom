"""S1 engine: `manual` — user supplies BPM + offset + duration.

Produces a SongGrid with one tempo segment, one time-sig segment, evenly
spaced downbeats, and no sections (caller can add later).
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any, Callable

from ..registry import EngineSpec, Stage, register_engine


_PARAMS_SCHEMA = {
    'bpm': {'type': 'number', 'min': 30.0, 'max': 250.0, 'default': 120.0,
            'label': 'BPM'},
    'time_sig_num': {'type': 'enum', 'options': [3, 4, 6], 'default': 4,
                     'label': 'Time signature numerator'},
    'offset_s': {'type': 'number', 'min': 0.0, 'max': 10.0, 'step': 0.01, 'default': 0.0,
                 'label': 'Start offset (seconds)'},
    'audio_duration_s': {'type': 'number', 'min': 1.0, 'max': 3600.0, 'default': 180.0,
                         'label': 'Audio duration (seconds)'},
    'resolution': {'type': 'enum', 'options': [192, 480], 'default': 192,
                   'label': 'Tick resolution'},
}


def run_manual_grid(
    audio_path: Path | None,
    upstream: dict,
    params: dict[str, Any],
    on_progress: Callable[[str, int, str], None],
) -> dict[str, Any]:
    bpm = float(params.get('bpm') or 0)
    if bpm <= 0:
        raise ValueError('bpm parameter is required')
    duration = float(params.get('audio_duration_s') or 0)
    if duration <= 0:
        raise ValueError('audio_duration_s parameter is required')
    ts_num = int(params.get('time_sig_num') or 4)
    offset_s = float(params.get('offset_s') or 0.0)
    resolution = int(params.get('resolution') or 192)

    on_progress('manual', 50, f'Building {bpm:.1f} BPM grid…')

    seconds_per_beat = 60.0 / bpm
    total_beats = int((duration - offset_s) / seconds_per_beat)

    first_db_tick = int(round(offset_s * bpm / 60.0 * resolution))
    bar_ticks = ts_num * resolution
    # Calculate max tick based on audio duration
    max_tick = int(duration * bpm / 60.0 * resolution)
    downbeats = [first_db_tick + i * bar_ticks for i in range(total_beats // ts_num + 1)
                 if first_db_tick + i * bar_ticks < max_tick]
    if not downbeats:
        downbeats = [first_db_tick]

    payload = {
        'engine': 'manual',
        'params': params,
        'audio_duration_s': duration,
        'resolution': resolution,
        'tempo_segments': [{'tick_start': 0, 'micro_bpm': int(round(bpm * 1000)), 'label': 'main'}],
        'time_sig_segments': [{'tick_start': 0, 'num': ts_num, 'denom_pow': 2}],
        'downbeats': downbeats,
        'sections': [{'tick_start': 0, 'label': 'song'}],
        'detected_key': None,
        'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
    }
    on_progress('manual', 100, 'done')
    return payload


register_engine(Stage.GRID, EngineSpec(
    id='manual',
    display_name='Manual (BPM + offset)',
    params_schema=_PARAMS_SCHEMA,
    runner=run_manual_grid,
))
