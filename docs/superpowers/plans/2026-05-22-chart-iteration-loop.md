# Chart Iteration Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three integrated pieces that close the iterate-on-feel loop: (A) mirror the multi-beatmap `[Beatmaps]` metadata into the published `song.ini` so Unity can pick variants without parsing the chart; (B) per-chart text feedback (tags + rating + free-form text, user-attributed); (C) an admin Generation Presets page with a per-stem "Propose new presets from feedback" button that calls the Anthropic API and lets the user save the returned drafts.

**Architecture:** Backend gets a new `feedback` service + router (JSONL per beatmap), a `preset_proposer` service wrapping the Anthropic SDK, three config env vars, and a new endpoint on the existing `generation_presets` router. The publish-time `stems.write_song_ini` gains an optional `beatmaps` argument. Frontend gets a reusable `FeedbackPanel` mounted on Tracks-page chart rows and inside the BeatmapEditor, plus a new admin-only `/presets` page with a `ProposalReviewModal`.

**Tech Stack:** Python 3.9+, FastAPI, pytest. New pip dep: `anthropic>=0.40`. React 18 + TypeScript + Vite + Tailwind. No DB.

**Spec:** `docs/superpowers/specs/2026-05-22-chart-iteration-loop-design.md`

---

## File Map

| Path | Action | Purpose |
|---|---|---|
| `web/backend/app/services/stems.py` | Modify | `write_song_ini` gains optional `beatmaps=[…]`; emits `[beatmap_N]` sections |
| `web/backend/app/routers/tracks.py` | Modify | `publish_track_to_game` passes its already-built beatmap list to `write_song_ini` |
| `web/backend/app/services/feedback.py` | Create | `FEEDBACK_TAGS` constant, `FeedbackNote` schema, JSONL CRUD, `aggregate_for_stem` |
| `web/backend/app/routers/feedback.py` | Create | 6 endpoints under `/api/feedback` |
| `web/backend/app/main.py` | Modify | Mount the `feedback` router |
| `web/backend/app/config.py` | Modify | Add `anthropic_api_key`, `anthropic_model`, `anthropic_max_tokens` |
| `web/backend/requirements.txt` | Modify | Add `anthropic>=0.40` |
| `web/backend/app/services/preset_proposer.py` | Create | System-prompt builder + Anthropic call + response parser |
| `web/backend/app/routers/generation_presets.py` | Modify | Add `POST /propose-from-feedback?stem=<stem>&n=<n>` |
| `web/backend/tests/test_write_song_ini_beatmaps.py` | Create | Cases for `beatmaps=None` regression, one beatmap, two beatmaps, escaping |
| `web/backend/tests/test_feedback_crud.py` | Create | Auth + schema + concurrency for the feedback router |
| `web/backend/tests/test_feedback_aggregate.py` | Create | Multi-track scan + stem filter |
| `web/backend/tests/test_preset_proposer.py` | Create | Mock the Anthropic client; verify prompt + parse + schema validation |
| `web/frontend/src/components/feedback/FeedbackPanel.tsx` | Create | Note list + new-note form, reusable |
| `web/frontend/src/components/feedback/FeedbackButton.tsx` | Create | Toggle button with count badge |
| `web/frontend/src/pages/TracksPage.tsx` | Modify | Mount FeedbackButton in each beatmap row |
| `web/frontend/src/components/BeatmapEditor.tsx` | Modify | Mount FeedbackPanel inside the editor |
| `web/frontend/src/pages/GenerationPresetsPage.tsx` | Create | Admin presets page (grouped by stem) |
| `web/frontend/src/components/presets/ProposalReviewModal.tsx` | Create | N-card review modal |
| `web/frontend/src/App.tsx` | Modify | Add `/presets` route (admin-only) + nav link |

---

# Phase A — song.ini multi-chart metadata

## Task A1: Extend `stems.write_song_ini` with `beatmaps=[…]`

**Files:**
- Modify: `web/backend/app/services/stems.py` (the `write_song_ini` function at line 86)
- Create: `web/backend/tests/test_write_song_ini_beatmaps.py`

- [ ] **Step 1: Write the failing test**

Create `web/backend/tests/test_write_song_ini_beatmaps.py`:

```python
"""Unit tests for the new `beatmaps` parameter on stems.write_song_ini.

Each test calls write_song_ini with a synthetic fields dict + a beatmaps
list, then asserts on the resulting song.ini text (read back from disk).
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.services.stems import write_song_ini


MINIMAL_FIELDS = {'name': 'Test', 'artist': 'Foo', 'album': 'Bar', 'genre': 'Rock', 'year': '2026'}


def _read(tmp_path: Path) -> str:
    return (tmp_path / 'song.ini').read_text(encoding='utf-8')


def test_no_beatmaps_arg_is_unchanged(tmp_path):
    """Regression — passing beatmaps=None must produce the same output as today."""
    write_song_ini(tmp_path, MINIMAL_FIELDS)
    expected = _read(tmp_path)

    write_song_ini(tmp_path, MINIMAL_FIELDS, beatmaps=None)
    assert _read(tmp_path) == expected


def test_empty_beatmaps_list_is_unchanged(tmp_path):
    write_song_ini(tmp_path, MINIMAL_FIELDS)
    expected = _read(tmp_path)

    write_song_ini(tmp_path, MINIMAL_FIELDS, beatmaps=[])
    assert _read(tmp_path) == expected


def test_single_beatmap_emits_block(tmp_path):
    bm = {
        'id': '4d038f0672dc',
        'name': 'V1 — Defaults',
        'preset': 'v1',
        'stem': 'guitar',
        'is_active': True,
        'sections': ['ExpertSingle', 'HardSingle', 'MediumSingle', 'EasySingle'],
    }
    write_song_ini(tmp_path, MINIMAL_FIELDS, beatmaps=[bm])
    text = _read(tmp_path)

    assert '[beatmap_1]' in text
    assert 'id = 4d038f0672dc' in text
    assert 'name = V1 — Defaults' in text
    assert 'preset = v1' in text
    assert 'stem = guitar' in text
    assert 'is_active = true' in text
    assert 'sections = ExpertSingle,HardSingle,MediumSingle,EasySingle' in text


def test_two_beatmaps_numbered_sequentially(tmp_path):
    beatmaps = [
        {'id': 'a1', 'name': 'V1', 'preset': 'v1', 'stem': 'guitar', 'is_active': True,
         'sections': ['ExpertSingle']},
        {'id': 'a2', 'name': 'V2', 'preset': 'v2', 'stem': 'guitar', 'is_active': False,
         'sections': ['ExpertSingle2']},
    ]
    write_song_ini(tmp_path, MINIMAL_FIELDS, beatmaps=beatmaps)
    text = _read(tmp_path)

    i1 = text.index('[beatmap_1]')
    i2 = text.index('[beatmap_2]')
    assert i1 < i2  # ordering preserved
    assert 'is_active = true' in text[i1:i2]
    assert 'is_active = false' in text[i2:]


def test_special_chars_in_name_are_escaped(tmp_path):
    """Newlines in name must be stripped; quotes escaped."""
    bm = {
        'id': 'x', 'preset': 'v1', 'stem': 'guitar', 'is_active': True,
        'sections': [],
        'name': 'My "weird"\nname',  # newline + embedded quote
    }
    write_song_ini(tmp_path, MINIMAL_FIELDS, beatmaps=[bm])
    text = _read(tmp_path)

    name_line = [ln for ln in text.splitlines() if ln.startswith('name = ')][-1]
    assert '\n' not in name_line[len('name = '):]  # newline stripped within the value
    assert 'My \\"weird\\" name' in name_line


def test_missing_optional_fields_use_defaults(tmp_path):
    """`is_active` missing → false; `sections` missing → empty string."""
    bm = {'id': 'x', 'name': 'V1', 'preset': 'v1', 'stem': 'guitar'}
    write_song_ini(tmp_path, MINIMAL_FIELDS, beatmaps=[bm])
    text = _read(tmp_path)
    assert 'is_active = false' in text
    assert 'sections = ' in text  # empty value, but key present
```

- [ ] **Step 2: Run the test to confirm it fails**

Run from `web/backend/`:
```bash
./venv/bin/python -m pytest tests/test_write_song_ini_beatmaps.py -v
```
Expected: All cases except possibly the first two fail with `TypeError: write_song_ini() got an unexpected keyword argument 'beatmaps'`.

- [ ] **Step 3: Add the `_esc` helper + extend `write_song_ini`**

In `web/backend/app/services/stems.py`, just above the existing `def write_song_ini(...)` (line 86), add a small helper:

```python
def _esc_ini_value(s: str) -> str:
    """Strip CR/LF (which would break the line-oriented song.ini format) and
    escape embedded double quotes. Mirrors the chart_generator._esc helper used
    for the notes.chart [Beatmaps] block."""
    return s.replace('\r', '').replace('\n', ' ').replace('"', '\\"')
```

Then change the `write_song_ini` signature to accept an optional `beatmaps` argument and append the new sections at the end (after the existing `[background]` block):

