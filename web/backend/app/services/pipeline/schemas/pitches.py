"""PitchList — output of S3."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

from ..types import StageOutputBase


class PerOnset(BaseModel):
    time_s: float = Field(ge=0)
    dominant_midi: Optional[int] = Field(default=None, ge=21, le=108)
    dominant_confidence: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    polyphony: int = Field(ge=1)
    all_pitches_midi: list[int] = Field(default_factory=list)


class PitchList(StageOutputBase):
    per_onset: list[PerOnset]
