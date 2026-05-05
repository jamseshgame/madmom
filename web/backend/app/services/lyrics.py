"""Lyrics service — LRClib + Whisper + chart event injection.

See docs/superpowers/specs/2026-05-05-timestamped-lyrics-design.md.
"""
from __future__ import annotations

import datetime
import re

import httpx

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
        "fetched_at": datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        "words": words,
    }
