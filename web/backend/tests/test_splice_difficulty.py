"""Unit tests for the pure chart-splice helpers used by the cross-chart
difficulty clone. No filesystem or audio — just chart text in/out.
"""
from __future__ import annotations

import pytest

from app.services.chart_generator import chart_difficulties, splice_difficulty


def _chart(*, resolution=192, expert='  0 = N 0 0\n  192 = N 1 0',
           hard=None, song='Test') -> str:
    parts = [
        f'[Song]\n{{\n  Name = "{song}"\n  Resolution = {resolution}\n  Offset = 0\n}}\n',
        '[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n',
        '[Events]\n{\n  0 = E "section intro"\n}\n',
    ]
    parts.append(f'[ExpertSingle]\n{{\n{expert}\n}}\n')
    if hard is not None:
        parts.append(f'[HardSingle]\n{{\n{hard}\n}}\n')
    return ''.join(parts)


def test_splice_same_resolution_copies_block_verbatim():
    src = _chart(expert='  0 = N 0 0\n  192 = N 1 0')
    tgt = _chart(expert='  0 = N 4 0', hard='  0 = N 2 0')
    new_text, overwrote = splice_difficulty(src, 'ExpertSingle', tgt, 'HardSingle')
    assert overwrote is True
    assert '[HardSingle]\n{\n  0 = N 0 0\n  192 = N 1 0\n}\n' in new_text
    assert '[ExpertSingle]\n{\n  0 = N 4 0\n}\n' in new_text


def test_splice_rescales_ticks_when_resolution_differs():
    src = _chart(resolution=192, expert='  0 = N 0 0\n  192 = N 1 0')
    tgt = _chart(resolution=480, expert='  0 = N 0 0')
    new_text, _ = splice_difficulty(src, 'ExpertSingle', tgt, 'HardSingle')
    assert '[HardSingle]\n{\n  0 = N 0 0\n  480 = N 1 0\n}\n' in new_text


def test_splice_inserts_when_target_slot_empty():
    src = _chart(expert='  0 = N 0 0')
    tgt = _chart(expert='  0 = N 4 0')
    new_text, overwrote = splice_difficulty(src, 'ExpertSingle', tgt, 'HardSingle')
    assert overwrote is False
    assert '[HardSingle]\n{\n  0 = N 0 0\n}\n' in new_text


def test_splice_missing_source_difficulty_raises():
    src = _chart(expert='  0 = N 0 0')
    tgt = _chart(expert='  0 = N 0 0')
    with pytest.raises(ValueError, match='HardSingle'):
        splice_difficulty(src, 'HardSingle', tgt, 'HardSingle')


def test_splice_remap_writes_under_target_name():
    src = _chart(expert='  0 = N 0 0')
    tgt = _chart(expert='  0 = N 4 0')
    new_text, _ = splice_difficulty(src, 'ExpertSingle', tgt, 'EasySingle')
    assert '[EasySingle]\n{\n  0 = N 0 0\n}\n' in new_text


def test_chart_difficulties_lists_present_sections_with_counts():
    txt = _chart(expert='  0 = N 0 0\n  192 = N 1 0', hard='  0 = N 2 0')
    diffs = chart_difficulties(txt)
    by_name = {d['name']: d['note_count'] for d in diffs}
    assert by_name == {'ExpertSingle': 2, 'HardSingle': 1}


def test_chart_difficulties_ignores_non_difficulty_sections():
    txt = _chart(expert='  0 = N 0 0')
    names = [d['name'] for d in chart_difficulties(txt)]
    assert names == ['ExpertSingle']
