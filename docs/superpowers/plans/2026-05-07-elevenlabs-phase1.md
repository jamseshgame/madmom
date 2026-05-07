# ElevenLabs Phase 1 — Alt TTS Engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ElevenLabs available as a per-VO TTS engine alongside Chatterbox, with a track-level default voice + per-VO voice override, all without exposing the API key to the browser.

**Architecture:** Backend gets a new pure client (`elevenlabs_client.py`) and a thin auth-gated router (`routers/elevenlabs.py`) that proxies voices + synth. The chart's `VO` line gains two optional attributes (`engine=`, `voice=`) parsed and serialized inside the existing tutorial-section helpers. The editor's VO card shows an engine radio + voice dropdown; the Track detail page persists a per-track default voice id into `song.ini`. The Phase 2 (Studio import) and Phase 3 (publish-time bundle) work plugs into the same client.

**Tech stack:** FastAPI + pydantic-settings + `httpx.AsyncClient` (no ElevenLabs SDK — REST directly). React 18 / TypeScript / Vite for the UI. pytest for backend unit + integration tests; the frontend has no test framework, so verification is `npm run build` + targeted manual smoke-tests.

---

## File map

- **Create** `web/backend/app/services/elevenlabs_client.py`
  - Pure module: key resolution, in-memory voice cache, `list_voices()`, `synth_to_ogg()`. No FastAPI imports.
- **Create** `web/backend/app/routers/elevenlabs.py`
  - Auth-gated router. Exposes `GET /api/elevenlabs/voices` + `POST /api/elevenlabs/synth` for Phase 1. Phase 2 adds the studio routes here too.
- **Create** `tests/web_backend/test_elevenlabs_client.py`
  - Unit tests for key resolution + voice cache. Mocks `httpx.AsyncClient`.
- **Create** `tests/web_backend/test_elevenlabs_router.py`
  - Integration tests: voices endpoint returns cached payload; synth endpoint writes a file under the beatmap dir; both return 503 when no key is configured.
- **Modify** `web/backend/app/config.py` — add `elevenlabs_api_key: str = ''`.
- **Modify** `web/backend/app/main.py` — `include_router(elevenlabs.router, dependencies=_auth_dep)`.
- **Modify** `web/backend/requirements.txt` — no new package; httpx already present.
- **Modify** `web/.env.example` — add `ELEVENLABS_API_KEY=` line.
- **Modify** `web/backend/app/services/tracks.py` — add `read_elevenlabs_voice(track_id)` + `write_elevenlabs_voice(track_id, voice_id)` helpers.
- **Modify** `web/backend/app/routers/tracks.py` (or wherever the per-track endpoints live; see Task 4 for grep) — `GET` + `PUT` `/api/tracks/{id}/elevenlabs-voice`.
- **Modify** `web/frontend/src/components/BeatmapEditor.tsx`
  - `TutorialVoEvent` type gains `engine`, `voiceId`.
  - `parseTutorialSection` reads `engine=` + `voice=` from VO lines.
  - `serializeTutorialSection` writes them back.
  - `addVo` defaults engine to `chatterbox`.
  - VO card UI gets engine radio + voice dropdown.
  - `generateVoAudio` routes to the right backend endpoint.
- (No `TracksPage.tsx` change in Phase 1 — the default-voice picker lives in the editor's tutorial sidebar instead, since `elevenlabs_voice_id` is per-beatmap. See Task 7's note.)

No backend test framework needs to be added — `pytest` is already configured (per CLAUDE.md). Phase 1 backend tests live under `tests/web_backend/`. If that directory doesn't already exist, the first test task creates it.

---

## Task 1: Backend config + key resolution

**Files:**
- Modify: `web/backend/app/config.py`
- Create: `web/backend/app/services/elevenlabs_client.py`
- Create: `tests/web_backend/__init__.py` (empty)
- Create: `tests/web_backend/test_elevenlabs_client.py`

- [ ] **Step 1: Add the env field to Settings**

Edit `web/backend/app/config.py`. Find the line `studio_password: str = 'SlayTheStage'` and add a blank line after it, then:

```python
    elevenlabs_api_key: str = ''
```

So the section reads:

