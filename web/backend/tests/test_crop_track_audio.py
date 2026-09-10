"""Track-level stem cropping — trims the head/tail off every stem at once.

Real ffmpeg, real files: the whole point of the feature is that the stems stay
sample-aligned with each other, which only an actual encode can demonstrate.
"""
from __future__ import annotations

import json
import shutil
import subprocess

import pytest

ffmpeg_missing = shutil.which('ffmpeg') is None or shutil.which('ffprobe') is None
pytestmark = pytest.mark.skipif(ffmpeg_missing, reason='ffmpeg/ffprobe not installed')


def _make_audio(path, seconds, silent_head=0.0):
    """A sine tone, optionally muted for the first `silent_head` seconds — so a
    test can tell whether the head was really removed rather than just trusting
    the reported duration."""
    args = ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:r=44100',
            '-t', str(seconds)]
    if silent_head:
        args += ['-af', "volume=enable='lt(t,%s)':volume=0" % silent_head]
    codec = {'.ogg': 'libvorbis', '.mp3': 'libmp3lame', '.wav': 'pcm_s16le'}[path.suffix]
    args += ['-c:a', codec, str(path)]
    subprocess.run(args, capture_output=True, check=True)


def _duration(path):
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
         '-of', 'default=nw=1:nk=1', str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def _max_volume_db(path, start, dur):
    out = subprocess.run(
        ['ffmpeg', '-v', 'info', '-ss', str(start), '-t', str(dur), '-i', str(path),
         '-af', 'volumedetect', '-f', 'null', '-'],
        capture_output=True, text=True,
    )
    for line in out.stderr.splitlines():
        if 'max_volume:' in line:
            return float(line.split('max_volume:')[1].strip().split()[0])
    return -999.0


@pytest.fixture
def track(tmp_path, monkeypatch):
    """A 'ready' track with three 10 s stems, a stored master and an album.png."""
    from app.services import tracks as tracks_mod

    tracks_dir = tmp_path / '_tracks'
    tracks_dir.mkdir(parents=True)
    monkeypatch.setattr(tracks_mod, 'TRACKS_DIR', tracks_dir)

    t = tracks_mod.Track(
        id='abc123', name='Nausea', created_at=0.0, output_format='ogg',
        stems={
            'vocals': 'vocals.ogg',
            'drums': 'drums.ogg',
            'song': 'song.ogg',
            'album_png': 'album.png',
        },
        source_audio='source.ogg',
    )
    t.stems_dir.mkdir(parents=True)
    t.source_dir.mkdir(parents=True)
    for name in ('vocals.ogg', 'drums.ogg', 'song.ogg'):
        _make_audio(t.stems_dir / name, 10, silent_head=2.0)
    _make_audio(t.source_dir / 'source.ogg', 10, silent_head=2.0)
    (t.stems_dir / 'album.png').write_bytes(b'\x89PNG-not-really')
    (t.stems_dir / 'song.ini').write_text('[song]\nname = Nausea\nsong_length = 10000\n')
    t.save()
    return t


