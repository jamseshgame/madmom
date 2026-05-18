"""LaneEvents — output of S5/S6/S7."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field, field_validator

from ..types import StageOutputBase


VALID_FRETS = {0, 1, 2, 3, 4, 7}
VALID_PAIRS = {(0, 1), (1, 2), (2, 3), (3, 4)}


class LaneEvent(BaseModel):
    tick: int = Field(ge=0)
    frets: list[int]
    sustain: int = Field(default=0, ge=0)
    section: Optional[str] = None

    @field_validator('frets')
    @classmethod
    def _valid_frets(cls, v):
        if not v:
            raise ValueError('frets cannot be empty')
        for f in v:
            if f not in VALID_FRETS:
                raise ValueError(f'invalid fret {f}; allowed {sorted(VALID_FRETS)}')
        if len(v) == 1:
            return v
        if len(v) == 2:
            pair = tuple(sorted(v))
            if pair not in VALID_PAIRS:
                raise ValueError(f'chord pair {pair} is not adjacent; allowed {sorted(VALID_PAIRS)}')
            return v
        raise ValueError('frets must be one or two values')


class LaneEvents(StageOutputBase):
    lanes: list[LaneEvent]
    edits: list[dict] = Field(default_factory=list)
