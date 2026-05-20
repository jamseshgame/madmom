"""Integration test for the V2 generate-beatmap endpoint."""
from __future__ import annotations

import json
import time
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
    upload_dir = tmp_path / 'uploads'
    tracks_dir = upload_dir / '_tracks'
    upload_dir.mkdir(parents=True)
    tracks_dir.mkdir(parents=True)
    monkeypatch.setattr(settings, 'upload_dir', str(upload_dir))
    monkeypatch.setattr('app.services.tracks.TRACKS_DIR', tracks_dir)
    monkeypatch.setattr(
        'app.routers.pipeline._resolve_track_dir',
        lambda track_id: tracks_dir / track_id,
    )
    from app.main import app
    with TestClient(app) as c:
        yield c


def _wait(client, job_id, timeout_s=90):
    for _ in range(timeout_s * 10):
        r = client.get(f'/api/jobs/{job_id}')
        if r.json().get('status') in ('done', 'failed'):
            return r.json()
        time.sleep(0.1)
    raise TimeoutError(job_id)


@pytest.fixture
def fake_track(client, tmp_path):
    """Create a Track on disk with a single Bass stem of impulse audio.

    Depends on `client` so the TRACKS_DIR monkeypatch is in effect before
    we instantiate Track (Track.save() writes to TRACKS_DIR / id).

    Note: the V2 pipeline runner expects stems at
    `<track_dir>/stems/<stem>/<file>.ogg` (subfolder layout). The legacy
    Track.stems_dir layout is flat (`<track_dir>/stems/<file>.ogg`); we
    write the same audio under both so the legacy stem_path lookup and the
    pipeline's `_audio_path_for` both resolve.
    """
    from app.services.tracks import Track
    tid = 'tracktest'
    td = tmp_path / 'uploads' / '_tracks' / tid
    (td / 'stems' / 'bass').mkdir(parents=True)
    (td / 'stems' / 'guitar').mkdir(parents=True)

    sr = 22050
    n = sr * 6
    y = np.zeros(n, dtype=np.float32)
    burst = (0.4 * np.sin(2 * np.pi * 110 * np.linspace(0, 0.15, int(sr * 0.15)))).astype(np.float32)
    for s in np.arange(0, 6, 0.5):
        i = int(s * sr)
        y[i:i + burst.shape[0]] += burst
    sf.write(td / 'song.ogg', y, sr)
    # Flat layout for the legacy Track.stems_dir / filename lookup
    sf.write(td / 'stems' / 'bass.ogg', y, sr)
    sf.write(td / 'stems' / 'guitar.ogg', y, sr)
    # Subfolder layout for the pipeline runner's `_audio_path_for`
    sf.write(td / 'stems' / 'bass' / 'bass.ogg', y, sr)
    sf.write(td / 'stems' / 'guitar' / 'guitar.ogg', y, sr)

    t = Track(
        id=tid, name='Test', created_at=time.time(), stems={'bass': 'bass.ogg'},
        model='demucs', output_format='ogg',
        artist='A', album='B', genre='G', year='2026',
    )
    t.save()
    return tid


def test_generate_beatmap_v2_runs_all_stages(client, fake_track):
    tid = fake_track
    form = {
        'stem': 'bass',
        'name': 'Bass Test',
        'artist': 'A',
        'album': 'B',
        'genre': 'G',
        'year': '2026',
        'onsets_engine': 'librosa-onset',
        'onsets_params': json.dumps({}),
        'pitches_engine': 'yin',
        'pitches_params': json.dumps({}),
        'quantized_engine': 'metric-weighted',
        'quantized_params': json.dumps({}),
        'lanes_engine': 'section-sliding',
        'lanes_params': json.dumps({}),
        'playability_engine': 'identity',
        'playability_params': json.dumps({}),
    }
    r = client.post(f'/api/tracks/{tid}/generate-beatmap-v2', data=form)
    assert r.status_code == 200, r.text
    job_id = r.json()['job_id']

    final = _wait(client, job_id)
    assert final.get('status') == 'done', final

    from app.config import settings
    job_dir = Path(settings.upload_dir) / job_id
    subdirs = [p for p in job_dir.iterdir() if p.is_dir()]
    assert len(subdirs) == 1, f'expected one folder, got {subdirs}'
    out = subdirs[0]
    assert (out / 'notes.chart').exists()
    assert (out / 'song.ogg').exists()
    assert (out / 'song.ini').exists()

    ini = (out / 'song.ini').read_text()
    assert 'name = Bass Test' in ini


def test_generate_beatmap_v2_rejects_drums(client, fake_track):
    """Drums stem must be rejected — drums use legacy endpoint."""
    r = client.post(
        f'/api/tracks/{fake_track}/generate-beatmap-v2',
        data={
            'stem': 'drums',
            'name': 'D', 'artist': 'A', 'album': 'B', 'genre': 'G', 'year': '2026',
            'onsets_engine': 'librosa-onset', 'onsets_params': '{}',
            'pitches_engine': 'yin', 'pitches_params': '{}',
            'quantized_engine': 'metric-weighted', 'quantized_params': '{}',
            'lanes_engine': 'section-sliding', 'lanes_params': '{}',
            'playability_engine': 'identity', 'playability_params': '{}',
        },
    )
    assert r.status_code == 400
    assert 'drum' in r.json()['detail'].lower()
