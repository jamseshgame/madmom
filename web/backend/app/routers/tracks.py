"""Track library endpoints — browse, manage, and generate beatmaps from saved tracks."""

import asyncio
import json
import shutil
import tempfile
import uuid
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
from ..services import lyrics as lyrics_service
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
    read_elevenlabs_voice,
    clone_beatmap_record,
    rename_beatmap_record,
    set_active_beatmap,
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
        )

        return {
            'track_id': track.id,
            'beatmap_id': beatmap_id,
            'editor_url': f'/edit/{track.id}/{beatmap_id}',
        }
    finally:
        shutil.rmtree(staging, ignore_errors=True)


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
    omitted or a stem isn't listed, the most recent beatmap for that stem
    is used.
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
            # Group beatmaps by stem so we can apply user overrides cleanly.
            by_stem: dict[str, list[dict]] = {}
            for bm in track.beatmaps:
                by_stem.setdefault(bm.get('stem', ''), []).append(bm)

            charts_to_merge: list[tuple[str, str]] = []
            beatmap_selection: dict[str, str] = {}
            for stem, candidates in by_stem.items():
                # Pick: the user-specified beatmap_id if provided AND it exists
                # for this stem; otherwise the most recently generated.
                chosen: dict | None = None
                want = stem_overrides.get(stem)
                if want:
                    for bm in candidates:
                        if bm.get('id') == want:
                            chosen = bm
                            break
                if chosen is None:
                    active_match = next((b for b in candidates if b.get('active')), None)
                    chosen = active_match or max(candidates, key=lambda b: b.get('generated_at', 0))

                bm_dir = track.beatmaps_dir / chosen.get('id', '')
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
                charts_to_merge.append((str(src_chart), stem))
                beatmap_selection[stem] = chosen.get('id', '')

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

        # ── Tutorial mode: copy instrument samples, VO clips, and append a
        # [TutorialScript] section to notes_fixed_slides.chart if the picked
        # beatmaps carry tutorial events. The Unity dev parses these.
        tutorial_status = _bundle_tutorial_assets(
            track,
            charts_to_merge if track.beatmaps else [],
            beatmap_selection,
            tmp_dir,
            ini_fields,
        )

        # Write song.ini (after tutorial fields may have been spliced in)
        write_song_ini(tmp_dir, ini_fields)

        # Publish to GitHub
        commit_url = await publish_song_folder(tmp_dir, folder_name)
        return {
            'commit_url': commit_url,
            'folder': f'{settings.github_inbox_prefix}/{folder_name}',
            'chart': chart_status,
            'tutorial': tutorial_status,
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


def _bundle_tutorial_assets(
    track,
    charts_to_merge: list,
    beatmap_selection: dict,
    tmp_dir,
    ini_fields: dict,
) -> dict:
    """If any selected beatmap declares tutorial content, copy the track's
    tutorial samples + the beatmap's VO clips into the publish folder, append
    a [TutorialScript] section to notes_fixed_slides.chart, and stamp tutorial
    metadata into ini_fields so song.ini carries the sample paths.

    Returns a status dict the publish endpoint includes in its response.
    """
    import subprocess
    from pathlib import Path as _Path

    # Aggregate any [TutorialScript] sections from the selected charts.
    tutorial_blocks: list[tuple[str, str]] = []  # (stem, body)
    for chart_path, stem in charts_to_merge:
        try:
            text = _Path(chart_path).read_text(encoding='utf-8', errors='replace')
        except OSError:
            continue
        body = _extract_tutorial_section(text)
        if body:
            tutorial_blocks.append((stem, body))

    if not tutorial_blocks and not (track.dir / 'tutorial_samples').exists():
        return {'enabled': False}

    # Mark song.ini as an onboarding tutorial and stamp the sample paths
    ini_fields['onboarding'] = 'True'
    samples_src = track.dir / 'tutorial_samples'
    samples_dst = tmp_dir / 'tutorial_samples'
    bundled_samples: list[str] = []
    if samples_src.exists():
        samples_dst.mkdir(parents=True, exist_ok=True)
        for slot in _TUTORIAL_SAMPLE_SLOTS:
            for ext in ('.ogg', '.wav', '.mp3', '.flac'):
                p = samples_src / f'{slot}{ext}'
                if p.exists():
                    dst = samples_dst / f'{slot}.ogg'
                    if ext == '.ogg':
                        shutil.copy2(p, dst)
                    else:
                        # Re-encode anything non-ogg into ogg
                        subprocess.run(
                            ['ffmpeg', '-y', '-i', str(p), '-vn', '-c:a', 'libvorbis', '-q:a', '6', str(dst)],
                            capture_output=True,
                        )
                    if dst.exists():
                        bundled_samples.append(slot)
                        ini_fields[f'sample_{slot}'] = f'tutorial_samples/{slot}.ogg'
                        # Also synthesise a simple slide_up / slide_down pitch
                        # variant per base sample. Single ffmpeg pass with
                        # asetrate (cheap pitch shift; a touch unnatural but
                        # matches what a slide effect needs).
                        for direction, shift in (
                            ('slide_up', _SLIDE_SHIFT),
                            ('slide_down', -_SLIDE_SHIFT),
                        ):
                            slide_dst = samples_dst / f'{slot}_{direction}.ogg'
                            ratio = 2 ** (shift / 12.0)
                            subprocess.run(
                                [
                                    'ffmpeg', '-y', '-i', str(dst),
                                    '-af',
                                    # asetrate scales sample rate (changes pitch
                                    # AND tempo); aresample brings sr back to
                                    # 44100 leaving only pitch shifted.
                                    f'asetrate=44100*{ratio:.6f},aresample=44100',
                                    '-c:a', 'libvorbis', '-q:a', '6',
                                    str(slide_dst),
                                ],
                                capture_output=True,
                            )
                            if slide_dst.exists():
                                ini_fields[f'sample_{slot}_{direction}'] = f'tutorial_samples/{slot}_{direction}.ogg'
                    break

    # Bundle VO clips from each selected beatmap
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

    # Append [TutorialScript] block to notes_fixed_slides.chart
    chart_path = tmp_dir / 'notes_fixed_slides.chart'
    if tutorial_blocks and chart_path.exists():
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

    return {
        'enabled': True,
        'samples': bundled_samples,
        'vo': bundled_vo,
        'script_blocks': len(tutorial_blocks),
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
