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
from ..services.pipeline.runner import _update_state_after_run, run_stage as _run_stage

_S7_STAGES = {Stage.LANES_HARD, Stage.LANES_MEDIUM, Stage.LANES_EASY}
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

    Uses the Tracks service's canonical directory: <upload_dir>/_tracks/<id>.
    Falls back to a synthetic path under <upload_dir>/_tracks/<id> for IDs
    that don't have a Track record yet (so tests using arbitrary IDs work).
    """
    from ..services.tracks import TRACKS_DIR
    return TRACKS_DIR / track_id


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
                    return _run_stage(
                        stage=stage,
                        track_dir=td,
                        stem=stem_ or None,
                        engine_id=engine_id,
                        params=params,
                        on_progress=on_progress,
                    )

                await loop.run_in_executor(None, _do_run)

                if stage in _S7_STAGES:
                    await job.send_done({'stage': 'lanes_(hard|medium|easy)', 'engine': engine_id})
                else:
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
                                payload.get('engine', 'unknown'))
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


# -------------------- mount one sub-router per stage --------------------

for _stage in Stage:
    router.include_router(_make_stage_subrouter(_stage), prefix=f'/{_stage.value}')


@router.post('/build-chart')
async def build_chart(track_id: str = Query(...), stem: str = Query(...)):
    """Run S8 — read all active stage outputs for the stem, serialize, write notes.chart."""
    from ..services.pipeline.serialize import serialize_chart
    td = _resolve_track_dir(track_id)
    grid_p = stage_path(td, Stage.GRID, None)
    if not grid_p.exists():
        raise HTTPException(404, 'No active grid')
    grid = json.loads(grid_p.read_text())

    lanes_per_difficulty: dict[str, dict] = {}
    expert_p = stage_path(td, Stage.LANES_EXPERT, stem)
    filtered_p = stage_path(td, Stage.LANES_FILTERED, stem)
    use_p = filtered_p if filtered_p.exists() else expert_p
    if not use_p.exists():
        raise HTTPException(404, 'No active lanes_expert (or _filtered) for stem')
    lanes_per_difficulty['ExpertSingle'] = json.loads(use_p.read_text())

    for diff_section, stage in (
        ('HardSingle', Stage.LANES_HARD),
        ('MediumSingle', Stage.LANES_MEDIUM),
        ('EasySingle', Stage.LANES_EASY),
    ):
        p = stage_path(td, stage, stem)
        if p.exists():
            lanes_per_difficulty[diff_section] = json.loads(p.read_text())

    text = serialize_chart(
        grid=grid, lanes_per_difficulty=lanes_per_difficulty,
        song_name=track_id, resolution=int(grid['resolution']),
    )
    out_dir = td / 'stems' / stem / 'v2'
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / 'notes.chart'
    out_path.write_text(text, encoding='utf-8')
    return {'chart_path': str(out_path)}
