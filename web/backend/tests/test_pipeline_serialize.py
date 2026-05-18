"""Tests for the S8 .chart serializer."""
from __future__ import annotations

from app.services.pipeline.serialize import serialize_chart


def test_serialize_basic_chart():
    grid = {
        'resolution': 192,
        'tempo_segments': [{'tick_start': 0, 'micro_bpm': 120000}],
        'time_sig_segments': [{'tick_start': 0, 'num': 4, 'denom_pow': 2}],
        'sections': [{'tick_start': 0, 'label': 'intro'}],
        'downbeats': [0, 768, 1536],
        'audio_duration_s': 10.0,
    }
    lanes_expert = {'lanes': [
        {'tick': 0, 'frets': [0], 'sustain': 0},
        {'tick': 192, 'frets': [2], 'sustain': 0},
        {'tick': 384, 'frets': [0, 1], 'sustain': 96},
    ]}
    chart_text = serialize_chart(
        grid=grid, lanes_per_difficulty={'ExpertSingle': lanes_expert},
        song_name='Test Song', resolution=192,
    )
    assert '[Song]' in chart_text
    assert 'Name = "Test Song"' in chart_text
    assert '[SyncTrack]' in chart_text
    assert '0 = B 120000' in chart_text
    assert '0 = TS 4' in chart_text
    assert '[Events]' in chart_text
    assert '0 = E "section intro"' in chart_text
    assert '[ExpertSingle]' in chart_text
    assert '0 = N 0 0' in chart_text
    assert '192 = N 2 0' in chart_text
    assert '384 = N 0 96' in chart_text
    assert '384 = N 1 96' in chart_text


def test_serialize_multi_tempo_segments():
    grid = {
        'resolution': 192,
        'tempo_segments': [
            {'tick_start': 0, 'micro_bpm': 120000},
            {'tick_start': 768, 'micro_bpm': 60000},
        ],
        'time_sig_segments': [{'tick_start': 0, 'num': 4, 'denom_pow': 2}],
        'sections': [{'tick_start': 0, 'label': 'song'}],
        'downbeats': [0],
        'audio_duration_s': 5.0,
    }
    chart_text = serialize_chart(grid=grid, lanes_per_difficulty={'ExpertSingle': {'lanes': []}},
                                 song_name='X', resolution=192)
    assert '0 = B 120000' in chart_text
    assert '768 = B 60000' in chart_text
