"""Pipeline stage endpoints.

Pattern mirrors /api/lyrics: per-stage GET/POST/DELETE for the active
file, GET/POST/DELETE on /versions/<filename> for snapshots, plus meta
endpoints (engines catalog, pipeline_state, stems list, run-from,
build-chart).

Each stage sub-resource is built from the same `_make_stage_subrouter`
factory so adding a new stage is mounting one line.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException, Query

from ..config import settings
from ..services.jobs import JobKind, create_job, get_job
from ..services.pipeline.registry import Stage, engines_catalog, get_engine
from ..services.pipeline.state import (
    PipelineState,
    StageState,
    StemState,
    load_pipeline_state,
    mark_downstream_stale,
    save_pipeline_state,
)
from ..services.pipeline.storage import (
    list_versions,
    move_active_to_stale,
    save_version_and_activate,
    stage_path,
    versions_dir,
)


router = APIRouter(prefix='/api/pipeline', tags=['pipeline'])


_TRACK_LEVEL_STAGES = {Stage.GRID}


def _resolve_track_dir(track_id: str) -> Path:
    """Return the directory where a Track's pipeline files live.

    Default: <upload_dir>/tracks/<track_id>. The tracks service may
    override this lookup once Track records have a canonical dir; for
    Phase 0 this is the simplest path that's stable per track_id.
    """
    return Path(settings.upload_dir) / 'tracks' / track_id


def _require_stem(stage: Stage, stem: str | None) -> str:
    if stage in _TRACK_LEVEL_STAGES:
        return ''  # ignored
    if not stem:
        raise HTTPException(400, f"stage {stage.value!r} requires &stem=<name>")
    return stem


# -------------------- meta endpoints --------------------

@router.get('/engines')
async def get_engines_catalog():
    return engines_catalog()


@router.get('/state')
async def get_state(track_id: str = Query(...)):
    return load_pipeline_state(_resolve_track_dir(track_id))


@router.get('/stems')
async def get_stems(track_id: str = Query(...)):
    """Auto-detect stems from <track_dir>/stems/ directory contents."""
    td = _resolve_track_dir(track_id)
    sdir = td / 'stems'
    if not sdir.is_dir():
        return []
    out = []
    for child in sorted(sdir.iterdir()):
        if not child.is_dir():
            continue
        audio_candidates = list(child.glob('*.ogg')) + list(child.glob('*.wav')) + list(child.glob(f'{child.name}.*'))
        audio_path = audio_candidates[0] if audio_candidates else None
        out.append({
            'name': child.name,
            'audio_path': str(audio_path) if audio_path else None,
            'has_v2_pipeline_state': (child / 'v2').is_dir(),
        })
    return out


# -------------------- per-stage sub-router factory --------------------

def _make_stage_subrouter(stage: Stage) -> APIRouter:
    sub = APIRouter()
    stage_id = stage.value

    @sub.get('')
    async def get_active(track_id: str = Query(...), stem: str | None = Query(default=None)):
        stem_ = _require_stem(stage, stem)
        td = _resolve_track_dir(track_id)
        p = stage_path(td, stage, stem_ or None)
        if not p.exists():
            raise HTTPException(404, f'No active {stage_id} for this scope')
        return json.loads(p.read_text())

    @sub.post('')
    async def run_stage(
        body: dict = Body(default_factory=dict),
        track_id: str = Query(...),
        stem: str | None = Query(default=None),
    ):
        stem_ = _require_stem(stage, stem)
        engine_id = body.get('engine')
        params = body.get('params') or {}
        if not engine_id:
            raise HTTPException(400, '`engine` is required in body')
        try:
            spec = get_engine(stage, engine_id)
        except LookupError as e:
            raise HTTPException(404, str(e))

        # Refuse if a job for this (track, stage, stem) is already in flight.
        from ..services.jobs import list_jobs
        for j in list_jobs():
            if (
                j.kind == JobKind.PIPELINE_STAGE
                and j.status.value in ('queued', 'running')
                and j.metadata.get('track_id') == track_id
                and j.metadata.get('stage') == stage_id
                and (j.metadata.get('stem') or '') == (stem_ or '')
            ):
                raise HTTPException(409, 'A run for this stage is already in flight')

        td = _resolve_track_dir(track_id)
        job = create_job(kind=JobKind.PIPELINE_STAGE, title=f'{stage_id}:{engine_id}')
        job.metadata.update({
            'track_id': track_id,
            'stage': stage_id,
            'stem': stem_ or None,
            'engine': engine_id,
            'params': params,
        })

        async def _run():
            try:
                loop = asyncio.get_running_loop()

                def on_progress(step: str, pct: int, msg: str) -> None:
                    asyncio.run_coroutine_threadsafe(job.send(step, pct, msg), loop)

                def _do_run():
                    upstream = _gather_upstream(td, stage, stem_ or None)
                    return spec.runner(
                        audio_path=_audio_path_for(td, stage, stem_ or None),
                        upstream=upstream,
                        params=params,
                        on_progress=on_progress,
                    )

                payload = await loop.run_in_executor(None, _do_run)
                payload.setdefault('engine', engine_id)
                payload.setdefault('params', params)
                payload.setdefault('generated_at',
                                   __import__('datetime').datetime.utcnow().isoformat() + 'Z')

                save_version_and_activate(td, stage, stem_ or None, payload)
                _update_state_after_run(td, stage, stem_ or None, engine_id, payload)
                mark_downstream_stale(td, changed_stage=stage, stem=stem_ or None)

                await job.send_done({'stage': stage_id, 'engine': engine_id})
            except Exception as e:  # noqa: BLE001
                if not job.cancelled:
                    await job.send_error(str(e) or 'pipeline stage failed')

        job.task = asyncio.create_task(_run())
        return {'job_id': job.id}

    @sub.delete('')
    async def clear_active(track_id: str = Query(...), stem: str | None = Query(default=None)):
        stem_ = _require_stem(stage, stem)
        td = _resolve_track_dir(track_id)
        p = stage_path(td, stage, stem_ or None)
        if p.exists():
            p.unlink()
        mark_downstream_stale(td, changed_stage=stage, stem=stem_ or None)
        return {'ok': True}

    @sub.get('/versions')
    async def get_versions(track_id: str = Query(...), stem: str | None = Query(default=None)):
        stem_ = _require_stem(stage, stem)
        td = _resolve_track_dir(track_id)
        return list_versions(td, stage, stem_ or None)

    @sub.get('/versions/{filename}')
    async def get_version(filename: str, track_id: str = Query(...), stem: str | None = Query(default=None)):
        stem_ = _require_stem(stage, stem)
        td = _resolve_track_dir(track_id)
        p = versions_dir(td, stage, stem_ or None) / filename
        if not p.exists():
            raise HTTPException(404, 'Version not found')
        return json.loads(p.read_text())

    @sub.post('/versions/{filename}/activate')
    async def activate_version(filename: str, track_id: str = Query(...), stem: str | None = Query(default=None)):
        stem_ = _require_stem(stage, stem)
        td = _resolve_track_dir(track_id)
        src = versions_dir(td, stage, stem_ or None) / filename
        if not src.exists():
            raise HTTPException(404, 'Version not found')
        dst = stage_path(td, stage, stem_ or None)
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(src.read_text())
        payload = json.loads(src.read_text())
        _update_state_after_run(td, stage, stem_ or None,
                                payload.get('engine', 'unknown'), payload)
        mark_downstream_stale(td, changed_stage=stage, stem=stem_ or None)
        return {'ok': True}

    @sub.delete('/versions/{filename}')
    async def delete_version(filename: str, track_id: str = Query(...), stem: str | None = Query(default=None)):
        stem_ = _require_stem(stage, stem)
        td = _resolve_track_dir(track_id)
        active = stage_path(td, stage, stem_ or None)
        target = versions_dir(td, stage, stem_ or None) / filename
        if not target.exists():
            raise HTTPException(404, 'Version not found')
        if active.exists() and active.read_text() == target.read_text():
            raise HTTPException(409, 'Cannot delete the currently active version')
        target.unlink()
        return {'ok': True}

    return sub


# -------------------- helpers used by the factory --------------------

def _gather_upstream(track_dir: Path, stage: Stage, stem: str | None) -> dict[str, dict]:
    """Load active JSONs for every upstream stage the given stage may need.

    Engines are free to ignore keys they don't use. Returns {} for stages
    that have no upstream (Stage.GRID).
    """
    if stage == Stage.GRID:
        return {}
    upstream: dict[str, dict] = {}
    grid_p = stage_path(track_dir, Stage.GRID, None)
    if grid_p.exists():
        upstream['grid'] = json.loads(grid_p.read_text())
    if stem is None:
        return upstream
    # Each downstream stage gets every prior stem-scoped stage too.
    from .pipeline_order import upstream_for
    for s in upstream_for(stage):
        p = stage_path(track_dir, s, stem)
        if p.exists():
            upstream[s.value] = json.loads(p.read_text())
    return upstream


def _audio_path_for(track_dir: Path, stage: Stage, stem: str | None) -> Path | None:
    """For S1 the engine reads the full mix; for stem stages it reads
    the stem audio. Returns None if the file isn't available — engines
    that need audio raise downstream."""
    if stage == Stage.GRID:
        for cand in ['song.ogg', 'song.wav', 'mix.ogg', 'mix.wav']:
            p = track_dir / cand
            if p.exists():
                return p
        return None
    if stem is None:
        return None
    sdir = track_dir / 'stems' / stem
    candidates = list(sdir.glob('*.ogg')) + list(sdir.glob('*.wav'))
    return candidates[0] if candidates else None


def _update_state_after_run(
    track_dir: Path,
    stage: Stage,
    stem: str | None,
    engine_id: str,
    payload: dict,
) -> None:
    state = load_pipeline_state(track_dir)
    new_state = StageState(
        active_version=None,
        engine=engine_id,
        stale=False,
    )
    versions = list_versions(track_dir, stage, stem)
    if versions:
        new_state.active_version = versions[0]['filename']
    if stage == Stage.GRID:
        state.grid = new_state
    else:
        if stem is None:
            raise ValueError('stem required for non-grid stage')
        ss = state.stems.setdefault(stem, StemState())
        setattr(ss, stage.value, new_state)
    save_pipeline_state(track_dir, state)


# -------------------- mount one sub-router per stage --------------------

for _stage in Stage:
    router.include_router(_make_stage_subrouter(_stage), prefix=f'/{_stage.value}')