```python
    studio_username: str = 'admin'
    studio_password: str = 'SlayTheStage'

    elevenlabs_api_key: str = ''
```

- [ ] **Step 2: Scaffold the client module**

Create `web/backend/app/services/elevenlabs_client.py`:

```python
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
```

- [ ] **Step 3: Write failing tests for key resolution + voice cache**

Create `tests/web_backend/__init__.py` as an empty file.

Create `tests/web_backend/test_elevenlabs_client.py`:

```python
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
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kw: httpx.AsyncClient(transport=transport, **kw))

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
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kw: httpx.AsyncClient(transport=transport, **kw))

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
```

- [ ] **Step 4: Run the tests to confirm they fail**

```
pytest tests/web_backend/test_elevenlabs_client.py -v
```

Expected: tests fail (the client file might not import cleanly until config has the new field). If the only failure is `ModuleNotFoundError: web.backend.app.services.elevenlabs_client` you wrote it wrong; otherwise the tests should attempt to load and at least run.

- [ ] **Step 5: Run the tests to confirm they pass**

```
pytest tests/web_backend/test_elevenlabs_client.py -v
```

Expected: all 5 tests pass.

- [ ] **Step 6: Commit**

```
git add web/backend/app/config.py web/backend/app/services/elevenlabs_client.py tests/web_backend/__init__.py tests/web_backend/test_elevenlabs_client.py
git commit -m "feat(elevenlabs): backend client + key resolution"
```

---

## Task 2: Backend `/voices` and `/synth` router

**Files:**
- Create: `web/backend/app/routers/elevenlabs.py`
- Modify: `web/backend/app/main.py`
- Create: `tests/web_backend/test_elevenlabs_router.py`

- [ ] **Step 1: Write failing integration tests for the router**

Create `tests/web_backend/test_elevenlabs_router.py`:

```python
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

    # Mock the HTTP layer
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == '/v1/voices':
            return httpx.Response(200, json={'voices': [{'voice_id': 'v1', 'name': 'Adam'}]})
        if request.url.path.startswith('/v1/text-to-speech/'):
            return httpx.Response(200, content=b'OggS\x00audio')
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kw: httpx.AsyncClient(transport=transport, **kw))

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
    assert written.exists()
    assert written.read_bytes() == b'OggS\x00audio'


def test_synth_400_on_empty_text(client, tmp_path):
    (tmp_path / 'elevenapi.txt').write_text('sk_test', encoding='utf-8')
    resp = client.post(
        '/api/elevenlabs/synth',
        data={'text': '   ', 'voice_id': 'v1', 'track_id': 't', 'beatmap_id': 'b'},
    )
    assert resp.status_code == 400
```

- [ ] **Step 2: Run them to confirm they fail**

```
pytest tests/web_backend/test_elevenlabs_router.py -v
```

Expected: ImportError or 404s — the router doesn't exist yet.

- [ ] **Step 3: Create the router**

Create `web/backend/app/routers/elevenlabs.py`:

