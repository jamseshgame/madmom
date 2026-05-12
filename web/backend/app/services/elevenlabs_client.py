"""ElevenLabs REST client used by the elevenlabs router and Phase 3 publisher.

Key resolution order:
  1. Settings.elevenlabs_api_key (loaded from .env via pydantic-settings).
  2. Repo-root file `elevenapi.txt` (gitignored) as a developer convenience.

If neither resolves, all calls raise NotConfiguredError. Callers should
translate that into a 503 to the frontend.
"""
from __future__ import annotations

import asyncio
import re
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx

from ..config import settings


class NotConfiguredError(RuntimeError):
    """Raised when no ElevenLabs API key can be resolved."""


_API_BASE = 'https://api.elevenlabs.io'
_VOICES_TTL_SECONDS = 300

_voices_cache: dict[str, Any] | None = None
_voices_cache_at: float = 0.0
_voices_lock = asyncio.Lock()


def _repo_root() -> Path:
    """Return the madmom repo root (4 levels up from this file)."""
    return Path(__file__).resolve().parents[3]


def resolve_api_key() -> str:
    """Try env first, then `<repo_root>/elevenapi.txt`. Raise if neither found."""
    if settings.elevenlabs_api_key:
        return settings.elevenlabs_api_key.strip()
    fallback = _repo_root() / 'elevenapi.txt'
    if fallback.exists():
        contents = fallback.read_text(encoding='utf-8').strip()
        if contents:
            return contents
    raise NotConfiguredError('ElevenLabs API key not configured (set ELEVENLABS_API_KEY or place elevenapi.txt at the repo root)')


def _headers() -> dict[str, str]:
    return {'xi-api-key': resolve_api_key(), 'accept': 'application/json'}


async def list_voices(force_refresh: bool = False) -> dict[str, Any]:
    """Return ElevenLabs voices payload with a 5-minute in-memory cache."""
    global _voices_cache, _voices_cache_at
    now = time.monotonic()
    async with _voices_lock:
        fresh = _voices_cache is not None and (now - _voices_cache_at) < _VOICES_TTL_SECONDS
        if fresh and not force_refresh:
            return _voices_cache  # type: ignore[return-value]
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(f'{_API_BASE}/v1/voices', headers=_headers())
            resp.raise_for_status()
            data = resp.json()
        _voices_cache = data
        _voices_cache_at = now
        return data


def reset_voices_cache() -> None:
    """Test hook to clear the voices cache between cases."""
    global _voices_cache, _voices_cache_at
    _voices_cache = None
    _voices_cache_at = 0.0


_STUDIO_ID_RE = re.compile(r'^[A-Za-z0-9_-]{12,40}$')


def parse_studio_url(url: str) -> tuple[str, str]:
    """Extract (project_id, chapter_id) from an ElevenLabs Studio URL.

    Accepted shapes:
      https://elevenlabs.io/app/studio/<project_id>?chapterId=<chapter_id>
      https://elevenlabs.io/app/studio/<project_id>/<chapter_id>
    Raises ValueError on any other shape.
    """
    url = url.strip()
    if not url:
        raise ValueError('URL is empty')
    parts = urlparse(url)
    if not parts.netloc:
        raise ValueError('Not a URL — paste a full https://elevenlabs.io/app/studio/... link')
    # Pull the project ID out of the path segment after /studio/.
    m = re.search(r'/studio/([A-Za-z0-9_-]+)(?:/([A-Za-z0-9_-]+))?', parts.path)
    if not m:
        raise ValueError('Could not find /studio/<project_id> in the URL')
    project_id = m.group(1)
    chapter_id = m.group(2) or ''
    if not chapter_id:
        # Fall through to the chapterId query param (the share-link shape).
        chapter_ids = parse_qs(parts.query).get('chapterId', [])
        chapter_id = chapter_ids[0] if chapter_ids else ''
    if not chapter_id:
        raise ValueError('Chapter ID missing — the URL needs a chapterId query param or a /studio/<project>/<chapter> path')
    if not _STUDIO_ID_RE.match(project_id) or not _STUDIO_ID_RE.match(chapter_id):
        raise ValueError('Project / chapter IDs look malformed')
    return project_id, chapter_id


def _extract_chapter_text(chapter: dict[str, Any]) -> str:
    """Best-effort text extraction across ElevenLabs Studio schema variants.

    Historically the chapter payload has carried text under one of:
      chapter['content']['blocks'][i]['text']
      chapter['content']['blocks'][i]['nodes'][j]['text']
      chapter['source_text']  (legacy)
    """
    parts: list[str] = []
    content = chapter.get('content') or {}
    blocks = content.get('blocks') or []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        block_text = block.get('text')
        if isinstance(block_text, str) and block_text.strip():
            parts.append(block_text.strip())
            continue
        for node in block.get('nodes') or []:
            if not isinstance(node, dict):
                continue
            nt = node.get('text')
            if isinstance(nt, str) and nt.strip():
                parts.append(nt.strip())
    if parts:
        return ' '.join(parts)
    fallback = chapter.get('source_text')
    if isinstance(fallback, str) and fallback.strip():
        return fallback.strip()
    return ''


