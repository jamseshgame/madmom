"""Beatmap creation, status, download, and publish endpoints."""

import asyncio
import io
import json
import zipfile
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from ..config import settings
from ..services.audio import read_audio_metadata
from ..services.chart_generator import generate_full_chart
from ..services.github_publisher import publish_song_folder
from ..services.jobs import JobStatus, create_job, get_job

router = APIRouter(prefix='/api/beatmap', tags=['beatmap'])

ALLOWED_EXTENSIONS = {'.flac', '.mp3', '.ogg', '.wav'}


@router.post('/metadata')
async def extract_metadata(file: UploadFile):
    """Upload audio and return extracted metadata (title, artist, album, year, genre)."""
    ext = Path(file.filename or '').suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f'Unsupported format: {ext}')

    upload_dir = Path(settings.upload_dir)
    upload_dir.mkdir(parents=True, exist_ok=True)

    # Save to temp file for ffprobe
    import tempfile
    tmp = upload_dir / f'_meta_probe{ext}'
    content = await file.read()
    tmp.write_bytes(content)
    try:
        meta = read_audio_metadata(str(tmp))
    finally:
        tmp.unlink(missing_ok=True)

    basename = Path(file.filename or 'audio').stem.replace('.', ' ').replace('_', ' ').strip()
    return {
        'title': meta.get('title') or basename,
        'artist': meta.get('artist') or '',
        'album': meta.get('album') or '',
        'year': meta.get('year') or '',
        'genre': meta.get('genre') or '',
    }


@router.post('/create')
async def create_beatmap(
    file: UploadFile,
    title: str | None = None,
    artist: str | None = None,
    album: str | None = None,
    year: str | None = None,
    genre: str | None = None,
):
    """Upload audio and start chart generation. Returns job_id for SSE tracking."""
    ext = Path(file.filename or '').suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f'Unsupported format: {ext}. Use: {", ".join(ALLOWED_EXTENSIONS)}')

    # Save uploaded file
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

    # Read metadata from file, override with form values
    meta = read_audio_metadata(str(audio_path))
    basename = Path(file.filename or 'audio').stem.replace('.', ' ').replace('_', ' ').strip()
    song_name = title or meta.get('title') or basename
    song_artist = artist or meta.get('artist') or 'Unknown'
    song_album = album or meta.get('album') or 'Unknown'
    song_year = year or meta.get('year') or 'Unknown'
    song_genre = genre or meta.get('genre') or 'Unknown'

    safe_artist = song_artist.replace('/', '-').replace('\\', '-').replace(':', '-').strip()
    safe_title = song_name.replace('/', '-').replace('\\', '-').replace(':', '-').strip()
    folder_name = f'{safe_artist} - {safe_title}'

    output_dir = job_dir / folder_name
    job.metadata['folder_name'] = folder_name

    # Launch generation in background
    async def _run():
        job.status = JobStatus.RUNNING
        try:
            result = await generate_full_chart(
                audio_path=str(audio_path),
                output_dir=str(output_dir),
                song_name=song_name,
                artist=song_artist,
                album=song_album,
                year=song_year,
                genre=song_genre,
                progress_callback=job.send,
            )
            if result is None:
                await job.send_error('No onsets detected in audio')
            else:
                await job.send_done(result)
        except Exception as e:
            await job.send_error(str(e))

    asyncio.create_task(_run())

    return {'job_id': job.id}


@router.get('/{job_id}/status')
async def beatmap_status(job_id: str):
    """SSE stream of generation progress."""
    job = get_job(job_id)
    if not job:
        raise HTTPException(404, 'Job not found')

    queue = job.subscribe()

    async def event_stream():
        try:
            # Send current status if already done
            if job.status == JobStatus.DONE:
                yield f'data: {json.dumps({"step": "done", "progress": 100, "message": "Complete", "metadata": job.metadata})}\n\n'
                return
            if job.status == JobStatus.FAILED:
                yield f'data: {json.dumps({"step": "error", "progress": -1, "message": job.error or "Failed"})}\n\n'
                return

            while True:
                event = await asyncio.wait_for(queue.get(), timeout=300)
                if event is None:
                    break
                yield f'data: {json.dumps(event)}\n\n'
        except asyncio.TimeoutError:
            yield f'data: {json.dumps({"step": "error", "progress": -1, "message": "Timeout"})}\n\n'
        finally:
            job.unsubscribe(queue)

    return StreamingResponse(event_stream(), media_type='text/event-stream')


@router.get('/{job_id}/download/zip')
async def download_zip(job_id: str):
    """Download the generated song folder as a ZIP."""
    job = get_job(job_id)
    if not job or job.status != JobStatus.DONE:
        raise HTTPException(404, 'Job not found or not complete')

    folder_name = job.metadata.get('folder_name', job_id)
    song_dir = job.output_dir / folder_name

    if not song_dir.exists():
        raise HTTPException(404, 'Output directory not found')

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for file_path in sorted(song_dir.iterdir()):
            if file_path.is_file() and not file_path.name.startswith('_'):
                zf.write(file_path, f'{folder_name}/{file_path.name}')
    buf.seek(0)

    return StreamingResponse(
        buf,
        media_type='application/zip',
        headers={'Content-Disposition': f'attachment; filename="{folder_name}.zip"'},
    )


@router.get('/{job_id}/download/{filename}')
async def download_file(job_id: str, filename: str):
    """Download a single file from the output folder."""
    job = get_job(job_id)
    if not job or job.status != JobStatus.DONE:
        raise HTTPException(404, 'Job not found or not complete')

    folder_name = job.metadata.get('folder_name', job_id)
    file_path = job.output_dir / folder_name / filename

    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(404, 'File not found')

    return FileResponse(file_path, filename=filename)


@router.post('/{job_id}/publish')
async def publish_to_github(job_id: str):
    """Push generated song folder to GitHub SongInbox."""
    job = get_job(job_id)
    if not job or job.status != JobStatus.DONE:
        raise HTTPException(404, 'Job not found or not complete')

    if not settings.github_token:
        raise HTTPException(500, 'GitHub token not configured')

    folder_name = job.metadata.get('folder_name', job_id)
    song_dir = job.output_dir / folder_name

    if not song_dir.exists():
        raise HTTPException(404, 'Output directory not found')

    try:
        commit_url = await publish_song_folder(song_dir, folder_name)
        return {'commit_url': commit_url, 'folder': f'{settings.github_inbox_prefix}/{folder_name}'}
    except Exception as e:
        raise HTTPException(500, f'GitHub publish failed: {e}')
