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


@router.get('/exists')
async def vocals_exists(
    job_id: str | None = Query(default=None),
    track_id: str | None = Query(default=None),
):
    """Presence probe — always returns 200 so the frontend can check whether
    a scope has a vocal_notes.json without logging a 404 in the console.
    Companion to GET / above which returns the data (or 404 when missing).
    """
    target = _resolve_dir(job_id=job_id, track_id=track_id)
    data = vocals_service.load_vocal_notes(target)
    return {'exists': data is not None}


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


# --- Versioned vocalmap history (mirrors /api/lyrics/versions) --------------

@router.get('/versions')
async def list_vocalmap_versions(
    job_id: str | None = Query(default=None),
    track_id: str | None = Query(default=None),
):
    target = _resolve_dir(job_id=job_id, track_id=track_id)
    return vocals_service.list_vocal_notes_versions(target)


@router.get('/versions/{filename}')
async def get_vocalmap_version(
    filename: str,
    job_id: str | None = Query(default=None),
    track_id: str | None = Query(default=None),
):
    target = _resolve_dir(job_id=job_id, track_id=track_id)
    data = vocals_service.load_vocal_notes_version(target, filename)
    if data is None:
        raise HTTPException(404, 'Version not found')
    return data


@router.post('/versions/{filename}/activate')
async def activate_vocalmap_version(
    filename: str,
    job_id: str | None = Query(default=None),
    track_id: str | None = Query(default=None),
):
    target = _resolve_dir(job_id=job_id, track_id=track_id)
    data = vocals_service.activate_vocal_notes_version(target, filename)
    if data is None:
        raise HTTPException(404, 'Version not found')
    return {'ok': True, 'syllable_count': len(data.get('syllables') or [])}


@router.delete('/versions/{filename}')
async def delete_vocalmap_version(
    filename: str,
    job_id: str | None = Query(default=None),
    track_id: str | None = Query(default=None),
):
    """Delete a single vocalmap snapshot. If it matches the active version
    (fetched_at equality), also wipe vocal_notes.json so the editor +
    Publish-to-Game don't keep a dangling active reference. Returns
    `was_active` so the caller can refresh derived UI."""
    target = _resolve_dir(job_id=job_id, track_id=track_id)
    snap = vocals_service.load_vocal_notes_version(target, filename)
    if snap is None:
        raise HTTPException(404, 'Version not found')
    active = vocals_service.load_vocal_notes(target) or {}
    was_active = bool(active.get('fetched_at')) and snap.get('fetched_at') == active['fetched_at']
    if was_active:
        active_path = target / 'vocal_notes.json'
        if active_path.exists():
            active_path.unlink()
    if not vocals_service.delete_vocal_notes_version(target, filename):
        raise HTTPException(404, 'Version not found')
    return {'ok': True, 'was_active': was_active}


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

    # Pull tunables out of the body so build_vocal_notes gets them through
    # run_in_executor below. Validation is light — the service already
    # clamps model_size and falls back to defaults on bad floats.
    gen_params = {
        'model_size': str(body.get('model_size') or 'full'),
        'fmin': float(body.get('fmin') or 50.0),
        'fmax': float(body.get('fmax') or 1000.0),
        'periodicity_threshold': float(body.get('periodicity_threshold') or 0.21),
        'transpose_semitones': int(body.get('transpose_semitones') or 0),
        'min_note_duration_s': float(body.get('min_note_duration_s') or 0.0),
    }

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

            last_step = {'step': 'crepe', 'pct': 70, 'msg': 'Detecting pitch...'}

            def sync_build_progress(step: str, pct: int, msg: str) -> None:
                last_step['step'] = step
                last_step['pct'] = pct
                last_step['msg'] = msg
                asyncio.run_coroutine_threadsafe(work_job.send(step, pct, msg), loop)

            async def _heartbeat() -> None:
                """Re-send the most recent progress event every 5s so the SSE
                stays visibly alive during the long CREPE pass — without it,
                EventSource sees no traffic for minutes and fires onerror."""
                import time
                start = time.time()
                while True:
                    await asyncio.sleep(5)
                    elapsed = int(time.time() - start)
                    await work_job.send(
                        last_step['step'], last_step['pct'],
                        f"{last_step['msg']} ({elapsed}s)",
                    )

            hb = asyncio.create_task(_heartbeat())
            try:
                notes = await loop.run_in_executor(
                    None,
                    lambda: vocals_service.build_vocal_notes(
                        vocals, lyrics, sync_build_progress, **gen_params,
                    ),
                )
            finally:
                hb.cancel()

            target.mkdir(parents=True, exist_ok=True)
            vocals_service.write_vocal_notes(target, notes)
            vocals_service.save_vocal_notes_version(target, notes)

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