```python
def write_song_ini(
    output_dir: Path,
    fields: dict,
    *,
    beatmaps: list[dict] | None = None,
) -> Path:
    """... (existing docstring) ...

    When `beatmaps` is provided, after the existing sections the writer emits
    one `[beatmap_N]` section per entry. The order of the list determines N
    (primary first per stem, then alternates) and N matches the section-number
    suffix used in notes.chart by merge_beatmap_charts. The Unity client reads
    these to populate its variant picker without parsing the chart.
    """
    # ... existing logic that builds `lines` unchanged ...

    # ── new — multi-beatmap metadata ────────────────────────────────────────
    if beatmaps:
        for i, bm in enumerate(beatmaps, start=1):
            lines.append('')
            lines.append(f'[beatmap_{i}]')
            for key in ('id', 'name', 'preset', 'stem'):
                raw = str(bm.get(key, ''))
                lines.append(f'{key} = {_esc_ini_value(raw)}')
            is_active = bool(bm.get('is_active', False))
            lines.append(f'is_active = {"true" if is_active else "false"}')
            sections = bm.get('sections') or []
            joined = ','.join(_esc_ini_value(str(s)) for s in sections)
            lines.append(f'sections = {joined}')

    ini_path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return ini_path
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
./venv/bin/python -m pytest tests/test_write_song_ini_beatmaps.py -v
```
Expected: all 6 cases PASS. Also run the existing `tests/test_write_chart_song_ini.py` to confirm no regression there.

- [ ] **Step 5: Commit**

```bash
git add web/backend/app/services/stems.py web/backend/tests/test_write_song_ini_beatmaps.py
git commit -m "feat(song-ini): emit [beatmap_N] blocks when publishing multi-beatmap tracks"
```

---

## Task A2: Wire `publish_track_to_game` to pass the beatmaps list

**Files:**
- Modify: `web/backend/app/routers/tracks.py` (`publish_track_to_game`, around line 1357 where `write_song_ini` is called)

- [ ] **Step 1: Locate the publish flow**

Open `web/backend/app/routers/tracks.py` and find the section starting around line 1253 (`ordered = order_beatmaps_for_publish(...)`) through line 1294 (the end of the `chart_status` block) and line 1357 where `write_song_ini(tmp_dir, ini_fields)` is called.

- [ ] **Step 2: Build the song.ini-shaped beatmaps list alongside `charts_to_merge`**

Inside the `if track.beatmaps:` branch (around line 1255), where `charts_to_merge` is built up, also accumulate a parallel list with the section names. After `merge_beatmap_charts` returns, it's the authoritative source of `included` order — we mirror that to ensure N matches between the chart and song.ini.

Change the post-merge block (around line 1286) from:

```python
if merge_result['included']:
    chart_status = {
        'found': True,
        'published_as': 'notes_fixed_slides.chart',
        'included_stems': merge_result['included'],
        'skipped_stems': merge_result['skipped'],
        'source': f'{len(merge_result["included"])}-stem merge',
        'selected_beatmaps': beatmap_selection,
    }
```

to:

```python
if merge_result['included']:
    chart_status = {
        'found': True,
        'published_as': 'notes_fixed_slides.chart',
        'included_stems': merge_result['included'],
        'skipped_stems': merge_result['skipped'],
        'source': f'{len(merge_result["included"])}-stem merge',
        'selected_beatmaps': beatmap_selection,
        # Carry the per-beatmap section names emitted by merge_beatmap_charts
        # so write_song_ini below can mirror them into [beatmap_N] blocks. The
        # merger returns 'sections_by_beatmap' as a parallel dict (added in
        # Task A2.5 below).
    }
    song_ini_beatmaps = merge_result.get('sections_by_beatmap', [])
else:
    song_ini_beatmaps = []
```

- [ ] **Step 3: Extend `merge_beatmap_charts` to return `sections_by_beatmap`**

In `web/backend/app/services/chart_generator.py:merge_beatmap_charts` (the function starts at line ~95), add a parallel per-beatmap record collected during the main loop and emitted in the return value. Apply this diff against the existing code:

**A. Just after `sections_out = []` (line ~132), add:**
```python
# Parallel to sections_out — one record per beatmap that contributed
# sections. Carries the same identifiers as the [Beatmaps] rows in the
# chart so the caller (publish_track_to_game → write_song_ini) can mirror
# them into song.ini's [beatmap_N] blocks for Unity's variant picker.
beatmap_records: list[dict] = []
```

**B. Inside the for-difficulty loop body at line ~173-188, immediately after `sections_out.append(...)`, also accumulate this beatmap's section names:**
```python
# (existing)
sections_out.append((section_name, m.group(1), suffix, candidate_n, row_text))
contributed_sections.append(section_name)  # NEW
any_section = True
```

…and declare `contributed_sections: list[str] = []` right above the for-difficulty loop (i.e. just after `name_tag = ...` at line ~171).

**C. In the `if any_section:` branch at line ~190, after `included.append(stem)`, push the beatmap record:**
```python
if any_section:
    beatmap_index_per_stem[stem] = candidate_n
    included.append(stem)
    beatmap_records.append({                      # NEW block
        'id': meta.get('beatmap_id', '') or '',
        'name': meta.get('preset', '') or '',     # display name = preset for v1
        'preset': meta.get('preset', '') or '',
        'stem': stem,
        'is_active': bool(meta.get('is_active')),
        '_n': candidate_n,                        # internal — stripped before return
        'sections': contributed_sections,
    })
else:
    skipped.append(stem)
```

**D. After `sections_sorted = sorted(...)` (line ~217), sort and clean `beatmap_records` to match the chart's stem/n ordering, then strip the internal `_n`:**
```python
diff_order_local = {'Expert': 0, 'Hard': 1, 'Medium': 2, 'Easy': 3}
beatmap_records.sort(
    key=lambda r: (
        suffix_first_seen.get(STEM_TO_SECTION_SUFFIX.get(r['stem'], ''), 0),
        r['_n'],
    ),
)
for r in beatmap_records:
    suf = STEM_TO_SECTION_SUFFIX.get(r['stem'], '')
    if suf:
        r['sections'].sort(
            key=lambda sn: diff_order_local.get(
                sn[: sn.index(suf)] if suf in sn else '', 99
            )
        )
    r.pop('_n', None)
```

**E. Replace the final `return` line at line ~232 with:**
```python
return {
    'included': included,
    'skipped': skipped,
    'sections_by_beatmap': beatmap_records,
}
```

Also handle the early-return path at line ~200 (empty input case) — give it the same key so callers can always read it:
```python
if not sections_out or song_block is None or sync_block is None:
    return {'included': included, 'skipped': skipped, 'sections_by_beatmap': []}
```

- [ ] **Step 4: Pass `beatmaps=song_ini_beatmaps` into `write_song_ini`**

Around line 1357 (`write_song_ini(tmp_dir, ini_fields)`), change to:

```python
# Write song.ini (after tutorial / realnotes fields may have been added)
write_song_ini(tmp_dir, ini_fields, beatmaps=song_ini_beatmaps)
```

In the `else` branch where `track.beatmaps` is empty, `song_ini_beatmaps` defaults to `[]` so the new arg is a no-op.

- [ ] **Step 5: Extend the existing merger test to assert `sections_by_beatmap`**

In `web/backend/tests/test_chart_merge_multi_beatmap.py` (created by the previous plan), add one new test:

```python
def test_returns_sections_by_beatmap_for_song_ini(tmp_path: Path):
    in1 = tmp_path / 'g1.chart'
    in2 = tmp_path / 'g2.chart'
    _write_chart(in1)
    _write_chart(in2)
    out = tmp_path / 'merged.chart'

    result = merge_beatmap_charts(
        [
            (str(in1), 'guitar', _meta('v1', 'bm-1', True)),
            (str(in2), 'guitar', _meta('v2', 'bm-2', False)),
        ],
        str(out),
    )

    sb = result['sections_by_beatmap']
    assert len(sb) == 2
    primary, alt = sb
    assert primary['is_active'] is True
    assert primary['preset'] == 'v1'
    assert primary['sections'] == ['ExpertSingle', 'HardSingle', 'MediumSingle', 'EasySingle']
    assert alt['is_active'] is False
    assert alt['preset'] == 'v2'
    assert alt['sections'] == ['ExpertSingle2', 'HardSingle2', 'MediumSingle2', 'EasySingle2']
```

- [ ] **Step 6: Run the full backend test suite**

```bash
cd web/backend && ./venv/bin/python -m pytest -q
```
Expected: all green. Investigate any breakage; the only callers of `merge_beatmap_charts` are `publish_track_to_game` and the merger test file.

- [ ] **Step 7: Commit**

```bash
git add web/backend/app/services/chart_generator.py web/backend/app/routers/tracks.py web/backend/tests/test_chart_merge_multi_beatmap.py
git commit -m "feat(publish): pass per-beatmap section names into song.ini for Unity variant picker"
```

---

# Phase B — Per-chart feedback

## Task B1: Define `FEEDBACK_TAGS` + `FeedbackNote` schema + JSONL helpers

**Files:**
- Create: `web/backend/app/services/feedback.py`

- [ ] **Step 1: Scaffold the module**

Create `web/backend/app/services/feedback.py`:

