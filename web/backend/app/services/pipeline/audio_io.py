"""Audio loading. librosa when available; otherwise soundfile or an ffmpeg
subprocess (the backend already requires ffmpeg for stem conversion), so the
numpy/scipy-only engines (drum detection, phrase analysis) never depend on
librosa being importable."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import numpy as np


def _resample(y: np.ndarray, sr: int, target_sr: int) -> np.ndarray:
    if sr == target_sr:
        return y
    from scipy.signal import resample_poly
    from math import gcd
    g = gcd(sr, target_sr)
    return resample_poly(y, target_sr // g, sr // g, axis=-1).astype(np.float32)


def _load_ffmpeg(path: Path, target_sr: int | None, mono: bool) -> tuple[np.ndarray, int]:
    ffmpeg = shutil.which('ffmpeg')
    if ffmpeg is None:
        raise RuntimeError('neither librosa, soundfile nor ffmpeg is available to decode audio')
    sr = int(target_sr or 44100)
    channels = 1 if mono else 2
    cmd = [ffmpeg, '-v', 'error', '-i', str(path), '-f', 'f32le', '-acodec', 'pcm_f32le',
           '-ac', str(channels), '-ar', str(sr), '-']
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    y = np.frombuffer(raw, dtype=np.float32)
    if not mono:
        y = y.reshape(-1, 2).T
    return y, sr


def load_audio(
    path: str | Path,
    target_sr: int | None = None,
    mono: bool = True,
) -> tuple[np.ndarray, int]:
    """Load audio file, optionally resampling and downmixing.

    Returns (samples float32 in [-1, 1], sample_rate). Shape is (n,) for
    mono, (channels, n) otherwise — librosa's convention.
    """
    path = Path(path)
    try:
        import librosa
    except ImportError:
        librosa = None
    if librosa is not None:
        y, sr = librosa.load(str(path), sr=target_sr, mono=mono)
        if y.dtype != np.float32:
            y = y.astype(np.float32, copy=False)
        return y, int(sr)

    try:
        import soundfile as sf
        y, sr = sf.read(str(path), dtype='float32', always_2d=True)
        y = y.T  # (channels, n)
        if mono:
            y = y.mean(axis=0)
        if target_sr is not None and int(sr) != int(target_sr):
            y = _resample(y, int(sr), int(target_sr))
            sr = int(target_sr)
        return np.ascontiguousarray(y, dtype=np.float32), int(sr)
    except Exception:  # noqa: BLE001 — fall through to ffmpeg (e.g. ogg/mp3 without libsndfile support)
        pass
    return _load_ffmpeg(path, target_sr, mono)
