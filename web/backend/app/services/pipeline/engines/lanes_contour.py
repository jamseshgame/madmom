"""S5 engine: `contour-dp` — lane assignment as an optimisation.

The percentile engines map a note to a lane by where its pitch sits in the
*distribution* of the section, so the same riff lands on different lanes
in the verse and the chorus and a note's lane says nothing about the note
before it. Players read a chart as a contour: up means up, the same note
stays put, hands don't leap on fast passages. That is a cost function, not
a binning, so this engine runs a Viterbi pass over the note sequence with
five fret states (plus an optional open-note state) and a cost made of:

  contour    the lane step should match the pitch step (direction never
             contradicted; a repeated pitch keeps its lane)
  register   a slow-moving pitch window keeps absolute-ish consistency so
             the same pitch tends to land on the same lane across the song
  movement   big lane jumps on fast notes are penalised
  open       pitches far below the window may become open notes

Chords come from real polyphony (adjacent-pair shapes anchored on the lowest
note); sustains from note durations. Both only happen when the pitch stage
supplies the fields (basic-pitch does; pyin gives neither, which is fine).

The `phrase-consistency` filter (lanes_filtered) adds repetition copying on
top; the two are separate so v13 vs v14 isolates its effect.
"""
from __future__ import annotations

import datetime as dt
from typing import Any

import numpy as np

from ..registry import EngineSpec, Stage, register_engine
from ..tempo_math import build_tempo_segments, seconds_to_tick, tick_to_seconds


_PARAMS = {
    'semitones_per_lane': {'type': 'number', 'min': 1, 'max': 5, 'step': 0.5, 'default': 2.0,
                           'label': 'Semitones per lane step'},
    'w_contour': {'type': 'number', 'min': 0, 'max': 10, 'step': 0.5, 'default': 3.0,
                  'label': 'Weight: lane step matches pitch step'},
    'w_direction': {'type': 'number', 'min': 0, 'max': 20, 'step': 1, 'default': 8.0,
                    'label': 'Penalty: lane moves against pitch direction'},
    'w_same_pitch': {'type': 'number', 'min': 0, 'max': 20, 'step': 1, 'default': 6.0,
                     'label': 'Penalty: repeated pitch changes lane'},
    'w_register': {'type': 'number', 'min': 0, 'max': 10, 'step': 0.5, 'default': 1.5,
                   'label': 'Weight: absolute position in the pitch window'},
    'w_move': {'type': 'number', 'min': 0, 'max': 10, 'step': 0.5, 'default': 2.0,
               'label': 'Penalty per lane beyond a 2-lane jump on fast notes'},
    'fast_note_beats': {'type': 'number', 'min': 0.25, 'max': 2, 'step': 0.25, 'default': 0.5,
                        'label': 'Notes closer than this (beats) count as fast'},
    'register_window_notes': {'type': 'number', 'min': 2, 'max': 64, 'step': 1, 'default': 12,
                              'label': 'Notes in the moving pitch window'},
    'allow_open': {'type': 'boolean', 'default': True, 'label': 'Allow open notes (lane 7)'},
    'open_below_semitones': {'type': 'number', 'min': 3, 'max': 24, 'step': 1, 'default': 9,
                             'label': 'Open note when pitch is this far below the window'},
    'chord_polyphony_threshold': {'type': 'number', 'min': 2, 'max': 6, 'step': 1, 'default': 2,
                                  'label': 'Polyphony required for a chord'},
    'min_sustain_beats': {'type': 'number', 'min': 0.5, 'max': 4, 'step': 0.25, 'default': 1.0,
                          'label': 'Min note length for a sustain (beats)'},
    'sustain_gap_ticks': {'type': 'number', 'min': 0, 'max': 192, 'step': 8, 'default': 48,
                          'label': 'Gap kept before the next note (ticks)'},
}

_LANES = (0, 1, 2, 3, 4)
_OPEN = 7


def _now() -> str:
    return dt.datetime.now(dt.UTC).isoformat().replace('+00:00', 'Z')


