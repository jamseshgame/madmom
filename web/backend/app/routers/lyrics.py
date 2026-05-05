"""Lyrics fetch / persist / publish-prep routes.

See docs/superpowers/specs/2026-05-05-timestamped-lyrics-design.md.
"""
from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix='/api/lyrics', tags=['lyrics'])
