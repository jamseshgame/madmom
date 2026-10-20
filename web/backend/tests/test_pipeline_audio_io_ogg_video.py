"""Regression: an .ogg carrying a Theora (video / cover-art) stream before
the Vorbis stream — what `stems._convert_to_ogg` produced without `-vn` from
an mp3 with embedded artwork or a YouTube pull — makes libsndfile raise
"File contains data in an unimplemented format". The pipeline's loader must
fall through to ffmpeg, and the converter must no longer write such files."""
from __future__ import annotations

import asyncio
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from app.services.pipeline.audio_io import load_audio
from app.services.pipeline.grid_support import audio_duration_s


def _ffmpeg_has(*encoders: str) -> bool:
    if shutil.which('ffmpeg') is None or shutil.which('ffprobe') is None:
        return False
    out = subprocess.run(['ffmpeg', '-v', 'error', '-encoders'], capture_output=True, text=True).stdout
    return all(e in out for e in encoders)


def _duration(path: Path) -> float:
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)],
        capture_output=True, text=True,
    ).stdout.strip()
    return float(out)


def _streams(path: Path) -> list[str]:
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', str(path)],
        capture_output=True, text=True,
    ).stdout
    return [ln.strip() for ln in out.splitlines() if ln.strip()]


@pytest.fixture
def cover_art_mp3(tmp_path: Path) -> Path:
    if not _ffmpeg_has('libmp3lame', 'libvorbis', 'libtheora'):
        pytest.skip('ffmpeg without libmp3lame/libvorbis/libtheora')
    mp3 = tmp_path / 'master.mp3'
    subprocess.run(
        ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
         '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=2:r=1', '-map', '0:a', '-map', '1:v',
         '-c:a', 'libmp3lame', '-c:v', 'mjpeg', '-frames:v', '1', '-disposition:v', 'attached_pic',
         '-id3v2_version', '3', str(mp3)],
        check=True,
    )
    assert 'video' in _streams(mp3)
    return mp3


@pytest.fixture
def broken_ogg(cover_art_mp3: Path, tmp_path: Path) -> Path:
    """What the old converter wrote: Theora + Vorbis in one .ogg."""
    ogg = tmp_path / 'song.ogg'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(cover_art_mp3),
                    '-c:a', 'libvorbis', '-q:a', '6', str(ogg)], check=True)
    assert _streams(ogg)[0] == 'video'
    return ogg


def test_load_audio_decodes_ogg_with_video_stream(broken_ogg: Path):
    y, sr = load_audio(broken_ogg, target_sr=22050, mono=True)
    assert sr == 22050
    assert abs(len(y) / sr - _duration(broken_ogg)) < 0.1
    assert np.abs(y).max() > 0.1  # real samples, not silence


def test_audio_duration_handles_ogg_with_video_stream(broken_ogg: Path):
    assert abs(audio_duration_s(broken_ogg) - _duration(broken_ogg)) < 0.05


def test_stems_converter_strips_video_and_artwork(cover_art_mp3: Path, tmp_path: Path):
    from app.services.stems import _convert_to_ogg
    dst = tmp_path / 'clean.ogg'
    asyncio.run(_convert_to_ogg(cover_art_mp3, dst))
    assert _streams(dst) == ['audio']
    # And libsndfile-based readers now accept it.
    try:
        import soundfile as sf
    except ImportError:
        return
    assert sf.info(str(dst)).samplerate > 0
