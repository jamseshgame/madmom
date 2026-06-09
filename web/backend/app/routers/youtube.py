"""YouTube search + audio-as-MP3 download.

Search returns lightweight metadata. Download is wrapped as a Job so progress
streams via the universal /api/jobs/{id}/events SSE endpoint and the user can
close the tab and come back to a still-running download.
"""

import asyncio
import contextlib
import re
import shutil
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from ..config import settings
from ..routers.auth import require_auth
from ..services import youtube_cookies as yc
from ..services.jobs import JobKind, JobStatus, create_job, get_job

router = APIRouter(prefix='/api/youtube', tags=['youtube'])

# Upper bound on length we'll fetch — keeps the UI responsive and the disk sane.
_MAX_DURATION_SECONDS = 30 * 60  # 30 minutes
_VIDEO_ID_RE = re.compile(r'^[A-Za-z0-9_-]{6,32}$')


@contextlib.contextmanager
def _ytdl_session_opts(username: str | None = None):
    """Shared yt-dlp options applied to every call (search + download).

    Cookies resolve per-user file → global YOUTUBE_COOKIES_FILE → none,
    and yt-dlp gets a disposable copy (see yc.ytdlp_cookiefile) — never
    the canonical file, which its on-close jar save would overwrite.

    Without cookies, force the Android InnerTube player client first
    (web stays as a fallback) — more permissive about anonymous access
    and often slips past the bot wall on its own. With cookies, leave
    yt-dlp's default client list alone: android doesn't support cookies
    (yt-dlp skips it), and the defaults are tuned for authed sessions.
    """
    with yc.ytdlp_cookiefile(username) as cookiefile:
        opts: dict[str, Any] = {}
        if cookiefile:
            opts['cookiefile'] = cookiefile
        else:
            opts['extractor_args'] = {'youtube': {'player_client': ['android', 'web']}}
        yield opts


def _bot_wall_hint(msg: str, username: str | None) -> str:
    """Append an actionable hint when YouTube's bot check bites."""
    if 'Sign in to confirm' not in msg and 'not a bot' not in msg.lower():
        return msg
    if yc.cookies_status(username).get('signed_in'):
        return msg + (
            "\n\nYouTube has flagged this server's IP and rejected the cookies on "
            'file (the session may have been invalidated). Export a fresh '
            'cookies.txt from a private/incognito window — then close that window '
            "so the browser can't rotate the session — and upload it via Replace "
            'under "YouTube cookies".'
        )
    return msg + (
        "\n\nYouTube has flagged this server's IP and the cookies on file no "
        'longer carry a signed-in session. Export a fresh cookies.txt from a '
        'private/incognito window — then close that window — and upload it via '
        'Replace under "YouTube cookies".'
    )


@router.get('/search')
async def search_youtube(
    q: str,
    limit: int = 10,
    user: dict = Depends(require_auth),
) -> list[dict[str, Any]]:
    """Search YouTube for the query and return up to `limit` results.

    Uses yt-dlp's `ytsearch<n>:` virtual URL with extract_flat — no full extract
    per video, so this is one HTTP round trip and finishes in 1–2 seconds.
    """
    q = (q or '').strip()
    if not q:
        raise HTTPException(400, 'Query required')
    limit = max(1, min(limit, 25))

    import yt_dlp

    def _search() -> list[dict[str, Any]]:
        with _ytdl_session_opts(user.get('username')) as session_opts:
            opts = {
                **session_opts,
                'quiet': True,
                'no_warnings': True,
                'extract_flat': True,
                'skip_download': True,
                'default_search': 'ytsearch',
            }
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(f'ytsearch{limit}:{q}', download=False)
        return info.get('entries', []) or []

    try:
        entries = await asyncio.to_thread(_search)
    except Exception as e:
        raise HTTPException(502, _bot_wall_hint(f'YouTube search failed: {e}', user.get('username')))

    results = []
    for e in entries:
        if not e:
            continue
        vid = e.get('id') or ''
        # extract_flat sometimes returns the thumbnails list, sometimes a single
        # 'thumbnail' field. Pick whichever is available.
        thumb = e.get('thumbnail')
        if not thumb:
            thumbs = e.get('thumbnails') or []
            if thumbs:
                thumb = thumbs[-1].get('url') if isinstance(thumbs[-1], dict) else None
        if not thumb and vid:
            thumb = f'https://i.ytimg.com/vi/{vid}/hqdefault.jpg'
        results.append({
            'video_id': vid,
            'title': e.get('title') or '',
            'channel': e.get('uploader') or e.get('channel') or '',
            'duration': int(e.get('duration') or 0),
            'thumbnail': thumb or '',
            'url': e.get('url') or (f'https://www.youtube.com/watch?v={vid}' if vid else ''),
        })
    return results


