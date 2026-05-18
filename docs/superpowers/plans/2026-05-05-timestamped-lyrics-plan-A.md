# Timestamped Lyrics — Plan A: Backend + Cards + Publish

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a complete user-visible lyrics feature: fetch synced lyrics from LRClib or transcribe with Whisper, persist them per-track, preview in the UI, and embed them in the published Jamsesh `notes.chart` so the song renders karaoke-style in-game. Manual editor integration is **deferred to Plan B**.

**Architecture:** A new `lyrics` backend service (LRClib client + faster-whisper wrapper + chart-event injection + persistence) exposed via REST + SSE. A shared React component handles fetch/preview/state for both the vocals stem card (Separation Complete view) and the Studio Library track detail. Publish-to-Game pulls `lyrics.json` and rewrites the merged chart's `[Events]` block.

**Tech Stack:** FastAPI + httpx + faster-whisper + numpy (existing) on the backend. React + TypeScript + Tailwind + Vite (existing) on the frontend. pytest for backend unit tests. Frontend has no test framework — manual verification.

**Spec:** `docs/superpowers/specs/2026-05-05-timestamped-lyrics-design.md`

**Scope deviations from spec:**
- Manual beatmap editor lyrics layer is **deferred to Plan B**.
- Undo/redo is **not in scope** (the editor doesn't have an existing undo stack to piggyback on; if it's wanted, spec a separate enhancement).

---

## File map

### New files
- `web/backend/app/services/lyrics.py` — LRC parsing, interpolation, LRClib client, Whisper wrapper, chart injection, persistence helpers.
- `web/backend/app/routers/lyrics.py` — REST + SSE routes.
- `web/backend/tests/test_lyrics.py` — unit tests for the service.
- `web/backend/tests/__init__.py` — only if it doesn't exist.
- `web/backend/tests/fixtures/sample.chart` — minimal fixture chart for inject round-trip tests.
- `web/frontend/src/components/LyricsButtons.tsx` — shared two-button + state machine + preview modal. Used by stem card and library detail.

### Modified files
- `web/backend/requirements.txt` — pin `faster-whisper`.
- `web/backend/app/main.py` — register `lyrics` router.
- `web/backend/app/routers/tracks.py` — `publish_track_to_game()` reads `lyrics.json`, copies, and calls `inject_into_chart`.
- `web/backend/app/routers/stems.py` — expose `vocals` stem absolute path lookup for the Whisper job (or keep job-id path resolution inside the service — see Task 11).
- `web/frontend/src/components/StemResult.tsx` — render `<LyricsButtons jobId={jobId} hasVocals={...} />` in the vocals stem card above `Generate Beatmap`.
- `web/frontend/src/pages/TracksPage.tsx` — render `<LyricsButtons trackId={...} hasVocals={...} />` next to the vocals stem player on the library track detail.

---

## Phase 1 — Backend lyrics service (TDD)

### Task 1: Add `faster-whisper` dependency and scaffold the router

**Files:**
- Modify: `web/backend/requirements.txt`
- Create: `web/backend/app/routers/lyrics.py`
- Modify: `web/backend/app/main.py`

- [ ] **Step 1: Pin the new dependency**

Append to `web/backend/requirements.txt`:

```
# Whisper transcription (CTranslate2-backed, CPU-friendly, MIT). Lazy-loaded
# on first /api/lyrics/whisper call. Default model "medium" is ~1.5 GB and
# downloads on first use.
faster-whisper>=1.0
```

- [ ] **Step 2: Create router stub**

Create `web/backend/app/routers/lyrics.py`:

```python
"""Lyrics fetch / persist / publish-prep routes.

See docs/superpowers/specs/2026-05-05-timestamped-lyrics-design.md.
"""
from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix='/api/lyrics', tags=['lyrics'])
```

- [ ] **Step 3: Register router in main**

Find where other routers are registered in `web/backend/app/main.py` (search for `include_router`). Add the lyrics import alongside the existing ones and call `app.include_router(lyrics.router)`. Keep the import order alphabetical with the others.

- [ ] **Step 4: Install and verify**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pip install -r requirements.txt
./venv/Scripts/python.exe -m uvicorn app.main:app --port 8001 &
sleep 3
curl -s http://127.0.0.1:8001/openapi.json | python -c "import sys, json; d = json.load(sys.stdin); print('lyrics paths:', [p for p in d['paths'] if '/lyrics' in p])"
kill %1
```

Expected: empty list (no routes yet) but no import errors.

- [ ] **Step 5: Commit**

```bash
git add web/backend/requirements.txt web/backend/app/routers/lyrics.py web/backend/app/main.py
git commit -m "feat(lyrics): scaffold router and pin faster-whisper"
```

---

### Task 2: LRC parser → list of lines

**Files:**
- Create: `web/backend/app/services/lyrics.py`
- Create: `web/backend/tests/__init__.py` (if not present)
- Create: `web/backend/tests/test_lyrics.py`

- [ ] **Step 1: Write failing tests for the LRC parser**

Create `web/backend/tests/test_lyrics.py`:

```python
"""Unit tests for the lyrics service."""
from __future__ import annotations

from app.services.lyrics import parse_lrc


def test_parse_lrc_basic():
    text = "[00:12.34]Hello world\n[00:14.50]Foo bar baz\n"
    assert parse_lrc(text) == [
        (12.34, "Hello world"),
        (14.50, "Foo bar baz"),
    ]


def test_parse_lrc_three_digit_ms():
    text = "[00:12.345]One\n[00:13.000]Two\n"
    assert parse_lrc(text) == [(12.345, "One"), (13.0, "Two")]


def test_parse_lrc_skips_blank_and_header_lines():
    text = (
        "[ar:Some Artist]\n"
        "[ti:Some Title]\n"
        "\n"
        "[00:01.00]Real line\n"
    )
    assert parse_lrc(text) == [(1.0, "Real line")]


def test_parse_lrc_repeated_timestamps_on_one_line():
    # LRC can label the same line for repeated choruses
    text = "[00:30.00][01:00.00]Chorus line\n"
    assert parse_lrc(text) == [(30.0, "Chorus line"), (60.0, "Chorus line")]


def test_parse_lrc_drops_lines_without_timestamps():
    text = "Free text without timing\n[00:05.00]Timed line\n"
    assert parse_lrc(text) == [(5.0, "Timed line")]


def test_parse_lrc_empty_input():
    assert parse_lrc("") == []
```

- [ ] **Step 2: Verify tests fail**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_lyrics.py -v
```

Expected: ImportError (parse_lrc undefined).

- [ ] **Step 3: Implement parser**

Create `web/backend/app/services/lyrics.py`:

```python
"""Lyrics service — LRClib + Whisper + chart event injection.

See docs/superpowers/specs/2026-05-05-timestamped-lyrics-design.md.
"""
from __future__ import annotations

import re

# [mm:ss.xx] or [mm:ss.xxx]; one or more allowed in front of a single line.
_TS_RE = re.compile(r'\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]')


def parse_lrc(text: str) -> list[tuple[float, str]]:
    """Parse standard LRC into a list of (time_seconds, line_text), sorted.

    - Skips header tags like [ar:], [ti:], [al:], [length:].
    - Supports multiple timestamps prefixing one line (repeated chorus).
    - Trailing whitespace on the lyric text is stripped.
    """
    out: list[tuple[float, str]] = []
    for raw in text.splitlines():
        timestamps: list[float] = []
        rest = raw
        while True:
            m = _TS_RE.match(rest)
            if not m:
                break
            mm, ss, ms = m.groups()
            ms_pad = (ms or '0').ljust(3, '0')[:3]
            timestamps.append(int(mm) * 60 + int(ss) + int(ms_pad) / 1000.0)
            rest = rest[m.end():]
        if not timestamps:
            continue
        line = rest.strip()
        if not line:
            continue
        for t in timestamps:
            out.append((t, line))
    out.sort(key=lambda x: x[0])
    return out
```

