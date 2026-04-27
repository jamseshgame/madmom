"""Audio metadata extraction and format conversion via ffmpeg/ffprobe."""

import io
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


async def fetch_cover_from_web(artist: str, album: str = '', title: str = '') -> bytes | None:
    """Fetch album artwork via iTunes Search API, falling back to MusicBrainz."""
    import httpx

    artist = (artist or '').strip()
    album = (album or '').strip()
    title = (title or '').strip()
    if not artist and not album and not title:
        return None

    async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
        # iTunes Search — prefer album-level, fall back to song
        queries = []
        if artist and album:
            queries.append(('album', f'{artist} {album}'))
        if artist and title:
            queries.append(('song', f'{artist} {title}'))
        if album:
            queries.append(('album', album))
        if title:
            queries.append(('song', title))

        for entity, term in queries:
            try:
                r = await client.get(
                    'https://itunes.apple.com/search',
                    params={'term': term, 'entity': entity, 'limit': 1},
                )
                r.raise_for_status()
                results = r.json().get('results') or []
                if not results:
                    continue
                url = results[0].get('artworkUrl100') or ''
                if not url:
                    continue
                hi = url.replace('100x100bb', '600x600bb')
                img = await client.get(hi)
                if img.status_code == 200 and img.content:
                    return img.content
            except Exception:
                continue

        # MusicBrainz + Cover Art Archive as a secondary fallback
        if artist and (album or title):
            try:
                q = f'artist:{artist} AND release:{album or title}'
                mb = await client.get(
                    'https://musicbrainz.org/ws/2/release',
                    params={'query': q, 'limit': 1, 'fmt': 'json'},
                    headers={'User-Agent': 'JamseshStudio/1.0 ( team@jamsesh.co )'},
                )
                mb.raise_for_status()
                releases = mb.json().get('releases') or []
                if releases:
                    mbid = releases[0].get('id')
                    if mbid:
                        caa = await client.get(f'https://coverartarchive.org/release/{mbid}/front')
                        if caa.status_code == 200 and caa.content:
                            return caa.content
            except Exception:
                pass

    return None


def extract_cover_art(audio_path: str | Path) -> bytes | None:
    """Extract embedded cover art from an audio file as raw image bytes. Returns None if no cover."""
    try:
        result = subprocess.run(
            ['ffmpeg', '-v', 'quiet', '-i', str(audio_path), '-an', '-c:v', 'copy', '-f', 'image2pipe', 'pipe:1'],
            capture_output=True,
            timeout=15,
        )
        if result.returncode == 0 and result.stdout:
            return result.stdout
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None


def resize_to_square_png(image_bytes: bytes, size: int = 512) -> bytes:
    """Resize image to a `size x size` square PNG. Letterboxes to preserve aspect ratio."""
    from PIL import Image

    img = Image.open(io.BytesIO(image_bytes))
    if img.mode not in ('RGB', 'RGBA'):
        img = img.convert('RGBA' if 'transparency' in img.info else 'RGB')
    # Fit within square, then paste centered on a solid background to keep aspect
    img.thumbnail((size, size), Image.Resampling.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    x = (size - img.width) // 2
    y = (size - img.height) // 2
    canvas.paste(img, (x, y))
    # If the source was opaque, flatten to RGB so we don't ship unnecessary alpha
    if img.mode == 'RGB':
        bg = Image.new('RGB', (size, size), (0, 0, 0))
        bg.paste(canvas.convert('RGB'))
        canvas = bg
    out = io.BytesIO()
    canvas.save(out, format='PNG', optimize=True)
    return out.getvalue()
