"""Unit + integration tests for the vocals service."""
from __future__ import annotations

from app.services.vocals import syllabify, voicing_classify


def test_syllabify_three_word_english():
    words = [
        {"time_s": 1.0, "text": "Hello", "phrase_start": True},
        {"time_s": 1.5, "text": "wonderful"},
        {"time_s": 2.6, "text": "world", "phrase_end": True},
    ]
    sylls = syllabify(words, language="en")
    # "Hello" → "Hel-lo" (2), "wonderful" → "won-der-ful" (3), "world" → "world" (1)
    assert [s["text"] for s in sylls] == [
        "Hel", "lo", "won", "der", "ful", "world",
    ]
    # First and last syllables carry phrase boundaries
    assert sylls[0].get("phrase_start") is True
    assert sylls[-1].get("phrase_end") is True
    # Middle syllables don't
    assert "phrase_start" not in sylls[1]
    assert "phrase_end" not in sylls[-2]
    # Times are monotonically non-decreasing
    times = [s["time_s"] for s in sylls]
    assert times == sorted(times)


def test_syllabify_single_syllable_word():
    words = [{"time_s": 0.0, "text": "go", "phrase_start": True, "phrase_end": True}]
    sylls = syllabify(words, language="en")
    assert sylls == [{
        "time_s": 0.0,
        "duration_s": 0.0,
        "text": "go",
        "phrase_start": True,
        "phrase_end": True,
    }]


def test_syllabify_non_english_falls_back_to_per_word():
    words = [
        {"time_s": 0.0, "text": "bonjour", "phrase_start": True},
        {"time_s": 0.5, "text": "monde", "phrase_end": True},
    ]
    sylls = syllabify(words, language="fr")
    # Each word kept whole — no syllabifier for fr in v1
    assert [s["text"] for s in sylls] == ["bonjour", "monde"]
    assert sylls[0]["phrase_start"] is True
    assert sylls[-1]["phrase_end"] is True


def test_syllabify_distributes_word_duration_across_syllables():
    # Two-word lyric where each word has a known duration_s window.
    words = [
        {"time_s": 1.0, "duration_s": 1.0, "text": "Hello", "phrase_start": True, "phrase_end": True},
    ]
    sylls = syllabify(words, language="en")
    # "Hello" → "Hel" (3 chars) + "lo" (2 chars). Distribute by char count: 0.6s + 0.4s.
    assert len(sylls) == 2
    assert sylls[0]["text"] == "Hel"
    assert sylls[0]["time_s"] == 1.0
    assert abs(sylls[0]["duration_s"] - 0.6) < 0.01
    assert sylls[1]["text"] == "lo"
    assert abs(sylls[1]["time_s"] - 1.6) < 0.01
    assert abs(sylls[1]["duration_s"] - 0.4) < 0.01


def test_voicing_classify_sung_is_high_conf_steady_pitch():
    # High median confidence, low pitch std-dev → sung
    curve = [64.0, 64.1, 64.0, 63.9, 64.0]
    assert voicing_classify(curve, confidence=0.85, dynamics_db=[-15, -14, -13, -14, -15]) == "sung"


def test_voicing_classify_whispered_is_low_energy_low_conf():
    # Whisper has very low RMS, low confidence
    curve = [55.0, 56.0, 54.0, 55.5, 55.0]
    assert voicing_classify(curve, confidence=0.30, dynamics_db=[-45, -47, -44, -46, -45]) == "whispered"


def test_voicing_classify_spoken_is_mid_confidence():
    curve = [50.0, 52.0, 49.0, 51.0, 50.0]
    assert voicing_classify(curve, confidence=0.55, dynamics_db=[-22, -20, -23, -21, -22]) == "spoken"


def test_voicing_classify_high_conf_unsteady_pitch_is_spoken():
    # Confident but pitch jumps around → declamatory speech, not sung
    curve = [50.0, 60.0, 55.0, 65.0, 52.0]  # > 1.5 semitone std
    assert voicing_classify(curve, confidence=0.85, dynamics_db=[-20, -19, -20, -21, -20]) == "spoken"


import os
import math
import subprocess
import pytest
from pathlib import Path


