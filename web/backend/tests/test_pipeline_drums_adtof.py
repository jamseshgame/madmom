"""Tests for the `drum-adtof` onsets engine (model call monkeypatched)."""
from __future__ import annotations

from pathlib import Path

import pytest

from app.services.pipeline.engines import onsets_adtof
from app.services.pipeline.engines.drums_engines import run_drum_class, run_drum_gm_lanes


def _noop(*a, **k):
    pass


@pytest.fixture
def fake_model(monkeypatch):
    # ADTOF vocabulary: 35 kick, 38 snare, 47 tom, 42 hat, 49 cymbal/ride.
    hits = [(0.50, 35, 1.0), (0.50, 42, 1.0), (1.00, 38, 1.0), (1.00, 42, 1.0),
            (1.25, 42, 1.0), (1.50, 35, 1.0), (1.75, 47, 1.0), (2.00, 49, 1.0), (2.00, 35, 1.0),
            (2.00, 99, 1.0)]  # 99 = unmapped pitch, must be ignored
    monkeypatch.setattr(onsets_adtof, 'transcribe_with_adtof', lambda path, params: hits)
    monkeypatch.setattr(onsets_adtof, 'ADTOF_AVAILABLE', True)


def test_adtof_engine_emits_bandsplit_shape(fake_model):
    out = onsets_adtof.run_drum_adtof(Path('drums.ogg'), {}, {}, _noop)
    assert out['engine'] == 'drum-adtof'
    times = [o['time_s'] for o in out['onsets']]
    assert times == pytest.approx([0.5, 1.0, 1.25, 1.5, 1.75, 2.0])
    assert all(b > a for a, b in zip(times, times[1:]))
    dc = out['drum_classes']
    assert [h['time_s'] for h in dc['kick']] == [0.5, 1.5, 2.0]
    assert [h['time_s'] for h in dc['hihat']] == [0.5, 1.0, 1.25]
    assert [h['time_s'] for h in dc['tom']] == [1.75] and [h['time_s'] for h in dc['cymbal']] == [2.0]
    assert out['onset_classes'][0] == {'kick': 1.0, 'hihat': 1.0}


def test_adtof_feeds_the_rest_of_the_drum_column(fake_model):
    onsets = onsets_adtof.run_drum_adtof(Path('drums.ogg'), {}, {}, _noop)
    pitches = run_drum_class(None, {'onsets': onsets}, {}, _noop)
    assert pitches['per_onset'][0]['all_pitches_midi'] == [36, 42]
    quant = {'events': [{'tick': i * 96, 'metric_weight': 3, 'dropped': False,
                         'all_pitches_midi': po['all_pitches_midi'], 'polyphony': po['polyphony']}
                        for i, po in enumerate(pitches['per_onset'])]}
    lanes = run_drum_gm_lanes(None, {'quantized': quant}, {}, _noop)['lanes']
    assert [(e['tick'], e['frets'][0]) for e in lanes][:3] == [(0, 0), (0, 2), (96, 1)]


def test_adtof_engine_reports_missing_package(monkeypatch):
    monkeypatch.setattr(onsets_adtof, 'ADTOF_AVAILABLE', False)
    with pytest.raises(RuntimeError, match='adtof-pytorch'):
        onsets_adtof.run_drum_adtof(Path('drums.ogg'), {}, {}, _noop)


def test_adtof_engine_is_registered():
    from app.services.pipeline.registry import engines_catalog
    ids = [e['engine_id'] for e in engines_catalog()['onsets']]
    assert 'drum-adtof' in ids and 'drum-bandsplit' in ids
