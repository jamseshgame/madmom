from __future__ import annotations

from app.services.calibration_metrics import build_tempo_map, tick_to_seconds


def test_build_tempo_map_reads_b_events_and_divides_by_1000():
    chart = '[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n  384 = B 240000\n}\n'
    assert build_tempo_map(chart) == [(0, 120.0), (384, 240.0)]


def test_build_tempo_map_defaults_to_120_at_zero_when_missing():
    assert build_tempo_map('[Song]\n{\n  Resolution = 192\n}\n') == [(0, 120.0)]


def test_build_tempo_map_prepends_zero_when_first_b_is_later():
    chart = '[SyncTrack]\n{\n  384 = B 90000\n}\n'
    assert build_tempo_map(chart) == [(0, 120.0), (384, 90.0)]


def test_tick_to_seconds_single_tempo():
    tm = [(0, 120.0)]
    assert tick_to_seconds(0, tm, 192) == 0.0
    assert tick_to_seconds(192, tm, 192) == 0.5   # 1 beat at 120bpm
    assert tick_to_seconds(384, tm, 192) == 1.0


def test_tick_to_seconds_tempo_change():
    tm = [(0, 120.0), (384, 240.0)]   # 2 beats @120 then 240
    # 384 ticks = 2 beats @120 = 1.0s; +192 ticks = 1 beat @240 = 0.25s
    assert tick_to_seconds(576, tm, 192) == 1.25
