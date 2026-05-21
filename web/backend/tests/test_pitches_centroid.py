"""Unit tests for the centroid pitch engine.

The engine wraps the legacy chart_generator's spectral-centroid helpers
to produce per-onset fake-MIDI values. Tests use synthesized audio
(low-frequency sine vs high-frequency noise) to confirm the engine
spreads its output across the configured MIDI range monotonically with
centroid frequency.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from app.services.pipeline.engines.pitches_centroid import run_centroid


@pytest.fixture
def tmp_audio(tmp_path: Path):
    """Factory: write a numpy mono signal to a .wav and return its path."""
    def _make(signal: np.ndarray, sr: int = 44100) -> Path:
        out = tmp_path / 'test.wav'
        sf.write(str(out), signal, sr)
        return out
    return _make


def _onsets_payload(times_s: list[float]) -> dict:
    return {'onsets': [{'time_s': float(t)} for t in times_s]}


def _silence(seconds: float, sr: int = 44100) -> np.ndarray:
    return np.zeros(int(seconds * sr), dtype=np.float32)


def _sine_pulses(freqs_hz: list[float], pulse_ms: int = 100, gap_ms: int = 400, sr: int = 44100) -> np.ndarray:
    """One sine burst at each frequency, separated by silence. Returns the
    concatenated mono signal."""
    parts = []
    pulse_n = int(pulse_ms / 1000 * sr)
    gap_n = int(gap_ms / 1000 * sr)
    t = np.arange(pulse_n) / sr
    env = np.hanning(pulse_n).astype(np.float32)
    for f in freqs_hz:
        pulse = (0.5 * np.sin(2 * np.pi * f * t) * env).astype(np.float32)
        parts.append(pulse)
        parts.append(np.zeros(gap_n, dtype=np.float32))
    return np.concatenate(parts)


def _pulse_onset_times(num: int, pulse_ms: int = 100, gap_ms: int = 400) -> list[float]:
    """Onset start times for _sine_pulses output — one onset per pulse start."""
    step_s = (pulse_ms + gap_ms) / 1000.0
    return [i * step_s + 0.005 for i in range(num)]  # +5 ms inside the pulse


def test_empty_onsets_returns_empty_per_onset(tmp_audio):
    path = tmp_audio(_silence(1.0))
    out = run_centroid(path, {'onsets': _onsets_payload([])['onsets']}, {}, lambda *a: None)
    assert out['engine'] == 'centroid'
    assert out['per_onset'] == []


def test_silent_audio_yields_none_midi(tmp_audio):
    path = tmp_audio(_silence(2.0))
    payload = _onsets_payload([0.1, 0.5, 1.0])
    out = run_centroid(path, payload, {}, lambda *a: None)
    assert len(out['per_onset']) == 3
    for entry in out['per_onset']:
        assert entry['dominant_midi'] is None
        assert entry['polyphony'] == 1


def test_low_frequency_pulses_yield_low_midi(tmp_audio):
    # 100 Hz pulses — should map to the low end of the configured MIDI range
    signal = _sine_pulses([100.0, 100.0, 100.0])
    path = tmp_audio(signal)
    payload = _onsets_payload(_pulse_onset_times(3))
    out = run_centroid(path, payload, {}, lambda *a: None)
    midis = [e['dominant_midi'] for e in out['per_onset'] if e['dominant_midi'] is not None]
    assert len(midis) >= 2, f'expected >=2 non-None midis, got {midis}'
    # Default range maps centroid 100 Hz -> fake-MIDI near 40 (bottom)
    assert max(midis) <= 55, f'low-freq pulses should map to low MIDI; got {midis}'


def test_high_frequency_pulses_yield_high_midi(tmp_audio):
    # 6 kHz pulses — should map to the high end of the configured MIDI range
    signal = _sine_pulses([6000.0, 6000.0, 6000.0])
    path = tmp_audio(signal)
    payload = _onsets_payload(_pulse_onset_times(3))
    out = run_centroid(path, payload, {}, lambda *a: None)
    midis = [e['dominant_midi'] for e in out['per_onset'] if e['dominant_midi'] is not None]
    assert len(midis) >= 2, f'expected >=2 non-None midis, got {midis}'
    assert min(midis) >= 70, f'high-freq pulses should map to high MIDI; got {midis}'


def test_mixed_frequencies_spread_across_midi_range(tmp_audio):
    # 100 Hz then 6 kHz pulses — low should map low, high should map high
    signal = _sine_pulses([100.0, 6000.0, 100.0, 6000.0])
    path = tmp_audio(signal)
    payload = _onsets_payload(_pulse_onset_times(4))
    out = run_centroid(path, payload, {}, lambda *a: None)
    midis = [e['dominant_midi'] for e in out['per_onset']]
    valid = [m for m in midis if m is not None]
    assert len(valid) >= 3
    assert max(valid) - min(valid) >= 15, f'mixed freqs should span >=15 MIDI; got {midis}'


def test_per_onset_schema_matches_yin(tmp_audio):
    """Every entry must carry the same five keys other PITCHES engines emit."""
    signal = _sine_pulses([440.0, 440.0])
    path = tmp_audio(signal)
    payload = _onsets_payload(_pulse_onset_times(2))
    out = run_centroid(path, payload, {}, lambda *a: None)
    for entry in out['per_onset']:
        assert set(entry.keys()) == {
            'time_s', 'dominant_midi', 'dominant_confidence', 'polyphony', 'all_pitches_midi',
        }
        assert entry['polyphony'] == 1


def test_audio_path_none_raises(tmp_audio):
    with pytest.raises(ValueError, match='centroid requires a stem audio file'):
        run_centroid(None, _onsets_payload([0.1]), {}, lambda *a: None)


def test_engine_registers_for_pitches_stage():
    """Importing the engine module side-registers it for the PITCHES stage."""
    from app.services.pipeline.registry import Stage, get_engine
    from app.services.pipeline.engines import pitches_centroid  # noqa: F401
    spec = get_engine(Stage.PITCHES, 'centroid')
    assert spec is not None
    assert spec.id == 'centroid'
    assert spec.display_name == 'Spectral centroid (drum-friendly)'
    assert 'min_centroid_hz' in spec.params_schema
    assert 'max_centroid_hz' in spec.params_schema
    assert 'window_ms' in spec.params_schema
