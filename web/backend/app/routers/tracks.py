"""Track library endpoints — browse, manage, and generate beatmaps from saved tracks."""

import asyncio
import json
import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, Form, HTTPException
from fastapi.responses import FileResponse, StreamingResponse

from ..config import settings
from ..services.chart_generator import generate_full_chart
from ..services.github_publisher import publish_song_folder
from ..services.jobs import JobStatus, create_job, get_job
from ..services.stems import DEMUCS_TO_GAME, _convert_to_ogg, write_song_ini
from ..services.tracks import create_track, delete_track, get_track, list_tracks, update_track_meta

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
    track = get_track(track_id)
    if not track:
        raise HTTPException(404, 'Track not found')
    return track.to_dict()


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
    job = create_job()
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
                await job.send_done(result)
        except Exception as e:
            import traceback
            print(f'[tracks] Job {job.id} failed: {traceback.format_exc()}')
            await job.send_error(str(e) or 'Unknown error')

    asyncio.create_task(_run())

    return {'job_id': job.id}


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
    try:
        # Convert each stem to ogg with game naming
        for stem_name, filename in track.stems.items():
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
