# Clone-Difficulty-Across-Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a charter copy one difficulty from one chart into another chart (same stem) on a multichart track, straight from the Studio Library list — with independent source/target difficulty slots and an overwrite confirm.

**Architecture:** A pure chart-text splice helper in `chart_generator.py` does the section lift + tick rescale + replace/insert. A thin service in `tracks.py` wraps it with track/beatmap lookup and same-stem + section-family validation. Two endpoints expose it: a small `GET …/difficulties` (drives the picker dropdowns + overwrite warning) and the `POST …/clone-difficulty` action. A `TracksPage` modal drives the picker.

**Tech Stack:** Python 3.9+, FastAPI, pytest (backend); React 18 + TypeScript + Vite (frontend).

---

## File Structure

- `web/backend/app/services/chart_generator.py` — add pure helpers `splice_difficulty()` and `chart_difficulties()` (they live with the existing section regex + `STEM_TO_SECTION_SUFFIX`).
- `web/backend/app/services/tracks.py` — add `CloneDifficultyError` and `clone_difficulty_across_beatmaps()`.
- `web/backend/app/routers/tracks.py` — add `GET /{track_id}/beatmaps/{beatmap_id}/difficulties` and `POST /{track_id}/beatmaps/{target_id}/clone-difficulty`.
- `web/backend/tests/test_splice_difficulty.py` — NEW. Pure-helper unit tests.
- `web/backend/tests/test_clone_difficulty_service.py` — NEW. Service tests with a Track + two beatmap dirs.
- `web/backend/tests/test_clone_difficulty_endpoint.py` — NEW. Endpoint tests via TestClient.
- `web/frontend/src/components/tracks/CloneDifficultyModal.tsx` — NEW. The picker modal.
- `web/frontend/src/pages/TracksPage.tsx` — wire a "Clone diff" button per chart row that opens the modal.

---

## Task 1: Pure splice + difficulty-listing helpers

**Files:**
- Modify: `web/backend/app/services/chart_generator.py`
- Test: `web/backend/tests/test_splice_difficulty.py`

- [ ] **Step 1: Write the failing tests**

Create `web/backend/tests/test_splice_difficulty.py`:

```python
"""Unit tests for the pure chart-splice helpers used by the cross-chart
difficulty clone. No filesystem or audio — just chart text in/out.
"""
from __future__ import annotations

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
    # HardSingle in target now holds the source Expert notes, ticks unchanged.
    assert '[HardSingle]\n{\n  0 = N 0 0\n  192 = N 1 0\n}\n' in new_text
    # Target's own ExpertSingle is untouched.
    assert '[ExpertSingle]\n{\n  0 = N 4 0\n}\n' in new_text


def test_splice_rescales_ticks_when_resolution_differs():
    src = _chart(resolution=192, expert='  0 = N 0 0\n  192 = N 1 0')
    tgt = _chart(resolution=480, expert='  0 = N 0 0')
    new_text, _ = splice_difficulty(src, 'ExpertSingle', tgt, 'HardSingle')
    # 192 * 480/192 = 480; tick 0 stays 0; payload preserved.
    assert '[HardSingle]\n{\n  0 = N 0 0\n  480 = N 1 0\n}\n' in new_text


def test_splice_inserts_when_target_slot_empty():
    src = _chart(expert='  0 = N 0 0')
    tgt = _chart(expert='  0 = N 4 0')  # no HardSingle present
    new_text, overwrote = splice_difficulty(src, 'ExpertSingle', tgt, 'HardSingle')
    assert overwrote is False
    assert '[HardSingle]\n{\n  0 = N 0 0\n}\n' in new_text


def test_splice_missing_source_difficulty_raises():
    src = _chart(expert='  0 = N 0 0')  # no HardSingle
    tgt = _chart(expert='  0 = N 0 0')
    try:
        splice_difficulty(src, 'HardSingle', tgt, 'HardSingle')
        assert False, 'expected ValueError'
    except ValueError as e:
        assert 'HardSingle' in str(e)


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
    assert names == ['ExpertSingle']  # Song/SyncTrack/Events excluded
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest web/backend/tests/test_splice_difficulty.py -v`
Expected: FAIL with `ImportError: cannot import name 'splice_difficulty'`.

