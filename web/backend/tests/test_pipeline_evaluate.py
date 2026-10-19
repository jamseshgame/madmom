"""Tests for the chart evaluation harness."""
from __future__ import annotations

from app.services.pipeline.evaluate import (
    drum_rows_to_lanes, evaluate_charts, format_report, match_times, parse_chart, self_consistency,
)


def _chart(section: str, rows: list[str], bpm: int = 120000) -> str:
    body = '\n'.join(f'  {r}' for r in rows)
    return (
        '[Song]\n{\n  Resolution = 192\n}\n'
        f'[SyncTrack]\n{{\n  0 = TS 4\n  0 = B {bpm}\n}}\n'
        '[Events]\n{\n}\n'
        f'[{section}]\n{{\n{body}\n}}\n'
    )


def test_parse_chart_reads_resolution_tempo_and_notes():
    c = parse_chart(_chart('ExpertSingle', ['0 = N 0 0', '192 = N 2 96', '192 = N 3 96']))
    assert c.resolution == 192 and c.tempo == [{'tick': 0, 'micro_bpm': 120000}]
    assert c.sections['ExpertSingle'] == [(0, 0, 0), (192, 2, 96), (192, 3, 96)]
    assert abs(c.seconds(192) - 0.5) < 1e-9


def test_drum_rows_to_lanes_uses_cymbal_modifiers():
    lanes = drum_rows_to_lanes([(0, 2, 0), (0, 66, 0), (96, 2, 0), (192, 4, 0), (192, 68, 0), (288, 4, 0), (288, 0, 0)])
    assert lanes[0] == {2} and lanes[96] == {3} and lanes[192] == {4} and lanes[288] == {0, 3}


def test_match_times_is_one_to_one_within_tolerance():
    assert match_times([0.0, 1.0, 2.0], [0.02, 0.03, 2.1], 0.05) == [(0, 0)]
    assert match_times([0.0, 1.0], [1.01, 0.01], 0.05) == [(0, 1), (1, 0)]


def test_self_consistency_scores_repeated_bars():
    bar = 768
    notes = [(0, (0,)), (192, (1,)), (384, (2,)), (576, (3,))]
    same = [(t + bar, l) for t, l in notes]
    different = [(t + 2 * bar, ((l[0] + 1) % 5,)) for t, l in notes]
    assert self_consistency(notes + same + different, bar) == 0.5
    assert self_consistency(notes, bar) is None


def test_evaluate_guitar_perfect_match():
    rows = ['0 = N 0 0', '192 = N 1 0', '384 = N 2 96', '576 = N 1 0']
    ref = _chart('ExpertSingle', rows)
    res = evaluate_charts(ref, ref)
    exp = res['difficulties']['Expert']
    assert exp['onsets']['f1'] == 1.0 and exp['contour_agreement'] == 1.0 and exp['exact_lane_accuracy'] == 1.0
    assert exp['sustain_rate'] == {'reference': 0.25, 'candidate': 0.25}
    assert res['summary']['expert_onset_f1'] == 1.0
    assert 'Expert' in format_report(res)


def test_evaluate_guitar_detects_timing_and_contour_errors():
    ref = _chart('ExpertSingle', ['0 = N 0 0', '192 = N 1 0', '384 = N 2 0', '576 = N 3 0'])
    # Candidate: same first three notes but mirrored lanes (down instead of up), last one 100 ms late.
    cand = _chart('ExpertSingle', ['0 = N 4 0', '192 = N 3 0', '384 = N 2 0', '615 = N 1 0'])
    exp = evaluate_charts(ref, cand)['difficulties']['Expert']
    assert exp['onsets']['recall'] == 0.75 and exp['onsets']['precision'] == 0.75
    assert exp['contour_agreement'] == 0.0


def test_evaluate_drums_per_lane():
    ref = _chart('ExpertDrums', ['0 = N 0 0', '0 = N 2 0', '0 = N 66 0', '192 = N 1 0', '384 = N 0 0', '576 = N 1 0'])
    # Candidate hats read as toms (no modifier) and misses the second kick.
    cand = _chart('ExpertDrums', ['0 = N 0 0', '0 = N 2 0', '192 = N 1 0', '576 = N 1 0'])
    exp = evaluate_charts(ref, cand)['difficulties']['Expert']
    assert exp['drums'] is True
    assert exp['lanes']['kick']['recall'] == 0.5 and exp['lanes']['snare']['f1'] == 1.0
    assert exp['lanes']['hihat']['recall'] == 0.0 and exp['lanes']['tom']['precision'] == 0.0
    assert abs(exp['lane_set_accuracy'] - 2 / 3) < 1e-3


def test_evaluate_matches_sections_across_single_and_drums_names():
    ref = _chart('ExpertDrums', ['0 = N 0 0', '192 = N 1 0'])
    cand = _chart('ExpertDrums2', ['0 = N 0 0', '192 = N 1 0'])
    res = evaluate_charts(ref, cand)
    assert res['difficulties']['Expert']['onsets']['f1'] == 1.0
