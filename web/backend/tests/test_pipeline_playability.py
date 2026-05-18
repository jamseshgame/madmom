"""Tests for S6 playability engines."""
from __future__ import annotations

import pytest

from app.services.pipeline.engines.playability_engines import (
    run_identity, run_spread_fretboard, run_avoid_cramps,
)


def _noop(*a, **k): pass


def _lanes(tick_fret_pairs):
    return {'lanes': [
        {'tick': t, 'frets': [f], 'sustain': 0, 'section': 'song'} for t, f in tick_fret_pairs
    ]}


def test_identity_passes_through_unchanged():
    inp = _lanes([(0, 2), (192, 2), (384, 2)])
    out = run_identity(audio_path=None, upstream={'lanes_expert': inp},
                       params={}, on_progress=_noop)
    assert out['lanes'] == inp['lanes']
    assert out['edits'] == []


def test_spread_displaces_long_runs():
    inp = _lanes([(0, 2), (96, 2), (192, 2), (288, 2), (384, 2)])
    out = run_spread_fretboard(audio_path=None, upstream={'lanes_expert': inp},
                               params={'max_same_fret_run': 4}, on_progress=_noop)
    frets = [l['frets'][0] for l in out['lanes']]
    assert frets[:4] == [2, 2, 2, 2]
    assert frets[4] != 2
    assert any(e['kind'] == 'displace' for e in out['edits'])


def test_avoid_cramps_demotes_big_jumps():
    inp = _lanes([(0, 0), (19, 4)])
    out = run_avoid_cramps(audio_path=None, upstream={'lanes_expert': inp},
                           params={'max_jump': 3, 'min_gap_ticks': 96},
                           on_progress=_noop)
    second = out['lanes'][1]['frets'][0]
    assert second <= 3


def test_chain_runs_engines_in_order():
    from app.services.pipeline.engines.playability_engines import run_chain
    inp = _lanes([(0, 2), (96, 2), (192, 2), (288, 2), (384, 2), (480, 0)])
    out = run_chain(
        audio_path=None,
        upstream={'lanes_expert': inp},
        params={'chain': ['spread-fretboard', 'avoid-cramps'],
                'spread-fretboard': {'max_same_fret_run': 4},
                'avoid-cramps': {'max_jump': 3, 'min_gap_ticks': 96}},
        on_progress=_noop,
    )
    assert any(e['reason'] == 'same_fret_run' for e in out['edits'])
