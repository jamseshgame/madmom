"""Tutorial-mode authoring endpoints.

Three concerns:
  - Tutorial-mode instrument samples (10 base OGG slots per track).
  - Per-beatmap VO clips (TTS-generated or user-uploaded).
  - Direct text→speech endpoint for ad-hoc generation.

Sample slot keys (10 total — slide_up/slide_down variants are auto-generated
at publish time via ffmpeg pitch-shift):

    lane_1, lane_2, lane_3, lane_4, lane_5,
    chord_12, chord_23, chord_34, chord_45,
    open
"""

from __future__ import annotations

import re
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..config import settings
from ..services.tracks import Track, get_beatmap_dir, get_track
from ..services.tts import synth_async

router = APIRouter(prefix='/api/tutorial', tags=['tutorial'])

_AUDIO_EXTS = {'.ogg', '.wav', '.mp3', '.flac', '.m4a'}


def _slugify(s: str) -> str:
    s = s.strip().lower()
    s = re.sub(r'[^a-z0-9]+', '-', s)
    return s.strip('-') or 'untagged'


def _safe_filename(name: str) -> str:
    """Keep the original filename readable while stripping anything that would
    let it escape its directory. We preserve spaces, commas, apostrophes etc.
    since VO filenames are the narration script itself."""
    name = name.replace('\\', '/').split('/')[-1]
    name = name.lstrip('.')
    name = re.sub(r'[\x00-\x1f<>:"|?*]', '', name)
    return name.strip() or 'unnamed'


def _derive_text(stem: str) -> str:
    """Turn '01 - So I hear you play guitar...' into 'So I hear you play guitar...'."""
    return re.sub(r'^\s*\d+\s*[-_.\s]+\s*', '', stem).strip()


def _vo_library_root() -> Path:
    root = Path(settings.upload_dir) / 'vo_library'
    root.mkdir(parents=True, exist_ok=True)
    return root


def _transcode_to_ogg(src: Path, dst: Path) -> None:
    if src.suffix.lower() == '.ogg':
        src.replace(dst)
        return
    proc = subprocess.run(
        ['ffmpeg', '-y', '-i', str(src), '-vn', '-c:a', 'libvorbis', '-q:a', '5', str(dst)],
        capture_output=True,
    )
    src.unlink(missing_ok=True)
    if proc.returncode != 0:
        raise HTTPException(500, f'ffmpeg failed: {proc.stderr.decode("utf-8", errors="replace")[-400:]}')

# Allowed sample slot ids — keep in sync with the frontend Tutorial panel
SAMPLE_SLOTS: tuple[str, ...] = (
    'lane_1', 'lane_2', 'lane_3', 'lane_4', 'lane_5',
    'chord_12', 'chord_23', 'chord_34', 'chord_45',
    'open',
)

_SLOT_RE = re.compile(r'^(lane_[1-5]|chord_(?:12|23|34|45)|open)$')


def _samples_dir(track: Track) -> Path:
    d = track.dir / 'tutorial_samples'
    d.mkdir(parents=True, exist_ok=True)
    return d


def _vo_dir(track_id: str, beatmap_id: str) -> Optional[Path]:
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        return None
    d = bm_dir / 'vo'
    d.mkdir(parents=True, exist_ok=True)
    return d


# -- TTS ---------------------------------------------------------------------