- [ ] **Step 4: Verify tests pass**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_lyrics.py -v
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add web/backend/app/services/lyrics.py web/backend/tests/__init__.py web/backend/tests/test_lyrics.py
git commit -m "feat(lyrics): LRC parser with header-tag tolerance"
```

---

### Task 3: Word interpolation across a line

**Files:**
- Modify: `web/backend/app/services/lyrics.py`
- Modify: `web/backend/tests/test_lyrics.py`

- [ ] **Step 1: Write failing tests**

Append to `web/backend/tests/test_lyrics.py`:

```python
from app.services.lyrics import interpolate_words


def _approx(a: float, b: float, tol: float = 0.01) -> bool:
    return abs(a - b) <= tol


def test_interpolate_three_word_line():
    # "Hello world tonight" → 5 + 5 + 7 = 17 chars → cumulative ratios
    words = interpolate_words("Hello world tonight", line_start=10.0, line_end=13.4)
    assert [w["text"] for w in words] == ["Hello", "world", "tonight"]
    assert _approx(words[0]["time_s"], 10.0)
    # Second word starts after 5/17 of 3.4s = 1.0s
    assert _approx(words[1]["time_s"], 11.0)
    # Third word starts after 10/17 of 3.4s = 2.0s
    assert _approx(words[2]["time_s"], 12.0)
    assert words[0]["phrase_start"] is True
    assert words[-1]["phrase_end"] is True


def test_interpolate_single_word_line():
    words = interpolate_words("Yeah", line_start=4.0, line_end=5.0)
    assert words == [{
        "time_s": 4.0,
        "text": "Yeah",
        "phrase_start": True,
        "phrase_end": True,
    }]


def test_interpolate_empty_line():
    assert interpolate_words("   ", line_start=1.0, line_end=2.0) == []


def test_interpolate_zero_duration_falls_back_to_line_start():
    words = interpolate_words("a b c", line_start=2.0, line_end=2.0)
    # All three words pinned to line_start; phrase_start/end on first/last
    assert all(_approx(w["time_s"], 2.0) for w in words)
    assert words[0]["phrase_start"] is True
    assert words[-1]["phrase_end"] is True
```

- [ ] **Step 2: Verify tests fail**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_lyrics.py::test_interpolate_three_word_line -v
```

Expected: ImportError.

- [ ] **Step 3: Implement**

Append to `web/backend/app/services/lyrics.py`:

```python
def interpolate_words(
    line: str,
    line_start: float,
    line_end: float,
) -> list[dict]:
    """Distribute a line's text across [line_start, line_end] proportional to
    each word's character count. Returns word dicts with phrase_start on the
    first word and phrase_end on the last."""
    words = line.split()
    if not words:
        return []
    duration = max(0.0, line_end - line_start)
    total_chars = sum(len(w) for w in words) or 1
    out: list[dict] = []
    cumulative = 0
    for i, word in enumerate(words):
        ratio = cumulative / total_chars
        t = line_start + ratio * duration
        cumulative += len(word)
        entry: dict = {"time_s": round(t, 3), "text": word}
        if i == 0:
            entry["phrase_start"] = True
        if i == len(words) - 1:
            entry["phrase_end"] = True
        out.append(entry)
    return out
```

- [ ] **Step 4: Verify tests pass**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_lyrics.py -v
```

Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add web/backend/app/services/lyrics.py web/backend/tests/test_lyrics.py
git commit -m "feat(lyrics): per-word interpolation across LRC lines"
```

---

### Task 4: LRClib HTTP client (mocked)

**Files:**
- Modify: `web/backend/app/services/lyrics.py`
- Modify: `web/backend/tests/test_lyrics.py`

- [ ] **Step 1: Write failing tests**

Append to `web/backend/tests/test_lyrics.py`:

```python
import pytest
import httpx
from app.services.lyrics import fetch_from_lrclib


@pytest.mark.asyncio
async def test_lrclib_synced_hit(monkeypatch):
    sample = {
        "id": 1,
        "syncedLyrics": "[00:01.00]Hello world\n[00:03.00]Goodbye\n",
        "plainLyrics": "Hello world\nGoodbye",
        "duration": 4.0,
    }

    class MockResponse:
        status_code = 200
        def json(self):
            return sample
        def raise_for_status(self):
            pass

    class MockClient:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            pass
        async def get(self, url, params, timeout):
            return MockResponse()

    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: MockClient())

    result = await fetch_from_lrclib(
        artist="X", title="Y", album=None, duration_s=4.0,
    )
    assert result is not None
    assert result["source"] == "lrclib"
    assert result["language"] == "en"   # default; we don't ask LRClib for language
    # Two lines → at least 2 phrases. "Hello world" → 2 words, "Goodbye" → 1.
    texts = [w["text"] for w in result["words"]]
    assert texts == ["Hello", "world", "Goodbye"]
    assert result["words"][0]["phrase_start"] is True
    assert result["words"][1]["phrase_end"] is True
    assert result["words"][2]["phrase_start"] is True
    assert result["words"][2]["phrase_end"] is True


@pytest.mark.asyncio
async def test_lrclib_text_only_returns_none(monkeypatch):
    sample = {"syncedLyrics": "", "plainLyrics": "no timing here"}

    class MockResponse:
        status_code = 200
        def json(self):
            return sample
        def raise_for_status(self):
            pass

    class MockClient:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            pass
        async def get(self, *a, **kw):
            return MockResponse()

    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: MockClient())
    result = await fetch_from_lrclib(artist="X", title="Y", album=None, duration_s=None)
    assert result is None


@pytest.mark.asyncio
async def test_lrclib_404_returns_none(monkeypatch):
    class MockResponse:
        status_code = 404
        def raise_for_status(self):
            raise httpx.HTTPStatusError("404", request=None, response=self)

    class MockClient:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            pass
        async def get(self, *a, **kw):
            return MockResponse()

    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: MockClient())
    result = await fetch_from_lrclib(artist="X", title="Y", album=None, duration_s=None)
    assert result is None
```

Add to `web/backend/requirements.txt` if missing: `pytest-asyncio`. Then in `web/backend/conftest.py` (create if missing):

```python
import pytest_asyncio  # noqa: F401
```

And ensure pytest finds asyncio mode. Append to `web/backend/pytest.ini` (create if missing):

```ini
[pytest]
asyncio_mode = auto
```

- [ ] **Step 2: Verify tests fail**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pip install pytest-asyncio
./venv/Scripts/python.exe -m pytest tests/test_lyrics.py -v
```

Expected: 3 failures (ImportError on `fetch_from_lrclib`).

- [ ] **Step 3: Implement**

Append to `web/backend/app/services/lyrics.py`:

```python
import datetime
import httpx

LRCLIB_URL = "https://lrclib.net/api/get"


