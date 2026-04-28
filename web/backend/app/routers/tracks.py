"""Track library endpoints — browse, manage, and generate beatmaps from saved tracks."""

import asyncio
import json
import shutil
import tempfile
from pathlib import Path

from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from ..config import settings
from ..services.audio import resize_to_square_png
from ..services.chart_generator import generate_full_chart
from ..services.game_songs import _parse_song_ini
from ..services.github_publisher import publish_song_folder
from ..services.jobs import JobKind, JobStatus, create_job, get_job
from ..services.stems import DEMUCS_TO_GAME, _convert_to_ogg, write_song_ini
from ..services.tracks import (
    add_beatmap_record,
    create_track,
    delete_beatmap_record,
    delete_track,
    get_beatmap_dir,
    get_track,
    get_track_enriched,
    list_tracks,
    update_track_meta,
)

router = APIRouter(prefix='/api/tracks', tags=['tracks'])


@router.get('')
async def get_all_tracks():
    """List all saved tracks."""
    return list_tracks()


@router.get('/schema/song-ini')
async def get_song_ini_schema():
    """Return the full song.ini field schema for the frontend."""
    return SONG_INI_FIELDS


@router.get('/{track_id}')
async def get_single_track(track_id: str):
    """Get a single track by ID."""
    data = get_track_enriched(track_id)
    if not data:
        raise HTTPException(404, 'Track not found')
    return data


@router.patch('/{track_id}')
async def update_track(
    track_id: str,
    name: str = Form(None),
    artist: str = Form(None),
    album: str = Form(None),
    genre: str = Form(None),
    year: str = Form(None),
):
    """Update track metadata."""
    kwargs = {}
    if name is not None:
        kwargs['name'] = name
    if artist is not None:
        kwargs['artist'] = artist
    if album is not None:
        kwargs['album'] = album
    if genre is not None:
        kwargs['genre'] = genre
    if year is not None:
        kwargs['year'] = year

    track = update_track_meta(track_id, **kwargs)
    if not track:
        raise HTTPException(404, 'Track not found')
    return track.to_dict()


@router.delete('/{track_id}')
async def remove_track(track_id: str):
    """Delete a saved track and its stem files."""
    if not delete_track(track_id):
        raise HTTPException(404, 'Track not found')
    return {'deleted': True}


@router.get('/{track_id}/song-ini')
async def get_track_song_ini(track_id: str):
    """Read the song.ini sitting in the track's stems folder. Returns {} if missing."""
    track = get_track(track_id)
    if not track:
        raise HTTPException(404, 'Track not found')
    path = track.stems_dir / 'song.ini'
    if not path.exists():
        return {}
    return _parse_song_ini(path.read_text(encoding='utf-8'))


@router.patch('/{track_id}/song-ini')
async def update_track_song_ini(
    track_id: str,
    fields: str = Form(...),
    album_art: Optional[UploadFile] = File(None),
):
    """Write song.ini for a track and (optionally) replace album.png."""
    track = get_track(track_id)
    if not track:
        raise HTTPException(404, 'Track not found')
    try:
        ini_fields = json.loads(fields)
    except json.JSONDecodeError:
        raise HTTPException(400, 'fields must be JSON')
    if not isinstance(ini_fields, dict):
        raise HTTPException(400, 'fields must be a JSON object')

    track.stems_dir.mkdir(parents=True, exist_ok=True)
    write_song_ini(track.stems_dir, ini_fields)
    track.stems['song_ini'] = 'song.ini'

    if album_art is not None:
        raw = await album_art.read()
        if raw:
            try:
                png = resize_to_square_png(raw, size=512)
                (track.stems_dir / 'album.png').write_bytes(png)
                track.stems['album_png'] = 'album.png'
            except Exception as ae:
                print(f'[tracks] album.png replace failed: {ae}')

    # Mirror name/artist/album/genre/year into the Track dataclass so the
    # library list and publish logic stay in sync.
    update_track_meta(
        track_id,
        name=ini_fields.get('name', track.name),
        artist=ini_fields.get('artist', track.artist),
        album=ini_fields.get('album', track.album),
        genre=ini_fields.get('genre', track.genre),
        year=ini_fields.get('year', track.year),
    )
    return ini_fields


