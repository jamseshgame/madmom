"""Service tests for clone_difficulty_across_beatmaps — builds a Track with two
guitar beatmap dirs on disk and asserts the target notes.chart is spliced."""
from __future__ import annotations

import time
from pathlib import Path

import pytest


@pytest.fixture
def track_with_two_guitar_beatmaps(tmp_path, monkeypatch):
    from app.config import settings
    from app.services import tracks as tracks_mod
    from app.services.tracks import Track

    upload_dir = tmp_path / 'uploads'
    tracks_dir = upload_dir / '_tracks'
    tracks_dir.mkdir(parents=True)
    monkeypatch.setattr(settings, 'upload_dir', str(upload_dir))
    monkeypatch.setattr(tracks_mod, 'TRACKS_DIR', tracks_dir)

    tid = 'trk1'
    t = Track(id=tid, name='Test', created_at=time.time(),
              stems={'guitar': 'guitar.ogg'}, model='demucs', output_format='ogg')
    t.beatmaps = [
        {'id': 'src', 'stem': 'guitar', 'preset': 'v8', 'active': True, 'generated_at': 1.0},
        {'id': 'dst', 'stem': 'guitar', 'preset': 'v11', 'active': False, 'generated_at': 2.0},
        {'id': 'drm', 'stem': 'drums', 'preset': 'd1', 'active': True, 'generated_at': 3.0},
    ]
    t.save()

    def _chart(expert, hard=None, resolution=192):
        parts = [
            f'[Song]\n{{\n  Resolution = {resolution}\n}}\n',
            '[SyncTrack]\n{\n  0 = B 120000\n}\n',
            f'[ExpertSingle]\n{{\n{expert}\n}}\n',
        ]
        if hard is not None:
            parts.append(f'[HardSingle]\n{{\n{hard}\n}}\n')
        return ''.join(parts)

    for bid, text in (
        ('src', _chart('  0 = N 0 0\n  192 = N 1 0')),
        ('dst', _chart('  0 = N 4 0', hard='  0 = N 2 0')),
        ('drm', '[Song]\n{\n  Resolution = 192\n}\n[ExpertDrums]\n{\n  0 = N 0 0\n}\n'),
    ):
        d = t.beatmaps_dir / bid
        d.mkdir(parents=True)
        (d / 'notes.chart').write_text(text, encoding='utf-8')

    return tid, t.beatmaps_dir


def test_clone_overwrites_target_difficulty(track_with_two_guitar_beatmaps):
    from app.services.tracks import clone_difficulty_across_beatmaps
    tid, bdir = track_with_two_guitar_beatmaps
    result = clone_difficulty_across_beatmaps(tid, 'src', 'ExpertSingle', 'dst', 'HardSingle')
    assert result['overwrote'] is True
    assert result['target_difficulty'] == 'HardSingle'
    txt = (bdir / 'dst' / 'notes.chart').read_text(encoding='utf-8')
    assert '[HardSingle]\n{\n  0 = N 0 0\n  192 = N 1 0\n}\n' in txt
    assert '[ExpertSingle]\n{\n  0 = N 4 0\n}\n' in txt


def test_clone_into_empty_slot_reports_not_overwrote(track_with_two_guitar_beatmaps):
    from app.services.tracks import clone_difficulty_across_beatmaps
    tid, bdir = track_with_two_guitar_beatmaps
    result = clone_difficulty_across_beatmaps(tid, 'src', 'ExpertSingle', 'dst', 'EasySingle')
    assert result['overwrote'] is False
    txt = (bdir / 'dst' / 'notes.chart').read_text(encoding='utf-8')
    assert '[EasySingle]\n{\n  0 = N 0 0\n  192 = N 1 0\n}\n' in txt


def test_clone_cross_stem_raises(track_with_two_guitar_beatmaps):
    from app.services.tracks import CloneDifficultyError, clone_difficulty_across_beatmaps
    tid, _ = track_with_two_guitar_beatmaps
    with pytest.raises(CloneDifficultyError):
        clone_difficulty_across_beatmaps(tid, 'src', 'ExpertSingle', 'drm', 'ExpertDrums')


def test_clone_mismatched_section_family_raises(track_with_two_guitar_beatmaps):
    from app.services.tracks import CloneDifficultyError, clone_difficulty_across_beatmaps
    tid, _ = track_with_two_guitar_beatmaps
    with pytest.raises(CloneDifficultyError):
        clone_difficulty_across_beatmaps(tid, 'src', 'ExpertSingle', 'dst', 'HardDrums')


def test_clone_missing_source_difficulty_raises(track_with_two_guitar_beatmaps):
    from app.services.tracks import CloneDifficultyError, clone_difficulty_across_beatmaps
    tid, _ = track_with_two_guitar_beatmaps
    with pytest.raises(CloneDifficultyError):
        clone_difficulty_across_beatmaps(tid, 'src', 'MediumSingle', 'dst', 'HardSingle')


def test_clone_unknown_beatmap_returns_none(track_with_two_guitar_beatmaps):
    from app.services.tracks import clone_difficulty_across_beatmaps
    tid, _ = track_with_two_guitar_beatmaps
    assert clone_difficulty_across_beatmaps(tid, 'nope', 'ExpertSingle', 'dst', 'HardSingle') is None


def test_clone_same_beatmap_remaps_difficulty(track_with_two_guitar_beatmaps):
    """source==target is well-defined: copy one difficulty into another slot of
    the same beatmap."""
    from app.services.tracks import clone_difficulty_across_beatmaps
    tid, bdir = track_with_two_guitar_beatmaps
    result = clone_difficulty_across_beatmaps(tid, 'dst', 'ExpertSingle', 'dst', 'HardSingle')
    assert result['overwrote'] is True
    txt = (bdir / 'dst' / 'notes.chart').read_text(encoding='utf-8')
    # dst's Expert ('  0 = N 4 0') is now also its Hard.
    assert '[HardSingle]\n{\n  0 = N 4 0\n}\n' in txt
