# Multi-beatmap-per-instrument Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish every beatmap a track has per stem into the merged `notes_fixed_slides.chart`: active in the unnumbered section (e.g. `[ExpertDrums]`), alternates in numbered sections (`[ExpertDrums2]`, `[ExpertDrums3]`, …) with a new `[Beatmaps]` metadata block labelling each section by source preset.

**Architecture:** Backend-only change. Two units: (1) `merge_beatmap_charts` in `chart_generator.py` gains a per-stem numbering counter, emits a `[Beatmaps]` block, and accepts a 3-tuple `(chart_path, stem, meta)` per beatmap. (2) `publish_track_to_game` in `tracks.py` gathers all beatmaps per stem (not just one), orders them (primary first, alternates alphabetical by preset name), and passes the wider tuple shape downstream. A small pure helper `order_beatmaps_for_publish` is extracted to make the gather/order logic unit-testable in isolation.

**Tech Stack:** Python 3.9+, FastAPI, pytest. No new pip dependencies. No frontend changes.

**Spec:** `docs/superpowers/specs/2026-05-22-multi-beatmap-chart-design.md`

---

## File Map

| Path | Action | Purpose |
|---|---|---|
| `web/backend/app/services/chart_generator.py` | Modify | Extend `merge_beatmap_charts` signature; add per-stem numbering counter; emit `[Beatmaps]` block; add `_esc` helper; sort note-track sections by (stem, n, difficulty) |
| `web/backend/tests/test_chart_merge_multi_beatmap.py` | Create | Unit tests for the new merger behavior — covers single beatmap, multiple beatmaps, missing difficulties, ordering, escaping |
| `web/backend/app/routers/tracks.py` | Modify | Extract `order_beatmaps_for_publish` helper; rewrite the per-stem selection block in `publish_track_to_game` to gather all beatmaps per stem and build meta dicts |
| `web/backend/tests/test_order_beatmaps_for_publish.py` | Create | Unit tests for the gather/order helper — covers override, active-flag, alphabetical sort, no beatmaps |

---

## Task 1: Merger changes + TDD tests

**Files:**
- Modify: `web/backend/app/services/chart_generator.py` (extend `merge_beatmap_charts`, add `_esc`)
- Create: `web/backend/tests/test_chart_merge_multi_beatmap.py`

- [ ] **Step 1: Write the failing tests first**

Create `web/backend/tests/test_chart_merge_multi_beatmap.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

```
cd web/backend && venv/Scripts/python.exe -m pytest tests/test_chart_merge_multi_beatmap.py -v 2>&1 | tail -30
```

Expected: most tests fail. The first one (`test_single_beatmap_single_stem`) will fail because the existing merger:
- Doesn't accept the 3-tuple `(path, stem, meta)` — currently accepts 2-tuple `(path, stem)`
- Doesn't emit `[Beatmaps]`
- Doesn't have the new ordering

Some tests may error rather than fail (TypeError on unpacking the wrong tuple shape).

- [ ] **Step 3: Modify `merge_beatmap_charts` in `web/backend/app/services/chart_generator.py`**

Find the existing function (around line 87-156). Replace the entire function with:

```python
def _esc(s: str) -> str:
    """Escape a string for use inside a [Beatmaps] row's double-quoted value.

    Strips newlines (which would corrupt the line-oriented row format) and
    escapes embedded double quotes."""
    return s.replace('\r', '').replace('\n', ' ').replace('"', '\\"')


