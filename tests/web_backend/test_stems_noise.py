"""Known-noise stderr lines from separator subprocesses must not become
progress-headline log events (they read as failures in the UI)."""
from __future__ import annotations

import pytest

from app.services.stems import is_noise_line


@pytest.mark.parametrize(
    'line',
    [
        '[src/libmpg123/id3.c:process_comment():587] error: No comment text / valid description?',
        '[src/libmpg123/id3.c:process_text():420] warning: Unknown text frame',
        '[src/libmpg123/parse.c:do_readahead():1099] warning: Cannot read next header, a one-frame stream?',
    ],
)
def test_libmpg123_chatter_is_noise(line):
    assert is_noise_line(line)


@pytest.mark.parametrize(
    'line',
    [
        '2026-08-24 21:52:10.857 - INFO - common_separator - Input audio subtype: MPEG_LAYER_III',
        'RuntimeError: CUDA out of memory',
        '',
    ],
)
def test_real_lines_are_not_noise(line):
    assert not is_noise_line(line)
