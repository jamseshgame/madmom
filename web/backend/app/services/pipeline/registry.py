"""Pipeline engine registry.

Stages are an enum; engines are registered into per-stage dicts at import
time (each engine module side-effect-registers itself when imported).
The router/UI later read this registry via `engines_catalog()`.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable

from .types import EngineNotFoundError, EngineParams


class Stage(str, Enum):
    GRID = 'grid'
    ONSETS = 'onsets'
    PITCHES = 'pitches'
    QUANTIZED = 'quantized'
    LANES_EXPERT = 'lanes_expert'
    LANES_FILTERED = 'lanes_filtered'
    LANES_HARD = 'lanes_hard'
    LANES_MEDIUM = 'lanes_medium'
    LANES_EASY = 'lanes_easy'


EngineRunner = Callable[..., dict[str, Any]]
"""Signature: runner(audio_path, upstream, params, on_progress) -> dict.

`upstream` is a dict of upstream-stage outputs the engine needs, keyed by
stage name (e.g. `{'grid': {...}, 'onsets': {...}}`). `on_progress` is a
sync callable `(step: str, pct: int, msg: str) -> None` the engine calls
to report progress; the router bridges it onto the SSE channel.
"""


@dataclass(frozen=True)
class EngineSpec:
    id: str
    display_name: str
    # JSON-schema-like dict the UI uses to render sliders/dropdowns.
    # See docs/superpowers/specs §6 for examples.
    params_schema: dict[str, Any]
    runner: EngineRunner


_REGISTRY: dict[Stage, dict[str, EngineSpec]] = {s: {} for s in Stage}


def register_engine(stage: Stage, spec: EngineSpec) -> None:
    bucket = _REGISTRY[stage]
    if spec.id in bucket:
        raise ValueError(f"engine {spec.id!r} already registered for stage {stage.value!r}")
    bucket[spec.id] = spec


def get_engine(stage: Stage, engine_id: str) -> EngineSpec:
    bucket = _REGISTRY[stage]
    if engine_id not in bucket:
        raise EngineNotFoundError(f"no engine {engine_id!r} for stage {stage.value!r}")
    return bucket[engine_id]


def list_engines(stage: Stage) -> list[EngineSpec]:
    return list(_REGISTRY[stage].values())


def engines_catalog() -> dict[str, list[dict[str, Any]]]:
    """Serializable engine catalog for the meta endpoint."""
    return {
        stage.value: [
            {
                'engine_id': spec.id,
                'display_name': spec.display_name,
                'params_schema': spec.params_schema,
            }
            for spec in specs.values()
        ]
        for stage, specs in _REGISTRY.items()
    }