```python
"""ElevenLabs proxy endpoints.

Phase 1 surfaces voice listing and TTS synthesis. Phase 2 will extend this
file with Studio browse + import endpoints. Phase 3 reuses the same client
from the GitHub publisher.
"""
from __future__ import annotations

import uuid
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Form, HTTPException
from fastapi.responses import JSONResponse

from ..services import elevenlabs_client
from ..services.tracks import get_beatmap_dir, get_track

router = APIRouter(prefix='/api/elevenlabs', tags=['elevenlabs'])


def _resolve_vo_dir(track_id: str, beatmap_id: str) -> Optional[Path]:
    """Mirror routers/tutorial.py::_vo_dir so file layout stays identical
    across engines. Returns None if track/beatmap pair is invalid."""
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        return None
    d = bm_dir / 'vo'
    d.mkdir(parents=True, exist_ok=True)
    return d


@router.get('/voices')
async def voices(refresh: bool = False) -> JSONResponse:
    try:
        data = await elevenlabs_client.list_voices(force_refresh=refresh)
    except elevenlabs_client.NotConfiguredError as e:
        raise HTTPException(503, str(e))
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, f'ElevenLabs: {e.response.text[:200]}')
    return JSONResponse(content=data)


@router.post('/synth')
async def synth(
    text: str = Form(...),
    voice_id: str = Form(...),
    track_id: str = Form(...),
    beatmap_id: str = Form(...),
):
    text = text.strip()
    if not text:
        raise HTTPException(400, 'text is required')
    if not voice_id.strip():
        raise HTTPException(400, 'voice_id is required')
    if get_track(track_id) is None:
        raise HTTPException(404, 'Track not found')
    out_dir = _resolve_vo_dir(track_id, beatmap_id)
    if out_dir is None:
        raise HTTPException(404, 'Beatmap not found')

    out_filename = f'{uuid.uuid4().hex[:12]}.ogg'
    out_path = out_dir / out_filename
    try:
        await elevenlabs_client.synth_to_ogg(text, voice_id, out_path)
    except elevenlabs_client.NotConfiguredError as e:
        raise HTTPException(503, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, f'ElevenLabs: {e.response.text[:200]}')

    return {
        'filename': out_filename,
        'rel_path': f'vo/{out_filename}',
        'voice_id': voice_id,
        'engine': 'elevenlabs',
        'size_bytes': out_path.stat().st_size,
    }
```

- [ ] **Step 4: Register the router in main.py**

Edit `web/backend/app/main.py`. Find the line `app.include_router(tutorial.router, dependencies=_auth_dep)` and add an import + include for the new router. The imports section already imports the other router modules — add `elevenlabs` next to them. Then below the `tutorial` line, add:

```python
app.include_router(elevenlabs.router, dependencies=_auth_dep)
```

(Whatever import-block style main.py uses, follow it. If routers are imported from a single line `from .routers import auth, beatmap, ...`, add `elevenlabs` to that list.)

- [ ] **Step 5: Run the tests to confirm they pass**

```
pytest tests/web_backend/test_elevenlabs_router.py -v
```

Expected: all 4 tests pass.

- [ ] **Step 6: Commit**

```
git add web/backend/app/routers/elevenlabs.py web/backend/app/main.py tests/web_backend/test_elevenlabs_router.py
git commit -m "feat(elevenlabs): /voices + /synth router"
```

---

## Task 3: `.env.example` + secrets hygiene

**Files:**
- Modify: `web/.env.example`

- [ ] **Step 1: Add the env example line**

Edit `web/.env.example`. Find the section after `GITHUB_INBOX_PREFIX=SongInbox`. Add a new section block above the `# DigitalOcean` block:

```
# ElevenLabs (Phase 1+ TTS)
ELEVENLABS_API_KEY=sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- [ ] **Step 2: Commit**

```
git add web/.env.example
git commit -m "docs(env): document ELEVENLABS_API_KEY"
```

---

## Task 4: Per-track default voice in song.ini

**Files:**
- Modify: `web/backend/app/services/tracks.py`
- Modify: `web/backend/app/routers/tracks.py` (or wherever per-track endpoints live — see Step 1)
- Create test: `tests/web_backend/test_song_ini_voice.py`

- [ ] **Step 1: Locate the per-track endpoints file**

Run from the repo root:

```
grep -ln "/api/tracks/" web/backend/app/routers
```

The file you'll modify in Step 4 is whichever router file already defines `@router.get('/api/tracks/{track_id}')` or similar per-track GET routes. Likely `web/backend/app/routers/tracks.py`.

- [ ] **Step 2: Write the failing test**

Create `tests/web_backend/test_song_ini_voice.py`:

```python
"""Tests for elevenlabs_voice_id read/write in song.ini."""
from __future__ import annotations

from pathlib import Path

import pytest

from web.backend.app.services import tracks as tracks_svc


@pytest.fixture
def beatmap_dir(tmp_path, monkeypatch):
    """Return a fake beatmap dir with a starter song.ini, and stub the
    track/beatmap resolver so the helpers under test find it."""
    bm = tmp_path / 'beatmap'
    bm.mkdir()
    (bm / 'song.ini').write_text(
        '[song]\nname = Test\nartist = Foo\n', encoding='utf-8',
    )
    monkeypatch.setattr(tracks_svc, 'get_beatmap_dir', lambda t, b: bm)
    return bm


