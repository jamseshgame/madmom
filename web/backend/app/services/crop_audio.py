"""Crop a beatmap's song.ogg to end just after its last charted event."""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

from .audio import read_audio_metadata

# Matches a chart event line: "<tick> = <rest>" with an integer left-hand side.
_EVENT_RE = re.compile(r'^\s*(\d+)\s*=\s*(.*)$', re.MULTILINE)
# Note/star-power lines carry a trailing sustain length: "N <fret> <length>".
_NOTE_RE = re.compile(r'^[NSR]\s+\d+\s+(\d+)\s*$')


def last_event_tick(content: str) -> int:
    """Largest event tick across every section, including sustain tails."""
    max_tick = 0
    for m in _EVENT_RE.finditer(content):
        tick = int(m.group(1))
        rest = m.group(2).strip()
        note = _NOTE_RE.match(rest)
        if note:
            tick += int(note.group(1))
        if tick > max_tick:
            max_tick = tick
    return max_tick


def _resolution(content: str) -> int:
    m = re.search(r'Resolution\s*=\s*(\d+)', content)
    return int(m.group(1)) if m else 192


def _tempo_segments(content: str) -> list[tuple[int, float]]:
    """Ordered (tick, micro_bpm) BPM markers from [SyncTrack]. micro_bpm is the
    raw `B` value (bpm * 1000). Always starts at tick 0."""
    sync = re.search(r'\[SyncTrack\]\s*\n\{([^}]*)\}', content)
    markers: list[tuple[int, float]] = []
    if sync:
        for line in sync.group(1).splitlines():
            bm = re.match(r'\s*(\d+)\s*=\s*B\s+(\d+)', line)
            if bm:
                markers.append((int(bm.group(1)), float(bm.group(2))))
    markers.sort(key=lambda x: x[0])
    if not markers or markers[0][0] != 0:
        markers.insert(0, (0, 120000.0))
    return markers


def tick_to_ms(content: str, tick: int) -> float:
    """Convert a tick to milliseconds using the chart's tempo map.

    ms-per-beat = 60_000_000 / micro_bpm; ms-per-tick = ms-per-beat / resolution.
    Mirrors the editor's frontend tickToSec helper.
    """
    resolution = _resolution(content)
    segs = _tempo_segments(content)
    ms = 0.0
    for i, (seg_tick, micro_bpm) in enumerate(segs):
        next_tick = segs[i + 1][0] if i + 1 < len(segs) else None
        ms_per_tick = (60_000_000.0 / micro_bpm) / resolution
        if next_tick is not None and tick >= next_tick:
            ms += (next_tick - seg_tick) * ms_per_tick
        else:
            ms += (tick - seg_tick) * ms_per_tick
            break
    return ms


def update_song_length(ini_text: str, length_ms: int) -> str:
    """Set song_length under [song], replacing an existing line or inserting one."""
    if re.search(r'(?im)^\s*song_length\s*=.*$', ini_text):
        return re.sub(r'(?im)^\s*song_length\s*=.*$', f'song_length = {length_ms}', ini_text)
    # No song_length line — insert right after the [song] header (case-insensitive).
    m = re.search(r'(?im)^\s*\[song\]\s*$', ini_text)
    if m:
        idx = m.end()
        return ini_text[:idx] + f'\nsong_length = {length_ms}' + ini_text[idx:]
    # No [song] section at all — prepend one.
    return f'[song]\nsong_length = {length_ms}\n' + ini_text


def crop_song_ogg(bm_dir: Path, padding_ms: int) -> dict:
    """Crop bm_dir/song.ogg to (last event + padding). Overwrites in place and
    updates song_length in song.ini. Returns a result summary.

    Raises ValueError('no-events') if the chart has no croppable events.
    """
    bm_dir = Path(bm_dir)
    song = bm_dir / 'song.ogg'
    chart_path = bm_dir / 'notes.chart'
    padding_ms = max(0, int(padding_ms))

    content = chart_path.read_text(encoding='utf-8', errors='ignore') if chart_path.exists() else ''
    last_tick = last_event_tick(content)
    if last_tick <= 0:
        raise ValueError('no-events')

    last_event_ms = tick_to_ms(content, last_tick)
    crop_ms = last_event_ms + padding_ms

    actual_ms = float(read_audio_metadata(song).get('duration', 0.0)) * 1000.0
    clamped = False
    if actual_ms and crop_ms >= actual_ms:
        # Nothing to trim — target is at or past the file end.
        return {
            'last_event_ms': last_event_ms,
            'crop_ms': crop_ms,
            'duration_ms': actual_ms,
            'noop': True,
            'clamped': True,
        }

    tmp = bm_dir / 'song.crop.ogg'
    proc = subprocess.run(
        ['ffmpeg', '-y', '-i', str(song), '-t', f'{crop_ms / 1000.0:.3f}',
         '-vn', '-c:a', 'libvorbis', '-q:a', '6', str(tmp)],
        capture_output=True, text=True, timeout=120,
    )
    if proc.returncode != 0:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f'ffmpeg crop failed: {proc.stderr[-400:]}')
    os.replace(tmp, song)

    # Invalidate the cached waveform peaks so the editor re-extracts them.
    (bm_dir / 'song.peaks.f32').unlink(missing_ok=True)

    new_ms = float(read_audio_metadata(song).get('duration', crop_ms / 1000.0)) * 1000.0

    ini_path = bm_dir / 'song.ini'
    if ini_path.exists():
        ini_path.write_text(update_song_length(ini_path.read_text(encoding='utf-8'), round(new_ms)),
                            encoding='utf-8')

    return {
        'last_event_ms': last_event_ms,
        'crop_ms': crop_ms,
        'duration_ms': new_ms,
        'noop': False,
        'clamped': clamped,
    }
