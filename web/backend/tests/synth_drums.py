"""Synthetic drum-kit audio for tests (no samples needed).

`render_pattern` turns a list of (time_s, class) hits into a mono float32
signal with plausible kick / snare / hihat / tom / cymbal spectra, so the
class-aware detector can be scored deterministically."""
from __future__ import annotations

import numpy as np
from scipy.signal import butter, sosfilt


def _env(n: int, sr: int, decay_s: float) -> np.ndarray:
    t = np.arange(n) / sr
    return np.exp(-t / decay_s)


def _bandpass(x: np.ndarray, sr: int, lo: float, hi: float) -> np.ndarray:
    sos = butter(4, [lo, min(hi, sr / 2 - 1)], btype='band', fs=sr, output='sos')
    return sosfilt(sos, x)


def kick(sr: int, rng) -> np.ndarray:
    n = int(0.25 * sr)
    t = np.arange(n) / sr
    f = 50 + 90 * np.exp(-t / 0.03)  # pitch sweep down to ~50 Hz
    phase = 2 * np.pi * np.cumsum(f) / sr
    return 0.9 * np.sin(phase) * _env(n, sr, 0.12)


def snare(sr: int, rng) -> np.ndarray:
    n = int(0.2 * sr)
    t = np.arange(n) / sr
    body = 0.5 * np.sin(2 * np.pi * 190 * t) * _env(n, sr, 0.08)
    noise = _bandpass(rng.standard_normal(n), sr, 1500, 9000) * _env(n, sr, 0.09)
    return body + 0.7 * noise / (np.abs(noise).max() + 1e-9)


def tom(sr: int, rng) -> np.ndarray:
    n = int(0.3 * sr)
    t = np.arange(n) / sr
    f = 120 + 60 * np.exp(-t / 0.05)
    phase = 2 * np.pi * np.cumsum(f) / sr
    return 0.8 * np.sin(phase) * _env(n, sr, 0.15)


def hihat(sr: int, rng) -> np.ndarray:
    n = int(0.06 * sr)
    noise = _bandpass(rng.standard_normal(n), sr, 6500, 10500) * _env(n, sr, 0.012)
    return 0.5 * noise / (np.abs(noise).max() + 1e-9)


def cymbal(sr: int, rng) -> np.ndarray:
    n = int(0.9 * sr)
    noise = _bandpass(rng.standard_normal(n), sr, 5000, 10500) * _env(n, sr, 0.35)
    return 0.9 * noise / (np.abs(noise).max() + 1e-9)


_GEN = {'kick': kick, 'snare': snare, 'tom': tom, 'hihat': hihat, 'cymbal': cymbal}


def render_pattern(hits: list[tuple[float, str]], sr: int = 22050, duration_s: float | None = None,
                   seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    end = max(t for t, _ in hits) + 1.0 if duration_s is None else duration_s
    y = np.zeros(int(end * sr), dtype=np.float64)
    for t, cls in hits:
        s = _GEN[cls](sr, rng)
        i = int(round(t * sr))
        j = min(len(y), i + len(s))
        y[i:j] += s[: j - i]
    peak = np.abs(y).max() or 1.0
    return (0.9 * y / peak).astype(np.float32)


def rock_beat(bars: int = 4, bpm: float = 120.0, start: float = 0.5) -> list[tuple[float, str]]:
    """Kick 1&3, snare 2&4, hats on 8ths, crash on bar 1, tom fill in the last bar."""
    beat = 60.0 / bpm
    hits: list[tuple[float, str]] = []
    for bar in range(bars):
        b0 = start + bar * 4 * beat
        hits += [(b0, 'kick'), (b0 + 2 * beat, 'kick'), (b0 + beat, 'snare'), (b0 + 3 * beat, 'snare')]
        if bar == bars - 1:
            # Fill: three 16th toms after the beat-4 snare.
            hits += [(b0 + 3 * beat + k * beat / 4, 'tom') for k in range(1, 4)]
        else:
            hits += [(b0 + k * beat / 2, 'hihat') for k in range(8)]
        if bar == 0:
            hits.append((b0, 'cymbal'))
    return sorted(hits)