def test_read_returns_empty_when_key_missing(beatmap_dir):
    assert tracks_svc.read_elevenlabs_voice('t', 'b') == ''


def test_write_appends_then_read_returns_value(beatmap_dir):
    tracks_svc.write_elevenlabs_voice('t', 'b', 'voice_abc')
    assert tracks_svc.read_elevenlabs_voice('t', 'b') == 'voice_abc'
    body = (beatmap_dir / 'song.ini').read_text(encoding='utf-8')
    assert 'elevenlabs_voice_id = voice_abc' in body
    # Existing keys are preserved
    assert 'name = Test' in body
    assert 'artist = Foo' in body


def test_write_rewrites_existing_value(beatmap_dir):
    (beatmap_dir / 'song.ini').write_text(
        '[song]\nname = Test\nelevenlabs_voice_id = old\n', encoding='utf-8',
    )
    tracks_svc.write_elevenlabs_voice('t', 'b', 'new')
    assert tracks_svc.read_elevenlabs_voice('t', 'b') == 'new'
    body = (beatmap_dir / 'song.ini').read_text(encoding='utf-8')
    assert body.count('elevenlabs_voice_id') == 1
```

- [ ] **Step 3: Run the tests to confirm they fail**

```
pytest tests/web_backend/test_song_ini_voice.py -v
```

Expected: `AttributeError: module 'web.backend.app.services.tracks' has no attribute 'read_elevenlabs_voice'`.

- [ ] **Step 4: Add helpers to `web/backend/app/services/tracks.py`**

Append the following at the bottom of `web/backend/app/services/tracks.py`:

```python
def read_elevenlabs_voice(track_id: str, beatmap_id: str) -> str:
    """Return the elevenlabs_voice_id from a beatmap's song.ini, or '' if absent."""
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        return ''
    ini = bm_dir / 'song.ini'
    if not ini.exists():
        return ''
    for raw in ini.read_text(encoding='utf-8', errors='replace').splitlines():
        line = raw.strip()
        if not line or line.startswith(('#', ';', '[')) or '=' not in line:
            continue
        k, _, v = line.partition('=')
        if k.strip().lower() == 'elevenlabs_voice_id':
            return v.strip()
    return ''


def write_elevenlabs_voice(track_id: str, beatmap_id: str, voice_id: str) -> bool:
    """Write/replace elevenlabs_voice_id in song.ini. Returns True on success.

    Mirrors the existing line-based song.ini editing pattern: scan for the
    key, replace if found, otherwise append at end (preserving every other
    line verbatim).
    """
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        return False
    ini = bm_dir / 'song.ini'
    if not ini.exists():
        ini.write_text(f'[song]\nelevenlabs_voice_id = {voice_id.strip()}\n', encoding='utf-8')
        return True
    lines = ini.read_text(encoding='utf-8', errors='replace').splitlines()
    needle = 'elevenlabs_voice_id'
    rewrote = False
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith('#') or stripped.startswith(';') or '=' not in stripped:
            continue
        k, _, _ = stripped.partition('=')
        if k.strip().lower() == needle:
            lines[i] = f'{needle} = {voice_id.strip()}'
            rewrote = True
            break
    if not rewrote:
        lines.append(f'{needle} = {voice_id.strip()}')
    ini.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return True
```

- [ ] **Step 5: Run the tests to confirm they pass**

```
pytest tests/web_backend/test_song_ini_voice.py -v
```

Expected: all 3 tests pass.

- [ ] **Step 6: Add a GET + PUT endpoint**

Edit the per-track router file from Step 1. Append two new routes (use whatever import style the rest of the file uses):

```python
from ..services.tracks import read_elevenlabs_voice, write_elevenlabs_voice


@router.get('/{track_id}/beatmaps/{beatmap_id}/elevenlabs-voice')
def get_elevenlabs_voice(track_id: str, beatmap_id: str):
    return {'voice_id': read_elevenlabs_voice(track_id, beatmap_id)}


