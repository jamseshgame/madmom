"""The publish merge keeps ONE [SyncTrack]; beatmaps generated with
different grid engines must be retimed onto it or they drift."""
from __future__ import annotations

from pathlib import Path

from app.services.chart_generator import merge_beatmap_charts, retime_section
from app.services.pipeline.evaluate import parse_chart


def _chart(sync_rows: list[str], notes: list[str], resolution: int = 192) -> str:
    sync = '\n'.join(f'  {r}' for r in sync_rows)
    body = '\n'.join(f'  {r}' for r in notes)
    return (f'[Song]\n{{\n  Resolution = {resolution}\n  Offset = 0\n}}\n'
            f'[SyncTrack]\n{{\n  0 = TS 4\n{sync}\n}}\n[Events]\n{{\n}}\n'
            f'[ExpertSingle]\n{{\n{body}\n}}\n')


def test_retime_section_preserves_wall_clock_times():
    # Source: constant 120 BPM. Destination: 120 for 4 beats, then 150.
    src_song, src_sync = '  Resolution = 192\n', '  0 = B 120000\n'
    dst_song, dst_sync = '  Resolution = 192\n', '  0 = B 120000\n  768 = B 150000\n'
    # Note at beat 8 (tick 1536 @120 = 4.0 s) with a one-beat sustain.
    body = '\n  1536 = N 2 192\n  1536 = E solo\n'
    out = retime_section(body, src_song, src_sync, dst_song, dst_sync)
    # On the destination map, 4.0 s = 768 ticks (2 s) + 2 s @150 BPM = 5 beats = 960 → 1728.
    assert '1728 = N 2 240' in out      # sustain 0.5 s @150 BPM = 240 ticks
    assert '1728 = E solo' in out
    # Identical maps → untouched.
    assert retime_section(body, src_song, src_sync, src_song, src_sync) == body


def test_merge_retimes_chart_with_different_synctrack(tmp_path: Path):
    # Guitar on the old constant grid, drums on a beat-anchored grid whose
    # real tempo drifts to 125 after bar 2. The same wall-clock hit (6.0 s)
    # is tick 2304 on the guitar map but a different tick on the drums map.
    guitar = _chart(['0 = B 120000'], ['0 = N 0 0', '2304 = N 1 0'])
    drums_sync = ['0 = B 120000', '1536 = B 125000']
    # 6.0 s on the drums map: 1536 ticks = 4 s, then 2 s @125 = 800 ticks → 2336.
    drums = _chart(drums_sync, ['0 = N 0 0', '2336 = N 1 0'])
    gp, dp = tmp_path / 'g.chart', tmp_path / 'd.chart'
    gp.write_text(guitar)
    dp.write_text(drums)
    out = tmp_path / 'merged.chart'
    res = merge_beatmap_charts(
        [(str(gp), 'guitar', {'preset': 'v1', 'beatmap_id': 'g', 'is_active': True}),
         (str(dp), 'drums', {'preset': 'drums-v3', 'beatmap_id': 'd', 'is_active': True})],
        str(out),
    )
    assert res['retimed'] == ['drums']
    merged = parse_chart(out.read_text())
    # One sync track (the guitar's), and the drums' second hit now lands at 6.0 s on it.
    assert merged.tempo == [{'tick': 0, 'micro_bpm': 120000}]
    drum_ticks = sorted(t for t, _n, _s in merged.sections['ExpertDrums'])
    assert drum_ticks == [0, 2304]
    assert abs(merged.seconds(drum_ticks[1]) - 6.0) < 0.005


def test_merge_leaves_matching_synctracks_alone(tmp_path: Path):
    a = _chart(['0 = B 120000', '768 = B 130000'], ['0 = N 0 0', '960 = N 2 96'])
    b = _chart(['0 = B 120000', '768 = B 130000'], ['0 = N 0 0', '960 = N 1 0'])
    ap, bp = tmp_path / 'a.chart', tmp_path / 'b.chart'
    ap.write_text(a)
    bp.write_text(b)
    out = tmp_path / 'm.chart'
    res = merge_beatmap_charts(
        [(str(ap), 'guitar', {'preset': 'x', 'beatmap_id': 'a', 'is_active': True}),
         (str(bp), 'drums', {'preset': 'y', 'beatmap_id': 'b', 'is_active': True})],
        str(out),
    )
    assert res['retimed'] == []
    text = out.read_text()
    assert '960 = N 2 96' in text and '960 = N 1 0' in text