@router.post('/download')
async def start_youtube_download(
    video_id: str = Form(...),
    user: dict = Depends(require_auth),
):
    """Kick off a yt-dlp download + MP3 extract as a Job. Returns job_id for
    the universal SSE / status endpoints to track."""
    video_id = (video_id or '').strip()
    if not _VIDEO_ID_RE.match(video_id):
        raise HTTPException(400, 'Invalid video_id')

    upload_dir = Path(settings.upload_dir)
    upload_dir.mkdir(parents=True, exist_ok=True)

    job = create_job(kind=JobKind.YOUTUBE, title=f'YouTube {video_id}')
    job_dir = upload_dir / job.id
    job_dir.mkdir()
    job.output_dir = job_dir
    job.metadata['video_id'] = video_id

    async def _run() -> None:
        try:
            import yt_dlp

            await job.send('init', 5, f'Resolving https://youtube.com/watch?v={video_id}')

            # We need to bridge yt-dlp's progress callbacks (called from a
            # worker thread) onto the async loop so they reach the SSE queue.
            # asyncio.run_coroutine_threadsafe + the running loop is the
            # standard pattern.
            loop = asyncio.get_running_loop()

            def _hook(d: dict) -> None:
                status = d.get('status', '')
                if status == 'downloading':
                    total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
                    got = d.get('downloaded_bytes') or 0
                    pct = 10 + int(70 * got / total) if total else 10
                    pct = max(10, min(80, pct))
                    eta = d.get('eta')
                    eta_s = f' · ETA {eta}s' if eta else ''
                    msg = f'Downloading audio · {got // 1024} KiB' + (f' / {total // 1024} KiB' if total else '') + eta_s
                    asyncio.run_coroutine_threadsafe(
                        job.send('download', pct, msg), loop,
                    )
                elif status == 'finished':
                    asyncio.run_coroutine_threadsafe(
                        job.send('convert', 85, 'Extracting MP3 with ffmpeg…'), loop,
                    )

            def _download() -> dict[str, Any]:
                with _ytdl_session_opts(user.get('username')) as session_opts:
                    opts = {
                        **session_opts,
                        'format': 'bestaudio/best',
                        'outtmpl': str(job_dir / '%(title).200B.%(ext)s'),
                        'quiet': True,
                        'no_warnings': True,
                        'noprogress': True,
                        'progress_hooks': [_hook],
                        'postprocessors': [{
                            'key': 'FFmpegExtractAudio',
                            'preferredcodec': 'mp3',
                            'preferredquality': '320',
                        }],
                    }
                    with yt_dlp.YoutubeDL(opts) as ydl:
                        info = ydl.extract_info(
                            f'https://www.youtube.com/watch?v={video_id}',
                            download=True,
                        )
                if isinstance(info, dict):
                    return info
                return {}

            info = await asyncio.to_thread(_download)
            if job.cancelled:
                return

            duration = int(info.get('duration') or 0)
            if duration > _MAX_DURATION_SECONDS:
                # Don't waste disk on hour-long videos. Bail with a clear error.
                shutil.rmtree(job_dir, ignore_errors=True)
                await job.send_error(f'Video is {duration // 60} min — limit is {_MAX_DURATION_SECONDS // 60} min')
                return

            mp3_files = list(job_dir.glob('*.mp3'))
            if not mp3_files:
                await job.send_error('MP3 conversion failed — no .mp3 in output')
                return
            mp3_path = mp3_files[0]

            title = info.get('title') or video_id
            uploader = info.get('uploader') or info.get('channel') or ''

            job.metadata.update({
                'title': title,
                'uploader': uploader,
                'duration': duration,
                'filename': mp3_path.name,
                'size_bytes': mp3_path.stat().st_size,
            })
            job.title = title

            await job.send_done({
                'video_id': video_id,
                'title': title,
                'uploader': uploader,
                'duration': duration,
                'filename': mp3_path.name,
                'size_bytes': mp3_path.stat().st_size,
            })
        except asyncio.CancelledError:
            return
        except Exception as e:
            if job.cancelled:
                return
            import traceback
            print(f'[youtube] Job {job.id} failed: {traceback.format_exc()}')
            msg = _bot_wall_hint(str(e) or 'YouTube download failed', user.get('username'))
            await job.send_error(msg)

    job.task = asyncio.create_task(_run())
    return {'job_id': job.id}


@router.get('/{job_id}/file')
async def download_youtube_file(job_id: str):
    """Return the MP3 produced by a completed YouTube job."""
    job = get_job(job_id)
    if not job:
        raise HTTPException(404, 'Job not found')
    if job.status != JobStatus.DONE:
        raise HTTPException(409, f'Job is {job.status.value}, not done')
    if not job.output_dir or not job.output_dir.exists():
        raise HTTPException(404, 'Job output directory missing')

    filename: Optional[str] = job.metadata.get('filename')
    if filename:
        path = job.output_dir / filename
    else:
        # Fallback: any mp3 under the job dir
        candidates = list(job.output_dir.glob('*.mp3'))
        path = candidates[0] if candidates else None
    if not path or not path.exists():
        raise HTTPException(404, 'MP3 file not found on disk')

    return FileResponse(
        path,
        media_type='audio/mpeg',
        filename=path.name,
    )


# ── Per-user cookies management ────────────────────────────────────────────

@router.get('/cookies')
async def get_cookies_status(user: dict = Depends(require_auth)) -> dict[str, Any]:
    """Return whether the current user has uploaded YouTube cookies + when."""
    status = yc.cookies_status(user.get('username'))
    # Tell the UI if the global fallback is configured so it can show a
    # different empty-state message ("server-wide cookies in use" vs.
    # "no cookies — searches may be blocked").
    status['global_fallback_configured'] = bool(
        (settings.youtube_cookies_file or '').strip()
        and Path(settings.youtube_cookies_file).is_file()
    )
    return status


@router.post('/cookies')
async def upload_cookies(
    file: UploadFile = File(...),
    user: dict = Depends(require_auth),
) -> dict[str, Any]:
    """Upload a Netscape-format cookies.txt. Replaces any previous file."""
    if file.size and file.size > 1_000_000:
        # Netscape cookies.txt for a YouTube session is ~10 KB. 1 MB is a
        # generous ceiling that catches misuploads (whole-profile JSON,
        # screenshots, etc.).
        raise HTTPException(413, 'cookies file too large (max 1 MB)')
    content = await file.read()
    try:
        return yc.save_cookies(user['username'], content)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete('/cookies')
async def delete_cookies(user: dict = Depends(require_auth)) -> dict[str, Any]:
    """Remove the current user's cookies file, if any."""
    removed = yc.delete_cookies(user['username'])
    return {'removed': removed, 'has_cookies': False}
