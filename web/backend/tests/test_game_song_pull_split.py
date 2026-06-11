"""Tests for the Game Library pull/push round trip: split_merged_chart /
splice_stem_charts_into_merged in chart_generator, and the per-stem Studio
track shim built by clone_game_song_to_studio_track."""

from __future__ import annotations

import json

import pytest

import app.services.game_songs as gs
import app.services.tracks as tracks_mod
from app.services.chart_generator import (
    parse_beatmaps_block,
    splice_stem_charts_into_merged,
    split_merged_chart,
)

MERGED = '''[Song]
{
  Name = "Somebody Told Me"
  Resolution = 192
  MusicStream = "song.ogg"
}
[SyncTrack]
{
  0 = TS 4
  0 = B 138000
}
[Events]
{
  384 = E "section Intro"
}
[Beatmaps]
{
  ExpertSingle = preset="guitar-v1" name="active" beatmap_id="aaaa11112222"
  ExpertDrums = preset="drums-v1" name="active" beatmap_id="bbbb33334444"
  ExpertDrums2 = preset="drums-alt" name="alt" beatmap_id="cccc55556666"
}
[ExpertSingle]
{
  192 = N 0 0
  384 = N 1 96
}
[HardSingle]
{
  192 = N 0 0
}
[SlideMeta_ExpertSingle]
{
  192 = S 1 0
}
[ExpertDrums]
{
  192 = N 2 0
}
[ExpertDrums2]
{
  192 = N 3 0
}
[JamseshVocals]
{
  0 = V 60 96 hel-
}
'''

ALL_STEMS = {'song', 'guitar', 'drums', 'rhythm', 'vocals', 'crowd'}


# ── parse_beatmaps_block ────────────────────────────────────────────────────

def test_parse_beatmaps_block():
    rows = parse_beatmaps_block(MERGED)
    assert rows['ExpertSingle'] == {'preset': 'guitar-v1', 'tag': 'active', 'beatmap_id': 'aaaa11112222'}
    assert rows['ExpertDrums2']['tag'] == 'alt'
    assert parse_beatmaps_block('[Song]\n{\n}\n') == {}


# ── split_merged_chart ──────────────────────────────────────────────────────

def test_split_groups_sections_by_suffix_and_alternate():
    pieces = split_merged_chart(MERGED, ALL_STEMS)
    assert [(p['stem'], p['n']) for p in pieces] == [('guitar', 1), ('drums', 1), ('drums', 2)]
    guitar, drums, drums_alt = pieces
    assert guitar['sections'] == ['ExpertSingle', 'HardSingle']
    assert guitar['beatmap_id'] == 'aaaa11112222'
    assert guitar['preset'] == 'guitar-v1'
    assert guitar['is_active'] is True
    assert drums_alt['beatmap_id'] == 'cccc55556666'
    assert drums_alt['is_active'] is False


def test_split_renames_sections_to_single_family():
    pieces = split_merged_chart(MERGED, ALL_STEMS)
    drums = pieces[1]
    assert '[ExpertSingle]' in drums['chart_text']
    assert '192 = N 2 0' in drums['chart_text']
    assert '[ExpertDrums]' not in drums['chart_text']
    # Header blocks copied into every split chart
    assert 'Resolution = 192' in drums['chart_text']
    assert '0 = B 138000' in drums['chart_text']
    assert 'section Intro' in drums['chart_text']
    # No metadata block leaks into per-stem charts
    assert '[Beatmaps]' not in drums['chart_text']
    assert '[JamseshVocals]' not in drums['chart_text']


def test_split_carries_slide_meta():
    guitar = split_merged_chart(MERGED, ALL_STEMS)[0]
    assert '[SlideMeta_ExpertSingle]' in guitar['chart_text']
    assert '192 = S 1 0' in guitar['chart_text']
    drums = split_merged_chart(MERGED, ALL_STEMS)[1]
    assert '[SlideMeta' not in drums['chart_text']


def test_split_stem_fallbacks_without_audio():
    pieces = split_merged_chart(MERGED, {'song', 'drums'})
    assert pieces[0]['stem'] == 'song'  # no guitar.ogg → master mix owns Single


def test_split_without_beatmaps_block_defaults_metadata():
    text = MERGED.replace(
        '[Beatmaps]\n{\n'
        '  ExpertSingle = preset="guitar-v1" name="active" beatmap_id="aaaa11112222"\n'
        '  ExpertDrums = preset="drums-v1" name="active" beatmap_id="bbbb33334444"\n'
        '  ExpertDrums2 = preset="drums-alt" name="alt" beatmap_id="cccc55556666"\n'
        '}\n',
        '',
    )
    pieces = split_merged_chart(text, ALL_STEMS)
    assert [p['beatmap_id'] for p in pieces] == ['', '', '']
    assert [p['is_active'] for p in pieces] == [True, True, False]  # n==1 active


