"""End-to-end S1: POST a manual grid, GET active, verify pipeline_state."""
from __future__ import annotations

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
    monkeypatch.setattr(settings, 'upload_dir', str(tmp_path / 'uploads'))
    monkeypatch.setattr(
        'app.routers.pipeline._resolve_track_dir',
        lambda track_id: tmp_path / 'uploads' / 'tracks' / track_id,
    )
    from app.main import app
    with TestClient(app) as c:
        yield c


def test_s1_manual_end_to_end(client, tmp_path):
    # Run manual grid engine
    r = client.post('/api/pipeline/grid?track_id=tx', json={
        'engine': 'manual',
        'params': {'bpm': 120.0, 'audio_duration_s': 30.0, 'time_sig_num': 4},
    })
    assert r.status_code == 200
    job_id = r.json()['job_id']

    # Job is async — poll via state endpoint until grid is non-null
    import time
    state = None
    for _ in range(40):
        r = client.get('/api/pipeline/state?track_id=tx')
        if r.json().get('grid'):
            state = r.json()
            break
        time.sleep(0.1)

    assert state is not None, f'grid never appeared in state (job_id={job_id})'
    assert state['grid'] is not None
    assert state['grid']['engine'] == 'manual'

    # GET active grid
    r = client.get('/api/pipeline/grid?track_id=tx')
    assert r.status_code == 200
    grid = r.json()
    assert grid['tempo_segments'][0]['micro_bpm'] == 120000

    # Versions list shows one entry
    r = client.get('/api/pipeline/grid/versions?track_id=tx')
    assert r.status_code == 200
    versions = r.json()
    assert len(versions) == 1
    assert versions[0]['active'] is True