@router.put('/{track_id}/beatmaps/{beatmap_id}/elevenlabs-voice')
def put_elevenlabs_voice(track_id: str, beatmap_id: str, payload: dict):
    voice_id = (payload.get('voice_id') or '').strip()
    ok = write_elevenlabs_voice(track_id, beatmap_id, voice_id)
    if not ok:
        raise HTTPException(404, 'Beatmap not found')
    return {'voice_id': voice_id}
```

(If the file already has `from ..services.tracks import ...`, add the two helper names to the existing import line instead of a new line.)

If the per-track router has its own prefix already, drop the `/{track_id}/...` portion that's already in the prefix. Verify by reading 10 lines around the `router = APIRouter(...)` declaration.

- [ ] **Step 7: Commit**

```
git add web/backend/app/services/tracks.py web/backend/app/routers/tracks.py tests/web_backend/test_song_ini_voice.py
git commit -m "feat(elevenlabs): per-track default voice in song.ini"
```

---

## Task 5: Frontend — chart parsing/serialization for engine + voice attrs

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx`

- [ ] **Step 1: Extend `TutorialVoEvent`**

In `BeatmapEditor.tsx`, find the existing interface (around line 18):

```ts
interface TutorialVoEvent {
  kind: 'vo'
  id: string             // ephemeral, not persisted (regenerated per parse)
  tick: number
  file: string           // relative path under the beatmap dir, e.g. "vo/abc.ogg"
  text: string           // optional draft text used to (re)generate the clip
}
```

Replace it with:

```ts
type VoEngine = 'chatterbox' | 'elevenlabs'

interface TutorialVoEvent {
  kind: 'vo'
  id: string             // ephemeral, not persisted (regenerated per parse)
  tick: number
  file: string           // relative path under the beatmap dir, e.g. "vo/abc.ogg"
  text: string           // optional draft text used to (re)generate the clip
  engine: VoEngine       // which TTS engine generated the file (defaults to chatterbox)
  voiceId: string        // when engine === 'elevenlabs'; '' means inherit track default
}
```

- [ ] **Step 2: Read `engine=` and `voice=` in `parseTutorialSection`**

Find the VO branch in `parseTutorialSection` (around line 177):

```ts
    if (kind === 'VO') {
      const file = tokens[1] || ''
      let textArg = ''
      for (const t of tokens.slice(2)) {
        if (t.startsWith('text=')) textArg = t.slice(5)
      }
      events.push({
        kind: 'vo',
        id: `vo-${tick}-${counter++}`,
        tick,
        file,
        text: textArg,
      })
    }
```

Replace it with:

```ts
    if (kind === 'VO') {
      const file = tokens[1] || ''
      let textArg = ''
      let engineArg: VoEngine = 'chatterbox'
      let voiceArg = ''
      for (const t of tokens.slice(2)) {
        if (t.startsWith('text=')) textArg = t.slice(5)
        else if (t.startsWith('engine=')) {
          const v = t.slice(7).toLowerCase()
          if (v === 'elevenlabs' || v === 'chatterbox') engineArg = v
        }
        else if (t.startsWith('voice=')) voiceArg = t.slice(6)
      }
      events.push({
        kind: 'vo',
        id: `vo-${tick}-${counter++}`,
        tick,
        file,
        text: textArg,
        engine: engineArg,
        voiceId: voiceArg,
      })
    }
```

- [ ] **Step 3: Write `engine=` and `voice=` in `serializeTutorialSection`**

Find the VO branch in `serializeTutorialSection` (around line 250):

```ts
    if (e.kind === 'vo') {
      const t = e.text ? ` text="${e.text.replace(/"/g, "'")}"` : ''
      return `  ${e.tick} = VO "${e.file}"${t}`
    }
```

Replace with:

```ts
    if (e.kind === 'vo') {
      const t = e.text ? ` text="${e.text.replace(/"/g, "'")}"` : ''
      const engine = e.engine && e.engine !== 'chatterbox' ? ` engine=${e.engine}` : ''
      const voice = e.voiceId ? ` voice=${e.voiceId}` : ''
      return `  ${e.tick} = VO "${e.file}"${t}${engine}${voice}`
    }
