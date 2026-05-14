"""Loop factory for uvicorn.

Forces ``ProactorEventLoop`` on Windows so ``asyncio.create_subprocess_exec``
works (Demucs, ffmpeg, pip upgrade, etc.). Modern uvicorn (>=0.36) builds the
loop via ``Config.get_loop_factory()`` and ignores the global asyncio policy
when ``use_subprocess=True`` (i.e. ``--reload``), so we have to plug a custom
factory directly through ``Config.loop``.

The supervisor's ``Config`` is pickled into the multiprocessing ``spawn`` child
that runs the actual server, so both processes share this factory.
"""

from __future__ import annotations

import asyncio
import sys


def proactor() -> asyncio.AbstractEventLoop:
    if sys.platform == 'win32':
        return asyncio.ProactorEventLoop()
    return asyncio.new_event_loop()
