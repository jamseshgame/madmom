"""Unit tests for the lyrics service."""
from __future__ import annotations

import os
from pathlib import Path

import httpx
import pytest

from app.services.lyrics import fetch_from_lrclib, inject_into_chart, interpolate_words, load_lyrics, parse_lrc, parse_sync_track, seconds_to_tick, transcribe_with_whisper, write_lyrics


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
    # 1.5s past seg start = 1.5 * 192 = 288 ticks → 384 + 288 = 672.
    segments = [
        {"tick": 0, "bpm": 120.0},
        {"tick": 384, "bpm": 60.0},
    ]
    assert seconds_to_tick(0.0, 192, segments) == 0
    assert seconds_to_tick(1.0, 192, segments) == 384
    assert seconds_to_tick(2.5, 192, segments) == 672


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

    # 0.5s @ 120 BPM, 192 ppq = 192 ticks. 1.0s = 384. 2.0s = 768.
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
    inject_into_chart(chart_path, {
        "source": "lrclib", "language": "en",
        "words": [{"time_s": 1.0, "text": "Hi", "phrase_start": True, "phrase_end": True}],
    })
    inject_into_chart(chart_path, {"source": "lrclib", "language": "en", "words": []})
    text = chart_path.read_text()
    assert 'E "lyric' not in text
    assert 'phrase_start' not in text
    # Original section event still there
    assert '192 = E "section Intro"' in text


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


from fastapi.testclient import TestClient
from app.main import app
from app.routers.auth import require_auth


@pytest.fixture(autouse=False)
def _no_auth():
    """Override the require_auth dependency so TestClient calls succeed without a cookie."""
    app.dependency_overrides[require_auth] = lambda: None
    yield
    app.dependency_overrides.pop(require_auth, None)


def test_lyrics_get_404_when_missing(monkeypatch, tmp_path, _no_auth):
    from app.routers import lyrics as lyrics_router
    monkeypatch.setattr(lyrics_router, '_resolve_dir', lambda **kw: tmp_path)
    client = TestClient(app)
    r = client.get('/api/lyrics?track_id=does-not-matter')
    assert r.status_code == 404


def test_lyrics_put_then_get(monkeypatch, tmp_path, _no_auth):
    from app.routers import lyrics as lyrics_router
    monkeypatch.setattr(lyrics_router, '_resolve_dir', lambda **kw: tmp_path)
    client = TestClient(app)
    body = {"source": "lrclib", "language": "en", "words": []}
    r = client.put('/api/lyrics?track_id=t1', json=body)
    assert r.status_code == 200
    r = client.get('/api/lyrics?track_id=t1')
    assert r.status_code == 200
    assert r.json() == body


def test_lyrics_delete(monkeypatch, tmp_path, _no_auth):
    from app.routers import lyrics as lyrics_router
    monkeypatch.setattr(lyrics_router, '_resolve_dir', lambda **kw: tmp_path)
    client = TestClient(app)
    body = {"source": "lrclib", "language": "en", "words": []}
    client.put('/api/lyrics?track_id=t1', json=body)
    r = client.delete('/api/lyrics?track_id=t1')
    assert r.status_code == 200
    r = client.get('/api/lyrics?track_id=t1')
    assert r.status_code == 404


@pytest.mark.skipif(
    os.environ.get('LYRICS_WHISPER_SMOKE') != '1',
    reason='set LYRICS_WHISPER_SMOKE=1 to run (downloads the medium model)',
)
def test_whisper_smoke_on_short_clip(tmp_path):
    """Generate a 2-second silent clip via ffmpeg and run faster-whisper.
    Asserts the result has the expected normalized-shape keys."""
    import subprocess
    wav = tmp_path / "tiny.wav"
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'anullsrc=duration=2',
         '-loglevel', 'error', str(wav)],
        check=True,
    )

    result = transcribe_with_whisper(wav, progress_callback=None)
    assert result["source"] == "whisper"
    assert result["model"] == "medium"
    assert "fetched_at" in result
    assert isinstance(result["words"], list)