class TestCropTrackAudio:
    def test_every_audio_stem_lands_on_the_same_new_duration(self, track):
        from app.services.crop_audio import crop_track_audio

        crop_track_audio(track, start_sec=2.0, end_sec=7.0)

        durations = [_duration(track.stems_dir / n)
                     for n in ('vocals.ogg', 'drums.ogg', 'song.ogg')]
        for d in durations:
            assert 4.9 < d < 5.1, durations
        # Sample-alignment is the whole feature: no stem may drift from another.
        assert max(durations) - min(durations) < 0.01

    def test_head_is_actually_removed_not_just_reported(self, track):
        from app.services.crop_audio import crop_track_audio

        # The fixture is silent for its first 2 s. Before the crop that silence
        # is at the front; after cropping from 2.0 s the tone should start
        # immediately.
        assert _max_volume_db(track.stems_dir / 'vocals.ogg', 0, 0.5) < -50

        crop_track_audio(track, start_sec=2.0, end_sec=7.0)

        assert _max_volume_db(track.stems_dir / 'vocals.ogg', 0, 0.5) > -20

    def test_stored_master_is_cropped_too(self, track):
        from app.services.crop_audio import crop_track_audio

        crop_track_audio(track, start_sec=2.0, end_sec=7.0)

        assert 4.9 < _duration(track.source_path) < 5.1

    def test_non_audio_stems_are_left_alone(self, track):
        from app.services.crop_audio import crop_track_audio

        crop_track_audio(track, start_sec=2.0, end_sec=7.0)

        assert (track.stems_dir / 'album.png').read_bytes() == b'\x89PNG-not-really'

    def test_song_length_in_song_ini_follows_the_new_duration(self, track):
        from app.services.crop_audio import crop_track_audio

        crop_track_audio(track, start_sec=2.0, end_sec=7.0)

        ini = (track.stems_dir / 'song.ini').read_text()
        length = int(ini.split('song_length = ')[1].split('\n')[0])
        assert 4900 < length < 5100

    def test_stale_peak_caches_are_dropped(self, track):
        from app.services.crop_audio import crop_track_audio

        (track.stems_dir / 'peaks.json').write_text(json.dumps({'vocals': [0.1]}))
        (track.stems_dir / 'vocals.peaks.f32').write_bytes(b'\x00' * 16)

        crop_track_audio(track, start_sec=2.0, end_sec=7.0)

        assert not (track.stems_dir / 'peaks.json').exists()
        assert not (track.stems_dir / 'vocals.peaks.f32').exists()

    def test_result_reports_the_new_duration_and_what_was_cropped(self, track):
        from app.services.crop_audio import crop_track_audio

        res = crop_track_audio(track, start_sec=2.0, end_sec=7.0)

        assert res['start_sec'] == 2.0
        assert res['end_sec'] == 7.0
        assert 4900 < res['duration_ms'] < 5100
        assert set(res['cropped']) == {'vocals', 'drums', 'song', 'source'}

    def test_reports_beatmaps_it_left_out_of_sync(self, track):
        from app.services.crop_audio import crop_track_audio

        track.beatmaps = [{'id': 'bm1', 'stem': 'guitar'}, {'id': 'bm2', 'stem': 'drums'}]
        track.save()

        res = crop_track_audio(track, start_sec=2.0, end_sec=7.0)

        assert res['beatmaps_untouched'] == ['bm1', 'bm2']

    def test_mp3_stems_crop_without_losing_their_format(self, tmp_path, monkeypatch):
        from app.services import tracks as tracks_mod
        from app.services.crop_audio import crop_track_audio

        tracks_dir = tmp_path / '_tracks'
        tracks_dir.mkdir(parents=True)
        monkeypatch.setattr(tracks_mod, 'TRACKS_DIR', tracks_dir)
        t = tracks_mod.Track(id='mp3trk', name='M', created_at=0.0, output_format='mp3',
                             stems={'vocals': 'vocals.mp3'})
        t.stems_dir.mkdir(parents=True)
        _make_audio(t.stems_dir / 'vocals.mp3', 10)
        t.save()

        crop_track_audio(t, start_sec=1.0, end_sec=4.0)

        assert 2.8 < _duration(t.stems_dir / 'vocals.mp3') < 3.2


class TestCropTrackAudioAtomicity:
    def test_a_failed_encode_leaves_every_stem_untouched(self, track):
        from app.services.crop_audio import crop_track_audio

        # A stem ffmpeg cannot decode. A half-applied crop would leave the
        # remaining stems shorter than this one — exactly the desync the
        # feature exists to prevent — so nothing may be swapped.
        (track.stems_dir / 'drums.ogg').write_bytes(b'not audio at all')
        before = {n: (track.stems_dir / n).read_bytes()
                  for n in ('vocals.ogg', 'drums.ogg', 'song.ogg')}

        with pytest.raises(RuntimeError):
            crop_track_audio(track, start_sec=2.0, end_sec=7.0)

        for name, blob in before.items():
            assert (track.stems_dir / name).read_bytes() == blob, name

    def test_no_temp_files_are_left_behind_after_a_failure(self, track):
        from app.services.crop_audio import crop_track_audio

        (track.stems_dir / 'drums.ogg').write_bytes(b'not audio at all')
        with pytest.raises(RuntimeError):
            crop_track_audio(track, start_sec=2.0, end_sec=7.0)

        assert not list(track.stems_dir.glob('*.crop.*'))


class TestCropTrackAudioValidation:
    def test_rejects_end_at_or_before_start(self, track):
        from app.services.crop_audio import crop_track_audio

        with pytest.raises(ValueError):
            crop_track_audio(track, start_sec=5.0, end_sec=5.0)

    def test_rejects_negative_start(self, track):
        from app.services.crop_audio import crop_track_audio

        with pytest.raises(ValueError):
            crop_track_audio(track, start_sec=-1.0, end_sec=5.0)

    def test_rejects_an_end_past_the_track_duration(self, track):
        from app.services.crop_audio import crop_track_audio

        with pytest.raises(ValueError):
            crop_track_audio(track, start_sec=0.0, end_sec=30.0)

    def test_rejects_a_track_with_no_audio_stems(self, tmp_path, monkeypatch):
        from app.services import tracks as tracks_mod
        from app.services.crop_audio import crop_track_audio

        tracks_dir = tmp_path / '_tracks'
        tracks_dir.mkdir(parents=True)
        monkeypatch.setattr(tracks_mod, 'TRACKS_DIR', tracks_dir)
        t = tracks_mod.Track(id='empty1', name='E', created_at=0.0, stems={}, status='draft')
        t.stems_dir.mkdir(parents=True)
        t.save()

        with pytest.raises(ValueError):
            crop_track_audio(t, start_sec=0.0, end_sec=5.0)
