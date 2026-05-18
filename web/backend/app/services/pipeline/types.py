"""Shared pipeline types and exceptions."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict


StageId = Literal[
    'grid',
    'onsets',
    'pitches',
    'quantized',
    'lanes_expert',
    'lanes_filtered',
    'lanes_hard',
    'lanes_medium',
    'lanes_easy',
]

# `lanes_hard`/`lanes_medium`/`lanes_easy` share an engine list (S7) but are
# stored separately because each difficulty's active version is independently
# selectable.

EngineId = str
EngineParams = dict[str, object]


class StageOutputBase(BaseModel):
    """Every stage output JSON contains at least these fields."""

    engine: EngineId
    params: EngineParams
    generated_at: str  # ISO 8601 UTC

    model_config = ConfigDict(extra='allow')


class EngineNotFoundError(LookupError):
    """Raised when a stage/engine combination isn't registered."""


class StageValidationError(ValueError):
    """Raised when a stage output fails its schema or invariants check."""
