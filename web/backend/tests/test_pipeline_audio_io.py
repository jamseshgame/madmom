"""Tests for the librosa-backed audio loader."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from app.services.pipeline.audio_io import load_audio


@pytest.fixture
def sine_wav(tmp_path: Path) -> Path:
    sr = 22050
    t = np.linspace(0, 1.0, sr, endpoint=False)
    y = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    p = tmp_path / 'sine.wav'
    sf.write(p, y, sr)
    return p


def test_load_returns_mono_float32(sine_wav):
    y, sr = load_audio(sine_wav, target_sr=22050, mono=True)
    assert y.dtype == np.float32
    assert y.ndim == 1
    assert sr == 22050
    assert abs(y.max() - 0.5) < 0.01


def test_load_resamples(sine_wav):
    y, sr = load_audio(sine_wav, target_sr=16000, mono=True)
    assert sr == 16000
    assert abs(len(y) - 16000) <= 1
