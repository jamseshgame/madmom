"""Dev-only launcher that forces uvicorn's --reload workers onto the
ProactorEventLoop on Windows.

uvicorn 0.36+ hardcodes `SelectorEventLoop` for `--reload` worker processes
(`uvicorn.loops.asyncio.asyncio_loop_factory(use_subprocess=True)`), but the
Selector loop on Windows raises NotImplementedError for
`asyncio.create_subprocess_exec`. The app shells out to ffmpeg/demucs/madmom
via that API, so every shell-out crashes the worker under --reload.

Setting the policy in `app/main.py` is too late — the loop is already
created before that module is imported. multiprocessing.spawn on Windows
re-executes this launcher's top-level code in each spawned worker, so the
monkey-patch below propagates to every reload worker before uvicorn calls
`Server.run()`.

Usage (from `web/backend/`):
    python dev_runner.py
"""

from __future__ import annotations

import asyncio
import sys

import uvicorn.loops.asyncio
import uvicorn.loops.auto


def _proactor_factory(use_subprocess: bool = False):
    return asyncio.ProactorEventLoop


if sys.platform == 'win32':
    uvicorn.loops.asyncio.asyncio_loop_factory = _proactor_factory
    uvicorn.loops.auto.auto_loop_factory = _proactor_factory


if __name__ == '__main__':
    import uvicorn

    uvicorn.run('app.main:app', reload=True, host='127.0.0.1', port=8000)