```python
"""Per-chart feedback storage.

Each beatmap has a `feedback.jsonl` file inside its folder containing one
JSON object per line. Notes are append-only on write; edits and deletes
rewrite the file under a per-beatmap lock so concurrent CRUD doesn't
interleave partial lines.

The Claude-driven preset proposer reads aggregated feedback across all
beatmaps for a stem; see `aggregate_for_stem`.
"""
from __future__ import annotations

import datetime
import json
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Iterable

from ..config import settings
from . import tracks as tracks_service


# ── Tag vocabulary ──────────────────────────────────────────────────────────
# Adding a new tag requires editing this constant and deploying. The frontend
# reads the categorised structure via GET /api/feedback/tags.
FEEDBACK_TAGS: dict[str, list[str]] = {
    'Density':       ['too-sparse', 'too-dense'],
    'Lane spread':   ['too-crampy', 'over-spread'],
    'Pitch mapping': ['wrong-pitch-mapping', 'tonic-anchored'],
    'Chords':        ['too-many-chords', 'not-enough-chords', 'weird-chord-shapes'],
    'Open notes':    ['too-many-opens', 'not-enough-opens'],
    'Rhythm':        ['off-beat', 'missed-section-changes'],
    'Overall':       ['feels-great', 'feels-random', 'unplayable'],
}

ALL_TAGS: set[str] = {t for ts in FEEDBACK_TAGS.values() for t in ts}


# ── Concurrency ─────────────────────────────────────────────────────────────
_locks: dict[tuple[str, str], threading.Lock] = {}
_locks_lock = threading.Lock()


def _lock_for(track_id: str, beatmap_id: str) -> threading.Lock:
    key = (track_id, beatmap_id)
    with _locks_lock:
        lk = _locks.get(key)
        if lk is None:
            lk = _locks[key] = threading.Lock()
        return lk


# ── ID + timestamp helpers ──────────────────────────────────────────────────
def _new_note_id() -> str:
    """Lexicographically time-sortable ID without external deps.

    `fb_<ms-hex>_<rand>`. The hex-ms prefix gives natural ordering when scanning
    JSONL by created_at.
    """
    return f'fb_{int(time.time() * 1000):x}_{secrets.token_hex(4)}'


def _now_iso() -> str:
    return datetime.datetime.now(tz=datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


# ── Validation ──────────────────────────────────────────────────────────────
class FeedbackError(ValueError):
    pass


def _validate_payload(rating: Any, tags: Any, text: Any) -> tuple[int, list[str], str]:
    if not isinstance(rating, int) or rating < 1 or rating > 5:
        raise FeedbackError('rating must be an integer between 1 and 5')
    if tags is None:
        tags = []
    if not isinstance(tags, list) or any(not isinstance(t, str) for t in tags):
        raise FeedbackError('tags must be a list of strings')
    unknown = [t for t in tags if t not in ALL_TAGS]
    if unknown:
        raise FeedbackError(f'unknown tag(s): {unknown}')
    if text is None:
        text = ''
    if not isinstance(text, str):
        raise FeedbackError('text must be a string')
    if not tags and not text.strip():
        raise FeedbackError('at least one of tags or text must be non-empty')
    return rating, list(tags), text


# ── Storage paths ───────────────────────────────────────────────────────────
def _feedback_path(track_id: str, beatmap_id: str) -> Path | None:
    bm_dir = tracks_service.get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        return None
    return bm_dir / 'feedback.jsonl'


# ── CRUD ────────────────────────────────────────────────────────────────────
def list_notes(track_id: str, beatmap_id: str) -> list[dict[str, Any]]:
    p = _feedback_path(track_id, beatmap_id)
    if p is None or not p.exists():
        return []
    out: list[dict[str, Any]] = []
    for line in p.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue  # skip malformed lines defensively
    return out


def add_note(
    track_id: str, beatmap_id: str, *, author: str,
    rating: int, tags: list[str], text: str,
) -> dict[str, Any]:
    p = _feedback_path(track_id, beatmap_id)
    if p is None:
        raise FeedbackError('beatmap not found')
    rating, tags, text = _validate_payload(rating, tags, text)
    now = _now_iso()
    note = {
        'id': _new_note_id(),
        'created_at': now,
        'updated_at': now,
        'author': author,
        'rating': rating,
        'tags': tags,
        'text': text,
    }
    with _lock_for(track_id, beatmap_id):
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open('a', encoding='utf-8') as f:
            f.write(json.dumps(note) + '\n')
    return note


def update_note(
    track_id: str, beatmap_id: str, note_id: str, *, requester: str,
    rating: Any = None, tags: Any = None, text: Any = None,
) -> dict[str, Any]:
    p = _feedback_path(track_id, beatmap_id)
    if p is None:
        raise FeedbackError('beatmap not found')
    with _lock_for(track_id, beatmap_id):
        notes = list_notes(track_id, beatmap_id)
        target_idx = next((i for i, n in enumerate(notes) if n.get('id') == note_id), None)
        if target_idx is None:
            raise FeedbackError('note not found')
        target = notes[target_idx]
        if target.get('author') != requester:
            raise PermissionError('only the author can edit a note')
        new_rating = target['rating'] if rating is None else rating
        new_tags = target['tags'] if tags is None else tags
        new_text = target['text'] if text is None else text
        new_rating, new_tags, new_text = _validate_payload(new_rating, new_tags, new_text)
        target.update({
            'rating': new_rating, 'tags': new_tags, 'text': new_text,
            'updated_at': _now_iso(),
        })
        notes[target_idx] = target
        p.write_text(''.join(json.dumps(n) + '\n' for n in notes), encoding='utf-8')
        return target


def delete_note(
    track_id: str, beatmap_id: str, note_id: str, *, requester: str, is_admin: bool,
) -> None:
    p = _feedback_path(track_id, beatmap_id)
    if p is None:
        raise FeedbackError('beatmap not found')
    with _lock_for(track_id, beatmap_id):
        notes = list_notes(track_id, beatmap_id)
        target = next((n for n in notes if n.get('id') == note_id), None)
        if target is None:
            raise FeedbackError('note not found')
        if not is_admin and target.get('author') != requester:
            raise PermissionError('only the author or an admin can delete a note')
        kept = [n for n in notes if n.get('id') != note_id]
        p.write_text(''.join(json.dumps(n) + '\n' for n in kept), encoding='utf-8')


# ── Aggregation (admin-only consumer) ───────────────────────────────────────
def aggregate_for_stem(stem: str) -> list[dict[str, Any]]:
    """Return per-beatmap groups for every beatmap whose preset applies to `stem`.

    A preset is considered applicable when it has no `stems` field (universal)
    or when its `stems` list includes `stem`. The result is a flat list ready
    to be embedded into the Claude system prompt.
    """
    # Local import to avoid an import cycle on module load.
    from ..routers.generation_presets import BUILTIN_PRESETS, _load_user_presets

    presets = list(BUILTIN_PRESETS) + _load_user_presets()
    by_name = {p['name']: p for p in presets}

    def _preset_applies(name: str) -> bool:
        p = by_name.get(name)
        if p is None:
            return False
        s = p.get('stems') or []
        return not s or stem in s

    # list_tracks() returns enriched DICTS, not Track objects, so reload each
    # by id to get the typed Track (with .beatmaps attribute access).
    out: list[dict[str, Any]] = []
    for td in tracks_service.list_tracks():
        track = tracks_service.get_track(td['id'])
        if track is None:
            continue
        for bm in (track.beatmaps or []):
            preset_name = bm.get('preset', '') or ''
            if not _preset_applies(preset_name):
                continue
            notes = list_notes(track.id, bm.get('id', ''))
            if not notes:
                continue
            out.append({
                'track_id': track.id,
                'track_name': track.name,
                'preset_name': preset_name,
                'beatmap_id': bm.get('id', ''),
                'beatmap_name': bm.get('song_name', preset_name),
                'is_active': bool(bm.get('active')),
                'notes': notes,
            })
    return out
```

- [ ] **Step 2: Commit the scaffold (no tests yet; tests live with the router in Task B3)**

```bash
git add web/backend/app/services/feedback.py
git commit -m "feat(feedback): add JSONL-backed feedback service + tag vocabulary"
```

---

## Task B2: Add the feedback router (TDD)

**Files:**
- Create: `web/backend/app/routers/feedback.py`
- Create: `web/backend/tests/test_feedback_crud.py`
- Modify: `web/backend/app/main.py` (mount the router)

- [ ] **Step 1: Write the failing tests**

Create `web/backend/tests/test_feedback_crud.py`. Auth in this codebase is cookie-based via `require_auth`; the existing tests (e.g. `test_generation_presets.py:18`) override the dependency for the TestClient rather than threading real cookies. We follow that pattern but swap the override per "logged-in user" to exercise the author-only / admin-can-delete-any rules:

