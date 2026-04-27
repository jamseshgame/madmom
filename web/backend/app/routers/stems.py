"""Stem separation endpoints — upload audio, split into vocals/drums/bass/guitar/piano/other."""

import asyncio
import io
import json
import zipfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from ..config import settings
from ..services.audio import resize_to_square_png
from ..services.stems import MODEL_STEMS, separate_stems, write_song_ini
from ..services.github_publisher import publish_song_folder
from ..services.jobs import JobStatus, create_job, get_job
from ..services.tracks import create_track

router = APIRouter(prefix='/api/stems', tags=['stems'])

ALLOWED_EXTENSIONS = {'.flac', '.mp3', '.ogg', '.wav', '.m4a', '.aac', '.wma'}


@router.get('/models')
async def list_models():
    """Return available models and their stem lists."""
    return MODEL_STEMS


@router.post('/separate')
async def start_separation(
    file: UploadFile,
    model: str = Form('htdemucs'),
    stems: str = Form(''),
    output_format: str = Form('mp3'),
    mp3_bitrate: int = Form(320),
    shifts: int = Form(1),
    overlap: float = Form(0.25),
    clip_mode: str = Form('rescale'),
    segment: str = Form(''),
    game_ready: bool = Form(False),
    song_ini: Optional[str] = Form(None),
    album_art: Optional[UploadFile] = File(None),
):
    """Upload audio and start stem separation. Returns job_id for SSE tracking."""
    ext = Path(file.filename or '').suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f'Unsupported format: {ext}. Use: {", ".join(sorted(ALLOWED_EXTENSIONS))}')

    if model not in MODEL_STEMS:
        raise HTTPException(400, f'Unknown model: {model}. Use: {", ".join(MODEL_STEMS.keys())}')

    # Parse stems list
    stem_list = [s.strip() for s in stems.split(',') if s.strip()] or None

    # Parse optional segment
    segment_val = int(segment) if segment.strip() else None

    upload_dir = Path(settings.upload_dir)
    upload_dir.mkdir(parents=True, exist_ok=True)

    job = create_job()
    job_dir = upload_dir / job.id
    job_dir.mkdir()
    job.output_dir = job_dir

    audio_path = job_dir / f'input{ext}'
    content = await file.read()
    if len(content) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, f'File too large. Max {settings.max_upload_mb} MB.')
    audio_path.write_bytes(content)

    original_name = Path(file.filename or 'audio').stem
    job.metadata['original_name'] = original_name

    # Stage album.png (resized to 512×512) for the game-ready folder
    album_png_bytes: Optional[bytes] = None
    if album_art is not None:
        raw = await album_art.read()
        if raw:
            try:
                album_png_bytes = resize_to_square_png(raw, size=512)
            except Exception as ae:
                print(f'[stems] album_art resize failed: {ae}')

    async def _run():
        job.status = JobStatus.RUNNING
        try:
            result = await separate_stems(
                audio_path=str(audio_path),
                output_dir=str(job_dir / 'stems'),
                model=model,
                stems=stem_list,
                output_format=output_format,
                mp3_bitrate=mp3_bitrate,
                shifts=shifts,
                segment=segment_val,
                overlap=overlap,
                clip_mode=clip_mode,
                game_ready=game_ready,
                progress_callback=job.send,
            )
            job.metadata.update(result)

            # Write song.ini for game-ready exports
            if game_ready and song_ini:
                try:
                    ini_fields = json.loads(song_ini)
                    ini_path = write_song_ini(job_dir / 'stems', ini_fields)
                    result['stems']['song_ini'] = 'song.ini'
                    job.metadata['song_ini'] = ini_fields
                    if job.send:
                        await job.send('init', -1, f'Wrote {ini_path.name}')
                except Exception as ie:
                    print(f'[stems] song.ini write failed: {ie}')

            # Write album.png for game-ready exports
            if game_ready and album_png_bytes:
                try:
                    (job_dir / 'stems' / 'album.png').write_bytes(album_png_bytes)
                    result['stems']['album_png'] = 'album.png'
                    if job.send:
                        await job.send('init', -1, 'Wrote album.png')
                except Exception as ae:
                    print(f'[stems] album.png write failed: {ae}')

            # Auto-save as a persistent track
            try:
                track = create_track(
                    name=original_name,
                    stems=result['stems'],
                    source_stems_dir=job_dir / 'stems',
                    model=result.get('model', model),
                    output_format=result.get('output_format', output_format),
                )
                job.metadata['track_id'] = track.id
            except Exception as te:
                print(f'[stems] Track save failed: {te}')

            await job.send_done(job.metadata)
        except Exception as e:
            import traceback
            err_msg = str(e) or traceback.format_exc().splitlines()[-1]
            print(f'[stems] Job {job.id} failed: {traceback.format_exc()}')
            await job.send_error(err_msg)

    asyncio.create_task(_run())

    return {'job_id': job.id}


