"""Audio metadata extraction and format conversion via ffmpeg/ffprobe."""

import json
import subprocess
from pathlib import Path


def read_audio_metadata(audio_path: str | Path) -> dict:
    """Extract metadata from audio file using ffprobe."""
    meta = {}
    try:
        result = subprocess.run(
            ['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', str(audio_path)],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            info = json.loads(result.stdout)
            tags = info.get('format', {}).get('tags', {})
            tag_lower = {k.lower(): v for k, v in tags.items()}
            meta['title'] = tag_lower.get('title', '')
            meta['artist'] = tag_lower.get('artist', '')
            meta['album'] = tag_lower.get('album', '')
            meta['year'] = tag_lower.get('date', tag_lower.get('year', ''))
            meta['genre'] = tag_lower.get('genre', '')
            meta['track'] = tag_lower.get('track', tag_lower.get('tracknumber', ''))
            fmt = info.get('format', {})
            meta['duration'] = float(fmt.get('duration', 0))
    except (OSError, subprocess.TimeoutExpired, ValueError):
        pass
    return meta


def convert_to_ogg(input_path: str | Path, output_path: str | Path) -> bool:
    """Convert audio to Ogg Vorbis. Returns True on success."""
    result = subprocess.run(
        ['ffmpeg', '-y', '-i', str(input_path), '-vn', '-codec:a', 'libvorbis', '-q:a', '6', str(output_path)],
        capture_output=True,
        text=True,
        timeout=300,
    )
    return result.returncode == 0
