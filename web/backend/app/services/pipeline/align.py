"""Align two recordings of the same song (an auto-charted stem vs a reference
master) so their charts can be compared on one clock.

A YouTube rip and a game master typically differ by a few seconds of
lead-in and a fraction of a percent in speed (pitch-preserving edits,
different sample-rate chains). Both matter at ±50 ms matching tolerance:
0.2 % over five minutes is 600 ms.

`align_audio(a, b)` returns (speed, lag) such that ``t_b = t_a / speed +
lag``, found by cross-correlating spectral-flux curves over a speed sweep
and then verifying the lag per window — a repetitive song has several
similar lags from different choruses, and only the true one is stable
across the whole file. numpy/scipy + ffmpeg only.
"""
from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.signal import fftconvolve, stft

_SR = 11025
_HOP = 110
FPS = _SR / _HOP


@dataclass
class Alignment:
    speed: float
    lag_s: float
    ncc: float               # normalised cross-correlation at the chosen (speed, lag)
    window_lag_std_ms: float  # spread of per-window lags; small = trustworthy
    windows: int

    @property
    def reliable(self) -> bool:
        return self.ncc >= 0.35 and self.window_lag_std_ms <= 40 and self.windows >= 3

    def to_ref(self, t_auto: float) -> float:
        return t_auto / self.speed + self.lag_s


def _decode(path: Path) -> np.ndarray:
    raw = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', str(path), '-f', 'f32le', '-ac', '1', '-ar', str(_SR), '-'],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)


def _mix(paths: list[Path]) -> np.ndarray:
    ys = [_decode(p) for p in paths]
    n = max(len(y) for y in ys)
    out = np.zeros(n, dtype=np.float32)
    for y in ys:
        out[:len(y)] += y
    return out


def flux_curve(y: np.ndarray) -> np.ndarray:
    """Half-wave-rectified log-spectral flux at FPS, locally de-meaned and
    unit-variance — insensitive to mastering level/EQ."""
    _f, _t, Z = stft(y, fs=_SR, nperseg=512, noverlap=512 - _HOP, boundary='zeros', padded=True)
    L = np.log1p(50 * np.abs(Z))
    d = np.diff(L, axis=1, prepend=L[:, :1])
    x = np.maximum(d, 0).sum(0)
    x = x - np.convolve(x, np.ones(101) / 101, 'same')
    return (x / (x.std() + 1e-9)).astype(np.float32)


def _stretch(x: np.ndarray, speed: float) -> np.ndarray:
    n = int(len(x) / speed)
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


def _best_lag(ref: np.ndarray, cand: np.ndarray) -> tuple[float, float]:
    c = fftconvolve(ref, cand[::-1], 'full')
    k = int(np.argmax(c))
    ncc = float(c[k] / np.sqrt((cand ** 2).sum() * (ref ** 2).sum()))
    return (k - (len(cand) - 1)) / FPS, ncc


def align_flux(fa: np.ndarray, fr: np.ndarray, speeds=None) -> Alignment:
    if speeds is None:
        coarse = np.arange(0.96, 1.0401, 0.0025)
    else:
        coarse = np.asarray(speeds)
    best = max(((_best_lag(fr, _stretch(fa, s)), s) for s in coarse), key=lambda t: t[0][1])
    (lag, ncc), speed = best
    fine = np.arange(speed - 0.002, speed + 0.00201, 0.00025)
    best = max(((_best_lag(fr, _stretch(fa, s)), s) for s in fine), key=lambda t: t[0][1])
    (lag, ncc), speed = best
    fas = _stretch(fa, speed)
    # Per-window verification around the global lag.
    win, search = 20.0, 1.0
    lags = []
    for start in np.arange(0, len(fas) / FPS - win, win):
        a = fas[int(start * FPS):int((start + win) * FPS)]
        lo, hi = int((start + lag - search) * FPS), int((start + lag + search + win) * FPS)
        if lo < 0 or hi > len(fr):
            continue
        r = fr[lo:hi]
        cc = fftconvolve(r, a[::-1], 'valid')
        k = int(np.argmax(cc))
        lags.append((lo + k) / FPS - start)
    std_ms = float(np.std(lags) * 1000) if len(lags) >= 2 else float('inf')
    lag_final = float(np.median(lags)) if lags else lag
    return Alignment(speed=float(speed), lag_s=lag_final, ncc=ncc, window_lag_std_ms=std_ms, windows=len(lags))


def align_audio(auto_audio: Path, ref_audio: Path | list[Path]) -> Alignment:
    """``t_ref = t_auto / speed + lag``. Pass the reference drum stems (a
    list) when comparing a drum-stem chart — a much cleaner signal than
    the full mix."""
    fa = flux_curve(_decode(Path(auto_audio)))
    fr = flux_curve(_mix([Path(p) for p in ref_audio]) if isinstance(ref_audio, list) else _decode(Path(ref_audio)))
    return align_flux(fa, fr)
