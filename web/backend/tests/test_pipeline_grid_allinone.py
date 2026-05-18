"""Tests for the all-in-one grid engine.

Skipped automatically if `allin1` is not importable (model download is
heavy; CI installs it on a dedicated runner via requirements-extras).
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf


allin1 = pytest.importorskip('allin1')

from app.services.pipeline.engines.grid_allinone import run_allinone_grid


def _noop(step, pct, msg):
    pass


@pytest.fixture
def click_120bpm(tmp_path: Path) -> Path:
    sr = 22050
    duration_s = 16
    n = sr * duration_s
    y = np.zeros(n, dtype=np.float32)
    spacing = int(sr * 0.5)
    click = np.ones(60, dtype=np.float32) * 0.8
    for i in range(0, n - 60, spacing):
        y[i:i + 60] += click
    y = np.clip(y, -1, 1)
    p = tmp_path / 'click.wav'
    sf.write(p, y, sr)
    return p


def test_allinone_detects_around_120bpm(click_120bpm):
    payload = run_allinone_grid(
        audio_path=click_120bpm,
        upstream={},
        params={'min_segment_beats': 8},
        on_progress=_noop,
    )
    assert 114_000 <= payload['tempo_segments'][0]['micro_bpm'] <= 126_000
    assert len(payload['downbeats']) >= 4