```

- [ ] **Step 4: Default new VOs to `chatterbox`**

Find the `addVo` helper (around line 1187):

```ts
  const addVo = () => {
    if (!chart) return
    const ev: TutorialVoEvent = {
      kind: 'vo',
      id: `vo-${Date.now()}`,
      tick: playheadTick,
      file: '',
      text: '',
    }
    updateTutorial([...chart.tutorial, ev], true)
  }
```

Replace with:

```ts
  const addVo = () => {
    if (!chart) return
    const ev: TutorialVoEvent = {
      kind: 'vo',
      id: `vo-${Date.now()}`,
      tick: playheadTick,
      file: '',
      text: '',
      engine: 'chatterbox',
      voiceId: '',
    }
    updateTutorial([...chart.tutorial, ev], true)
  }
```

- [ ] **Step 5: Build and confirm type-safety**

```
cd web/frontend && npm run build
```

Expected: build succeeds. The new fields might be referenced where they aren't initialized — if you see "Property 'engine' is missing in type" errors, find every other place that constructs a `TutorialVoEvent` literal and add `engine: 'chatterbox'`, `voiceId: ''`.

- [ ] **Step 6: Commit**

```
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): parse engine= and voice= attrs on VO lines"
```

---

## Task 6: Frontend — VO card UI for engine + voice + Generate routing

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx`

- [ ] **Step 1: Add a voices fetch hook**

Add this state + effect inside the `BeatmapEditor()` component, near the other top-level useState calls (e.g. above the existing `const [ttsBusy, setTtsBusy] = useState<string | null>(null)` line at ~1389):

```ts
  // ElevenLabs voices fetched once per editor session. 503 is the "not
  // configured" path; we fall back to an empty list and the engine radio
  // will explain the situation to the user.
  interface ElVoice { voice_id: string; name: string }
  const [elVoices, setElVoices] = useState<ElVoice[]>([])
  const [elVoicesLoaded, setElVoicesLoaded] = useState(false)
  const [elVoicesError, setElVoicesError] = useState('')
  const [trackVoiceId, setTrackVoiceId] = useState('')

  useEffect(() => {
    fetch('/api/elevenlabs/voices')
      .then(async (r) => {
        if (r.status === 503) {
          setElVoicesError('ElevenLabs not configured')
          setElVoicesLoaded(true)
          return
        }
        if (!r.ok) {
          setElVoicesError(`Failed to load voices (${r.status})`)
          setElVoicesLoaded(true)
          return
        }
        const data = await r.json()
        setElVoices((data.voices || []).map((v: { voice_id: string; name: string }) => ({
          voice_id: v.voice_id, name: v.name,
        })))
        setElVoicesLoaded(true)
      })
      .catch(() => {
        setElVoicesError('Network error loading voices')
        setElVoicesLoaded(true)
      })
    fetch(`/api/tracks/${trackId}/beatmaps/${beatmapId}/elevenlabs-voice`)
      .then((r) => (r.ok ? r.json() : { voice_id: '' }))
      .then((d) => setTrackVoiceId(d.voice_id || ''))
      .catch(() => undefined)
  }, [trackId, beatmapId])
```

- [ ] **Step 2: Route `generateVoAudio` to the right backend**

Find `generateVoAudio` (around line 1722). Replace the entire function body with:

```ts
  const generateVoAudio = async (ev: TutorialVoEvent) => {
    if (!ev.text.trim()) return
    setTtsBusy(ev.id)
    try {
      let endpoint: string
      const fd = new FormData()
      fd.append('text', ev.text)
      fd.append('track_id', trackId)
      fd.append('beatmap_id', beatmapId)
      if (ev.engine === 'elevenlabs') {
        const voice = ev.voiceId || trackVoiceId
        if (!voice) {
          throw new Error('No ElevenLabs voice selected (set a track default or pick one on this VO)')
        }
        fd.append('voice_id', voice)
        endpoint = '/api/elevenlabs/synth'
      } else {
        endpoint = '/api/tutorial/tts/synth'
      }
      const res = await fetch(endpoint, { method: 'POST', body: fd })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `TTS failed (${res.status})`)
      }
      const data = await res.json()
      updateTutorialEvent(ev.id, { file: data.rel_path })
    } catch (e) {
      window.alert((e as Error).message)
    } finally {
      setTtsBusy(null)
    }
  }
```