# ── splice_stem_charts_into_merged ──────────────────────────────────────────

def _contributions(pieces):
    return [
        (p['chart_text'], p['stem'], {'preset': p['preset'], 'beatmap_id': p['beatmap_id'] or 'x', 'is_active': p['is_active']})
        for p in pieces
    ]


def test_splice_round_trip_preserves_unmanaged_blocks():
    pieces = split_merged_chart(MERGED, ALL_STEMS)
    out = splice_stem_charts_into_merged(MERGED, _contributions(pieces))
    assert '[JamseshVocals]' in out
    assert '0 = V 60 96 hel-' in out
    assert '[ExpertSingle]' in out and '[ExpertDrums]' in out and '[ExpertDrums2]' in out
    assert '[HardSingle]' in out
    assert '[SlideMeta_ExpertSingle]' in out
    rows = parse_beatmaps_block(out)
    assert rows['ExpertSingle']['beatmap_id'] == 'aaaa11112222'
    assert rows['ExpertDrums2']['tag'] == 'alt'
    # Round trip is stable: splitting the spliced chart yields the same groups
    again = split_merged_chart(out, ALL_STEMS)
    assert [(p['stem'], p['n'], p['sections']) for p in again] == \
        [(p['stem'], p['n'], p['sections']) for p in pieces]


def test_splice_applies_edits_and_deletions():
    pieces = split_merged_chart(MERGED, ALL_STEMS)
    guitar = pieces[0]
    edited = guitar['chart_text'].replace('384 = N 1 96', '384 = N 4 96')
    # Delete the Hard difficulty entirely
    edited = edited.replace('[HardSingle]\n{\n  192 = N 0 0\n}\n', '')
    assert '[HardSingle]' not in edited
    pieces[0] = dict(guitar, chart_text=edited)
    out = splice_stem_charts_into_merged(MERGED, _contributions(pieces))
    assert '384 = N 4 96' in out
    assert '384 = N 1 96' not in out
    assert '[HardSingle]' not in out
    assert 'HardSingle' not in parse_beatmaps_block(out)


def test_splice_into_empty_chart_builds_from_contributions():
    pieces = split_merged_chart(MERGED, ALL_STEMS)
    out = splice_stem_charts_into_merged('', _contributions(pieces))
    assert 'Resolution = 192' in out
    assert '[ExpertDrums]' in out
    assert '[JamseshVocals]' not in out


# ── clone_game_song_to_studio_track / sync_studio_edits_to_game_folder ─────

@pytest.fixture
def game_env(tmp_path, monkeypatch):
    local_dir = tmp_path / 'game-songs'
    tracks_dir = tmp_path / 'tracks'
    monkeypatch.setattr(gs, 'LOCAL_DIR', local_dir)
    monkeypatch.setattr(gs, 'TRACKS_DIR', tracks_dir)
    monkeypatch.setattr(tracks_mod, 'TRACKS_DIR', tracks_dir)

    folder = 'The Killers - Somebody Told Me'
    src = local_dir / folder
    src.mkdir(parents=True)
    for ogg in ('song', 'guitar', 'drums', 'rhythm', 'vocals', 'crowd', 'preview'):
        (src / f'{ogg}.ogg').write_bytes(b'OggS')
    (src / 'song.ini').write_text(
        '[song]\nname = Somebody Told Me\nartist = The Killers\nalbum = Hot Fuss\n', encoding='utf-8'
    )
    (src / 'album.png').write_bytes(b'\x89PNG')
    (src / 'notes_fixed_slides.chart').write_text(MERGED, encoding='utf-8')
    return folder, src