```python
"""End-to-end tests for the feedback router.

Auth is exercised by swapping the require_auth / require_admin dependency
overrides per test — the same pattern test_generation_presets.py uses to
isolate from cookie-based session handling. Storage paths are redirected
into a tmp dir."""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.main import app
from app.routers.auth import require_auth, require_admin
from app.services import tracks as tracks_service


ALICE = {'username': 'alice', 'role': 'user'}
BOB   = {'username': 'bob',   'role': 'user'}
ROOT  = {'username': 'root',  'role': 'admin'}


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    from app import config
    monkeypatch.setattr(config.settings, 'upload_dir', str(tmp_path))
    # The tracks service caches TRACKS_DIR at import time; redirect it too so
    # create_track/get_track/list_tracks all land inside tmp_path.
    monkeypatch.setattr(tracks_service, 'TRACKS_DIR', tmp_path / 'tracks')
    return TestClient(app)


@pytest.fixture
def as_user(client):
    """Returns a setter so tests can switch which user FastAPI sees per call.
    Default is Alice; tests call `as_user(BOB)` / `as_user(ROOT)` to swap."""
    def _set(user: dict | None):
        if user is None:
            app.dependency_overrides.pop(require_auth, None)
            app.dependency_overrides.pop(require_admin, None)
            return
        app.dependency_overrides[require_auth] = lambda: user
        if user['role'] == 'admin':
            app.dependency_overrides[require_admin] = lambda: user
        else:
            def _deny(): raise HTTPException(status_code=403, detail='Admin only')
            app.dependency_overrides[require_admin] = _deny
    _set(ALICE)
    yield _set
    _set(None)


@pytest.fixture
def seeded_beatmap(client):
    """Create a real track folder + beatmap so the feedback path resolver finds it."""
    track = tracks_service.create_track(
        name='Test Song',
        stems={'guitar': 'guitar.mp3'},
        source_stems_dir=Path('.'),  # no actual stem file copy required for these tests
        model='htdemucs',
        output_format='mp3',
    )
    bm_dir = track.beatmaps_dir / 'bm-1'
    bm_dir.mkdir(parents=True, exist_ok=True)
    tracks_service.add_beatmap_record(
        track.id, 'bm-1', 'guitar',
        folder_name='Test Song',
        song_name='Test Song',
        source_dir=bm_dir,
        model='madmom',
        preset='v1',
    )
    return track.id, 'bm-1'


def test_anon_get_returns_401(client, as_user, seeded_beatmap):
    as_user(None)  # remove the require_auth override → real dependency raises 401
    track_id, bm_id = seeded_beatmap
    r = client.get(f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}')
    assert r.status_code == 401


def test_post_appends_a_note(client, as_user, seeded_beatmap):
    track_id, bm_id = seeded_beatmap
    r = client.post(
        f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}',
        json={'rating': 3, 'tags': ['too-crampy'], 'text': 'Chord shapes feel off'},
    )
    assert r.status_code == 200, r.text
    note = r.json()
    assert note['author'] == 'alice'
    assert note['rating'] == 3
    assert note['tags'] == ['too-crampy']
    assert note['id'].startswith('fb_')

    r2 = client.get(f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}')
    assert len(r2.json()) == 1


def test_put_only_allowed_for_author(client, as_user, seeded_beatmap):
    track_id, bm_id = seeded_beatmap
    r = client.post(f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}',
                    json={'rating': 3, 'tags': [], 'text': 'A'})
    note_id = r.json()['id']

    as_user(BOB)
    r2 = client.put(f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}/{note_id}',
                    json={'text': 'edited'})
    assert r2.status_code == 403

    as_user(ALICE)
    r3 = client.put(f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}/{note_id}',
                    json={'text': 'edited'})
    assert r3.status_code == 200
    assert r3.json()['text'] == 'edited'


def test_admin_can_delete_anyone(client, as_user, seeded_beatmap):
    track_id, bm_id = seeded_beatmap
    r = client.post(f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}',
                    json={'rating': 5, 'tags': ['feels-great'], 'text': ''})
    note_id = r.json()['id']

    as_user(ROOT)
    r2 = client.delete(f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}/{note_id}')
    assert r2.status_code == 200

    r3 = client.get(f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}')
    assert r3.json() == []


def test_schema_errors_return_422(client, as_user, seeded_beatmap):
    track_id, bm_id = seeded_beatmap
    cases = [
        {'rating': 0, 'tags': ['feels-great'], 'text': ''},
        {'rating': 6, 'tags': ['feels-great'], 'text': ''},
        {'rating': 3, 'tags': ['totally-made-up'], 'text': ''},
        {'rating': 3, 'tags': [], 'text': ''},  # both empty → 422
    ]
    for body in cases:
        r = client.post(f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}', json=body)
        assert r.status_code == 422, body


def test_tags_endpoint_returns_vocabulary(client, as_user):
    r = client.get('/api/feedback/tags')
    assert r.status_code == 200
    payload = r.json()
    assert 'Density' in payload
    assert 'feels-great' in payload['Overall']


def test_concurrent_appends_do_not_interleave(client, as_user, seeded_beatmap):
    """Spawn 20 simultaneous POSTs and confirm all 20 notes parse cleanly."""
    import concurrent.futures
    track_id, bm_id = seeded_beatmap

    def post_one(i):
        return client.post(
            f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}',
            json={'rating': 3, 'tags': [], 'text': f'note {i}'},
        )

    with concurrent.futures.ThreadPoolExecutor(max_workers=20) as ex:
        results = list(ex.map(post_one, range(20)))
    assert all(r.status_code == 200 for r in results)

    notes = client.get(f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}').json()
    assert len(notes) == 20  # nothing lost or corrupted
```

- [ ] **Step 2: Verify the tests fail with import errors**

```bash
cd web/backend && ./venv/bin/python -m pytest tests/test_feedback_crud.py -v
```
Expected: collection fails because `app.routers.feedback` doesn't exist yet.

- [ ] **Step 3: Implement the router**

Create `web/backend/app/routers/feedback.py`:

```python
"""Feedback CRUD + aggregation endpoints.

Any logged-in user can read or write feedback. Edits are author-only.
Deletes are allowed for the author or an admin. The /aggregate endpoint
is admin-only and serves the preset proposer."""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException

from ..services import feedback as feedback_service
from .auth import require_admin, require_auth


router = APIRouter(prefix='/api/feedback', tags=['feedback'])


@router.get('/tags')
async def get_tags(_user: dict = Depends(require_auth)) -> dict[str, list[str]]:
    return feedback_service.FEEDBACK_TAGS


@router.get('/tracks/{track_id}/beatmaps/{beatmap_id}')
async def list_notes(track_id: str, beatmap_id: str,
                     _user: dict = Depends(require_auth)) -> list[dict]:
    return feedback_service.list_notes(track_id, beatmap_id)


@router.post('/tracks/{track_id}/beatmaps/{beatmap_id}')
async def create_note(track_id: str, beatmap_id: str,
                      body: dict = Body(...),
                      user: dict = Depends(require_auth)) -> dict:
    try:
        return feedback_service.add_note(
            track_id, beatmap_id,
            author=user['username'],
            rating=body.get('rating'),
            tags=body.get('tags') or [],
            text=body.get('text') or '',
        )
    except feedback_service.FeedbackError as e:
        # User-facing schema errors → 422 (not 400) for symmetry with FastAPI's defaults
        raise HTTPException(422, str(e))


@router.put('/tracks/{track_id}/beatmaps/{beatmap_id}/{note_id}')
async def edit_note(track_id: str, beatmap_id: str, note_id: str,
                    body: dict = Body(...),
                    user: dict = Depends(require_auth)) -> dict:
    try:
        return feedback_service.update_note(
            track_id, beatmap_id, note_id,
            requester=user['username'],
            rating=body.get('rating'),
            tags=body.get('tags'),
            text=body.get('text'),
        )
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except feedback_service.FeedbackError as e:
        if 'not found' in str(e):
            raise HTTPException(404, str(e))
        raise HTTPException(422, str(e))


@router.delete('/tracks/{track_id}/beatmaps/{beatmap_id}/{note_id}')
async def remove_note(track_id: str, beatmap_id: str, note_id: str,
                      user: dict = Depends(require_auth)) -> dict:
    try:
        feedback_service.delete_note(
            track_id, beatmap_id, note_id,
            requester=user['username'],
            is_admin=(user.get('role') == 'admin'),
        )
        return {'ok': True}
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except feedback_service.FeedbackError as e:
        raise HTTPException(404, str(e))


@router.get('/aggregate')
async def aggregate(stem: str, _admin: dict = Depends(require_admin)) -> list[dict]:
    return feedback_service.aggregate_for_stem(stem)
```

- [ ] **Step 4: Mount the router in `app/main.py`**

Open `web/backend/app/main.py` and add the import + `include_router` call alongside the existing routers. The order is alphabetical-ish — find where `elevenlabs` is mounted and add `feedback` right after.

```python
from .routers import feedback  # add to the import block
...
app.include_router(feedback.router)  # add to the mount block
```

- [ ] **Step 5: Run the tests and confirm pass**

```bash
cd web/backend && ./venv/bin/python -m pytest tests/test_feedback_crud.py -v
```
Expected: all 7 cases PASS.

- [ ] **Step 6: Commit**

```bash
git add web/backend/app/routers/feedback.py web/backend/app/main.py web/backend/tests/test_feedback_crud.py
git commit -m "feat(feedback): add CRUD router with author-only edit + admin-can-delete-any"
```

---

## Task B3: Aggregation test for the proposer's consumer

**Files:**
- Create: `web/backend/tests/test_feedback_aggregate.py`

- [ ] **Step 1: Write the test**

