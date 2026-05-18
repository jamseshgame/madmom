"""librosa-onset engine on click track."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from app.services.pipeline.engines.onsets_librosa import run_librosa_onsets


def _noop(*a, **k):
    pass


@pytest.fixture
def four_clicks(tmp_path: Path) -> Path:
    sr = 22050
    n = sr * 4
    y = np.zeros(n, dtype=np.float32)
    for s in (0.5, 1.5, 2.5, 3.5):
        i = int(s * sr)
        y[i:i + 40] = 0.8
    p = tmp_path / 'clicks.wav'
    sf.write(p, y, sr)
    return p


def test_librosa_finds_four_onsets(four_clicks):
    out = run_librosa_onsets(four_clicks, upstream={}, params={}, on_progress=_noop)
    times = [o['time_s'] for o in out['onsets']]
    assert 3 <= len(times) <= 6
