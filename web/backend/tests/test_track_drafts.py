"""Draft tracks — resumable imports staged before separation runs.

Covers the service helpers (create_draft_track / promote_draft) and the three
router endpoints (POST /draft, GET /{id}/source, POST /{id}/separate), with the
separation itself stubbed so the tests stay fast and offline.
"""
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

    upload_dir = tmp_path / 'uploads'
    tracks_dir = upload_dir / '_tracks'
    tracks_dir.mkdir(parents=True)
    monkeypatch.setattr(settings, 'upload_dir', str(upload_dir))
    monkeypatch.setattr(tracks_mod, 'TRACKS_DIR', tracks_dir)

    from app.main import app
    return TestClient(app)


class TestDraftService:
    def test_create_draft_persists_audio_and_marks_draft(self, client):
        from app.services.tracks import create_draft_track, get_track

        t = create_draft_track(
            name='Sabotage', audio_bytes=b'ID3fakeaudio', audio_filename='Sabotage.mp3',
            artist='Beastie Boys', youtube_source_url='https://youtu.be/z5rRZdiu1UE',
        )
        assert t.is_draft
        assert t.status == 'draft'
        assert t.stems == {}
        assert t.source_path is not None
        assert t.source_path.read_bytes() == b'ID3fakeaudio'
        assert t.source_audio == 'source.mp3'
        assert t.youtube_source_url == 'https://youtu.be/z5rRZdiu1UE'

        # Survives a round-trip through disk.
        reloaded = get_track(t.id)
        assert reloaded.is_draft
        assert reloaded.artist == 'Beastie Boys'

    def test_promote_flips_to_ready(self, client):
        from app.services.tracks import create_draft_track, get_track, promote_draft

        t = create_draft_track(name='X', audio_bytes=b'aa', audio_filename='x.wav')
        promote_draft(t, stems={'vocals': 'vocals.ogg'}, model='hybrid', output_format='ogg')

        reloaded = get_track(t.id)
        assert reloaded.status == 'ready'
        assert not reloaded.is_draft
        assert reloaded.stems == {'vocals': 'vocals.ogg'}
        assert reloaded.model == 'hybrid'
        # The stored master is kept so the track can be re-split later.
        assert reloaded.source_path is not None

    def test_missing_status_defaults_to_ready(self, client):
        # track.json files written before drafts existed have no status field.
        from app.services.tracks import Track, get_track

        t = Track(id='legacy', name='Old', created_at=time.time(), stems={'vocals': 'v.ogg'})
        t.save()
        assert get_track('legacy').status == 'ready'
        assert not get_track('legacy').is_draft


class TestDraftEndpoints:
    def test_post_draft_lists_as_in_progress(self, client):
        r = client.post(
            '/api/tracks/draft',
            files={'file': ('Song.mp3', b'ID3audio', 'audio/mpeg')},
            data={'name': 'Song', 'artist': 'Artist'},
        )
        assert r.status_code == 200
        body = r.json()
        assert body['status'] == 'draft'
        assert body['stem_count'] == 0

        listing = client.get('/api/tracks').json()
        assert any(t['id'] == body['id'] and t['status'] == 'draft' for t in listing)

    def test_post_draft_rejects_unsupported_format(self, client):
        r = client.post(
            '/api/tracks/draft',
            files={'file': ('Song.txt', b'x', 'text/plain')},
            data={'name': 'Song'},
        )
        assert r.status_code == 400

    def test_post_draft_rejects_empty_file(self, client):
        r = client.post(
            '/api/tracks/draft',
            files={'file': ('Song.mp3', b'', 'audio/mpeg')},
        )
        assert r.status_code == 400

    def test_name_falls_back_to_filename(self, client):
        r = client.post(
            '/api/tracks/draft',
            files={'file': ('Beastie Boys - Sabotage.mp3', b'ID3x', 'audio/mpeg')},
        )
        assert r.json()['name'] == 'Beastie Boys - Sabotage'

    def test_get_source_streams_master(self, client):
        created = client.post(
            '/api/tracks/draft',
            files={'file': ('Song.mp3', b'ID3-master-bytes', 'audio/mpeg')},
        ).json()
        r = client.get(f'/api/tracks/{created["id"]}/source')
        assert r.status_code == 200
        assert r.content == b'ID3-master-bytes'

    def test_get_source_404_when_absent(self, client):
        from app.services.tracks import Track

        t = Track(id='nostems', name='N', created_at=time.time(), stems={})
        t.save()
        assert client.get('/api/tracks/nostems/source').status_code == 404

    def test_separate_promotes_the_draft(self, client, monkeypatch):
        created = client.post(
            '/api/tracks/draft',
            files={'file': ('Song.wav', b'RIFF-master', 'audio/wav')},
            data={'name': 'Song'},
        ).json()

        captured = {}

        async def fake_separate(**kwargs):
            captured.update(kwargs)
            # Emit a stem file where the real engine would, so promote sees it.
            from pathlib import Path
            out = Path(kwargs['output_dir'])
            out.mkdir(parents=True, exist_ok=True)
            (out / 'vocals.ogg').write_bytes(b'ogg')
            return {'stems': {'vocals': 'vocals.ogg'}, 'track_name': 'Song',
                    'engine': kwargs['engine'], 'model': 'hybrid',
                    'output_format': 'ogg', 'game_ready': True}

        monkeypatch.setattr('app.routers.tracks.separate_with_engine', fake_separate)

        r = client.post(
            f'/api/tracks/{created["id"]}/separate',
            data={'engine': 'hybrid', 'params': '{"shifts": 2}'},
        )
        assert r.status_code == 200
        assert r.json()['track_id'] == created['id']

        # The background task runs on the event loop; wait for it to finish.
        for _ in range(100):
            if captured:
                break
            time.sleep(0.02)
        assert captured['engine'] == 'hybrid'
        assert captured['game_ready'] is True

        for _ in range(100):
            t = client.get(f'/api/tracks/{created["id"]}').json()
            if t['status'] == 'ready':
                break
            time.sleep(0.02)
        assert t['status'] == 'ready'
        assert t['stems'].get('vocals') == 'vocals.ogg'

    def test_separate_rejects_track_without_source(self, client):
        from app.services.tracks import Track

        t = Track(id='nosrc', name='N', created_at=time.time(), stems={'vocals': 'v.ogg'})
        t.save()
        r = client.post('/api/tracks/nosrc/separate', data={'engine': 'hybrid'})
        assert r.status_code == 400
        assert 'no stored master' in r.json()['detail'].lower()

    def test_separate_rejects_unknown_engine(self, client):
        created = client.post(
            '/api/tracks/draft',
            files={'file': ('Song.wav', b'RIFF', 'audio/wav')},
        ).json()
        r = client.post(f'/api/tracks/{created["id"]}/separate', data={'engine': 'spleeter'})
        assert r.status_code == 400

    def test_separate_404_for_missing_track(self, client):
        r = client.post('/api/tracks/nope/separate', data={'engine': 'hybrid'})
        assert r.status_code == 404