```python
"""Test the cross-track / cross-beatmap aggregation that the preset
proposer consumes."""
from __future__ import annotations

from pathlib import Path

import pytest

from app.services import feedback as feedback_service
from app.services import tracks as tracks_service


@pytest.fixture(autouse=True)
def _tmp_storage(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from app import config
    monkeypatch.setattr(config.settings, 'upload_dir', str(tmp_path))
    monkeypatch.setattr(tracks_service, 'TRACKS_DIR', tmp_path / 'tracks')


def _seed_beatmap(track, beatmap_id: str, *, stem: str, preset: str) -> None:
    bm_dir = track.beatmaps_dir / beatmap_id
    bm_dir.mkdir(parents=True, exist_ok=True)
    tracks_service.add_beatmap_record(
        track.id, beatmap_id, stem,
        folder_name='Test', song_name='Test',
        source_dir=bm_dir, model='madmom', preset=preset,
    )


def _new_track(name: str):
    return tracks_service.create_track(
        name=name, stems={'guitar': 'g.mp3'}, source_stems_dir=Path('.'),
        model='htdemucs', output_format='mp3',
    )


def test_aggregate_filters_by_stems_field(monkeypatch):
    # Stub the preset registry so the test doesn't depend on shipped built-ins.
    from app.routers import generation_presets as gp
    monkeypatch.setattr(gp, 'BUILTIN_PRESETS', [
        {'name': 'v1', 'description': '', 'builtin': True, 'generation': {}},
        {'name': 'drums-v1', 'description': '', 'builtin': True,
         'stems': ['drums'], 'generation': {}},
    ])
    monkeypatch.setattr(gp, '_load_user_presets', lambda: [])

    t1 = _new_track('Song A')
    _seed_beatmap(t1, 'bm-1', stem='guitar', preset='v1')          # universal preset
    _seed_beatmap(t1, 'bm-2', stem='drums',  preset='drums-v1')    # drums-only preset

    feedback_service.add_note(t1.id, 'bm-1', author='alice',
                              rating=3, tags=['too-crampy'], text='guitar feels off')
    feedback_service.add_note(t1.id, 'bm-2', author='alice',
                              rating=2, tags=['too-many-chords'], text='drums too busy')

    drums = feedback_service.aggregate_for_stem('drums')
    # Both beatmaps applied to drums: v1 is universal; drums-v1.stems includes 'drums'.
    assert {g['beatmap_id'] for g in drums} == {'bm-1', 'bm-2'}

    guitar = feedback_service.aggregate_for_stem('guitar')
    # Only bm-1 applies to guitar (drums-v1.stems=['drums'] excludes guitar).
    assert {g['beatmap_id'] for g in guitar} == {'bm-1'}


def test_aggregate_skips_beatmaps_with_no_feedback(monkeypatch):
    from app.routers import generation_presets as gp
    monkeypatch.setattr(gp, 'BUILTIN_PRESETS',
                        [{'name': 'v1', 'description': '', 'builtin': True, 'generation': {}}])
    monkeypatch.setattr(gp, '_load_user_presets', lambda: [])

    t = _new_track('Song X')
    _seed_beatmap(t, 'bm-empty', stem='guitar', preset='v1')

    result = feedback_service.aggregate_for_stem('guitar')
    assert result == []
```

- [ ] **Step 2: Run and confirm pass**

```bash
cd web/backend && ./venv/bin/python -m pytest tests/test_feedback_aggregate.py -v
```

- [ ] **Step 3: Commit**

```bash
git add web/backend/tests/test_feedback_aggregate.py
git commit -m "test(feedback): cover aggregate_for_stem filtering by preset's stems field"
```

---

## Task B4: Frontend — `FeedbackPanel.tsx`

**Files:**
- Create: `web/frontend/src/components/feedback/FeedbackPanel.tsx`

- [ ] **Step 1: Build the panel component**

```tsx
import { useEffect, useMemo, useState } from 'react'

interface FeedbackNote {
  id: string
  created_at: string
  updated_at: string
  author: string
  rating: number
  tags: string[]
  text: string
}

interface FeedbackPanelProps {
  trackId: string
  beatmapId: string
  currentUsername: string
  isAdmin: boolean
  onCountChange?: (count: number) => void
}

let _cachedTags: Record<string, string[]> | null = null

async function fetchTags(): Promise<Record<string, string[]>> {
  if (_cachedTags) return _cachedTags
  const r = await fetch('/api/feedback/tags')
  if (!r.ok) throw new Error('tags fetch failed')
  _cachedTags = await r.json()
  return _cachedTags!
}

export default function FeedbackPanel({
  trackId, beatmapId, currentUsername, isAdmin, onCountChange,
}: FeedbackPanelProps) {
  const [notes, setNotes] = useState<FeedbackNote[]>([])
  const [tagsByCategory, setTagsByCategory] = useState<Record<string, string[]>>({})
  const [draftRating, setDraftRating] = useState(3)
  const [draftTags, setDraftTags] = useState<Set<string>>(new Set())
  const [draftText, setDraftText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState('')

  const url = `/api/feedback/tracks/${trackId}/beatmaps/${beatmapId}`

  const load = async () => {
    const r = await fetch(url)
    if (!r.ok) return
    const data: FeedbackNote[] = await r.json()
    setNotes(data)
    onCountChange?.(data.length)
  }

  useEffect(() => { void load() }, [trackId, beatmapId])
  useEffect(() => { void fetchTags().then(setTagsByCategory) }, [])

  const submit = async () => {
    setErr('')
    if (draftTags.size === 0 && !draftText.trim()) {
      setErr('Add at least one tag or some text.')
      return
    }
    setSubmitting(true)
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: draftRating, tags: [...draftTags], text: draftText }),
      })
      if (!r.ok) { setErr(await r.text()); return }
      setDraftRating(3); setDraftTags(new Set()); setDraftText('')
      await load()
    } finally { setSubmitting(false) }
  }

  const remove = async (id: string) => {
    if (!confirm('Delete this feedback note?')) return
    await fetch(`${url}/${id}`, { method: 'DELETE' })
    await load()
  }

  return (
    <div className="bg-gray-900/40 border border-gray-800 rounded p-3 text-sm">
      <h4 className="font-semibold mb-2">Feedback</h4>
      {notes.length === 0 && <div className="text-gray-500 italic">No feedback yet.</div>}
      <ul className="space-y-2 mb-3">
        {notes.map(n => (
          <li key={n.id} className="bg-gray-950/40 rounded p-2">
            <div className="flex items-center justify-between text-xs text-gray-400">
              <span>{n.author} · {new Date(n.created_at).toLocaleString()} · ★ {n.rating}</span>
              {(n.author === currentUsername || isAdmin) && (
                <button className="text-red-400 hover:text-red-300" onClick={() => remove(n.id)}>×</button>
              )}
            </div>
            {n.tags.length > 0 && (
              <div className="mt-1 flex gap-1 flex-wrap">
                {n.tags.map(t => <span key={t} className="bg-purple-800/30 border border-purple-700/40 px-2 py-0.5 rounded text-xs">{t}</span>)}
              </div>
            )}
            {n.text && <div className="mt-1 text-gray-200 whitespace-pre-wrap">{n.text}</div>}
          </li>
        ))}
      </ul>

      <div className="border-t border-gray-800 pt-2">
        <label className="block text-xs text-gray-400 mb-1">
          Rating: <span className="text-yellow-400">{'★'.repeat(draftRating)}{'☆'.repeat(5 - draftRating)}</span>
          <input type="range" min={1} max={5} value={draftRating}
                 onChange={e => setDraftRating(parseInt(e.target.value, 10))}
                 className="ml-2 align-middle" />
        </label>
        {Object.entries(tagsByCategory).map(([cat, ts]) => (
          <div key={cat} className="mb-1">
            <div className="text-xs text-gray-500">{cat}</div>
            <div className="flex flex-wrap gap-1">
              {ts.map(t => (
                <button key={t} type="button"
                        onClick={() => {
                          const next = new Set(draftTags)
                          if (next.has(t)) next.delete(t); else next.add(t)
                          setDraftTags(next)
                        }}
                        className={`px-2 py-0.5 rounded text-xs border ${draftTags.has(t)
                          ? 'bg-purple-800/40 border-purple-600 text-purple-100'
                          : 'bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200'}`}>
                  {t}
                </button>
              ))}
            </div>
          </div>
        ))}
        <textarea value={draftText} onChange={e => setDraftText(e.target.value)}
                  placeholder="Optional notes — what felt off, what to try next…"
                  className="w-full mt-1 bg-gray-950 border border-gray-800 rounded p-2 text-sm" rows={2} />
        {err && <div className="text-red-400 text-xs mt-1">{err}</div>}
        <button disabled={submitting} onClick={submit}
                className="mt-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white px-3 py-1 rounded text-sm">
          {submitting ? 'Submitting…' : 'Add feedback'}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add web/frontend/src/components/feedback/FeedbackPanel.tsx
git commit -m "feat(feedback): reusable FeedbackPanel component"
```

---

## Task B5: Frontend — `FeedbackButton.tsx` + mount in `TracksPage`

**Files:**
- Create: `web/frontend/src/components/feedback/FeedbackButton.tsx`
- Modify: `web/frontend/src/pages/TracksPage.tsx`

- [ ] **Step 1: Build the button**

```tsx
import { useEffect, useState } from 'react'
import FeedbackPanel from './FeedbackPanel'

interface FeedbackButtonProps {
  trackId: string
  beatmapId: string
  currentUsername: string
  isAdmin: boolean
}

export default function FeedbackButton({ trackId, beatmapId, currentUsername, isAdmin }: FeedbackButtonProps) {
  const [open, setOpen] = useState(false)
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    fetch(`/api/feedback/tracks/${trackId}/beatmaps/${beatmapId}`)
      .then(r => r.ok ? r.json() : [])
      .then((d: unknown[]) => { if (alive) setCount(d.length) })
    return () => { alive = false }
  }, [trackId, beatmapId])

  return (
    <>
      <button onClick={() => setOpen(o => !o)}
              className="bg-gray-700/60 hover:bg-gray-700 text-gray-100 px-2 py-1 rounded text-xs">
        Feedback{count != null && count > 0 ? ` (${count})` : ''}
      </button>
      {open && (
        <div className="col-span-full mt-2">
          <FeedbackPanel trackId={trackId} beatmapId={beatmapId}
                         currentUsername={currentUsername} isAdmin={isAdmin}
                         onCountChange={setCount} />
        </div>
      )}
    </>
  )
}
```

