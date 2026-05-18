"""Phase-0 smoke: an empty track exposes empty engine catalog + empty state."""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _bypass_auth():
    """Override the require_auth dependency so TestClient calls succeed without a cookie."""
    from app.main import app
    from app.routers.auth import require_auth
    app.dependency_overrides[require_auth] = lambda: None
    yield
    app.dependency_overrides.pop(require_auth, None)


@pytest.fixture
def client(tmp_path, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, 'upload_dir', str(tmp_path / 'uploads'))
    from app.main import app
    with TestClient(app) as c:
        yield c


def test_phase0_empty_track(client, tmp_path, monkeypatch):
    # Point _resolve_track_dir at a tmp directory we haven't populated
    monkeypatch.setattr(
        'app.routers.pipeline._resolve_track_dir',
        lambda track_id: tmp_path / 'tracks' / track_id,
    )

    # Engines catalog: every stage key present. Stage engine lists fill in as
    # later tasks register engines — assert presence of known-registered ones.
    r = client.get('/api/pipeline/engines')
    assert r.status_code == 200
    cat = r.json()
    for stage in ['grid', 'onsets', 'pitches', 'quantized',
                  'lanes_expert', 'lanes_filtered',
                  'lanes_hard', 'lanes_medium', 'lanes_easy']:
        assert stage in cat
    assert any(e['engine_id'] == 'manual' for e in cat['grid'])

    # Empty pipeline state for an unknown track
    r = client.get('/api/pipeline/state?track_id=newtrack')
    assert r.status_code == 200
    state = r.json()
    assert state['schema_version'] == 1
    assert state['grid'] is None
    assert state['stems'] == {}

    # Stems list: 404-tolerant empty list
    r = client.get('/api/pipeline/stems?track_id=newtrack')
    assert r.status_code == 200
    assert r.json() == []

    # POST to grid without an engine: 400
    r = client.post('/api/pipeline/grid?track_id=newtrack', json={})
    assert r.status_code == 400

    # POST to grid with an unknown engine: 404
    r = client.post('/api/pipeline/grid?track_id=newtrack', json={'engine': 'nope'})
    assert r.status_code == 404