- [ ] **Step 3: Implement the helpers**

In `web/backend/app/services/chart_generator.py`, after the `STEM_TO_SECTION_SUFFIX` definition (around line 68), add:

```python
_DIFFICULTY_PREFIXES = ('Expert', 'Hard', 'Medium', 'Easy')


def _read_resolution(chart_text: str) -> int | None:
    """Parse `[Song] Resolution = N`. Returns None if not found."""
    m = re.search(r'\[Song\]\s*\{([^}]*)\}', chart_text)
    if not m:
        return None
    rm = re.search(r'(?im)^\s*Resolution\s*=\s*(\d+)', m.group(1))
    return int(rm.group(1)) if rm else None


def _extract_section_body(chart_text: str, section: str) -> str | None:
    """Return the brace body of [section], or None if the section is absent."""
    m = re.search(r'\[' + re.escape(section) + r'\]\s*\{([^}]*)\}', chart_text)
    return m.group(1) if m else None


def _rescale_block(body: str, ratio: float) -> str:
    """Scale the leading tick of each `  <tick> = <event>` line by `ratio`.
    Non-event lines (blank, braces already stripped) pass through unchanged."""
    if ratio == 1.0:
        return body
    out = []
    for line in body.split('\n'):
        m = re.match(r'^(\s*)(\d+)(\s*=.*)$', line)
        if m:
            out.append(f'{m.group(1)}{round(int(m.group(2)) * ratio)}{m.group(3)}')
        else:
            out.append(line)
    return '\n'.join(out)


def splice_difficulty(
    source_chart_text: str,
    source_difficulty: str,
    target_chart_text: str,
    target_difficulty: str,
) -> tuple[str, bool]:
    """Lift `[source_difficulty]` out of the source chart and write it into the
    target chart as `[target_difficulty]`, rescaling note ticks when the two
    charts have different `[Song] Resolution`. Replaces an existing target block
    in place (preserving every other section) or appends if the slot is empty.

    Returns `(new_target_chart_text, overwrote)` where `overwrote` is True when
    the target slot already held a block. Raises ValueError if the source chart
    has no `[source_difficulty]` section.
    """
    src_body = _extract_section_body(source_chart_text, source_difficulty)
    if src_body is None:
        raise ValueError(f'source chart has no [{source_difficulty}] section')

    src_res = _read_resolution(source_chart_text)
    tgt_res = _read_resolution(target_chart_text)
    ratio = (tgt_res / src_res) if (src_res and tgt_res and src_res != tgt_res) else 1.0
    new_body = _rescale_block(src_body, ratio)
    new_block = f'[{target_difficulty}]\n{{{new_body}}}\n'

    pattern = re.compile(r'\[' + re.escape(target_difficulty) + r'\]\s*\{[^}]*\}\n?')
    if pattern.search(target_chart_text):
        # Use a function replacement so backslashes/braces in new_block are literal.
        return pattern.sub(lambda _m: new_block, target_chart_text, count=1), True

    sep = '' if (not target_chart_text or target_chart_text.endswith('\n')) else '\n'
    return target_chart_text + sep + new_block, False


def chart_difficulties(chart_text: str) -> list[dict]:
    """List the difficulty sections present in a chart as
    `[{'name': 'ExpertSingle', 'note_count': 12}, ...]`. Only sections whose
    name is `<prefix><suffix>` (e.g. ExpertSingle, HardDrums) are reported;
    `[Song]`/`[SyncTrack]`/`[Events]`/`[Beatmaps]` are skipped."""
    suffixes = set(STEM_TO_SECTION_SUFFIX.values())
    out: list[dict] = []
    for m in re.finditer(r'\[([A-Za-z]+)\]\s*\{([^}]*)\}', chart_text):
        name = m.group(1)
        if not any(name.startswith(p) for p in _DIFFICULTY_PREFIXES):
            continue
        if not any(name.endswith(s) for s in suffixes):
            continue
        note_count = sum(1 for ln in m.group(2).split('\n') if re.search(r'=\s*N\s', ln))
        out.append({'name': name, 'note_count': note_count})
    return out
```

