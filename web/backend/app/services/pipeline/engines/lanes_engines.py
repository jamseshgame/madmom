"""S5 engines: pitch → fret lane assignment."""
from __future__ import annotations

import datetime
from typing import Any

import numpy as np

from ..registry import EngineSpec, Stage, register_engine


_PARAMS = {
    'open_high_percentile': {'type': 'number', 'min': 80, 'max': 100, 'step': 1, 'default': 100,
                             'label': 'Open-lane high percentile'},
    'open_low_percentile': {'type': 'number', 'min': 0, 'max': 20, 'step': 1, 'default': 0,
                            'label': 'Open-lane low percentile'},
    'chord_polyphony_threshold': {'type': 'number', 'min': 2, 'max': 6, 'step': 1, 'default': 3,
                                  'label': 'Polyphony required for chord'},
}


def _events_by_section(grid_payload: dict, quant_events: list[dict]) -> dict[str, list[dict]]:
    sections = grid_payload.get('sections') or [{'tick_start': 0, 'label': 'song'}]
    boundaries = [s['tick_start'] for s in sections] + [10**12]
    by_section: dict[str, list[dict]] = {s['label']: [] for s in sections}
    for ev in quant_events:
        if ev.get('dropped'):
            continue
        tick = ev['tick']
        for i, s in enumerate(sections):
            if boundaries[i] <= tick < boundaries[i + 1]:
                by_section[s['label']].append(ev)
                break
    return by_section


def _chord_pair_for_anchor(f: int) -> tuple[int, int]:
    if f < 4:
        return (f, f + 1)
    return (3, 4)


def _bin_to_fret(midi: int, edges: list[float]) -> int:
    for i, e in enumerate(edges):
        if midi < e:
            return i
    return 4


def _emit(events: list[dict], grid_payload: dict, section_label: str,
          edges: list[float], hi_thresh: float, lo_thresh: float,
          chord_thresh: int) -> list[dict]:
    out = []
    for ev in events:
        midi = ev.get('dominant_midi')
        poly = int(ev.get('polyphony', 1))
        if midi is None:
            anchor = 2
        elif midi > hi_thresh or midi < lo_thresh:
            out.append({'tick': ev['tick'], 'frets': [7], 'sustain': 0,
                        'section': section_label})
            continue
        else:
            anchor = _bin_to_fret(midi, edges)
        if poly >= chord_thresh:
            pair = _chord_pair_for_anchor(anchor)
            out.append({'tick': ev['tick'], 'frets': list(pair), 'sustain': 0,
                        'section': section_label})
        else:
            out.append({'tick': ev['tick'], 'frets': [anchor], 'sustain': 0,
                        'section': section_label})
    return out


def run_section_sliding(audio_path, upstream, params, on_progress):
    grid = upstream['grid']
    quant = upstream['quantized']
    chord_thresh = int(params.get('chord_polyphony_threshold', 3))
    hi_pct = float(params.get('open_high_percentile', 100))
    lo_pct = float(params.get('open_low_percentile', 0))

    by_section = _events_by_section(grid, quant['events'])
    lanes_out: list[dict] = []
    for section_label, events in by_section.items():
        if not events:
            continue
        midis = [e['dominant_midi'] for e in events if e.get('dominant_midi') is not None]
        if midis:
            arr = np.array(midis)
            edges = list(np.percentile(arr, [20, 40, 60, 80]))
            hi = float(np.percentile(arr, hi_pct))
            lo = float(np.percentile(arr, lo_pct))
        else:
            edges, hi, lo = [50, 55, 60, 65], 1e9, -1
        lanes_out.extend(_emit(events, grid, section_label, edges, hi, lo, chord_thresh))
    lanes_out.sort(key=lambda x: x['tick'])
    on_progress('done', 100, f'{len(lanes_out)} lane events')
    metric_weights = {
        str(e['tick']): int(e.get('metric_weight', 0))
        for e in quant['events']
        if not e.get('dropped')
    }
    return {'engine': 'section-sliding', 'params': params,
            'generated_at': datetime.datetime.now(datetime.UTC).isoformat().replace('+00:00', 'Z'),
            'lanes': lanes_out,
            'metric_weights': metric_weights}


