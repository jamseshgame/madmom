"""Vocal beatmap fetch / persist / generate routes.

See docs/superpowers/specs/2026-05-05-vocal-beatmaps-design.md.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Body, HTTPException, Query

from app.services import vocals as vocals_service
from app.services.jobs import get_job
from app.services.tracks import get_track


router = APIRouter(prefix='/api/vocals', tags=['vocals'])


def _resolve_dir(job_id: str | None = None, track_id: str | None = None) -> Path:
    """Mirror of lyrics router's _resolve_dir. track_id wins if both supplied."""
    if track_id:
        track = get_track(track_id)
        if not track:
            raise HTTPException(404, f'Track not found: {track_id}')
        return track.stems_dir
    if job_id:
        job = get_job(job_id)
        if not job or not job.output_dir:
            raise HTTPException(404, f'Job not found: {job_id}')
        return job.output_dir / 'stems'
    raise HTTPException(400, 'Provide job_id or track_id')


@router.get('')
async def get_vocals(
    job_id: str | None = Query(default=None),
    track_id: str | None = Query(default=None),
):
    target = _resolve_dir(job_id=job_id, track_id=track_id)
    data = vocals_service.load_vocal_notes(target)
    if data is None:
        raise HTTPException(404, 'No vocal notes for this scope')
    return data


@router.put('')
async def put_vocals(
    body: dict = Body(...),
    job_id: str | None = Query(default=None),
    track_id: str | None = Query(default=None),
):
    target = _resolve_dir(job_id=job_id, track_id=track_id)
    target.mkdir(parents=True, exist_ok=True)
    vocals_service.write_vocal_notes(target, body)
    return {'ok': True, 'syllable_count': len(body.get('syllables', []))}


@router.delete('')
async def delete_vocals(
    job_id: str | None = Query(default=None),
    track_id: str | None = Query(default=None),
):
    target = _resolve_dir(job_id=job_id, track_id=track_id)
    p = target / 'vocal_notes.json'
    if p.exists():
        p.unlink()
    return {'ok': True}
