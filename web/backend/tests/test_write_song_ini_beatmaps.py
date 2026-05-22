"""Unit tests for the new `beatmaps` parameter on stems.write_song_ini.

Each test calls write_song_ini with a synthetic fields dict + a beatmaps
list, then asserts on the resulting song.ini text (read back from disk).
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.services.stems import write_song_ini


MINIMAL_FIELDS = {'name': 'Test', 'artist': 'Foo', 'album': 'Bar', 'genre': 'Rock', 'year': '2026'}


def _read(tmp_path: Path) -> str:
    return (tmp_path / 'song.ini').read_text(encoding='utf-8')


def test_no_beatmaps_arg_is_unchanged(tmp_path):
    """Regression — passing beatmaps=None must produce the same output as today."""
    write_song_ini(tmp_path, MINIMAL_FIELDS)
    expected = _read(tmp_path)

    write_song_ini(tmp_path, MINIMAL_FIELDS, beatmaps=None)
    assert _read(tmp_path) == expected


def test_empty_beatmaps_list_is_unchanged(tmp_path):
    write_song_ini(tmp_path, MINIMAL_FIELDS)
    expected = _read(tmp_path)

    write_song_ini(tmp_path, MINIMAL_FIELDS, beatmaps=[])
    assert _read(tmp_path) == expected


def test_single_beatmap_emits_block(tmp_path):
    bm = {
        'id': '4d038f0672dc',
        'name': 'V1 — Defaults',
        'preset': 'v1',
        'stem': 'guitar',
        'is_active': True,
        'sections': ['ExpertSingle', 'HardSingle', 'MediumSingle', 'EasySingle'],
    }
    write_song_ini(tmp_path, MINIMAL_FIELDS, beatmaps=[bm])
    text = _read(tmp_path)

    assert '[beatmap_1]' in text
    assert 'id = 4d038f0672dc' in text
    assert 'name = V1 — Defaults' in text
    assert 'preset = v1' in text
    assert 'stem = guitar' in text
    assert 'is_active = true' in text
    assert 'sections = ExpertSingle,HardSingle,MediumSingle,EasySingle' in text


def test_two_beatmaps_numbered_sequentially(tmp_path):
    beatmaps = [
        {'id': 'a1', 'name': 'V1', 'preset': 'v1', 'stem': 'guitar', 'is_active': True,
         'sections': ['ExpertSingle']},
        {'id': 'a2', 'name': 'V2', 'preset': 'v2', 'stem': 'guitar', 'is_active': False,
         'sections': ['ExpertSingle2']},
    ]
    write_song_ini(tmp_path, MINIMAL_FIELDS, beatmaps=beatmaps)
    text = _read(tmp_path)

    i1 = text.index('[beatmap_1]')
    i2 = text.index('[beatmap_2]')
    assert i1 < i2  # ordering preserved
    assert 'is_active = true' in text[i1:i2]
    assert 'is_active = false' in text[i2:]


def test_special_chars_in_name_are_escaped(tmp_path):
    """Newlines in name must be stripped; quotes escaped."""
    bm = {
        'id': 'x', 'preset': 'v1', 'stem': 'guitar', 'is_active': True,
        'sections': [],
        'name': 'My "weird"\nname',  # newline + embedded quote
    }
    write_song_ini(tmp_path, MINIMAL_FIELDS, beatmaps=[bm])
    text = _read(tmp_path)

    name_line = [ln for ln in text.splitlines() if ln.startswith('name = ')][-1]
    assert '\n' not in name_line[len('name = '):]  # newline stripped within the value
    assert 'My \\"weird\\" name' in name_line


def test_missing_optional_fields_use_defaults(tmp_path):
    """`is_active` missing → false; `sections` missing → empty string."""
    bm = {'id': 'x', 'name': 'V1', 'preset': 'v1', 'stem': 'guitar'}
    write_song_ini(tmp_path, MINIMAL_FIELDS, beatmaps=[bm])
    text = _read(tmp_path)
    assert 'is_active = false' in text
    assert 'sections = ' in text  # empty value, but key present