def _group_by_tick(events: list[dict]) -> list[dict]:
    """One note per tick: the lowest pitch anchors, the full pitch set is kept."""
    by_tick: dict[int, dict] = {}
    for ev in events:
        if ev.get('dropped'):
            continue
        tick = int(ev['tick'])
        pitches = [int(m) for m in (ev.get('all_pitches_midi') or []) if m is not None]
        if not pitches and ev.get('dominant_midi') is not None:
            pitches = [int(ev['dominant_midi'])]
        g = by_tick.setdefault(tick, {'tick': tick, 'pitches': [], 'polyphony': 0,
                                      'duration_s': 0.0, 'velocity': None, 'metric_weight': 0,
                                      'time_s': ev.get('time_s_post')})
        g['pitches'].extend(pitches)
        g['polyphony'] = max(g['polyphony'], int(ev.get('polyphony', 1)), len(set(g['pitches'])))
        g['duration_s'] = max(g['duration_s'], float(ev.get('duration_s') or 0.0))
        if ev.get('velocity') is not None:
            g['velocity'] = max(g['velocity'] or 0.0, float(ev['velocity']))
        g['metric_weight'] = max(g['metric_weight'], int(ev.get('metric_weight', 0)))
    out = []
    for tick in sorted(by_tick):
        g = by_tick[tick]
        g['pitches'] = sorted(set(g['pitches']))
        g['midi'] = g['pitches'][0] if g['pitches'] else None
        out.append(g)
    return out


