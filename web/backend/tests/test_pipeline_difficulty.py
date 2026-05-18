"""S7 difficulty reduction tests."""
from __future__ import annotations

import pytest

from app.services.pipeline.engines.difficulty_engines import (
    run_metric_weight, run_density_target, run_none,
)


def _noop(*a, **k): pass


def _lanes_with_weights(items):
    """items: list of (tick, fret, metric_weight)."""
    return {'lanes': [
        {'tick': t, 'frets': [f], 'sustain': 0, 'section': 'song'}
        for t, f, _ in items
    ], 'metric_weights': {str(t): w for t, _f, w in items}}


def test_metric_weight_easy_keeps_only_downbeats():
    inp = _lanes_with_weights([
        (0, 0, 4),
        (96, 1, 1),
        (192, 2, 3),
        (288, 3, 1),
        (384, 4, 3),
        (768, 2, 4),
    ])
    out = run_metric_weight(
        audio_path=None,
        upstream={'lanes_filtered': inp},
        params={'easy': {'min_weight': 4}, 'medium': {'min_weight': 3},
                'hard': {'min_weight': 2}},
        on_progress=_noop,
    )
    easy_ticks = [l['tick'] for l in out['by_difficulty']['easy']['lanes']]
    medium_ticks = [l['tick'] for l in out['by_difficulty']['medium']['lanes']]
    hard_ticks = [l['tick'] for l in out['by_difficulty']['hard']['lanes']]
    assert easy_ticks == [0, 768]
    assert medium_ticks == [0, 192, 384, 768]
    assert hard_ticks == [0, 192, 384, 768]


def test_metric_weight_demotes_chord_to_single():
    inp = {
        'lanes': [{'tick': 0, 'frets': [0, 1], 'sustain': 0}],
        'metric_weights': {'0': 4},
    }
    out = run_metric_weight(
        audio_path=None,
        upstream={'lanes_filtered': inp},
        params={'easy': {'min_weight': 4, 'demote_chord_size': 1}},
        on_progress=_noop,
    )
    assert out['by_difficulty']['easy']['lanes'][0]['frets'] == [0]
