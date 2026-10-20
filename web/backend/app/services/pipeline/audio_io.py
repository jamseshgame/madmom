"""Audio loading. librosa when available, then soundfile, then an ffmpeg
subprocess (the backend already requires ffmpeg for stem conversion).

Every step is a fallback for the one before it, not just an import-time
choice: librosa and soundfile both decode through libsndfile, which rejects
some files ffmpeg handles happily — notably any Ogg whose first logical
stream isn't audio ("File contains data in an unimplemented format"), which
is what an mp3 with cover art or a YouTube pull turned into when converted
without ``-vn``. ffmpeg decodes those fine, so it is the last resort for
everything rather than only for installs without librosa."""
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
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        tail = proc.stderr.decode('utf-8', errors='replace').strip().splitlines()[-2:]
        raise RuntimeError(' '.join(tail) or f'ffmpeg exited {proc.returncode}')
    y = np.frombuffer(proc.stdout, dtype=np.float32)
    if len(y) == 0:
        raise RuntimeError('ffmpeg produced no audio samples')
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
    errors: list[str] = []
    try:
        import librosa
        y, sr = librosa.load(str(path), sr=target_sr, mono=mono)
        if y.dtype != np.float32:
            y = y.astype(np.float32, copy=False)
        return y, int(sr)
    except ImportError:
        pass
    except Exception as e:  # noqa: BLE001 — libsndfile/audioread couldn't decode it; try the next decoder
        errors.append(f'librosa: {e}')

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
    except ImportError:
        pass
    except Exception as e:  # noqa: BLE001
        errors.append(f'soundfile: {e}')

    try:
        return _load_ffmpeg(path, target_sr, mono)
    except Exception as e:  # noqa: BLE001
        errors.append(f'ffmpeg: {e}')
    raise RuntimeError(f'could not decode {path.name}: ' + '; '.join(errors))
