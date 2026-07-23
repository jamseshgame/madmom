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
from ..services.separators import (
    DEFAULT_ENGINE,
    ENGINES,
    audio_separator_catalog,
    default_params,
    engine_catalog,
    separate_with_engine,
)
from ..services.stems import (
    DEMUCS_TO_GAME,
    MODEL_STEMS,
    _convert_to_ogg,
    _mix_to_ogg,
    _write_peaks_file,
    write_song_ini,
)
from ..services.github_publisher import publish_song_folder
from ..services.jobs import JobKind, JobStatus, create_job, get_job
from ..services.tracks import create_track

router = APIRouter(prefix='/api/stems', tags=['stems'])

ALLOWED_EXTENSIONS = {'.flac', '.mp3', '.ogg', '.wav', '.m4a', '.aac', '.wma'}


@router.get('/models')
async def list_models():
    """Return the Demucs models and their stem lists."""
    return MODEL_STEMS


@router.get('/engines')
async def list_engines():
    """Separation engines, their full parameter schemas, and max-quality defaults.

    The frontend renders every knob straight off this payload, so a new
    parameter added to ``services.separators.ENGINES`` shows up in the UI with
    no frontend change.
    """
    catalog = audio_separator_catalog()
    return {
        'engines': engine_catalog(),
        'default_engine': DEFAULT_ENGINE,
        'defaults': {key: default_params(key) for key in ENGINES},
        'demucs_models': MODEL_STEMS,
        'audio_separator': catalog,
    }


@router.get('/engines/models')
async def list_separator_models(refresh: bool = False):
    """Live audio-separator checkpoint catalog (Roformer / MDX-Net / VR / Demucs)."""
    return audio_separator_catalog(refresh=refresh)


