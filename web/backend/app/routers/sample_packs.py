"""Sample-pack catalog + global pre-rendered store.

Real-notes are intrinsic to the chart now (R notes carrying pack/scale
strings), so there is no per-beatmap state to render or store. The editor
streams OGGs straight from the global pre-rendered bundle at
`web/backend/sample_packs_data/<pack>/<scale>/<slot>.ogg`, and the publish
flow copies whatever combos the chart actually references into the song
folder under `realnotes/<pack>/<scale>/`.

This router exposes three endpoints:
  - GET /api/sample-packs                                       — catalog
  - GET /api/sample-packs/{pack}/{scale}/preview                — audition lane_1
  - GET /api/sample-packs/{pack}/{scale}/{slot_name}.ogg        — single OGG
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from ..services import sample_packs

router = APIRouter(prefix='/api', tags=['sample-packs'])
# (reload trigger)


@router.get('/sample-packs')
async def list_packs() -> JSONResponse:
    return JSONResponse(content={
        'packs': sample_packs.pack_catalog(),
        'scales': sample_packs.scale_catalog(),
    })


@router.get('/sample-packs/{pack_id}/{scale_id}/preview')
async def preview_pack(pack_id: str, scale_id: str):
    """Stream lane_1 from the pre-rendered bundle so the picker can audition
    the (pack, scale) combo before committing."""
    if pack_id not in sample_packs.PACKS:
        raise HTTPException(404, f'Unknown pack: {pack_id}')
    if scale_id not in sample_packs.SCALES:
        raise HTTPException(404, f'Unknown scale: {scale_id}')
    pre = sample_packs.prerendered_path(pack_id, scale_id)
    if pre is None:
        raise HTTPException(404, 'No pre-rendered bundle for this combo')
    preview = pre / 'lane_1.ogg'
    if not preview.exists():
        raise HTTPException(404, 'Preview missing')
    return FileResponse(str(preview), media_type='audio/ogg', filename=f'{pack_id}-{scale_id}-preview.ogg')


@router.get('/sample-packs/{pack_id}/{scale_id}/{slot_name}.ogg')
async def get_pack_sample(pack_id: str, scale_id: str, slot_name: str):
    """Serve one OGG from the pre-rendered bundle. Used by the editor's
    real-notes buffer fetch and (potentially) by the in-game preview overlay."""
    if slot_name not in sample_packs.SLOT_ORDER:
        raise HTTPException(400, f'Unknown slot name: {slot_name}')
    if pack_id not in sample_packs.PACKS:
        raise HTTPException(404, f'Unknown pack: {pack_id}')
    if scale_id not in sample_packs.SCALES:
        raise HTTPException(404, f'Unknown scale: {scale_id}')
    pre = sample_packs.prerendered_path(pack_id, scale_id)
    if pre is None:
        raise HTTPException(404, 'No pre-rendered bundle for this combo')
    p = pre / f'{slot_name}.ogg'
    if not p.exists():
        raise HTTPException(404, 'Sample missing')
    return FileResponse(str(p), media_type='audio/ogg', filename=f'{slot_name}.ogg')