- [ ] **Step 2: Mount in `TracksPage.tsx`**

Find the beatmap-row JSX (the rows shown in the screenshot — they live inside the Beatmaps section of each stem expansion). Each row currently renders `<Edit>` and `<X>` buttons. Add `<FeedbackButton>` next to them, passing `trackId={track.id}`, `beatmapId={bm.id}`, the current session's `username` and `role === 'admin'`.

Locate the existing `useAuth` (or however the session is read) hook at the top of `TracksPage.tsx` and forward `currentUsername` + `isAdmin` to `FeedbackButton`. If no auth hook exists yet, read from `/api/auth/me` on mount.

- [ ] **Step 3: Smoke-test in the browser**

```bash
cd web/frontend && npm run dev
# Visit http://localhost:5173/tracks, expand a stem with beatmaps, click "Feedback",
# add a note, refresh, confirm it persists.
```

- [ ] **Step 4: Commit**

```bash
git add web/frontend/src/components/feedback/FeedbackButton.tsx web/frontend/src/pages/TracksPage.tsx
git commit -m "feat(feedback): mount FeedbackButton on Tracks-page beatmap rows"
```

---

## Task B6: Mount `FeedbackPanel` inside `BeatmapEditor`

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx`

- [ ] **Step 1: Add a collapsible Feedback section in the editor's sidebar**

In `BeatmapEditor.tsx`, find the existing sidebar/right-panel layout and add a new collapsible section labelled "Feedback" that mounts `<FeedbackPanel trackId={trackId} beatmapId={beatmapId} ...>`. The `trackId` and `beatmapId` come from the route params (already destructured via `useParams`).

- [ ] **Step 2: Smoke-test**

Open a beatmap in the editor, add feedback, confirm it appears under the chart's row on TracksPage too.

- [ ] **Step 3: Commit**

```bash
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(feedback): mount FeedbackPanel inside BeatmapEditor sidebar"
```

---

# Phase C — Claude-driven preset proposals

## Task C1: Config + requirements additions

**Files:**
- Modify: `web/backend/app/config.py`
- Modify: `web/backend/requirements.txt`
- Modify: `web/.env.example`

- [ ] **Step 1: Add the three env vars to `config.py`**

Inside the `Settings(BaseSettings)` class (alphabetical with the other fields):

```python
anthropic_api_key: str = ''
anthropic_model: str = 'claude-sonnet-4-6'
anthropic_max_tokens: int = 8192
```

- [ ] **Step 2: Add the SDK to `requirements.txt`**

Add a line `anthropic>=0.40` in the alphabetical block.

- [ ] **Step 3: Document the vars in `web/.env.example`**

```
# Claude integration for the "Propose new presets from feedback" button.
# Get a key from https://console.anthropic.com. Omitted = the endpoint
# returns 503.
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-6
ANTHROPIC_MAX_TOKENS=8192
```

- [ ] **Step 4: Install the new dep**

```bash
cd web/backend && ./venv/bin/pip install -r requirements.txt
```

- [ ] **Step 5: Commit**

```bash
git add web/backend/app/config.py web/backend/requirements.txt web/.env.example
git commit -m "feat(config): add ANTHROPIC_* settings for the preset proposer"
```

---

## Task C2: `preset_proposer` service (TDD)

**Files:**
- Create: `web/backend/app/services/preset_proposer.py`
- Create: `web/backend/tests/test_preset_proposer.py`

- [ ] **Step 1: Write the failing test**

```python
"""Unit tests for the Claude-driven preset proposer.

The Anthropic client is mocked so the tests don't make network calls.
Tests verify (1) the system prompt is built with engine catalog, current
presets, and feedback bundle, (2) the response is parsed into validated
proposals, (3) schema-invalid proposals are dropped, (4) common error
modes raise the right exceptions."""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from app.services import preset_proposer


_VALID_GENERATION = {
    'onsets':         {'engine': 'librosa-onset',   'params': {}},
    'pitches':        {'engine': 'centroid',        'params': {}},
    'quantized':      {'engine': 'metric-weighted', 'params': {}},
    'lanes_expert':   {'engine': 'section-sliding', 'params': {}},
    'lanes_filtered': {'engine': 'identity',        'params': {}},
}


def _mock_response(payload):
    """Build a fake anthropic.Anthropic().messages.create() return value."""
    msg = MagicMock()
    msg.content = [MagicMock(text=json.dumps(payload), type='text')]
    msg.stop_reason = 'end_turn'
    return msg


@pytest.fixture(autouse=True)
def _isolated_settings(monkeypatch):
    """Default to a key being set so tests don't trip the 503 branch."""
    monkeypatch.setattr(preset_proposer.settings, 'anthropic_api_key', 'sk-test')
    monkeypatch.setattr(preset_proposer.settings, 'anthropic_model', 'claude-sonnet-4-6')
    monkeypatch.setattr(preset_proposer.settings, 'anthropic_max_tokens', 1024)


@patch('app.services.preset_proposer._anthropic_client')
def test_returns_validated_proposals(mock_client, monkeypatch):
    monkeypatch.setattr(preset_proposer, 'aggregate_for_stem',
                        lambda s: [{'track_name': 'A', 'preset_name': 'v1', 'beatmap_id': 'b1',
                                    'beatmap_name': 'V1', 'notes': [
                                        {'author': 'alice', 'rating': 2,
                                         'tags': ['too-crampy'], 'text': 'cramped'}]}])

    mock_client.messages.create.return_value = _mock_response({
        'proposals': [
            {'name': 'v12-anti-cramp', 'description': 'Less crampy',
             'generation': _VALID_GENERATION,
             'stems': ['drums'],
             'rationale': 'Cites A/v1 cramp complaint.'},
        ],
    })

    result = preset_proposer.propose_presets('drums', n=3)
    assert len(result) == 1
    assert result[0]['name'] == 'v12-anti-cramp'
    assert result[0]['generation'] == _VALID_GENERATION


@patch('app.services.preset_proposer._anthropic_client')
def test_drops_schema_invalid_proposals(mock_client, monkeypatch):
    monkeypatch.setattr(preset_proposer, 'aggregate_for_stem',
                        lambda s: [{'track_name': 'A', 'preset_name': 'v1', 'beatmap_id': 'b1',
                                    'beatmap_name': 'V1', 'notes': [{'rating': 1, 'tags': [], 'text': 'bad'}]}])
    bad_gen = {'onsets': {'engine': 'x'}}  # missing pitches/quantized/lanes_*
    mock_client.messages.create.return_value = _mock_response({
        'proposals': [
            {'name': 'good', 'description': '', 'generation': _VALID_GENERATION, 'rationale': 'r'},
            {'name': 'bad', 'description': '', 'generation': bad_gen, 'rationale': 'r'},
        ],
    })
    result = preset_proposer.propose_presets('drums', n=3)
    assert [p['name'] for p in result] == ['good']


def test_missing_api_key_raises(monkeypatch):
    monkeypatch.setattr(preset_proposer.settings, 'anthropic_api_key', '')
    with pytest.raises(preset_proposer.ProposalError) as ei:
        preset_proposer.propose_presets('drums', n=3)
    assert 'not configured' in str(ei.value).lower()


@patch('app.services.preset_proposer._anthropic_client')
def test_empty_feedback_raises(mock_client, monkeypatch):
    monkeypatch.setattr(preset_proposer, 'aggregate_for_stem', lambda s: [])
    with pytest.raises(preset_proposer.ProposalError) as ei:
        preset_proposer.propose_presets('drums', n=3)
    assert 'no feedback' in str(ei.value).lower()


@patch('app.services.preset_proposer._anthropic_client')
def test_invalid_json_response_raises(mock_client, monkeypatch):
    monkeypatch.setattr(preset_proposer, 'aggregate_for_stem',
                        lambda s: [{'track_name': 'A', 'preset_name': 'v1', 'beatmap_id': 'b1',
                                    'beatmap_name': 'V1', 'notes': [{'rating': 1, 'tags': [], 'text': 'x'}]}])
    msg = MagicMock()
    msg.content = [MagicMock(text='not valid json {', type='text')]
    mock_client.messages.create.return_value = msg
    with pytest.raises(preset_proposer.ProposalError) as ei:
        preset_proposer.propose_presets('drums', n=3)
    assert 'invalid json' in str(ei.value).lower()
```

- [ ] **Step 2: Implement the service**

Create `web/backend/app/services/preset_proposer.py`:

```python
"""Anthropic-backed preset proposer.

Reads aggregated feedback for a stem + the current preset library + the
engine catalog, builds a system prompt with prompt caching on the
large prefix, calls Claude, parses the response, and returns
schema-validated proposals.

The caller (the generation_presets router) is responsible for HTTP
response shaping. This module raises ProposalError for all user-facing
failure modes."""
from __future__ import annotations

import json
import re
from typing import Any

import anthropic

from ..config import settings
from .feedback import FEEDBACK_TAGS, aggregate_for_stem


class ProposalError(RuntimeError):
    pass


