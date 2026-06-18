from __future__ import annotations

import time

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

    chart = (
        '[Song]\n{\n  Name = "T"\n  Resolution = 192\n}\n'
        '[SyncTrack]\n{\n  0 = B 120000\n}\n'
        '[ExpertSingle]\n{\n  0 = N 0 0\n  192 = N 1 0\n}\n'
    )
    t = Track(id='trk1', name='Song One', created_at=time.time(), stems={'guitar': 'g.ogg'})
    t.beatmaps = [{'id': 'bm1', 'stem': 'guitar', 'included': True, 'generated_at': 1.0}]
    t.save()
    d = t.beatmaps_dir / 'bm1'
    d.mkdir(parents=True)
    (d / 'notes.chart').write_text(chart, encoding='utf-8')

    from app.main import app
    with TestClient(app) as c:
        yield c


def test_compare_returns_rows(client):
    r = client.post('/api/calibration/compare', json={'track_ids': ['trk1']})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body['rows']) == 1
    assert body['rows'][0]['section'] == 'ExpertSingle'
    assert 'summary' in body and 'skipped' in body


def test_compare_empty_track_ids(client):
    r = client.post('/api/calibration/compare', json={'track_ids': []})
    assert r.status_code == 200, r.text
    assert r.json() == {'rows': [], 'summary': {}, 'skipped': []}
