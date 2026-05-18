"""Smoke tests for the pipeline router — verify route shape exists and
404s where expected before any engines are registered."""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.routers.auth import require_auth
from app.main import app


@pytest.fixture(autouse=True)
def _bypass_auth():
    """Override the require_auth dependency so TestClient calls succeed without a cookie."""
    app.dependency_overrides[require_auth] = lambda: None
    yield
    app.dependency_overrides.pop(require_auth, None)


@pytest.fixture
def client(tmp_path, monkeypatch):
    # Point upload_dir + a fake tracks store at a tmp dir so the router
    # operates on isolated state per test.
    from app.config import settings
    monkeypatch.setattr(settings, 'upload_dir', str(tmp_path / 'uploads'))
    from app.main import app
    with TestClient(app) as c:
        yield c


def test_engines_catalog_returns_all_stages_even_when_empty(client):
    r = client.get('/api/pipeline/engines')
    assert r.status_code == 200
    body = r.json()
    # Catalog keys are the 9 stage IDs from Stage enum
    for stage in ['grid', 'onsets', 'pitches', 'quantized',
                  'lanes_expert', 'lanes_filtered',
                  'lanes_hard', 'lanes_medium', 'lanes_easy']:
        assert stage in body


def test_grid_get_404_when_no_active(client, tmp_path, monkeypatch):
    # Patch the track-resolver to return a tmp dir with no grid.json
    monkeypatch.setattr(
        'app.routers.pipeline._resolve_track_dir',
        lambda track_id: tmp_path / 'no-such-track',
    )
    r = client.get('/api/pipeline/grid?track_id=t1')
    assert r.status_code == 404


def test_state_returns_empty_for_unknown_track(client, tmp_path, monkeypatch):
    monkeypatch.setattr(
        'app.routers.pipeline._resolve_track_dir',
        lambda track_id: tmp_path / 'unknown',
    )
    r = client.get('/api/pipeline/state?track_id=t1')
    assert r.status_code == 200
    body = r.json()
    assert body['schema_version'] == 1
    assert body['grid'] is None
    assert body['stems'] == {}
