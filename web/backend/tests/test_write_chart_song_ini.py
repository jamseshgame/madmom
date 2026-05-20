"""Unit test for the extracted write_chart_song_ini helper. Round-trips a
captured notes.chart through the helper and asserts the produced
song.ini contains the expected sections."""
from __future__ import annotations

from pathlib import Path

import pytest

from app.services.chart_generator import write_chart_song_ini


SAMPLE_CHART = """[Song]
{
  Resolution = 192
}
[SyncTrack]
{
  0 = TS 4
  0 = B 120000
}
[Events]
{
}
[ExpertSingle]
{
  0 = N 0 0
  192 = N 1 0
}
"""


def test_write_chart_song_ini_writes_metadata_and_stats(tmp_path):
    chart_path = tmp_path / 'notes.chart'
    chart_path.write_text(SAMPLE_CHART)

    ini_path = write_chart_song_ini(
        out_dir=tmp_path,
        chart_path=str(chart_path),
        song_name='Hello',
        artist='World',
        album='Test',
        genre='Rock',
        year='2026',
        ini_overrides={'charter': 'Tester', 'diff_guitar': 4},
    )

    text = Path(ini_path).read_text()
    assert '[song]' in text
    assert 'name = Hello' in text
    assert 'artist = World' in text
    assert 'charter = Tester' in text
    assert 'diff_guitar = 4' in text
    # stats section emitted for the difficulty present in the chart
    assert '[expert_stats]' in text
    assert 'total_events = 2' in text


def test_write_chart_song_ini_uses_defaults_for_missing_overrides(tmp_path):
    chart_path = tmp_path / 'notes.chart'
    chart_path.write_text(SAMPLE_CHART)

    ini_path = write_chart_song_ini(
        out_dir=tmp_path,
        chart_path=str(chart_path),
        song_name='X',
        artist='Y',
        album='Z',
        genre='G',
        year='',
        ini_overrides=None,
    )
    text = Path(ini_path).read_text()
    assert 'charter = Jamsesh' in text
    assert 'diff_guitar = -1' in text
