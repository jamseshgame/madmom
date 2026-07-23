"""Track library endpoints — browse, manage, and generate beatmaps from saved tracks."""

import asyncio
import json
import re
import shutil
import tempfile
import uuid
from pathlib import Path

from typing import Optional

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse

from ..config import settings
from ..services.audio import compute_audio_peaks, resize_to_square_png
from ..services.crop_audio import crop_song_ogg
from ..services.chart_generator import chart_difficulties, generate_full_chart
from ..services.game_songs import _parse_song_ini
from ..services.github_publisher import publish_song_folder
from ..services.jobs import JobKind, JobStatus, create_job, get_job
from ..services import lyrics as lyrics_service
from ..services import sample_packs
from ..services.separators import DEFAULT_ENGINE, ENGINES, separate_with_engine
from ..services.stems import DEMUCS_TO_GAME, _convert_to_ogg, write_song_ini
from ..services.tracks import (
    add_beatmap_record,
    CloneDifficultyError,
    clone_beatmap_record,
    clone_difficulty_across_beatmaps,
    create_draft_track,
    create_track,
    delete_beatmap_record,
    delete_track,
    get_beatmap_dir,
    get_track,
    get_track_enriched,
    list_tracks,
    promote_draft,
    read_elevenlabs_voice,
    rename_beatmap_record,
    set_active_beatmap,
    set_beatmap_included,
    update_track_meta,
    write_elevenlabs_voice,
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


DRAFT_AUDIO_EXTENSIONS = {'.flac', '.mp3', '.ogg', '.wav', '.m4a', '.aac', '.wma'}


@router.post('/draft')
async def create_track_draft(
    file: UploadFile,
    name: str = Form(''),
    artist: str = Form(''),
    album: str = Form(''),
    genre: str = Form(''),
    year: str = Form(''),
    youtube_source_url: str = Form(''),
):
    """Stage master audio as a resumable draft track, before separation.

    The Create page calls this as soon as audio is staged — a YouTube pull or
    a picked file — so the work survives closing the tab. Previously the
    downloaded MP3 lived only as a File object in the browser, and abandoning
    the settings screen discarded it with nothing left to resume from.
    """
    ext = Path(file.filename or '').suffix.lower()
    if ext not in DRAFT_AUDIO_EXTENSIONS:
        raise HTTPException(
            400, f'Unsupported format: {ext}. Use: {", ".join(sorted(DRAFT_AUDIO_EXTENSIONS))}',
        )

    content = await file.read()
    if not content:
        raise HTTPException(400, 'Empty audio file')
    if len(content) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, f'File too large. Max {settings.max_upload_mb} MB.')

    track = create_draft_track(
        name=(name.strip() or Path(file.filename or 'audio').stem),
        audio_bytes=content,
        audio_filename=file.filename or 'audio.mp3',
        artist=artist.strip(),
        album=album.strip(),
        genre=genre.strip(),
        year=year.strip(),
        youtube_source_url=youtube_source_url.strip(),
    )
    return track.to_dict()


@router.get('/{track_id}/source')
async def download_track_source(track_id: str):
    """Stream the untouched master a track was created from."""
    track = get_track(track_id)
    if not track:
        raise HTTPException(404, 'Track not found')
    path = track.source_path
    if path is None:
        raise HTTPException(404, 'No source audio stored for this track')
    return FileResponse(path, filename=path.name)


@router.post('/{track_id}/separate')
async def separate_track(
    track_id: str,
    engine: str = Form(DEFAULT_ENGINE),
    params: str = Form(''),
    stems: str = Form(''),
    song_ini: Optional[str] = Form(None),
    album_art: Optional[UploadFile] = File(None),
):
    """Run stem separation on a track's stored master. Returns a job_id.

    This is what "Resume" on a draft ultimately calls. It also works on an
    already-separated track (the master is kept), so a track can be re-split
    with a different engine without re-uploading — the old stems are replaced.
    """
    track = get_track(track_id)
    if not track:
        raise HTTPException(404, 'Track not found')
    source = track.source_path
    if source is None:
        raise HTTPException(
            400,
            'This track has no stored master audio to separate. It predates draft '
            'support — re-import the song from the Create page.',
        )
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

    stem_list = [s.strip() for s in stems.split(',') if s.strip()] or None

    ini_fields: Optional[dict] = None
    if song_ini:
        try:
            parsed = json.loads(song_ini)
            if isinstance(parsed, dict):
                ini_fields = parsed
        except json.JSONDecodeError:
            raise HTTPException(400, 'song_ini must be JSON')

    album_png_bytes: Optional[bytes] = None
    if album_art is not None:
        raw = await album_art.read()
        if raw:
            try:
                album_png_bytes = resize_to_square_png(raw, size=512)
            except Exception as ae:
                print(f'[tracks] album_art resize failed: {ae}')

    job = create_job(kind=JobKind.SEPARATE, title=track.name)
    job.output_dir = track.dir
    job.metadata['track_id'] = track.id
    job.metadata['original_name'] = track.name

    async def _run():
        job.status = JobStatus.RUNNING
        try:
            result = await separate_with_engine(
                audio_path=str(source),
                output_dir=str(track.stems_dir),
                engine=engine,
                params=engine_params,
                stems=stem_list,
                game_ready=True,
                progress_callback=job.send,
                set_process=lambda p: setattr(job, 'process', p),
            )

            if ini_fields is not None:
                write_song_ini(track.stems_dir, ini_fields)
                result['stems']['song_ini'] = 'song.ini'
                job.metadata['song_ini'] = ini_fields
            if album_png_bytes:
                (track.stems_dir / 'album.png').write_bytes(album_png_bytes)
                result['stems']['album_png'] = 'album.png'

            # Re-load rather than reusing the closed-over Track: the user may
            # have edited metadata from the library while separation ran.
            fresh = get_track(track_id) or track
            promote_draft(
                fresh,
                stems=result['stems'],
                model=result.get('model', engine),
                output_format=result.get('output_format', 'ogg'),
            )
            job.metadata.update(result)
            job.metadata['track_id'] = fresh.id
            await job.send_done(job.metadata)
        except asyncio.CancelledError:
            return
        except Exception as e:
            if job.cancelled:
                return
            import traceback
            print(f'[tracks] Separation job {job.id} failed: {traceback.format_exc()}')
            await job.send_error(str(e) or 'Separation failed')

    job.task = asyncio.create_task(_run())
    return {'job_id': job.id, 'track_id': track.id}


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
    """Write song.ini for a track and (optionally) replace album.png.

    Important: all mutations land on a single Track instance which is then
    saved exactly once. Earlier versions called update_track_meta after
    mutating track.stems locally; that helper does a fresh Track.load()
    which loses the in-memory stems mutation, so a newly-uploaded album.png
    file would land on disk but never be referenced from track.json — the
    library would then render the row as having no art."""
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

    # Mirror metadata fields into the Track dataclass so the library list
    # and publish logic stay in sync — same instance, single save below.
    for key in ('name', 'artist', 'album', 'genre', 'year'):
        val = ini_fields.get(key)
        if val is not None:
            setattr(track, key, val)
    track.save()
    return ini_fields


# ── Background video (editor's Background panel) ────────────────────────────
# Stored alongside the stems under `<track_dir>/background.<ext>` so it's
# scoped per-track. Filename is also written to song.ini's [background]
# section so the editor can re-discover it after a reload.

_BG_VIDEO_EXTS = {'.mp4', '.webm', '.mov', '.m4v', '.ogv'}


def _existing_bg_video(track) -> Optional[Path]:
    """Find any background.<ext> file already present on disk."""
    for ext in _BG_VIDEO_EXTS:
        p = track.stems_dir / f'background{ext}'
        if p.exists():
            return p
    return None