_PROPOSAL_SCHEMA_INSTRUCTIONS = """
Return JSON with this exact shape:

{
  "proposals": [
    {
      "name": "<short slug-style name, e.g. v12-anti-cramp>",
      "description": "<one sentence — what this preset addresses>",
      "stems": ["<stem>"] | null,
      "generation": {
        "onsets":         {"engine": "<one of the catalogued engine ids>", "params": {...}},
        "pitches":        {"engine": "...", "params": {...}},
        "quantized":      {"engine": "...", "params": {...}},
        "lanes_expert":   {"engine": "...", "params": {...}},
        "lanes_filtered": {"engine": "...", "params": {...}}
      },
      "rationale": "<paragraph citing specific feedback by (track_name, preset_name) and explaining why this preset addresses it>"
    }
  ]
}

Hard rules:
- Use only engines that appear in the engine catalog above.
- `rationale` MUST cite at least one feedback note by its (track_name, preset_name).
- Return at most `n` proposals. Return fewer if you don't see distinct patterns worth N proposals.
- Do NOT propose presets that duplicate the current preset library.
- Output ONLY the JSON object — no surrounding prose, no markdown fences.
"""


def _anthropic_client_factory():
    return anthropic.Anthropic(api_key=settings.anthropic_api_key)


# Module-level so tests can patch it.
_anthropic_client: Any = None


def _build_engine_catalog_text() -> str:
    """Pull the engine catalog from the registry and render as a stable text block."""
    from .pipeline.registry import engines_catalog
    cat = engines_catalog()  # {stage: [{name, label, params}, ...]}
    parts = ['## Engine catalog\n']
    for stage, engines in cat.items():
        parts.append(f'### {stage}')
        for e in engines:
            params_text = ', '.join(p['name'] for p in (e.get('params') or [])) or '(no params)'
            parts.append(f"- `{e['name']}` — {e.get('label', '')}; params: {params_text}")
        parts.append('')
    return '\n'.join(parts)


def _build_existing_presets_text(stem: str) -> str:
    from ..routers.generation_presets import BUILTIN_PRESETS, _load_user_presets
    relevant = []
    for p in list(BUILTIN_PRESETS) + _load_user_presets():
        s = p.get('stems') or []
        if not s or stem in s:
            relevant.append(p)
    lines = [f'## Existing presets applicable to stem "{stem}"\n']
    for p in relevant:
        lines.append(f"- **{p['name']}** — {p.get('description', '')}; engines: {json.dumps(p.get('generation', {}))}")
    return '\n'.join(lines)


def _build_system_prompt(stem: str) -> list[dict]:
    """System prompt is split into a stable (cacheable) prefix and a small tail."""
    prefix = (
        f"You are an audio engineering assistant proposing new chart-generation presets "
        f"for the Jamsesh rhythm game. Each preset configures five pipeline stages "
        f"(onsets, pitches, quantized, lanes_expert, lanes_filtered). You will be given "
        f"player feedback on charts generated with the existing presets for the **{stem}** "
        f"stem; your job is to propose up to N new presets that address recurring complaints "
        f"and aren't already covered.\n\n"
        f"{_build_engine_catalog_text()}\n\n"
        f"{_build_existing_presets_text(stem)}\n\n"
        f"## Tag vocabulary used in player feedback\n{json.dumps(FEEDBACK_TAGS, indent=2)}\n\n"
        f"{_PROPOSAL_SCHEMA_INSTRUCTIONS}"
    )
    return [{
        'type': 'text',
        'text': prefix,
        'cache_control': {'type': 'ephemeral'},
    }]


def _build_user_prompt(stem: str, n: int, aggregated: list[dict]) -> str:
    lines = [f'# Feedback corpus for stem: {stem}', f'Propose up to N={n} presets.\n']
    for group in aggregated:
        lines.append(f"## Track: {group['track_name']} — preset: {group['preset_name']} (beatmap_id: {group['beatmap_id']})")
        for note in group['notes']:
            tags = ', '.join(note.get('tags') or [])
            lines.append(f"- rating {note['rating']}, tags [{tags}] — \"{note.get('text', '')}\" (by {note.get('author', '?')})")
        lines.append('')
    return '\n'.join(lines)


def _extract_json(text: str) -> dict:
    """Tolerate small wrapping (e.g. accidental code fences) but require a JSON object."""
    text = text.strip()
    # Strip a wrapping ```json ... ``` if present.
    fence = re.match(r'^```(?:json)?\s*(.*?)\s*```$', text, re.DOTALL)
    if fence:
        text = fence.group(1)
    return json.loads(text)


def _validate_proposal(p: Any) -> dict | None:
    """Reject anything that can't pass the existing preset schema check."""
    if not isinstance(p, dict):
        return None
    if not isinstance(p.get('name'), str) or not p['name'].strip():
        return None
    if not isinstance(p.get('generation'), dict):
        return None
    try:
        from ..routers.generation_presets import _validate_generation
        gen = _validate_generation(p['generation'])
    except Exception:
        return None
    out = {
        'name': p['name'].strip(),
        'description': str(p.get('description', '')).strip(),
        'generation': gen,
        'rationale': str(p.get('rationale', '')).strip(),
    }
    stems = p.get('stems')
    if isinstance(stems, list) and all(isinstance(s, str) for s in stems) and stems:
        out['stems'] = stems
    return out


def propose_presets(stem: str, n: int) -> list[dict]:
    global _anthropic_client
    if not settings.anthropic_api_key:
        raise ProposalError('Anthropic API key not configured')
    if _anthropic_client is None:
        _anthropic_client = _anthropic_client_factory()

    aggregated = aggregate_for_stem(stem)
    if not aggregated:
        raise ProposalError(f"No feedback to aggregate for stem '{stem}'")

    system_blocks = _build_system_prompt(stem)
    user_text = _build_user_prompt(stem, n, aggregated)

    try:
        message = _anthropic_client.messages.create(
            model=settings.anthropic_model,
            max_tokens=settings.anthropic_max_tokens,
            system=system_blocks,
            messages=[{'role': 'user', 'content': user_text}],
        )
    except anthropic.APIError as e:
        raise ProposalError(f'Anthropic API error: {e}') from e

    raw = ''.join(b.text for b in message.content if getattr(b, 'type', '') == 'text')
    try:
        payload = _extract_json(raw)
    except json.JSONDecodeError as e:
        raise ProposalError(f'Claude returned invalid JSON: {e}') from e

    proposals = payload.get('proposals')
    if not isinstance(proposals, list) or not proposals:
        raise ProposalError('Response contained no proposals')

    valid = [v for v in (_validate_proposal(p) for p in proposals) if v]
    if not valid:
        raise ProposalError('No valid proposals returned')
    return valid[:n]
```

- [ ] **Step 3: Run the tests and confirm pass**

```bash
cd web/backend && ./venv/bin/python -m pytest tests/test_preset_proposer.py -v
```

- [ ] **Step 4: Commit**

```bash
git add web/backend/app/services/preset_proposer.py web/backend/tests/test_preset_proposer.py
git commit -m "feat(proposer): Anthropic-backed preset proposer service with schema validation"
```

---

## Task C3: `propose-from-feedback` endpoint

**Files:**
- Modify: `web/backend/app/routers/generation_presets.py`

- [ ] **Step 1: Add the endpoint at the bottom of the router file**

```python
@router.post('/propose-from-feedback')
async def propose_from_feedback(
    stem: str = Query(...),
    n: int = Query(default=3, ge=1, le=5),
    _admin: dict = Depends(require_admin),
) -> dict[str, list[dict[str, Any]]]:
    """Aggregate feedback for `stem`, call Claude, return validated drafts.
    Admin-only. No persistence — the user saves the drafts they want via
    the normal POST / endpoint."""
    from ..services.preset_proposer import propose_presets, ProposalError
    try:
        proposals = propose_presets(stem, n)
    except ProposalError as e:
        msg = str(e)
        if 'not configured' in msg.lower():
            raise HTTPException(503, msg)
        if 'no feedback' in msg.lower():
            raise HTTPException(422, msg)
        raise HTTPException(502, msg)
    return {'proposals': proposals}
```

Imports to add at the top of the file:

```python
from fastapi import Depends, Query
from .auth import require_admin
```

- [ ] **Step 2: Smoke-test in dev**

```bash
cd web/backend && ./venv/bin/python run.py
# In another shell, with an admin session cookie/token:
curl -X POST 'http://localhost:8000/api/generation-presets/propose-from-feedback?stem=drums&n=2' \
     -H 'Authorization: Bearer <token>'
```
Expected: 503 (api key not configured) — or, with `ANTHROPIC_API_KEY` set and feedback present, a JSON `{proposals: [...]}`.

- [ ] **Step 3: Commit**

```bash
git add web/backend/app/routers/generation_presets.py
git commit -m "feat(presets): admin endpoint to propose new presets from feedback"
```

---

## Task C4: Frontend — `GenerationPresetsPage`

**Files:**
- Create: `web/frontend/src/pages/GenerationPresetsPage.tsx`
- Create: `web/frontend/src/components/presets/ProposalReviewModal.tsx`
- Modify: `web/frontend/src/App.tsx` (add `/presets` route)

- [ ] **Step 1: Build the page**

```tsx
import { useEffect, useState } from 'react'
import ProposalReviewModal, { Proposal } from '../components/presets/ProposalReviewModal'