@router.post('/tts/synth')
async def tts_synth(
    text: str = Form(...),
    track_id: str = Form(''),
    beatmap_id: str = Form(''),
    use_voice_clone: bool = Form(True),
):
    """Generate a VO OGG from `text` and persist it under the beatmap's vo/ dir.

    If a track + beatmap pair is given, the new clip is stored at
    ``<beatmap>/vo/<uuid>.ogg`` and a relative path is returned. Otherwise the
    file is written under the track's tutorial_samples/ as a one-shot preview.

    When `use_voice_clone` is True (default), Chatterbox uses the track's
    `tutorial_voice_ref.wav` (if present) as a voice-clone reference.
    """
    text = text.strip()
    if not text:
        raise HTTPException(400, 'text is required')

    if not track_id:
        raise HTTPException(400, 'track_id is required')
    track = get_track(track_id)
    if track is None:
        raise HTTPException(404, 'Track not found')

    if beatmap_id:
        out_dir = _vo_dir(track_id, beatmap_id)
        if out_dir is None:
            raise HTTPException(404, 'Beatmap not found')
    else:
        out_dir = track.dir / 'tutorial_vo_drafts'
        out_dir.mkdir(parents=True, exist_ok=True)

    out_filename = f'{uuid.uuid4().hex[:12]}.ogg'
    out_path = out_dir / out_filename

    reference: Optional[Path] = None
    if use_voice_clone:
        for cand in ('tutorial_voice_ref.wav', 'tutorial_voice_ref.ogg', 'tutorial_voice_ref.mp3'):
            p = track.dir / cand
            if p.exists():
                reference = p
                break

    try:
        await synth_async(text, out_path, reference_audio=reference)
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f'TTS failed: {e}')

    rel = f'vo/{out_filename}' if beatmap_id else f'tutorial_vo_drafts/{out_filename}'
    return {
        'filename': out_filename,
        'rel_path': rel,
        'size_bytes': out_path.stat().st_size,
        'voice_cloned': reference is not None,
    }


@router.post('/{track_id}/voice-ref')
async def upload_voice_ref(track_id: str, file: UploadFile = File(...)):
    """Upload a 5-30 second reference clip the TTS engine clones from."""
    track = get_track(track_id)
    if track is None:
        raise HTTPException(404, 'Track not found')
    ext = Path(file.filename or '').suffix.lower() or '.wav'
    if ext not in {'.wav', '.ogg', '.mp3', '.flac', '.m4a'}:
        raise HTTPException(400, f'Unsupported reference format: {ext}')
    out = track.dir / f'tutorial_voice_ref{ext}'
    # Remove any older variants so the resolver picks up the new one
    for cand in ('tutorial_voice_ref.wav', 'tutorial_voice_ref.ogg', 'tutorial_voice_ref.mp3'):
        p = track.dir / cand
        if p.exists() and p != out:
            p.unlink(missing_ok=True)
    data = await file.read()
    out.write_bytes(data)
    return {'ok': True, 'path': out.name, 'size_bytes': len(data)}


@router.delete('/{track_id}/voice-ref')
async def delete_voice_ref(track_id: str):
    track = get_track(track_id)
    if track is None:
        raise HTTPException(404, 'Track not found')
    removed = []
    for cand in ('tutorial_voice_ref.wav', 'tutorial_voice_ref.ogg', 'tutorial_voice_ref.mp3'):
        p = track.dir / cand
        if p.exists():
            p.unlink(missing_ok=True)
            removed.append(cand)
    return {'ok': True, 'removed': removed}


@router.get('/{track_id}/voice-ref')
async def get_voice_ref(track_id: str):
    """Stream the reference clip back so the frontend can preview it."""
    track = get_track(track_id)
    if track is None:
        raise HTTPException(404, 'Track not found')
    for cand in ('tutorial_voice_ref.wav', 'tutorial_voice_ref.ogg', 'tutorial_voice_ref.mp3'):
        p = track.dir / cand
        if p.exists():
            media = {'.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg'}.get(p.suffix.lower(), 'audio/octet-stream')
            return FileResponse(p, media_type=media)
    raise HTTPException(404, 'No reference clip on this track')


# -- Tutorial sample slots ---------------------------------------------------


@router.get('/{track_id}/samples')
async def list_samples(track_id: str):
    track = get_track(track_id)
    if track is None:
        raise HTTPException(404, 'Track not found')
    out: dict[str, dict] = {}
    d = track.dir / 'tutorial_samples'
    if d.exists():
        for slot in SAMPLE_SLOTS:
            for ext in ('.ogg', '.wav', '.mp3', '.flac'):
                p = d / f'{slot}{ext}'
                if p.exists():
                    out[slot] = {
                        'filename': p.name,
                        'size_bytes': p.stat().st_size,
                        'mtime': int(p.stat().st_mtime),
                    }
                    break
    return out