Confirm `import re` is already present at the top of `chart_generator.py` (it is — `merge_charts` uses `re.search`). If not, add it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest web/backend/tests/test_splice_difficulty.py -v`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add web/backend/app/services/chart_generator.py web/backend/tests/test_splice_difficulty.py
git commit -m "feat(chart): pure splice_difficulty + chart_difficulties helpers"
```

---

## Task 2: Service `clone_difficulty_across_beatmaps`

**Files:**
- Modify: `web/backend/app/services/tracks.py`
- Test: `web/backend/tests/test_clone_difficulty_service.py`

- [ ] **Step 1: Write the failing tests**

Create `web/backend/tests/test_clone_difficulty_service.py`:

```python
"""Service tests for clone_difficulty_across_beatmaps — builds a Track with two
guitar beatmap dirs on disk and asserts the target notes.chart is spliced."""
from __future__ import annotations

import time
from pathlib import Path

import pytest


@pytest.fixture
def track_with_two_guitar_beatmaps(tmp_path, monkeypatch):
    from app.config import settings
    from app.services import tracks as tracks_mod
    from app.services.tracks import Track

    upload_dir = tmp_path / 'uploads'
    tracks_dir = upload_dir / '_tracks'
    tracks_dir.mkdir(parents=True)
    monkeypatch.setattr(settings, 'upload_dir', str(upload_dir))
    monkeypatch.setattr(tracks_mod, 'TRACKS_DIR', tracks_dir)

    tid = 'trk1'
    t = Track(id=tid, name='Test', created_at=time.time(),
              stems={'guitar': 'guitar.ogg'}, model='demucs', output_format='ogg')
    t.beatmaps = [
        {'id': 'src', 'stem': 'guitar', 'preset': 'v8', 'active': True, 'generated_at': 1.0},
        {'id': 'dst', 'stem': 'guitar', 'preset': 'v11', 'active': False, 'generated_at': 2.0},
        {'id': 'drm', 'stem': 'drums', 'preset': 'd1', 'active': True, 'generated_at': 3.0},
    ]
    t.save()

    def _chart(expert, hard=None, resolution=192):
        parts = [
            f'[Song]\n{{\n  Resolution = {resolution}\n}}\n',
            '[SyncTrack]\n{\n  0 = B 120000\n}\n',
            f'[ExpertSingle]\n{{\n{expert}\n}}\n',
        ]
        if hard is not None:
            parts.append(f'[HardSingle]\n{{\n{hard}\n}}\n')
        return ''.join(parts)

    for bid, text in (
        ('src', _chart('  0 = N 0 0\n  192 = N 1 0')),
        ('dst', _chart('  0 = N 4 0', hard='  0 = N 2 0')),
        ('drm', '[Song]\n{\n  Resolution = 192\n}\n[ExpertDrums]\n{\n  0 = N 0 0\n}\n'),
    ):
        d = t.beatmaps_dir / bid
        d.mkdir(parents=True)
        (d / 'notes.chart').write_text(text, encoding='utf-8')

    return tid, t.beatmaps_dir


def test_clone_overwrites_target_difficulty(track_with_two_guitar_beatmaps):
    from app.services.tracks import clone_difficulty_across_beatmaps
    tid, bdir = track_with_two_guitar_beatmaps
    result = clone_difficulty_across_beatmaps(tid, 'src', 'ExpertSingle', 'dst', 'HardSingle')
    assert result['overwrote'] is True
    assert result['target_difficulty'] == 'HardSingle'
    txt = (bdir / 'dst' / 'notes.chart').read_text(encoding='utf-8')
    assert '[HardSingle]\n{\n  0 = N 0 0\n  192 = N 1 0\n}\n' in txt
    # dst's own ExpertSingle untouched.
    assert '[ExpertSingle]\n{\n  0 = N 4 0\n}\n' in txt


def test_clone_into_empty_slot_reports_not_overwrote(track_with_two_guitar_beatmaps):
    from app.services.tracks import clone_difficulty_across_beatmaps
    tid, bdir = track_with_two_guitar_beatmaps
    result = clone_difficulty_across_beatmaps(tid, 'src', 'ExpertSingle', 'dst', 'EasySingle')
    assert result['overwrote'] is False
    txt = (bdir / 'dst' / 'notes.chart').read_text(encoding='utf-8')
    assert '[EasySingle]\n{\n  0 = N 0 0\n  192 = N 1 0\n}\n' in txt


def test_clone_cross_stem_raises(track_with_two_guitar_beatmaps):
    from app.services.tracks import CloneDifficultyError, clone_difficulty_across_beatmaps
    tid, _ = track_with_two_guitar_beatmaps
    with pytest.raises(CloneDifficultyError):
        clone_difficulty_across_beatmaps(tid, 'src', 'ExpertSingle', 'drm', 'ExpertDrums')


def test_clone_mismatched_section_family_raises(track_with_two_guitar_beatmaps):
    from app.services.tracks import CloneDifficultyError, clone_difficulty_across_beatmaps
    tid, _ = track_with_two_guitar_beatmaps
    # Both beatmaps are guitar (*Single) — asking for a *Drums target is invalid.
    with pytest.raises(CloneDifficultyError):
        clone_difficulty_across_beatmaps(tid, 'src', 'ExpertSingle', 'dst', 'HardDrums')


def test_clone_missing_source_difficulty_raises(track_with_two_guitar_beatmaps):
    from app.services.tracks import CloneDifficultyError, clone_difficulty_across_beatmaps
    tid, _ = track_with_two_guitar_beatmaps
    # src has no MediumSingle.
    with pytest.raises(CloneDifficultyError):
        clone_difficulty_across_beatmaps(tid, 'src', 'MediumSingle', 'dst', 'HardSingle')


def test_clone_unknown_beatmap_returns_none(track_with_two_guitar_beatmaps):
    from app.services.tracks import clone_difficulty_across_beatmaps
    tid, _ = track_with_two_guitar_beatmaps
    assert clone_difficulty_across_beatmaps(tid, 'nope', 'ExpertSingle', 'dst', 'HardSingle') is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest web/backend/tests/test_clone_difficulty_service.py -v`
