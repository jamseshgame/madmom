from __future__ import annotations

from app.services.calibration_metrics import build_tempo_map, tick_to_seconds
from app.services.calibration_metrics import GemTick, parse_gem_ticks, section_metrics


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


def test_parse_gem_ticks_groups_chord_and_marks_slide():
    body = '\n'.join([
        '  0 = N 0 0',
        '  0 = N 1 0',          # chord at tick 0 (frets 0,1)
        '  192 = N 2 96',       # hold at tick 192
        '  384 = E slide 3',    # slide-start (no N)
        '  384 = N 5 0',        # modifier fret ignored
    ])
    gems = parse_gem_ticks(body)
    assert gems[0] == GemTick(tick=0, frets=(0, 1), max_sustain=0, is_slide=False)
    assert gems[1] == GemTick(tick=192, frets=(2,), max_sustain=96, is_slide=False)
    assert gems[2] == GemTick(tick=384, frets=(3,), max_sustain=0, is_slide=True)


def test_section_metrics_counts_and_timing():
    # tick 0 chord(0,1); 192 single hold(2); 384 single(0); resolution 192 @120bpm
    body = '\n'.join([
        '  0 = N 0 0',
        '  0 = N 1 0',
        '  192 = N 2 96',
        '  384 = N 0 0',
    ])
    tm = [(0, 120.0)]
    m = section_metrics(body, 192, tm)
    assert m['total_gems'] == 4          # chord = 2 gems + 2 singles
    assert m['total_notes'] == 3         # 3 note-groups
    assert m['total_chords'] == 1
    assert m['total_holds'] == 1
    assert m['distinct_lanes'] == 3      # frets 0,1,2
    assert m['lane_lo'] == 0 and m['lane_hi'] == 2
    assert m['avg_chord_size'] == 2.0
    # duration = end of last note-group. tick 384 = 1.0s
    assert m['duration_s'] == 1.0
    assert m['gems_per_min'] == 240.0    # 4 gems / (1.0/60)


def test_section_metrics_returns_none_when_empty():
    assert section_metrics('\n  \n', 192, [(0, 120.0)]) is None


def test_section_metrics_min_gap_and_runs():
    # four 16th notes @120bpm: gap = 0.125s each (resolution/4 ticks = 48)
    body = '\n'.join(f'  {t} = N 0 0' for t in (0, 48, 96, 144))
    m = section_metrics(body, 192, [(0, 120.0)])
    assert round(m['min_gap_s'], 3) == 0.125
    assert m['longest_run'] == 4         # all gaps <= FAST_GAP_S (0.25)


def test_summarize_rows_groups_by_tier_and_computes_quartiles():
    from app.services.calibration_metrics import summarize_rows

    rows = [
        {'difficulty': 'Expert', 'gems_per_min': 100.0, 'min_gap_s': None},
        {'difficulty': 'Expert', 'gems_per_min': 200.0, 'min_gap_s': 0.2},
        {'difficulty': 'Expert', 'gems_per_min': 300.0, 'min_gap_s': 0.4},
        {'difficulty': 'Easy', 'gems_per_min': 50.0, 'min_gap_s': 1.0},
    ]
    s = summarize_rows(rows)
    assert s['Expert']['gems_per_min']['min'] == 100.0
    assert s['Expert']['gems_per_min']['max'] == 300.0
    assert s['Expert']['gems_per_min']['median'] == 200.0
    assert s['Expert']['gems_per_min']['mean'] == 200.0
    assert s['Expert']['gems_per_min']['count'] == 3
    # None values are skipped: only 2 of 3 Expert rows have min_gap_s
    assert s['Expert']['min_gap_s']['count'] == 2
    assert s['Easy']['gems_per_min']['count'] == 1