interface Preset {
  name: string
  description?: string
  builtin?: boolean
  stems?: string[]
  generation: Record<string, { engine: string; params: Record<string, unknown> }>
}

const STEM_ORDER = ['drums', 'guitar', 'bass', 'vocal'] as const

export default function GenerationPresetsPage() {
  const [presets, setPresets] = useState<Preset[]>([])
  const [proposingStem, setProposingStem] = useState<string | null>(null)
  const [proposing, setProposing] = useState(false)
  const [error, setError] = useState('')
  const [proposals, setProposals] = useState<Proposal[]>([])

  const load = () => fetch('/api/generation-presets').then(r => r.json()).then(setPresets)
  useEffect(() => { void load() }, [])

  const groups = (() => {
    const universal: Preset[] = []
    const byStem: Record<string, Preset[]> = {}
    for (const p of presets) {
      if (!p.stems || p.stems.length === 0) { universal.push(p); continue }
      for (const s of p.stems) (byStem[s] ??= []).push(p)
    }
    return { universal, byStem }
  })()

  const propose = async (stem: string) => {
    setProposingStem(stem); setProposing(true); setError(''); setProposals([])
    try {
      const r = await fetch(`/api/generation-presets/propose-from-feedback?stem=${stem}&n=3`, { method: 'POST' })
      if (!r.ok) { setError(await r.text()); return }
      const data = await r.json()
      setProposals(data.proposals)
    } finally { setProposing(false) }
  }

  return (
    <div className="p-6 text-gray-200">
      <h1 className="text-2xl font-bold mb-4">Generation Presets</h1>

      {groups.universal.length > 0 && (
        <PresetGroup heading="Universal" stem={null} presets={groups.universal} onPropose={() => {}} proposing={false} />
      )}
      {STEM_ORDER.filter(s => groups.byStem[s]?.length).map(stem => (
        <PresetGroup key={stem} heading={stem[0].toUpperCase() + stem.slice(1)}
                     stem={stem} presets={groups.byStem[stem] || []}
                     onPropose={() => propose(stem)}
                     proposing={proposing && proposingStem === stem} />
      ))}

      {(proposing || proposals.length > 0) && proposingStem && (
        <ProposalReviewModal
          stem={proposingStem}
          loading={proposing}
          proposals={proposals}
          error={error}
          onClose={() => { setProposingStem(null); setProposals([]); setError('') }}
          onSaved={() => { void load() }}
        />
      )}
    </div>
  )
}

function PresetGroup({ heading, stem, presets, onPropose, proposing }: {
  heading: string
  stem: string | null
  presets: Preset[]
  onPropose: () => void
  proposing: boolean
}) {
  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold">{heading}</h2>
        {stem && (
          <button onClick={onPropose} disabled={proposing}
                  className="bg-purple-700 hover:bg-purple-600 disabled:opacity-50 px-3 py-1 rounded text-sm">
            {proposing ? 'Asking Claude…' : 'Propose new presets from feedback'}
          </button>
        )}
      </div>
      <ul className="space-y-2">
        {presets.map(p => (
          <li key={p.name} className="bg-gray-900/40 border border-gray-800 rounded p-3">
            <div className="font-semibold">{p.name} {p.builtin && <span className="text-xs text-gray-500">(built-in)</span>}</div>
            {p.description && <div className="text-sm text-gray-400">{p.description}</div>}
            <div className="text-xs text-gray-500 mt-1">
              {Object.entries(p.generation).map(([stage, cfg]) =>
                <span key={stage} className="mr-3">{stage}: <code>{cfg.engine}</code></span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
```

- [ ] **Step 2: Build the review modal**

```tsx
// web/frontend/src/components/presets/ProposalReviewModal.tsx
import { useState } from 'react'

export interface Proposal {
  name: string
  description: string
  generation: Record<string, { engine: string; params: Record<string, unknown> }>
  stems?: string[]
  rationale: string
}

interface Props {
  stem: string
  loading: boolean
  proposals: Proposal[]
  error: string
  onClose: () => void
  onSaved: () => void
}

export default function ProposalReviewModal({ stem, loading, proposals, error, onClose, onSaved }: Props) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-lg max-w-6xl w-full max-h-[90vh] overflow-auto p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xl font-semibold">Proposals for {stem}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-200">×</button>
        </div>
        {loading && <div className="py-8 text-center text-gray-400">Asking Claude to read your feedback and propose new presets…</div>}
        {error && <div className="bg-red-900/30 border border-red-800 text-red-200 p-2 rounded mb-3">{error}</div>}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
          {proposals.map((p, i) => <ProposalCard key={i} proposal={p} onSaved={onSaved} />)}
        </div>
      </div>
    </div>
  )
}

function ProposalCard({ proposal, onSaved }: { proposal: Proposal; onSaved: () => void }) {
  const [name, setName] = useState(proposal.name)
  const [description, setDescription] = useState(proposal.description)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    setError('')
    const body = { name, description, generation: proposal.generation, stems: proposal.stems }
    const r = await fetch('/api/generation-presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) { setError(await r.text()); return }
    setSaved(true); onSaved()
  }

  return (
    <div className={`border rounded p-3 ${saved ? 'border-green-700 bg-green-900/10' : 'border-gray-700 bg-gray-950/40'}`}>
      <input value={name} onChange={e => setName(e.target.value)} disabled={saved}
             className="w-full bg-gray-900 border border-gray-700 rounded p-1 mb-2 font-semibold" />
      <textarea value={description} onChange={e => setDescription(e.target.value)} disabled={saved} rows={2}
                className="w-full bg-gray-900 border border-gray-700 rounded p-1 mb-2 text-sm" />
      <div className="text-xs text-gray-400 mb-2">
        {Object.entries(proposal.generation).map(([stage, cfg]) =>
          <div key={stage}><strong>{stage}:</strong> <code>{cfg.engine}</code> {Object.keys(cfg.params).length > 0 && <span className="text-gray-500">{JSON.stringify(cfg.params)}</span>}</div>
        )}
      </div>
      <div className="text-xs text-gray-500 italic mb-2 whitespace-pre-wrap">{proposal.rationale}</div>
      {proposal.stems && proposal.stems.length > 0 && (
        <div className="text-xs text-gray-400 mb-2">Stems: {proposal.stems.join(', ')}</div>
      )}
      {error && <div className="text-xs text-red-400 mb-2">{error}</div>}
      <button onClick={save} disabled={saved}
              className="w-full bg-purple-700 hover:bg-purple-600 disabled:opacity-50 py-1 rounded text-sm">
        {saved ? 'Saved' : 'Save preset'}
      </button>
    </div>
  )
}
```

- [ ] **Step 3: Wire the route in `App.tsx`**

Add an import + route alongside the existing ones, gated by an admin check. If there's no `useSession` hook yet, use whatever the existing admin-only `/users` route does:

```tsx
import GenerationPresetsPage from './pages/GenerationPresetsPage'
// ...
<Route path="/presets" element={<RequireAdmin><GenerationPresetsPage /></RequireAdmin>} />
```

If a `RequireAdmin` wrapper doesn't exist yet, copy the pattern that protects `/users`.

Also add a nav link in whichever header component lists Tracks/Users/Logs/etc.

- [ ] **Step 4: Smoke-test**

```bash
cd web/frontend && npm run dev
# Visit /presets as an admin user.
# Click "Propose new presets from feedback" on a stem group.
# With ANTHROPIC_API_KEY unset: confirm the modal shows the 503 error.
# With key set and feedback present: confirm proposals render and Save works.
```

- [ ] **Step 5: Commit**

```bash
git add web/frontend/src/pages/GenerationPresetsPage.tsx \
         web/frontend/src/components/presets/ProposalReviewModal.tsx \
         web/frontend/src/App.tsx
git commit -m "feat(presets): admin page + Claude proposal review modal"
```

---

# Final verification

- [ ] **Step 1: Run the full backend test suite**

```bash
cd web/backend && ./venv/bin/python -m pytest -q
```
Expected: all green.

- [ ] **Step 2: Build the frontend**

```bash
cd web/frontend && npm run build
```
Expected: tsc + vite build succeed with no errors.

- [ ] **Step 3: Manual smoke-walk**

1. As an admin, log in.
2. Generate at least two beatmaps on one stem (uses Phase A's section numbering on publish).
3. Publish to game; open the resulting `song.ini`; confirm `[beatmap_1]` and `[beatmap_2]` blocks exist.
4. On the Tracks page, click "Feedback" on a beatmap row; add a note with a tag, rating, and text.
5. Re-open the panel; confirm the note shows your username + rating + tags + text.
6. As a different user, edit your own note — confirm 200; try to edit someone else's — confirm 403.
7. Visit `/presets`; confirm the preset list shows grouped by stem.
8. With `ANTHROPIC_API_KEY` set, click "Propose new presets from feedback" on a stem with feedback; confirm proposals render with rationale; Save one; confirm it appears in the preset list.

- [ ] **Step 4: Push**

```bash
git push origin main
```

Per the user's standing deploy rule, push includes the droplet deploy:

```bash
ssh -i ~/.ssh/id_ed25519_beatmap root@137.184.217.203 \
  "cd /opt/madmom && git fetch origin main && git reset --hard origin/main \
   && cd web/frontend && npm run build 2>&1 | tail -8 \
   && systemctl restart beatmap-backend && systemctl is-active beatmap-backend"
```

Confirm the deploy succeeded and that the new `/presets` route loads on beatmap.jamsesh.co.