@router.post('/{track_id}/background-video')
async def upload_background_video(track_id: str, file: UploadFile = File(...)):
    """Upload a video file the editor can play behind the highway. Overwrites
    any previously-uploaded background video for this track."""
    track = get_track(track_id)
    if not track:
        raise HTTPException(404, 'Track not found')
    ext = Path(file.filename or '').suffix.lower()
    if ext not in _BG_VIDEO_EXTS:
        raise HTTPException(400, f'Unsupported video format: {ext}')
    track.stems_dir.mkdir(parents=True, exist_ok=True)
    # Wipe any prior file regardless of extension before writing the new one.
    for old_ext in _BG_VIDEO_EXTS:
        old = track.stems_dir / f'background{old_ext}'
        if old.exists() and old.suffix != ext:
            old.unlink(missing_ok=True)
    out = track.stems_dir / f'background{ext}'
    raw = await file.read()
    out.write_bytes(raw)
    return {'filename': out.name, 'size_bytes': len(raw)}


@router.get('/{track_id}/background-video')
async def download_background_video(track_id: str):
    track = get_track(track_id)
    if not track:
        raise HTTPException(404, 'Track not found')
    p = _existing_bg_video(track)
    if not p:
        raise HTTPException(404, 'No background video uploaded')
    media = {
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mov': 'video/quicktime',
        '.m4v': 'video/x-m4v',
        '.ogv': 'video/ogg',
    }.get(p.suffix.lower(), 'application/octet-stream')
    return FileResponse(p, media_type=media, filename=p.name)


