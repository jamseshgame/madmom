"""ElevenLabs REST client used by the elevenlabs router and Phase 3 publisher.

Key resolution order:
  1. Settings.elevenlabs_api_key (loaded from .env via pydantic-settings).
  2. Repo-root file `elevenapi.txt` (gitignored) as a developer convenience.

If neither resolves, all calls raise NotConfiguredError. Callers should
translate that into a 503 to the frontend.
"""
from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

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
