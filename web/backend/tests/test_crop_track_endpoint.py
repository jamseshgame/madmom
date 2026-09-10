"""Router surface for track-level cropping: the per-stem peaks feed the crop
modal draws, and the crop itself."""
from __future__ import annotations

import shutil
import struct
import subprocess

import pytest
from fastapi.testclient import TestClient

ffmpeg_missing = shutil.which('ffmpeg') is None or shutil.which('ffprobe') is None
pytestmark = pytest.mark.skipif(ffmpeg_missing, reason='ffmpeg/ffprobe not installed')


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

    upload_dir = tmp_path / 'uploads'
    tracks_dir = upload_dir / '_tracks'
    tracks_dir.mkdir(parents=True)
    monkeypatch.setattr(settings, 'upload_dir', str(upload_dir))
    monkeypatch.setattr(tracks_mod, 'TRACKS_DIR', tracks_dir)

    from app.main import app
    return TestClient(app)


@pytest.fixture
def track(client):
    """A two-stem, 4 s track on disk."""
    from app.services import tracks as tracks_mod

    t = tracks_mod.Track(
        id='croptrk', name='Nausea', created_at=0.0, output_format='ogg',
        stems={'vocals': 'vocals.ogg', 'drums': 'drums.ogg'},
    )
    t.stems_dir.mkdir(parents=True)
    for name in ('vocals.ogg', 'drums.ogg'):
        subprocess.run(
            ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:r=44100',
             '-t', '4', '-c:a', 'libvorbis', str(t.stems_dir / name)],
            capture_output=True, check=True,
        )
    t.save()
    return t


def _duration(path):
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
         '-of', 'default=nw=1:nk=1', str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


class TestStemPeaksEndpoint:
    def test_returns_one_float32_per_bucket_covering_the_stem(self, client, track):
        r = client.get(f'/api/tracks/{track.id}/stems/vocals/peaks?bucket_ms=20')

        assert r.status_code == 200
        peaks = struct.unpack(f'<{len(r.content) // 4}f', r.content)
        # 4 s at 20 ms per bucket ≈ 200 buckets; the modal derives the
        # waveform's duration from this length, so it has to line up.
        assert 190 <= len(peaks) <= 210
        assert max(peaks) > 0.1

    def test_caches_the_blob_next_to_the_stem(self, client, track):
        client.get(f'/api/tracks/{track.id}/stems/vocals/peaks')

        assert (track.stems_dir / 'vocals.peaks.f32').exists()

    def test_unknown_stem_is_404(self, client, track):
        assert client.get(f'/api/tracks/{track.id}/stems/tuba/peaks').status_code == 404


class TestCropStemsEndpoint:
    def test_crops_every_stem_and_reports_the_new_duration(self, client, track):
        r = client.post(f'/api/tracks/{track.id}/crop-stems',
                        json={'start_sec': 1.0, 'end_sec': 3.0})

        assert r.status_code == 200, r.text
        assert 1900 < r.json()['duration_ms'] < 2100
        for name in ('vocals.ogg', 'drums.ogg'):
            assert 1.9 < _duration(track.stems_dir / name) < 2.1

    def test_lists_beatmaps_left_out_of_sync(self, client, track):
        track.beatmaps = [{'id': 'bm1', 'stem': 'vocals'}]
        track.save()

        r = client.post(f'/api/tracks/{track.id}/crop-stems',
                        json={'start_sec': 1.0, 'end_sec': 3.0})

        assert r.json()['beatmaps_untouched'] == ['bm1']

    def test_an_impossible_range_is_400_not_500(self, client, track):
        r = client.post(f'/api/tracks/{track.id}/crop-stems',
                        json={'start_sec': 3.0, 'end_sec': 1.0})

        assert r.status_code == 400

    def test_an_end_past_the_audio_is_400(self, client, track):
        r = client.post(f'/api/tracks/{track.id}/crop-stems',
                        json={'start_sec': 0.0, 'end_sec': 90.0})

        assert r.status_code == 400

    def test_unknown_track_is_404(self, client):
        r = client.post('/api/tracks/nope/crop-stems',
                        json={'start_sec': 0.0, 'end_sec': 1.0})

        assert r.status_code == 404
