"""Phase 3 end-to-end: stem → 4-difficulty chart via all stages."""
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


def _wait(client, job_id, timeout_s=30):
    import time
    for _ in range(timeout_s * 10):
        r = client.get(f'/api/jobs/{job_id}')
        if r.json().get('status') in ('done', 'failed'):
            return r.json()
        time.sleep(0.1)
    raise TimeoutError(job_id)


@pytest.fixture
def fake_song(tmp_path):
    td = tmp_path / 'uploads' / 'tracks' / 'ty'
    (td / 'stems' / 'guitar').mkdir(parents=True)
    sr = 22050
    n = sr * 8
    y = np.zeros(n, dtype=np.float32)
    burst_len = int(sr * 0.15)
    t_burst = np.linspace(0, 0.15, burst_len, endpoint=False)
    for s in np.arange(0, 8, 0.125):
        burst = (0.4 * np.sin(2 * np.pi * (440 + 30 * int(s % 4)) * t_burst)).astype(np.float32)
        i = int(s * sr)
        if i + burst_len <= n:
            y[i:i + burst_len] += burst
    sf.write(td / 'song.ogg', y, sr)
    sf.write(td / 'stems' / 'guitar' / 'guitar.ogg', y, sr)
    return 'ty'


def test_phase3_full_pipeline(client, fake_song):
    tid = fake_song
    # S1
    r = client.post(f'/api/pipeline/grid?track_id={tid}', json={
        'engine': 'manual', 'params': {'bpm': 120, 'audio_duration_s': 8, 'time_sig_num': 4},
    })
    _wait(client, r.json()['job_id'])
    # S2..S5 with non-ML engines
    for stage, engine in (('onsets', 'librosa-onset'),
                          ('pitches', 'yin'),
                          ('quantized', 'metric-weighted'),
                          ('lanes_expert', 'section-sliding')):
        r = client.post(f'/api/pipeline/{stage}?track_id={tid}&stem=guitar',
                        json={'engine': engine, 'params': {}})
        _wait(client, r.json()['job_id'])
    # S6 identity
    r = client.post(f'/api/pipeline/lanes_filtered?track_id={tid}&stem=guitar',
                    json={'engine': 'identity', 'params': {}})
    _wait(client, r.json()['job_id'])
    # S7 metric-weight — POST to lanes_hard, it writes all three
    r = client.post(f'/api/pipeline/lanes_hard?track_id={tid}&stem=guitar',
                    json={'engine': 'metric-weight', 'params': {}})
    _wait(client, r.json()['job_id'])
    # S8 build chart
    r = client.post(f'/api/pipeline/build-chart?track_id={tid}&stem=guitar')
    assert r.status_code == 200, r.text
    text = Path(r.json()['chart_path']).read_text()
    for section in ('[ExpertSingle]', '[HardSingle]', '[MediumSingle]', '[EasySingle]'):
        assert section in text
    # Easy must have fewer events than Expert
    expert_count = text.split('[ExpertSingle]')[1].split('[')[0].count(' = N ')
    easy_count = text.split('[EasySingle]')[1].split('[')[0].count(' = N ')
    assert easy_count <= expert_count, f'easy ({easy_count}) should be <= expert ({expert_count})'