@router.put('/{track_id}/samples/{slot}')
async def upload_sample(track_id: str, slot: str, file: UploadFile = File(...)):
    if not _SLOT_RE.match(slot):
        raise HTTPException(400, f'Invalid sample slot: {slot}')
    track = get_track(track_id)
    if track is None:
        raise HTTPException(404, 'Track not found')
    raw_ext = Path(file.filename or '').suffix.lower()
    if raw_ext not in {'.ogg', '.wav', '.mp3', '.flac', '.m4a'}:
        raise HTTPException(400, f'Unsupported sample format: {raw_ext}')

    d = _samples_dir(track)
    # Wipe any previous file in this slot regardless of extension
    for ext in ('.ogg', '.wav', '.mp3', '.flac', '.m4a'):
        old = d / f'{slot}{ext}'
        if old.exists():
            old.unlink(missing_ok=True)

    raw_bytes = await file.read()
    raw_path = d / f'_raw_{slot}{raw_ext}'
    raw_path.write_bytes(raw_bytes)

    final_path = d / f'{slot}.ogg'
    if raw_ext == '.ogg':
        # Already in the target format — just rename
        raw_path.replace(final_path)
    else:
        import subprocess
        proc = subprocess.run(
            [
                'ffmpeg', '-y', '-i', str(raw_path),
                '-vn', '-c:a', 'libvorbis', '-q:a', '6', str(final_path),
            ],
            capture_output=True,
        )
        raw_path.unlink(missing_ok=True)
        if proc.returncode != 0:
            raise HTTPException(500, f'ffmpeg failed: {proc.stderr.decode("utf-8", errors="replace")[-400:]}')

    return {
        'slot': slot,
        'filename': final_path.name,
        'size_bytes': final_path.stat().st_size,
    }


@router.delete('/{track_id}/samples/{slot}')
async def delete_sample(track_id: str, slot: str):
    if not _SLOT_RE.match(slot):
        raise HTTPException(400, f'Invalid sample slot: {slot}')
    track = get_track(track_id)
    if track is None:
        raise HTTPException(404, 'Track not found')
    d = track.dir / 'tutorial_samples'
    removed = []
    for ext in ('.ogg', '.wav', '.mp3', '.flac', '.m4a'):
        p = d / f'{slot}{ext}'
        if p.exists():
            p.unlink(missing_ok=True)
            removed.append(p.name)
    return {'ok': True, 'removed': removed}


@router.get('/{track_id}/samples/{slot}/file')
async def download_sample(track_id: str, slot: str):
    track = get_track(track_id)
    if track is None:
        raise HTTPException(404, 'Track not found')
    d = track.dir / 'tutorial_samples'
    for ext in ('.ogg', '.wav', '.mp3', '.flac', '.m4a'):
        p = d / f'{slot}{ext}'
        if p.exists():
            return FileResponse(p, media_type='audio/ogg')
    raise HTTPException(404, 'Sample slot is empty')


# -- Per-beatmap VO clips ----------------------------------------------------


@router.get('/{track_id}/beatmaps/{beatmap_id}/vo/{name}')
async def download_vo(track_id: str, beatmap_id: str, name: str):
    """Stream a saved VO clip for in-editor playback."""
    if '/' in name or '\\' in name or name.startswith('.'):
        raise HTTPException(400, 'Invalid filename')
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        raise HTTPException(404, 'Beatmap not found')
    p = bm_dir / 'vo' / name
    if not p.exists():
        raise HTTPException(404, 'VO clip not found')
    return FileResponse(p, media_type='audio/ogg')


@router.delete('/{track_id}/beatmaps/{beatmap_id}/vo/{name}')
async def delete_vo(track_id: str, beatmap_id: str, name: str):
    if '/' in name or '\\' in name or name.startswith('.'):
        raise HTTPException(400, 'Invalid filename')
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        raise HTTPException(404, 'Beatmap not found')
    p = bm_dir / 'vo' / name
    if p.exists():
        p.unlink(missing_ok=True)
    return {'ok': True}


