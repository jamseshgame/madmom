"""Audio loading via librosa. Replaces madmom.audio.signal.Signal."""
from __future__ import annotations

from pathlib import Path

import numpy as np


def load_audio(
    path: str | Path,
    target_sr: int | None = None,
    mono: bool = True,
) -> tuple[np.ndarray, int]:
    """Load audio file, optionally resampling and downmixing.

    Returns (samples float32 in [-1, 1], sample_rate).
    """
    import librosa

    y, sr = librosa.load(str(path), sr=target_sr, mono=mono)
    if y.dtype != np.float32:
        y = y.astype(np.float32, copy=False)
    return y, int(sr)
