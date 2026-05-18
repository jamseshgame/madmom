"""OnsetList — output of S2."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field, field_validator

from ..types import StageOutputBase


class Onset(BaseModel):
    time_s: float = Field(ge=0)
    confidence: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    source_note_id: Optional[int] = None


class OnsetList(StageOutputBase):
    onsets: list[Onset]

    @field_validator('onsets')
    @classmethod
    def _strictly_monotonic(cls, v):
        prev = -1.0
        for o in v:
            if o.time_s <= prev:
                raise ValueError('onsets must be strictly monotonic in time_s')
            prev = o.time_s
        return v