@router.post('/{track_id}/beatmaps/{beatmap_id}/music-segment')
async def create_music_segment(
    track_id: str,
    beatmap_id: str,
    file: UploadFile = File(...),
    difficulty: str = Form('ExpertSingle'),
):
    """Upload a short music clip, run the chart generator on it, return the
    notes + BPM + duration so the editor can stitch a MUSIC event + a
    [MusicSeg_<id>] section into the active beatmap's chart on next save.

    The audio is persisted under `<beatmap>/segments/<uuid>.ogg`. The clip
    can be any length but is capped at 5 minutes to keep generation snappy.
    """
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        raise HTTPException(404, 'Beatmap not found')
    raw_ext = Path(file.filename or '').suffix.lower()
    if raw_ext not in {'.ogg', '.wav', '.mp3', '.flac', '.m4a'}:
        raise HTTPException(400, f'Unsupported audio format: {raw_ext}')
    if difficulty not in ('ExpertSingle', 'HardSingle', 'MediumSingle', 'EasySingle'):
        raise HTTPException(400, f'Unknown difficulty: {difficulty}')

    seg_dir = bm_dir / 'segments'
    seg_dir.mkdir(parents=True, exist_ok=True)
    seg_id = uuid.uuid4().hex[:10]

    # Stage the upload, transcode to ogg if needed
    raw_path = seg_dir / f'_raw_{seg_id}{raw_ext}'
    raw_path.write_bytes(await file.read())
    out_ogg = seg_dir / f'{seg_id}.ogg'
    import subprocess
    if raw_ext == '.ogg':
        raw_path.replace(out_ogg)
    else:
        proc = subprocess.run(
            ['ffmpeg', '-y', '-i', str(raw_path), '-vn', '-c:a', 'libvorbis', '-q:a', '5', str(out_ogg)],
            capture_output=True,
        )
        raw_path.unlink(missing_ok=True)
        if proc.returncode != 0:
            raise HTTPException(500, f'ffmpeg failed: {proc.stderr.decode("utf-8", errors="replace")[-300:]}')

    # Probe duration via ffprobe so the editor knows how long the segment plays
    duration = 0.0
    try:
        probe = subprocess.run(
            [
                'ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1', str(out_ogg),
            ],
            capture_output=True, text=True,
        )
        duration = float(probe.stdout.strip() or 0)
    except (ValueError, OSError):
        pass

    if duration > 300:
        out_ogg.unlink(missing_ok=True)
        raise HTTPException(400, f'Segment too long ({duration:.0f}s) — cap is 5 minutes')

    # Run the existing chart generator on the clip in an isolated temp dir.
    # We only care about the notes for the chosen difficulty.
    import tempfile as _tf
    from ..services.chart_generator import generate_full_chart

    work = Path(_tf.mkdtemp(prefix='tutseg_'))
    try:
        result = await generate_full_chart(
            audio_path=str(out_ogg),
            output_dir=str(work),
            song_name=f'segment_{seg_id}',
            artist='Tutorial',
            album='',
            year='',
            genre='tutorial',
        )
        if result is None:
            return {
                'id': seg_id,
                'file': out_ogg.name,
                'rel_path': f'segments/{out_ogg.name}',
                'section_name': f'MusicSeg_{seg_id}',
                'section_body': '',
                'bpm': 120.0,
                'resolution': 192,
                'duration_seconds': duration,
                'notes_count': 0,
                'difficulty': difficulty,
                'warning': 'No onsets detected — segment plays without notes',
            }

        chart_text = (work / 'notes.chart').read_text(encoding='utf-8', errors='replace')
        # Pull the chosen difficulty's body
        import re as _re
        m = _re.search(r'\[' + difficulty + r'\]\s*\{([^}]*)\}', chart_text)
        section_body = (m.group(1).strip() if m else '')

        # BPM and resolution come from the segment's own [SyncTrack]/[Song]
        bpm_match = _re.search(r'=\s*B\s+(\d+)', chart_text)
        bpm = (int(bpm_match.group(1)) / 1000.0) if bpm_match else 120.0
        res_match = _re.search(r'Resolution\s*=\s*(\d+)', chart_text)
        resolution = int(res_match.group(1)) if res_match else 192

        notes_count = len(_re.findall(r'^\s*\d+\s*=\s*N\s+', section_body, flags=_re.M))

        return {
            'id': seg_id,
            'file': out_ogg.name,
            'rel_path': f'segments/{out_ogg.name}',
            'section_name': f'MusicSeg_{seg_id}',
            'section_body': section_body,
            'bpm': bpm,
            'resolution': resolution,
            'duration_seconds': duration,
            'notes_count': notes_count,
            'difficulty': difficulty,
        }
    except Exception as e:  # noqa: BLE001
        out_ogg.unlink(missing_ok=True)
        raise HTTPException(500, f'Segment chart generation failed: {e}')
    finally:
        shutil.rmtree(work, ignore_errors=True)


