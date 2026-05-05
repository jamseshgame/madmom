"""Lyrics fetch / persist / publish-prep routes.

See docs/superpowers/specs/2026-05-05-timestamped-lyrics-design.md.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Body, HTTPException, Query

from app.services import lyrics as lyrics_service
from app.services.jobs import get_job
from app.services.tracks import get_track

router = APIRouter(prefix='/api/lyrics', tags=['lyrics'])


def _resolve_dir(job_id: str | None = None, track_id: str | None = None) -> Path:
    """Return the directory where lyrics.json for the given scope should live.

    track_id wins over job_id when both are supplied. Raises 400 if neither
    is given, 404 if the scope can't be resolved.
    """
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
async def get_lyrics(
    job_id: str | None = Query(default=None),
    track_id: str | None = Query(default=None),
):
    target = _resolve_dir(job_id=job_id, track_id=track_id)
    data = lyrics_service.load_lyrics(target)
    if data is None:
        raise HTTPException(404, 'No lyrics for this scope')
    return data


@router.put('')
async def put_lyrics(
    body: dict = Body(...),
    job_id: str | None = Query(default=None),
    track_id: str | None = Query(default=None),
):
    target = _resolve_dir(job_id=job_id, track_id=track_id)
    target.mkdir(parents=True, exist_ok=True)
    lyrics_service.write_lyrics(target, body)
    return {'ok': True, 'word_count': len(body.get('words', []))}


@router.delete('')
async def delete_lyrics(
    job_id: str | None = Query(default=None),
    track_id: str | None = Query(default=None),
):
    target = _resolve_dir(job_id=job_id, track_id=track_id)
    p = target / 'lyrics.json'
    if p.exists():
        p.unlink()
    return {'ok': True}


@router.post('/lrclib')
async def post_lrclib(
    body: dict = Body(...),
    job_id: str | None = Query(default=None),
    track_id: str | None = Query(default=None),
):
    """Body: artist, title, album?, duration_s?"""
    target = _resolve_dir(job_id=job_id, track_id=track_id)
    artist = (body.get('artist') or '').strip()
    title = (body.get('title') or '').strip()
    if not artist or not title:
        raise HTTPException(400, 'artist and title are required')
    result = await lyrics_service.fetch_from_lrclib(
        artist=artist, title=title,
        album=body.get('album'),
        duration_s=body.get('duration_s'),
    )
    if result is None:
        return {'source': None}
    target.mkdir(parents=True, exist_ok=True)
    lyrics_service.write_lyrics(target, result)
    return result
