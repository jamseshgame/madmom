"""Endpoint tests for the cross-chart difficulty clone + difficulty listing."""
from __future__ import annotations

import time
from pathlib import Path

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
    from app.services import tracks as tracks_mod
    from app.services.tracks import Track

    upload_dir = tmp_path / 'uploads'
    tracks_dir = upload_dir / '_tracks'
    tracks_dir.mkdir(parents=True)
    monkeypatch.setattr(settings, 'upload_dir', str(upload_dir))
    monkeypatch.setattr(tracks_mod, 'TRACKS_DIR', tracks_dir)

    t = Track(id='trk1', name='Test', created_at=time.time(),
              stems={'guitar': 'guitar.ogg'}, model='demucs', output_format='ogg')
    t.beatmaps = [
        {'id': 'src', 'stem': 'guitar', 'preset': 'v8', 'active': True, 'generated_at': 1.0},
        {'id': 'dst', 'stem': 'guitar', 'preset': 'v11', 'active': False, 'generated_at': 2.0},
    ]
    t.save()
    for bid, expert, hard in (('src', '  0 = N 0 0\n  192 = N 1 0', None),
                              ('dst', '  0 = N 4 0', '  0 = N 2 0')):
        d = t.beatmaps_dir / bid
        d.mkdir(parents=True)
        parts = [f'[Song]\n{{\n  Resolution = 192\n}}\n', f'[ExpertSingle]\n{{\n{expert}\n}}\n']
        if hard is not None:
            parts.append(f'[HardSingle]\n{{\n{hard}\n}}\n')
        (d / 'notes.chart').write_text(''.join(parts), encoding='utf-8')

    from app.main import app
    with TestClient(app) as c:
        yield c


def test_list_difficulties(client):
    r = client.get('/api/tracks/trk1/beatmaps/src/difficulties')
    assert r.status_code == 200, r.text
    names = [d['name'] for d in r.json()['difficulties']]
    assert names == ['ExpertSingle']
    assert r.json()['difficulties'][0]['note_count'] == 2


def test_clone_difficulty_happy_path(client):
    r = client.post('/api/tracks/trk1/beatmaps/dst/clone-difficulty', json={
        'source_beatmap_id': 'src', 'source_difficulty': 'ExpertSingle',
        'target_difficulty': 'HardSingle',
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body['overwrote'] is True
    assert body['target_difficulty'] == 'HardSingle'


def test_clone_difficulty_unknown_source_404(client):
    r = client.post('/api/tracks/trk1/beatmaps/dst/clone-difficulty', json={
        'source_beatmap_id': 'ghost', 'source_difficulty': 'ExpertSingle',
        'target_difficulty': 'HardSingle',
    })
    assert r.status_code == 404, r.text


def test_clone_difficulty_missing_source_section_422(client):
    r = client.post('/api/tracks/trk1/beatmaps/dst/clone-difficulty', json={
        'source_beatmap_id': 'src', 'source_difficulty': 'MediumSingle',
        'target_difficulty': 'HardSingle',
    })
    assert r.status_code == 422, r.text
