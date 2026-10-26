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
from ..tempo_math import build_tempo_segments, tick_to_seconds


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
    'floor_tom_split': {'type': 'boolean', 'default': True,
                        'label': 'Split toms by pitch: low → floor tom (GM 41, green pad)'},
    'floor_tom_max_hz': {'type': 'number', 'min': 70, 'max': 180, 'step': 5, 'default': 115,
                         'label': 'Tom fundamental below this (Hz) is a floor tom'},
}

GM_FLOOR_TOM = 41
GM_RACK_TOM = 45


def tom_fundamentals(y: np.ndarray, sr: int, times: list[float]) -> list[float | None]:
    """Fundamental (Hz) of each tom hit: peak of a zero-padded FFT of the
    80 ms after the attack, searched in 50–350 Hz with parabolic
    interpolation. None when the window is silent."""
    out: list[float | None] = []
    n = int(0.08 * sr)
    nfft = 1 << (n * 4 - 1).bit_length()
    freqs = np.fft.rfftfreq(nfft, 1.0 / sr)
    band = (freqs >= 50) & (freqs <= 350)
    win = np.hanning(n)
    for t in times:
        i = int(round((t + 0.005) * sr))
        seg = y[i:i + n]
        if len(seg) < n or np.abs(seg).max() < 1e-4:
            out.append(None)
            continue
        mag = np.abs(np.fft.rfft(seg * win, nfft))
        k = int(np.argmax(np.where(band, mag, 0)))
        if 0 < k < len(mag) - 1 and mag[k] > 0:
            a, b, c = np.log(mag[k - 1] + 1e-12), np.log(mag[k] + 1e-12), np.log(mag[k + 1] + 1e-12)
            d = 0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) != 0 else 0.0
            out.append(float(freqs[k] + d * (freqs[1] - freqs[0])))
        else:
            out.append(float(freqs[k]))
    return out


def split_floor_toms(f0s: list[float | None], max_hz: float) -> list[bool]:
    """True for floor toms. Absolute threshold, replaced by an Otsu split of
    log-f0 when the song's toms are clearly bimodal (≥ 5 semitones apart)."""
    vals = np.array([f for f in f0s if f])
    thr = float(max_hz)
    if len(vals) >= 12:
        lv = np.log2(vals)
        if lv.max() - lv.min() >= 5 / 12:
            from ..drum_detect import _otsu_threshold
            t = _otsu_threshold(lv)
            lo, hi = lv[lv < t], lv[lv >= t]
            if len(lo) >= 4 and len(hi) >= 4 and (np.median(hi) - np.median(lo)) >= 4 / 12:
                thr = float(2 ** t)
    return [bool(f is not None and f < thr) for f in f0s]


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

    # Floor vs rack tom: the detectors give one 'tom' class, but charts put
    # floor toms on the green pad and rack toms on blue/yellow.
    floor_times: set[float] = set()
    tom_hits = drum_classes.get('tom') or []
    if bool(params.get('floor_tom_split', True)) and tom_hits and audio_path is not None:
        on_progress('toms', 40, f'Pitching {len(tom_hits)} tom hits…')
        try:
            y, sr = load_audio(audio_path, target_sr=22050, mono=True)
            times = [float(h['time_s']) for h in tom_hits]
            f0s = tom_fundamentals(y, sr, times)
            for t, is_floor in zip(times, split_floor_toms(f0s, float(params.get('floor_tom_max_hz', 115)))):
                if is_floor:
                    floor_times.add(round(t, 4))
        except Exception as e:  # noqa: BLE001 — pitch split is best-effort
            on_progress('toms', 45, f'Tom pitch split skipped: {e}')

    def gm_for(cls: str, t: float) -> int:
        if cls == 'tom':
            near = [ft for ft in floor_times if abs(ft - t) <= win_s]
            return GM_FLOOR_TOM if near else GM_RACK_TOM
        return GM_FOR_CLASS[cls]

    on_progress('classify', 60, 'Attaching classes to onsets…')
    per_onset = []
    n_floor = 0
    for o in onsets_payload['onsets']:
        t = float(o['time_s'])
        classes = _classes_near(t, drum_classes, win_s)
        if not classes:
            per_onset.append({'time_s': t, 'dominant_midi': None, 'dominant_confidence': None,
                              'polyphony': 1, 'all_pitches_midi': []})
            continue
        lead = max(classes.items(), key=lambda kv: kv[1])
        midis = sorted(gm_for(c, t) for c in classes)
        n_floor += midis.count(GM_FLOOR_TOM)
        per_onset.append({
            'time_s': t,
            'dominant_midi': gm_for(lead[0], t),
            'dominant_confidence': float(min(1.0, lead[1])),
            'polyphony': len(classes),
            'all_pitches_midi': midis,
            'velocity': float(min(1.0, max(classes.values()))),
        })
    on_progress('done', 100, f'{len(per_onset)} onsets classified' + (f', {n_floor} floor toms' if n_floor else ''))
    return {'engine': 'drum-class', 'params': params, 'generated_at': _now(), 'per_onset': per_onset}


# ── S5: drum-gm ──────────────────────────────────────────────────────────

LANE_FOR_CLASS = {'kick': 0, 'snare': 1, 'hihat': 2, 'tom': 3, 'cymbal': 4}

_GM_LANE_PARAMS = {
    'floor_tom_lane5': {'type': 'boolean', 'default': True,
                        'label': 'Map floor toms (GM 41/43) to the Floor Tom lane (5 → green pad)'},
    'unknown_to_snare': {'type': 'boolean', 'default': False,
                         'label': 'Onsets with no class → snare (else dropped)'},
}