Expected: FAIL with `ImportError: cannot import name 'clone_difficulty_across_beatmaps'`.

- [ ] **Step 3: Implement the service**

In `web/backend/app/services/tracks.py`, add near the other beatmap helpers (e.g. just after `clone_beatmap_record`, around line 311):

```python
class CloneDifficultyError(Exception):
    """Raised for cross-stem / mismatched-family / missing-source-section
    clone-difficulty attempts. The router maps it to HTTP 422."""


def clone_difficulty_across_beatmaps(
    track_id: str,
    source_beatmap_id: str,
    source_difficulty: str,
    target_beatmap_id: str,
    target_difficulty: str,
) -> dict | None:
    """Copy one difficulty section from one beatmap's notes.chart into another
    beatmap's notes.chart on the same track. Both beatmaps must be on the same
    stem; source/target difficulty names must belong to that stem's section
    family (remap across difficulties is allowed). Overwrites the target
    difficulty in place, preserving every other section.

    Returns a result dict, or None when the track / either beatmap record /
    either notes.chart is missing. Raises CloneDifficultyError on validation
    failures (cross-stem, mismatched family, source section absent).
    """
    from app.services.chart_generator import STEM_TO_SECTION_SUFFIX, splice_difficulty

    track = Track.load(track_id)
    if not track:
        return None
    src = next((b for b in track.beatmaps if b.get('id') == source_beatmap_id), None)
    tgt = next((b for b in track.beatmaps if b.get('id') == target_beatmap_id), None)
    if src is None or tgt is None:
        return None

    src_stem = src.get('stem', '')
    if src_stem != tgt.get('stem', ''):
        raise CloneDifficultyError('source and target beatmaps are on different stems')
    suffix = STEM_TO_SECTION_SUFFIX.get(src_stem)
    if not suffix:
        raise CloneDifficultyError(f'stem {src_stem!r} has no chart section family')
    valid = {f'{p}{suffix}' for p in ('Expert', 'Hard', 'Medium', 'Easy')}
    if source_difficulty not in valid or target_difficulty not in valid:
        raise CloneDifficultyError(
            f'difficulty must be one of {sorted(valid)} for stem {src_stem!r}'
        )

    src_chart = track.beatmaps_dir / source_beatmap_id / 'notes.chart'
    tgt_chart = track.beatmaps_dir / target_beatmap_id / 'notes.chart'
    if not src_chart.exists() or not tgt_chart.exists():
        return None

    src_text = src_chart.read_text(encoding='utf-8', errors='replace')
    tgt_text = tgt_chart.read_text(encoding='utf-8', errors='replace')
    try:
        new_text, overwrote = splice_difficulty(
            src_text, source_difficulty, tgt_text, target_difficulty
        )
    except ValueError as exc:
        raise CloneDifficultyError(str(exc))
    tgt_chart.write_text(new_text, encoding='utf-8')

    return {
        'target_beatmap_id': target_beatmap_id,
        'target_difficulty': target_difficulty,
        'source_beatmap_id': source_beatmap_id,
        'source_difficulty': source_difficulty,
        'overwrote': overwrote,
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest web/backend/tests/test_clone_difficulty_service.py -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add web/backend/app/services/tracks.py web/backend/tests/test_clone_difficulty_service.py
git commit -m "feat(tracks): clone_difficulty_across_beatmaps service + CloneDifficultyError"
```