def _register_centres(notes: list[dict], window: int) -> np.ndarray:
    """Centred moving median of the surrounding pitched notes.

    Centred (not causal) on purpose: the song is analysed offline, and a
    causal window makes the first bars of every phrase map differently from
    the rest because the window is still filling. With a centred window a
    repeated phrase in the same register gets the same preferred lanes."""
    n = len(notes)
    centres = np.full(n, 60.0)
    pitched_idx = [i for i, x in enumerate(notes) if x['midi'] is not None]
    if not pitched_idx:
        return centres
    pitched = np.asarray([float(notes[i]['midi']) for i in pitched_idx])
    half = max(1, window // 2)
    for k, i in enumerate(pitched_idx):
        lo, hi = max(0, k - half), min(len(pitched), k + half + 1)
        centres[i] = float(np.median(pitched[lo:hi]))
    # Unpitched notes carry the nearest pitched centre.
    last = centres[pitched_idx[0]]
    for i in range(n):
        if notes[i]['midi'] is None:
            centres[i] = last
        else:
            last = centres[i]
    return centres


def assign_lanes_dp(notes: list[dict], params: dict[str, Any], resolution: int) -> list[int]:
    """Viterbi over lanes. Returns one lane (0-4 or 7) per note."""
    spl = float(params.get('semitones_per_lane', 2.0))
    w_contour = float(params.get('w_contour', 3.0))
    w_dir = float(params.get('w_direction', 8.0))
    w_same = float(params.get('w_same_pitch', 6.0))
    w_reg = float(params.get('w_register', 1.5))
    w_move = float(params.get('w_move', 2.0))
    fast_ticks = float(params.get('fast_note_beats', 0.5)) * resolution
    window = int(params.get('register_window_notes', 12))
    allow_open = bool(params.get('allow_open', True))
    open_below = float(params.get('open_below_semitones', 9))

    n = len(notes)
    if n == 0:
        return []
    states = list(_LANES) + ([_OPEN] if allow_open else [])
    S = len(states)
    centres = _register_centres(notes, window)

    def emit_cost(i: int, s: int) -> float:
        lane = states[s]
        midi = notes[i]['midi']
        if midi is None:
            return 0.0 if lane == 2 else 0.5  # unpitched: mild pull to the middle
        rel = (midi - centres[i]) / spl
        if lane == _OPEN:
            return 0.0 if (midi - centres[i]) <= -open_below else 1e6
        pref = min(4.0, max(0.0, 2.0 + rel))
        return w_reg * abs(lane - pref)

    def trans_cost(i: int, s_prev: int, s: int) -> float:
        lane_p, lane = states[s_prev], states[s]
        a, b = notes[i - 1], notes[i]
        if a['midi'] is None or b['midi'] is None:
            return 0.0
        d_pitch = b['midi'] - a['midi']
        if lane == _OPEN or lane_p == _OPEN:
            # Open ↔ fret: only require direction sanity (open is "below").
            if lane == _OPEN and d_pitch > 0:
                return w_dir
            if lane_p == _OPEN and d_pitch < 0:
                return w_dir
            return 0.0
        d_lane = lane - lane_p
        cost = 0.0
        if d_pitch == 0:
            cost += w_same * abs(d_lane)
        else:
            expected = int(np.clip(round(d_pitch / spl), -4, 4))
            cost += w_contour * abs(d_lane - expected)
            if d_pitch > 0 and d_lane < 0:
                cost += w_dir
            elif d_pitch < 0 and d_lane > 0:
                cost += w_dir
        if (b['tick'] - a['tick']) < fast_ticks and abs(d_lane) > 2:
            cost += w_move * (abs(d_lane) - 2)
        return cost

    cost = np.full((n, S), np.inf)
    back = np.zeros((n, S), dtype=np.int64)
    for s in range(S):
        cost[0, s] = emit_cost(0, s)
    for i in range(1, n):
        for s in range(S):
            e = emit_cost(i, s)
            if e >= 1e6:
                continue
            best, arg = np.inf, 0
            for sp in range(S):
                if cost[i - 1, sp] == np.inf:
                    continue
                c = cost[i - 1, sp] + trans_cost(i, sp, s)
                if c < best:
                    best, arg = c, sp
            cost[i, s] = best + e
            back[i, s] = arg
    lanes = [0] * n
    s = int(np.argmin(cost[-1]))
    for i in range(n - 1, -1, -1):
        lanes[i] = states[s]
        s = int(back[i, s])
    return lanes


def _chord_for(anchor: int, pitches: list[int], polyphony: int, threshold: int) -> list[int]:
    if anchor == _OPEN or polyphony < threshold or len(set(pitches)) < 2:
        return [anchor]
    partner = anchor + 1 if anchor < 4 else anchor - 1
    return sorted([anchor, partner])


def _sustain_ticks(note: dict, next_tick: int | None, segs, resolution: int,
                   min_beats: float, gap: int) -> int:
    dur = float(note.get('duration_s') or 0.0)
    if dur <= 0 or note.get('time_s') is None:
        return 0
    start_s = tick_to_seconds(note['tick'], segs, resolution)
    end_tick = seconds_to_tick(start_s + dur, segs, resolution)
    length = end_tick - note['tick']
    if next_tick is not None:
        length = min(length, next_tick - note['tick'] - gap)
    if length < min_beats * resolution:
        return 0
    return int(max(0, length))


def run_contour_dp(audio_path, upstream, params, on_progress):
    grid = upstream['grid']
    quant = upstream['quantized']
    resolution = int(grid.get('resolution', 192))
    segs = build_tempo_segments(
        [{'tick': t['tick_start'], 'micro_bpm': t['micro_bpm']} for t in grid['tempo_segments']], resolution,
    )
    chord_thr = int(params.get('chord_polyphony_threshold', 2))
    min_sus = float(params.get('min_sustain_beats', 1.0))
    gap = int(params.get('sustain_gap_ticks', 48))

    notes = _group_by_tick(quant['events'])
    on_progress('dp', 30, f'Assigning lanes to {len(notes)} notes…')
    lanes = assign_lanes_dp(notes, params, resolution)

    out = []
    for i, (note, lane) in enumerate(zip(notes, lanes)):
        next_tick = notes[i + 1]['tick'] if i + 1 < len(notes) else None
        frets = _chord_for(lane, note['pitches'], note['polyphony'], chord_thr)
        sustain = _sustain_ticks(note, next_tick, segs, resolution, min_sus, gap)
        ev = {'tick': note['tick'], 'frets': frets, 'sustain': sustain, 'section': 'song',
              'midi': note['midi'], 'pitches': note['pitches']}
        if note.get('velocity') is not None:
            ev['velocity'] = note['velocity']
        out.append(ev)
    metric_weights = {str(e['tick']): int(e.get('metric_weight', 0)) for e in quant['events'] if not e.get('dropped')}
    on_progress('done', 100, f'{len(out)} lane events, {sum(1 for e in out if e["sustain"])} sustains, '
                             f'{sum(1 for e in out if len(e["frets"]) == 2)} chords')
    return {'engine': 'contour-dp', 'params': params, 'generated_at': _now(),
            'lanes': out, 'metric_weights': metric_weights}


register_engine(Stage.LANES_EXPERT, EngineSpec(
    id='contour-dp', display_name='Contour DP (Viterbi lane assignment, sustains, real chords)',
    params_schema=_PARAMS, runner=run_contour_dp,
))
