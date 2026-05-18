"""Phase 2 end-to-end: stem in → notes.chart out via pipeline stages."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
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


@pytest.fixture
def fake_song(tmp_path):
    td = tmp_path / 'uploads' / 'tracks' / 'tx'
    (td / 'stems' / 'guitar').mkdir(parents=True)

    sr = 22050
    n = sr * 4
    y = np.zeros(n, dtype=np.float32)
    t_burst = np.linspace(0, 0.2, int(sr * 0.2), endpoint=False)
    burst = (0.5 * np.sin(2 * np.pi * 440 * t_burst)).astype(np.float32)
    for s in (0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5):
        i = int(s * sr)
        y[i:i + len(burst)] += burst
    sf.write(td / 'song.ogg', y, sr)
    sf.write(td / 'stems' / 'guitar' / 'guitar.ogg', y, sr)
    return 'tx'


def _wait_for_job_done(client, job_id, timeout_s=30):
    import time
    for _ in range(int(timeout_s * 10)):
        r = client.get(f'/api/jobs/{job_id}')
        if r.status_code == 200 and r.json().get('status') in ('done', 'failed'):
            return r.json()
        time.sleep(0.1)
    raise TimeoutError(f'job {job_id} did not finish in {timeout_s}s')


def test_phase2_end_to_end_manual_grid_libonsets_yin(client, fake_song):
    track_id = fake_song
    # S1: manual grid
    r = client.post(f'/api/pipeline/grid?track_id={track_id}', json={
        'engine': 'manual',
        'params': {'bpm': 120.0, 'audio_duration_s': 4.0, 'time_sig_num': 4},
    })
    _wait_for_job_done(client, r.json()['job_id'])

    # S2: librosa onset
    r = client.post(f'/api/pipeline/onsets?track_id={track_id}&stem=guitar', json={
        'engine': 'librosa-onset', 'params': {},
    })
    _wait_for_job_done(client, r.json()['job_id'])

    # S3: yin (librosa, no ML dep)
    r = client.post(f'/api/pipeline/pitches?track_id={track_id}&stem=guitar', json={
        'engine': 'yin', 'params': {},
    })
    _wait_for_job_done(client, r.json()['job_id'])

    # S4: nearest-grid
    r = client.post(f'/api/pipeline/quantized?track_id={track_id}&stem=guitar', json={
        'engine': 'nearest-grid', 'params': {},
    })
    _wait_for_job_done(client, r.json()['job_id'])

    # S5: section-sliding
    r = client.post(f'/api/pipeline/lanes_expert?track_id={track_id}&stem=guitar', json={
        'engine': 'section-sliding', 'params': {},
    })
    _wait_for_job_done(client, r.json()['job_id'])

    # S8: build chart
    r = client.post(f'/api/pipeline/build-chart?track_id={track_id}&stem=guitar')
    assert r.status_code == 200, r.text
    chart_path = Path(r.json()['chart_path'])
    text = chart_path.read_text()
    assert '[Song]' in text
    assert '[SyncTrack]' in text
    assert '[ExpertSingle]' in text
    # Expect at least one note line
    assert ' = N ' in text
