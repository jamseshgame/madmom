"""Chart Generation Pipeline V2 — modular stages for pitched-stem charts.

See docs/superpowers/specs/2026-05-18-chart-pipeline-design.md.
"""
from __future__ import annotations

from .registry import Stage, register_engine, get_engine, list_engines, engines_catalog
from .state import (
    PipelineState,
    load_pipeline_state,
    save_pipeline_state,
    mark_downstream_stale,
)
from .storage import (
    track_dir,
    stem_v2_dir,
    stage_path,
    versions_dir,
    archive_dir,
    stale_dir,
    save_version_and_activate,
    list_versions,
    move_active_to_stale,
)
from .types import (
    StageId,
    EngineId,
    EngineParams,
    StageOutputBase,
    EngineNotFoundError,
    StageValidationError,
)

__all__ = [
    'Stage',
    'register_engine',
    'get_engine',
    'list_engines',
    'engines_catalog',
    'PipelineState',
    'load_pipeline_state',
    'save_pipeline_state',
    'mark_downstream_stale',
    'track_dir',
    'stem_v2_dir',
    'stage_path',
    'versions_dir',
    'archive_dir',
    'stale_dir',
    'save_version_and_activate',
    'list_versions',
    'move_active_to_stale',
    'StageId',
    'EngineId',
    'EngineParams',
    'StageOutputBase',
    'EngineNotFoundError',
    'StageValidationError',
]
