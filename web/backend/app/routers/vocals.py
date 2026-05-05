"""Vocal beatmap fetch / persist / generate routes.

See docs/superpowers/specs/2026-05-05-vocal-beatmaps-design.md.
"""
from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix='/api/vocals', tags=['vocals'])
