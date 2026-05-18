"""Tests for the pipeline engine registry."""
from __future__ import annotations

import pytest

from app.services.pipeline.registry import (
    EngineSpec,
    Stage,
    engines_catalog,
    get_engine,
    list_engines,
    register_engine,
)
from app.services.pipeline.types import EngineNotFoundError


def _dummy_runner(audio_path, grid, params, on_progress):
    return {'ok': True}


@pytest.fixture(autouse=True)
def _isolate_registry():
    # Snapshot + restore so tests don't bleed state.
    from app.services.pipeline import registry
    snapshot = {k: v.copy() for k, v in registry._REGISTRY.items()}
    yield
    registry._REGISTRY.clear()
    registry._REGISTRY.update(snapshot)


def test_register_and_get_engine():
    register_engine(
        Stage.GRID, EngineSpec(
            id='dummy', display_name='Dummy', params_schema={}, runner=_dummy_runner,
        ),
    )
    spec = get_engine(Stage.GRID, 'dummy')
    assert spec.id == 'dummy'
    assert spec.runner is _dummy_runner


def test_get_engine_unknown_raises():
    with pytest.raises(EngineNotFoundError):
        get_engine(Stage.GRID, 'nope')


def test_register_duplicate_raises():
    register_engine(
        Stage.GRID, EngineSpec(
            id='dup', display_name='Dup', params_schema={}, runner=_dummy_runner,
        ),
    )
    with pytest.raises(ValueError, match='already registered'):
        register_engine(
            Stage.GRID, EngineSpec(
                id='dup', display_name='Dup2', params_schema={}, runner=_dummy_runner,
            ),
        )


def test_list_engines_returns_registered():
    register_engine(
        Stage.GRID, EngineSpec(
            id='a', display_name='A', params_schema={}, runner=_dummy_runner,
        ),
    )
    register_engine(
        Stage.GRID, EngineSpec(
            id='b', display_name='B', params_schema={}, runner=_dummy_runner,
        ),
    )
    ids = [e.id for e in list_engines(Stage.GRID)]
    assert 'a' in ids and 'b' in ids


def test_engines_catalog_groups_by_stage():
    register_engine(
        Stage.GRID, EngineSpec(
            id='g1', display_name='G1', params_schema={}, runner=_dummy_runner,
        ),
    )
    register_engine(
        Stage.ONSETS, EngineSpec(
            id='o1', display_name='O1', params_schema={}, runner=_dummy_runner,
        ),
    )
    cat = engines_catalog()
    assert 'grid' in cat and 'onsets' in cat
    assert any(e['engine_id'] == 'g1' for e in cat['grid'])
    assert any(e['engine_id'] == 'o1' for e in cat['onsets'])
