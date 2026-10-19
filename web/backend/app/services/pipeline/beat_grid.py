"""Beat-anchored tempo grids.

The original S1 engines kept only a single BPM number from the beat tracker
and declared tick 0 = 0.000 s, so detected beats landed on arbitrary ticks
(0 of 60 downbeats on the grid in a realistic test) and the quantizer's
metric weights were close to random — Easy/Medium charts came out nearly
empty and everything drifted by the BPM-estimate error over the song.

`beats_to_grid` does what a human charter does in Moonscraper: it puts every
detected beat on a tick that is an exact multiple of `resolution` and emits a
piecewise tempo map (one `B` marker per run of near-constant tempo) so that
``tick_to_seconds(beat_i) == beat_times[i]`` to within `merge_tol_ms`.
Downbeats are then on the grid by construction and bar lines (`TS`) are
re-anchored at the first downbeat so a pickup intro doesn't shift every bar.

Pure Python + numpy; engines feed it beat times from whichever tracker
they use (madmom RNN/DBN, librosa, all-in-one).
"""
from __future__ import annotations

from typing import Any, Sequence

import numpy as np

from .tempo_math import build_tempo_segments, seconds_to_tick

# Lead-in handling: tick 0 is always audio time 0 (the editor's tempo map
# assumes it), so the span before the first beat is covered by virtual beats
# at a lead-in tempo. A first beat closer than this to t=0 is simply pinned
# to tick 0 (one beat, < 60 ms error) rather than creating an absurd tempo.
_MIN_LEAD_IN_S = 0.06
_MAX_LEAD_IN_BPM = 1000.0
_MIN_BPM = 20.0
_MAX_BPM = 400.0


def _median_period(beat_times: np.ndarray) -> float:
    if len(beat_times) < 2:
        return 0.5
    return float(np.median(np.diff(beat_times)))


def _micro_bpm(span_ticks: float, resolution: int, span_s: float) -> int:
    """Tempo (in 1/1000 BPM, as .chart `B` markers use) that makes
    `span_ticks` ticks last exactly `span_s` seconds, clamped to sane bounds."""
    micro = 60000.0 * (span_ticks / resolution) / max(1e-6, span_s)
    return int(round(min(max(micro, _MIN_BPM * 1000), _MAX_BPM * 1000)))


def _merge_runs(
    beat_ticks: np.ndarray,
    beat_times: np.ndarray,
    resolution: int,
    merge_tol_s: float,
    start_s: float | None = None,
) -> list[dict[str, Any]]:
    """Greedy left-to-right merge of per-beat tempo segments.

    A run [a, b] of beats becomes one segment with BPM chosen so beat b lands
    exactly; it is extended while every interior beat stays within
    `merge_tol_s` of its true time. Segment start seconds are tracked with
    the *rounded* micro_bpm exactly as `tempo_math.build_tempo_segments`
    does, so the backend/frontend reconstruction has no cumulative drift.
    """
    segs: list[dict[str, Any]] = []
    n = len(beat_times)
    a = 0
    # Wall-clock seconds at beat_ticks[a]. When the first beat is pinned to
    # tick 0 the caller passes start_s=0 so the first segment absorbs the
    # small offset and beat 1 still lands exactly.
    cum_s = float(beat_times[0]) if start_s is None else float(start_s)
    while a < n - 1:
        b = a + 1
        best_b = b
        while b < n:
            span_ticks = beat_ticks[b] - beat_ticks[a]
            span_s = beat_times[b] - cum_s
            if span_s <= 0:
                break
            micro_bpm = _micro_bpm(span_ticks, resolution, span_s)
            # Check every interior beat under the rounded tempo.
            ok = True
            for k in range(a + 1, b):
                pred = cum_s + (beat_ticks[k] - beat_ticks[a]) / resolution * (60000.0 / micro_bpm)
                if abs(pred - beat_times[k]) > merge_tol_s:
                    ok = False
                    break
            if not ok:
                break
            best_b = b
            b += 1
        span_ticks = beat_ticks[best_b] - beat_ticks[a]
        span_s = max(1e-6, beat_times[best_b] - cum_s)
        micro_bpm = _micro_bpm(span_ticks, resolution, span_s)
        segs.append({'tick_start': int(beat_ticks[a]), 'micro_bpm': micro_bpm})
        cum_s += span_ticks / resolution * (60000.0 / micro_bpm)
        a = best_b
    return segs