@router.get('/{track_id}/stems/{stem}')
async def download_track_stem(track_id: str, stem: str):
    """Download a stem file from a saved track."""
    track = get_track(track_id)
    if not track:
        raise HTTPException(404, 'Track not found')

    filename = track.stems.get(stem)
    if not filename:
        raise HTTPException(404, f'Stem not found: {stem}')

    filepath = track.stems_dir / filename
    if not filepath.exists():
        raise HTTPException(404, 'Stem file not found on disk')

    return FileResponse(filepath, filename=filename)


# ── Song.ini field definitions ──────────────────────────────────────────────

SONG_INI_FIELDS = {
    # Metadata
    'name': {'type': 'str', 'default': '', 'label': 'Song Name'},
    'artist': {'type': 'str', 'default': 'Unknown', 'label': 'Artist'},
    'album': {'type': 'str', 'default': 'Unknown', 'label': 'Album'},
    'genre': {'type': 'str', 'default': 'Unknown', 'label': 'Genre'},
    'year': {'type': 'str', 'default': '', 'label': 'Year'},
    'charter': {'type': 'str', 'default': 'Jamsesh', 'label': 'Charter'},
    'loading_phrase': {'type': 'str', 'default': '', 'label': 'Loading Phrase'},
    'icon': {'type': 'str', 'default': '', 'label': 'Icon'},
    'album_track': {'type': 'int', 'default': 0, 'label': 'Album Track #'},
    'playlist_track': {'type': 'int', 'default': 0, 'label': 'Playlist Track #'},
    # Timing
    'delay': {'type': 'int', 'default': 0, 'label': 'Delay (ms)'},
    'preview_start_time': {'type': 'int', 'default': 0, 'label': 'Preview Start (ms)'},
    'video_start_time': {'type': 'int', 'default': 0, 'label': 'Video Start (ms)'},
    'song_length': {'type': 'int', 'default': 0, 'label': 'Song Length (ms)'},
    # Difficulty ratings
    'diff_guitar': {'type': 'int', 'default': -1, 'label': 'Difficulty: Guitar'},
    'diff_rhythm': {'type': 'int', 'default': -1, 'label': 'Difficulty: Rhythm'},
    'diff_bass': {'type': 'int', 'default': -1, 'label': 'Difficulty: Bass'},
    'diff_guitar_coop': {'type': 'int', 'default': -1, 'label': 'Difficulty: Co-op Guitar'},
    'diff_drums': {'type': 'int', 'default': -1, 'label': 'Difficulty: Drums'},
    'diff_drums_real': {'type': 'int', 'default': -1, 'label': 'Difficulty: Pro Drums'},
    'diff_keys': {'type': 'int', 'default': -1, 'label': 'Difficulty: Keys'},
    'diff_guitarghl': {'type': 'int', 'default': -1, 'label': 'Difficulty: GHL Guitar'},
    'diff_bassghl': {'type': 'int', 'default': -1, 'label': 'Difficulty: GHL Bass'},
    # Gameplay
    'hopo_frequency': {'type': 'int', 'default': 0, 'label': 'HOPO Frequency'},
    'sustain_cutoff_threshold': {'type': 'int', 'default': 0, 'label': 'Sustain Cutoff Threshold'},
    'five_lane_drums': {'type': 'bool', 'default': False, 'label': '5-Lane Drums'},
    'modchart': {'type': 'bool', 'default': False, 'label': 'Modchart'},
}


