"""Dev runner that forces a Proactor event loop on Windows.

Uvicorn (>=0.36) builds the worker's loop via ``Config.get_loop_factory()``.
With ``--reload`` it picks ``SelectorEventLoop`` on Windows, which can't spawn
subprocesses (Demucs, ffmpeg, pip upgrade — all fail with an empty-message
``NotImplementedError``). Passing ``loop='_loop:proactor'`` overrides that;
the same factory string travels into the spawn-child via the pickled Config.
"""

from __future__ import annotations

import uvicorn


if __name__ == '__main__':
    uvicorn.run(
        'app.main:app',
        host='127.0.0.1',
        port=8000,
        reload=True,
        reload_dirs=['app'],
        loop='_loop:proactor',
        log_level='info',
    )