@router.get('/{track_id}/beatmaps/{beatmap_id}/segments/{name}')
async def download_segment(track_id: str, beatmap_id: str, name: str):
    """Stream a saved music segment for in-editor playback."""
    if '/' in name or '\\' in name or name.startswith('.'):
        raise HTTPException(400, 'Invalid filename')
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        raise HTTPException(404, 'Beatmap not found')
    p = bm_dir / 'segments' / name
    if not p.exists():
        raise HTTPException(404, 'Segment not found')
    return FileResponse(p, media_type='audio/ogg')


@router.delete('/{track_id}/beatmaps/{beatmap_id}/segments/{name}')
async def delete_segment(track_id: str, beatmap_id: str, name: str):
    if '/' in name or '\\' in name or name.startswith('.'):
        raise HTTPException(400, 'Invalid filename')
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        raise HTTPException(404, 'Beatmap not found')
    p = bm_dir / 'segments' / name
    if p.exists():
        p.unlink(missing_ok=True)
    return {'ok': True}


@router.post('/{track_id}/beatmaps/{beatmap_id}/vo/upload')
async def upload_vo(track_id: str, beatmap_id: str, file: UploadFile = File(...)):
    """User-supplied VO clip — converted to OGG and stored under vo/."""
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        raise HTTPException(404, 'Beatmap not found')
    ext = Path(file.filename or '').suffix.lower()
    if ext not in _AUDIO_EXTS:
        raise HTTPException(400, f'Unsupported audio format: {ext}')
    d = bm_dir / 'vo'
    d.mkdir(parents=True, exist_ok=True)
    fname = f'{uuid.uuid4().hex[:12]}.ogg'
    out = d / fname

    data = await file.read()
    raw = d / f'_raw_{fname}{ext}'
    raw.write_bytes(data)
    _transcode_to_ogg(raw, out)
    return {'filename': fname, 'rel_path': f'vo/{fname}', 'size_bytes': out.stat().st_size}


# -- Shared VO library -------------------------------------------------------
# A track-agnostic store keyed by a user-supplied batch label (e.g. "Guitar
# Lesson 1 elevenlabs Ryan"). Files keep their original (sanitized) names so
# the narration script — encoded by the uploader as the filename — survives.
# Tutorials import a copy of a library file into their own vo/ dir, so chart
# playback continues to resolve VOs relative to the beatmap.


@router.post('/vo-library/upload')
async def vo_library_upload(
    batch_tag: str = Form(...),
    files: list[UploadFile] = File(...),
):
    """Save one or more VO files into the shared library under the given
    batch tag. Filenames are preserved (sanitized) so the in-editor browser
    can show the script line as the file label."""
    label = batch_tag.strip()
    if not label:
        raise HTTPException(400, 'batch_tag is required')
    if not files:
        raise HTTPException(400, 'At least one file is required')

    slug = _slugify(label)
    batch_dir = _vo_library_root() / slug
    batch_dir.mkdir(parents=True, exist_ok=True)
    # Persist the original label so future listings can show it verbatim
    (batch_dir / '_label.txt').write_text(label, encoding='utf-8')

    saved = []
    for upload in files:
        raw_name = _safe_filename(upload.filename or 'unnamed')
        ext = Path(raw_name).suffix.lower()
        if ext not in _AUDIO_EXTS:
            raise HTTPException(400, f'Unsupported audio format on {raw_name}: {ext}')
        stem = Path(raw_name).stem
        out = batch_dir / f'{stem}.ogg'
        raw = batch_dir / f'_raw_{uuid.uuid4().hex[:8]}{ext}'
        raw.write_bytes(await upload.read())
        _transcode_to_ogg(raw, out)
        saved.append({
            'name': out.name,
            'text': _derive_text(stem),
            'size_bytes': out.stat().st_size,
        })

    return {'batch': slug, 'label': label, 'files': saved}