@router.post('/{track_id}/generate-beatmap')
async def generate_beatmap_from_track(
    track_id: str,
    stem: str = Form(...),
    # All song.ini fields as optional form params
    name: str = Form(''),
    artist: str = Form(''),
    album: str = Form(''),
    genre: str = Form(''),
    year: str = Form(''),
    charter: str = Form('Jamsesh'),
    loading_phrase: str = Form(''),
    icon: str = Form(''),
    album_track: int = Form(0),
    playlist_track: int = Form(0),
    delay: int = Form(0),
    preview_start_time: int = Form(0),
    video_start_time: int = Form(0),
    song_length: int = Form(0),
    diff_guitar: int = Form(-1),
    diff_rhythm: int = Form(-1),
    diff_bass: int = Form(-1),
    diff_guitar_coop: int = Form(-1),
    diff_drums: int = Form(-1),
    diff_drums_real: int = Form(-1),
    diff_keys: int = Form(-1),
    diff_guitarghl: int = Form(-1),
    diff_bassghl: int = Form(-1),
    hopo_frequency: int = Form(0),
    sustain_cutoff_threshold: int = Form(0),
    five_lane_drums: bool = Form(False),
    modchart: bool = Form(False),
):
    """Generate a beatmap from a saved track's stem with full song.ini control."""
    track = get_track(track_id)
    if not track:
        raise HTTPException(404, 'Track not found')

    filename = track.stems.get(stem)
    if not filename:
        raise HTTPException(404, f'Stem not found: {stem}')

    stem_path = track.stems_dir / filename
    if not stem_path.exists():
        raise HTTPException(404, 'Stem file not found on disk')

    song_name = name or f'{track.name} ({stem})'
    song_artist = artist or track.artist or 'Unknown'
    song_album = album or track.album or 'Unknown'
    song_genre = genre or track.genre or 'Unknown'
    song_year = year or track.year or ''

    # Collect all song.ini overrides
    ini_overrides = {
        'charter': charter,
        'loading_phrase': loading_phrase,
        'icon': icon,
        'album_track': album_track,
        'playlist_track': playlist_track,
        'delay': delay,
        'preview_start_time': preview_start_time,
        'video_start_time': video_start_time,
        'song_length': song_length,
        'diff_guitar': diff_guitar,
        'diff_rhythm': diff_rhythm,
        'diff_bass': diff_bass,
        'diff_guitar_coop': diff_guitar_coop,
        'diff_drums': diff_drums,
        'diff_drums_real': diff_drums_real,
        'diff_keys': diff_keys,
        'diff_guitarghl': diff_guitarghl,
        'diff_bassghl': diff_bassghl,
        'hopo_frequency': hopo_frequency,
        'sustain_cutoff_threshold': sustain_cutoff_threshold,
        'five_lane_drums': five_lane_drums,
        'modchart': modchart,
    }

    upload_dir = Path(settings.upload_dir)
    bm_title = f'{song_artist} — {song_name} ({stem})' if song_artist and song_artist != 'Unknown' else f'{song_name} ({stem})'
    job = create_job(kind=JobKind.BEATMAP, title=bm_title)
    job.track_id = track_id
    job.metadata['track_id'] = track_id
    job.metadata['stem'] = stem
    job_dir = upload_dir / job.id
    job_dir.mkdir(parents=True)
    job.output_dir = job_dir

    safe_artist = song_artist.replace('/', '-').replace('\\', '-').replace(':', '-').strip()
    safe_title = song_name.replace('/', '-').replace('\\', '-').replace(':', '-').strip()
    folder_name = f'{safe_artist} - {safe_title}'
    job.metadata['folder_name'] = folder_name

    output_dir = job_dir / folder_name

    async def _run():
        job.status = JobStatus.RUNNING
        try:
            result = await generate_full_chart(
                audio_path=str(stem_path),
                output_dir=str(output_dir),
                song_name=song_name,
                artist=song_artist,
                album=song_album,
                year=song_year,
                genre=song_genre,
                ini_overrides=ini_overrides,
                progress_callback=job.send,
            )
            if result is None:
                await job.send_error('No onsets detected in stem audio')
            else:
                add_beatmap_record(
                    track_id=track_id,
                    beatmap_id=job.id,
                    stem=stem,
                    folder_name=folder_name,
                    song_name=song_name,
                    source_dir=output_dir,
                )
                await job.send_done(result)
        except asyncio.CancelledError:
            return
        except Exception as e:
            if job.cancelled:
                return
            import traceback
            print(f'[tracks] Job {job.id} failed: {traceback.format_exc()}')
            await job.send_error(str(e) or 'Unknown error')

    job.task = asyncio.create_task(_run())

    return {'job_id': job.id}


