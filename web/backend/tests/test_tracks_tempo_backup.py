"""Tests for the tempo-propagation safety net on tracks.py.

A tempo edit on one beatmap is mirrored onto every sibling chart of the track
(_propagate_tempo_to_siblings). A single bad save (e.g. an octave-doubled BPM)
therefore rewrites every chart at once, and used to be irreversible. These tests
pin the safeguards: a .autobak is written before any destructive overwrite, and
a near-octave tempo change is flagged so the UI can warn.
"""
from __future__ import annotations

import time
from pathlib import Path

import pytest


@pytest.fixture
def track_with_three_beatmaps(tmp_path, monkeypatch):
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
        {'id': 'sib1', 'stem': 'guitar', 'preset': 'v11', 'active': False, 'generated_at': 2.0},
        {'id': 'sib2', 'stem': 'drums', 'preset': 'd1', 'active': True, 'generated_at': 3.0},
    ]
    t.save()

    def _chart(micro_bpm=120000, offset='0.0'):
        return (
            f'[Song]\n{{\n  Resolution = 192\n  Offset = {offset}\n}}\n'
            f'[SyncTrack]\n{{\n  0 = TS 4\n  0 = B {micro_bpm}\n}}\n'
            '[ExpertSingle]\n{\n  0 = N 0 0\n  192 = N 1 0\n}\n'
        )

    for bid, micro in (('src', 103359), ('sib1', 103359), ('sib2', 103359)):
        d = t.beatmaps_dir / bid
        d.mkdir(parents=True)
        (d / 'notes.chart').write_text(_chart(micro), encoding='utf-8')

    return tid, t.beatmaps_dir, _chart


def test_first_micro_bpm_reads_tick0_tempo():
    from app.routers.tracks import _first_micro_bpm
    text = '[SyncTrack]\n{\n  0 = TS 4\n  0 = B 103359\n}\n'
    assert _first_micro_bpm(text) == 103359


def test_first_micro_bpm_none_when_absent():
    from app.routers.tracks import _first_micro_bpm
    assert _first_micro_bpm('[SyncTrack]\n{\n  0 = TS 4\n}\n') is None


def test_octave_ratio_detects_double():
    from app.routers.tracks import _octave_ratio
    assert _octave_ratio(103359, 204000) == pytest.approx(2.0, abs=0.05)


def test_octave_ratio_detects_half():
    from app.routers.tracks import _octave_ratio
    assert _octave_ratio(204000, 103359) == pytest.approx(0.5, abs=0.05)


def test_octave_ratio_none_for_small_change():
    from app.routers.tracks import _octave_ratio
    assert _octave_ratio(103359, 104000) is None


def test_propagation_backs_up_siblings_before_overwrite(track_with_three_beatmaps):
    from app.routers.tracks import _propagate_tempo_to_siblings
    tid, bdir, _chart = track_with_three_beatmaps
    # Source now carries an (accidental) doubled tempo.
    new_source = _chart(204000)
    (bdir / 'src' / 'notes.chart').write_text(new_source, encoding='utf-8')

    _propagate_tempo_to_siblings(tid, 'src', new_source)

    for sib in ('sib1', 'sib2'):
        chart = (bdir / sib / 'notes.chart').read_text(encoding='utf-8')
        bak = bdir / sib / 'notes.chart.autobak'
        assert '0 = B 204000' in chart, f'{sib} should have received the new tempo'
        assert bak.exists(), f'{sib} should have a .autobak safety copy'
        assert '0 = B 103359' in bak.read_text(encoding='utf-8'), 'backup holds the pre-overwrite tempo'


def test_propagation_flags_octave_warning(track_with_three_beatmaps):
    from app.routers.tracks import _propagate_tempo_to_siblings
    tid, bdir, _chart = track_with_three_beatmaps
    new_source = _chart(204000)
    result = _propagate_tempo_to_siblings(tid, 'src', new_source)
    assert set(result['synced']) == {'sib1', 'sib2'}
    assert result['octave_warning'] is not None
    assert result['octave_warning']['factor'] == pytest.approx(2.0, abs=0.05)


def test_propagation_no_warning_for_small_change(track_with_three_beatmaps):
    from app.routers.tracks import _propagate_tempo_to_siblings
    tid, bdir, _chart = track_with_three_beatmaps
    new_source = _chart(104000)
    result = _propagate_tempo_to_siblings(tid, 'src', new_source)
    assert result['octave_warning'] is None


def test_save_chart_with_backup_writes_autobak(tmp_path):
    from app.routers.tracks import _save_chart_with_backup
    p = tmp_path / 'notes.chart'
    p.write_text('original', encoding='utf-8')
    _save_chart_with_backup(p, 'updated')
    assert p.read_text(encoding='utf-8') == 'updated'
    assert (tmp_path / 'notes.chart.autobak').read_text(encoding='utf-8') == 'original'


def test_save_chart_with_backup_no_backup_when_absent(tmp_path):
    from app.routers.tracks import _save_chart_with_backup
    p = tmp_path / 'notes.chart'
    _save_chart_with_backup(p, 'first')
    assert p.read_text(encoding='utf-8') == 'first'
    assert not (tmp_path / 'notes.chart.autobak').exists()