- [ ] **Step 3: Add the engine radio + voice dropdown to the VO card**

Find the VO card render block. Search for the literal text `placeholder="VO script — what the narrator says"` — the textarea is right above the controls row. Right after the textarea closing `/>` (still inside the same `<li>` block), and BEFORE the existing `<div className="flex items-center gap-1.5">` row that holds the Generate button, insert this new row:

```tsx
                          <div className="flex items-center gap-2 text-[10px] text-gray-400">
                            <label className="flex items-center gap-1 cursor-pointer">
                              <input
                                type="radio"
                                name={`engine-${ev.id}`}
                                checked={ev.engine === 'chatterbox'}
                                onChange={() => updateTutorialEvent(ev.id, { engine: 'chatterbox' })}
                                className="accent-jam-500"
                              />
                              Chatterbox
                            </label>
                            <label className="flex items-center gap-1 cursor-pointer">
                              <input
                                type="radio"
                                name={`engine-${ev.id}`}
                                checked={ev.engine === 'elevenlabs'}
                                onChange={() => updateTutorialEvent(ev.id, { engine: 'elevenlabs' })}
                                disabled={!!elVoicesError}
                                className="accent-jam-500"
                              />
                              ElevenLabs{elVoicesError ? ` (${elVoicesError})` : ''}
                            </label>
                            {ev.engine === 'elevenlabs' && (
                              <select
                                value={ev.voiceId}
                                onChange={(e) => updateTutorialEvent(ev.id, { voiceId: e.target.value })}
                                className="ml-auto bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-[10px] text-gray-200 max-w-[140px]"
                              >
                                <option value="">
                                  inherit{trackVoiceId
                                    ? ` (${(elVoices.find((v) => v.voice_id === trackVoiceId)?.name || 'track default')})`
                                    : ' (no track default)'}
                                </option>
                                {elVoices.map((v) => (
                                  <option key={v.voice_id} value={v.voice_id}>{v.name}</option>
                                ))}
                              </select>
                            )}
                          </div>
```