def _parse_song_ini_sections(text: str) -> dict[str, dict[str, str]]:
    """Parse a song.ini, preserving [section] grouping. Lower-cases keys/sections."""
    sections: dict[str, dict[str, str]] = {}
    current = '_root'
    sections[current] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith(('#', ';')):
            continue
        if line.startswith('[') and line.endswith(']'):
            current = line[1:-1].strip().lower()
            sections.setdefault(current, {})
            continue
        if '=' not in line:
            continue
        k, _, v = line.partition('=')
        sections[current][k.strip().lower()] = v.strip()
    return sections


@router.get('/{track_id}/beatmaps/{beatmap_id}/stats')
async def get_beatmap_stats(track_id: str, beatmap_id: str):
    """Return parsed song.ini sections for a generated beatmap."""
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if not bm_dir:
        raise HTTPException(404, 'Beatmap not found')
    ini_path = bm_dir / 'song.ini'
    if not ini_path.exists():
        raise HTTPException(404, 'song.ini missing')
    sections = _parse_song_ini_sections(ini_path.read_text(encoding='utf-8', errors='replace'))
    chart_path = bm_dir / 'notes.chart'
    chart_size = chart_path.stat().st_size if chart_path.exists() else 0
    return {
        'sections': sections,
        'chart_bytes': chart_size,
    }


@router.get('/{track_id}/beatmaps/{beatmap_id}/download/zip')
async def download_beatmap_zip(track_id: str, beatmap_id: str):
    """Download the beatmap folder as a ZIP."""
    import io
    import zipfile

    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if not bm_dir:
        raise HTTPException(404, 'Beatmap not found')

    folder_name = bm_dir.parent.parent.name  # placeholder; we use a record-derived name
    track = get_track(track_id)
    if track:
        rec = next((b for b in track.beatmaps if b.get('id') == beatmap_id), None)
        if rec:
            folder_name = rec.get('folder_name') or folder_name

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for file_path in sorted(bm_dir.iterdir()):
            if file_path.is_file() and not file_path.name.startswith('_'):
                zf.write(file_path, f'{folder_name}/{file_path.name}')
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type='application/zip',
        headers={'Content-Disposition': f'attachment; filename="{folder_name}.zip"'},
    )


@router.get('/{track_id}/beatmaps/{beatmap_id}/download/{filename}')
async def download_beatmap_file(track_id: str, beatmap_id: str, filename: str):
    """Download a single file (notes.chart, song.ogg, song.ini, album.png) from a beatmap."""
    if '/' in filename or '\\' in filename or filename.startswith('.'):
        raise HTTPException(400, 'Invalid filename')
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if not bm_dir:
        raise HTTPException(404, 'Beatmap not found')
    fp = bm_dir / filename
    if not fp.exists() or not fp.is_file():
        raise HTTPException(404, 'File not found')
    return FileResponse(str(fp), filename=filename)


@router.get('/{track_id}/beatmaps/{beatmap_id}/chart')
async def get_beatmap_chart(track_id: str, beatmap_id: str):
    """Return notes.chart as raw text for the editor."""
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if not bm_dir:
        raise HTTPException(404, 'Beatmap not found')
    chart_path = bm_dir / 'notes.chart'
    if not chart_path.exists():
        raise HTTPException(404, 'notes.chart missing')
    return {'chart': chart_path.read_text(encoding='utf-8', errors='replace')}