async def fetch_from_lrclib(
    artist: str,
    title: str,
    album: str | None,
    duration_s: float | None,
) -> dict | None:
    """Look up synced lyrics on LRClib. Returns the normalized lyrics dict or
    None on miss (404, missing syncedLyrics field, or transport error)."""
    params: dict[str, str] = {
        "artist_name": artist,
        "track_name": title,
    }
    if album:
        params["album_name"] = album
    if duration_s is not None:
        params["duration"] = str(int(round(duration_s)))

    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(LRCLIB_URL, params=params, timeout=10.0)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            data = r.json()
    except httpx.HTTPError:
        return None

    synced = (data or {}).get("syncedLyrics") or ""
    if not synced.strip():
        return None

    lines = parse_lrc(synced)
    if not lines:
        return None

    # Determine each line's end as the next line's start, with the final line
    # extending one second past its start (LRC has no native end markers).
    words: list[dict] = []
    for i, (start, text) in enumerate(lines):
        end = lines[i + 1][0] if i + 1 < len(lines) else start + 1.0
        words.extend(interpolate_words(text, start, end))

    return {
        "source": "lrclib",
        "language": "en",
        "fetched_at": datetime.datetime.utcnow().isoformat() + "Z",
        "words": words,
    }
```

- [ ] **Step 4: Verify tests pass**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_lyrics.py -v
```

Expected: 13 passed.

- [ ] **Step 5: Commit**

```bash
git add web/backend/app/services/lyrics.py web/backend/tests/test_lyrics.py web/backend/requirements.txt web/backend/conftest.py web/backend/pytest.ini
git commit -m "feat(lyrics): LRClib client with mock-based test coverage"
```

---

### Task 5: Tempo map + tick conversion

**Files:**
- Modify: `web/backend/app/services/lyrics.py`
- Modify: `web/backend/tests/test_lyrics.py`

- [ ] **Step 1: Write failing tests**

Append to `web/backend/tests/test_lyrics.py`:

```python
from app.services.lyrics import parse_sync_track, seconds_to_tick


def test_parse_sync_track_single_bpm():
    chart = """[Song]
{
  Resolution = 192
}
[SyncTrack]
{
  0 = TS 4
  0 = B 120000
}
[Events]
{
}
"""
    res, segments = parse_sync_track(chart)
    assert res == 192
    # Single segment starting at tick 0, 120 BPM
    assert segments == [{"tick": 0, "bpm": 120.0}]


def test_parse_sync_track_multi_bpm():
    chart = """[Song]
{
  Resolution = 480
}
[SyncTrack]
{
  0 = B 120000
  3840 = B 90000
  7680 = B 140000
}
[Events]
{
}
"""
    res, segments = parse_sync_track(chart)
    assert res == 480
    assert segments == [
        {"tick": 0, "bpm": 120.0},
        {"tick": 3840, "bpm": 90.0},
        {"tick": 7680, "bpm": 140.0},
    ]


def test_seconds_to_tick_single_bpm():
    # 120 BPM, 192 ppq → 1 second = 2 beats = 384 ticks
    segments = [{"tick": 0, "bpm": 120.0}]
    assert seconds_to_tick(0.0, 192, segments) == 0
    assert seconds_to_tick(1.0, 192, segments) == 384
    assert seconds_to_tick(2.5, 192, segments) == 960


def test_seconds_to_tick_after_tempo_change():
    # 120 BPM for first 2 beats (= 1s), then 60 BPM
    # First seg: tick 0..384 covers 0..1s
    # Second seg starts at tick 384 (= 1.0s). At 60 BPM, 1s = 192 ticks.
    # So time t=2.5s = 1s in seg 2 = 384 + 60*ppq*0.5/something... let me compute:
    # At 60 BPM, 1 beat = 1s, so 1s = 192 ticks (one beat at 192 ppq).
    # 1.5s in seg 2 = 1.5 * 192 = 288 ticks past seg start.
    # Total = 384 + 288 = 672.
    segments = [
        {"tick": 0, "bpm": 120.0},
        {"tick": 384, "bpm": 60.0},
    ]
    assert seconds_to_tick(0.0, 192, segments) == 0
    assert seconds_to_tick(1.0, 192, segments) == 384
    assert seconds_to_tick(2.5, 192, segments) == 672
```

- [ ] **Step 2: Verify tests fail**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_lyrics.py::test_parse_sync_track_single_bpm tests/test_lyrics.py::test_seconds_to_tick_single_bpm -v
```

Expected: ImportErrors.

- [ ] **Step 3: Implement**

Append to `web/backend/app/services/lyrics.py`:

```python
_RESOLUTION_RE = re.compile(r"^\s*Resolution\s*=\s*(\d+)\s*$", re.MULTILINE)
_BPM_LINE_RE = re.compile(r"^\s*(\d+)\s*=\s*B\s+(\d+)\s*$")


def parse_sync_track(chart_text: str) -> tuple[int, list[dict]]:
    """Extract Resolution and the [SyncTrack] BPM segments. BPM in CH `.chart`
    format is `B <bpm * 1000>` so we divide back by 1000."""
    res_match = _RESOLUTION_RE.search(chart_text)
    resolution = int(res_match.group(1)) if res_match else 192

    segments: list[dict] = []
    in_sync = False
    for line in chart_text.splitlines():
        stripped = line.strip()
        if stripped == "[SyncTrack]":
            in_sync = True
            continue
        if in_sync:
            if stripped == "}":
                break
            m = _BPM_LINE_RE.match(line)
            if m:
                segments.append({
                    "tick": int(m.group(1)),
                    "bpm": int(m.group(2)) / 1000.0,
                })
    if not segments:
        segments = [{"tick": 0, "bpm": 120.0}]
    segments.sort(key=lambda s: s["tick"])
    return resolution, segments


def seconds_to_tick(t: float, resolution: int, segments: list[dict]) -> int:
    """Walk the tempo segments to convert a time-in-seconds to a tick.
    `segments` is the list returned by `parse_sync_track` (sorted by tick).
    Times before tick 0 clamp to 0."""
    if t <= 0:
        return 0
    # Build cumulative seconds at each segment boundary, then interpolate.
    accum_s = 0.0
    for i, seg in enumerate(segments):
        seg_start_tick = seg["tick"]
        bpm = seg["bpm"]
        if i + 1 < len(segments):
            next_tick = segments[i + 1]["tick"]
            seg_duration_ticks = next_tick - seg_start_tick
            seg_duration_s = (seg_duration_ticks / resolution) * (60.0 / bpm)
            if accum_s + seg_duration_s >= t:
                # `t` falls inside this segment
                local_t = t - accum_s
                local_ticks = local_t * (bpm * resolution / 60.0)
                return int(round(seg_start_tick + local_ticks))
            accum_s += seg_duration_s
        else:
            # Final segment extends to infinity
            local_t = t - accum_s
            local_ticks = local_t * (bpm * resolution / 60.0)
            return int(round(seg_start_tick + local_ticks))
    return 0
```

- [ ] **Step 4: Verify tests pass**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_lyrics.py -v
```

Expected: 17 passed.

- [ ] **Step 5: Commit**

```bash
git add web/backend/app/services/lyrics.py web/backend/tests/test_lyrics.py
git commit -m "feat(lyrics): SyncTrack parsing and tempo-aware seconds→tick"
```

---

### Task 6: `inject_into_chart` round-trip

**Files:**
- Modify: `web/backend/app/services/lyrics.py`
- Modify: `web/backend/tests/test_lyrics.py`
- Create: `web/backend/tests/fixtures/sample.chart`

- [ ] **Step 1: Create fixture chart**

Create `web/backend/tests/fixtures/sample.chart`:

```
[Song]
{
  Name = "Test"
  Resolution = 192
}
[SyncTrack]
{
  0 = TS 4
  0 = B 120000
}
[Events]
{
  192 = E "section Intro"
}
[ExpertSingle]
{
  0 = N 0 0
  192 = N 1 0
}
```

