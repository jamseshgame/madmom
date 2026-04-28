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
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from ..services.tracks import Track, get_beatmap_dir, get_track
from ..services.tts import synth_async

router = APIRouter(prefix='/api/tutorial', tags=['tutorial'])

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


@router.post('/{track_id}/beatmaps/{beatmap_id}/vo/upload')
async def upload_vo(track_id: str, beatmap_id: str, file: UploadFile = File(...)):
    """User-supplied VO clip — converted to OGG and stored under vo/."""
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        raise HTTPException(404, 'Beatmap not found')
    ext = Path(file.filename or '').suffix.lower()
    if ext not in {'.ogg', '.wav', '.mp3', '.flac', '.m4a'}:
        raise HTTPException(400, f'Unsupported audio format: {ext}')
    d = bm_dir / 'vo'
    d.mkdir(parents=True, exist_ok=True)
    fname = f'{uuid.uuid4().hex[:12]}.ogg'
    out = d / fname

    data = await file.read()
    raw = d / f'_raw_{fname}{ext}'
    raw.write_bytes(data)
    if ext == '.ogg':
        raw.replace(out)
    else:
        import subprocess
        proc = subprocess.run(
            ['ffmpeg', '-y', '-i', str(raw), '-vn', '-c:a', 'libvorbis', '-q:a', '5', str(out)],
            capture_output=True,
        )
        raw.unlink(missing_ok=True)
        if proc.returncode != 0:
            raise HTTPException(500, f'ffmpeg failed: {proc.stderr.decode("utf-8", errors="replace")[-400:]}')
    return {'filename': fname, 'rel_path': f'vo/{fname}', 'size_bytes': out.stat().st_size}