@router.put('/{track_id}/beatmaps/{beatmap_id}/chart')
async def put_beatmap_chart(track_id: str, beatmap_id: str, body: dict):
    """Overwrite notes.chart with edited text from the editor."""
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if not bm_dir:
        raise HTTPException(404, 'Beatmap not found')
    text = body.get('chart')
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(400, 'body.chart must be a non-empty string')
    if len(text) > 5_000_000:
        raise HTTPException(413, 'Chart too large')
    chart_path = bm_dir / 'notes.chart'
    chart_path.write_text(text, encoding='utf-8')
    return {'ok': True, 'bytes': len(text)}


@router.delete('/{track_id}/beatmaps/{beatmap_id}')
async def remove_beatmap(track_id: str, beatmap_id: str):
    """Delete a beatmap record and its files."""
    if not delete_beatmap_record(track_id, beatmap_id):
        raise HTTPException(404, 'Beatmap not found')
    return {'ok': True}


@router.post('/{track_id}/publish-game')
async def publish_track_to_game(
    track_id: str,
    song_ini: str = Form(...),
):
    """Convert track stems to game format, write song.ini, and publish to GitHub SongInbox."""
    track = get_track(track_id)
    if not track:
        raise HTTPException(404, 'Track not found')

    if not settings.github_token:
        raise HTTPException(500, 'GitHub token not configured')

    ini_fields = json.loads(song_ini)
    artist = ini_fields.get('artist', '').strip()
    name = ini_fields.get('name', '').strip()
    if not name:
        raise HTTPException(400, 'Song name is required')

    folder_name = f'{artist} - {name}' if artist else name
    for ch in ['/', '\\', ':', '"', '<', '>', '|', '?', '*']:
        folder_name = folder_name.replace(ch, '-')

    # Build game-ready files in a temp directory
    tmp_dir = Path(tempfile.mkdtemp(prefix='jamsesh_publish_'))
    NON_AUDIO_KEYS = {'song_ini', 'album_png'}
    try:
        # Convert each stem to ogg with game naming
        for stem_name, filename in track.stems.items():
            if stem_name in NON_AUDIO_KEYS:
                continue
            src = track.stems_dir / filename
            if not src.exists():
                continue
            game_name = DEMUCS_TO_GAME.get(stem_name, stem_name)
            dst = tmp_dir / f'{game_name}.ogg'
            # If already ogg with correct name, just copy
            if src.suffix == '.ogg' and src.stem == game_name:
                shutil.copy2(str(src), str(dst))
            else:
                await _convert_to_ogg(src, dst)

        # Carry album.png across to the published folder if the track has one
        album_src = track.stems_dir / 'album.png'
        if album_src.exists():
            shutil.copy2(str(album_src), str(tmp_dir / 'album.png'))

        # Create song.ogg (full mix) by mixing all stems with ffmpeg
        ogg_stems = sorted(tmp_dir.glob('*.ogg'))
        if ogg_stems and not (tmp_dir / 'song.ogg').exists():
            inputs = []
            for s in ogg_stems:
                inputs += ['-i', str(s)]
            mix_cmd = [
                'ffmpeg', '-y', *inputs,
                '-filter_complex', f'amix=inputs={len(ogg_stems)}:duration=longest:normalize=0',
                '-c:a', 'libvorbis', '-q:a', '6',
                str(tmp_dir / 'song.ogg'),
            ]
            proc = await asyncio.create_subprocess_exec(
                *mix_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await proc.communicate()

        # Write song.ini
        write_song_ini(tmp_dir, ini_fields)

        # Publish to GitHub
        commit_url = await publish_song_folder(tmp_dir, folder_name)
        return {'commit_url': commit_url, 'folder': f'{settings.github_inbox_prefix}/{folder_name}'}
    except Exception as e:
        raise HTTPException(500, f'Publish failed: {e}')
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
