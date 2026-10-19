"""Test the cross-track / cross-beatmap aggregation that the preset
proposer consumes."""
from __future__ import annotations

from pathlib import Path

import pytest

from app.services import feedback as feedback_service
from app.services import tracks as tracks_service


@pytest.fixture(autouse=True)
def _tmp_storage(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from app import config
    monkeypatch.setattr(config.settings, 'upload_dir', str(tmp_path))
    monkeypatch.setattr(tracks_service, 'TRACKS_DIR', tmp_path / 'tracks')


def _seed_beatmap(track, beatmap_id: str, *, stem: str, preset: str) -> None:
    bm_dir = track.beatmaps_dir / beatmap_id
    bm_dir.mkdir(parents=True, exist_ok=True)
    tracks_service.add_beatmap_record(
        track.id, beatmap_id, stem,
        folder_name='Test', song_name='Test',
        source_dir=bm_dir, model='madmom', preset=preset,
    )


def _new_track(name: str):
    return tracks_service.create_track(
        name=name, stems={'guitar': 'g.mp3'}, source_stems_dir=Path('.'),
        model='htdemucs', output_format='mp3',
    )


def test_aggregate_filters_by_stems_field(monkeypatch):
    # Stub the preset registry so the test doesn't depend on shipped built-ins.
    from app.routers import generation_presets as gp
    monkeypatch.setattr(gp, 'BUILTIN_PRESETS', [
        {'name': 'v1', 'description': '', 'builtin': True, 'generation': {}},
        {'name': 'drums-v1', 'description': '', 'builtin': True,
         'stems': ['drums'], 'generation': {}},
    ])
    monkeypatch.setattr(gp, '_load_user_presets', lambda: [])

    t1 = _new_track('Song A')
    _seed_beatmap(t1, 'bm-1', stem='guitar', preset='v1')          # universal preset
    _seed_beatmap(t1, 'bm-2', stem='drums',  preset='drums-v1')    # drums-only preset

    feedback_service.add_note(t1.id, 'bm-1', author='alice',
                              rating=3, tags=['too-crampy'], text='guitar feels off')
    feedback_service.add_note(t1.id, 'bm-2', author='alice',
                              rating=2, tags=['too-many-chords'], text='drums too busy')

    drums = feedback_service.aggregate_for_stem('drums')
    # Both beatmaps applied to drums: v1 is universal; drums-v1.stems includes 'drums'.
    assert {g['beatmap_id'] for g in drums} == {'bm-1', 'bm-2'}

    guitar = feedback_service.aggregate_for_stem('guitar')
    # Only bm-1 applies to guitar (drums-v1.stems=['drums'] excludes guitar).
    assert {g['beatmap_id'] for g in guitar} == {'bm-1'}


def test_aggregate_skips_beatmaps_with_no_feedback(monkeypatch):
    from app.routers import generation_presets as gp
    monkeypatch.setattr(gp, 'BUILTIN_PRESETS',
                        [{'name': 'v1', 'description': '', 'builtin': True, 'generation': {}}])
    monkeypatch.setattr(gp, '_load_user_presets', lambda: [])

    t = _new_track('Song X')
    _seed_beatmap(t, 'bm-empty', stem='guitar', preset='v1')

    result = feedback_service.aggregate_for_stem('guitar')
    assert result == []


def test_scoreboard_rolls_up_per_preset(monkeypatch):
    from app.routers import generation_presets as gp
    monkeypatch.setattr(gp, 'BUILTIN_PRESETS', [
        {'name': 'v1', 'description': '', 'builtin': True, 'generation': {}},
        {'name': 'v13 — contour DP', 'description': '', 'builtin': True, 'generation': {}},
    ])
    monkeypatch.setattr(gp, '_load_user_presets', lambda: [])

    t1 = _new_track('Song A')
    _seed_beatmap(t1, 'bm-v1', stem='guitar', preset='v1')
    _seed_beatmap(t1, 'bm-v13', stem='guitar', preset='v13 — contour DP')
    feedback_service.add_note(t1.id, 'bm-v1', author='alice', rating=2, tags=['feels-random'], text='')
    feedback_service.add_note(t1.id, 'bm-v1', author='bob', rating=3, tags=['feels-random', 'off-beat'], text='')
    feedback_service.add_note(t1.id, 'bm-v13', author='alice', rating=5, tags=['feels-great'], text='')

    board = feedback_service.scoreboard_for_stem('guitar')
    assert [r['preset_name'] for r in board] == ['v13 — contour DP', 'v1']
    v1 = board[1]
    assert v1['beatmaps'] == 1 and v1['notes'] == 2 and v1['mean_rating'] == 2.5
    assert v1['tag_counts'] == {'feels-random': 2, 'off-beat': 1}
    assert board[0]['mean_rating'] == 5.0