async def list_studio_projects() -> list[dict[str, Any]]:
    """Return the connected account's Studio projects (id + name + state)."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f'{_API_BASE}/v1/studio/projects', headers=_headers())
        resp.raise_for_status()
        data = resp.json()
    projects = data.get('projects') or []
    out: list[dict[str, Any]] = []
    for p in projects:
        out.append({
            'project_id': p.get('project_id') or p.get('id') or '',
            'name': p.get('name') or '',
            'state': p.get('state') or '',
            'created_at_unix': p.get('created_at_unix') or 0,
        })
    return out


async def list_studio_chapters(project_id: str) -> list[dict[str, Any]]:
    """Return chapters for a Studio project."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f'{_API_BASE}/v1/studio/projects/{project_id}/chapters',
            headers=_headers(),
        )
        resp.raise_for_status()
        data = resp.json()
    chapters = data.get('chapters') or []
    out: list[dict[str, Any]] = []
    for c in chapters:
        out.append({
            'chapter_id': c.get('chapter_id') or c.get('id') or '',
            'name': c.get('name') or '',
            'state': c.get('state') or '',
        })
    return out


async def import_studio_chapter(
    project_id: str,
    chapter_id: str,
    out_dir: Path,
) -> dict[str, Any]:
    """Fetch chapter metadata + the latest rendered audio snapshot.

    Writes the audio bytes to `out_dir/<uuid>.<ext>` and returns a dict with
    `rel_path`, `filename`, `name`, `text`, `project_id`, `chapter_id`,
    `size_bytes`. Raises ValueError if the chapter has no snapshots yet
    (caller should surface that as a 400).
    """
    base = f'{_API_BASE}/v1/studio/projects/{project_id}/chapters/{chapter_id}'
    async with httpx.AsyncClient(timeout=120.0) as client:
        # 1. Chapter metadata (script text + name).
        ch_resp = await client.get(base, headers=_headers())
        # ElevenLabs gates Studio API access behind an account-tier whitelist
        # — every Studio endpoint returns 403 invalid_subscription until they
        # enable it. Translate that into a human-readable ValueError so the
        # frontend modal can surface a clear message instead of raw HTTP.
        if ch_resp.status_code == 403 and 'invalid_subscription' in ch_resp.text:
            raise ValueError(
                'ElevenLabs Studio API is not enabled on this account. '
                'Contact ElevenLabs sales to whitelist your account for the Studio API, '
                'or copy the script text from Studio into a regular VO and click Generate.'
            )
        ch_resp.raise_for_status()
        chapter = ch_resp.json()
        name = chapter.get('name') or 'Imported chapter'
        text = _extract_chapter_text(chapter)

        # 2. Pick the most recently rendered snapshot.
        snap_resp = await client.get(f'{base}/snapshots', headers=_headers())
        snap_resp.raise_for_status()
        snap_payload = snap_resp.json()
        snapshots = snap_payload.get('snapshots') or []
        if not snapshots:
            raise ValueError('Chapter has no rendered audio yet — render it in Studio first, then retry.')
        snapshots.sort(key=lambda s: s.get('created_at_unix') or 0, reverse=True)
        snapshot = snapshots[0]
        snapshot_id = snapshot.get('chapter_snapshot_id') or snapshot.get('snapshot_id') or snapshot.get('id')
        if not snapshot_id:
            raise ValueError('Snapshot record is missing an id field')

        # 3. Download the audio. ElevenLabs renders Studio chapters as MP3 by
        #    default; we save whatever Content-Type we get back as the file
        #    extension. The frontend <audio> element + browser MIME detection
        #    handle MP3 just fine for VO playback.
        audio_resp = await client.get(f'{base}/snapshots/{snapshot_id}/audio', headers=_headers())
        audio_resp.raise_for_status()
        audio_bytes = audio_resp.content
        content_type = (audio_resp.headers.get('content-type') or '').lower()

    if 'ogg' in content_type:
        ext = 'ogg'
    elif 'mpeg' in content_type or 'mp3' in content_type:
        ext = 'mp3'
    elif 'wav' in content_type:
        ext = 'wav'
    else:
        ext = 'mp3'  # safe default — ElevenLabs Studio defaults to MP3
    out_filename = f'{uuid.uuid4().hex[:12]}.{ext}'
    out_path = out_dir / out_filename
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(audio_bytes)
    return {
        'filename': out_filename,
        'rel_path': f'vo/{out_filename}',
        'name': name,
        'text': text,
        'project_id': project_id,
        'chapter_id': chapter_id,
        'size_bytes': len(audio_bytes),
    }


async def synth_to_ogg(text: str, voice_id: str, out_path: Path) -> Path:
    """Synthesize `text` with `voice_id` and write OGG bytes to `out_path`.

    Returns out_path on success. Raises NotConfiguredError if no key is set,
    httpx.HTTPStatusError if ElevenLabs rejects the request, and bubbles up
    network/IO errors otherwise.
    """
    if not text.strip():
        raise ValueError('text is required')
    if not voice_id.strip():
        raise ValueError('voice_id is required')
    headers = {**_headers(), 'accept': 'audio/ogg', 'content-type': 'application/json'}
    body = {
        'text': text,
        'model_id': 'eleven_multilingual_v2',
        'voice_settings': {'stability': 0.5, 'similarity_boost': 0.75},
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f'{_API_BASE}/v1/text-to-speech/{voice_id}',
            headers=headers,
            json=body,
        )
        resp.raise_for_status()
        out_path.write_bytes(resp.content)
    return out_path