@router.get('/{job_id}/status')
async def separation_status(job_id: str):
    """SSE stream of separation progress."""
    job = get_job(job_id)
    if not job:
        raise HTTPException(404, 'Job not found')

    queue = job.subscribe()

    async def event_stream():
        try:
            if job.status == JobStatus.DONE:
                yield f'data: {json.dumps({"step": "done", "progress": 100, "message": "Complete", "metadata": job.metadata})}\n\n'
                return
            if job.status == JobStatus.FAILED:
                yield f'data: {json.dumps({"step": "error", "progress": -1, "message": job.error or "Failed"})}\n\n'
                return

            while True:
                event = await asyncio.wait_for(queue.get(), timeout=600)
                if event is None:
                    break
                yield f'data: {json.dumps(event)}\n\n'
        except asyncio.TimeoutError:
            yield f'data: {json.dumps({"step": "error", "progress": -1, "message": "Timeout"})}\n\n'
        finally:
            job.unsubscribe(queue)

    return StreamingResponse(event_stream(), media_type='text/event-stream')


@router.get('/{job_id}/download/zip')
async def download_all_stems(job_id: str):
    """Download all separated stems as a ZIP."""
    job = get_job(job_id)
    if not job or job.status != JobStatus.DONE:
        raise HTTPException(404, 'Job not found or not complete')

    stems_dir = job.output_dir / 'stems'
    if not stems_dir.exists():
        raise HTTPException(404, 'Stems directory not found')

    original_name = job.metadata.get('original_name', 'stems')
    zip_name = f'{original_name} - stems'

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        stem_files = job.metadata.get('stems', {})
        for stem_name, filename in stem_files.items():
            filepath = stems_dir / filename
            if filepath.exists():
                zf.write(filepath, f'{zip_name}/{filename}')
    buf.seek(0)

    return StreamingResponse(
        buf,
        media_type='application/zip',
        headers={'Content-Disposition': f'attachment; filename="{zip_name}.zip"'},
    )


@router.get('/{job_id}/download/{stem}')
async def download_stem(job_id: str, stem: str):
    """Download a single stem file."""
    job = get_job(job_id)
    if not job or job.status != JobStatus.DONE:
        raise HTTPException(404, 'Job not found or not complete')

    stem_files = job.metadata.get('stems', {})

    filename = stem_files.get(stem)
    if not filename:
        filename = stem
        if not any(filename == f for f in stem_files.values()):
            raise HTTPException(404, f'Stem not found: {stem}. Available: {", ".join(stem_files.keys())}')

    filepath = job.output_dir / 'stems' / filename
    if not filepath.exists():
        raise HTTPException(404, 'File not found')

    return FileResponse(filepath, filename=filename)


@router.post('/{job_id}/publish')
async def publish_stems_to_github(job_id: str):
    """Push game-ready stems + song.ini to GitHub SongInbox."""
    job = get_job(job_id)
    if not job or job.status != JobStatus.DONE:
        raise HTTPException(404, 'Job not found or not complete')

    if not job.metadata.get('game_ready'):
        raise HTTPException(400, 'Only game-ready jobs can be published')

    if not settings.github_token:
        raise HTTPException(500, 'GitHub token not configured')

    stems_dir = job.output_dir / 'stems'
    if not stems_dir.exists():
        raise HTTPException(404, 'Stems directory not found')

    # Build folder name from song.ini fields or fall back to original name
    song_ini = job.metadata.get('song_ini', {})
    artist = song_ini.get('artist', '').strip()
    name = song_ini.get('name', '').strip()
    if artist and name:
        folder_name = f'{artist} - {name}'
    else:
        folder_name = job.metadata.get('original_name', job_id)

    # Sanitize
    for ch in ['/', '\\', ':', '"', '<', '>', '|', '?', '*']:
        folder_name = folder_name.replace(ch, '-')

    try:
        commit_url = await publish_song_folder(stems_dir, folder_name)
        return {'commit_url': commit_url, 'folder': f'{settings.github_inbox_prefix}/{folder_name}'}
    except Exception as e:
        raise HTTPException(500, f'GitHub publish failed: {e}')