---

## Task 3: Endpoints — list difficulties + clone-difficulty

**Files:**
- Modify: `web/backend/app/routers/tracks.py`
- Test: `web/backend/tests/test_clone_difficulty_endpoint.py`

- [ ] **Step 1: Write the failing tests**

Create `web/backend/tests/test_clone_difficulty_endpoint.py`:

```python
"""Endpoint tests for the cross-chart difficulty clone + difficulty listing."""
from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _bypass_auth():
    from app.main import app
    from app.routers.auth import require_auth
    app.dependency_overrides[require_auth] = lambda: None
    yield
    app.dependency_overrides.pop(require_auth, None)


@pytest.fixture
def client(tmp_path, monkeypatch):
    from app.config import settings
    from app.services import tracks as tracks_mod
    from app.services.tracks import Track

    upload_dir = tmp_path / 'uploads'
    tracks_dir = upload_dir / '_tracks'
    tracks_dir.mkdir(parents=True)
    monkeypatch.setattr(settings, 'upload_dir', str(upload_dir))
    monkeypatch.setattr(tracks_mod, 'TRACKS_DIR', tracks_dir)

    t = Track(id='trk1', name='Test', created_at=time.time(),
              stems={'guitar': 'guitar.ogg'}, model='demucs', output_format='ogg')
    t.beatmaps = [
        {'id': 'src', 'stem': 'guitar', 'preset': 'v8', 'active': True, 'generated_at': 1.0},
        {'id': 'dst', 'stem': 'guitar', 'preset': 'v11', 'active': False, 'generated_at': 2.0},
    ]
    t.save()
    for bid, expert, hard in (('src', '  0 = N 0 0\n  192 = N 1 0', None),
                              ('dst', '  0 = N 4 0', '  0 = N 2 0')):
        d = t.beatmaps_dir / bid
        d.mkdir(parents=True)
        parts = [f'[Song]\n{{\n  Resolution = 192\n}}\n', f'[ExpertSingle]\n{{\n{expert}\n}}\n']
        if hard is not None:
            parts.append(f'[HardSingle]\n{{\n{hard}\n}}\n')
        (d / 'notes.chart').write_text(''.join(parts), encoding='utf-8')

    from app.main import app
    with TestClient(app) as c:
        yield c


def test_list_difficulties(client):
    r = client.get('/api/tracks/trk1/beatmaps/src/difficulties')
    assert r.status_code == 200, r.text
    names = [d['name'] for d in r.json()['difficulties']]
    assert names == ['ExpertSingle']
    assert r.json()['difficulties'][0]['note_count'] == 2


def test_clone_difficulty_happy_path(client):
    r = client.post('/api/tracks/trk1/beatmaps/dst/clone-difficulty', json={
        'source_beatmap_id': 'src', 'source_difficulty': 'ExpertSingle',
        'target_difficulty': 'HardSingle',
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body['overwrote'] is True
    assert body['target_difficulty'] == 'HardSingle'


def test_clone_difficulty_unknown_source_404(client):
    r = client.post('/api/tracks/trk1/beatmaps/dst/clone-difficulty', json={
        'source_beatmap_id': 'ghost', 'source_difficulty': 'ExpertSingle',
        'target_difficulty': 'HardSingle',
    })
    assert r.status_code == 404, r.text


def test_clone_difficulty_missing_source_section_422(client):
    r = client.post('/api/tracks/trk1/beatmaps/dst/clone-difficulty', json={
        'source_beatmap_id': 'src', 'source_difficulty': 'MediumSingle',
        'target_difficulty': 'HardSingle',
    })
    assert r.status_code == 422, r.text
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest web/backend/tests/test_clone_difficulty_endpoint.py -v`
Expected: FAIL — 404 (route not registered) on the new paths.

