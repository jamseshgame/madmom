"""Tests for the librosa-beat grid engine. Uses a synthetic click track."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from app.services.pipeline.engines.grid_librosa import run_librosa_grid
from app.services.pipeline.schemas.grid import SongGrid


def _noop(step, pct, msg):
    pass


@pytest.fixture
def click_120bpm(tmp_path: Path) -> Path:
    sr = 22050
    duration_s = 10
    n = sr * duration_s
    y = np.zeros(n, dtype=np.float32)
    spacing = int(sr / (120 / 60.0))
    click = np.ones(50, dtype=np.float32)
    for i in range(0, n - 50, spacing):
        y[i:i + 50] += click
    y = np.clip(y, -1, 1)
    p = tmp_path / 'click.wav'
    sf.write(p, y, sr)
    return p


def test_librosa_detects_120bpm(click_120bpm):
    payload = run_librosa_grid(
        audio_path=click_120bpm,
        upstream={},
        params={},
        on_progress=_noop,
    )
    g = SongGrid(**payload)
    assert 118_000 <= g.tempo_segments[0].micro_bpm <= 122_000
    assert g.audio_duration_s == pytest.approx(10.0, abs=0.1)


def test_librosa_produces_at_least_one_section(click_120bpm):
    payload = run_librosa_grid(
        audio_path=click_120bpm,
        upstream={},
        params={},
        on_progress=_noop,
    )
    assert len(payload['sections']) >= 1
