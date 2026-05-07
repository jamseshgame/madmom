"""Repo-root conftest: ensure the repo root is on sys.path so tests can import
the `web.backend.app...` package tree directly.
"""
from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))
