"""Beatmap reassignment preserves content and per-stem primary selection."""
import pytest

from app.services import tracks


@pytest.fixture
def track(tmp_path, monkeypatch):
    monkeypatch.setattr(tracks, 'TRACKS_DIR', tmp_path)
    track = tracks.Track(id='move-test', name='Test', created_at=0,
                         stems={s: f'{s}.ogg' for s in ('drums', 'guitar', 'song', 'vocals')},
                         beatmaps=[
                             {'id': 'a', 'stem': 'drums', 'active': True, 'included': False},
                             {'id': 'b', 'stem': 'drums', 'active': False, 'generated_at': 1},
                             {'id': 'c', 'stem': 'guitar', 'active': True},
                         ])
    track.stems_dir.mkdir(parents=True)
    for filename in track.stems.values():
        (track.stems_dir / filename).write_bytes(b'audio')
    chart_dir = track.beatmaps_dir / 'a'
    chart_dir.mkdir(parents=True)
    (chart_dir / 'notes.chart').write_text('unchanged notes')
    track.save()
    return track


@pytest.mark.parametrize('destination', ['guitar', 'song', 'vocals'])
def test_move_preserves_chart_and_repairs_primary(track, destination):
    record = tracks.move_beatmap_record(track.id, 'a', destination)
    assert record['stem'] == destination
    assert record['included'] is False
    assert record['active'] is (destination != 'guitar')
    saved = tracks.get_track(track.id)
    assert next(b for b in saved.beatmaps if b['id'] == 'b')['active']
    assert next(b for b in saved.beatmaps if b['id'] == 'c')['active']
    assert (track.beatmaps_dir / 'a' / 'notes.chart').read_text() == 'unchanged notes'


@pytest.mark.parametrize('destination', ['missing', 'song_ini', 'album_png', '../song'])
def test_invalid_destination_does_not_change_record(track, destination):
    before = track.meta_path.read_bytes()
    with pytest.raises(ValueError):
        tracks.move_beatmap_record(track.id, 'a', destination)
    assert track.meta_path.read_bytes() == before


def test_same_stem_is_noop_and_unknown_record_is_missing(track):
    before = track.meta_path.read_bytes()
    assert tracks.move_beatmap_record(track.id, 'a', 'drums')['active']
    assert tracks.move_beatmap_record(track.id, 'missing', 'song') is None
    assert track.meta_path.read_bytes() == before


def test_missing_audio_is_rejected(track):
    (track.stems_dir / 'song.ogg').unlink()
    with pytest.raises(ValueError, match='missing'):
        tracks.move_beatmap_record(track.id, 'a', 'song')


@pytest.fixture
def client(track):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.routers.auth import require_auth
    app.dependency_overrides[require_auth] = lambda: None
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(require_auth, None)


def test_move_endpoint(client, track):
    url = f'/api/tracks/{track.id}/beatmaps/a/move'
    assert client.post(url, json={'stem': 'song_ini'}).status_code == 400
    response = client.post(url, json={'stem': 'song'})
    assert response.status_code == 200
    assert response.json()['stem'] == 'song'
    assert client.post(url.replace('/a/', '/missing/'), json={'stem': 'song'}).status_code == 404


