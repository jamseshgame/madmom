"""Tests for the grid → transient calibration in grid_support."""
from __future__ import annotations

from pathlib import Path

import numpy as np

from app.services.pipeline.grid_support import calibrate_beats, find_drum_stem, transient_offset_s


def _clicks(times, sr=22050, dur=20.0):
    y = np.zeros(int(sr * dur), dtype=np.float32)
    # Kick-like burst with a 3 ms attack ramp (a real drum is never a
    # zero-length click; the STFT straddles an ideal click a few ms early).
    n = int(0.03 * sr)
    k = np.arange(n)
    env = np.minimum(1.0, k / (0.003 * sr)) * np.exp(-k / (0.006 * sr))
    burst = (np.sin(2 * np.pi * 80 * k / sr) * env).astype(np.float32)
    for t in times:
        i = int(t * sr)
        y[i:i + n] += burst
    return y


def test_transient_offset_recovers_a_constant_early_grid():
    sr = 22050
    hits = 0.5 + np.arange(36) * 0.5
    y = _clicks(hits, sr)
    off, n = transient_offset_s(y, sr, hits - 0.027)
    assert n >= 32
    assert abs(off - 0.027) < 0.006
    off0, _ = transient_offset_s(y, sr, hits)
    assert abs(off0) < 0.006


def test_transient_offset_needs_enough_beats():
    sr = 22050
    hits = 0.5 + np.arange(10) * 0.5
    off, n = transient_offset_s(_clicks(hits, sr), sr, hits - 0.027)
    assert off == 0.0 and n < 32


def test_find_drum_stem_layouts(tmp_path):
    stems = tmp_path / 'stems'
    stems.mkdir()
    (stems / 'song.ogg').write_bytes(b'')
    assert find_drum_stem(stems / 'song.ogg') is None
    (stems / 'drums.ogg').write_bytes(b'')
    assert find_drum_stem(stems / 'song.ogg') == stems / 'drums.ogg'


def test_calibrate_beats_uses_drum_stem_and_manual_offset(tmp_path, monkeypatch):
    from app.services.pipeline import grid_support
    sr = 22050
    hits = 0.5 + np.arange(36) * 0.5
    y = _clicks(hits, sr)
    stems = tmp_path / 'stems'
    stems.mkdir()
    (stems / 'song.ogg').write_bytes(b'')
    (stems / 'drums.ogg').write_bytes(b'')
    monkeypatch.setattr('app.services.pipeline.audio_io.load_audio', lambda p, target_sr=22050, mono=True: (y, sr))
    beats, info = calibrate_beats(list(hits - 0.027), stems / 'song.ogg', {'beat_offset_ms': 5})
    assert info['calibration_source'] == 'drums.ogg'
    assert abs(info['transient_offset_ms'] - 27) < 6
    assert abs(beats[5] - (hits[5] + 0.005)) < 0.006
    beats_off, info_off = calibrate_beats(list(hits), stems / 'song.ogg', {'snap_to_transients': False})
    assert info_off['calibration_source'] is None and beats_off == [float(t) for t in hits]
