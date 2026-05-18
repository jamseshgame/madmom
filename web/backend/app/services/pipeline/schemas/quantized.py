"""QuantizedEvents — output of S4."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

from ..types import StageOutputBase


class QuantizedEvent(BaseModel):
    tick: int = Field(ge=0)
    time_s_pre: Optional[float] = None
    time_s_post: Optional[float] = None
    snap_division: Optional[int] = None
    metric_weight: int = Field(ge=0, le=4)
    dominant_midi: Optional[int] = None
    polyphony: int = Field(default=1, ge=1)
    dropped: bool = False


class QuantizedEvents(StageOutputBase):
    events: list[QuantizedEvent]
