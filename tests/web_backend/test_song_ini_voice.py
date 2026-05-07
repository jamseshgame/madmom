"""Tests for elevenlabs_voice_id read/write in song.ini."""
from __future__ import annotations

from pathlib import Path

import pytest

from web.backend.app.services import tracks as tracks_svc


@pytest.fixture
def beatmap_dir(tmp_path, monkeypatch):
    """Return a fake beatmap dir with a starter song.ini, and stub the
    track/beatmap resolver so the helpers under test find it."""
    bm = tmp_path / 'beatmap'
    bm.mkdir()
    (bm / 'song.ini').write_text(
        '[song]\nname = Test\nartist = Foo\n', encoding='utf-8',
    )
    monkeypatch.setattr(tracks_svc, 'get_beatmap_dir', lambda t, b: bm)
    return bm


def test_read_returns_empty_when_key_missing(beatmap_dir):
    assert tracks_svc.read_elevenlabs_voice('t', 'b') == ''


def test_write_appends_then_read_returns_value(beatmap_dir):
    tracks_svc.write_elevenlabs_voice('t', 'b', 'voice_abc')
    assert tracks_svc.read_elevenlabs_voice('t', 'b') == 'voice_abc'
    body = (beatmap_dir / 'song.ini').read_text(encoding='utf-8')
    assert 'elevenlabs_voice_id = voice_abc' in body
    # Existing keys are preserved
    assert 'name = Test' in body
    assert 'artist = Foo' in body


def test_write_rewrites_existing_value(beatmap_dir):
    (beatmap_dir / 'song.ini').write_text(
        '[song]\nname = Test\nelevenlabs_voice_id = old\n', encoding='utf-8',
    )
    tracks_svc.write_elevenlabs_voice('t', 'b', 'new')
    assert tracks_svc.read_elevenlabs_voice('t', 'b') == 'new'
    body = (beatmap_dir / 'song.ini').read_text(encoding='utf-8')
    assert body.count('elevenlabs_voice_id') == 1
