from __future__ import annotations

import time

import pytest


@pytest.fixture
def two_tracks(tmp_path, monkeypatch):
    from app.config import settings
    from app.services import tracks as tracks_mod
    from app.services.tracks import Track

    upload_dir = tmp_path / 'uploads'
    tracks_dir = upload_dir / '_tracks'
    tracks_dir.mkdir(parents=True)
    monkeypatch.setattr(settings, 'upload_dir', str(upload_dir))
    monkeypatch.setattr(tracks_mod, 'TRACKS_DIR', tracks_dir)

    expert = '\n'.join(f'  {t} = N 0 0' for t in range(0, 192 * 8, 48))  # dense
    hard = '\n'.join(f'  {t} = N 0 0' for t in range(0, 192 * 8, 192))   # sparse
    chart = (
        '[Song]\n{\n  Name = "T"\n  Resolution = 192\n}\n'
        '[SyncTrack]\n{\n  0 = B 120000\n}\n'
        f'[ExpertSingle]\n{{\n{expert}\n}}\n'
        f'[HardSingle]\n{{\n{hard}\n}}\n'
    )

    t = Track(id='trk1', name='Song One', created_at=time.time(),
              stems={'guitar': 'guitar.ogg'}, artist='Artist A')
    # one included beatmap + one excluded beatmap (must be ignored)
    t.beatmaps = [
        {'id': 'bm_inc', 'stem': 'guitar', 'preset': 'v1', 'included': True, 'generated_at': 1.0},
        {'id': 'bm_exc', 'stem': 'guitar', 'preset': 'v2', 'included': False, 'generated_at': 2.0},
    ]
    t.save()
    for bid in ('bm_inc', 'bm_exc'):
        d = t.beatmaps_dir / bid
        d.mkdir(parents=True)
        (d / 'notes.chart').write_text(chart, encoding='utf-8')
    return ['trk1']


def test_compute_calibration_rows_only_included(two_tracks):
    from app.services.calibration import compute_calibration
    res = compute_calibration(two_tracks)
    beatmap_ids = {r['beatmap_id'] for r in res['rows']}
    assert beatmap_ids == {'bm_inc'}             # excluded beatmap dropped
    difficulties = {r['difficulty'] for r in res['rows']}
    assert difficulties == {'Expert', 'Hard'}
    assert all(r['instrument'] == 'Guitar' for r in res['rows'])


def test_compute_calibration_cross_difficulty_ratio(two_tracks):
    from app.services.calibration import compute_calibration
    res = compute_calibration(two_tracks)
    expert = next(r for r in res['rows'] if r['difficulty'] == 'Expert')
    hard = next(r for r in res['rows'] if r['difficulty'] == 'Hard')
    assert expert['pct_of_expert_gpm'] == 100.0
    assert hard['pct_of_expert_gpm'] < 100.0     # Hard is sparser


def test_compute_calibration_summary_present(two_tracks):
    from app.services.calibration import compute_calibration
    res = compute_calibration(two_tracks)
    assert 'Expert' in res['summary']
    assert 'gems_per_min' in res['summary']['Expert']


def test_compute_calibration_skips_missing_chart(two_tracks):
    from app.services.calibration import compute_calibration
    from app.services.tracks import Track
    (Track.load('trk1').beatmaps_dir / 'bm_inc' / 'notes.chart').unlink()
    res = compute_calibration(two_tracks)
    assert res['rows'] == []
    assert res['skipped'] and res['skipped'][0]['beatmap_id'] == 'bm_inc'
