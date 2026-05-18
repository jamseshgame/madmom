"""Per-stage upstream lookup."""
from __future__ import annotations

from ..services.pipeline.registry import Stage


_UPSTREAM: dict[Stage, list[Stage]] = {
    Stage.GRID: [],
    Stage.ONSETS: [],
    Stage.PITCHES: [Stage.ONSETS],
    Stage.QUANTIZED: [Stage.PITCHES],
    Stage.LANES_EXPERT: [Stage.QUANTIZED],
    Stage.LANES_FILTERED: [Stage.LANES_EXPERT],
    Stage.LANES_HARD: [Stage.LANES_FILTERED],
    Stage.LANES_MEDIUM: [Stage.LANES_FILTERED],
    Stage.LANES_EASY: [Stage.LANES_FILTERED],
}


def upstream_for(stage: Stage) -> list[Stage]:
    return _UPSTREAM[stage]
