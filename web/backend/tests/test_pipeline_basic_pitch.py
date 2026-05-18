"""basic-pitch S2 + S3 engine tests on a synthetic pure-tone clip."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf


pytest.importorskip('basic_pitch')

from app.services.pipeline.engines.onsets_basic_pitch import run_basic_pitch_onsets
from app.services.pipeline.engines.pitches_basic_pitch import run_basic_pitch_pitches


def _noop(step, pct, msg):
    pass


@pytest.fixture
def a4_pulses(tmp_path: Path) -> Path:
    """Three 440 Hz tone bursts at 0.5s, 1.5s, 2.5s."""
    sr = 22050
    duration_s = 4
    n = sr * duration_s
    y = np.zeros(n, dtype=np.float32)
    t = np.linspace(0, 0.2, int(sr * 0.2), endpoint=False)
    pulse = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    for start_s in (0.5, 1.5, 2.5):
        i = int(start_s * sr)
        y[i:i + len(pulse)] += pulse
    p = tmp_path / 'a4.wav'
    sf.write(p, y, sr)
    return p


def test_s2_finds_three_onsets(a4_pulses):
    out = run_basic_pitch_onsets(a4_pulses, upstream={}, params={}, on_progress=_noop)
    times = [o['time_s'] for o in out['onsets']]
    assert 2 <= len(times) <= 5
    for expected in (0.5, 1.5, 2.5):
        assert any(abs(t - expected) < 0.1 for t in times), \
            f'expected an onset near {expected}, got {times}'


def test_s3_recovers_a4(a4_pulses):
    s2 = run_basic_pitch_onsets(a4_pulses, upstream={}, params={}, on_progress=_noop)
    s3 = run_basic_pitch_pitches(
        a4_pulses, upstream={'onsets': s2}, params={}, on_progress=_noop,
    )
    midis = [e['dominant_midi'] for e in s3['per_onset'] if e['dominant_midi'] is not None]
    assert any(abs(m - 69) <= 2 for m in midis), f'expected an A4 (MIDI 69), got {midis}'
