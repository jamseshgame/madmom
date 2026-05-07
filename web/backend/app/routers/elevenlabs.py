"""ElevenLabs proxy endpoints.

Phase 1 surfaces voice listing and TTS synthesis. Phase 2 will extend this
file with Studio browse + import endpoints. Phase 3 reuses the same client
from the GitHub publisher.
"""
from __future__ import annotations

import uuid
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Form, HTTPException
from fastapi.responses import JSONResponse

from ..services import elevenlabs_client
from ..services.tracks import get_beatmap_dir, get_track

router = APIRouter(prefix='/api/elevenlabs', tags=['elevenlabs'])


def _resolve_vo_dir(track_id: str, beatmap_id: str) -> Optional[Path]:
    """Mirror routers/tutorial.py::_vo_dir so file layout stays identical
    across engines. Returns None if track/beatmap pair is invalid."""
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        return None
    d = bm_dir / 'vo'
    d.mkdir(parents=True, exist_ok=True)
    return d


@router.get('/voices')
async def voices(refresh: bool = False) -> JSONResponse:
    try:
        data = await elevenlabs_client.list_voices(force_refresh=refresh)
    except elevenlabs_client.NotConfiguredError as e:
        raise HTTPException(503, str(e))
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, f'ElevenLabs: {e.response.text[:200]}')
    return JSONResponse(content=data)


@router.post('/synth')
async def synth(
    text: str = Form(...),
    voice_id: str = Form(...),
    track_id: str = Form(...),
    beatmap_id: str = Form(...),
):
    text = text.strip()
    if not text:
        raise HTTPException(400, 'text is required')
    if not voice_id.strip():
        raise HTTPException(400, 'voice_id is required')
    if get_track(track_id) is None:
        raise HTTPException(404, 'Track not found')
    out_dir = _resolve_vo_dir(track_id, beatmap_id)
    if out_dir is None:
        raise HTTPException(404, 'Beatmap not found')

    out_filename = f'{uuid.uuid4().hex[:12]}.ogg'
    out_path = out_dir / out_filename
    try:
        await elevenlabs_client.synth_to_ogg(text, voice_id, out_path)
    except elevenlabs_client.NotConfiguredError as e:
        raise HTTPException(503, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, f'ElevenLabs: {e.response.text[:200]}')

    return {
        'filename': out_filename,
        'rel_path': f'vo/{out_filename}',
        'voice_id': voice_id,
        'engine': 'elevenlabs',
        'size_bytes': out_path.stat().st_size,
    }