- [ ] **Step 2: Write failing test**

Append to `web/backend/tests/test_lyrics.py`:

```python
from pathlib import Path
from app.services.lyrics import inject_into_chart

FIXTURE = Path(__file__).parent / "fixtures" / "sample.chart"


def test_inject_into_chart_writes_lyric_events(tmp_path):
    chart_path = tmp_path / "out.chart"
    chart_path.write_text(FIXTURE.read_text())

    lyrics = {
        "source": "lrclib",
        "language": "en",
        "words": [
            {"time_s": 0.5, "text": "Hello", "phrase_start": True},
            {"time_s": 1.0, "text": "world", "phrase_end": True},
            {"time_s": 2.0, "text": "again", "phrase_start": True, "phrase_end": True},
        ],
    }
    count = inject_into_chart(chart_path, lyrics)
    assert count == 3

    text = chart_path.read_text()

    # Existing section event preserved
    assert '192 = E "section Intro"' in text
    # Lyric events present
    assert 'E "lyric Hello"' in text
    assert 'E "lyric world"' in text
    assert 'E "lyric again"' in text
    # Phrase markers
    assert text.count('E "phrase_start"') == 2
    assert text.count('E "phrase_end"') == 2

    # Events block sorted by tick: 0.5s @ 120 BPM, 192 ppq = 192 ticks.
    # 1.0s = 384 ticks; 2.0s = 768 ticks.
    assert '192 = E "phrase_start"' in text
    assert '192 = E "lyric Hello"' in text
    assert '384 = E "lyric world"' in text
    assert '384 = E "phrase_end"' in text
    assert '768 = E "phrase_start"' in text
    assert '768 = E "lyric again"' in text
    assert '768 = E "phrase_end"' in text


def test_inject_into_chart_idempotent(tmp_path):
    """Running twice produces the same output (no duplicate events)."""
    chart_path = tmp_path / "out.chart"
    chart_path.write_text(FIXTURE.read_text())
    lyrics = {
        "source": "lrclib", "language": "en",
        "words": [{"time_s": 1.0, "text": "Hi", "phrase_start": True, "phrase_end": True}],
    }
    inject_into_chart(chart_path, lyrics)
    first = chart_path.read_text()
    inject_into_chart(chart_path, lyrics)
    second = chart_path.read_text()
    assert first == second


def test_inject_into_chart_empty_words_clears_lyrics(tmp_path):
    chart_path = tmp_path / "out.chart"
    chart_path.write_text(FIXTURE.read_text())
    # First inject some
    inject_into_chart(chart_path, {
        "source": "lrclib", "language": "en",
        "words": [{"time_s": 1.0, "text": "Hi", "phrase_start": True, "phrase_end": True}],
    })
    # Then inject empty
    inject_into_chart(chart_path, {"source": "lrclib", "language": "en", "words": []})
    text = chart_path.read_text()
    assert 'E "lyric' not in text
    assert 'phrase_start' not in text
    # Original section event still there
    assert '192 = E "section Intro"' in text
```

- [ ] **Step 3: Verify tests fail**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_lyrics.py -v -k inject
```

Expected: ImportError.

- [ ] **Step 4: Implement**

Append to `web/backend/app/services/lyrics.py`:

```python
from pathlib import Path

_LYRIC_EVENT_NAMES = ('phrase_start', 'phrase_end', 'lyric ')


def _is_lyric_event_line(line: str) -> bool:
    """True if a line inside [Events] is a lyric/phrase event we manage."""
    s = line.strip()
    if not s.startswith(tuple(f'{n}' for n in '0123456789')):
        return False
    return any(name in s for name in _LYRIC_EVENT_NAMES)


def _escape_chart_text(text: str) -> str:
    """Quotes and backslashes need escaping inside CH .chart string events."""
    return text.replace('\\', '\\\\').replace('"', '\\"')


def inject_into_chart(chart_path: Path, lyrics: dict) -> int:
    """Rewrite the [Events] block of `chart_path` with lyric/phrase events
    derived from `lyrics`. Existing non-lyric events are preserved; existing
    lyric events from a previous run are removed (idempotent). Returns the
    number of lyric events written (3 per word in the worst case)."""
    text = chart_path.read_text()
    resolution, segments = parse_sync_track(text)

    # Build the new lyric event lines.
    new_event_lines: list[tuple[int, str]] = []
    for w in lyrics.get('words', []):
        tick = seconds_to_tick(float(w['time_s']), resolution, segments)
        if w.get('phrase_start'):
            new_event_lines.append((tick, f'  {tick} = E "phrase_start"'))
        new_event_lines.append((tick, f'  {tick} = E "lyric {_escape_chart_text(w["text"])}"'))
        if w.get('phrase_end'):
            new_event_lines.append((tick, f'  {tick} = E "phrase_end"'))

    # Locate [Events] block boundaries.
    lines = text.splitlines()
    try:
        events_idx = lines.index('[Events]')
    except ValueError:
        # No Events block — append one
        lines += ['[Events]', '{', '}']
        events_idx = len(lines) - 3
    open_idx = events_idx + 1
    while open_idx < len(lines) and lines[open_idx].strip() != '{':
        open_idx += 1
    close_idx = open_idx + 1
    while close_idx < len(lines) and lines[close_idx].strip() != '}':
        close_idx += 1

    # Strip out any existing lyric/phrase events; keep everything else.
    preserved: list[tuple[int, str]] = []
    for raw in lines[open_idx + 1:close_idx]:
        if _is_lyric_event_line(raw):
            continue
        m = re.match(r'\s*(\d+)\s*=', raw)
        if m:
            preserved.append((int(m.group(1)), raw))

    # Merge and sort stably by tick.
    merged = preserved + new_event_lines
    merged.sort(key=lambda x: x[0])

    new_block = ['[Events]', '{'] + [line for _, line in merged] + ['}']
    new_lines = lines[:events_idx] + new_block + lines[close_idx + 1:]
    chart_path.write_text('\n'.join(new_lines) + '\n')

    return sum(1 for _ in lyrics.get('words', []))
```

- [ ] **Step 5: Verify tests pass**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_lyrics.py -v
```

Expected: 20 passed.

- [ ] **Step 6: Commit**

```bash
git add web/backend/app/services/lyrics.py web/backend/tests/test_lyrics.py web/backend/tests/fixtures/sample.chart
git commit -m "feat(lyrics): idempotent inject_into_chart with tempo-aware ticks"
```

---

### Task 7: Faster-whisper transcription wrapper

**Files:**
- Modify: `web/backend/app/services/lyrics.py`
- Modify: `web/backend/tests/test_lyrics.py`

- [ ] **Step 1: Write a smoke test that's skippable when the model isn't downloaded**

Append to `web/backend/tests/test_lyrics.py`:

```python
import os


@pytest.mark.skipif(
    os.environ.get('LYRICS_WHISPER_SMOKE') != '1',
    reason='set LYRICS_WHISPER_SMOKE=1 to run (downloads the medium model)',
)
def test_whisper_smoke_on_short_clip(tmp_path):
    """Generate a 2-second sine + a TTS-free clear "test" word via ffmpeg
    (silence is fine; we just want the call path to work). Asserts the result
    has the expected normalized-shape keys, not specific transcribed words."""
    import subprocess
    wav = tmp_path / "tiny.wav"
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'anullsrc=duration=2',
         '-loglevel', 'error', str(wav)],
        check=True,
    )
    from app.services.lyrics import transcribe_with_whisper

    result = transcribe_with_whisper(wav, progress_callback=None)
    assert result["source"] == "whisper"
    assert result["model"] == "medium"
    assert "fetched_at" in result
    assert isinstance(result["words"], list)
```