(Indentation matches the surrounding JSX — adjust if your editor's auto-format differs.)

- [ ] **Step 4: Build and smoke-test**

```
cd web/frontend && npm run build
```

Expected: build succeeds.

In the dev server: open a beatmap → add a VO → switch the radio to ElevenLabs → voice dropdown appears with the inherited-from-track option + every voice in the account. Switching back to Chatterbox hides the dropdown. Type some text → click Generate → audio plays.

- [ ] **Step 5: Commit**

```
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): per-VO engine radio + voice dropdown"
```

---

## Task 7: Frontend — beatmap default voice setter in editor sidebar

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx`

**Note on placement deviation from spec:** the spec called for the dropdown on the Track detail page's Tutorial samples panel, but our `elevenlabs_voice_id` storage is per-beatmap (song.ini lives in the beatmap dir, not the track dir). Putting the setter in the editor sidebar — where `trackId + beatmapId` are already in scope and Task 6 already loads `trackVoiceId` — keeps the data flow consistent. The TracksPage panel can grow this UI later if needed.

- [ ] **Step 1: Add the dropdown to the TUTORIAL sidebar card**

Find the existing TUTORIAL section header in the right sidebar (search the file for `>Tutorial</h3>`). The block looks like:

```tsx
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Tutorial</h3>
                <label className="flex items-center gap-1 text-[11px] text-gray-400">
                  <input
                    type="checkbox"
                    checked={chart.tutorialEnabled}
                    onChange={(e) => updateTutorial(chart.tutorial, e.target.checked)}
                    className="accent-jam-500"
                  />
                  enabled
                </label>
              </div>
              {chart.tutorialEnabled && (
                <>
                  <div className="grid grid-cols-3 gap-1 mb-2">
```

Immediately INSIDE the `{chart.tutorialEnabled && (` `<>...</>` fragment, BEFORE the existing `<div className="grid grid-cols-3 gap-1 mb-2">` (the `+ VO / + STEP / + MUSIC` row), insert:

```tsx
                  <div className="mb-2 p-2 bg-gray-900 border border-gray-800 rounded">
                    <div className="text-[10px] text-gray-500 mb-1 uppercase tracking-wider">ElevenLabs default voice</div>
                    {elVoicesError ? (
                      <p className="text-[10px] text-gray-600">{elVoicesError}</p>
                    ) : (
                      <select
                        value={trackVoiceId}
                        onChange={async (e) => {
                          const next = e.target.value
                          setTrackVoiceId(next)
                          await fetch(`/api/tracks/${trackId}/beatmaps/${beatmapId}/elevenlabs-voice`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ voice_id: next }),
                          })
                        }}
                        className="w-full bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200"
                      >
                        <option value="">— no default —</option>
                        {elVoices.map((v) => (
                          <option key={v.voice_id} value={v.voice_id}>{v.name}</option>
                        ))}
                      </select>
                    )}
                    <p className="text-[10px] text-gray-600 mt-1 leading-snug">
                      VOs set to ElevenLabs use this voice unless overridden per-VO.
                    </p>
                  </div>
```

This re-uses the `elVoices`, `elVoicesError`, `trackVoiceId`, `setTrackVoiceId` state introduced in Task 6 — no new fetches needed.

- [ ] **Step 2: Build and smoke-test**

```
cd web/frontend && npm run build
```

Expected: build succeeds.

In the dev server: open a beatmap with tutorial mode enabled → the new "ElevenLabs default voice" dropdown sits at the top of the Tutorial sidebar card, above the `+ VO / + STEP / + MUSIC` row. Pick a voice → reload the editor → the value persists. Add a VO → switch its engine to ElevenLabs → the per-VO dropdown shows `inherit (<picked voice name>)` as the first option.

- [ ] **Step 3: Commit**

```
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): default voice picker in tutorial sidebar"
```

---

## Task 8: End-to-end verification + push + deploy

**Files:** none (verification + deployment)

- [ ] **Step 1: Run the full backend test suite**

```
pytest tests/web_backend -v
```

Expected: every test passes (Phase 1 added 5 client tests + 4 router tests + 3 song.ini tests = 12 new tests).

- [ ] **Step 2: Production frontend build**

```
cd web/frontend && npm run build
```

Expected: build succeeds with no errors.

- [ ] **Step 3: Live smoke test in the local dev server**

Start backend (`uvicorn app.main:app --reload` from `web/backend/`) + frontend (`npm run dev` from `web/frontend/`). With `elevenapi.txt` at the repo root:

1. Open a beatmap with tutorial mode on → confirm the new "ElevenLabs default voice" dropdown sits at the top of the right-sidebar Tutorial card. Pick a voice → reload editor → value persists.
2. Add a VO → switch its engine radio to ElevenLabs → confirm the per-VO voice dropdown appears with `inherit (<picked default name>)` as the first option.
3. Type narration text → click Generate → an OGG appears, plays.
4. Switch the same VO to Chatterbox → click Generate → a new OGG appears (Chatterbox path still works).
5. Save the chart. Reload the editor. The VO's engine + voice survive the round-trip.
6. Inspect the saved chart on disk: VO line carries `engine=elevenlabs voice=<id>` (or omits both for chatterbox+inherit).

- [ ] **Step 4: Push**

```
git push origin main
```

- [ ] **Step 5: Deploy to the droplet**

```
ssh -i ~/.ssh/id_ed25519_beatmap root@beatmap.jamsesh.co \
  'cd /opt/madmom && git pull --ff-only && cd web/backend && pip install -r requirements.txt && cd ../frontend && npm ci --silent && npm run build && systemctl restart beatmap-backend && systemctl is-active beatmap-backend'
```

Expected: `active` printed at the end. Then drop the actual API key on the droplet (one-time):

```
ssh -i ~/.ssh/id_ed25519_beatmap root@beatmap.jamsesh.co \
  'echo "ELEVENLABS_API_KEY=<paste real key>" >> /opt/madmom/web/.env && systemctl restart beatmap-backend'
```

(You will paste the key manually in this shell, since it's not in the local repo's tracked files.)

- [ ] **Step 6: Smoke test on prod**

Open `https://beatmap.jamsesh.co` → into a track → confirm the voice dropdown loads. Open a beatmap → confirm the VO card's ElevenLabs path generates audio.
