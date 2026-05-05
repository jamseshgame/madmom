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
