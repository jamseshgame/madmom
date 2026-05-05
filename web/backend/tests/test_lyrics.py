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
