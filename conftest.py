"""Repo-root conftest: ensure the repo root is on sys.path so tests can import
the `web.backend.app...` package tree directly. Also expose `web/backend` so
existing modules that use `from app.services import ...` (the runtime layout
when uvicorn is launched from web/backend) keep importing.
"""
from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

_WEB_BACKEND = _REPO_ROOT / 'web' / 'backend'
if _WEB_BACKEND.is_dir() and str(_WEB_BACKEND) not in sys.path:
    sys.path.insert(0, str(_WEB_BACKEND))