- [ ] **Step 3: Implement the endpoints**

In `web/backend/app/routers/tracks.py`:

First extend the service import block (around lines 26–38, the `from app.services.tracks import (...)` group) to add:

```python
    CloneDifficultyError,
    clone_difficulty_across_beatmaps,
```

Then add the two endpoints next to the other beatmap routes (e.g. right after `toggle_beatmap_included`, around line 858):

```python
@router.get('/{track_id}/beatmaps/{beatmap_id}/difficulties')
async def list_beatmap_difficulties(track_id: str, beatmap_id: str):
    """List the difficulty sections present in a beatmap's notes.chart, with a
    note count per section. Drives the clone-difficulty picker (which source
    difficulties exist) and the overwrite warning (does the target slot already
    have notes)."""
    from app.services.chart_generator import chart_difficulties

    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if not bm_dir:
        raise HTTPException(404, 'Beatmap not found')
    chart_path = bm_dir / 'notes.chart'
    if not chart_path.exists():
        return {'difficulties': []}
    text = chart_path.read_text(encoding='utf-8', errors='replace')
    return {'difficulties': chart_difficulties(text)}


@router.post('/{track_id}/beatmaps/{target_id}/clone-difficulty')
async def clone_beatmap_difficulty(
    track_id: str,
    target_id: str,
    source_beatmap_id: str = Body(...),
    source_difficulty: str = Body(...),
    target_difficulty: str = Body(...),
):
    """Copy one difficulty from `source_beatmap_id` into this (`target_id`)
    beatmap's chart, under `target_difficulty`. Both beatmaps must be on the
    same stem. Overwrites the target difficulty in place."""
    try:
        result = clone_difficulty_across_beatmaps(
            track_id, source_beatmap_id, source_difficulty, target_id, target_difficulty
        )
    except CloneDifficultyError as exc:
        raise HTTPException(422, str(exc))
    if result is None:
        raise HTTPException(404, 'Track, beatmap, or notes.chart not found')
    return result
```

`Body` is already imported in `tracks.py` (used by `toggle_beatmap_included`). With three `Body(...)` params, FastAPI expects a single JSON object with those three keys — matching the test's `json={...}`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest web/backend/tests/test_clone_difficulty_endpoint.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full backend suite to check for regressions**

Run: `pytest web/backend/tests -q`
Expected: all pass (prior count + the new tests).

- [ ] **Step 6: Commit**

```bash
git add web/backend/app/routers/tracks.py web/backend/tests/test_clone_difficulty_endpoint.py
git commit -m "feat(api): clone-difficulty + list-difficulties beatmap endpoints"
```

---

## Task 4: Frontend — clone-difficulty picker on the track row

**Files:**
- Create: `web/frontend/src/components/tracks/CloneDifficultyModal.tsx`
- Modify: `web/frontend/src/pages/TracksPage.tsx`
- Test: none (no frontend harness for this interaction; rely on the typed picker + backend tests). Verify with `npm run build`.

- [ ] **Step 1: Create the modal component**

