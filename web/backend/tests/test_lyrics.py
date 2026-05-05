"""Unit tests for the lyrics service."""
from __future__ import annotations

from app.services.lyrics import parse_lrc


def test_parse_lrc_basic():
    text = "[00:12.34]Hello world\n[00:14.50]Foo bar baz\n"
    assert parse_lrc(text) == [
        (12.34, "Hello world"),
        (14.50, "Foo bar baz"),
    ]


def test_parse_lrc_three_digit_ms():
    text = "[00:12.345]One\n[00:13.000]Two\n"
    assert parse_lrc(text) == [(12.345, "One"), (13.0, "Two")]


def test_parse_lrc_skips_blank_and_header_lines():
    text = (
        "[ar:Some Artist]\n"
        "[ti:Some Title]\n"
        "\n"
        "[00:01.00]Real line\n"
    )
    assert parse_lrc(text) == [(1.0, "Real line")]


def test_parse_lrc_repeated_timestamps_on_one_line():
    # LRC can label the same line for repeated choruses
    text = "[00:30.00][01:00.00]Chorus line\n"
    assert parse_lrc(text) == [(30.0, "Chorus line"), (60.0, "Chorus line")]


def test_parse_lrc_drops_lines_without_timestamps():
    text = "Free text without timing\n[00:05.00]Timed line\n"
    assert parse_lrc(text) == [(5.0, "Timed line")]


def test_parse_lrc_empty_input():
    assert parse_lrc("") == []


from app.services.lyrics import interpolate_words


def _approx(a: float, b: float, tol: float = 0.01) -> bool:
    return abs(a - b) <= tol


def test_interpolate_three_word_line():
    # "Hello world tonight" → 5 + 5 + 7 = 17 chars → cumulative ratios
    words = interpolate_words("Hello world tonight", line_start=10.0, line_end=13.4)
    assert [w["text"] for w in words] == ["Hello", "world", "tonight"]
    assert _approx(words[0]["time_s"], 10.0)
    # Second word starts after 5/17 of 3.4s = 1.0s
    assert _approx(words[1]["time_s"], 11.0)
    # Third word starts after 10/17 of 3.4s = 2.0s
    assert _approx(words[2]["time_s"], 12.0)
    assert words[0]["phrase_start"] is True
    assert words[-1]["phrase_end"] is True


def test_interpolate_single_word_line():
    words = interpolate_words("Yeah", line_start=4.0, line_end=5.0)
    assert words == [{
        "time_s": 4.0,
        "text": "Yeah",
        "phrase_start": True,
        "phrase_end": True,
    }]


def test_interpolate_empty_line():
    assert interpolate_words("   ", line_start=1.0, line_end=2.0) == []


def test_interpolate_zero_duration_falls_back_to_line_start():
    words = interpolate_words("a b c", line_start=2.0, line_end=2.0)
    # All three words pinned to line_start; phrase_start/end on first/last
    assert all(_approx(w["time_s"], 2.0) for w in words)
    assert words[0]["phrase_start"] is True
    assert words[-1]["phrase_end"] is True