def merge_beatmap_charts(
    chart_paths_with_meta: list[tuple[str, str, dict]],
    output_path: str,
) -> dict:
    """Merge per-stem beatmap charts into a single notes_fixed_slides.chart.

    Each input tuple is (chart_path, stem, meta) where meta is
    {'preset': str, 'beatmap_id': str, 'is_active': bool}. The caller is
    responsible for ordering — primary-first per stem, then alternates in
    whatever order they want exposed in the chart (the merger emits in
    input order within each stem).

    Sections from each beatmap are renamed by stem-suffix
    (drums → ExpertDrums/HardDrums/..., guitar → ExpertSingle/HardSingle/...).
    The first beatmap per stem gets unnumbered names; subsequent beatmaps
    for the same stem get numeric suffixes ([ExpertDrums2], [ExpertDrums3]).
    All four difficulties for a single beatmap share the same N — if a
    beatmap is missing one difficulty, that specific section is simply
    absent (other difficulties for the same beatmap still align at the
    beatmap's N).

    A [Beatmaps] metadata block lists every emitted section with its source
    preset, active/alt tag, and beatmap_id. Clone Hero ignores unknown
    sections; the published chart is still CH-playable using the unnumbered
    (active) sections.

    Returns {'included': [stems...], 'skipped': [stems...]}. A stem may
    appear in 'included' multiple times if multiple beatmaps for it
    contributed sections; 'skipped' contains stems whose chart had no
    sections OR whose stem name has no STEM_TO_SECTION_SUFFIX entry.
    """
    song_block: str | None = None
    sync_block: str | None = None
    events_block: str | None = None
    sections_out: list[tuple[str, str, str, int]] = []  # (section_name, content, suffix, n)
    beatmaps_rows: list[str] = []
    included: list[str] = []
    skipped: list[str] = []

    # Per-stem counter — advances only when the beatmap actually contributed
    # one or more sections (so a beatmap with zero usable difficulties
    # doesn't burn the next N slot).
    beatmap_index_per_stem: dict[str, int] = {}

    for chart_path, stem, meta in chart_paths_with_meta:
        suffix = STEM_TO_SECTION_SUFFIX.get(stem)
        if suffix is None:
            skipped.append(stem)
            continue
        try:
            with open(chart_path, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read()
        except OSError:
            skipped.append(stem)
            continue

        # Capture the first chart's header blocks — those become the merged
        # chart's [Song]/[SyncTrack]/[Events] (all beatmaps for a track
        # share the same tempo grid via the V2 pipeline).
        if song_block is None:
            sm = re.search(r'\[Song\]\s*\{([^}]*)\}', content)
            tk = re.search(r'\[SyncTrack\]\s*\{([^}]*)\}', content)
            ev = re.search(r'\[Events\]\s*\{([^}]*)\}', content)
            if sm:
                song_block = sm.group(1)
            if tk:
                sync_block = tk.group(1)
            if ev:
                events_block = ev.group(1)

        candidate_n = beatmap_index_per_stem.get(stem, 0) + 1
        any_section = False
        preset = _esc(meta.get('preset', '') or '')
        bid = _esc(meta.get('beatmap_id', '') or '')
        name_tag = 'active' if meta.get('is_active') else 'alt'

        for difficulty in ('Expert', 'Hard', 'Medium', 'Easy'):
            m = re.search(
                r'\[' + difficulty + r'Single\]\s*\{([^}]*)\}',
                content,
            )
            if not m:
                continue
            section_name = (
                f'{difficulty}{suffix}' if candidate_n == 1
                else f'{difficulty}{suffix}{candidate_n}'
            )
            sections_out.append((section_name, m.group(1), suffix, candidate_n))
            beatmaps_rows.append(
                f'  {section_name} = preset="{preset}" name="{name_tag}" beatmap_id="{bid}"'
            )
            any_section = True

        if any_section:
            beatmap_index_per_stem[stem] = candidate_n
            included.append(stem)
        else:
            skipped.append(stem)

    if not sections_out or song_block is None or sync_block is None:
        return {'included': included, 'skipped': skipped or [s for _, s, _ in chart_paths_with_meta]}

    # Difficulty order inside one beatmap: Expert → Hard → Medium → Easy.
    diff_order = {'Expert': 0, 'Hard': 1, 'Medium': 2, 'Easy': 3}
    # Stem-suffix order: emit in the order suffixes first appeared (stable).
    suffix_first_seen: dict[str, int] = {}
    for _, _, suf, _ in sections_out:
        suffix_first_seen.setdefault(suf, len(suffix_first_seen))

    def _section_sort_key(item):
        section_name, _content, suffix, n = item
        # Difficulty prefix sits before the suffix; pull it back out.
        diff = section_name[: section_name.index(suffix)]
        return (suffix_first_seen[suffix], n, diff_order.get(diff, 99))

    sections_sorted = sorted(sections_out, key=_section_sort_key)

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(f'[Song]\n{{{song_block}}}\n')
        f.write(f'[SyncTrack]\n{{{sync_block}}}\n')
        f.write(f'[Events]\n{{{events_block or ""}}}\n')
        if beatmaps_rows:
            body = '\n'.join(beatmaps_rows)
            f.write(f'[Beatmaps]\n{{\n{body}\n}}\n')
        for section_name, content, _suffix, _n in sections_sorted:
            f.write(f'[{section_name}]\n{{{content}}}\n')
    return {'included': included, 'skipped': skipped}
```

Note: the function is replacing the existing one (signature changes from 2-tuple to 3-tuple). The only caller (`tracks.py:1232`) is updated in Task 2.

- [ ] **Step 4: Run tests to verify they pass**

```
cd web/backend && venv/Scripts/python.exe -m pytest tests/test_chart_merge_multi_beatmap.py -v 2>&1 | tail -30
```

Expected: 8 passing.

If `test_empty_input_returns_empty_result` fails because the function writes an empty file rather than returning early, double-check the `if not sections_out or song_block is None or sync_block is None:` guard. The intended behavior on empty input is to return `{'included': [], 'skipped': []}` without writing.

If `test_unknown_stem_is_skipped` shows `skipped: ['other']` but ALSO writes an empty chart, check the early-return path on `not sections_out` — when only unknown stems are passed, sections_out is empty and we should skip the write.

- [ ] **Step 5: Confirm broader regression**

The merger is also touched by no other tests, but the publish flow does call it indirectly. Run any test files that might exercise the publish path:

```
cd web/backend && venv/Scripts/python.exe -m pytest tests/test_publish_imported_sources.py -v 2>&1 | tail -10
```

If this fails because the publish endpoint is using the OLD signature (`(chart_path, stem)`), that's expected — Task 2 fixes the call site. Note the failure mode and proceed; don't fix it in Task 1.

If you can't tell whether the failure is from the signature change vs. another regression, read the failing test trace and confirm the error is `TypeError: not enough values to unpack` or similar at the call site.

- [ ] **Step 6: Commit**

```bash
git add web/backend/app/services/chart_generator.py \
        web/backend/tests/test_chart_merge_multi_beatmap.py
git commit -m "feat(chart): merge_beatmap_charts supports multiple beatmaps per stem

New signature: list[tuple[chart_path, stem, meta]] where meta is
{preset, beatmap_id, is_active}. Per-stem counter assigns N to each
beatmap; the first beatmap per stem keeps unnumbered sections, the rest
get [ExpertDrums2], [ExpertDrums3], etc. A new [Beatmaps] header block
labels every emitted section with its preset/active-flag/beatmap_id so
the Jamsesh game can present alternates as picker options. Clone Hero
ignores unknown sections — the chart stays CH-playable.

Single caller (publish_track_to_game in tracks.py) is updated in the
follow-up commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Publish endpoint integration + helper

**Files:**
- Modify: `web/backend/app/routers/tracks.py` (extract helper, rewrite gather block in `publish_track_to_game`, update merger call)
- Create: `web/backend/tests/test_order_beatmaps_for_publish.py`

- [ ] **Step 1: Write the failing tests first**

Create `web/backend/tests/test_order_beatmaps_for_publish.py`:

```python
"""Unit tests for order_beatmaps_for_publish — the pure helper that
chooses each stem's primary beatmap (active flag > selected_beatmaps
override > most recent) and orders the rest alphabetically by preset
name for the multi-beatmap publish flow.
"""
from __future__ import annotations

from app.routers.tracks import order_beatmaps_for_publish


def _bm(bid: str, stem: str, preset: str, *, active: bool = False, generated_at: float = 0.0) -> dict:
    return {
        'id': bid, 'stem': stem, 'preset': preset,
        'active': active, 'generated_at': generated_at,
    }


def test_single_beatmap_per_stem_keeps_it_as_primary():
    bms = [_bm('g1', 'guitar', 'v1', active=True)]
    ordered = order_beatmaps_for_publish(bms, stem_overrides={})
    assert ordered == [(_bm('g1', 'guitar', 'v1', active=True), True)]


def test_active_flag_picks_primary_when_multiple_present():
    bms = [
        _bm('g1', 'guitar', 'v1', active=False, generated_at=100.0),
        _bm('g2', 'guitar', 'v2', active=True, generated_at=200.0),
        _bm('g3', 'guitar', 'v3', active=False, generated_at=300.0),
    ]
    ordered = order_beatmaps_for_publish(bms, stem_overrides={})
    # First is the active beatmap (g2), rest alphabetical by preset (v1 < v3).
    assert [b['id'] for b, _ in ordered] == ['g2', 'g1', 'g3']
    assert [is_active for _, is_active in ordered] == [True, False, False]


def test_stem_overrides_beat_the_active_flag():
    bms = [
        _bm('g1', 'guitar', 'v1', active=True, generated_at=100.0),
        _bm('g2', 'guitar', 'v2', active=False, generated_at=200.0),
    ]
    ordered = order_beatmaps_for_publish(bms, stem_overrides={'guitar': 'g2'})
    # Override wins — g2 is primary even though g1 is the active one.
    assert [b['id'] for b, _ in ordered] == ['g2', 'g1']
    assert [is_active for _, is_active in ordered] == [True, False]


def test_most_recent_wins_when_no_active_and_no_override():
    bms = [
        _bm('g1', 'guitar', 'v1', generated_at=100.0),
        _bm('g2', 'guitar', 'v2', generated_at=300.0),  # most recent
        _bm('g3', 'guitar', 'v3', generated_at=200.0),
    ]
    ordered = order_beatmaps_for_publish(bms, stem_overrides={})
    assert [b['id'] for b, _ in ordered] == ['g2', 'g1', 'g3']


def test_multi_stem_emits_per_stem_ordering_grouped():
    bms = [
        _bm('g1', 'guitar', 'v3', active=True),
        _bm('g2', 'guitar', 'v1'),
        _bm('d1', 'drums', 'drums-v1', active=True),
        _bm('d2', 'drums', 'v1'),
        _bm('d3', 'drums', 'v2'),
    ]
    ordered = order_beatmaps_for_publish(bms, stem_overrides={})
    # Order: all-guitar (primary then alts) followed by all-drums (primary
    # then alts). Within stem: primary first, alternates alphabetical by preset.
    assert [b['id'] for b, _ in ordered] == ['g1', 'g2', 'd1', 'd2', 'd3']


def test_alternates_sorted_alphabetically_then_by_generated_at():
    """Two alternates with the same preset name (e.g. user generated v3 twice)
    fall back to generated_at as the tiebreaker."""
    bms = [
        _bm('g1', 'guitar', 'v1', active=True),
        _bm('g2', 'guitar', 'v3', generated_at=300.0),
        _bm('g3', 'guitar', 'v3', generated_at=100.0),  # earlier v3
        _bm('g4', 'guitar', 'v2'),
    ]
    ordered = order_beatmaps_for_publish(bms, stem_overrides={})
    # v1 (active), v2, v3 earliest, v3 newest.
    assert [b['id'] for b, _ in ordered] == ['g1', 'g4', 'g3', 'g2']


def test_empty_beatmaps_returns_empty_list():
    assert order_beatmaps_for_publish([], stem_overrides={}) == []


def test_beatmaps_with_no_stem_field_are_skipped():
    """Beatmaps without a 'stem' field can't be merged — they belong to no
    instrument. Drop them silently."""
    bms = [
        _bm('g1', 'guitar', 'v1', active=True),
        {'id': 'x', 'preset': 'v2'},  # no stem
    ]
    ordered = order_beatmaps_for_publish(bms, stem_overrides={})
    assert [b['id'] for b, _ in ordered] == ['g1']
```

- [ ] **Step 2: Run tests to verify they fail**

```
cd web/backend && venv/Scripts/python.exe -m pytest tests/test_order_beatmaps_for_publish.py -v 2>&1 | tail -20
```

Expected: ImportError — `order_beatmaps_for_publish` doesn't exist in `app.routers.tracks` yet.

- [ ] **Step 3: Add the `order_beatmaps_for_publish` helper to `tracks.py`**

In `web/backend/app/routers/tracks.py`, find a good spot for a module-level helper — somewhere above `publish_track_to_game` (around line 1099). A reasonable location is right before the `@router.post('/{track_id}/publish-game')` decorator.

Add:

```python
def order_beatmaps_for_publish(
    track_beatmaps: list[dict],
    stem_overrides: dict[str, str],
) -> list[tuple[dict, bool]]:
    """Group beatmaps by stem and return a per-beatmap ordering with the
    primary flag attached. Pure function — no filesystem or DB hits — so
    it's testable in isolation.

    For each stem: pick the primary (stem_overrides[stem] override wins,
    else the user-marked active beatmap, else the most recent), then list
    alternates alphabetically by preset name (with generated_at as the
    tiebreaker when two beatmaps share a preset).

    Returns [(beatmap_dict, is_primary)] in the order the merger should
    consume — grouped by stem, primary first per stem, then alternates.
    Stems are emitted in dict-insertion order of their first beatmap so
    the resulting chart's section ordering is stable.

    Beatmaps without a 'stem' field are silently dropped — they belong
    to no instrument.
    """
    by_stem: dict[str, list[dict]] = {}
    for bm in track_beatmaps:
        stem = bm.get('stem')
        if not stem:
            continue
        by_stem.setdefault(stem, []).append(bm)

    out: list[tuple[dict, bool]] = []
    for stem, candidates in by_stem.items():
        primary: dict | None = None
        want = stem_overrides.get(stem)
        if want:
            primary = next((b for b in candidates if b.get('id') == want), None)
        if primary is None:
            primary = next((b for b in candidates if b.get('active')), None)
        if primary is None:
            primary = max(candidates, key=lambda b: b.get('generated_at', 0))

        alternates = sorted(
            (b for b in candidates if b is not primary),
            key=lambda b: (b.get('preset', '') or '', b.get('generated_at', 0)),
        )

        out.append((primary, True))
        for bm in alternates:
            out.append((bm, False))
    return out
```

- [ ] **Step 4: Run the helper tests to verify they pass**

```
cd web/backend && venv/Scripts/python.exe -m pytest tests/test_order_beatmaps_for_publish.py -v 2>&1 | tail -20
```

Expected: 8 passing.

- [ ] **Step 5: Rewrite the gather block in `publish_track_to_game`**

In `web/backend/app/routers/tracks.py`, find the per-stem selection block in `publish_track_to_game`. Currently it sits roughly at lines 1194-1230 and looks like:

```python
chart_status: dict = {'found': False, 'source': None, 'included_stems': [], 'skipped_stems': []}
if track.beatmaps:
    # Group beatmaps by stem so we can apply user overrides cleanly.
    by_stem: dict[str, list[dict]] = {}
    for bm in track.beatmaps:
        by_stem.setdefault(bm.get('stem', ''), []).append(bm)

    charts_to_merge: list[tuple[str, str]] = []
    beatmap_selection: dict[str, str] = {}
    for stem, candidates in by_stem.items():
        # Pick: the user-specified beatmap_id if provided AND it exists
        # for this stem; otherwise the most recently generated.
        chosen: dict | None = None
        want = stem_overrides.get(stem)
        if want:
            for bm in candidates:
                if bm.get('id') == want:
                    chosen = bm
                    break
        if chosen is None:
            active_match = next((b for b in candidates if b.get('active')), None)
            chosen = active_match or max(candidates, key=lambda b: b.get('generated_at', 0))

        bm_dir = track.beatmaps_dir / chosen.get('id', '')
        if not bm_dir.exists():
            continue
        src_chart = None
        for candidate in ('notes.chart', 'notes_fixed_slides.chart'):
            p = bm_dir / candidate
            if p.exists():
                src_chart = p
                break
        if src_chart is None:
            src_chart = next(iter(bm_dir.glob('*.chart')), None)
        if src_chart is None:
            continue
        charts_to_merge.append((str(src_chart), stem))
        beatmap_selection[stem] = chosen.get('id', '')

    if charts_to_merge:
        merge_result = merge_beatmap_charts(
            charts_to_merge,
            str(tmp_dir / 'notes_fixed_slides.chart'),
        )
```

Replace with the multi-beatmap version using the new helper:

```python
chart_status: dict = {'found': False, 'source': None, 'included_stems': [], 'skipped_stems': []}
if track.beatmaps:
    # Order every beatmap for publish: primary first per stem (override > active > most recent),
    # then alternates alphabetical by preset. Numbered sections come from
    # merge_beatmap_charts' per-stem counter.
    ordered = order_beatmaps_for_publish(list(track.beatmaps), stem_overrides)

    charts_to_merge: list[tuple[str, str, dict]] = []
    beatmap_selection: dict[str, str] = {}
    for bm, is_primary in ordered:
        bm_dir = track.beatmaps_dir / bm.get('id', '')
        if not bm_dir.exists():
            continue
        src_chart = None
        for candidate in ('notes.chart', 'notes_fixed_slides.chart'):
            p = bm_dir / candidate
            if p.exists():
                src_chart = p
                break
        if src_chart is None:
            src_chart = next(iter(bm_dir.glob('*.chart')), None)
        if src_chart is None:
            continue
        stem = bm.get('stem', '')
        meta = {
            'preset': bm.get('preset', '') or '',
            'beatmap_id': bm.get('id', ''),
            'is_active': is_primary,
        }
        charts_to_merge.append((str(src_chart), stem, meta))
        if is_primary:
            beatmap_selection[stem] = bm.get('id', '')

    if charts_to_merge:
        merge_result = merge_beatmap_charts(
            charts_to_merge,
            str(tmp_dir / 'notes_fixed_slides.chart'),
        )
```

The `merge_result` consumption immediately after (chart_status updates etc.) is unchanged — `merge_beatmap_charts` still returns the same `{'included': [...], 'skipped': [...]}` shape.

- [ ] **Step 6: Build / syntax-check**

The whole `tracks.py` should still import without syntax errors. Quick check:

```
cd web/backend && venv/Scripts/python.exe -c "from app.routers import tracks; print('ok')" 2>&1 | tail -5
```

Expected: `ok`.

- [ ] **Step 7: Re-run all the new tests + the broader publish smoke**

```
cd web/backend && venv/Scripts/python.exe -m pytest tests/test_chart_merge_multi_beatmap.py tests/test_order_beatmaps_for_publish.py tests/test_publish_imported_sources.py -v 2>&1 | tail -20
```

Expected: 8 (merge) + 8 (helper) + N (imported_sources) passing. `test_publish_imported_sources` should now pass again (Task 1 broke it via the signature change; Task 2's call-site update fixes it).

If `test_publish_imported_sources` still fails, read the failure trace and check whether the publish path inside that test triggers the merger code we just rewrote. If it does, the failure is likely a real regression — fix it before committing.

- [ ] **Step 8: Run the full backend test suite quickly to catch any other regressions**

```
cd web/backend && venv/Scripts/python.exe -m pytest tests/ -x 2>&1 | tail -30
```

Expected: all green. The `-x` flag stops on first failure so unexpected breakage surfaces fast.

- [ ] **Step 9: Commit**

```bash
git add web/backend/app/routers/tracks.py \
        web/backend/tests/test_order_beatmaps_for_publish.py
git commit -m "feat(tracks): publish all beatmaps per stem as numbered alternates

publish_track_to_game now gathers EVERY beatmap for each stem (not
just the active one) and passes them through the multi-beatmap merger.
Primary picked via the existing stem_overrides form field (override >
active > most recent); alternates ordered alphabetically by preset
name with generated_at as tiebreaker.

The gather/order logic is extracted to a new pure helper
order_beatmaps_for_publish() so it's unit-testable in isolation. The
endpoint's existing selected_beatmaps form field keeps its semantics
(picks the primary), and the response/SSE plumbing is unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Deploy + final smoke

**Files:** none

- [ ] **Step 1: Push to remote**

```bash
git push origin main
```

- [ ] **Step 2: Deploy (backend-only)**

Per the deploy memory, backend-only changes need a pull + service restart (no `npm run build`):

```
ssh beatmap 'cd /opt/madmom && git pull --ff-only && systemctl restart beatmap-backend && systemctl is-active beatmap-backend'
```

Expected: `active` at the end of the output.

- [ ] **Step 3: Sanity-check the backend is running**

```
curl -s -o /dev/null -w "%{http_code}\n" https://beatmap.jamsesh.co/api/tracks
```

Expected: `401` (auth gate — endpoint is mounted).

- [ ] **Step 4: Verify on production via the test track**

This step depends on the test track from the user's setup. Track ID `4d038f0672dc` should have ~10 drums beatmaps and ~10 guitar beatmaps after the parallel generation script completes.

In a browser logged into the Studio:

- [ ] Open the track at `https://beatmap.jamsesh.co/?id=4d038f0672dc`
- [ ] Confirm the Tracks page lists multiple beatmaps under both drums and guitar (10 each)
- [ ] Click **Publish to Game**, fill in song.ini fields, submit
- [ ] Wait for publish to complete

- [ ] **Step 5: Inspect the published chart on GitHub**

Find the new commit on `jamseshgame/JamseshSongContent` (branch `main`, under `SongInbox/`) for this track. Open `notes_fixed_slides.chart` in the GitHub web UI and verify:

- [ ] Has `[Beatmaps]` block right after `[Events]`
- [ ] `[Beatmaps]` block contains rows for `ExpertSingle`, `HardSingle`, etc. (the active beatmaps) with `name="active"`
- [ ] `[Beatmaps]` block contains rows for `ExpertSingle2`..`ExpertSingle10` and `ExpertDrums2`..`ExpertDrums10` with `name="alt"`
- [ ] Note-track sections appear in stem-then-N-then-difficulty order (eyeball with `grep -E '^\[' notes_fixed_slides.chart`)
- [ ] Total section count: 4 header blocks + 4 difficulties × 10 beatmaps × 2 stems = 84 sections

- [ ] **Step 6: Clone Hero compatibility smoke**

- [ ] Download the published folder from GitHub
- [ ] Drop into a Clone Hero install's `songs/` directory
- [ ] Confirm the song loads in CH's song list
- [ ] Confirm the guitar chart and drums chart play correctly (CH reads the active/unnumbered sections; alternates are silently ignored — that's the intended Clone Hero behavior)

---

## Self-review

**Spec coverage:**
- ✅ New signature for `merge_beatmap_charts` — Task 1 Step 3
- ✅ Per-beatmap N numbering (all 4 difficulties share N) — Task 1 Step 3
- ✅ `[Beatmaps]` metadata block — Task 1 Step 3
- ✅ `_esc` helper — Task 1 Step 3
- ✅ Section ordering by (stem, n, difficulty) — Task 1 Step 3
- ✅ Edge case: missing difficulty in a beatmap — Task 1 Step 1 (`test_missing_difficulty_does_not_shift_other_diffs`)
- ✅ Edge case: beatmap with zero difficulties doesn't burn N — Task 1 Step 1 (`test_all_missing_difficulties_does_not_burn_n_slot`)
- ✅ Edge case: empty input — Task 1 Step 1
- ✅ Edge case: unknown stem — Task 1 Step 1
- ✅ Edge case: preset with `"` or `\n` — Task 1 Step 1
- ✅ Publish endpoint gathers all beatmaps per stem — Task 2 Step 5
- ✅ `selected_beatmaps` override still picks primary — Task 2 Step 1 (`test_stem_overrides_beat_the_active_flag`) + Step 5
- ✅ Alternates ordered alphabetical by preset — Task 2 Step 1 (`test_active_flag_picks_primary_when_multiple_present`) + Step 3
- ✅ `order_beatmaps_for_publish` extracted as testable pure helper — Task 2 Step 3
- ✅ Deploy procedure — Task 3
- ✅ Clone Hero compatibility smoke — Task 3 Step 6

**Placeholders:** none — every step has complete code or an exact command.

**Type consistency:**
- 3-tuple `(chart_path, stem, meta)` shape defined in Task 1's function docstring + tests, consumed identically in Task 2's call-site change
- `meta` dict shape `{'preset': str, 'beatmap_id': str, 'is_active': bool}` matches in tests, helper, and call site
- `order_beatmaps_for_publish` return type `list[tuple[dict, bool]]` matches in tests (Task 2 Step 1) and consumer (Task 2 Step 5)
- `_esc` defined and used only inside `chart_generator.py` — no cross-file dependency