@router.delete('/{track_id}/background-video')
async def delete_background_video(track_id: str):
    track = get_track(track_id)
    if not track:
        raise HTTPException(404, 'Track not found')
    p = _existing_bg_video(track)
    if p:
        p.unlink(missing_ok=True)
    return {'ok': True}


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
    'five_lane_drums': {'type': 'bool', 'default': True, 'label': '5-Lane Drums'},
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
    five_lane_drums: bool = Form(True),
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
                stem=stem,
            )
            if result is None:
                await job.send_error('No onsets detected in stem audio')
            else:
                try:
                    from importlib.metadata import version as _pkg_version
                    _madmom_version = _pkg_version('madmom')
                except Exception:
                    _madmom_version = None
                add_beatmap_record(
                    track_id=track_id,
                    beatmap_id=job.id,
                    stem=stem,
                    folder_name=folder_name,
                    song_name=song_name,
                    source_dir=output_dir,
                    model='madmom',
                    model_version=_madmom_version,
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


@router.post('/{track_id}/generate-beatmap-v2')
async def generate_beatmap_v2(
    track_id: str,
    stem: str = Form(...),
    # song.ini fields (same shape as legacy endpoint)
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
    five_lane_drums: bool = Form(True),
    modchart: bool = Form(False),
    # V2 pipeline engine selections
    onsets_engine: str = Form('librosa-onset'),
    onsets_params: str = Form('{}'),
    pitches_engine: str = Form('yin'),
    pitches_params: str = Form('{}'),
    quantized_engine: str = Form('metric-weighted'),
    quantized_params: str = Form('{}'),
    lanes_engine: str = Form('section-sliding'),
    lanes_params: str = Form('{}'),
    playability_engine: str = Form('identity'),
    playability_params: str = Form('{}'),
    # Optional preset name — recorded on the beatmap so the picker badges it
    preset: str = Form(''),
):
    """Generate a beatmap by driving the V2 staged pipeline end-to-end.

    Unlike `/generate-beatmap` (legacy), this endpoint runs each V2 stage in
    sequence with the caller-selected engines and writes the final
    notes.chart via the V2 serializer. All stems including drums go through
    V2 with single-hit semantics — V2 lane engines emit sustain=0 and no
    slide notes by design, matching what the legacy single_hits_only flag
    produced for drums.
    """
    import json as _json

    track = get_track(track_id)
    if not track:
        raise HTTPException(404, 'Track not found')
    filename = track.stems.get(stem)
    if not filename:
        raise HTTPException(404, f'Stem not found: {stem}')
    stem_path = track.stems_dir / filename
    if not stem_path.exists():
        raise HTTPException(404, 'Stem file not found on disk')

    def _parse(field_name: str, raw: str) -> dict:
        try:
            return _json.loads(raw or '{}')
        except _json.JSONDecodeError as e:
            raise HTTPException(400, f'{field_name} is not valid JSON: {e}')

    engine_params = {
        'onsets': (onsets_engine, _parse('onsets_params', onsets_params)),
        'pitches': (pitches_engine, _parse('pitches_params', pitches_params)),
        'quantized': (quantized_engine, _parse('quantized_params', quantized_params)),
        'lanes_expert': (lanes_engine, _parse('lanes_params', lanes_params)),
        'lanes_filtered': (playability_engine, _parse('playability_params', playability_params)),
    }

    song_name = name or f'{track.name} ({stem})'
    song_artist = artist or track.artist or 'Unknown'
    song_album = album or track.album or 'Unknown'
    song_genre = genre or track.genre or 'Unknown'
    song_year = year or track.year or ''

    ini_overrides = {
        'charter': charter, 'loading_phrase': loading_phrase, 'icon': icon,
        'album_track': album_track, 'playlist_track': playlist_track,
        'delay': delay, 'preview_start_time': preview_start_time,
        'video_start_time': video_start_time, 'song_length': song_length,
        'diff_guitar': diff_guitar, 'diff_rhythm': diff_rhythm,
        'diff_bass': diff_bass, 'diff_guitar_coop': diff_guitar_coop,
        'diff_drums': diff_drums, 'diff_drums_real': diff_drums_real,
        'diff_keys': diff_keys, 'diff_guitarghl': diff_guitarghl,
        'diff_bassghl': diff_bassghl, 'hopo_frequency': hopo_frequency,
        'sustain_cutoff_threshold': sustain_cutoff_threshold,
        'five_lane_drums': five_lane_drums, 'modchart': modchart,
    }

    upload_dir = Path(settings.upload_dir)
    bm_title = f'{song_artist} — {song_name} ({stem})' if song_artist and song_artist != 'Unknown' else f'{song_name} ({stem})'
    job = create_job(kind=JobKind.BEATMAP, title=bm_title)
    job.track_id = track_id
    job.metadata['track_id'] = track_id
    job.metadata['stem'] = stem
    job.metadata['pipeline'] = 'v2'
    job_dir = upload_dir / job.id
    job_dir.mkdir(parents=True)
    job.output_dir = job_dir

    safe_artist = song_artist.replace('/', '-').replace('\\', '-').replace(':', '-').strip()
    safe_title = song_name.replace('/', '-').replace('\\', '-').replace(':', '-').strip()
    folder_name = f'{safe_artist} - {safe_title}'
    job.metadata['folder_name'] = folder_name
    output_dir = job_dir / folder_name

    async def _run():
        from ..services.pipeline.registry import Stage
        from ..services.pipeline.runner import run_stage
        from ..services.pipeline.storage import stage_path
        from ..services.pipeline.serialize import serialize_chart
        from ..services.audio import convert_to_ogg
        from ..services.chart_generator import write_chart_song_ini
        from ..services import tracks as tracks_mod

        job.status = JobStatus.RUNNING
        loop = asyncio.get_running_loop()

        def make_on_progress(stage_lo: int, stage_hi: int):
            def cb(step: str, pct: int, msg: str) -> None:
                mapped = int(stage_lo + (stage_hi - stage_lo) * (max(0, min(100, pct)) / 100))
                asyncio.run_coroutine_threadsafe(job.send(step, mapped, msg), loop)
            return cb

        try:
            td = tracks_mod.TRACKS_DIR / track_id

            # S1: Grid (track-level) — reuse if active.json exists
            grid_p = stage_path(td, Stage.GRID, None)
            if not grid_p.exists():
                await job.send('grid', 2, 'Computing tempo grid…')
                await loop.run_in_executor(None, lambda: run_stage(
                    Stage.GRID, td, None, 'librosa-beat', {},
                    make_on_progress(2, 10),
                ))

            # Stem-scoped stages
            stages = [
                (Stage.ONSETS, *engine_params['onsets'], 10, 25, 'Detecting onsets'),
                (Stage.PITCHES, *engine_params['pitches'], 25, 45, 'Estimating pitches'),
                (Stage.QUANTIZED, *engine_params['quantized'], 45, 55, 'Quantising to grid'),
                (Stage.LANES_EXPERT, *engine_params['lanes_expert'], 55, 70, 'Mapping lanes (Expert)'),
                (Stage.LANES_FILTERED, *engine_params['lanes_filtered'], 70, 78, 'Filtering for playability'),
            ]
            for st, eng, p, lo, hi, label in stages:
                await job.send(st.value, lo, label + '…')
                await loop.run_in_executor(None, lambda st=st, eng=eng, p=p, lo=lo, hi=hi: run_stage(
                    st, td, stem, eng, p, make_on_progress(lo, hi),
                ))

            # S7: difficulties — defaults, run once (writes all three sub-stages)
            await job.send('lanes_hard', 78, 'Building Hard/Medium/Easy…')
            await loop.run_in_executor(None, lambda: run_stage(
                Stage.LANES_HARD, td, stem, 'metric-weight', {},
                make_on_progress(78, 90),
            ))

            # S8: build chart
            await job.send('build', 90, 'Writing notes.chart…')
            grid = _json.loads(grid_p.read_text())
            lanes_per_difficulty: dict[str, dict] = {}
            filtered_p = stage_path(td, Stage.LANES_FILTERED, stem)
            expert_p = stage_path(td, Stage.LANES_EXPERT, stem)
            lanes_per_difficulty['ExpertSingle'] = _json.loads(
                (filtered_p if filtered_p.exists() else expert_p).read_text()
            )
            for diff_section, st in (
                ('HardSingle', Stage.LANES_HARD),
                ('MediumSingle', Stage.LANES_MEDIUM),
                ('EasySingle', Stage.LANES_EASY),
            ):
                p = stage_path(td, st, stem)
                if p.exists():
                    lanes_per_difficulty[diff_section] = _json.loads(p.read_text())

            chart_text = serialize_chart(
                grid=grid, lanes_per_difficulty=lanes_per_difficulty,
                song_name=song_name, resolution=int(grid['resolution']),
                collapse_wide=(stem != 'drums'),
            )
            output_dir.mkdir(parents=True, exist_ok=True)
            chart_path = str(output_dir / 'notes.chart')
            Path(chart_path).write_text(chart_text, encoding='utf-8')

            # Audio
            await job.send('convert', 94, 'Converting audio to song.ogg…')
            ogg_path = str(output_dir / 'song.ogg')
            await loop.run_in_executor(None, lambda: convert_to_ogg(str(stem_path), ogg_path))

            # song.ini
            await job.send('finalize', 97, 'Writing song.ini…')
            write_chart_song_ini(
                out_dir=output_dir, chart_path=chart_path,
                song_name=song_name, artist=song_artist, album=song_album,
                genre=song_genre, year=song_year, ini_overrides=ini_overrides,
            )

            # Register beatmap record
            try:
                from importlib.metadata import version as _pkg_version
                _madmom_version = _pkg_version('madmom')
            except Exception:
                _madmom_version = None
            model_version = f'{_madmom_version}+v2' if _madmom_version else 'v2'
            add_beatmap_record(
                track_id=track_id, beatmap_id=job.id, stem=stem,
                folder_name=folder_name, song_name=song_name,
                source_dir=output_dir,
                model='madmom', model_version=model_version,
                preset=(preset.strip() or None),
            )
            await job.send_done({
                'chart_path': chart_path, 'ogg_path': ogg_path,
                'song_name': song_name, 'artist': song_artist,
                'folder_name': folder_name,
            })
        except asyncio.CancelledError:
            return
        except Exception as e:  # noqa: BLE001
            if not job.cancelled:
                await job.send_error(str(e) or 'V2 pipeline failed')

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


@router.get('/{track_id}/beatmaps/{beatmap_id}/song-peaks')
async def get_beatmap_song_peaks(track_id: str, beatmap_id: str, bucket_ms: int = 20):
    """Per-bucket peak amplitudes for a beatmap's song.ogg, as a Float32
    binary blob. The editor's WaveformStrip reads this directly into a
    Float32Array. Cached on disk per beatmap; re-extracted when the
    source audio is newer than the cache.
    """
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        raise HTTPException(404, 'Beatmap not found')
    audio_path = bm_dir / 'song.ogg'
    if not audio_path.exists():
        raise HTTPException(404, 'song.ogg missing for this beatmap')
    cache_path = bm_dir / 'song.peaks.f32'
    if cache_path.exists() and cache_path.stat().st_mtime >= audio_path.stat().st_mtime:
        return Response(content=cache_path.read_bytes(), media_type='application/octet-stream')
    try:
        blob = compute_audio_peaks(audio_path, bucket_ms=bucket_ms)
    except RuntimeError as e:
        raise HTTPException(500, f'Peak extraction failed: {e}')
    cache_path.write_bytes(blob)
    return Response(content=blob, media_type='application/octet-stream')


@router.post('/{track_id}/beatmaps/{beatmap_id}/crop-audio')
async def crop_beatmap_audio(track_id: str, beatmap_id: str, body: dict):
    """Crop song.ogg to end just after the last charted event, plus padding_ms.
    Overwrites song.ogg and updates song_length in song.ini."""
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        raise HTTPException(404, 'Beatmap not found')
    if not (bm_dir / 'song.ogg').exists():
        raise HTTPException(404, 'song.ogg missing for this beatmap')
    padding_ms = int(body.get('padding_ms', 0) or 0)
    try:
        return crop_song_ogg(bm_dir, padding_ms)
    except ValueError:
        raise HTTPException(400, 'No events to crop to')
    except (RuntimeError, OSError) as e:
        raise HTTPException(500, f'Crop failed: {e}')


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


_SYNCTRACK_BLOCK_RE = re.compile(r'\[SyncTrack\]\s*\{[^}]*\}')
_OFFSET_LINE_RE = re.compile(r'(?m)^(\s*Offset\s*=\s*)-?[0-9]*\.?[0-9]+\s*$')
_RESOLUTION_LINE_RE = re.compile(r'(?m)^(\s*Resolution\s*=\s*\d+[^\n]*\n)')
_SONG_OPEN_RE = re.compile(r'(\[Song\]\s*\{)')


def _apply_synctrack(text: str, sync_block: str) -> str:
    """Replace the [SyncTrack] block, or insert it if the chart has none."""
    if _SYNCTRACK_BLOCK_RE.search(text):
        return _SYNCTRACK_BLOCK_RE.sub(lambda _m: sync_block, text, count=1)
    # No [SyncTrack] — slot it in just before [Events] (its canonical spot),
    # else append. Mirrors the editor's applySyncTrackToFullText placement.
    idx = text.find('[Events]')
    if idx >= 0:
        return text[:idx] + sync_block + '\n' + text[idx:]
    return text + ('' if text.endswith('\n') else '\n') + sync_block + '\n'


def _apply_offset(text: str, offset_val: str) -> str:
    """Replace the [Song] Offset line, or insert it if the chart has none."""
    if _OFFSET_LINE_RE.search(text):
        return _OFFSET_LINE_RE.sub(lambda _m: _m.group(1) + offset_val, text, count=1)
    line = f'  Offset = {offset_val}\n'
    # No Offset line — insert after Resolution inside [Song], else right after
    # the [Song] open brace. Mirrors the editor's applyOffsetToFullText.
    if _RESOLUTION_LINE_RE.search(text):
        return _RESOLUTION_LINE_RE.sub(lambda _m: _m.group(1) + line, text, count=1)
    if _SONG_OPEN_RE.search(text):
        return _SONG_OPEN_RE.sub(lambda _m: _m.group(1) + '\n' + line.rstrip('\n'), text, count=1)
    return text


_TICK0_B_RE = re.compile(r'(?m)^\s*0\s*=\s*B\s+(\d+)')


def _first_micro_bpm(text: str) -> int | None:
    """The tick-0 tempo (``0 = B <micro_bpm>``) from a chart's [SyncTrack], or
    None if the chart carries no tick-0 tempo marker."""
    m = _TICK0_B_RE.search(text)
    return int(m.group(1)) if m else None


def _octave_ratio(prev_micro: int, new_micro: int) -> float | None:
    """If ``new_micro`` is ~2x or ~0.5x ``prev_micro`` (the classic tap-on-the-
    off-beat / octave-detection mistake), return the raw ratio; else None. A big
    tempo change is *also* how a legitimate octave fix looks, so this only warns
    — it never blocks."""
    if not prev_micro or not new_micro:
        return None
    ratio = new_micro / prev_micro
    if 1.8 <= ratio <= 2.2 or 0.45 <= ratio <= 0.55:
        return ratio
    return None


def _backup_chart(chart_path: Path) -> None:
    """Snapshot the current notes.chart to a sibling ``.autobak`` before it's
    overwritten, so a bad tempo save is always reversible. Rolling single copy
    (each backup overwrites the previous). No-op if the file doesn't exist yet."""
    if chart_path.exists():
        try:
            shutil.copy2(str(chart_path), str(chart_path) + '.autobak')
        except OSError as e:
            print(f'[tracks] autobak failed for {chart_path}: {e}')


def _save_chart_with_backup(chart_path: Path, text: str) -> None:
    """Write notes.chart, backing up the prior content to ``.autobak`` first."""
    _backup_chart(chart_path)
    chart_path.write_text(text, encoding='utf-8')


def _propagate_tempo_to_siblings(track_id: str, source_id: str, source_text: str) -> dict:
    """Copy the just-saved beatmap's [SyncTrack] block and [Song] Offset onto
    every sibling beatmap of the track.

    All of a track's beatmaps are meant to share one tempo grid, and the
    publish-time merge (chart_generator.merge_beatmap_charts) takes [SyncTrack]
    from whichever beatmap it processes first. So a tempo/offset edit on one
    beatmap that *isn't* mirrored to its siblings can ship a stale tempo in the
    merged chart — which plays correctly in the editor (you're viewing the
    edited beatmap) but drifts in-game.

    Siblings that are *missing* a [SyncTrack] block or Offset line get one
    inserted (not just replaced) so a freshly generated instrument chart can't
    silently keep a stale/zero offset or tempo grid.

    Every overwritten sibling is snapshotted to ``.autobak`` first — a single
    bad save (e.g. an octave-doubled BPM) rewrites every chart on the track at
    once, and this makes that reversible. Returns ``{'synced': [ids],
    'octave_warning': {...} | None}``; the warning fires when the propagated
    tempo is ~2x/~0.5x a sibling's previous tempo so the UI can surface it.
    """
    sync_m = _SYNCTRACK_BLOCK_RE.search(source_text)
    if not sync_m:
        return {'synced': [], 'octave_warning': None}
    sync_block = sync_m.group(0)  # full "[SyncTrack]\n{ ... }"
    off_m = re.search(r'Offset\s*=\s*(-?[0-9]*\.?[0-9]+)', source_text)
    offset_val = off_m.group(1) if off_m else None
    new_micro = _first_micro_bpm(source_text)

    track = get_track(track_id)
    if track is None:
        return {'synced': [], 'octave_warning': None}
    synced: list[str] = []
    octave_ratio: float | None = None
    for bm in track.beatmaps:
        bid = bm.get('id')
        if not bid or bid == source_id:
            continue
        cp = track.beatmaps_dir / bid / 'notes.chart'
        if not cp.exists():
            continue
        original = cp.read_text(encoding='utf-8', errors='replace')
        updated = _apply_synctrack(original, sync_block)
        if offset_val is not None:
            updated = _apply_offset(updated, offset_val)
        if updated != original:
            if new_micro is not None:
                ratio = _octave_ratio(_first_micro_bpm(original) or 0, new_micro)
                if ratio is not None:
                    octave_ratio = ratio
            _backup_chart(cp)
            cp.write_text(updated, encoding='utf-8')
            synced.append(bid)
    warning = (
        {'factor': octave_ratio, 'new_micro_bpm': new_micro, 'synced': synced}
        if octave_ratio is not None
        else None
    )
    return {'synced': synced, 'octave_warning': warning}


@router.put('/{track_id}/beatmaps/{beatmap_id}/chart')
async def put_beatmap_chart(track_id: str, beatmap_id: str, body: dict):
    """Overwrite notes.chart with edited text from the editor, then mirror the
    tempo grid ([SyncTrack] + [Song] Offset) onto the track's other beatmaps so
    the published merge can't ship a stale, drifting tempo."""
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if not bm_dir:
        raise HTTPException(404, 'Beatmap not found')
    text = body.get('chart')
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(400, 'body.chart must be a non-empty string')
    if len(text) > 5_000_000:
        raise HTTPException(413, 'Chart too large')
    chart_path = bm_dir / 'notes.chart'
    _save_chart_with_backup(chart_path, text)
    prop = _propagate_tempo_to_siblings(track_id, beatmap_id, text)
    return {
        'ok': True,
        'bytes': len(text),
        'tempo_synced_to': prop['synced'],
        'tempo_octave_warning': prop['octave_warning'],
    }


@router.delete('/{track_id}/beatmaps/{beatmap_id}')
async def remove_beatmap(track_id: str, beatmap_id: str):
    """Delete a beatmap record and its files."""
    if not delete_beatmap_record(track_id, beatmap_id):
        raise HTTPException(404, 'Beatmap not found')
    return {'ok': True}


@router.patch('/{track_id}/beatmaps/{beatmap_id}')
async def rename_beatmap(
    track_id: str,
    beatmap_id: str,
    song_name: str = Form(...),
):
    """Rename a beatmap. Updates the song_name on the track record and the
    [Song] name in the beatmap's song.ini + notes.chart so the new title
    propagates into anything downstream that reads either file."""
    record = rename_beatmap_record(track_id, beatmap_id, song_name)
    if record is None:
        raise HTTPException(404, 'Beatmap not found, or song_name was empty')
    return record


@router.post('/{track_id}/beatmaps/{beatmap_id}/clone')
async def clone_beatmap(track_id: str, beatmap_id: str):
    """Duplicate this beatmap into a new editable copy. Useful for keeping a
    pristine generated chart alongside hand-edited variants."""
    record = clone_beatmap_record(track_id, beatmap_id)
    if record is None:
        raise HTTPException(404, 'Source beatmap not found')
    return record


@router.post('/{track_id}/beatmaps/{beatmap_id}/activate')
async def activate_beatmap(track_id: str, beatmap_id: str):
    """Mark this beatmap as the active one for its stem. The publish flow uses
    the active beatmap per stem when no per-stem override is supplied."""
    record = set_active_beatmap(track_id, beatmap_id)
    if record is None:
        raise HTTPException(404, 'Beatmap not found')
    return record


@router.post('/{track_id}/beatmaps/{beatmap_id}/included')
async def toggle_beatmap_included(
    track_id: str,
    beatmap_id: str,
    included: bool = Body(..., embed=True),
):
    """Mark whether this beatmap is included in the published chart.

    Multiple beatmaps per stem can be included simultaneously — they appear
    as numbered alternates in notes.chart. Unchecking excludes a beatmap
    from publish without deleting it."""
    record = set_beatmap_included(track_id, beatmap_id, included)
    if record is None:
        raise HTTPException(404, 'Beatmap not found')
    return record


@router.get('/{track_id}/beatmaps/{beatmap_id}/difficulties')
async def list_beatmap_difficulties(track_id: str, beatmap_id: str):
    """List the difficulty sections present in a beatmap's notes.chart, with a
    note count per section. Drives the clone-difficulty picker (which source
    difficulties exist) and the overwrite warning (does the target slot already
    have notes)."""
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if not bm_dir:
        raise HTTPException(404, 'Beatmap not found')
    chart_path = bm_dir / 'notes.chart'
    if not chart_path.exists():
        return {'difficulties': []}
    text = chart_path.read_text(encoding='utf-8', errors='replace')
    return {'difficulties': chart_difficulties(text)}


@router.post('/{track_id}/beatmaps/{target_id}/clone-difficulty')
async def clone_beatmap_difficulty(
    track_id: str,
    target_id: str,
    source_beatmap_id: str = Body(...),
    source_difficulty: str = Body(...),
    target_difficulty: str = Body(...),
):
    """Copy one difficulty from `source_beatmap_id` into this (`target_id`)
    beatmap's chart, under `target_difficulty`. Both beatmaps must be on the
    same stem. Overwrites the target difficulty in place."""
    if not get_beatmap_dir(track_id, target_id):
        raise HTTPException(404, 'Beatmap not found')
    try:
        result = clone_difficulty_across_beatmaps(
            track_id, source_beatmap_id, source_difficulty, target_id, target_difficulty
        )
    except CloneDifficultyError as exc:
        raise HTTPException(422, str(exc))
    if result is None:
        raise HTTPException(404, 'Source beatmap or notes.chart not found')
    return result


@router.post('/{track_id}/empty-beatmap')
async def create_empty_beatmap_for_track(
    track_id: str,
    stem: str = Form('guitar'),
    bpm: int = Form(120),
    tutorial: bool = Form(False),
):
    """Create a beatmap on an existing track with no auto-generated notes —
    just an empty notes.chart, so the user can land in the editor and author
    from scratch (manual charting, tutorial-only beatmap, etc.).

    The chosen stem's audio is reused as the beatmap's song.ogg.
    """
    track = get_track(track_id)
    if not track:
        raise HTTPException(404, 'Track not found')

    bpm = max(40, min(int(bpm or 120), 240))
    artist = (track.artist or 'Unknown').strip() or 'Unknown'
    base_name = (track.name or 'Untitled').strip() or 'Untitled'
    bm_name = f'{base_name} (empty)'

    upload_dir = Path(settings.upload_dir)
    upload_dir.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='empty_bm_', dir=str(upload_dir)))
    try:
        bm_src = staging / 'bm'
        bm_src.mkdir()

        # Resolve the stem's filename (or fall back to the master mix) and
        # copy it in as the beatmap's song.ogg so the editor's audio scrubber
        # has something to play.
        candidate_stems = [stem, 'song']
        src_audio: Path | None = None
        for s in candidate_stems:
            fname = track.stems.get(s)
            if not fname:
                continue
            p = track.stems_dir / fname
            if p.exists():
                src_audio = p
                break
        if src_audio is None:
            raise HTTPException(404, f'No audio found for stem "{stem}" on this track')

        # If the stem isn't already an OGG, transcode on the way in
        if src_audio.suffix.lower() == '.ogg':
            shutil.copy2(str(src_audio), str(bm_src / 'song.ogg'))
        else:
            proc = await asyncio.create_subprocess_exec(
                'ffmpeg', '-y', '-i', str(src_audio),
                '-vn', '-c:a', 'libvorbis', '-q:a', '6',
                str(bm_src / 'song.ogg'),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            _, err = await proc.communicate()
            if proc.returncode != 0 or not (bm_src / 'song.ogg').exists():
                raise HTTPException(500, f'ffmpeg transcode failed: {err.decode("utf-8", errors="replace")[-300:]}')

        # Empty chart with the user's BPM. [TutorialScript] placeholder
        # appears whenever tutorial=True so the editor lands with the
        # tutorial sidebar already on.
        bpm_milli = int(bpm * 1000)
        chart_text = (
            '[Song]\n{\n'
            f'  Name = "{bm_name}"\n'
            f'  Artist = "{artist}"\n'
            '  Charter = "Jamsesh"\n'
            '  Offset = 0\n'
            '  Resolution = 192\n'
            '  Player2 = bass\n'
            '  Difficulty = 0\n'
            '  PreviewStart = 0\n'
            '  PreviewEnd = 0\n'
            f'  Genre = "{(track.genre or "").strip()}"\n'
            '  MediaType = "cd"\n'
            '  MusicStream = "song.ogg"\n'
            '}\n'
            '[SyncTrack]\n{\n'
            '  0 = TS 4\n'
            f'  0 = B {bpm_milli}\n'
            '}\n'
            '[Events]\n{\n}\n'
            '[ExpertSingle]\n{\n}\n'
            + ('[TutorialScript]\n{\n}\n' if tutorial else '')
        )
        (bm_src / 'notes.chart').write_text(chart_text, encoding='utf-8')

        ini_lines = [
            '[song]',
            f'name = {bm_name}',
            f'artist = {artist}',
            f'album = {(track.album or "").strip()}',
            f'genre = {(track.genre or "").strip()}',
            f'year = {(track.year or "").strip()}',
            'charter = Jamsesh',
            'preview_start_time = 0',
            'delay = 0',
            'loading_phrase =',
        ]
        if tutorial:
            ini_lines += ['', '[onboarding]', 'onboarding = True']
        (bm_src / 'song.ini').write_text('\n'.join(ini_lines) + '\n', encoding='utf-8')

        beatmap_id = uuid.uuid4().hex[:12]
        safe_artist = artist
        for ch in ['/', '\\', ':', '"', '<', '>', '|', '?', '*']:
            safe_artist = safe_artist.replace(ch, '-')
        safe_title = bm_name
        for ch in ['/', '\\', ':', '"', '<', '>', '|', '?', '*']:
            safe_title = safe_title.replace(ch, '-')
        folder_name = f'{safe_artist} - {safe_title}'

        from ..services.tracks import add_beatmap_record as _add_bm
        _add_bm(
            track_id=track.id,
            beatmap_id=beatmap_id,
            stem=stem,
            folder_name=folder_name,
            song_name=bm_name,
            source_dir=bm_src,
            model='manual',
            model_version=None,
        )

        return {
            'track_id': track.id,
            'beatmap_id': beatmap_id,
            'editor_url': f'/edit/{track.id}/{beatmap_id}',
        }
    finally:
        shutil.rmtree(staging, ignore_errors=True)


@router.post('/blank-tutorial')
async def create_blank_tutorial(
    name: str = Form('Tutorial'),
    artist: str = Form('Jamsesh'),
    bpm: int = Form(120),
    duration_seconds: int = Form(300),
):
    """Spin up an empty tutorial — a Track holding a single beatmap with a
    silent placeholder song.ogg + an empty notes.chart whose [TutorialScript]
    section is already wired. The user lands in the editor with nothing but
    VO/STEP authoring to do.
    """
    name = (name or 'Tutorial').strip() or 'Tutorial'
    artist = (artist or 'Jamsesh').strip() or 'Jamsesh'
    bpm = max(40, min(int(bpm or 120), 240))
    duration_seconds = max(30, min(int(duration_seconds or 300), 30 * 60))

    upload_dir = Path(settings.upload_dir)
    upload_dir.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='blank_tut_', dir=str(upload_dir)))

    try:
        # Silent placeholder so the editor's audio scrubber + ResizeObserver
        # have something with a defined duration to bind to. Click-track was
        # tempting but would ship in the published folder; silent keeps it
        # neutral.
        stems_src = staging / 'stems'
        stems_src.mkdir()
        silent_ogg = stems_src / 'song.ogg'
        proc = await asyncio.create_subprocess_exec(
            'ffmpeg', '-y',
            '-f', 'lavfi', '-i', f'anullsrc=r=44100:cl=stereo',
            '-t', str(duration_seconds),
            '-c:a', 'libvorbis', '-q:a', '3',
            str(silent_ogg),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0 or not silent_ogg.exists():
            raise HTTPException(500, f'ffmpeg silent-ogg failed: {err.decode("utf-8", errors="replace")[-300:]}')

        # Persist as a Track so it appears in the library list.
        from ..services.tracks import create_track as _create_track
        track = _create_track(
            name=name,
            stems={'song': 'song.ogg'},
            source_stems_dir=stems_src,
            model='manual',
            output_format='ogg',
            artist=artist,
        )

        # Build an empty chart + the same silent ogg + a starter song.ini
        # under a fresh beatmap directory.
        beatmap_id = uuid.uuid4().hex[:12]
        bm_src = staging / 'bm'
        bm_src.mkdir()
        shutil.copy2(silent_ogg, bm_src / 'song.ogg')
        bpm_milli = int(bpm * 1000)
        chart_text = (
            '[Song]\n{\n'
            f'  Name = "{name}"\n'
            f'  Artist = "{artist}"\n'
            '  Charter = "Jamsesh"\n'
            '  Offset = 0\n'
            '  Resolution = 192\n'
            '  Player2 = bass\n'
            '  Difficulty = 0\n'
            '  PreviewStart = 0\n'
            '  PreviewEnd = 0\n'
            '  Genre = "tutorial"\n'
            '  MediaType = "cd"\n'
            '  MusicStream = "song.ogg"\n'
            '}\n'
            '[SyncTrack]\n{\n'
            '  0 = TS 4\n'
            f'  0 = B {bpm_milli}\n'
            '}\n'
            '[Events]\n{\n}\n'
            '[ExpertSingle]\n{\n}\n'
            '[TutorialScript]\n{\n}\n'
        )
        (bm_src / 'notes.chart').write_text(chart_text, encoding='utf-8')

        ini_lines = [
            '[song]',
            f'name = {name}',
            f'artist = {artist}',
            'album = ',
            'genre = tutorial',
            'year = ',
            'song_length = ' + str(duration_seconds * 1000),
            'charter = Jamsesh',
            'preview_start_time = 0',
            'delay = 0',
            'loading_phrase =',
            '',
            '[onboarding]',
            'onboarding = True',
        ]
        (bm_src / 'song.ini').write_text('\n'.join(ini_lines) + '\n', encoding='utf-8')

        from ..services.tracks import add_beatmap_record as _add_bm
        _add_bm(
            track_id=track.id,
            beatmap_id=beatmap_id,
            stem='song',  # tutorial tracks only have a 'song' stem, so file the beatmap there so it appears in the track-detail picker
            folder_name=f'{artist} - {name}',
            song_name=name,
            source_dir=bm_src,
            model='manual',
            model_version=None,
        )

        return {
            'track_id': track.id,
            'beatmap_id': beatmap_id,
            'editor_url': f'/edit/{track.id}/{beatmap_id}',
        }
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def order_beatmaps_for_publish(
    track_beatmaps: list[dict],
    stem_overrides: dict[str, str],
) -> list[tuple[dict, bool]]:
    """Group beatmaps by stem and return a per-beatmap ordering with the
    primary flag attached. Pure function — no filesystem or DB hits — so
    it's testable in isolation.

    For each stem: pick the primary (stem_overrides[stem] override wins,
    else the user-marked active beatmap, else the most recent), then list
    alternates alphabetically by preset name (with generated_at as the
    tiebreaker when two beatmaps share a preset).

    Returns [(beatmap_dict, is_primary)] in the order the merger should
    consume — grouped by stem, primary first per stem, then alternates.
    Stems are emitted in dict-insertion order of their first beatmap so
    the resulting chart's section ordering is stable.

    Beatmaps without a 'stem' field are silently dropped — they belong
    to no instrument.
    """
    by_stem: dict[str, list[dict]] = {}
    for bm in track_beatmaps:
        stem = bm.get('stem')
        if not stem:
            continue
        # Honour the per-beatmap `included` checkbox — unchecked beatmaps
        # are filtered out of the publish bundle entirely. Missing field
        # means included (backward compat with pre-checkbox records).
        if not bm.get('included', True):
            continue
        by_stem.setdefault(stem, []).append(bm)

    out: list[tuple[dict, bool]] = []
    for stem, candidates in by_stem.items():
        primary: dict | None = None
        want = stem_overrides.get(stem)
        if want:
            primary = next((b for b in candidates if b.get('id') == want), None)
        if primary is None:
            primary = next((b for b in candidates if b.get('active')), None)
        if primary is None:
            primary = max(candidates, key=lambda b: b.get('generated_at', 0))

        alternates = sorted(
            (b for b in candidates if b is not primary),
            key=lambda b: (b.get('preset', '') or '', b.get('generated_at', 0)),
        )

        out.append((primary, True))
        for bm in alternates:
            out.append((bm, False))
    return out


@router.post('/{track_id}/publish-game')
async def publish_track_to_game(
    track_id: str,
    song_ini: str = Form(...),
    selected_beatmaps: str = Form(''),
):
    """Convert track stems to game format, write song.ini, merge per-stem
    beatmaps into notes_fixed_slides.chart, and publish to GitHub SongInbox.

    `selected_beatmaps` is an optional JSON object mapping stem name to a
    specific beatmap_id (e.g. {"drums": "abc123", "guitar": "def456"}). When
    set for a stem, that beatmap becomes the PRIMARY (unnumbered section
    in the chart) for that stem; otherwise the user-marked active beatmap
    is used, or the most recent if none is marked active.

    All other beatmaps for each stem are included as numbered alternates
    ([ExpertSingle2], [ExpertSingle3], ...) sorted alphabetically by
    preset name. See merge_beatmap_charts in chart_generator.py for the
    chart format details.
    """
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

    # Parse stem → beatmap_id selection (optional). Empty/invalid falls back to
    # the previous "latest per stem" behaviour.
    stem_overrides: dict[str, str] = {}
    if selected_beatmaps:
        try:
            parsed = json.loads(selected_beatmaps)
            if isinstance(parsed, dict):
                stem_overrides = {str(k): str(v) for k, v in parsed.items() if v}
        except json.JSONDecodeError:
            raise HTTPException(400, 'selected_beatmaps must be valid JSON')

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

        # Merge all of the track's beatmaps into one notes_fixed_slides.chart.
        # Each beatmap was generated from a single stem and writes everything
        # into [*Single] sections — for a multi-stem chart, we rename those
        # sections per stem (drums → [*Drums], bass → [*DoubleBass], etc.) so
        # the game can route each instrument correctly. Stems without a known
        # mapping (vocals, other) get skipped from the merged chart.
        from ..services.chart_generator import merge_beatmap_charts

        chart_status: dict = {'found': False, 'source': None, 'included_stems': [], 'skipped_stems': []}
        if track.beatmaps:
            # Order every beatmap for publish: primary first per stem (override > active > most recent),
            # then alternates alphabetical by preset. Numbered sections come from
            # merge_beatmap_charts' per-stem counter.
            ordered = order_beatmaps_for_publish(list(track.beatmaps), stem_overrides)

            charts_to_merge: list[tuple[str, str, dict]] = []
            beatmap_selection: dict[str, str] = {}
            for bm, is_primary in ordered:
                bm_dir = track.beatmaps_dir / bm.get('id', '')
                if not bm_dir.exists():
                    continue
                src_chart = None
                for candidate in ('notes.chart', 'notes_fixed_slides.chart'):
                    p = bm_dir / candidate
                    if p.exists():
                        src_chart = p
                        break
                if src_chart is None:
                    src_chart = next(iter(bm_dir.glob('*.chart')), None)
                if src_chart is None:
                    continue
                stem = bm.get('stem', '')
                meta = {
                    'preset': bm.get('preset', '') or '',
                    'beatmap_id': bm.get('id', ''),
                    'is_active': is_primary,
                }
                charts_to_merge.append((str(src_chart), stem, meta))
                if is_primary:
                    beatmap_selection[stem] = bm.get('id', '')

            if charts_to_merge:
                merge_result = merge_beatmap_charts(
                    charts_to_merge,
                    str(tmp_dir / 'notes_fixed_slides.chart'),
                )
                if merge_result['included']:
                    chart_status = {
                        'found': True,
                        'published_as': 'notes_fixed_slides.chart',
                        'included_stems': merge_result['included'],
                        'skipped_stems': merge_result['skipped'],
                        'source': f'{len(merge_result["included"])}-stem merge',
                        'selected_beatmaps': beatmap_selection,
                    }
                    # Carry the per-beatmap section names emitted by
                    # merge_beatmap_charts so write_song_ini below can mirror
                    # them into [beatmap_N] blocks for Unity's variant picker.
                    song_ini_beatmaps = merge_result.get('sections_by_beatmap', [])
                else:
                    song_ini_beatmaps = []
            else:
                song_ini_beatmaps = []
        else:
            charts_to_merge: list[tuple[str, str, dict]] = []
            beatmap_selection: dict[str, str] = {}
            song_ini_beatmaps = []

        # Vocals (preferred) / lyrics (fallback): if vocal_notes.json exists,
        # write a [JamseshVocals] block (and clear stale [Events] lyric/phrase
        # entries from Plan A). Otherwise fall back to Plan A's lyric event
        # injection. lyrics.json is always copied alongside if present.
        from app.services import vocals as vocals_service

        vocal_notes_data = vocals_service.load_vocal_notes(track.stems_dir)
        lyrics_data = lyrics_service.load_lyrics(track.stems_dir)

        vocals_summary: dict = {
            'source': None, 'syllable_count': 0, 'voicing': {},
            'pitch_model': None, 'included': False,
        }
        lyrics_summary: dict = {'source': None, 'word_count': 0, 'included': False}

        chart_path = tmp_dir / 'notes_fixed_slides.chart'

        if vocal_notes_data and chart_path.exists():
            inserted = vocals_service.inject_vocals_into_chart(chart_path, vocal_notes_data)
            vocals_service.write_vocal_notes(tmp_dir, vocal_notes_data)
            voicing: dict[str, int] = {'sung': 0, 'spoken': 0, 'whispered': 0}
            for s in vocal_notes_data.get('syllables', []):
                v = s.get('voicing', 'sung')
                voicing[v] = voicing.get(v, 0) + 1
            vocals_summary = {
                'source': vocal_notes_data.get('syllabified_from'),
                'syllable_count': inserted,
                'voicing': voicing,
                'pitch_model': vocal_notes_data.get('pitch_model'),
                'included': True,
            }
            if lyrics_data:
                lyrics_service.write_lyrics(tmp_dir, lyrics_data)
        elif lyrics_data and chart_path.exists():
            inserted = lyrics_service.inject_into_chart(chart_path, lyrics_data)
            lyrics_service.write_lyrics(tmp_dir, lyrics_data)
            lyrics_summary = {
                'source': lyrics_data.get('source'),
                'word_count': inserted,
                'included': True,
            }

        # ── Tutorial mode: bundle VO clips and splice [TutorialScript] into
        # notes_fixed_slides.chart if the picked beatmaps carry tutorial
        # events. Real-notes are handled separately by _bundle_realnotes below.
        tutorial_status = _bundle_tutorial_assets(
            track,
            charts_to_merge if track.beatmaps else [],
            beatmap_selection,
            tmp_dir,
            ini_fields,
        )

        # Real-notes: copy the (pack, scale) bundles referenced by R notes in
        # the merged chart into realnotes/<pack>/<scale>/ and stamp song.ini.
        realnotes_status = _bundle_realnotes(chart_path, tmp_dir, ini_fields)

        # Write song.ini (after tutorial / realnotes fields may have been added)
        write_song_ini(tmp_dir, ini_fields, beatmaps=song_ini_beatmaps)

        # Publish to GitHub
        commit_url = await publish_song_folder(tmp_dir, folder_name)
        return {
            'commit_url': commit_url,
            'folder': f'{settings.github_inbox_prefix}/{folder_name}',
            'chart': chart_status,
            'tutorial': tutorial_status,
            'realnotes': realnotes_status,
            'lyrics': lyrics_summary,
            'vocals': vocals_summary,
        }
    except Exception as e:
        raise HTTPException(500, f'Publish failed: {e}')
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


# ─── Tutorial-mode bundling ──────────────────────────────────────────────────

# Slot keys that the Tutorial editor accepts. Mirrors routers/tutorial.py.
_TUTORIAL_SAMPLE_SLOTS = (
    'lane_1', 'lane_2', 'lane_3', 'lane_4', 'lane_5',
    'chord_12', 'chord_23', 'chord_34', 'chord_45',
    'open',
)

# Pitch shift in semitones used for auto-generating slide_up / slide_down.
# +2 / -2 is enough to be audible without sounding "wrong".
_SLIDE_SHIFT = 2.0


def _extract_tutorial_section(chart_text: str) -> str | None:
    """Pull the verbatim contents of a [TutorialScript] section from a chart
    file, if present. Returns the inner block (without braces) or None."""
    import re as _re

    m = _re.search(r'\[TutorialScript\]\s*\{([^}]*)\}', chart_text)
    if not m:
        return None
    body = m.group(1).strip()
    return body if body else None


_IMPORTED_SOURCES_RE = re.compile(r'\[ImportedSources\]\s*\{([^}]*)\}', re.DOTALL)
_IMPORTED_ROW_RE = re.compile(
    r'^\s*([a-z][a-z0-9_]*)\s*=\s*track="([^"]*)"\s+beatmap="([^"]*)"\s+name="([^"]*)"',
    re.MULTILINE,
)


def _parse_imported_sources_section(chart_text: str) -> dict[str, dict[str, str]]:
    """Return {local_id: {track, beatmap, name}} for every entry in the
    [ImportedSources] section. Empty dict if the section is missing."""
    m = _IMPORTED_SOURCES_RE.search(chart_text)
    if not m:
        return {}
    out: dict[str, dict[str, str]] = {}
    for row in _IMPORTED_ROW_RE.finditer(m.group(1)):
        out[row.group(1)] = {'track': row.group(2), 'beatmap': row.group(3), 'name': row.group(4)}
    return out


def _strip_imported_sources_section(chart_text: str) -> str:
    """Drop the [ImportedSources] section. Used at publish time — Unity
    resolves `MUSIC source=` directly to `sources/<source>/song.ogg`,
    no studio-side ids needed."""
    return _IMPORTED_SOURCES_RE.sub('', chart_text).strip() + '\n'


def _strip_orphan_musicsegs(chart_text: str) -> str:
    """Remove [MusicSeg_<id>] sections that no MUSIC event references."""
    tut_match = re.search(r'\[TutorialScript\]\s*\{([^}]*)\}', chart_text, flags=re.DOTALL)
    referenced: set[str] = set()
    if tut_match:
        for m in re.finditer(r'\d+\s*=\s*MUSIC\s+[^\n]*?section="([^"]+)"', tut_match.group(1)):
            referenced.add(m.group(1))

    def repl(m: re.Match) -> str:
        return '' if m.group(1) not in referenced else m.group(0)

    return re.sub(r'\[(MusicSeg_[A-Za-z0-9]+)\]\s*\{[^}]*\}\s*', repl, chart_text, flags=re.DOTALL)


def _bundle_tutorial_assets(
    track,
    charts_to_merge: list[tuple[str, str, dict]],
    beatmap_selection: dict,
    tmp_dir,
    ini_fields: dict,
) -> dict:
    """If any selected beatmap declares a [TutorialScript], bundle its VO
    clips, splice the script into notes_fixed_slides.chart, and mark song.ini
    as an onboarding tutorial.

    Real-notes sample packs are handled separately in
    ``_bundle_realnotes`` — keep them out of this function so non-tutorial
    songs that use real-notes don't get flagged as tutorials.
    """
    from pathlib import Path as _Path

    tutorial_blocks: list[tuple[str, str]] = []  # (stem, body)
    for chart_path, stem, _meta in charts_to_merge:
        try:
            text = _Path(chart_path).read_text(encoding='utf-8', errors='replace')
        except OSError:
            continue
        body = _extract_tutorial_section(text)
        if body:
            tutorial_blocks.append((stem, body))

    if not tutorial_blocks:
        return {'enabled': False}

    ini_fields['onboarding'] = 'True'

    bundled_vo: dict[str, list[str]] = {}
    for stem, bm_id in beatmap_selection.items():
        vo_src = track.beatmaps_dir / bm_id / 'vo'
        if not vo_src.exists():
            continue
        vo_dst = tmp_dir / 'vo'
        vo_dst.mkdir(parents=True, exist_ok=True)
        names: list[str] = []
        for clip in vo_src.glob('*.ogg'):
            shutil.copy2(clip, vo_dst / clip.name)
            names.append(clip.name)
        if names:
            bundled_vo[stem] = names

    chart_path = tmp_dir / 'notes_fixed_slides.chart'
    if chart_path.exists():
        merged_lines: list[str] = []
        for stem, body in tutorial_blocks:
            merged_lines.append(f'  ; from {stem}')
            for raw in body.splitlines():
                line = raw.strip()
                if line:
                    merged_lines.append(f'  {line}')
        section = (
            '[TutorialScript]\n{\n'
            + '\n'.join(merged_lines)
            + '\n}\n'
        )
        chart_path.write_text(
            chart_path.read_text(encoding='utf-8', errors='replace') + section,
            encoding='utf-8',
        )

    if chart_path.exists():
        text = chart_path.read_text(encoding='utf-8', errors='replace')
        sources = _parse_imported_sources_section(text)
        # Copy each source's song.ogg into sources/<id>/song.ogg
        for local_id, meta in sources.items():
            src_track_dir = Path(settings.upload_dir) / '_tracks' / meta['track']
            src_audio = src_track_dir / 'beatmaps' / meta['beatmap'] / 'song.ogg'
            if not src_audio.exists():
                src_audio = src_track_dir / 'stems' / 'song.ogg'
            if src_audio.exists():
                dst = tmp_dir / 'sources' / local_id / 'song.ogg'
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(str(src_audio), str(dst))
        # Strip ImportedSources + orphan MusicSegs
        text = _strip_imported_sources_section(text)
        text = _strip_orphan_musicsegs(text)
        chart_path.write_text(text, encoding='utf-8')

    return {
        'enabled': True,
        'vo': bundled_vo,
        'script_blocks': len(tutorial_blocks),
    }


_REALNOTES_PACK_RE = re.compile(r'^\s*\d+\s*=\s*E\s+realnotes_pack\s+(\S+)', re.MULTILINE)
_REALNOTES_SCALE_RE = re.compile(r'^\s*\d+\s*=\s*E\s+realnotes_scale\s+(\S+)', re.MULTILINE)
_R_NOTE_RE = re.compile(r'^\s*\d+\s*=\s*R\s+\d+\s+\d+', re.MULTILINE)


def _bundle_realnotes(chart_path: Path, tmp_dir: Path, ini_fields: dict) -> dict:
    """Copy the (pack, scale) bundles referenced by the merged chart into
    ``<song_folder>/realnotes/<pack>/<scale>/``.

    Walks the published chart looking for R notes paired with their nearest
    preceding ``E realnotes_pack`` / ``E realnotes_scale`` declarations,
    collects the unique combos, and copies each one's pre-rendered bundle
    from ``web/backend/sample_packs_data/<pack>/<scale>/``. Anything not
    pre-rendered is reported in the ``missing`` list and skipped — production
    builds ship every catalog combo, so this should only happen if a chart
    references a pack/scale that's been removed.

    Sets ``ini_fields['realnotes'] = 'True'`` iff at least one bundle was
    copied — that flag is the Unity-side cheap "do I need the realnotes
    subsystem?" check.
    """
    if not chart_path.exists():
        return {'enabled': False, 'bundled': [], 'missing': []}
    text = chart_path.read_text(encoding='utf-8', errors='replace')
    used: set[tuple[str, str]] = set()
    # Walk per section so an `E realnotes_pack` in [ExpertBass] doesn't bleed
    # into [ExpertSingle]. State resets at each `[Section] { ... }` block.
    section_re = re.compile(r'\[(?P<name>[^\]]+)\]\s*\{(?P<body>[^}]*)\}', re.DOTALL)
    for match in section_re.finditer(text):
        body = match.group('body')
        # Walk lines in tick + source order, tracking active (pack, scale).
        active_pack: str | None = None
        active_scale: str | None = None
        for raw in body.splitlines():
            t = raw.strip()
            if not t:
                continue
            m = _REALNOTES_PACK_RE.match(raw)
            if m:
                active_pack = m.group(1)
                continue
            m = _REALNOTES_SCALE_RE.match(raw)
            if m:
                active_scale = m.group(1)
                continue
            if _R_NOTE_RE.match(raw) and active_pack and active_scale:
                used.add((active_pack, active_scale))

    bundled: list[dict] = []
    missing: list[dict] = []
    for pack_id, scale_id in sorted(used):
        src = sample_packs.prerendered_path(pack_id, scale_id)
        if src is None:
            missing.append({'pack': pack_id, 'scale': scale_id})
            continue
        dst = tmp_dir / 'realnotes' / pack_id / scale_id
        dst.mkdir(parents=True, exist_ok=True)
        for slot_name in sample_packs.SLOT_ORDER:
            shutil.copy2(src / f'{slot_name}.ogg', dst / f'{slot_name}.ogg')
        bundled.append({'pack': pack_id, 'scale': scale_id})

    if bundled:
        ini_fields['realnotes'] = 'True'

    return {
        'enabled': bool(bundled),
        'bundled': bundled,
        'missing': missing,
    }


@router.get('/{track_id}/beatmaps/{beatmap_id}/elevenlabs-voice')
def get_elevenlabs_voice(track_id: str, beatmap_id: str):
    return {'voice_id': read_elevenlabs_voice(track_id, beatmap_id)}


@router.put('/{track_id}/beatmaps/{beatmap_id}/elevenlabs-voice')
def put_elevenlabs_voice(track_id: str, beatmap_id: str, payload: dict):
    voice_id = (payload.get('voice_id') or '').strip()
    ok = write_elevenlabs_voice(track_id, beatmap_id, voice_id)
    if not ok:
        raise HTTPException(404, 'Beatmap not found')
    return {'voice_id': voice_id}
