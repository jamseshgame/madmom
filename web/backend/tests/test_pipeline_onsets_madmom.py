"""Tests for the madmom-onset engine wrapper (detector monkeypatched)."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from app.services.pipeline.engines import onsets_madmom


def _noop(*a, **k):
    pass


def test_madmom_onsets_emit_schema_shape(monkeypatch):
    monkeypatch.setattr(onsets_madmom, 'detect_onsets_madmom',
                        lambda path, model, thr, comb, smooth: (np.array([0.5, 0.52, 1.0, 1.5]), np.array([0.9, 0.6, 0.8, 1.2])))
    out = onsets_madmom.run_madmom_onsets(Path('guitar.ogg'), {}, {'min_gap_ms': 40}, _noop)
    times = [o['time_s'] for o in out['onsets']]
    assert times == [0.5, 1.0, 1.5]                       # 0.52 dropped by min_gap
    assert all(0.0 <= o['confidence'] <= 1.0 for o in out['onsets'])
    assert out['engine'] == 'madmom-onset'


def test_madmom_onsets_pass_params_to_detector(monkeypatch):
    seen = {}

    def fake(path, model, thr, comb, smooth):
        seen.update(model=model, thr=thr, comb=comb, smooth=smooth)
        return np.array([]), np.array([])
    monkeypatch.setattr(onsets_madmom, 'detect_onsets_madmom', fake)
    out = onsets_madmom.run_madmom_onsets(Path('x.ogg'), {}, {'model': 'rnn', 'threshold': 0.3, 'combine_ms': 80, 'smooth_ms': 10}, _noop)
    assert seen == {'model': 'rnn', 'thr': 0.3, 'comb': 0.08, 'smooth': 0.01}
    assert out['onsets'] == []


def test_madmom_onsets_requires_audio():
    with pytest.raises(ValueError):
        onsets_madmom.run_madmom_onsets(None, {}, {}, _noop)


def test_registered():
    from app.services.pipeline.registry import engines_catalog
    assert 'madmom-onset' in [e['engine_id'] for e in engines_catalog()['onsets']]