def beats_to_grid(
    beat_times: Sequence[float],
    *,
    resolution: int = 192,
    audio_duration_s: float,
    downbeat_indices: Sequence[int] | None = None,
    beats_per_bar: int = 4,
    merge_tol_ms: float = 5.0,
    section_times: Sequence[float] | None = None,
    section_labels: Sequence[str] | None = None,
) -> dict[str, Any]:
    """Build the SongGrid core (tempo/TS/downbeats/sections) from beat times.

    Parameters
    ----------
    beat_times
        Sorted beat times in seconds.
    downbeat_indices
        Indices into `beat_times` that are downbeats. If None, every
        `beats_per_bar`-th beat from the first is assumed.
    merge_tol_ms
        Max timing error allowed for any beat when merging adjacent tempo
        segments. Lower = more `B` markers, tighter fit.
    section_times / section_labels
        Optional structural boundaries in seconds; snapped to the nearest
        downbeat tick.

    Returns a dict with keys resolution, audio_duration_s, tempo_segments,
    time_sig_segments, downbeats, sections, beat_ticks, lead_in_beats.
    """
    bt = np.asarray(sorted(float(t) for t in beat_times), dtype=np.float64)
    bt = bt[bt >= 0]
    if len(bt) == 0:
        bt = np.array([0.0])
    period = _median_period(bt)
    merge_tol_s = merge_tol_ms / 1000.0

    # ── Lead-in: virtual beats between t=0 and the first detected beat.
    t0 = float(bt[0])
    if t0 < _MIN_LEAD_IN_S:
        lead_in = 0
    else:
        lead_in = max(1, int(round(t0 / period)))
        # Keep the lead-in tempo plausible: more virtual beats = slower.
        while 60.0 * lead_in / t0 > _MAX_LEAD_IN_BPM:
            lead_in += 1

    if downbeat_indices is None:
        db_idx = list(range(0, len(bt), max(1, beats_per_bar)))
    else:
        db_idx = sorted({int(i) for i in downbeat_indices if 0 <= int(i) < len(bt)})
        if not db_idx:
            db_idx = list(range(0, len(bt), max(1, beats_per_bar)))

    beat_ticks = (np.arange(len(bt)) + lead_in) * resolution

    # ── Tempo map.
    tempo_segments: list[dict[str, Any]] = []
    if lead_in > 0:
        lead_bpm = 60.0 * lead_in / t0
        tempo_segments.append({'tick_start': 0, 'micro_bpm': int(round(lead_bpm * 1000)), 'label': 'lead-in'})
    if len(bt) >= 2:
        runs = _merge_runs(beat_ticks, bt, resolution, merge_tol_s,
                           start_s=0.0 if lead_in == 0 else None)
        for i, seg in enumerate(runs):
            seg['label'] = f'seg_{i}'
        tempo_segments.extend(runs)
        # The last run's tempo holds to the end of the audio.
    else:
        bpm = 60.0 / period
        tempo_segments.append({'tick_start': int(beat_ticks[0]), 'micro_bpm': int(round(bpm * 1000)), 'label': 'seg_0'})
    if tempo_segments[0]['tick_start'] != 0:
        tempo_segments[0]['tick_start'] = 0
    # Dedupe any equal tick_starts (e.g. lead-in == 0 and first run at 0).
    dedup: list[dict[str, Any]] = []
    for seg in tempo_segments:
        if dedup and dedup[-1]['tick_start'] == seg['tick_start']:
            dedup[-1] = seg
        else:
            dedup.append(seg)
    tempo_segments = dedup

    # ── Downbeats + time signatures.
    downbeat_ticks = [int(beat_ticks[i]) for i in db_idx]
    time_sig_segments: list[dict[str, Any]] = []
    pickup_beats = int(beat_ticks[db_idx[0]] // resolution) if db_idx else 0
    if pickup_beats > 0:
        # Bars before the first downbeat: one pickup bar if it fits.
        time_sig_segments.append({'tick_start': 0, 'num': min(16, max(1, pickup_beats)), 'denom_pow': 2})
    current_num = None
    for j, i in enumerate(db_idx):
        if j + 1 < len(db_idx):
            num = db_idx[j + 1] - i
        else:
            num = current_num or beats_per_bar
        num = int(min(16, max(1, num)))
        if num != current_num:
            tick = int(beat_ticks[i])
            if time_sig_segments and time_sig_segments[-1]['tick_start'] == tick:
                time_sig_segments[-1]['num'] = num
            else:
                time_sig_segments.append({'tick_start': tick, 'num': num, 'denom_pow': 2})
            current_num = num
    if not time_sig_segments:
        time_sig_segments = [{'tick_start': 0, 'num': beats_per_bar, 'denom_pow': 2}]
    if time_sig_segments[0]['tick_start'] != 0:
        time_sig_segments.insert(0, {'tick_start': 0, 'num': beats_per_bar, 'denom_pow': 2})

    # ── Sections, snapped to the nearest downbeat.
    sections: list[dict[str, Any]] = []
    if section_times:
        segs = build_tempo_segments(
            [{'tick': s['tick_start'], 'micro_bpm': s['micro_bpm']} for s in tempo_segments], resolution,
        )
        # Tick 0 is always a legal section start (intro before the first bar).
        db_arr = np.asarray(sorted({0, *downbeat_ticks}))
        seen: set[int] = set()
        for k, t in enumerate(section_times):
            raw = seconds_to_tick(float(t), segs, resolution)
            tick = int(db_arr[int(np.argmin(np.abs(db_arr - raw)))])
            if tick in seen:
                continue
            seen.add(tick)
            label = section_labels[k] if section_labels and k < len(section_labels) else f'section_{k}'
            sections.append({'tick_start': tick, 'label': str(label)})
        sections.sort(key=lambda s: s['tick_start'])
        if not sections or sections[0]['tick_start'] != 0:
            sections.insert(0, {'tick_start': 0, 'label': 'intro' if sections else 'song'})
    else:
        sections = [{'tick_start': 0, 'label': 'song'}]

    return {
        'resolution': int(resolution),
        'audio_duration_s': float(audio_duration_s),
        'tempo_segments': tempo_segments,
        'time_sig_segments': time_sig_segments,
        'downbeats': downbeat_ticks,
        'sections': sections,
        'beat_ticks': [int(t) for t in beat_ticks],
        'lead_in_beats': int(lead_in),
    }


def positions_to_downbeat_indices(beat_positions: Sequence[float]) -> list[int]:
    """madmom's DBN downbeat tracker labels each beat with its position in
    the bar (1 = downbeat). Return the indices of the downbeats."""
    return [i for i, p in enumerate(beat_positions) if int(round(float(p))) == 1]
