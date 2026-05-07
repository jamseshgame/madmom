"""Unit tests for the ElevenLabs client module.

We test the key-resolution logic, the voice-list cache, and the synth_to_ogg
contract. Real HTTP traffic is mocked with respx via httpx.MockTransport.
"""
from __future__ import annotations

import importlib
from pathlib import Path

import httpx
import pytest


@pytest.fixture(autouse=True)
def _isolate_settings(tmp_path, monkeypatch):
    """Reset module state and point the repo-root probe at a tmp dir."""
    from web.backend.app.services import elevenlabs_client as mod
    importlib.reload(mod)
    # Force `_repo_root()` to point at tmp_path so the fallback file lookup is
    # isolated from whatever is in the actual repo.
    monkeypatch.setattr(mod, '_repo_root', lambda: tmp_path)
    # Clear settings.elevenlabs_api_key (pydantic-settings reads .env at import
    # time, so we patch the live settings instance).
    from web.backend.app.config import settings
    monkeypatch.setattr(settings, 'elevenlabs_api_key', '')
    mod.reset_voices_cache()
    yield


def test_resolve_api_key_prefers_env(monkeypatch):
    from web.backend.app.services import elevenlabs_client as mod
    from web.backend.app.config import settings
    monkeypatch.setattr(settings, 'elevenlabs_api_key', 'sk_from_env  ')
    assert mod.resolve_api_key() == 'sk_from_env'


def test_resolve_api_key_falls_back_to_file(tmp_path):
    from web.backend.app.services import elevenlabs_client as mod
    (tmp_path / 'elevenapi.txt').write_text('sk_from_file\n', encoding='utf-8')
    assert mod.resolve_api_key() == 'sk_from_file'


def test_resolve_api_key_raises_when_missing():
    from web.backend.app.services import elevenlabs_client as mod
    with pytest.raises(mod.NotConfiguredError):
        mod.resolve_api_key()


@pytest.mark.asyncio
async def test_list_voices_caches_for_five_minutes(tmp_path, monkeypatch):
    from web.backend.app.services import elevenlabs_client as mod
    (tmp_path / 'elevenapi.txt').write_text('sk_test', encoding='utf-8')
    calls = {'n': 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls['n'] += 1
        return httpx.Response(200, json={'voices': [{'voice_id': 'v1', 'name': 'A'}]})

    transport = httpx.MockTransport(handler)
    real_async_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kw: real_async_client(transport=transport, **kw))

    a = await mod.list_voices()
    b = await mod.list_voices()
    assert a == b == {'voices': [{'voice_id': 'v1', 'name': 'A'}]}
    assert calls['n'] == 1, 'second call should hit the cache'


@pytest.mark.asyncio
async def test_synth_to_ogg_writes_response_bytes(tmp_path, monkeypatch):
    from web.backend.app.services import elevenlabs_client as mod
    (tmp_path / 'elevenapi.txt').write_text('sk_test', encoding='utf-8')

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith('/v1/text-to-speech/voice_xyz')
        assert request.headers['xi-api-key'] == 'sk_test'
        return httpx.Response(200, content=b'OggS\x00fakeaudio')

    transport = httpx.MockTransport(handler)
    real_async_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kw: real_async_client(transport=transport, **kw))

    out = tmp_path / 'out.ogg'
    result = await mod.synth_to_ogg('Hello', 'voice_xyz', out)
    assert result == out
    assert out.read_bytes() == b'OggS\x00fakeaudio'


@pytest.mark.asyncio
async def test_synth_to_ogg_rejects_empty_text(tmp_path):
    from web.backend.app.services import elevenlabs_client as mod
    (tmp_path / 'elevenapi.txt').write_text('sk_test', encoding='utf-8')
    with pytest.raises(ValueError):
        await mod.synth_to_ogg('  ', 'v1', tmp_path / 'x.ogg')
