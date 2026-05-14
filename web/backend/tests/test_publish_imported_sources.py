"""Tests for the publish-time imported-sources copy + orphan-MusicSeg strip."""
from __future__ import annotations

from pathlib import Path

from app.routers.tracks import _strip_orphan_musicsegs, _parse_imported_sources_section


CHART = """\
[Song]
{
  Resolution = 192
}
[ImportedSources]
{
  src_a = track="trk1" beatmap="bm1" name="Crashing Down"
  src_b = track="trk2" beatmap="bm2" name="Stairway"
}
[ExpertSingle]
{
  100 = N 0 0
}
[TutorialScript]
{
  192 = MUSIC source="src_a" stem="song" section="MusicSeg_used" start_ms=0 duration_ms=1000 bpm=120.00 resolution=192 duration=1.00 notes=2 required=2 timing=any
}
[MusicSeg_used]
{
  ; source="src_a" start_sec=0.000 end_sec=1.000 name="placed"
  0 = N 0 0
}
[MusicSeg_orphan]
{
  ; source="src_b" start_sec=10.000 end_sec=20.000 name="library only"
  0 = N 0 0
}
"""


def test_parse_imported_sources_returns_dict():
    sources = _parse_imported_sources_section(CHART)
    assert sources == {
        'src_a': {'track': 'trk1', 'beatmap': 'bm1', 'name': 'Crashing Down'},
        'src_b': {'track': 'trk2', 'beatmap': 'bm2', 'name': 'Stairway'},
    }


def test_orphan_section_dropped():
    out = _strip_orphan_musicsegs(CHART)
    assert '[MusicSeg_used]' in out
    assert '[MusicSeg_orphan]' not in out
    assert 'source="src_a"' in out


def test_imported_sources_section_can_be_stripped():
    """Helper exists to drop the [ImportedSources] section before publish."""
    from app.routers.tracks import _strip_imported_sources_section
    out = _strip_imported_sources_section(CHART)
    assert '[ImportedSources]' not in out
    # MUSIC events still reference src_a — runtime resolves to sources/src_a/song.ogg
    assert 'source="src_a"' in out
