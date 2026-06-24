from __future__ import annotations

import shutil
import subprocess

import pytest

ffmpeg_missing = shutil.which('ffmpeg') is None or shutil.which('ffprobe') is None
pytestmark = pytest.mark.skipif(ffmpeg_missing, reason='ffmpeg/ffprobe not installed')

from app.services.crop_audio import crop_song_ogg

CHART = """[Song]
{
  Name = "X"
  Resolution = 192
}
[SyncTrack]
{
  0 = B 120000
}
[ExpertSingle]
{
  384 = N 0 0
}
"""


def _make_ogg(path, seconds):
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', f'anullsrc=r=44100:cl=mono',
         '-t', str(seconds), '-c:a', 'libvorbis', '-q:a', '6', str(path)],
        capture_output=True, check=True,
    )


def test_crop_trims_to_last_event_plus_padding(tmp_path):
    _make_ogg(tmp_path / 'song.ogg', 10)  # 10s source
    (tmp_path / 'notes.chart').write_text(CHART)
    (tmp_path / 'song.ini').write_text('[song]\nname = X\n')

    # Last event tick 384 @120BPM/res192 = 1000 ms; +500 ms pad → ~1.5 s.
    res = crop_song_ogg(tmp_path, padding_ms=500)

    assert res['last_event_ms'] == 1000.0
    assert res['crop_ms'] == 1500.0
    assert 1.3 < res['duration_ms'] / 1000 < 1.7
    assert res['noop'] is False
    assert 'song_length = ' in (tmp_path / 'song.ini').read_text()


def test_crop_noop_when_source_already_shorter(tmp_path):
    _make_ogg(tmp_path / 'song.ogg', 1)  # 1s source, shorter than 1.5s target
    (tmp_path / 'notes.chart').write_text(CHART)
    (tmp_path / 'song.ini').write_text('[song]\nname = X\n')
    res = crop_song_ogg(tmp_path, padding_ms=500)
    assert res['noop'] is True


def test_crop_raises_when_no_events(tmp_path):
    _make_ogg(tmp_path / 'song.ogg', 5)
    (tmp_path / 'notes.chart').write_text('[Song]\n{\n  Resolution = 192\n}\n')
    (tmp_path / 'song.ini').write_text('[song]\nname = X\n')
    with pytest.raises(ValueError):
        crop_song_ogg(tmp_path, padding_ms=0)
