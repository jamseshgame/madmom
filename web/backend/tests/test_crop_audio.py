from __future__ import annotations

from app.services.crop_audio import last_event_tick, tick_to_ms, update_song_length

CHART = """[Song]
{
  Name = "X"
  Resolution = 192
}
[SyncTrack]
{
  0 = TS 4
  0 = B 120000
}
[Events]
{
  768 = E "section intro"
}
[ExpertSingle]
{
  0 = N 0 0
  384 = N 1 96
  1920 = N 2 0
}
[HardSingle]
{
  0 = N 0 0
  2304 = N 0 0
}
"""


def test_last_event_tick_takes_max_across_sections_and_sustains():
    # HardSingle 2304 is the latest start; ExpertSingle 384+96 sustain = 480.
    assert last_event_tick(CHART) == 2304


def test_last_event_tick_includes_sustain_tail():
    chart = '[ExpertSingle]\n{\n  100 = N 0 500\n  200 = N 1 0\n}\n'
    assert last_event_tick(chart) == 600  # 100 + 500 sustain tail


def test_last_event_tick_ignores_non_integer_lhs():
    # Resolution/Name lines must not be parsed as ticks.
    chart = '[Song]\n{\n  Resolution = 192\n  Name = "Y"\n}\n'
    assert last_event_tick(chart) == 0


def test_tick_to_ms_single_tempo():
    # 120 BPM, resolution 192 → 1 beat (192 ticks) = 500 ms.
    assert tick_to_ms(CHART, 192) == 500.0
    assert tick_to_ms(CHART, 384) == 1000.0


def test_tick_to_ms_multi_tempo():
    chart = (
        '[Song]\n{\n  Resolution = 192\n}\n'
        '[SyncTrack]\n{\n  0 = B 120000\n  192 = B 240000\n}\n'
    )
    # First beat at 120 BPM = 500 ms; second beat at 240 BPM = 250 ms.
    assert tick_to_ms(chart, 384) == 750.0


def test_update_song_length_replaces_existing():
    ini = '[song]\nname = X\nsong_length = 99\nartist = Y\n'
    out = update_song_length(ini, 18000)
    assert 'song_length = 18000' in out
    assert 'song_length = 99' not in out


def test_update_song_length_inserts_when_absent():
    ini = '[song]\nname = X\nartist = Y\n'
    out = update_song_length(ini, 18000)
    assert 'song_length = 18000' in out
    assert out.index('[song]') < out.index('song_length = 18000')