def gm_to_lane(midi: int, floor_tom_lane5: bool = True) -> int | None:
    cls = CLASS_FOR_GM.get(int(midi))
    if cls is None:
        return None
    if floor_tom_lane5 and midi in (41, 43):
        return 5
    return LANE_FOR_CLASS[cls]


def run_drum_gm_lanes(audio_path, upstream, params, on_progress):
    quant = upstream['quantized']
    floor5 = bool(params.get('floor_tom_lane5', True))
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
# removes the lane entirely.
#
# Derived from how Harmonix actually steps down (fraction of Expert notes
# surviving at the same tick+pad, two references — Elton John / Killers):
#   Hard:   every class keeps beats and most 8ths; 16ths gone (0 %)
#   Medium: beat-position notes of every class (snare/hat/crash ~100 %),
#           8ths mostly gone (kick 1–9 %, hat 0–36 %, snare 0–31 %)
#   Easy:   snare 90–100 %, hats 65–96 %, crashes 80–100 % on beats;
#           kicks almost gone (12–38 % even on beats, ~25 % on downbeats)
# The earlier defaults removed hats on Easy and kept 8th kicks on Medium —
# the opposite of this.

DEFAULT_DRUM_DIFFICULTY: dict[str, dict[str, int | None]] = {
    'hard':   {'0': 2, '1': 2, '2': 2, '3': 2, '4': 2, '5': 2},
    'medium': {'0': 3, '1': 3, '2': 3, '3': 3, '4': 3, '5': 3},
    'easy':   {'0': 4, '1': 3, '2': 3, '3': 3, '4': 3, '5': 3},
}

# Harmonix also keeps each difficulty near a notes-per-second budget
# (five references: Medium 2.4–3.2 /s, Easy 2.0–2.7 /s at 115–160 BPM) —
# on a slower song the 8th-note hats survive into Medium and even Easy
# because they are not fast. So after the metric rules, relax one step at a
# time (hats to 8ths, then kicks) until the difficulty reaches its floor.
DEFAULT_MIN_DENSITY = {'medium': 2.5, 'easy': 2.1}
_RELAX_LADDER = {
    'medium': ({'2': 2}, {'0': 2}),      # hats on 8ths, then kicks on 8ths
    'easy': ({'2': 2}, {'0': 3}),        # hats on 8ths, then kicks on beats
}

_REMOVAL_PARAMS = {
    'hard': {'type': 'enum', 'options': [], 'default': DEFAULT_DRUM_DIFFICULTY['hard'],
             'label': 'Hard: min metric weight per lane (null = remove lane)'},
    'medium': {'type': 'enum', 'options': [], 'default': DEFAULT_DRUM_DIFFICULTY['medium'],
               'label': 'Medium: min metric weight per lane'},
    'easy': {'type': 'enum', 'options': [], 'default': DEFAULT_DRUM_DIFFICULTY['easy'],
             'label': 'Easy: min metric weight per lane'},
    'easy_max_pads_per_tick': {'type': 'number', 'min': 1, 'max': 3, 'step': 1, 'default': 2,
                               'label': 'Easy: max pads per tick (kick excluded)'},
    'medium_min_density': {'type': 'number', 'min': 0, 'max': 6, 'step': 0.1, 'default': DEFAULT_MIN_DENSITY['medium'],
                           'label': 'Medium: relax rules until at least this many notes/sec (0 = off)'},
    'easy_min_density': {'type': 'number', 'min': 0, 'max': 6, 'step': 0.1, 'default': DEFAULT_MIN_DENSITY['easy'],
                         'label': 'Easy: relax rules until at least this many notes/sec (0 = off)'},
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


def _span_seconds(lanes: list[dict], grid: dict | None) -> float:
    if not lanes:
        return 1.0
    resolution = int((grid or {}).get('resolution', 192))
    tempo = (grid or {}).get('tempo_segments') or [{'tick_start': 0, 'micro_bpm': 120000}]
    segs = build_tempo_segments([{'tick': t['tick_start'], 'micro_bpm': t['micro_bpm']} for t in tempo], resolution)
    t0 = tick_to_seconds(int(lanes[0]['tick']), segs, resolution)
    t1 = tick_to_seconds(int(lanes[-1]['tick']), segs, resolution)
    return max(1.0, t1 - t0)


def run_drum_class_removal(audio_path, upstream, params, on_progress):
    inp = upstream.get('lanes_filtered')
    if inp is None:
        raise ValueError('S7 requires upstream lanes_filtered')
    metric_weights = inp.get('metric_weights') or {}
    caps = {'hard': None,
            'medium': int(params.get('medium_max_pads_per_tick', 2)),
            'easy': int(params.get('easy_max_pads_per_tick', 2))}
    span = _span_seconds(inp['lanes'], upstream.get('grid'))
    by_difficulty = {}
    for diff in ('easy', 'medium', 'hard'):
        rule = dict(params.get(diff) or DEFAULT_DRUM_DIFFICULTY[diff])
        lanes = _reduce(inp['lanes'], metric_weights, rule, caps[diff])
        floor = float(params.get(f'{diff}_min_density', DEFAULT_MIN_DENSITY.get(diff, 0)) or 0)
        relaxed: list[dict] = []
        for step in _RELAX_LADDER.get(diff, ()):
            if floor <= 0 or len(lanes) / span >= floor:
                break
            rule.update(step)
            relaxed.append(step)
            lanes = _reduce(inp['lanes'], metric_weights, rule, caps[diff])
        by_difficulty[diff] = {
            'engine': 'drum-class-removal',
            'params': {**rule, 'min_density': floor, 'relaxed': relaxed, 'density': round(len(lanes) / span, 3)},
            'generated_at': _now(),
            'lanes': lanes,
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
