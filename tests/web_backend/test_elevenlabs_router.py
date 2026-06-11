"""Integration tests for the elevenlabs router.

We mount the FastAPI app, mock the ElevenLabs HTTP layer, and exercise the
two Phase-1 endpoints. Auth is bypassed via the require_auth dependency
override pattern already used elsewhere.
"""
from __future__ import annotations

import importlib
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    # Point the repo-root probe at tmp_path
    from web.backend.app.services import elevenlabs_client as mod
    importlib.reload(mod)
    monkeypatch.setattr(mod, '_repo_root', lambda: tmp_path)
    mod.reset_voices_cache()

    # Neutralize any key configured via web/.env on the dev machine —
    # resolve_api_key checks settings BEFORE the elevenapi.txt fallback, so
    # without this the 503 test fails on hosts with a real key configured.
    from web.backend.app.config import settings
    monkeypatch.setattr(settings, 'elevenlabs_api_key', '')

    # Mock the HTTP layer. Capture original AsyncClient before patching to
    # avoid the recursive-transport trap.
    real_async_client = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == '/v1/voices':
            return httpx.Response(200, json={'voices': [{'voice_id': 'v1', 'name': 'Adam'}]})
        if request.url.path.startswith('/v1/text-to-speech/'):
            return httpx.Response(200, content=b'OggS\x00audio')
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kw: real_async_client(transport=transport, **kw))

    from web.backend.app.main import app
    from web.backend.app.routers.auth import require_auth
    app.dependency_overrides[require_auth] = lambda: None
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_voices_returns_503_when_no_key(client, tmp_path):
    # No elevenapi.txt in tmp_path → resolve_api_key raises
    resp = client.get('/api/elevenlabs/voices')
    assert resp.status_code == 503
    assert 'not configured' in resp.json()['detail'].lower()


def test_voices_returns_payload_when_configured(client, tmp_path):
    (tmp_path / 'elevenapi.txt').write_text('sk_test', encoding='utf-8')
    resp = client.get('/api/elevenlabs/voices')
    assert resp.status_code == 200
    assert resp.json() == {'voices': [{'voice_id': 'v1', 'name': 'Adam'}]}


def test_synth_writes_under_beatmap_vo_dir(client, tmp_path, monkeypatch):
    (tmp_path / 'elevenapi.txt').write_text('sk_test', encoding='utf-8')

    # Stub the beatmap-dir resolver so synth has somewhere to write
    fake_bm = tmp_path / 'fake_beatmap'
    fake_bm.mkdir()
    from web.backend.app.routers import elevenlabs as router_mod
    monkeypatch.setattr(router_mod, '_resolve_vo_dir', lambda track_id, beatmap_id: fake_bm / 'vo')
    # The router also calls get_track to validate the track exists; stub it.
    monkeypatch.setattr(router_mod, 'get_track', lambda track_id: object())

    resp = client.post(
        '/api/elevenlabs/synth',
        data={'text': 'hi', 'voice_id': 'v1', 'track_id': 't', 'beatmap_id': 'b'},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body['engine'] == 'elevenlabs'
    assert body['voice_id'] == 'v1'
    assert body['rel_path'].startswith('vo/')
    written = fake_bm / 'vo' / Path(body['filename']).name
    # _resolve_vo_dir in the route returns `fake_bm / 'vo'` as a Path; the
    # client writes the file inside it. Make sure the parent exists.
    assert written.parent.exists()
    assert written.exists()
    assert written.read_bytes() == b'OggS\x00audio'


def test_synth_400_on_empty_text(client, tmp_path):
    (tmp_path / 'elevenapi.txt').write_text('sk_test', encoding='utf-8')
    resp = client.post(
        '/api/elevenlabs/synth',
        data={'text': '   ', 'voice_id': 'v1', 'track_id': 't', 'beatmap_id': 'b'},
    )
    assert resp.status_code == 400
