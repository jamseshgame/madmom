"""Unit tests for the multi-beatmap variant of merge_beatmap_charts.

Each test writes one or more minimal CH chart files into a tmp dir,
calls merge_beatmap_charts with the (chart_path, stem, meta) tuples,
and asserts on the merged output's section names + [Beatmaps] block.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.services.chart_generator import merge_beatmap_charts


def _write_chart(path: Path, *, expert='N 0 0', hard='N 1 0', medium='N 2 0', easy='N 3 0',
                 song_name='Test', resolution=192) -> None:
    """Write a minimal CH chart with all four difficulty sections present.

    Pass None for a difficulty to omit that section.
    """
    parts = [
        f'[Song]\n{{\n  Name = "{song_name}"\n  Resolution = {resolution}\n  Offset = 0\n}}\n',
        '[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n',
        '[Events]\n{\n  0 = E "section intro"\n}\n',
    ]
    for diff, body in (('Expert', expert), ('Hard', hard), ('Medium', medium), ('Easy', easy)):
        if body is None:
            continue
        parts.append(f'[{diff}Single]\n{{\n  0 = {body}\n}}\n')
    path.write_text(''.join(parts), encoding='utf-8')


def _section_names(chart_text: str) -> list[str]:
    """Return [Section] headers in file order."""
    return re.findall(r'\[([^\]]+)\]', chart_text)


def _beatmaps_rows(chart_text: str) -> list[str]:
    """Return the body lines of the [Beatmaps] block in file order, stripped."""
    m = re.search(r'\[Beatmaps\]\s*\{\n([^}]*)\n\}', chart_text)
    if not m:
        return []
    return [ln.strip() for ln in m.group(1).split('\n') if ln.strip()]


def _meta(preset: str, beatmap_id: str, is_active: bool) -> dict:
    return {'preset': preset, 'beatmap_id': beatmap_id, 'is_active': is_active}


def test_single_beatmap_single_stem(tmp_path: Path):
    in_chart = tmp_path / 'guitar1.chart'
    _write_chart(in_chart)
    out = tmp_path / 'merged.chart'

    result = merge_beatmap_charts(
        [(str(in_chart), 'guitar', _meta('v1', 'bm-1', True))],
        str(out),
    )

    assert result['included'] == ['guitar']
    assert result['skipped'] == []
    text = out.read_text(encoding='utf-8')
    names = _section_names(text)
    # Header blocks first, then four guitar difficulty sections — no numbered alternates.
    assert names == ['Song', 'SyncTrack', 'Events', 'Beatmaps',
                     'ExpertSingle', 'HardSingle', 'MediumSingle', 'EasySingle']
    rows = _beatmaps_rows(text)
    assert rows == [
        'ExpertSingle = preset="v1" name="active" beatmap_id="bm-1"',
        'HardSingle = preset="v1" name="active" beatmap_id="bm-1"',
        'MediumSingle = preset="v1" name="active" beatmap_id="bm-1"',
        'EasySingle = preset="v1" name="active" beatmap_id="bm-1"',
    ]


def test_three_beatmaps_one_stem_alphabetical_order(tmp_path: Path):
    """Caller passes them primary-first (caller's job to order). The merger just
    numbers in input order and emits matching [Beatmaps] rows."""
    c1 = tmp_path / 'g_v1.chart'; _write_chart(c1)
    c2 = tmp_path / 'g_v2.chart'; _write_chart(c2)
    c3 = tmp_path / 'g_v3.chart'; _write_chart(c3)
    out = tmp_path / 'merged.chart'

    result = merge_beatmap_charts(
        [
            (str(c1), 'guitar', _meta('v1', 'bm-1', True)),     # primary
            (str(c2), 'guitar', _meta('v2', 'bm-2', False)),    # alt n=2
            (str(c3), 'guitar', _meta('v3', 'bm-3', False)),    # alt n=3
        ],
        str(out),
    )

    assert result['included'] == ['guitar', 'guitar', 'guitar']
    text = out.read_text(encoding='utf-8')
    names = _section_names(text)
    # Note-track sections grouped by (stem-suffix, n, difficulty).
    assert names == ['Song', 'SyncTrack', 'Events', 'Beatmaps',
                     'ExpertSingle', 'HardSingle', 'MediumSingle', 'EasySingle',
                     'ExpertSingle2', 'HardSingle2', 'MediumSingle2', 'EasySingle2',
                     'ExpertSingle3', 'HardSingle3', 'MediumSingle3', 'EasySingle3']
    rows = _beatmaps_rows(text)
    # Spot-check a few:
    assert rows[0] == 'ExpertSingle = preset="v1" name="active" beatmap_id="bm-1"'
    assert rows[4] == 'ExpertSingle2 = preset="v2" name="alt" beatmap_id="bm-2"'
    assert rows[8] == 'ExpertSingle3 = preset="v3" name="alt" beatmap_id="bm-3"'
    assert len(rows) == 12  # 4 diffs × 3 beatmaps


def test_two_stems_grouped_by_stem_then_n(tmp_path: Path):
    g1 = tmp_path / 'g1.chart'; _write_chart(g1)
    g2 = tmp_path / 'g2.chart'; _write_chart(g2)
    d1 = tmp_path / 'd1.chart'; _write_chart(d1)
    d2 = tmp_path / 'd2.chart'; _write_chart(d2)
    out = tmp_path / 'merged.chart'

    merge_beatmap_charts(
        [
            (str(g1), 'guitar', _meta('v1', 'g-1', True)),
            (str(g2), 'guitar', _meta('v2', 'g-2', False)),
            (str(d1), 'drums', _meta('drums-v1', 'd-1', True)),
            (str(d2), 'drums', _meta('v1', 'd-2', False)),
        ],
        str(out),
    )

    names = _section_names(out.read_text(encoding='utf-8'))
    # Header first, then guitar block (n=1, n=2), then drums block (n=1, n=2).
    assert names == ['Song', 'SyncTrack', 'Events', 'Beatmaps',
                     'ExpertSingle', 'HardSingle', 'MediumSingle', 'EasySingle',
                     'ExpertSingle2', 'HardSingle2', 'MediumSingle2', 'EasySingle2',
                     'ExpertDrums', 'HardDrums', 'MediumDrums', 'EasyDrums',
                     'ExpertDrums2', 'HardDrums2', 'MediumDrums2', 'EasyDrums2']


def test_missing_difficulty_does_not_shift_other_diffs(tmp_path: Path):
    """A beatmap missing one difficulty leaves that section absent — other
    difficulties for the same beatmap still land at the same N. The next
    beatmap's four diffs cleanly land at N+1."""
    c1 = tmp_path / 'c1.chart'; _write_chart(c1)                  # all 4 diffs
    c2 = tmp_path / 'c2.chart'; _write_chart(c2, medium=None)     # no Medium
    c3 = tmp_path / 'c3.chart'; _write_chart(c3)                  # all 4 diffs
    out = tmp_path / 'merged.chart'

    merge_beatmap_charts(
        [
            (str(c1), 'guitar', _meta('a', 'bm-1', True)),
            (str(c2), 'guitar', _meta('b', 'bm-2', False)),
            (str(c3), 'guitar', _meta('c', 'bm-3', False)),
        ],
        str(out),
    )

    text = out.read_text(encoding='utf-8')
    names = _section_names(text)
    # Beatmap 2 (no Medium) has Expert/Hard/Easy at n=2; MediumSingle2 absent.
    # Beatmap 3 fills n=3 cleanly across all four diffs.
    expected_note_sections = [
        'ExpertSingle', 'HardSingle', 'MediumSingle', 'EasySingle',     # bm 1
        'ExpertSingle2', 'HardSingle2', 'EasySingle2',                  # bm 2 (no Medium)
        'ExpertSingle3', 'HardSingle3', 'MediumSingle3', 'EasySingle3', # bm 3
    ]
    note_sections = [n for n in names if n not in {'Song', 'SyncTrack', 'Events', 'Beatmaps'}]
    assert note_sections == expected_note_sections
    rows = _beatmaps_rows(text)
    assert 'MediumSingle2' not in '\n'.join(rows)  # no row for the missing section
    # bm 3's Medium does exist:
    assert any(r.startswith('MediumSingle3 = ') for r in rows)


def test_all_missing_difficulties_does_not_burn_n_slot(tmp_path: Path):
    """A beatmap with zero difficulty sections is skipped entirely — the next
    beatmap reuses what would have been its N."""
    c1 = tmp_path / 'c1.chart'; _write_chart(c1)
    # Chart with header blocks only — no difficulty sections.
    c2 = tmp_path / 'c2.chart'
    c2.write_text(
        '[Song]\n{\n  Name = "Test"\n  Resolution = 192\n  Offset = 0\n}\n'
        '[SyncTrack]\n{\n  0 = B 120000\n}\n'
        '[Events]\n{\n}\n',
        encoding='utf-8',
    )
    c3 = tmp_path / 'c3.chart'; _write_chart(c3)
    out = tmp_path / 'merged.chart'

    result = merge_beatmap_charts(
        [
            (str(c1), 'guitar', _meta('a', 'bm-1', True)),
            (str(c2), 'guitar', _meta('b', 'bm-2', False)),
            (str(c3), 'guitar', _meta('c', 'bm-3', False)),
        ],
        str(out),
    )

    # bm-2 contributed nothing — counted as skipped, didn't burn N=2.
    assert result['skipped'] == ['guitar']
    note_sections = [
        n for n in _section_names(out.read_text(encoding='utf-8'))
        if n not in {'Song', 'SyncTrack', 'Events', 'Beatmaps'}
    ]
    assert note_sections == [
        'ExpertSingle', 'HardSingle', 'MediumSingle', 'EasySingle',     # bm 1 (n=1)
        'ExpertSingle2', 'HardSingle2', 'MediumSingle2', 'EasySingle2', # bm 3 (n=2, not n=3)
    ]


def test_beatmaps_block_escapes_quote_and_newline(tmp_path: Path):
    """Preset names containing " or \\n must be escaped/collapsed so the
    line-oriented [Beatmaps] row format doesn't get corrupted."""
    c1 = tmp_path / 'c1.chart'; _write_chart(c1)
    out = tmp_path / 'merged.chart'

    merge_beatmap_charts(
        [(str(c1), 'guitar', _meta('has "quote" and\nnewline', 'bm-1', True))],
        str(out),
    )

    rows = _beatmaps_rows(out.read_text(encoding='utf-8'))
    # Quote escaped to \" and newline collapsed to a space.
    assert rows[0] == 'ExpertSingle = preset="has \\"quote\\" and newline" name="active" beatmap_id="bm-1"'


def test_empty_input_returns_empty_result(tmp_path: Path):
    out = tmp_path / 'merged.chart'
    result = merge_beatmap_charts([], str(out))
    assert result == {'included': [], 'skipped': []}
    # No file written.
    assert not out.exists()


def test_unknown_stem_is_skipped(tmp_path: Path):
    c1 = tmp_path / 'c1.chart'; _write_chart(c1)
    out = tmp_path / 'merged.chart'

    result = merge_beatmap_charts(
        [(str(c1), 'other', _meta('v1', 'bm-1', True))],
        str(out),
    )

    # 'other' has no STEM_TO_SECTION_SUFFIX entry — skipped entirely; no file written.
    assert result['included'] == []
    assert result['skipped'] == ['other']