- [ ] **Step 2: Implement**

Append to `web/backend/app/services/lyrics.py`:

```python
_WHISPER_MODEL = None  # Lazy singleton


def _get_whisper_model(model_size: str = 'medium'):
    """Load the faster-whisper model on first call. CPU int8 keeps RAM low."""
    global _WHISPER_MODEL
    if _WHISPER_MODEL is None:
        from faster_whisper import WhisperModel
        _WHISPER_MODEL = WhisperModel(model_size, device='cpu', compute_type='int8')
    return _WHISPER_MODEL


def transcribe_with_whisper(
    audio_path: Path,
    progress_callback=None,
    model_size: str = 'medium',
) -> dict:
    """Transcribe a vocals stem with faster-whisper, returning the normalized
    lyrics shape. Each VAD segment is one phrase. `progress_callback` matches
    the rest of the codebase: callable(step: str, percent: int, msg: str)."""
    if progress_callback:
        progress_callback('model-load', 5, f'Loading Whisper {model_size}...')
    model = _get_whisper_model(model_size)
    if progress_callback:
        progress_callback('transcribe', 15, 'Transcribing vocals...')

    segments_iter, info = model.transcribe(
        str(audio_path),
        word_timestamps=True,
        vad_filter=True,
    )

    words: list[dict] = []
    for seg in segments_iter:
        seg_words = list(seg.words or [])
        if not seg_words:
            continue
        for i, w in enumerate(seg_words):
            entry: dict = {
                'time_s': round(float(w.start or 0.0), 3),
                'text': w.word.strip(),
            }
            if i == 0:
                entry['phrase_start'] = True
            if i == len(seg_words) - 1:
                entry['phrase_end'] = True
            if entry['text']:
                words.append(entry)

    if progress_callback:
        progress_callback('done', 100, f'Transcribed {len(words)} words')

    return {
        'source': 'whisper',
        'language': info.language or 'en',
        'model': model_size,
        'fetched_at': datetime.datetime.utcnow().isoformat() + 'Z',
        'words': words,
    }
```

- [ ] **Step 3: Verify import works (skip the smoke test by default)**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_lyrics.py -v
```

Expected: 20 passed, 1 skipped.

- [ ] **Step 4: Commit**

```bash
git add web/backend/app/services/lyrics.py web/backend/tests/test_lyrics.py
git commit -m "feat(lyrics): faster-whisper transcription wrapper, lazy singleton"
```

---

### Task 8: Lyrics persistence helpers

**Files:**
- Modify: `web/backend/app/services/lyrics.py`
- Modify: `web/backend/tests/test_lyrics.py`

- [ ] **Step 1: Write failing tests**

Append to `web/backend/tests/test_lyrics.py`:

```python
from app.services.lyrics import write_lyrics, load_lyrics


def test_write_then_load_lyrics(tmp_path):
    lyrics = {
        "source": "lrclib", "language": "en", "words": [
            {"time_s": 1.0, "text": "Hi", "phrase_start": True, "phrase_end": True},
        ],
    }
    path = write_lyrics(tmp_path, lyrics)
    assert path == tmp_path / "lyrics.json"
    assert load_lyrics(tmp_path) == lyrics


def test_load_lyrics_missing(tmp_path):
    assert load_lyrics(tmp_path) is None
```

- [ ] **Step 2: Implement**

Append to `web/backend/app/services/lyrics.py`:

```python
import json


def write_lyrics(target_dir: Path, lyrics: dict) -> Path:
    """Persist `lyrics.json` in target_dir. Caller is responsible for ensuring
    target_dir exists."""
    path = target_dir / 'lyrics.json'
    path.write_text(json.dumps(lyrics, ensure_ascii=False, indent=2))
    return path


def load_lyrics(target_dir: Path) -> dict | None:
    """Read lyrics.json from target_dir. Returns None if absent."""
    path = target_dir / 'lyrics.json'
    if not path.exists():
        return None
    return json.loads(path.read_text())
```

- [ ] **Step 3: Verify**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_lyrics.py -v
```

Expected: 22 passed, 1 skipped.

- [ ] **Step 4: Commit**

```bash
git add web/backend/app/services/lyrics.py web/backend/tests/test_lyrics.py
git commit -m "feat(lyrics): persistence helpers (write/load lyrics.json)"
```

---

### Task 9: REST routes — GET / PUT / DELETE / POST /lrclib

**Files:**
- Modify: `web/backend/app/routers/lyrics.py`
- Modify: `web/backend/tests/test_lyrics.py`

- [ ] **Step 1: Write integration tests**

Append to `web/backend/tests/test_lyrics.py`:

```python
from fastapi.testclient import TestClient
from app.main import app


def test_lyrics_get_404_when_missing(monkeypatch, tmp_path):
    # Stub out the resolver so the route uses tmp_path
    from app.routers import lyrics as lyrics_router
    monkeypatch.setattr(lyrics_router, '_resolve_dir', lambda **kw: tmp_path)
    client = TestClient(app)
    r = client.get('/api/lyrics?track_id=does-not-matter')
    assert r.status_code == 404


def test_lyrics_put_then_get(monkeypatch, tmp_path):
    from app.routers import lyrics as lyrics_router
    monkeypatch.setattr(lyrics_router, '_resolve_dir', lambda **kw: tmp_path)
    client = TestClient(app)
    body = {"source": "lrclib", "language": "en", "words": []}
    r = client.put('/api/lyrics?track_id=t1', json=body)
    assert r.status_code == 200
    r = client.get('/api/lyrics?track_id=t1')
    assert r.status_code == 200
    assert r.json() == body


def test_lyrics_delete(monkeypatch, tmp_path):
    from app.routers import lyrics as lyrics_router
    monkeypatch.setattr(lyrics_router, '_resolve_dir', lambda **kw: tmp_path)
    client = TestClient(app)
    body = {"source": "lrclib", "language": "en", "words": []}
    client.put('/api/lyrics?track_id=t1', json=body)
    r = client.delete('/api/lyrics?track_id=t1')
    assert r.status_code == 200
    r = client.get('/api/lyrics?track_id=t1')
    assert r.status_code == 404
```