def run_global_percentile(audio_path, upstream, params, on_progress):
    grid = upstream['grid']
    quant = upstream['quantized']
    chord_thresh = int(params.get('chord_polyphony_threshold', 3))
    hi_pct = float(params.get('open_high_percentile', 100))
    lo_pct = float(params.get('open_low_percentile', 0))

    events = [e for e in quant['events'] if not e.get('dropped')]
    midis = [e['dominant_midi'] for e in events if e.get('dominant_midi') is not None]
    if midis:
        arr = np.array(midis)
        edges = list(np.percentile(arr, [20, 40, 60, 80]))
        hi = float(np.percentile(arr, hi_pct))
        lo = float(np.percentile(arr, lo_pct))
    else:
        edges, hi, lo = [50, 55, 60, 65], 1e9, -1

    lanes_out = _emit(events, grid, 'song', edges, hi, lo, chord_thresh)
    lanes_out.sort(key=lambda x: x['tick'])
    on_progress('done', 100, f'{len(lanes_out)} lane events')
    metric_weights = {
        str(e['tick']): int(e.get('metric_weight', 0))
        for e in quant['events']
        if not e.get('dropped')
    }
    return {'engine': 'global-percentile', 'params': params,
            'generated_at': datetime.datetime.now(datetime.UTC).isoformat().replace('+00:00', 'Z'),
            'lanes': lanes_out,
            'metric_weights': metric_weights}


_KEY_TO_PC = {'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'E': 4, 'F': 5, 'F#': 6,
              'G': 7, 'G#': 8, 'A': 9, 'A#': 10, 'B': 11}


def run_key_relative(audio_path, upstream, params, on_progress):
    grid = upstream['grid']
    quant = upstream['quantized']
    chord_thresh = int(params.get('chord_polyphony_threshold', 3))
    key = grid.get('detected_key')
    if not key:
        return run_global_percentile(audio_path, upstream, params, on_progress)
    tonic_pc = _KEY_TO_PC.get(key['tonic'].upper(), 0)
    is_minor = (key['mode'].lower() == 'minor')
    interval_to_lane = (
        {0: 2, 2: 1, 3: 0, 5: 3, 7: 4} if is_minor
        else {0: 2, 2: 1, 4: 0, 5: 3, 7: 4}
    )
    events = [e for e in quant['events'] if not e.get('dropped')]
    lanes_out = []
    for ev in events:
        midi = ev.get('dominant_midi')
        poly = int(ev.get('polyphony', 1))
        if midi is None:
            anchor = 2
        else:
            interval = (midi - tonic_pc) % 12
            anchor = interval_to_lane.get(interval)
            if anchor is None:
                nearest_iv = min(interval_to_lane.keys(), key=lambda k: abs(k - interval))
                anchor = interval_to_lane[nearest_iv]
        if poly >= chord_thresh:
            pair = _chord_pair_for_anchor(anchor)
            lanes_out.append({'tick': ev['tick'], 'frets': list(pair), 'sustain': 0,
                              'section': 'song'})
        else:
            lanes_out.append({'tick': ev['tick'], 'frets': [anchor], 'sustain': 0,
                              'section': 'song'})
    lanes_out.sort(key=lambda x: x['tick'])
    on_progress('done', 100, f'{len(lanes_out)} lane events')
    metric_weights = {
        str(e['tick']): int(e.get('metric_weight', 0))
        for e in quant['events']
        if not e.get('dropped')
    }
    return {'engine': 'key-relative', 'params': params,
            'generated_at': datetime.datetime.now(datetime.UTC).isoformat().replace('+00:00', 'Z'),
            'lanes': lanes_out,
            'metric_weights': metric_weights}


for _id, _name, _runner in (
    ('section-sliding', 'Per-section sliding window (recommended)', run_section_sliding),
    ('global-percentile', 'Global percentile', run_global_percentile),
    ('key-relative', 'Key-relative (tonic = yellow)', run_key_relative),
):
    register_engine(Stage.LANES_EXPERT, EngineSpec(
        id=_id, display_name=_name, params_schema=_PARAMS, runner=_runner,
    ))
