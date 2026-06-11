"""CRUD tests for the sequence-library router.

Persists to <upload_dir>/sequences.json; upload_dir is pointed at tmp_path
and auth is bypassed via the require_auth dependency-override pattern used
by the other web_backend tests.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


NOTES = [
    {'tick': 768, 'lane': 1, 'sustain': 0},
    {'tick': 960, 'lane': 3, 'sustain': 96, 'slideId': 2},
]


@pytest.fixture
def client(tmp_path, monkeypatch):
    from web.backend.app.config import settings
    monkeypatch.setattr(settings, 'upload_dir', str(tmp_path))
    from web.backend.app.main import app
    from web.backend.app.routers.auth import require_auth
    app.dependency_overrides[require_auth] = lambda: None
    yield TestClient(app)
    app.dependency_overrides.clear()


def _create(client, name='Riff A'):
    resp = client.post('/api/sequences', json={'name': name, 'resolution': 192, 'notes': NOTES})
    assert resp.status_code == 200
    return resp.json()


def test_create_normalizes_ticks_and_lists(client):
    rec = _create(client)
    assert rec['name'] == 'Riff A'
    assert rec['resolution'] == 192
    # Earliest note shifted to tick 0; relative spacing preserved.
    assert [n['tick'] for n in rec['notes']] == [0, 192]
    assert rec['notes'][1]['slideId'] == 2
    listed = client.get('/api/sequences').json()
    assert [s['id'] for s in listed] == [rec['id']]


def test_create_rejects_blank_name_and_empty_notes(client):
    assert client.post('/api/sequences', json={'name': '  ', 'resolution': 192, 'notes': NOTES}).status_code == 400
    assert client.post('/api/sequences', json={'name': 'x', 'resolution': 192, 'notes': []}).status_code == 422


def test_create_rejects_bad_lane(client):
    bad = [{'tick': 0, 'lane': 9, 'sustain': 0}]
    assert client.post('/api/sequences', json={'name': 'x', 'resolution': 192, 'notes': bad}).status_code == 422


def test_rename(client):
    rec = _create(client)
    resp = client.patch(f"/api/sequences/{rec['id']}", json={'name': 'Riff B'})
    assert resp.status_code == 200
    assert resp.json()['name'] == 'Riff B'
    assert client.get('/api/sequences').json()[0]['name'] == 'Riff B'


def test_rename_blank_400_and_missing_404(client):
    rec = _create(client)
    assert client.patch(f"/api/sequences/{rec['id']}", json={'name': ' '}).status_code == 400
    assert client.patch('/api/sequences/nope', json={'name': 'x'}).status_code == 404


def test_clone_copies_notes_with_new_identity(client):
    rec = _create(client)
    resp = client.post(f"/api/sequences/{rec['id']}/clone")
    assert resp.status_code == 200
    copy = resp.json()
    assert copy['id'] != rec['id']
    assert copy['name'] == 'Riff A (copy)'
    assert copy['notes'] == rec['notes']
    assert len(client.get('/api/sequences').json()) == 2


def test_clone_missing_404(client):
    assert client.post('/api/sequences/nope/clone').status_code == 404


def test_delete(client):
    rec = _create(client)
    assert client.delete(f"/api/sequences/{rec['id']}").status_code == 200
    assert client.get('/api/sequences').json() == []
    assert client.delete(f"/api/sequences/{rec['id']}").status_code == 404


def test_corrupt_file_lists_empty(client, tmp_path):
    (tmp_path / 'sequences.json').write_text('not json', encoding='utf-8')
    assert client.get('/api/sequences').json() == []


def test_create_sorts_unsorted_input_and_drops_none_fields(client):
    unsorted = [
        {'tick': 960, 'lane': 3, 'sustain': 0},
        {'tick': 768, 'lane': 1, 'sustain': 0},
    ]
    resp = client.post('/api/sequences', json={'name': 'x', 'resolution': 192, 'notes': unsorted})
    assert resp.status_code == 200
    rec = resp.json()
    assert [n['tick'] for n in rec['notes']] == [0, 192]
    assert [n['lane'] for n in rec['notes']] == [1, 3]
    # Optional fields that were absent stay absent (None values dropped).
    assert 'slideId' not in rec['notes'][0]
    assert 'type' not in rec['notes'][0]


def test_create_rejects_oversized_payloads(client):
    too_many = [{'tick': i, 'lane': 0, 'sustain': 0} for i in range(5001)]
    assert client.post('/api/sequences', json={'name': 'x', 'resolution': 192, 'notes': too_many}).status_code == 422
    assert client.post('/api/sequences', json={'name': 'y' * 201, 'resolution': 192, 'notes': [{'tick': 0, 'lane': 0, 'sustain': 0}]}).status_code == 422
