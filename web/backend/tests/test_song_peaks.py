"""Tests for the audio-peaks helper used by the WaveformStrip endpoint."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import scipy.io.wavfile as wav
from fastapi.testclient import TestClient

from app.main import app
from app.services import tracks as tracks_service
from app.services.audio import compute_audio_peaks


def _write_wav(path: Path, samples: np.ndarray, sample_rate: int = 44100) -> None:
    """Write a mono int16 wav. Samples are float32 in [-1, 1]; we scale
    to int16 for a lossless round-trip through madmom's loader."""
    int16 = np.clip(samples, -1.0, 1.0)
    int16 = (int16 * 32767.0).astype(np.int16)
    wav.write(str(path), sample_rate, int16)


def test_silent_audio_peaks_are_zero(tmp_path):
    """1 s of literal silence → ~50 buckets at 20 ms each, all zero."""
    audio = tmp_path / 'silent.wav'
    _write_wav(audio, np.zeros(44100, dtype=np.float32))
    blob = compute_audio_peaks(audio, bucket_ms=20)
    peaks = np.frombuffer(blob, dtype=np.float32)
    assert 49 <= len(peaks) <= 51
    assert peaks.max() == 0.0


def test_peaks_track_amplitude(tmp_path):
    """A pure 1 kHz sine at peak amplitude 0.5 should produce per-bucket
    peaks at ~0.5. Lossless wav → peaks land within int16 quantization
    tolerance of the input level."""
    sr = 44100
    t = np.arange(sr) / sr
    sine = (0.5 * np.sin(2 * np.pi * 1000 * t)).astype(np.float32)
    audio = tmp_path / 'tone.wav'
    _write_wav(audio, sine, sample_rate=sr)
    blob = compute_audio_peaks(audio, bucket_ms=20)
    peaks = np.frombuffer(blob, dtype=np.float32)
    assert 49 <= len(peaks) <= 51
    # 1 kHz period (1 ms) << 20 ms bucket → every bucket contains many
    # full cycles, so peak per bucket = sine peak. Tolerance covers
    # int16 quantization (~3e-5 absolute error).
    assert 0.495 <= peaks.mean() <= 0.505
    assert 0.495 <= peaks.min() <= peaks.max() <= 0.505


def test_compute_raises_on_missing_file(tmp_path):
    with pytest.raises(Exception):
        compute_audio_peaks(tmp_path / 'does-not-exist.wav', bucket_ms=20)


@pytest.fixture
def authed_client():
    c = TestClient(app)
    r = c.post('/api/auth/login', data={'username': 'admin', 'password': 'SlayTheStage'})
    assert r.status_code == 200
    return c


def test_beatmap_song_peaks_endpoint_returns_binary(tmp_path, monkeypatch, authed_client):
    """Per-beatmap endpoint serves the registered beatmap's song.ogg peaks."""
    monkeypatch.setattr(tracks_service, 'TRACKS_DIR', tmp_path / '_tracks')
    audio = tmp_path / 'src.wav'
    _write_wav(audio, np.zeros(44100, dtype=np.float32))
    track = tracks_service.create_track(
        name='per-bm-peaks', stems={'song': 'song.ogg'},
        source_stems_dir=tmp_path, model='manual', output_format='ogg',
    )
    bm_id = 'beatmap_x'
    bm_src = tmp_path / 'bm_src'
    bm_src.mkdir()
    (bm_src / 'song.ogg').write_bytes(audio.read_bytes())
    tracks_service.add_beatmap_record(
        track_id=track.id, beatmap_id=bm_id, stem='song',
        folder_name='X', song_name='X', source_dir=bm_src,
    )

    r = authed_client.get(f'/api/tracks/{track.id}/beatmaps/{bm_id}/song-peaks')
    assert r.status_code == 200
    assert r.headers['content-type'] == 'application/octet-stream'
    peaks = np.frombuffer(r.content, dtype=np.float32)
    assert 49 <= len(peaks) <= 51
    cache = (track.beatmaps_dir / bm_id) / 'song.peaks.f32'
    assert cache.exists()
    assert cache.read_bytes() == r.content


def test_beatmap_song_peaks_404_for_missing_audio(tmp_path, monkeypatch, authed_client):
    monkeypatch.setattr(tracks_service, 'TRACKS_DIR', tmp_path / '_tracks')
    track = tracks_service.create_track(
        name='no-audio', stems={'song': 'song.ogg'},
        source_stems_dir=tmp_path, model='manual', output_format='ogg',
    )
    r = authed_client.get(f'/api/tracks/{track.id}/beatmaps/missing/song-peaks')
    assert r.status_code == 404


def test_beatmap_song_peaks_recomputes_when_audio_newer(tmp_path, monkeypatch, authed_client):
    """Cache is invalidated when song.ogg mtime is newer than the .peaks.f32 cache."""
    import os
    monkeypatch.setattr(tracks_service, 'TRACKS_DIR', tmp_path / '_tracks')
    audio = tmp_path / 'src.wav'
    _write_wav(audio, np.zeros(44100, dtype=np.float32))
    track = tracks_service.create_track(
        name='cache-bm', stems={'song': 'song.ogg'},
        source_stems_dir=tmp_path, model='manual', output_format='ogg',
    )
    bm_id = 'bm1'
    bm_src = tmp_path / 'bm_src'
    bm_src.mkdir()
    (bm_src / 'song.ogg').write_bytes(audio.read_bytes())
    tracks_service.add_beatmap_record(
        track_id=track.id, beatmap_id=bm_id, stem='song',
        folder_name='X', song_name='X', source_dir=bm_src,
    )

    # Prime the cache with a known-bad-content sentinel by overwriting
    # after first request.
    r1 = authed_client.get(f'/api/tracks/{track.id}/beatmaps/{bm_id}/song-peaks')
    assert r1.status_code == 200
    cache_path = track.beatmaps_dir / bm_id / 'song.peaks.f32'
    audio_path = track.beatmaps_dir / bm_id / 'song.ogg'

    # Stamp audio newer than cache, then write garbage to cache so we can
    # detect whether the endpoint served the cache (would return garbage)
    # or recomputed (would return real peaks).
    cache_path.write_bytes(b'\x00' * 16)
    new_mtime = cache_path.stat().st_mtime + 5
    os.utime(audio_path, (new_mtime, new_mtime))

    r2 = authed_client.get(f'/api/tracks/{track.id}/beatmaps/{bm_id}/song-peaks')
    assert r2.status_code == 200
    # Recomputed → not the 16-byte garbage we wrote
    assert len(r2.content) > 16
