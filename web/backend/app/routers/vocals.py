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


import asyncio

from app.services import lyrics as lyrics_service
from app.services.jobs import JobKind, create_job


@router.post('/generate')
async def post_generate(
    body: dict = Body(...),
    job_id: str | None = Query(default=None),
    track_id: str | None = Query(default=None),
):
    """Full vocals pipeline: fetch lyrics if missing -> CREPE -> align -> write.

    Body fields used only when lyrics need fetching:
      artist, title, album?, duration_s?
    Returns {job_id} for SSE subscription on /api/jobs/{job_id}/events.
    """
    target = _resolve_dir(job_id=job_id, track_id=track_id)

    candidates = list(target.glob('vocals.*'))
    audio_exts = {'.ogg', '.wav', '.mp3', '.flac'}
    vocals = next((p for p in candidates if p.suffix.lower() in audio_exts), None)
    if vocals is None or not vocals.exists():
        raise HTTPException(404, 'No vocals stem available for this scope')

    work_job = create_job(kind=JobKind.OTHER, title='Vocal beatmap generation')

    async def _run() -> None:
        loop = asyncio.get_running_loop()
        try:
            await work_job.send('init', 2, 'Resolving track...')

            lyrics = lyrics_service.load_lyrics(target)

            if lyrics is None:
                await work_job.send('lyrics-fetch', 10, 'Fetching synced lyrics from LRClib...')
                lyrics = await lyrics_service.fetch_from_lrclib(
                    artist=(body.get('artist') or '').strip(),
                    title=(body.get('title') or '').strip(),
                    album=body.get('album'),
                    duration_s=body.get('duration_s'),
                )
                if lyrics is None:
                    await work_job.send('lyrics-fetch', 25, 'No LRClib match - transcribing with Whisper...')

                    def sync_whisper_progress(step: str, pct: int, msg: str) -> None:
                        scaled = 25 + int(0.30 * pct / 100 * 100)
                        scaled = min(55, max(25, scaled))
                        asyncio.run_coroutine_threadsafe(
                            work_job.send('whisper', scaled, msg), loop,
                        )

                    lyrics = await loop.run_in_executor(
                        None,
                        lambda: lyrics_service.transcribe_with_whisper(vocals, sync_whisper_progress),
                    )
                target.mkdir(parents=True, exist_ok=True)
                lyrics_service.write_lyrics(target, lyrics)

            await work_job.send('crepe-load', 65, 'Loading pitch model...')

            def sync_build_progress(step: str, pct: int, msg: str) -> None:
                asyncio.run_coroutine_threadsafe(work_job.send(step, pct, msg), loop)

            notes = await loop.run_in_executor(
                None,
                lambda: vocals_service.build_vocal_notes(vocals, lyrics, sync_build_progress),
            )

            target.mkdir(parents=True, exist_ok=True)
            vocals_service.write_vocal_notes(target, notes)

            voicing_breakdown: dict[str, int] = {'sung': 0, 'spoken': 0, 'whispered': 0}
            for s in notes.get('syllables', []):
                v = s.get('voicing', 'sung')
                voicing_breakdown[v] = voicing_breakdown.get(v, 0) + 1

            await work_job.send_done({
                'syllable_count': len(notes.get('syllables', [])),
                'voicing': voicing_breakdown,
                'source': lyrics.get('source'),
                'pitch_model': notes.get('pitch_model'),
            })
        except asyncio.CancelledError:
            return
        except Exception as e:
            await work_job.send_error(str(e) or 'Vocal beatmap generation failed')

    work_job.task = asyncio.create_task(_run())
    return {'job_id': work_job.id}