- [ ] **Step 2: Verify tests fail**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_lyrics.py -v -k 'get_404 or put_then or delete'
```

Expected: AttributeError on `_resolve_dir`.

- [ ] **Step 3: Implement routes**

Replace `web/backend/app/routers/lyrics.py` with:

```python
"""Lyrics fetch / persist / publish-prep routes."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Body, HTTPException, Query

from app.services import lyrics as lyrics_service
from app.routers.stems import get_job  # existing helper for job lookup
from app.services.tracks import get_track  # existing track lookup; verify name in source
# NOTE: if app.services.tracks doesn't expose get_track, find the equivalent
# helper used by /api/tracks/{id} and import that. Search tracks.py for the
# function the existing GET-track endpoint uses to resolve a track by id.

router = APIRouter(prefix='/api/lyrics', tags=['lyrics'])


def _resolve_dir(job_id: str | None = None, track_id: str | None = None) -> Path:
    """Return the directory where lyrics.json for the given scope should live.

    - track_id wins over job_id when both are supplied.
    - Raises HTTPException(400) if neither is supplied.
    - Raises HTTPException(404) if the scope can't be resolved to an existing dir.
    """
    if track_id:
        track = get_track(track_id)
        if not track:
            raise HTTPException(404, f'Track not found: {track_id}')
        # Convention: track files live under track.output_dir (verify in source)
        return Path(track.output_dir)
    if job_id:
        job = get_job(job_id)
        if not job or not job.output_dir:
            raise HTTPException(404, f'Job not found: {job_id}')
        return job.output_dir / 'stems'
    raise HTTPException(400, 'Provide job_id or track_id')


@router.get('')
async def get_lyrics(
    job_id: str | None = Query(default=None),
    track_id: str | None = Query(default=None),
):
    target = _resolve_dir(job_id=job_id, track_id=track_id)
    data = lyrics_service.load_lyrics(target)
    if data is None:
        raise HTTPException(404, 'No lyrics for this scope')
    return data


@router.put('')
async def put_lyrics(
    body: dict = Body(...),
    job_id: str | None = Query(default=None),
    track_id: str | None = Query(default=None),
):
    target = _resolve_dir(job_id=job_id, track_id=track_id)
    target.mkdir(parents=True, exist_ok=True)
    lyrics_service.write_lyrics(target, body)
    return {'ok': True, 'word_count': len(body.get('words', []))}


@router.delete('')
async def delete_lyrics(
    job_id: str | None = Query(default=None),
    track_id: str | None = Query(default=None),
):
    target = _resolve_dir(job_id=job_id, track_id=track_id)
    p = target / 'lyrics.json'
    if p.exists():
        p.unlink()
    return {'ok': True}


@router.post('/lrclib')
async def post_lrclib(
    body: dict = Body(...),
    job_id: str | None = Query(default=None),
    track_id: str | None = Query(default=None),
):
    """Body fields: artist, title, album?, duration_s?"""
    target = _resolve_dir(job_id=job_id, track_id=track_id)
    artist = (body.get('artist') or '').strip()
    title = (body.get('title') or '').strip()
    if not artist or not title:
        raise HTTPException(400, 'artist and title are required')
    result = await lyrics_service.fetch_from_lrclib(
        artist=artist, title=title,
        album=body.get('album'),
        duration_s=body.get('duration_s'),
    )
    if result is None:
        return {'source': None}  # 200 + null source so the UI can render the miss state
    target.mkdir(parents=True, exist_ok=True)
    lyrics_service.write_lyrics(target, result)
    return result
```

> **Note for implementer:** before merging, open `web/backend/app/routers/tracks.py` and `web/backend/app/services/tracks.py` and confirm the actual track-lookup helper name (the import line above is a placeholder). If `get_track` doesn't exist, swap to whatever the existing tracks GET endpoint uses. Same for `track.output_dir` — the property may be different (e.g. `track.path`).

- [ ] **Step 4: Verify tests pass**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_lyrics.py -v
```

Expected: 25 passed, 1 skipped.

- [ ] **Step 5: Commit**

```bash
git add web/backend/app/routers/lyrics.py web/backend/tests/test_lyrics.py
git commit -m "feat(lyrics): GET/PUT/DELETE /api/lyrics + POST /api/lyrics/lrclib"
```

---

### Task 10: Whisper SSE job route

**Files:**
- Modify: `web/backend/app/routers/lyrics.py`

> **Discovery step required:** the existing demucs and pip-upgrade flows use a `Job` infrastructure (see `app/routers/stems.py` and `app/routers/versions.py` for `create_job(...)` / `start_job(...)` / SSE event helpers). Open `app/routers/versions.py:upgrade_package` first — it's the closest analog (background work, SSE progress, persistence on completion). Mirror its structure.

- [ ] **Step 1: Implement the route by mirroring versions.upgrade_package**

Append to `web/backend/app/routers/lyrics.py`:

```python
import asyncio
from fastapi import BackgroundTasks
# Adjust these imports after reading versions.py / stems.py:
from app.routers.jobs import create_job, get_job as get_any_job  # placeholder names


@router.post('/whisper')
async def post_whisper(
    background_tasks: BackgroundTasks,
    job_id: str | None = Query(default=None),
    track_id: str | None = Query(default=None),
):
    """Kick off a Whisper transcription as a Job. UI subscribes to
    /api/jobs/{returned_id}/events for progress."""
    target = _resolve_dir(job_id=job_id, track_id=track_id)

    # Find the vocals stem for this scope.
    candidates = list(target.glob('vocals.*')) + list(target.glob('*vocals*.ogg'))
    vocals = next(iter(candidates), None)
    if vocals is None or not vocals.exists():
        raise HTTPException(404, 'No vocals stem available for this scope')

    work_job = create_job(kind='lyrics-whisper')

    async def _run(progress_callback):
        # Run faster-whisper in a thread to avoid blocking the loop.
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            lambda: lyrics_service.transcribe_with_whisper(vocals, progress_callback),
        )
        target.mkdir(parents=True, exist_ok=True)
        lyrics_service.write_lyrics(target, result)
        return {'words': len(result['words']), 'source': 'whisper'}

    background_tasks.add_task(work_job.run, _run)
    return {'job_id': work_job.id}
```

> **Note:** the exact `create_job` / `Job.run` API will differ. Open `app/routers/versions.py:upgrade_package` and copy its job-spawn shape. The point of this task is to wire whisper into the same SSE machinery as upgrade — not to invent new job plumbing.

- [ ] **Step 2: Manual test**

```bash
# Set a job id that has vocals.ogg in it (one you already separated locally)
JOB_ID=...
cd web/backend && ./venv/Scripts/python.exe -m uvicorn app.main:app --port 8000 --reload-dir app
# In another terminal:
curl -X POST "http://127.0.0.1:8000/api/lyrics/whisper?job_id=$JOB_ID"
# Subscribe to the returned job_id's events; expect model-load → transcribe → done
```

- [ ] **Step 3: Commit**

```bash
git add web/backend/app/routers/lyrics.py
git commit -m "feat(lyrics): POST /api/lyrics/whisper as SSE job"
```

---

## Phase 2 — Publish-to-Game integration

### Task 11: Inject lyrics into the published chart

**Files:**
- Modify: `web/backend/app/routers/tracks.py`

- [ ] **Step 1: Locate the merge point**

Open `web/backend/app/routers/tracks.py` and find `publish_track_to_game` (≈line 731). Find the line that calls `merge_beatmap_charts(...)` and produces `notes_fixed_slides.chart`. The lyrics inject runs *after* merge, *before* the GitHub publish call.

- [ ] **Step 2: Add the inject block**

After the merge call and before `publish_song_folder(tmp_dir, folder_name)`, insert:

```python
# Lyrics: copy lyrics.json into the published folder and rewrite the chart's
# [Events] block. Looks at the track dir first, then falls back to the demucs
# job's stems dir (covers first-publish before lyrics persist to track).
from app.services import lyrics as lyrics_service

lyrics_data = lyrics_service.load_lyrics(track_output_dir)
if lyrics_data is None and job_stems_dir is not None:
    lyrics_data = lyrics_service.load_lyrics(job_stems_dir)

lyrics_summary = {'source': None, 'word_count': 0, 'included': False}
if lyrics_data:
    chart_path = tmp_dir / 'notes_fixed_slides.chart'  # match the merged-chart filename
    inserted = lyrics_service.inject_into_chart(chart_path, lyrics_data)
    lyrics_service.write_lyrics(tmp_dir, lyrics_data)  # copy into the published folder
    lyrics_summary = {
        'source': lyrics_data.get('source'),
        'word_count': inserted,
        'included': True,
    }
```

> **Important:** verify the variable names `track_output_dir`, `job_stems_dir`, `tmp_dir` against the actual function. Pull whichever the existing code uses for the on-disk track folder, the demucs job's stems dir, and the staging dir for the published bundle.

Then update the function's return value to include `lyrics_summary`:

```python
return {
    'commit_url': ...,
    'folder': folder_name,
    'chart': { ... },
    'tutorial': { ... },
    'lyrics': lyrics_summary,
}
```

- [ ] **Step 3: Manual test**

```bash
# Locally, with a track that already has lyrics.json
TRACK_ID=...
curl -X POST http://127.0.0.1:8000/api/tracks/$TRACK_ID/publish-game
# Assert the response has lyrics.included=true and word_count>0
# Then download the published notes.chart from the SongInbox repo and grep for "lyric "
```

- [ ] **Step 4: Commit**

```bash
git add web/backend/app/routers/tracks.py
git commit -m "feat(lyrics): inject lyric events into chart on publish"
```

---

## Phase 3 — Frontend (vocals card + library detail)

### Task 12: LyricsButtons component (state machine + LRClib)

**Files:**
- Create: `web/frontend/src/components/LyricsButtons.tsx`

- [ ] **Step 1: Scaffold the component**

Create `web/frontend/src/components/LyricsButtons.tsx`:

```tsx
import { useEffect, useState } from 'react'

export type LyricsScope = { jobId: string } | { trackId: string }

type Lyrics = {
  source: 'lrclib' | 'whisper' | null
  language?: string
  model?: string
  fetched_at?: string
  words: Array<{ time_s: number; text: string; phrase_start?: boolean; phrase_end?: boolean }>
}

type Props = {
  scope: LyricsScope
  hasVocals: boolean
  // Used by the LRClib search; pass the song.ini fields the parent already has.
  meta: { artist: string; title: string; album?: string; duration_s?: number }
  // Optional: parent can listen for lyrics changes to update its own state.
  onLyricsChange?: (lyrics: Lyrics | null) => void
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'lrclib-loading' }
  | { kind: 'lrclib-miss' }
  | { kind: 'whisper-running'; jobId: string; progress: number; message: string }
  | { kind: 'have-lyrics'; lyrics: Lyrics }
  | { kind: 'error'; message: string }

function scopeQuery(scope: LyricsScope): string {
  return 'jobId' in scope ? `job_id=${scope.jobId}` : `track_id=${scope.trackId}`
}

export default function LyricsButtons({ scope, hasVocals, meta, onLyricsChange }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [previewOpen, setPreviewOpen] = useState(false)

  // Hydrate from the server on mount.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/lyrics?${scopeQuery(scope)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return
        if (data && data.words) {
          setPhase({ kind: 'have-lyrics', lyrics: data })
          onLyricsChange?.(data)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [JSON.stringify(scope)])

  const fetchLrclib = async () => {
    setPhase({ kind: 'lrclib-loading' })
    try {
      const res = await fetch(`/api/lyrics/lrclib?${scopeQuery(scope)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: Lyrics = await res.json()
      if (!data.source) {
        setPhase({ kind: 'lrclib-miss' })
        return
      }
      setPhase({ kind: 'have-lyrics', lyrics: data })
      onLyricsChange?.(data)
    } catch (e) {
      setPhase({ kind: 'error', message: (e as Error).message })
    }
  }

  // Whisper button is implemented in the next task; stub for now.
  const startWhisper = async () => { /* Task 13 */ }

  const lrclibLabel =
    phase.kind === 'lrclib-loading' ? 'Searching…' :
    phase.kind === 'lrclib-miss' ? 'No match — try again' :
    phase.kind === 'have-lyrics' ? 'Preview Lyrics' :
    'Get Lyrics'

  const lrclibDisabled = phase.kind === 'lrclib-loading' || phase.kind === 'whisper-running'
  const lrclibAction = phase.kind === 'have-lyrics' ? () => setPreviewOpen(true) : fetchLrclib

  return (
    <>
      <button
        onClick={lrclibAction}
        disabled={lrclibDisabled}
        className="px-3 py-1.5 bg-purple-700/60 hover:bg-purple-600/70 disabled:opacity-50 text-purple-100 rounded text-xs font-medium transition-colors w-full"
      >
        {lrclibLabel}
      </button>
      {hasVocals && (
        <button
          onClick={startWhisper}
          disabled={phase.kind === 'whisper-running' || phase.kind === 'lrclib-loading'}
          className="px-3 py-1.5 bg-gray-700/70 hover:bg-gray-600/80 disabled:opacity-50 text-gray-200 rounded text-xs font-medium transition-colors w-full"
          title="Local Whisper transcription. ~2 min on CPU; first run downloads ~1.5 GB."
        >
          {phase.kind === 'whisper-running' ? `Transcribing… ${phase.progress}%` :
           phase.kind === 'have-lyrics' && phase.lyrics.source === 'whisper' ? 'Re-transcribe' :
           'Transcribe Vocals'}
        </button>
      )}
      {previewOpen && phase.kind === 'have-lyrics' && (
        <PreviewModal lyrics={phase.lyrics} onClose={() => setPreviewOpen(false)} />
      )}
    </>
  )
}

function PreviewModal({ lyrics, onClose }: { lyrics: Lyrics; onClose: () => void }) {
  const sourceLabel =
    lyrics.source === 'lrclib' ? 'LRClib' :
    lyrics.source === 'whisper' ? `Whisper · ${lyrics.model || 'medium'}` :
    'unknown'
  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg p-5 space-y-3 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-100">Lyrics</h3>
          <span className="text-xs text-gray-500">{sourceLabel} · {lyrics.words.length} words</span>
        </div>
        <div className="flex-1 overflow-auto font-mono text-xs space-y-0.5 bg-black/30 rounded p-3">
          {lyrics.words.map((w, i) => (
            <div key={i} className="flex gap-2">
              <span className="text-gray-600 w-12 shrink-0 text-right">
                {Math.floor(w.time_s / 60)}:{(w.time_s % 60).toFixed(2).padStart(5, '0')}
              </span>
              <span className={w.phrase_start ? 'text-jam-300' : 'text-gray-200'}>
                {w.text}{w.phrase_end ? ' ⏎' : ''}
              </span>
            </div>
          ))}
        </div>
        <div className="flex justify-end">
          <button onClick={onClose} className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-md text-sm">Close</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Type-check**

```bash
cd web/frontend && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add web/frontend/src/components/LyricsButtons.tsx
git commit -m "feat(lyrics): LyricsButtons component with LRClib + preview modal"
```

---

### Task 13: Whisper button + SSE progress

**Files:**
- Modify: `web/frontend/src/components/LyricsButtons.tsx`

- [ ] **Step 1: Implement startWhisper using SSE**

Replace the `startWhisper` stub in `LyricsButtons.tsx` with:

```tsx
const startWhisper = async () => {
  try {
    const res = await fetch(`/api/lyrics/whisper?${scopeQuery(scope)}`, { method: 'POST' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.detail || `HTTP ${res.status}`)
    }
    const { job_id } = await res.json()
    setPhase({ kind: 'whisper-running', jobId: job_id, progress: 0, message: 'Starting…' })

    const es = new EventSource(`/api/jobs/${job_id}/events`)
    es.onmessage = async (ev) => {
      const d = JSON.parse(ev.data)
      if (typeof d.progress === 'number' && d.progress >= 0) {
        setPhase((p) => p.kind === 'whisper-running' ? { ...p, progress: d.progress, message: d.message ?? p.message } : p)
      }
      if (d.step === 'done') {
        es.close()
        // Reload the saved lyrics
        const got = await fetch(`/api/lyrics?${scopeQuery(scope)}`)
        if (got.ok) {
          const lyrics: Lyrics = await got.json()
          setPhase({ kind: 'have-lyrics', lyrics })
          onLyricsChange?.(lyrics)
        } else {
          setPhase({ kind: 'error', message: 'Transcription finished but lyrics could not be loaded' })
        }
      } else if (d.step === 'error' || d.step === 'cancelled') {
        es.close()
        setPhase({ kind: 'error', message: d.message || 'Whisper failed' })
      }
    }
    es.onerror = () => { es.close(); setPhase({ kind: 'error', message: 'SSE connection lost' }) }
  } catch (e) {
    setPhase({ kind: 'error', message: (e as Error).message })
  }
}
```

- [ ] **Step 2: Type-check**

```bash
cd web/frontend && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add web/frontend/src/components/LyricsButtons.tsx
git commit -m "feat(lyrics): wire LyricsButtons whisper path through SSE job"
```

---

### Task 14: Wire into vocals stem card

**Files:**
- Modify: `web/frontend/src/components/StemResult.tsx`

- [ ] **Step 1: Locate the vocals card render**

In `StemResult.tsx`, find the per-stem card render (around line 308 — the `Object.entries(stems).filter(...).map(([stem]) => {` block). The Generate Beatmap button is rendered conditionally inside that map, gated on `stem !== 'song'`.

- [ ] **Step 2: Inject LyricsButtons above Generate Beatmap, only for `vocals`**

Add at the top of the file:

```tsx
import LyricsButtons from './LyricsButtons'
```

Inside the per-stem map's `<div>`, just before the Generate Beatmap button, add:

```tsx
{stem === 'vocals' && (
  <LyricsButtons
    scope={{ jobId }}
    hasVocals={true}
    meta={{
      artist: songIni.artist || '',
      title: songIni.name || '',
      album: songIni.album || undefined,
      duration_s: typeof metadata.duration === 'number' ? metadata.duration : undefined,
    }}
  />
)}
```

> Verify `metadata.duration` actually carries duration_s on this view — if not, drop the field; LRClib makes duration optional. Search for how duration flows in via metadata and adjust.

- [ ] **Step 3: Type-check + visual check**

```bash
cd web/frontend && npx tsc --noEmit
```

Then manually: load Separation Complete view in dev, confirm two new buttons appear above Generate Beatmap on the vocals card only.

- [ ] **Step 4: Commit**

```bash
git add web/frontend/src/components/StemResult.tsx
git commit -m "feat(lyrics): vocals card shows Get Lyrics + Transcribe Vocals"
```

---

### Task 15: Wire into Studio Library track detail

**Files:**
- Modify: `web/frontend/src/pages/TracksPage.tsx`

- [ ] **Step 1: Locate the vocals stem render**

Around `TracksPage.tsx:1242` there's a `<StemPlayer src={...tracks/.../stems/...} />` for each stem. Find the surrounding map and identify where stem === 'vocals'.

- [ ] **Step 2: Inject LyricsButtons next to the player on the vocals row**

Add at the top:

```tsx
import LyricsButtons from '../components/LyricsButtons'
```

In the per-stem render, when `stem === 'vocals'`, render the buttons after the StemPlayer, with `scope={{ trackId: selectedTrack.id }}`. Use the track's existing metadata fields (artist, name, album) for `meta`.

- [ ] **Step 3: Type-check + manual test**

```bash
cd web/frontend && npx tsc --noEmit
```

Manually: open the Studio Library, click a track → vocals row should show the buttons. Click Get Lyrics → preview opens for tracks with LRClib hits.

- [ ] **Step 4: Commit**

```bash
git add web/frontend/src/pages/TracksPage.tsx
git commit -m "feat(lyrics): library track detail shows Lyrics buttons on vocals row"
```

---

## Phase 4 — Manual end-to-end verification

### Task 16: Real-track LRClib smoke

- [ ] **Step 1: Pick a known LRClib hit**

"Mr. Brightside" by The Killers — known to have synced lyrics on LRClib.

- [ ] **Step 2: Run end-to-end locally**

1. Use the YouTube ingest flow to pull the track.
2. Run separation.
3. On Separation Complete, click *Get Lyrics* on the vocals card.
4. Confirm button changes to *Preview Lyrics* and the modal lists the words.
5. Click *Publish to Game*.
6. Inspect the SongInbox commit on GitHub — open the published `notes.chart` and grep for `phrase_start` / `lyric `. Should see ~hundreds of lyric events.
7. Also confirm `lyrics.json` is in the published folder.

- [ ] **Step 3: Document any flakiness**

If LRClib returns text-only (rare for this title), note the duration mismatch and consider retrying without `duration_s`.

---

### Task 17: Whisper smoke (if env permits)

- [ ] **Step 1: Force LRClib miss and trigger Whisper**

1. Pick an obscure track with no LRClib match.
2. Click *Get Lyrics* — confirm "No match — try again".
3. Click *Transcribe Vocals* — confirm progress bar moves through model-load → transcribe → done.
4. Open *Preview Lyrics* — sanity-check the transcribed words look at least vaguely correct.
5. Publish — confirm the chart contains Whisper-derived events.

- [ ] **Step 2: Document the model-download path**

Note where faster-whisper caches the model (typically `~/.cache/huggingface/`). First run will spend several minutes downloading; subsequent runs are fast.

---

### Task 18: In-game render check

- [ ] **Step 1: Open in Jamsesh**

Pull the published track folder from SongInbox into a CH song library, launch CH, play the song, and confirm lyrics render karaoke-style with phrase highlighting matching the music.

If lyrics drift or display garbled, capture the offending words and the chart's tick value for follow-up. Most commonly: tempo-change tracks → lyric ticks miscalculated. The backend `inject_into_chart` walks SyncTrack so this should be correct, but a real CH check is the only proof.

- [ ] **Step 2: Final deploy**

```bash
git push origin main
ssh -i ~/.ssh/id_ed25519_beatmap root@137.184.217.203 \
  "cd /opt/madmom && git fetch origin main && git reset --hard origin/main \
   && cd web/backend && ./venv/bin/pip install -r requirements.txt 2>&1 | tail -5 \
   && cd ../frontend && npm run build 2>&1 | tail -5 \
   && systemctl restart beatmap-backend && systemctl is-active beatmap-backend"
```

---

## Out of scope for Plan A (saved for Plan B)

- Manual beatmap editor lyrics layer — render, drag-to-retime, inline text edit, multi-select, phrase boundary editing, sidebar visibility toggle.
- Undo/redo (the editor doesn't have an existing stack — separate spec needed).

---

## Self-review notes (already applied inline)

- Task 9 ships with a `_resolve_dir` helper marked as a placeholder for the implementer to confirm against the actual `tracks` service API. Same for Task 11's variable names. These are flagged because the explore agent didn't open `services/tracks.py` directly.
- Task 10 mirrors the existing pip-upgrade SSE job pattern (in `routers/versions.py`) instead of inventing new job plumbing — the implementer should read that file before writing the route.
- Task 4 introduces `pytest-asyncio` + `pytest.ini` if missing; harmless on greenfield-config-side.
- All chart text writes go through `_escape_chart_text` to handle quotes/backslashes in word text (covered by the spec's edge-case table).
