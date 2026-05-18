"""pipeline_state.json — single source of truth for the editor UI."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, Field

from .registry import Stage


_STATE_FILENAME = 'pipeline_state.json'

# Downstream order for stem-scoped stages. Re-running any of these flags every
# later one as stale within the same stem.
_STEM_STAGE_ORDER = [
    Stage.ONSETS,
    Stage.PITCHES,
    Stage.QUANTIZED,
    Stage.LANES_EXPERT,
    Stage.LANES_FILTERED,
    Stage.LANES_HARD,
    Stage.LANES_MEDIUM,
    Stage.LANES_EASY,
]


class StageState(BaseModel):
    active_version: Optional[str] = None
    engine: Optional[str] = None
    stale: bool = False


class StemState(BaseModel):
    onsets: StageState = Field(default_factory=StageState)
    pitches: StageState = Field(default_factory=StageState)
    quantized: StageState = Field(default_factory=StageState)
    lanes_expert: StageState = Field(default_factory=StageState)
    lanes_filtered: StageState = Field(default_factory=StageState)
    lanes_hard: StageState = Field(default_factory=StageState)
    lanes_medium: StageState = Field(default_factory=StageState)
    lanes_easy: StageState = Field(default_factory=StageState)
    last_chart_built_at: Optional[str] = None


class PipelineState(BaseModel):
    schema_version: int = 1
    grid: Optional[StageState] = None
    stems: dict[str, StemState] = Field(default_factory=dict)


def _state_path(track_dir: Path) -> Path:
    return track_dir / _STATE_FILENAME


def load_pipeline_state(track_dir: Path) -> PipelineState:
    p = _state_path(track_dir)
    if not p.exists():
        return PipelineState()
    try:
        return PipelineState.model_validate_json(p.read_text())
    except Exception:
        return PipelineState()


def save_pipeline_state(track_dir: Path, state: PipelineState) -> None:
    track_dir.mkdir(parents=True, exist_ok=True)
    _state_path(track_dir).write_text(state.model_dump_json(indent=2))


def mark_downstream_stale(
    track_dir: Path,
    changed_stage: Stage,
    stem: str | None,
) -> None:
    """Flag every stage downstream of `changed_stage` (within the same stem,
    or for every stem when changed_stage is Stage.GRID) as stale."""
    state = load_pipeline_state(track_dir)

    if changed_stage == Stage.GRID:
        for stem_state in state.stems.values():
            for s in _STEM_STAGE_ORDER:
                getattr(stem_state, s.value).stale = True
        save_pipeline_state(track_dir, state)
        return

    if stem is None:
        raise ValueError(f"non-grid stage {changed_stage.value!r} requires a stem")
    if stem not in state.stems:
        return

    try:
        idx = _STEM_STAGE_ORDER.index(changed_stage)
    except ValueError:
        return
    downstream = _STEM_STAGE_ORDER[idx + 1:]
    stem_state = state.stems[stem]
    for s in downstream:
        getattr(stem_state, s.value).stale = True
    save_pipeline_state(track_dir, state)