@pytest.mark.skipif(
    os.environ.get('VOCALS_CREPE_SMOKE') != '1',
    reason='set VOCALS_CREPE_SMOKE=1 to run (downloads CREPE model)',
)
def test_crepe_detects_a440_within_one_semitone(tmp_path):
    """Generate a 2-second A4 (440 Hz) sine via ffmpeg, run detect_pitches,
    assert median MIDI pitch ~ 69 (A4). Smoke-only: gated to avoid the
    30 MB model download on every test run."""
    wav = tmp_path / "a440.wav"
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
         '-ac', '1', '-ar', '16000', '-loglevel', 'error', str(wav)],
        check=True,
    )
    from app.services.vocals import detect_pitches
    f0_hz, confidence = detect_pitches(wav)
    voiced = [f for f, c in zip(f0_hz, confidence) if not math.isnan(f) and c >= 0.5]
    assert len(voiced) > 0
    median_hz = sorted(voiced)[len(voiced) // 2]
    median_midi = 69 + 12 * math.log2(median_hz / 440.0)
    assert abs(median_midi - 69) < 1.0     # within 1 semitone


def test_build_vocal_notes_orchestrates_syllabify_and_pitch_alignment(monkeypatch, tmp_path):
    """Stub detect_pitches; assert build_vocal_notes assembles the right shape."""
    fake_audio = tmp_path / "vocals.wav"
    fake_audio.write_bytes(b"")  # not actually read since we stub detect_pitches

    # Fake CREPE output: 200 frames at 10 ms hop = 2.0 seconds, all A4 (440 Hz)
    n_frames = 200
    fake_f0 = [440.0] * n_frames
    fake_conf = [0.9] * n_frames

    from app.services import vocals as vocals_service
    monkeypatch.setattr(vocals_service, 'detect_pitches', lambda p: (fake_f0, fake_conf))

    # Lyrics: two LRClib-style words spanning 0..1.0 and 1.0..2.0
    lyrics = {
        "source": "lrclib",
        "language": "en",
        "words": [
            {"time_s": 0.0, "duration_s": 1.0, "text": "Hello", "phrase_start": True, "phrase_end": True},
            {"time_s": 1.0, "duration_s": 1.0, "text": "world", "phrase_start": True, "phrase_end": True},
        ],
    }

    notes = vocals_service.build_vocal_notes(fake_audio, lyrics)

    # Three syllables: "Hel", "lo", "world"
    assert len(notes["syllables"]) == 3
    assert [s["text"] for s in notes["syllables"]] == ["Hel", "lo", "world"]
    # All notes detect MIDI 69 (A4 = 440 Hz)
    assert all(s["midi_pitch"] == 69 for s in notes["syllables"])
    # All sung (high confidence, steady pitch)
    assert all(s["voicing"] == "sung" for s in notes["syllables"])
    # Phrase boundaries preserved
    assert notes["syllables"][0]["phrase_start"] is True
    assert notes["syllables"][1].get("phrase_start") is None or notes["syllables"][1].get("phrase_start") is not True
    assert notes["syllables"][-1].get("phrase_end") is True
    # Top-level metadata
    assert notes["version"] == 1
    assert notes["pitch_model"] == "torchcrepe-full"
    assert notes["syllabified_from"] == "lrclib"
    assert notes["syllabifier"] == "ssp-en"
    assert notes["frame_hop_s"] == 0.010
    assert "lyrics_etag" in notes


def test_write_then_load_vocal_notes(tmp_path):
    from app.services.vocals import write_vocal_notes, load_vocal_notes
    notes = {
        "version": 1, "syllabified_from": "lrclib",
        "pitch_model": "torchcrepe-full", "frame_hop_s": 0.010,
        "syllables": [
            {"time_s": 1.0, "duration_s": 0.3, "text": "Hi",
             "midi_pitch": 60, "confidence": 0.9, "voicing": "sung",
             "pitch_curve_st": [60.0], "dynamics_db": [-15.0]},
        ],
    }
    path = write_vocal_notes(tmp_path, notes)
    assert path == tmp_path / "vocal_notes.json"
    assert load_vocal_notes(tmp_path) == notes


def test_load_vocal_notes_missing(tmp_path):
    from app.services.vocals import load_vocal_notes
    assert load_vocal_notes(tmp_path) is None