Create `web/frontend/src/components/tracks/CloneDifficultyModal.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react'

export interface ChartRow {
  id: string
  stem: string
  label: string // e.g. "V11 — chain playability"
}

interface Diff {
  name: string
  note_count: number
}

interface Props {
  trackId: string
  /** The row the action was invoked from — the SOURCE of the difficulty. */
  source: ChartRow
  /** Other charts on the same stem — possible targets. */
  targets: ChartRow[]
  onClose: () => void
  onDone: (msg: string) => void
}

async function fetchDiffs(trackId: string, beatmapId: string): Promise<Diff[]> {
  const r = await fetch(`/api/tracks/${trackId}/beatmaps/${beatmapId}/difficulties`)
  if (!r.ok) return []
  const data = await r.json()
  return data.difficulties ?? []
}

export default function CloneDifficultyModal({ trackId, source, targets, onClose, onDone }: Props) {
  const [sourceDiffs, setSourceDiffs] = useState<Diff[]>([])
  const [sourceDiff, setSourceDiff] = useState('')
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '')
  const [targetDiffs, setTargetDiffs] = useState<Diff[]>([])
  const [targetDiff, setTargetDiff] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Difficulty slots for this stem's section family — derived from whatever
  // sections the source chart exposes (they share the stem suffix).
  const suffix = useMemo(() => {
    const any = sourceDiffs[0]?.name ?? 'ExpertSingle'
    return any.replace(/^(Expert|Hard|Medium|Easy)/, '')
  }, [sourceDiffs])
  const allSlots = useMemo(
    () => ['Expert', 'Hard', 'Medium', 'Easy'].map((p) => `${p}${suffix}`),
    [suffix],
  )

  useEffect(() => {
    fetchDiffs(trackId, source.id).then((d) => {
      setSourceDiffs(d)
      setSourceDiff(d[0]?.name ?? '')
    })
  }, [trackId, source.id])

  useEffect(() => {
    if (!targetId) return
    fetchDiffs(trackId, targetId).then((d) => {
      setTargetDiffs(d)
      setTargetDiff(d[0]?.name ?? allSlots[0] ?? '')
    })
  }, [trackId, targetId, allSlots])

  const targetHasNotes =
    targetDiffs.find((d) => d.name === targetDiff && d.note_count > 0) != null
  const targetLabel = targets.find((t) => t.id === targetId)?.label ?? ''

  async function submit() {
    setBusy(true)
    setError('')
    try {
      const r = await fetch(`/api/tracks/${trackId}/beatmaps/${targetId}/clone-difficulty`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_beatmap_id: source.id,
          source_difficulty: sourceDiff,
          target_difficulty: targetDiff,
        }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.detail ?? `HTTP ${r.status}`)
      }
      onDone(`Copied ${sourceDiff} → ${targetLabel} (${targetDiff})`)
      onClose()
    } catch (e: any) {
      setError(e.message ?? 'Clone failed')
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = !!sourceDiff && !!targetId && !!targetDiff && !busy

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[420px] rounded-lg bg-slate-800 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 text-lg font-semibold text-white">Clone difficulty</h3>
        <p className="mb-4 text-sm text-slate-400">
          From <span className="text-purple-300">{source.label}</span> into another{' '}
          {source.stem} chart.
        </p>

        <label className="mb-1 block text-xs uppercase text-slate-400">Source difficulty</label>
        <select
          className="mb-3 w-full rounded bg-slate-700 px-2 py-1.5 text-sm text-white"
          value={sourceDiff}
          onChange={(e) => setSourceDiff(e.target.value)}
        >
          {sourceDiffs.map((d) => (
            <option key={d.name} value={d.name}>
              {d.name} ({d.note_count} notes)
            </option>
          ))}
        </select>

        <label className="mb-1 block text-xs uppercase text-slate-400">Target chart</label>
        <select
          className="mb-3 w-full rounded bg-slate-700 px-2 py-1.5 text-sm text-white"
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
        >
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>

        <label className="mb-1 block text-xs uppercase text-slate-400">Target difficulty</label>
        <select
          className="mb-2 w-full rounded bg-slate-700 px-2 py-1.5 text-sm text-white"
          value={targetDiff}
          onChange={(e) => setTargetDiff(e.target.value)}
        >
          {allSlots.map((name) => {
            const existing = targetDiffs.find((d) => d.name === name)
            return (
              <option key={name} value={name}>
                {name}
                {existing ? ` (${existing.note_count} notes)` : ' (empty)'}
              </option>
            )
          })}
        </select>

        {targetHasNotes && (
          <p className="mb-2 text-sm text-amber-400">
            ⚠ This will overwrite {targetLabel}'s {targetDiff} difficulty.
          </p>
        )}
        {error && <p className="mb-2 text-sm text-red-400">{error}</p>}

        <div className="mt-3 flex justify-end gap-2">
          <button
            className="rounded px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="rounded bg-purple-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-50"
            onClick={submit}
            disabled={!canSubmit}
          >
            {busy ? 'Working…' : targetHasNotes ? 'Overwrite' : 'Clone'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire the button into the track row in `TracksPage.tsx`**

Find the per-chart action area where the **Edit** / **Feedback** buttons render (search for the Feedback button JSX in the beatmap-row map). Add state near the page component's other `useState` hooks:

```tsx
const [cloneDiffFor, setCloneDiffFor] = useState<ChartRow | null>(null)
```

Add the import at the top:

```tsx
import CloneDifficultyModal, { ChartRow } from '../components/tracks/CloneDifficultyModal'
```

In the row's action area, alongside the existing Edit/Feedback buttons, add (only when the stem has at least one OTHER chart to target):

```tsx
{beatmapsForStem(bm.stem).length > 1 && (
  <button
    className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-700"
    onClick={() =>
      setCloneDiffFor({
        id: bm.id,
        stem: bm.stem,
        label: chartLabel(bm), // reuse the row's existing version/preset label
      })
    }
  >
    Clone diff
  </button>
)}
```

`beatmapsForStem(stem)` and `chartLabel(bm)` are helper expressions — if the page does not already have them, derive them inline:
- `beatmapsForStem`: `track.beatmaps.filter((b) => b.stem === stem)`.
- `chartLabel`: the same string the row already renders in its version/preset chip (e.g. ``bm.preset ? bm.preset.toUpperCase() : 'V?'``). Reuse the existing render expression rather than duplicating logic.

At the end of the page component's JSX (near the other modals / before the closing fragment), render the modal:

```tsx
{cloneDiffFor && (
  <CloneDifficultyModal
    trackId={track.id}
    source={cloneDiffFor}
    targets={track.beatmaps
      .filter((b) => b.stem === cloneDiffFor.stem && b.id !== cloneDiffFor.id)
      .map((b) => ({ id: b.id, stem: b.stem, label: /* same chartLabel expr */ b.preset?.toUpperCase() ?? 'V?' }))}
    onClose={() => setCloneDiffFor(null)}
    onDone={(msg) => {
      // reuse whatever toast/inline-status mechanism the page already has;
      // at minimum trigger the existing track refetch so badges update.
      reloadTrack(track.id) // use the page's existing reload/refetch function
    }}
  />
)}
```

Match `track`, `reloadTrack`, and the label expression to the names actually present in `TracksPage.tsx` (read the surrounding code first — the variable that holds the track in the map, and the function the page already calls after mutations like rename/clone/activate to refresh a track). Do not invent a new data-loading path; reuse the one the sibling actions use.

- [ ] **Step 3: Type-check / build the frontend**

Run (from `web/frontend/`): `npm run build`
Expected: `tsc` passes and Vite build succeeds with no type errors.

- [ ] **Step 4: Commit**

```bash
git add web/frontend/src/components/tracks/CloneDifficultyModal.tsx web/frontend/src/pages/TracksPage.tsx
git commit -m "feat(tracks-ui): per-row clone-difficulty picker for multichart tracks"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** Task 1 = server-side splice + resolution rescale + difficulty listing; Task 2 = same-stem + section-family validation + in-place overwrite + result dict; Task 3 = the two endpoints with 404/422 mapping and sibling-matching (no) auth; Task 4 = track-row picker with source-diff / target-chart / target-diff remap + overwrite warning. The spec's "reuse stats endpoint" intent is satisfied by the tiny `…/difficulties` GET (stats returns song.ini sections, not chart difficulty sections, so it could not drive the picker).
- **Auth:** sibling beatmap-mutation endpoints (`clone`, `activate`, `included`) carry no `Depends` guard. The new endpoints match that — do NOT add `require_admin`.
- **Type consistency:** service returns keys `target_beatmap_id / target_difficulty / source_beatmap_id / source_difficulty / overwrote`; the endpoint passes them through; the modal reads `overwrote` indirectly (recomputes `targetHasNotes` from the difficulties list) and only uses the success path. `splice_difficulty` returns `(text, bool)` everywhere it's called.
- **Tempo:** intentionally NOT handled (spec out-of-scope). Resolution IS handled via `_rescale_block`.