@router.post('/separate')
async def start_separation(
    file: UploadFile,
    engine: str = Form(DEFAULT_ENGINE),
    params: str = Form(''),
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
    """Upload audio and start stem separation. Returns job_id for SSE tracking.

    ``params`` is a JSON object of engine-specific settings (see
    ``GET /api/stems/engines``). The individual ``model``/``shifts``/``overlap``
    /``clip_mode``/``segment`` form fields predate the multi-engine split and
    are kept as a fallback for older clients: they seed the Demucs parameters
    when ``params`` does not already carry them.
    """
    ext = Path(file.filename or '').suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f'Unsupported format: {ext}. Use: {", ".join(sorted(ALLOWED_EXTENSIONS))}')

    if engine not in ENGINES:
        raise HTTPException(400, f'Unknown engine: {engine}. Use: {", ".join(ENGINES)}')

    if params.strip():
        try:
            engine_params = json.loads(params)
        except json.JSONDecodeError:
            raise HTTPException(400, 'params must be a JSON object')
        if not isinstance(engine_params, dict):
            raise HTTPException(400, 'params must be a JSON object')
    else:
        engine_params = {}

    # Legacy form fields only fill gaps — an explicit params entry always wins.
    legacy = {
        'model': model,
        'output_format': output_format,
        'mp3_bitrate': mp3_bitrate,
        'shifts': shifts,
        'overlap': overlap,
        'clip_mode': clip_mode,
    }
    if segment.strip():
        legacy['segment'] = int(segment)
    for key, value in legacy.items():
        engine_params.setdefault(key, value)

    if engine == 'demucs' and engine_params.get('model') not in MODEL_STEMS:
        raise HTTPException(
            400, f'Unknown Demucs model: {engine_params.get("model")}. Use: {", ".join(MODEL_STEMS)}',
        )

    # Parse stems list
    stem_list = [s.strip() for s in stems.split(',') if s.strip()] or None

    upload_dir = Path(settings.upload_dir)
    upload_dir.mkdir(parents=True, exist_ok=True)

    original_name = Path(file.filename or 'audio').stem
    job = create_job(kind=JobKind.SEPARATE, title=original_name)
    job_dir = upload_dir / job.id
    job_dir.mkdir()
    job.output_dir = job_dir

    audio_path = job_dir / f'input{ext}'
    content = await file.read()
    if len(content) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, f'File too large. Max {settings.max_upload_mb} MB.')
    audio_path.write_bytes(content)

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
            result = await separate_with_engine(
                audio_path=str(audio_path),
                output_dir=str(job_dir / 'stems'),
                engine=engine,
                params=engine_params,
                stems=stem_list,
                game_ready=game_ready,
                progress_callback=job.send,
                set_process=lambda p: setattr(job, 'process', p),
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
        except asyncio.CancelledError:
            # cancel() already published the cancelled event + flipped status
            return
        except Exception as e:
            if job.cancelled:
                return
            import traceback
            err_msg = str(e) or traceback.format_exc().splitlines()[-1]
            print(f'[stems] Job {job.id} failed: {traceback.format_exc()}')
            await job.send_error(err_msg)

    job.task = asyncio.create_task(_run())

    return {'job_id': job.id}


@router.post('/manual')
async def manual_stems(
    file: Optional[UploadFile] = File(None),
    vocals: Optional[UploadFile] = File(None),
    drums: Optional[UploadFile] = File(None),
    bass: Optional[UploadFile] = File(None),
    guitar: Optional[UploadFile] = File(None),
    piano: Optional[UploadFile] = File(None),
    other: Optional[UploadFile] = File(None),
    song_ini: Optional[str] = Form(None),
    album_art: Optional[UploadFile] = File(None),
):
    """Package user-supplied stems into a game-ready folder.

    If a master `file` is supplied it becomes song.ogg. Otherwise the
    provided stems are summed with ffmpeg amix to synthesise song.ogg,
    so users with stems-only sources can still produce a valid game folder.
    """
    has_master = file is not None and file.filename
    if has_master:
        ext = Path(file.filename or '').suffix.lower()
        if ext not in ALLOWED_EXTENSIONS:
            raise HTTPException(400, f'Unsupported master format: {ext}')
    else:
        ext = ''

    stem_uploads = {
        'vocals': vocals,
        'drums': drums,
        'bass': bass,
        'guitar': guitar,
        'piano': piano,
        'other': other,
    }
    provided = {k: v for k, v in stem_uploads.items() if v is not None and v.filename}
    if not provided:
        raise HTTPException(400, 'At least one stem file is required')
    if not has_master and len(provided) < 2:
        raise HTTPException(400, 'Need at least 2 stems to synthesise song.ogg')

    upload_dir = Path(settings.upload_dir)
    upload_dir.mkdir(parents=True, exist_ok=True)

    job = create_job(kind=JobKind.MANUAL_STEMS, title='')
    job_dir = upload_dir / job.id
    job_dir.mkdir()
    job.output_dir = job_dir

    # Save master if provided
    master_path: Optional[Path] = None
    if has_master:
        master_bytes = await file.read()
        if len(master_bytes) > settings.max_upload_mb * 1024 * 1024:
            raise HTTPException(413, f'Master file too large. Max {settings.max_upload_mb} MB.')
        master_path = job_dir / f'input{ext}'
        master_path.write_bytes(master_bytes)
        original_name = Path(file.filename or 'audio').stem
    else:
        # Derive a fallback name from the song.ini if present, else the first stem
        original_name = ''
        if song_ini:
            try:
                _ini = json.loads(song_ini)
                fallback = f"{(_ini.get('artist') or '').strip()} - {(_ini.get('name') or '').strip()}".strip(' -')
                if fallback != '-' and fallback:
                    original_name = fallback
            except Exception:
                pass
        if not original_name:
            first_stem = next(iter(provided.values()))
            original_name = Path(first_stem.filename or 'stems-only').stem

    job.metadata['original_name'] = original_name
    job.title = original_name

    # Save uploaded stems to a staging dir
    staging = job_dir / '_uploaded_stems'
    staging.mkdir()
    saved: dict[str, Path] = {}
    for stem_name, upload in provided.items():
        s_ext = Path(upload.filename or '').suffix.lower() or '.wav'
        if s_ext not in ALLOWED_EXTENSIONS:
            raise HTTPException(400, f'Unsupported {stem_name} format: {s_ext}')
        data = await upload.read()
        if len(data) > settings.max_upload_mb * 1024 * 1024:
            raise HTTPException(413, f'{stem_name} file too large. Max {settings.max_upload_mb} MB.')
        path = staging / f'{stem_name}{s_ext}'
        path.write_bytes(data)
        saved[stem_name] = path

    # Album art
    album_png_bytes: Optional[bytes] = None
    if album_art is not None:
        raw = await album_art.read()
        if raw:
            try:
                album_png_bytes = resize_to_square_png(raw, size=512)
            except Exception as ae:
                print(f'[stems/manual] album_art resize failed: {ae}')

    out_dir = job_dir / 'stems'
    out_dir.mkdir()

    async def _run():
        job.status = JobStatus.RUNNING
        try:
            stems_to_convert = list(saved.items())
            total_steps = len(stems_to_convert) + 1  # +1 for master → song.ogg
            game_stems: dict[str, str] = {}

            for idx, (stem_name, src_path) in enumerate(stems_to_convert, 1):
                game_name = DEMUCS_TO_GAME.get(stem_name, stem_name)
                pct = int(85 * idx / total_steps)
                await job.send('convert', pct, f'Converting stem {idx}/{total_steps} → {game_name}.ogg')
                ogg_path = out_dir / f'{game_name}.ogg'
                await _convert_to_ogg(src_path, ogg_path)
                game_stems[game_name] = ogg_path.name

            # song.ogg — either convert the supplied master, or mux the stems
            song_ogg = out_dir / 'song.ogg'
            if master_path is not None:
                await job.send('convert', 90, f'Converting master {total_steps}/{total_steps} → song.ogg')
                await _convert_to_ogg(master_path, song_ogg)
            else:
                await job.send('convert', 90, f'Mixing {len(stems_to_convert)} stems → song.ogg')
                await _mix_to_ogg([p for _, p in stems_to_convert], song_ogg)
            game_stems['song'] = 'song.ogg'

            # song.ini
            if song_ini:
                try:
                    ini_fields = json.loads(song_ini)
                    write_song_ini(out_dir, ini_fields)
                    game_stems['song_ini'] = 'song.ini'
                    job.metadata['song_ini'] = ini_fields
                except Exception as ie:
                    print(f'[stems/manual] song.ini write failed: {ie}')

            # album.png
            if album_png_bytes:
                try:
                    (out_dir / 'album.png').write_bytes(album_png_bytes)
                    game_stems['album_png'] = 'album.png'
                except Exception as ae:
                    print(f'[stems/manual] album.png write failed: {ae}')

            # Precompute waveform peaks (parity with the Demucs /separate
            # flow) so the result page skips an in-browser Web Audio decode.
            try:
                audio_stems = {
                    k: v for k, v in game_stems.items() if k not in ('song_ini', 'album_png')
                }
                await _write_peaks_file(audio_stems, out_dir, job.send)
            except Exception as pe:
                print(f'[stems/manual] peaks computation failed: {pe}')

            job.metadata['stems'] = game_stems
            job.metadata['game_ready'] = True
            job.metadata['model'] = 'manual'
            job.metadata['output_format'] = 'ogg'

            # Persist as track
            try:
                track = create_track(
                    name=original_name,
                    stems=game_stems,
                    source_stems_dir=out_dir,
                    model='manual',
                    output_format='ogg',
                )
                job.metadata['track_id'] = track.id
            except Exception as te:
                print(f'[stems/manual] Track save failed: {te}')

            await job.send_done(job.metadata)
        except asyncio.CancelledError:
            return
        except Exception as e:
            if job.cancelled:
                return
            import traceback
            err_msg = str(e) or 'Manual stems processing failed'
            print(f'[stems/manual] Job {job.id} failed: {traceback.format_exc()}')
            await job.send_error(err_msg)

    job.task = asyncio.create_task(_run())
    return {'job_id': job.id}


@router.patch('/{job_id}/song-ini')
async def update_job_song_ini(
    job_id: str,
    fields: str = Form(...),
    album_art: Optional[UploadFile] = File(None),
):
    """Rewrite song.ini for a completed job and (optionally) replace album.png."""
    job = get_job(job_id)
    if not job or not job.output_dir:
        raise HTTPException(404, 'Job not found')
    try:
        ini_fields = json.loads(fields)
    except json.JSONDecodeError:
        raise HTTPException(400, 'fields must be JSON')
    if not isinstance(ini_fields, dict):
        raise HTTPException(400, 'fields must be a JSON object')

    stems_dir = job.output_dir / 'stems'
    if not stems_dir.exists():
        raise HTTPException(404, 'Stems directory not found for job')

    write_song_ini(stems_dir, ini_fields)
    job.metadata['song_ini'] = ini_fields

    if album_art is not None:
        raw = await album_art.read()
        if raw:
            try:
                png = resize_to_square_png(raw, size=512)
                (stems_dir / 'album.png').write_bytes(png)
                stems = job.metadata.setdefault('stems', {})
                stems['album_png'] = 'album.png'
            except Exception as ae:
                print(f'[stems] album.png replace failed: {ae}')
    return ini_fields


@router.post('/{job_id}/cancel')
async def cancel_separation(job_id: str):
    """Kill the running demucs subprocess for this job and stop the worker."""
    job = get_job(job_id)
    if not job:
        raise HTTPException(404, 'Job not found')
    if job.status not in (JobStatus.QUEUED, JobStatus.RUNNING):
        return {'cancelled': False, 'status': job.status.value}
    await job.cancel()
    return {'cancelled': True, 'status': job.status.value}


@router.get('/{job_id}/status')
async def separation_status(job_id: str):
    """SSE stream of separation progress.

    Replays the stored event log first (so refreshing the tab catches up), then
    streams live events. The dedicated ``/api/jobs/{id}/events`` endpoint does
    the same thing for any job kind — this is kept as a backward-compatible alias.
    """
    job = get_job(job_id)
    if not job:
        raise HTTPException(404, 'Job not found')

    queue = job.subscribe()

    async def event_stream():
        try:
            while True:
                event = await asyncio.wait_for(queue.get(), timeout=900)
                if event is None:
                    break
                yield f'data: {json.dumps(event)}\n\n'
        except asyncio.TimeoutError:
            yield f'data: {json.dumps({"step": "error", "progress": -1, "message": "Idle timeout"})}\n\n'
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


@router.get('/{job_id}/peaks')
async def get_peaks(job_id: str):
    """Precomputed waveform peaks per stem so the frontend can skip Web Audio."""
    job = get_job(job_id)
    if not job or job.status != JobStatus.DONE:
        raise HTTPException(404, 'Job not found or not complete')
    peaks_path = job.output_dir / 'stems' / 'peaks.json'
    if not peaks_path.exists():
        raise HTTPException(404, 'Peaks not available')
    return FileResponse(peaks_path, media_type='application/json')


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
