"""End-to-end tests for the feedback router.

Auth is exercised by swapping the require_auth / require_admin dependency
overrides per test — the same pattern test_generation_presets.py uses to
isolate from cookie-based session handling. Storage paths are redirected
into a tmp dir."""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.main import app
from app.routers.auth import require_admin, require_auth
from app.services import tracks as tracks_service


ALICE = {'username': 'alice', 'role': 'user'}
BOB = {'username': 'bob', 'role': 'user'}
ROOT = {'username': 'root', 'role': 'admin'}


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    from app import config
    monkeypatch.setattr(config.settings, 'upload_dir', str(tmp_path))
    # The tracks service caches TRACKS_DIR at import time; redirect it too so
    # create_track/get_track/list_tracks all land inside tmp_path.
    monkeypatch.setattr(tracks_service, 'TRACKS_DIR', tmp_path / 'tracks')
    return TestClient(app)


@pytest.fixture
def as_user(client):
    """Returns a setter so tests can switch which user FastAPI sees per call.
    Default is Alice; tests call `as_user(BOB)` / `as_user(ROOT)` to swap."""
    def _set(user: dict | None):
        if user is None:
            app.dependency_overrides.pop(require_auth, None)
            app.dependency_overrides.pop(require_admin, None)
            return
        app.dependency_overrides[require_auth] = lambda: user
        if user['role'] == 'admin':
            app.dependency_overrides[require_admin] = lambda: user
        else:
            def _deny():
                raise HTTPException(status_code=403, detail='Admin only')
            app.dependency_overrides[require_admin] = _deny
    _set(ALICE)
    yield _set
    _set(None)


@pytest.fixture
def seeded_beatmap(client):
    """Create a real track folder + beatmap so the feedback path resolver finds it."""
    track = tracks_service.create_track(
        name='Test Song',
        stems={'guitar': 'guitar.mp3'},
        source_stems_dir=Path('.'),  # no actual stem file copy required for these tests
        model='htdemucs',
        output_format='mp3',
    )
    bm_dir = track.beatmaps_dir / 'bm-1'
    bm_dir.mkdir(parents=True, exist_ok=True)
    tracks_service.add_beatmap_record(
        track.id, 'bm-1', 'guitar',
        folder_name='Test Song',
        song_name='Test Song',
        source_dir=bm_dir,
        model='madmom',
        preset='v1',
    )
    return track.id, 'bm-1'


def test_anon_get_returns_401(client, as_user, seeded_beatmap):
    as_user(None)  # remove the require_auth override → real dependency raises 401
    track_id, bm_id = seeded_beatmap
    r = client.get(f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}')
    assert r.status_code == 401


def test_post_appends_a_note(client, as_user, seeded_beatmap):
    track_id, bm_id = seeded_beatmap
    r = client.post(
        f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}',
        json={'rating': 3, 'tags': ['too-crampy'], 'text': 'Chord shapes feel off'},
    )
    assert r.status_code == 200, r.text
    note = r.json()
    assert note['author'] == 'alice'
    assert note['rating'] == 3
    assert note['tags'] == ['too-crampy']
    assert note['id'].startswith('fb_')

    r2 = client.get(f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}')
    assert len(r2.json()) == 1


def test_put_only_allowed_for_author(client, as_user, seeded_beatmap):
    track_id, bm_id = seeded_beatmap
    r = client.post(f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}',
                    json={'rating': 3, 'tags': [], 'text': 'A'})
    note_id = r.json()['id']

    as_user(BOB)
    r2 = client.put(f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}/{note_id}',
                    json={'text': 'edited'})
    assert r2.status_code == 403

    as_user(ALICE)
    r3 = client.put(f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}/{note_id}',
                    json={'text': 'edited'})
    assert r3.status_code == 200
    assert r3.json()['text'] == 'edited'


def test_admin_can_delete_anyone(client, as_user, seeded_beatmap):
    track_id, bm_id = seeded_beatmap
    r = client.post(f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}',
                    json={'rating': 5, 'tags': ['feels-great'], 'text': ''})
    note_id = r.json()['id']

    as_user(ROOT)
    r2 = client.delete(f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}/{note_id}')
    assert r2.status_code == 200

    r3 = client.get(f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}')
    assert r3.json() == []


def test_schema_errors_return_422(client, as_user, seeded_beatmap):
    track_id, bm_id = seeded_beatmap
    cases = [
        {'rating': 0, 'tags': ['feels-great'], 'text': ''},
        {'rating': 6, 'tags': ['feels-great'], 'text': ''},
        {'rating': 3, 'tags': ['totally-made-up'], 'text': ''},
        {'rating': 3, 'tags': [], 'text': ''},  # both empty → 422
    ]
    for body in cases:
        r = client.post(f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}', json=body)
        assert r.status_code == 422, body


def test_tags_endpoint_returns_vocabulary(client, as_user):
    r = client.get('/api/feedback/tags')
    assert r.status_code == 200
    payload = r.json()
    assert 'Density' in payload
    assert 'feels-great' in payload['Overall']


def test_concurrent_appends_do_not_interleave(client, as_user, seeded_beatmap):
    """Spawn 20 simultaneous POSTs and confirm all 20 notes parse cleanly."""
    import concurrent.futures
    track_id, bm_id = seeded_beatmap

    def post_one(i):
        return client.post(
            f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}',
            json={'rating': 3, 'tags': [], 'text': f'note {i}'},
        )

    with concurrent.futures.ThreadPoolExecutor(max_workers=20) as ex:
        results = list(ex.map(post_one, range(20)))
    assert all(r.status_code == 200 for r in results)

    notes = client.get(f'/api/feedback/tracks/{track_id}/beatmaps/{bm_id}').json()
    assert len(notes) == 20  # nothing lost or corrupted