@router.get('/vo-library/batches')
async def vo_library_list_batches():
    root = _vo_library_root()
    out = []
    for d in sorted(root.iterdir() if root.exists() else []):
        if not d.is_dir():
            continue
        label_file = d / '_label.txt'
        label = label_file.read_text(encoding='utf-8').strip() if label_file.exists() else d.name
        count = sum(1 for p in d.iterdir() if p.is_file() and p.suffix.lower() == '.ogg')
        out.append({'batch': d.name, 'label': label, 'file_count': count})
    return out


@router.get('/vo-library/batches/{batch}')
async def vo_library_list_files(batch: str):
    if '/' in batch or '\\' in batch or batch.startswith('.'):
        raise HTTPException(400, 'Invalid batch')
    d = _vo_library_root() / batch
    if not d.is_dir():
        raise HTTPException(404, 'Batch not found')
    label_file = d / '_label.txt'
    label = label_file.read_text(encoding='utf-8').strip() if label_file.exists() else batch
    files = []
    for p in sorted(d.iterdir(), key=lambda x: x.name):
        if not p.is_file() or p.suffix.lower() != '.ogg':
            continue
        files.append({
            'name': p.name,
            'text': _derive_text(p.stem),
            'size_bytes': p.stat().st_size,
        })
    return {'batch': batch, 'label': label, 'files': files}


@router.get('/vo-library/file/{batch}/{name}')
async def vo_library_stream(batch: str, name: str):
    if '/' in batch or '\\' in batch or batch.startswith('.'):
        raise HTTPException(400, 'Invalid batch')
    if '/' in name or '\\' in name or name.startswith('.'):
        raise HTTPException(400, 'Invalid filename')
    p = _vo_library_root() / batch / name
    if not p.exists():
        raise HTTPException(404, 'VO clip not found')
    return FileResponse(p, media_type='audio/ogg')


@router.delete('/vo-library/batches/{batch}')
async def vo_library_delete_batch(batch: str):
    if '/' in batch or '\\' in batch or batch.startswith('.'):
        raise HTTPException(400, 'Invalid batch')
    d = _vo_library_root() / batch
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)
    return {'ok': True}


@router.delete('/vo-library/file/{batch}/{name}')
async def vo_library_delete_file(batch: str, name: str):
    if '/' in batch or '\\' in batch or batch.startswith('.'):
        raise HTTPException(400, 'Invalid batch')
    if '/' in name or '\\' in name or name.startswith('.'):
        raise HTTPException(400, 'Invalid filename')
    p = _vo_library_root() / batch / name
    if p.exists():
        p.unlink(missing_ok=True)
    return {'ok': True}


class VoLibraryImportRequest(BaseModel):
    batch: str
    name: str


@router.post('/{track_id}/beatmaps/{beatmap_id}/vo/from-library')
async def vo_import_from_library(track_id: str, beatmap_id: str, req: VoLibraryImportRequest):
    """Copy a library VO into this beatmap's vo/ dir so it's playable via the
    existing per-beatmap stream endpoint. Returns the rel_path + derived text
    so the frontend can drop a VO event onto the timeline."""
    if '/' in req.batch or '\\' in req.batch or req.batch.startswith('.'):
        raise HTTPException(400, 'Invalid batch')
    if '/' in req.name or '\\' in req.name or req.name.startswith('.'):
        raise HTTPException(400, 'Invalid filename')
    src = _vo_library_root() / req.batch / req.name
    if not src.exists():
        raise HTTPException(404, 'Library VO not found')
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        raise HTTPException(404, 'Beatmap not found')
    d = bm_dir / 'vo'
    d.mkdir(parents=True, exist_ok=True)
    # Unique filename per import so re-inserting the same library file twice
    # gives two independent copies the user can edit / delete separately.
    stem = Path(req.name).stem
    dst = d / f'{stem}__{uuid.uuid4().hex[:6]}.ogg'
    shutil.copyfile(src, dst)
    return {
        'rel_path': f'vo/{dst.name}',
        'filename': dst.name,
        'text': _derive_text(stem),
        'size_bytes': dst.stat().st_size,
    }
