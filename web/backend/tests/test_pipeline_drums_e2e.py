"""End-to-end test of the drum column through the real stage runner:
synthetic kit → drum-bandsplit → drum-class → metric-weighted → drum-gm →
identity → drum-class-removal → serialize_chart(drums=True)."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from app.services.pipeline import engines  # noqa: F401  (registers engines)
from app.services.pipeline.beat_grid import beats_to_grid
from app.services.pipeline.registry import Stage
from app.services.pipeline.runner import run_stage
from app.services.pipeline.serialize import serialize_chart
from app.services.pipeline.storage import save_version_and_activate, stage_path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from synth_drums import render_pattern, rock_beat  # noqa: E402


def _noop(*a, **k):
    pass


def _write_wav(path: Path, y: np.ndarray, sr: int) -> None:
    from scipy.io import wavfile
    wavfile.write(str(path), sr, (y * 32767).astype(np.int16))


@pytest.fixture
def drum_track(tmp_path):
    bpm = 120.0
    hits = rock_beat(bars=4, bpm=bpm, start=0.5)
    y = render_pattern(hits, sr=22050)
    td = tmp_path / 'track'
    (td / 'stems').mkdir(parents=True)
    _write_wav(td / 'stems' / 'drums.wav', y, 22050)
    # Ground-truth grid from the known beats (the grid engines are tested separately).
    beats = 0.5 + np.arange(16) * 0.5
    grid = beats_to_grid(beats, audio_duration_s=len(y) / 22050)
    grid.update({'engine': 'test', 'params': {}, 'generated_at': 'now', 'detected_key': None})
    save_version_and_activate(td, Stage.GRID, None, grid)
    return td, hits, grid


def test_drum_column_end_to_end(drum_track):
    td, hits, grid = drum_track
    run_stage(Stage.ONSETS, td, 'drums', 'drum-bandsplit', {}, _noop)
    onsets = json.loads(stage_path(td, Stage.ONSETS, 'drums').read_text())
    assert 'drum_classes' in onsets and len(onsets['onsets']) > 20
    times = [o['time_s'] for o in onsets['onsets']]
    assert all(b > a for a, b in zip(times, times[1:]))  # OnsetList invariant

    run_stage(Stage.PITCHES, td, 'drums', 'drum-class', {}, _noop)
    pitches = json.loads(stage_path(td, Stage.PITCHES, 'drums').read_text())
    gm = {m for po in pitches['per_onset'] for m in po['all_pitches_midi']}
    assert {36, 38, 42} <= gm  # kick, snare, hat all present

    run_stage(Stage.QUANTIZED, td, 'drums', 'metric-weighted', {}, _noop)
    run_stage(Stage.LANES_EXPERT, td, 'drums', 'drum-gm', {}, _noop)
    lanes = json.loads(stage_path(td, Stage.LANES_EXPERT, 'drums').read_text())['lanes']
    by_lane = {}
    for ev in lanes:
        by_lane.setdefault(ev['frets'][0], []).append(ev['tick'])
    # Kicks on beats 1 & 3 of every bar: ticks 192 + 768*bar (+384) — lane 0 only.
    kick_ticks = {192 + 768 * b + off for b in range(4) for off in (0, 384)}
    assert kick_ticks <= set(by_lane[0])
    assert len(set(by_lane[0]) - kick_ticks) <= 1
    # Snares on beats 2 & 4 — lane 1.
    snare_ticks = {192 + 768 * b + off for b in range(4) for off in (192, 576)}
    assert snare_ticks <= set(by_lane[1])
    # Hi-hats on lane 2, lots of them; crash on lane 4 at the first downbeat.
    assert len(by_lane[2]) >= 15
    assert 192 in by_lane[4]
    # Simultaneous kick + hat on one tick survive as separate events (beat 3
    # of bar 1 — at the very first beat the crash takes the high band).
    assert 576 in by_lane[0] and 576 in by_lane[2]

    run_stage(Stage.LANES_FILTERED, td, 'drums', 'identity', {}, _noop)
    run_stage(Stage.LANES_HARD, td, 'drums', 'drum-class-removal', {}, _noop)
    easy = json.loads(stage_path(td, Stage.LANES_EASY, 'drums').read_text())['lanes']
    medium = json.loads(stage_path(td, Stage.LANES_MEDIUM, 'drums').read_text())['lanes']
    hard = json.loads(stage_path(td, Stage.LANES_HARD, 'drums').read_text())['lanes']
    assert len(easy) < len(medium) <= len(hard) <= len(lanes)
    assert {e['frets'][0] for e in easy} <= {0, 1, 4}      # kick/snare (+crash) only
    assert all(e['frets'][0] != 2 or e['tick'] % 96 == 0 for e in medium)  # 8th-note hats at most

    text = serialize_chart(
        grid=grid, song_name='t', resolution=192, drums=True,
        lanes_per_difficulty={'ExpertSingle': {'lanes': lanes}, 'EasySingle': {'lanes': easy}},
    )
    expert = text.split('[ExpertSingle]')[1].split('}')[0]
    assert '192 = N 0 0' in expert and '192 = N 4 0' in expert and '192 = N 68 0' in expert
    assert '576 = N 0 0' in expert and '576 = N 2 0' in expert and '576 = N 66 0' in expert
