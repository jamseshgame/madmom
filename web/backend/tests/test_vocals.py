"""Unit + integration tests for the vocals service."""
from __future__ import annotations

from app.services.vocals import syllabify


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
