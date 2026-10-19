"""Class-aware drum hit detection (numpy/scipy only).

The earlier drum path ran one onset detector over the whole drum stem and
tagged each onset with a single spectral centroid, so a kick and a hi-hat on
the same beat became *one* onset with a blended centroid (usually landing on
the tom lane) and lanes were percentile bins rather than instruments.

This module runs onset detection separately in three frequency bands of the
separated drum stem, so simultaneous hits come out as separate events, then
refines each band hit into a drum class:

    low  (30–130 Hz)      → kick
    mid  (130–1000 Hz)    → snare  (broadband snap present)  | tom (no snap)
    high (6–11 kHz)       → hihat  (fast decay)              | cymbal (slow decay / loud)

Output is a dict ``{class: [DrumHit(time_s, velocity), ...]}``. It is the
cheapest member of a family (NMF-template and pretrained-ADT engines can
produce the same shape later) and is meant to be judged by the eval harness
(`pipeline.evaluate`) against reference charts, not by eye.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy.signal import stft

DRUM_CLASSES = ('kick', 'snare', 'hihat', 'tom', 'cymbal')

# General MIDI percussion numbers used as the "fake MIDI" carried through
# the pitch/quantize stages — a real standard, so stage JSONs stay readable.
GM_FOR_CLASS = {'kick': 36, 'snare': 38, 'hihat': 42, 'tom': 45, 'cymbal': 49}
CLASS_FOR_GM: dict[int, str] = {
    35: 'kick', 36: 'kick',
    37: 'snare', 38: 'snare', 39: 'snare', 40: 'snare',
    42: 'hihat', 44: 'hihat', 46: 'hihat',
    41: 'tom', 43: 'tom', 45: 'tom', 47: 'tom', 48: 'tom', 50: 'tom',
    49: 'cymbal', 51: 'cymbal', 52: 'cymbal', 53: 'cymbal', 55: 'cymbal', 57: 'cymbal', 59: 'cymbal',
}


@dataclass(frozen=True)
class DrumHit:
    time_s: float
    velocity: float  # 0..1, relative to the band's loud hits

    def as_dict(self) -> dict[str, float]:
        return {'time_s': float(self.time_s), 'velocity': float(self.velocity)}


DEFAULT_PARAMS: dict[str, Any] = {
    'delta': 0.12,             # adaptive-threshold offset (fraction of band's loud-hit flux)
    'min_ioi_ms': 50.0,        # minimum gap between hits in one band
    'energy_gate_db': -20.0,   # per band: drop peaks quieter than this vs the band's loud hits
    'snare_noise_ratio': 0.2,  # (1.5–6 kHz) / (100–500 Hz) energy above → snare, else tom
                               # (overridden by an Otsu split when the ratios are clearly bimodal)
    'cymbal_decay_ratio': 0.45,  # high-band energy @+150 ms / @+15 ms above → cymbal
    'cymbal_velocity_pct': 92.0,  # high hits above this velocity percentile are cymbals too
    'kick_bleed_ratio': 2.0,    # mid peak whose mid/low energy is below this is kick bleed → drop
    'kick_low_dominance': 0.5,  # low peak needs low-band energy ≥ this × mid-band energy
    'hat_over_snare_ratio': 1.0,  # high peak coincident with a snare needs high/snap energy above this
    'backtrack': True,
}


def _band_mask(freqs: np.ndarray, lo: float, hi: float) -> np.ndarray:
    return (freqs >= lo) & (freqs < hi)


def _peak_pick(flux: np.ndarray, hop_s: float, delta: float, min_ioi_s: float,
               backtrack: bool) -> list[tuple[int, float]]:
    """Return (frame, strength) peaks of a flux curve using a local-mean
    adaptive threshold, a local-max test and a minimum inter-onset gap."""
    n = len(flux)
    if n == 0:
        return []
    # Normalise by the band's loud hits (mean of the top 2 % of frames) so
    # the threshold is relative to real hits, not to the leakage floor.
    top = np.sort(flux)[-max(1, int(round(0.02 * n))):]
    scale = float(top.mean()) or 1.0
    f = flux / scale
    w = max(1, int(round(0.10 / hop_s)))      # ±100 ms local mean
    pre = max(1, int(round(0.03 / hop_s)))    # local-max window
    post = max(1, int(round(0.03 / hop_s)))
    kernel = np.ones(2 * w + 1) / (2 * w + 1)
    local_mean = np.convolve(f, kernel, mode='same')
    thr = local_mean + delta
    min_gap = max(1, int(round(min_ioi_s / hop_s)))
    peaks: list[tuple[int, float]] = []
    last = -10 ** 9
    for i in range(n):
        if f[i] < thr[i] or f[i] <= 0:
            continue
        lo, hi = max(0, i - pre), min(n, i + post + 1)
        if f[i] < f[lo:hi].max():
            continue
        if i - last < min_gap:
            # keep the stronger of two close candidates
            if peaks and f[i] > peaks[-1][1]:
                peaks[-1] = (i, float(f[i]))
                last = i
            continue
        peaks.append((i, float(f[i])))
        last = i
    if backtrack:
        out = []
        for i, s in peaks:
            j = i
            while j > 0 and f[j - 1] > 0.2 * f[i] and f[j - 1] < f[j]:
                j -= 1
            out.append((j, s))
        peaks = out
    return peaks


def _otsu_threshold(values: np.ndarray, bins: int = 32) -> float:
    """Threshold separating a 1-D sample into two classes (max between-class
    variance). Used to split snare/tom and similar bimodal feature sets."""
    hist, edges = np.histogram(values, bins=bins)
    centers = (edges[:-1] + edges[1:]) / 2
    total = hist.sum()
    best, best_t = -1.0, float(np.median(values))
    w0 = 0.0
    sum0 = 0.0
    sum_all = float((hist * centers).sum())
    for i in range(bins - 1):
        w0 += hist[i]
        if w0 == 0:
            continue
        w1 = total - w0
        if w1 == 0:
            break
        sum0 += hist[i] * centers[i]
        m0 = sum0 / w0
        m1 = (sum_all - sum0) / w1
        var = w0 * w1 * (m0 - m1) ** 2
        if var > best:
            best, best_t = var, float(edges[i + 1])
    return best_t


def detect_drum_hits(
    y: np.ndarray,
    sr: int,
    params: dict[str, Any] | None = None,
) -> dict[str, list[DrumHit]]:
    """Detect kick/snare/hihat/tom/cymbal hits in a mono drum stem."""
    p = {**DEFAULT_PARAMS, **(params or {})}
    y = np.asarray(y, dtype=np.float32)
    if y.ndim > 1:
        y = y.mean(axis=0)
    hits: dict[str, list[DrumHit]] = {c: [] for c in DRUM_CLASSES}
    if len(y) < 2048:
        return hits

    n_fft, hop = 1024, 256
    freqs, _times, Z = stft(y, fs=sr, nperseg=n_fft, noverlap=n_fft - hop, boundary='zeros', padded=True)
    mag = np.abs(Z)                        # (bins, frames)
    power = mag ** 2
    logmag = np.log1p(20.0 * mag)
    hop_s = hop / sr
    n_frames = mag.shape[1]

    bands = {
        'low': _band_mask(freqs, 30, 100),
        'mid': _band_mask(freqs, 100, 1000),
        'high': _band_mask(freqs, 6000, min(11000, sr / 2)),
    }
    # Auxiliary bands for class refinement.
    snap = _band_mask(freqs, 1500, 6000)
    body = _band_mask(freqs, 100, 500)

    def flux_of(mask: np.ndarray) -> np.ndarray:
        d = np.diff(logmag[mask], axis=1, prepend=logmag[mask][:, :1])
        return np.maximum(d, 0).sum(axis=0)

    def energy(mask: np.ndarray, frame: int, span: int = 2) -> float:
        a, b = max(0, frame), min(n_frames, frame + span)
        if b <= a:
            return 0.0
        return float(power[mask][:, a:b].sum())

    min_ioi_s = float(p['min_ioi_ms']) / 1000.0
    delta = float(p['delta'])
    peaks = {name: _peak_pick(flux_of(mask), hop_s, delta, min_ioi_s, bool(p['backtrack']))
             for name, mask in bands.items()}

    # Energy gate: a transient in another band leaks a little energy into
    # every band (the attack is broadband), so drop candidates far quieter
    # than the band's typical loud hit.
    gate = 10.0 ** (float(p['energy_gate_db']) / 10.0)
    for name, mask in bands.items():
        if not peaks[name]:
            continue
        energies = np.asarray([energy(mask, fr, 3) for fr, _s in peaks[name]])
        ref = float(np.percentile(energies, 90)) if len(energies) >= 3 else float(energies.max())
        peaks[name] = [(fr, s) for (fr, s), e in zip(peaks[name], energies) if e >= gate * ref]

    # ── kick: must be low-dominant (a snare/tom body leaks a little into
    #    the low band, but never more than its own band carries).
    for fr, s in peaks['low']:
        e_low = energy(bands['low'], fr, 5)
        e_mid = energy(bands['mid'], fr, 5)
        if e_low < float(p['kick_low_dominance']) * e_mid:
            continue
        hits['kick'].append(DrumHit(fr * hop_s, min(1.0, s)))

    # ── snare vs tom (mid band), suppressing kick bleed
    mid_cands: list[tuple[int, float, float]] = []
    for fr, s in peaks['mid']:
        e_mid = energy(bands['mid'], fr, 5)
        e_low = energy(bands['low'], fr, 5)
        if e_mid < float(p['kick_bleed_ratio']) * max(e_low, 1e-12):
            continue  # the kick's upper partials, not a separate drum
        e_snap = energy(snap, fr, 5)
        e_body = energy(body, fr, 5)
        mid_cands.append((fr, s, np.log10(e_snap / max(e_body, 1e-12) + 1e-9)))
    thr_log = np.log10(float(p['snare_noise_ratio']))
    if len(mid_cands) >= 8:
        ratios = np.asarray([r for _f, _s, r in mid_cands])
        if ratios.std() > 0.45:  # clearly two populations → split between them
            thr_log = _otsu_threshold(ratios)
    snare_frames: list[int] = []
    for fr, s, r in mid_cands:
        cls = 'snare' if r >= thr_log else 'tom'
        hits[cls].append(DrumHit(fr * hop_s, min(1.0, s)))
        if cls == 'snare':
            snare_frames.append(fr)
    snare_frames_arr = np.asarray(snare_frames)

    # ── hihat vs cymbal (high band): decay + loudness, with snare-bleed and
    #    post-cymbal-decay suppression
    high_strengths = np.asarray([s for _f, s in peaks['high']]) if peaks['high'] else np.asarray([])
    loud_cut = float(np.percentile(high_strengths, float(p['cymbal_velocity_pct']))) if len(high_strengths) > 3 else np.inf
    f15 = max(1, int(round(0.015 / hop_s)))
    f150 = max(1, int(round(0.150 / hop_s)))
    coinc = max(1, int(round(0.020 / hop_s)))
    tail_win = int(round(0.120 / hop_s))
    last_cymbal: tuple[int, float] | None = None
    for fr, s in peaks['high']:
        if len(snare_frames_arr) and np.abs(snare_frames_arr - fr).min() <= coinc:
            # A snare's noise reaches the high band; only call it a hat too
            # if the high band clearly dominates the snare's snap band.
            e_high = energy(bands['high'], fr, 3)
            e_snap = energy(snap, fr, 3)
            if e_high < float(p['hat_over_snare_ratio']) * max(e_snap, 1e-12):
                continue
        if last_cymbal is not None and 0 < fr - last_cymbal[0] <= tail_win and s < 0.5 * last_cymbal[1]:
            continue  # fluctuation inside a crash's decay
        e_early = energy(bands['high'], fr + f15, 2)
        e_late = energy(bands['high'], fr + f150, 2)
        decay = e_late / max(e_early, 1e-12)
        is_cymbal = decay >= float(p['cymbal_decay_ratio']) or (len(high_strengths) > 3 and s >= loud_cut)
        if is_cymbal:
            last_cymbal = (fr, s)
        hits['cymbal' if is_cymbal else 'hihat'].append(DrumHit(fr * hop_s, min(1.0, s)))

    for c in hits:
        hits[c].sort(key=lambda h: h.time_s)
    return hits


def merge_hits(hits: dict[str, list[DrumHit]], merge_ms: float = 15.0) -> list[dict[str, Any]]:
    """Collapse all classes into one strictly-monotonic onset list (what the
    OnsetList schema requires), keeping the per-onset class set."""
    events = sorted(
        ((h.time_s, c, h.velocity) for c, hs in hits.items() for h in hs),
        key=lambda e: e[0],
    )
    merged: list[dict[str, Any]] = []
    tol = merge_ms / 1000.0
    for t, c, v in events:
        if merged and t - merged[-1]['time_s'] <= tol:
            m = merged[-1]
            m['classes'][c] = max(m['classes'].get(c, 0.0), v)
            m['confidence'] = max(m['confidence'], v)
            continue
        merged.append({'time_s': float(t), 'confidence': float(v), 'classes': {c: float(v)}})
    # Guarantee strict monotonicity even after merge (identical times).
    out: list[dict[str, Any]] = []
    for m in merged:
        if out and m['time_s'] <= out[-1]['time_s']:
            m['time_s'] = out[-1]['time_s'] + 1e-4
        out.append(m)
    return out