def test_clone_builds_per_stem_shim(game_env):
    folder, src = game_env
    track_id, primary_id = gs.clone_game_song_to_studio_track(folder)
    track = tracks_mod.Track.load(track_id)
    assert set(track.stems) == ALL_STEMS  # preview.ogg excluded
    assert track.artist == 'The Killers'
    assert (track.stems_dir / 'album.png').exists()

    assert [(b['stem'], b['active']) for b in track.beatmaps] == \
        [('guitar', True), ('drums', True), ('drums', False)]
    assert primary_id == 'aaaa11112222'  # id reused from [Beatmaps]
    for bm in track.beatmaps:
        bm_dir = track.beatmaps_dir / bm['id']
        chart = bm_dir / 'notes.chart'
        assert chart.exists() and not chart.is_symlink()
        assert '[ExpertSingle]' in chart.read_text(encoding='utf-8')
        assert (bm_dir / 'song.ogg').exists()
        assert (bm_dir / 'song.ini').exists()
    # Drums beatmap audio is the drums stem, not the master mix
    drums_audio = (track.beatmaps_dir / 'bbbb33334444' / 'song.ogg').resolve()
    assert drums_audio.name == 'drums.ogg' or drums_audio.read_bytes() == (src / 'drums.ogg').read_bytes()


def test_clone_is_idempotent_and_keeps_generated_beatmaps(game_env):
    folder, _src = game_env
    track_id, _ = gs.clone_game_song_to_studio_track(folder)
    track = tracks_mod.Track.load(track_id)
    ids_before = sorted(b['id'] for b in track.beatmaps)

    # A Studio-generated beatmap on the shim track must survive re-pulls
    gen_dir = track.beatmaps_dir / 'gen111222333'
    gen_dir.mkdir(parents=True)
    (gen_dir / 'notes.chart').write_text('[Song]\n{\n  Resolution = 192\n}\n[ExpertSingle]\n{\n  0 = N 0 0\n}\n')
    track.beatmaps.append({
        'id': 'gen111222333', 'stem': 'drums', 'generated_at': 1.0, 'folder_name': folder,
        'song_name': 'x', 'active': False, 'model': 'madmom', 'model_version': '0.17',
    })
    track.save()

    track_id2, _ = gs.clone_game_song_to_studio_track(folder)
    assert track_id2 == track_id
    track = tracks_mod.Track.load(track_id)
    imported = sorted(b['id'] for b in track.beatmaps if b['model'] == 'imported')
    assert imported == ids_before
    assert any(b['id'] == 'gen111222333' for b in track.beatmaps)
    assert (gen_dir / 'notes.chart').exists()


def test_clone_falls_back_to_whole_chart_shim(game_env):
    folder, src = game_env
    (src / 'notes_fixed_slides.chart').write_text('[Song]\n{\n  Resolution = 192\n}\n', encoding='utf-8')
    track_id, primary_id = gs.clone_game_song_to_studio_track(folder)
    track = tracks_mod.Track.load(track_id)
    assert [b['stem'] for b in track.beatmaps] == ['song']
    assert primary_id == track.beatmaps[0]['id']


def test_sync_studio_edits_back_into_folder_chart(game_env):
    folder, src = game_env
    track_id, primary_id = gs.clone_game_song_to_studio_track(folder)
    track = tracks_mod.Track.load(track_id)

    chart_path = track.beatmaps_dir / primary_id / 'notes.chart'
    chart_path.write_text(
        chart_path.read_text(encoding='utf-8').replace('384 = N 1 96', '384 = N 4 96'), encoding='utf-8'
    )

    assert gs.sync_studio_edits_to_game_folder(folder) is True
    out = (src / 'notes_fixed_slides.chart').read_text(encoding='utf-8')
    assert '384 = N 4 96' in out
    assert '[JamseshVocals]' in out
    assert '[ExpertDrums]' in out and '[ExpertDrums2]' in out
    rows = parse_beatmaps_block(out)
    assert rows['ExpertSingle']['beatmap_id'] == primary_id


def test_sync_skips_legacy_merged_chart_copies(game_env):
    folder, src = game_env
    track_id, primary_id = gs.clone_game_song_to_studio_track(folder)
    track = tracks_mod.Track.load(track_id)
    # Simulate a legacy Windows copy-fallback shim: bm chart holds the whole
    # merged chart (numbered + non-Single sections)
    for bm in track.beatmaps:
        (track.beatmaps_dir / bm['id'] / 'notes.chart').write_text(MERGED, encoding='utf-8')
    before = (src / 'notes_fixed_slides.chart').read_text(encoding='utf-8')
    assert gs.sync_studio_edits_to_game_folder(folder) is False
    assert (src / 'notes_fixed_slides.chart').read_text(encoding='utf-8') == before


def test_track_json_round_trips(game_env):
    folder, _src = game_env
    track_id, _ = gs.clone_game_song_to_studio_track(folder)
    data = json.loads((tracks_mod.TRACKS_DIR / track_id / 'track.json').read_text())
    assert data['source_game_song'] == folder
    assert data['stems']['drums'] == 'drums.ogg'
