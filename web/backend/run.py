"""Dev runner that forces the Windows Proactor event loop before uvicorn starts.

Uvicorn's default on Windows is `WindowsSelectorEventLoopPolicy`, which cannot
spawn subprocesses (Demucs, ffmpeg). We override its setup hook here before
launching so all worker loops use Proactor.
"""

from __future__ import annotations

import asyncio
import sys


def _force_proactor() -> None:
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())


# Patch uvicorn's Windows-selector default at import time.
import uvicorn.loops.asyncio as _uv_loop  # noqa: E402

_uv_loop.asyncio_setup = _force_proactor
_force_proactor()

import uvicorn  # noqa: E402


if __name__ == '__main__':
    uvicorn.run(
        'app.main:app',
        host='127.0.0.1',
        port=8000,
        reload=True,
        reload_dirs=['app'],
        log_level='info',
    )
