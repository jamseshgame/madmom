from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _bypass_auth():
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


def test_list_returns_seed_with_default_tracking(client):
    r = client.get('/api/outreach/reddit')
    assert r.status_code == 200, r.text
    body = r.json()
    assert 'as_of' in body and isinstance(body['rows'], list)
    assert body['rows'], 'seed should not be empty'
    row = body['rows'][0]
    # Reference + default tracking fields present on every row.
    for key in ('name', 'category', 'subscribers', 'self_promo_verdict', 'status', 'last_posted', 'notes'):
        assert key in row
    assert row['status'] == 'Not posted'


def test_patch_persists_tracking(client):
    seed_name = client.get('/api/outreach/reddit').json()['rows'][0]['name']
    r = client.patch(
        f'/api/outreach/reddit/{seed_name}',
        json={'status': 'Posted', 'last_posted': '2026-07-08', 'notes': 'shared trailer'},
    )
    assert r.status_code == 200, r.text

    # Round-trip: a fresh GET reflects the saved tracking.
    row = next(x for x in client.get('/api/outreach/reddit').json()['rows'] if x['name'] == seed_name)
    assert row['status'] == 'Posted'
    assert row['last_posted'] == '2026-07-08'
    assert row['notes'] == 'shared trailer'


def test_patch_rejects_bad_status(client):
    seed_name = client.get('/api/outreach/reddit').json()['rows'][0]['name']
    r = client.patch(f'/api/outreach/reddit/{seed_name}', json={'status': 'Nope'})
    assert r.status_code == 400


def test_patch_unknown_subreddit_404s(client):
    r = client.patch('/api/outreach/reddit/r%2Fdoes-not-exist-xyz', json={'notes': 'x'})
    assert r.status_code == 404


def test_add_and_delete_custom(client):
    r = client.post('/api/outreach/reddit', json={'name': 'mycoolsub', 'category': 'Indie/Promo'})
    assert r.status_code == 200, r.text
    assert r.json()['name'] == 'r/mycoolsub'
    assert r.json()['custom'] is True

    names = [x['name'] for x in client.get('/api/outreach/reddit').json()['rows']]
    assert 'r/mycoolsub' in names

    d = client.delete('/api/outreach/reddit/r%2Fmycoolsub')
    assert d.status_code == 200, d.text
    names = [x['name'] for x in client.get('/api/outreach/reddit').json()['rows']]
    assert 'r/mycoolsub' not in names


def test_cannot_delete_seed_row(client):
    seed_name = client.get('/api/outreach/reddit').json()['rows'][0]['name']
    r = client.delete(f'/api/outreach/reddit/{seed_name.replace("/", "%2F")}')
    assert r.status_code == 409


def test_duplicate_custom_conflicts(client):
    client.post('/api/outreach/reddit', json={'name': 'dupsub'})
    r = client.post('/api/outreach/reddit', json={'name': 'dupsub'})
    assert r.status_code == 409
