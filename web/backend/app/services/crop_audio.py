"""Audio cropping.

Two independent jobs live here:

* ``crop_song_ogg`` — trims a *beatmap's* song.ogg to end just after its last
  charted event.
* ``crop_track_audio`` — trims the head and tail off *every stem of a track* by
  the same amount, so the stems stay aligned with each other.
"""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING

from .audio import read_audio_metadata

if TYPE_CHECKING:
    from .tracks import Track

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


# ── Track-level cropping ────────────────────────────────────────────────────

# Entries in Track.stems that aren't audio and must never be handed to ffmpeg.
NON_AUDIO_STEMS = {'song_ini', 'album_png'}

# Per-container encoder flags. Stream copy is deliberately not an option: it
# can only cut on frame boundaries, which would let the stems drift from each
# other by up to a frame — the exact desync this feature exists to avoid.
_ENCODERS = {
    '.ogg': ['-c:a', 'libvorbis', '-q:a', '6'],
    '.oga': ['-c:a', 'libvorbis', '-q:a', '6'],
    '.mp3': ['-c:a', 'libmp3lame', '-q:a', '2'],
    '.wav': ['-c:a', 'pcm_s16le'],
    '.flac': ['-c:a', 'flac'],
    '.m4a': ['-c:a', 'aac', '-b:a', '256k'],
}


def _duration_sec(path: Path) -> float:
    """Duration in seconds, or 0.0 for anything ffprobe can't read."""
    try:
        return float(read_audio_metadata(path).get('duration', 0.0) or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _encode_segment(src: Path, dst: Path, start_sec: float, end_sec: float) -> None:
    """Re-encode [start, end) of `src` into `dst`, preserving the container."""
    proc = subprocess.run(
        ['ffmpeg', '-y', '-ss', f'{start_sec:.3f}', '-i', str(src),
         '-t', f'{end_sec - start_sec:.3f}', '-vn',
         *_ENCODERS.get(src.suffix.lower(), []), str(dst)],
        capture_output=True, text=True, timeout=600,
    )
    if proc.returncode != 0:
        raise RuntimeError(f'ffmpeg crop of {src.name} failed: {proc.stderr[-400:]}')


def crop_track_audio(track: 'Track', start_sec: float, end_sec: float) -> dict:
    """Trim every audio stem of `track` — and its stored master — to
    [start_sec, end_sec). Overwrites in place.

    Every file is encoded to a temp sibling first and only swapped in once the
    whole set succeeded, so a failure part-way leaves the track untouched
    rather than half-cropped (which would silently desync the stems).

    Beatmaps keep their own song.ogg copies and are deliberately left alone;
    their ids come back in ``beatmaps_untouched`` so the caller can warn.

    Raises ValueError for an unusable range or a track with no audio.
    """
    start_sec = float(start_sec)
    end_sec = float(end_sec)
    if start_sec < 0:
        raise ValueError('start-before-zero')
    if end_sec <= start_sec:
        raise ValueError('empty-range')

    targets: list[tuple[str, Path]] = []
    for stem, filename in track.stems.items():
        if stem in NON_AUDIO_STEMS or not filename:
            continue
        path = track.stems_dir / filename
        if path.exists():
            targets.append((stem, path))
    if track.source_path:
        targets.append(('source', track.source_path))
    if not targets:
        raise ValueError('no-audio-stems')

    duration = max(_duration_sec(path) for _, path in targets)
    # A small tolerance so an end dragged to the very end of the waveform isn't
    # rejected over container/decoder rounding.
    if duration and end_sec > duration + 0.05:
        raise ValueError('end-past-duration')

    # Encode everything before swapping anything.
    pending: list[tuple[Path, Path]] = []
    try:
        for _, path in targets:
            # Game-library tracks symlink their stems back into _game-songs/;
            # replacing the link instead of its target would break that.
            real = Path(os.path.realpath(path))
            tmp = real.with_name(f'{real.stem}.crop{real.suffix}')
            pending.append((real, tmp))
            _encode_segment(real, tmp, start_sec, end_sec)
    except Exception:
        for _, tmp in pending:
            tmp.unlink(missing_ok=True)
        raise

    for real, tmp in pending:
        os.replace(tmp, real)

    # Cached waveform peaks now describe audio that no longer exists.
    (track.stems_dir / 'peaks.json').unlink(missing_ok=True)
    for cache in track.stems_dir.glob('*.peaks.f32'):
        cache.unlink(missing_ok=True)

    new_ms = _duration_sec(pending[0][0]) * 1000.0 or (end_sec - start_sec) * 1000.0

    ini_path = track.stems_dir / 'song.ini'
    if ini_path.exists():
        ini_path.write_text(
            update_song_length(ini_path.read_text(encoding='utf-8'), round(new_ms)),
            encoding='utf-8',
        )

    return {
        'start_sec': start_sec,
        'end_sec': end_sec,
        'duration_ms': new_ms,
        'cropped': [stem for stem, _ in targets],
        'beatmaps_untouched': [b['id'] for b in track.beatmaps if b.get('id')],
    }
