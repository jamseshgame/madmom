"""Verify chart serializer emits all four difficulty sections when present."""
from __future__ import annotations

from app.services.pipeline.serialize import serialize_chart


def test_all_four_sections_present():
    grid = {
        'resolution': 192,
        'tempo_segments': [{'tick_start': 0, 'micro_bpm': 120000}],
        'time_sig_segments': [{'tick_start': 0, 'num': 4, 'denom_pow': 2}],
        'sections': [{'tick_start': 0, 'label': 'song'}],
        'downbeats': [0],
        'audio_duration_s': 5.0,
    }
    lanes = {'lanes': [{'tick': 0, 'frets': [0], 'sustain': 0}]}
    text = serialize_chart(
        grid=grid,
        lanes_per_difficulty={
            'ExpertSingle': lanes, 'HardSingle': lanes,
            'MediumSingle': lanes, 'EasySingle': lanes,
        },
        song_name='X', resolution=192,
    )
    for section in ('[ExpertSingle]', '[HardSingle]', '[MediumSingle]', '[EasySingle]'):
        assert section in text
