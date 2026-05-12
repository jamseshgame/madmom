"""Sample-pack library — real-notes mode sample-pack catalog + apply.

Two GETs (catalog + scales) and one POST (apply a pack to a track). Applying
renders all 10 slot OGGs into the track's stems_dir/tutorial_samples/, writes
sample_<slot>= entries into song.ini, and turns on the [real_notes] flag so
the game client knows to play samples on hit even outside tutorial mode.
"""
from __future__ import annotations

from fastapi import APIRouter, Form, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from ..services import sample_packs
from ..services.tracks import get_track

router = APIRouter(prefix='/api', tags=['sample-packs'])


@router.get('/sample-packs')
async def list_packs() -> JSONResponse:
    return JSONResponse(content={
        'packs': sample_packs.pack_catalog(),
        'scales': sample_packs.scale_catalog(),
    })


@router.get('/sample-packs/{pack_id}/{scale_id}/preview')
async def preview_pack(pack_id: str, scale_id: str):
    """Stream a single pre-rendered slot so the picker UI can audition a
    pack before the user commits to applying it. Currently returns lane_1
    (the scale root) — short, representative of the pack's timbre.

    Only pre-rendered packs have previews — on-demand SF2/synth rendering
    isn't worth the latency just to play a button.
    """
    if pack_id not in sample_packs.PACKS:
        raise HTTPException(404, f'Unknown pack: {pack_id}')
    if scale_id not in sample_packs.SCALES:
        raise HTTPException(404, f'Unknown scale: {scale_id}')
    pre = sample_packs.prerendered_path(pack_id, scale_id)
    if pre is None:
        raise HTTPException(404, 'No pre-rendered preview for this combo')
    preview = pre / 'lane_1.ogg'
    if not preview.exists():
        raise HTTPException(404, 'Preview missing')
    return FileResponse(str(preview), media_type='audio/ogg', filename=f'{pack_id}-{scale_id}-preview.ogg')


@router.post('/tracks/{track_id}/apply-sample-pack')
async def apply_pack(
    track_id: str,
    pack_id: str = Form(...),
    scale_id: str = Form(...),
):
    """Render `pack_id`+`scale_id` into the track's tutorial_samples/ and
    update song.ini so the game picks up the new samples on next download.

    Idempotent — running with the same pack/scale just overwrites the OGGs
    and the song.ini entries.
    """
    track = get_track(track_id)
    if track is None:
        raise HTTPException(404, 'Track not found')

    pack = sample_packs.get_pack(pack_id)
    if pack is None:
        raise HTTPException(404, f'Unknown pack: {pack_id}')
    scale = sample_packs.get_scale(scale_id)
    if scale is None:
        raise HTTPException(404, f'Unknown scale: {scale_id}')

    out_dir = track.stems_dir / 'tutorial_samples'
    try:
        rel_paths = sample_packs.render_pack(pack, scale, out_dir)
    except RuntimeError as e:
        raise HTTPException(500, str(e))

    # Stamp song.ini with the new sample_<slot> paths + the real_notes flag.
    # We merge into the existing file so user-edited fields (name, artist,
    # difficulties etc.) carry through. `_parse_song_ini` is a flat parser
    # (ignores section headers) which is exactly what write_song_ini wants.
    from ..services.stems import write_song_ini
    from ..services.game_songs import _parse_song_ini

    ini_path = track.stems_dir / 'song.ini'
    fields: dict[str, str] = {}
    if ini_path.exists():
        try:
            fields.update(_parse_song_ini(ini_path.read_text(encoding='utf-8')))
        except Exception:
            pass
    for slot, filename in rel_paths.items():
        fields[f'sample_{slot}'] = f'tutorial_samples/{filename}'
    fields['real_notes'] = 'True'
    fields['real_notes_pack'] = pack_id
    fields['real_notes_scale'] = scale_id
    write_song_ini(track.stems_dir, fields)

    # Mirror the slot map into the persistent track.stems dict so the
    # /api/tracks/{id} payload + /api/tracks/{id}/stems/<slot> file route
    # both reflect the new files immediately (and survive restart).
    for slot, filename in rel_paths.items():
        track.stems[f'sample_{slot}'] = f'tutorial_samples/{filename}'
    track.save()

    return {
        'pack_id': pack.pack_id,
        'scale_id': scale.scale_id,
        'slots': rel_paths,
        'sample_count': len(rel_paths),
    }
