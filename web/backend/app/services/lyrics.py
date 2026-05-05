"""Lyrics service — LRClib + Whisper + chart event injection.

See docs/superpowers/specs/2026-05-05-timestamped-lyrics-design.md.
"""
from __future__ import annotations

import datetime
import re
from pathlib import Path

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
    number of word events written."""
    text = chart_path.read_text()
    resolution, segments = parse_sync_track(text)

    new_event_lines: list[tuple[int, str]] = []
    for w in lyrics.get('words', []):
        tick = seconds_to_tick(float(w['time_s']), resolution, segments)
        if w.get('phrase_start'):
            new_event_lines.append((tick, f'  {tick} = E "phrase_start"'))
        new_event_lines.append((tick, f'  {tick} = E "lyric {_escape_chart_text(w["text"])}"'))
        if w.get('phrase_end'):
            new_event_lines.append((tick, f'  {tick} = E "phrase_end"'))

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

    preserved: list[tuple[int, str]] = []
    for raw in lines[open_idx + 1:close_idx]:
        if _is_lyric_event_line(raw):
            continue
        m = re.match(r'\s*(\d+)\s*=', raw)
        if m:
            preserved.append((int(m.group(1)), raw))

    merged = preserved + new_event_lines
    merged.sort(key=lambda x: x[0])

    new_block = ['[Events]', '{'] + [line for _, line in merged] + ['}']
    new_lines = lines[:events_idx] + new_block + lines[close_idx + 1:]
    chart_path.write_text('\n'.join(new_lines) + '\n')

    return sum(1 for _ in lyrics.get('words', []))


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
    lyrics shape. Each VAD segment becomes one phrase. `progress_callback` is
    callable(step: str, percent: int, msg: str) — same shape as elsewhere."""
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
        'fetched_at': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'words': words,
    }
