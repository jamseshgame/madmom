"""Drum-specific engines for the V2 pipeline.

Drums are categorical, not pitched, so the generic onsets → pitches → lanes
path (one onset list, one scalar per onset, percentile bins) can't express
them: a kick+hat on one beat became one onset with a blended centroid, and
"lane 0" meant "the quietest 20 % of this section", not "kick". These
engines use the same stage slots but carry drum *classes* through them:

  onsets     `drum-bandsplit`  merged monotonic onset list (schema-compatible)
                               + a sibling `drum_classes` key with per-class hits
  pitches    `drum-class`      per onset: all_pitches_midi = GM drum numbers of
                               the classes hitting there (36 kick, 38 snare,
                               42 hat, 45 tom, 49 cymbal); polyphony = count
  lanes      `drum-gm`         GM number → fixed editor lane, one single-lane
                               event per class per tick (serializer unions them
                               and adds the 66/68 cymbal modifiers)
  difficulty `drum-class-removal`  Hard/Medium/Easy by removing classes and
                               subdivisions the way human drum charts do

Every engine here is numpy/scipy only (no librosa / torch).
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any, Callable

import numpy as np

from ..audio_io import load_audio
from ..drum_detect import CLASS_FOR_GM, DEFAULT_PARAMS, DRUM_CLASSES, GM_FOR_CLASS, detect_drum_hits, merge_hits
from ..registry import EngineSpec, Stage, register_engine


def _now() -> str:
    return dt.datetime.now(dt.UTC).isoformat().replace('+00:00', 'Z')


# ── S2: drum-bandsplit ───────────────────────────────────────────────────

_BANDSPLIT_PARAMS = {
    'delta': {'type': 'number', 'min': 0.02, 'max': 0.6, 'step': 0.01, 'default': DEFAULT_PARAMS['delta'],
              'label': 'Onset threshold (fraction of loud-hit flux)'},
    'min_ioi_ms': {'type': 'number', 'min': 20, 'max': 150, 'step': 5, 'default': DEFAULT_PARAMS['min_ioi_ms'],
                   'label': 'Min gap between hits of one class (ms)'},
    'energy_gate_db': {'type': 'number', 'min': -40, 'max': -6, 'step': 1, 'default': DEFAULT_PARAMS['energy_gate_db'],
                       'label': 'Drop hits quieter than (dB vs loud hits)'},
    'snare_noise_ratio': {'type': 'number', 'min': 0.05, 'max': 1.0, 'step': 0.05,
                          'default': DEFAULT_PARAMS['snare_noise_ratio'],
                          'label': 'Snare vs tom: min snap/body energy ratio'},
    'cymbal_decay_ratio': {'type': 'number', 'min': 0.1, 'max': 0.9, 'step': 0.05,
                           'default': DEFAULT_PARAMS['cymbal_decay_ratio'],
                           'label': 'Cymbal vs hat: min 150 ms/15 ms energy ratio'},
    'merge_ms': {'type': 'number', 'min': 5, 'max': 40, 'step': 1, 'default': 15,
                 'label': 'Merge hits closer than (ms) into one onset'},
}


def _detect(audio_path: Path, params: dict[str, Any]) -> dict[str, list]:
    y, sr = load_audio(audio_path, target_sr=22050, mono=True)
    det_params = {k: params[k] for k in DEFAULT_PARAMS if k in params}
    return detect_drum_hits(y, sr, det_params)


def run_drum_bandsplit(audio_path: Path | None, upstream: dict, params: dict[str, Any],
                       on_progress: Callable[[str, int, str], None]) -> dict[str, Any]:
    if audio_path is None:
        raise ValueError('drum-bandsplit requires a drum stem audio file')
    on_progress('detect', 20, 'Detecting kick/snare/hat/tom/cymbal hits…')
    hits = _detect(audio_path, params)
    merged = merge_hits(hits, merge_ms=float(params.get('merge_ms', 15)))
    onsets = [{'time_s': m['time_s'], 'confidence': min(1.0, m['confidence']), 'source_note_id': None}
              for m in merged]
    counts = {c: len(h) for c, h in hits.items()}
    on_progress('done', 100, ', '.join(f'{c}={n}' for c, n in counts.items()))
    return {
        'engine': 'drum-bandsplit', 'params': params, 'generated_at': _now(),
        'onsets': onsets,
        # Extra key (StageOutputBase allows it): per-class hits for S3.
        'drum_classes': {c: [h.as_dict() for h in hs] for c, hs in hits.items()},
        # Per merged onset, the classes that hit there (same order as `onsets`).
        'onset_classes': [m['classes'] for m in merged],
    }


# ── S3: drum-class ───────────────────────────────────────────────────────

_CLASS_PARAMS = {
    'match_window_ms': {'type': 'number', 'min': 5, 'max': 60, 'step': 1, 'default': 25,
                        'label': 'Window to attach class hits to an onset (ms)'},
}


def _classes_near(t: float, drum_classes: dict[str, list[dict]], win_s: float) -> dict[str, float]:
    out: dict[str, float] = {}
    for cls, hs in drum_classes.items():
        best = 0.0
        for h in hs:
            if abs(float(h['time_s']) - t) <= win_s:
                best = max(best, float(h.get('velocity', 1.0)))
        if best > 0:
            out[cls] = best
    return out


def run_drum_class(audio_path: Path | None, upstream: dict, params: dict[str, Any],
                   on_progress: Callable[[str, int, str], None]) -> dict[str, Any]:
    onsets_payload = upstream.get('onsets')
    if onsets_payload is None:
        raise ValueError('S3 requires upstream onsets')
    win_s = float(params.get('match_window_ms', 25)) / 1000.0

    drum_classes = onsets_payload.get('drum_classes')
    if drum_classes is None:
        # Upstream wasn't drum-bandsplit (e.g. librosa-onset): classify the
        # given onsets ourselves.
        if audio_path is None:
            raise ValueError('drum-class needs the drum stem audio when upstream onsets carry no drum_classes')
        on_progress('detect', 20, 'Upstream onsets carry no drum classes — detecting…')
        drum_classes = {c: [h.as_dict() for h in hs] for c, hs in _detect(audio_path, params).items()}

    on_progress('classify', 60, 'Attaching classes to onsets…')
    per_onset = []
    for o in onsets_payload['onsets']:
        t = float(o['time_s'])
        classes = _classes_near(t, drum_classes, win_s)
        if not classes:
            per_onset.append({'time_s': t, 'dominant_midi': None, 'dominant_confidence': None,
                              'polyphony': 1, 'all_pitches_midi': []})
            continue
        lead = max(classes.items(), key=lambda kv: kv[1])
        per_onset.append({
            'time_s': t,
            'dominant_midi': GM_FOR_CLASS[lead[0]],
            'dominant_confidence': float(min(1.0, lead[1])),
            'polyphony': len(classes),
            'all_pitches_midi': sorted(GM_FOR_CLASS[c] for c in classes),
            'velocity': float(min(1.0, max(classes.values()))),
        })
    on_progress('done', 100, f'{len(per_onset)} onsets classified')
    return {'engine': 'drum-class', 'params': params, 'generated_at': _now(), 'per_onset': per_onset}


# ── S5: drum-gm ──────────────────────────────────────────────────────────

LANE_FOR_CLASS = {'kick': 0, 'snare': 1, 'hihat': 2, 'tom': 3, 'cymbal': 4}

_GM_LANE_PARAMS = {
    'floor_tom_lane5': {'type': 'boolean', 'default': False,
                        'label': 'Map low toms (GM 41/43) to the Floor Tom lane (5)'},
    'unknown_to_snare': {'type': 'boolean', 'default': False,
                         'label': 'Onsets with no class → snare (else dropped)'},
}


def gm_to_lane(midi: int, floor_tom_lane5: bool = False) -> int | None:
    cls = CLASS_FOR_GM.get(int(midi))
    if cls is None:
        return None
    if floor_tom_lane5 and midi in (41, 43):
        return 5
    return LANE_FOR_CLASS[cls]


def run_drum_gm_lanes(audio_path, upstream, params, on_progress):
    quant = upstream['quantized']
    floor5 = bool(params.get('floor_tom_lane5', False))
    unknown_to_snare = bool(params.get('unknown_to_snare', False))
    lanes_out: list[dict] = []
    seen: set[tuple[int, int]] = set()
    for ev in quant['events']:
        if ev.get('dropped'):
            continue
        midis = list(ev.get('all_pitches_midi') or [])
        if not midis and ev.get('dominant_midi') is not None:
            midis = [ev['dominant_midi']]
        lanes: list[int] = []
        for m in midis:
            lane = gm_to_lane(int(m), floor5)
            if lane is not None:
                lanes.append(lane)
        if not lanes and unknown_to_snare:
            lanes = [1]
        for lane in sorted(set(lanes)):
            key = (int(ev['tick']), lane)
            if key in seen:
                continue
            seen.add(key)
            lanes_out.append({'tick': int(ev['tick']), 'frets': [lane], 'sustain': 0, 'section': 'song',
                              'velocity': ev.get('velocity')})
    lanes_out.sort(key=lambda x: (x['tick'], x['frets'][0]))
    metric_weights = {str(e['tick']): int(e.get('metric_weight', 0)) for e in quant['events'] if not e.get('dropped')}
    on_progress('done', 100, f'{len(lanes_out)} drum lane events')
    return {'engine': 'drum-gm', 'params': params, 'generated_at': _now(),
            'lanes': lanes_out, 'metric_weights': metric_weights}


# ── S7: drum-class-removal ───────────────────────────────────────────────
# Per difficulty: the minimum metric weight (4 downbeat, 3 beat, 2 eighth,
# 1 sixteenth, 0 off-grid) a hit of each lane must have to survive; None
# removes the lane entirely. Mirrors how human CH drum charts step down:
# Easy = kick/snare backbeat on beats, Medium = add 8th hats + crashes on
# downbeats, Hard = everything but 16th-note hats and off-grid ghost notes.

DEFAULT_DRUM_DIFFICULTY: dict[str, dict[str, int | None]] = {
    'hard':   {'0': 1, '1': 1, '2': 2, '3': 1, '4': 1, '5': 1},
    'medium': {'0': 2, '1': 2, '2': 3, '3': 2, '4': 4, '5': 2},
    'easy':   {'0': 3, '1': 3, '2': None, '3': None, '4': 4, '5': None},
}

_REMOVAL_PARAMS = {
    'hard': {'type': 'enum', 'options': [], 'default': DEFAULT_DRUM_DIFFICULTY['hard'],
             'label': 'Hard: min metric weight per lane (null = remove lane)'},
    'medium': {'type': 'enum', 'options': [], 'default': DEFAULT_DRUM_DIFFICULTY['medium'],
               'label': 'Medium: min metric weight per lane'},
    'easy': {'type': 'enum', 'options': [], 'default': DEFAULT_DRUM_DIFFICULTY['easy'],
             'label': 'Easy: min metric weight per lane'},
    'easy_max_pads_per_tick': {'type': 'number', 'min': 1, 'max': 3, 'step': 1, 'default': 1,
                               'label': 'Easy: max pads per tick (kick excluded)'},
    'medium_max_pads_per_tick': {'type': 'number', 'min': 1, 'max': 3, 'step': 1, 'default': 2,
                                 'label': 'Medium: max pads per tick (kick excluded)'},
}


def _reduce(lanes: list[dict], metric_weights: dict[str, int], rule: dict[str, int | None],
            max_pads: int | None) -> list[dict]:
    out: list[dict] = []
    by_tick: dict[int, list[dict]] = {}
    for ev in lanes:
        lane = int(ev['frets'][0]) if len(ev['frets']) == 1 else None
        if lane is None:
            continue
        min_w = rule.get(str(lane), 0)
        if min_w is None:
            continue
        w = metric_weights.get(str(ev['tick']))
        if w is None:
            w = 2
        if int(w) < int(min_w):
            continue
        by_tick.setdefault(int(ev['tick']), []).append(ev)
    pad_priority = {1: 0, 4: 1, 3: 2, 5: 3, 2: 4}  # snare > cymbal > tom > floor > hat
    for tick in sorted(by_tick):
        evs = by_tick[tick]
        if max_pads is not None:
            kick = [e for e in evs if e['frets'] == [0]]
            pads = sorted((e for e in evs if e['frets'] != [0]), key=lambda e: pad_priority.get(e['frets'][0], 9))
            evs = kick + pads[:max_pads]
        out.extend(sorted(evs, key=lambda e: e['frets'][0]))
    return out


def run_drum_class_removal(audio_path, upstream, params, on_progress):
    inp = upstream.get('lanes_filtered')
    if inp is None:
        raise ValueError('S7 requires upstream lanes_filtered')
    metric_weights = inp.get('metric_weights') or {}
    caps = {'hard': None,
            'medium': int(params.get('medium_max_pads_per_tick', 2)),
            'easy': int(params.get('easy_max_pads_per_tick', 1))}
    by_difficulty = {}
    for diff in ('easy', 'medium', 'hard'):
        rule = params.get(diff) or DEFAULT_DRUM_DIFFICULTY[diff]
        by_difficulty[diff] = {
            'engine': 'drum-class-removal', 'params': rule, 'generated_at': _now(),
            'lanes': _reduce(inp['lanes'], metric_weights, rule, caps[diff]),
        }
    on_progress('done', 100, ' / '.join(f'{d}={len(v["lanes"])}' for d, v in by_difficulty.items()))
    return {'engine': 'drum-class-removal', 'params': params, 'generated_at': _now(),
            'by_difficulty': by_difficulty}


# ── registration ─────────────────────────────────────────────────────────

register_engine(Stage.ONSETS, EngineSpec(
    id='drum-bandsplit', display_name='Drum hits: band-split kick/snare/hat/tom/cymbal',
    params_schema=_BANDSPLIT_PARAMS, runner=run_drum_bandsplit,
))
register_engine(Stage.PITCHES, EngineSpec(
    id='drum-class', display_name='Drum classes as GM MIDI (drums)',
    params_schema=_CLASS_PARAMS, runner=run_drum_class,
))
register_engine(Stage.LANES_EXPERT, EngineSpec(
    id='drum-gm', display_name='Drum lanes: fixed GM → pad mapping (drums)',
    params_schema=_GM_LANE_PARAMS, runner=run_drum_gm_lanes,
))
for _stage in (Stage.LANES_HARD, Stage.LANES_MEDIUM, Stage.LANES_EASY):
    register_engine(_stage, EngineSpec(
        id='drum-class-removal', display_name='Drum class removal (drums)',
        params_schema=_REMOVAL_PARAMS, runner=run_drum_class_removal,
    ))

__all__ = ['DRUM_CLASSES', 'LANE_FOR_CLASS', 'gm_to_lane', 'run_drum_bandsplit', 'run_drum_class',
           'run_drum_gm_lanes', 'run_drum_class_removal']
