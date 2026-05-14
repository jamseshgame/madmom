"""Tests for the audio-peaks helper used by the WaveformStrip endpoint."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import scipy.io.wavfile as wav

from app.services.audio import compute_audio_peaks


def _write_wav(path: Path, samples: np.ndarray, sample_rate: int = 44100) -> None:
    """Write a mono int16 wav. Samples are float32 in [-1, 1]; we scale
    to int16 for a lossless round-trip through madmom's loader."""
    int16 = np.clip(samples, -1.0, 1.0)
    int16 = (int16 * 32767.0).astype(np.int16)
    wav.write(str(path), sample_rate, int16)


def test_silent_audio_peaks_are_zero(tmp_path):
    """1 s of literal silence → ~50 buckets at 20 ms each, all zero."""
    audio = tmp_path / 'silent.wav'
    _write_wav(audio, np.zeros(44100, dtype=np.float32))
    blob = compute_audio_peaks(audio, bucket_ms=20)
    peaks = np.frombuffer(blob, dtype=np.float32)
    assert 49 <= len(peaks) <= 51
    assert peaks.max() == 0.0


def test_peaks_track_amplitude(tmp_path):
    """A pure 1 kHz sine at peak amplitude 0.5 should produce per-bucket
    peaks at ~0.5. Lossless wav → peaks land within int16 quantization
    tolerance of the input level."""
    sr = 44100
    t = np.arange(sr) / sr
    sine = (0.5 * np.sin(2 * np.pi * 1000 * t)).astype(np.float32)
    audio = tmp_path / 'tone.wav'
    _write_wav(audio, sine, sample_rate=sr)
    blob = compute_audio_peaks(audio, bucket_ms=20)
    peaks = np.frombuffer(blob, dtype=np.float32)
    assert 49 <= len(peaks) <= 51
    # 1 kHz period (1 ms) << 20 ms bucket → every bucket contains many
    # full cycles, so peak per bucket = sine peak. Tolerance covers
    # int16 quantization (~3e-5 absolute error).
    assert 0.495 <= peaks.mean() <= 0.505
    assert 0.495 <= peaks.min() <= peaks.max() <= 0.505


def test_compute_raises_on_missing_file(tmp_path):
    with pytest.raises(Exception):
        compute_audio_peaks(tmp_path / 'does-not-exist.wav', bucket_ms=20)
