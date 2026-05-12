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
from ..services.tracks import get_beatmap_dir, get_track

router = APIRouter(prefix='/api', tags=['sample-packs'])


@router.get('/sample-packs')
async def list_packs() -> JSONResponse:
    return JSONResponse(content={
        'packs': sample_packs.pack_catalog(),
        'scales': sample_packs.scale_catalog(),
    })


@router.get('/tracks/{track_id}/beatmaps/{beatmap_id}/sample-pack')
async def get_beatmap_pack(track_id: str, beatmap_id: str) -> JSONResponse:
    """Return the pack/scale applied to this beatmap (or `null`s) plus a
    list of which slot OGGs are actually on disk. The editor uses this to
    decide whether to wire up real-notes preview playback."""
    track = get_track(track_id)
    if track is None:
        raise HTTPException(404, 'Track not found')
    rec = next((b for b in track.beatmaps if b.get('id') == beatmap_id), None)
    if rec is None:
        raise HTTPException(404, 'Beatmap not found')
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    samples_dir = bm_dir / 'tutorial_samples' if bm_dir else None
    slots_present: list[str] = []
    if samples_dir and samples_dir.is_dir():
        for slot in sample_packs.SLOT_ORDER:
            if (samples_dir / f'{slot}.ogg').exists():
                slots_present.append(slot)
    pack_info = rec.get('sample_pack') or {}
    return JSONResponse(content={
        'pack_id': pack_info.get('pack_id'),
        'scale_id': pack_info.get('scale_id'),
        'slots_present': slots_present,
    })


@router.post('/tracks/{track_id}/beatmaps/{beatmap_id}/apply-sample-pack')
async def apply_beatmap_pack(
    track_id: str,
    beatmap_id: str,
    pack_id: str = Form(...),
    scale_id: str = Form(...),
):
    """Per-beatmap sample-pack apply. Renders 10 OGGs into
    `<beatmap_dir>/tutorial_samples/` and records pack/scale on the beatmap
    metadata so the editor can show the current selection across reloads."""
    track = get_track(track_id)
    if track is None:
        raise HTTPException(404, 'Track not found')
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        raise HTTPException(404, 'Beatmap not found')
    pack = sample_packs.get_pack(pack_id)
    if pack is None:
        raise HTTPException(404, f'Unknown pack: {pack_id}')
    scale = sample_packs.get_scale(scale_id)
    if scale is None:
        raise HTTPException(404, f'Unknown scale: {scale_id}')
    out_dir = bm_dir / 'tutorial_samples'
    try:
        rel_paths = sample_packs.render_pack(pack, scale, out_dir)
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    # Persist the (pack, scale) choice on the beatmap record so the editor
    # can reflect it on reload and publish can stamp song.ini per beatmap.
    for rec in track.beatmaps:
        if rec.get('id') == beatmap_id:
            rec['sample_pack'] = {'pack_id': pack.pack_id, 'scale_id': scale.scale_id}
            break
    track.save()
    return {
        'pack_id': pack.pack_id,
        'scale_id': scale.scale_id,
        'slots': rel_paths,
        'sample_count': len(rel_paths),
    }


@router.delete('/tracks/{track_id}/beatmaps/{beatmap_id}/sample-pack')
async def clear_beatmap_pack(track_id: str, beatmap_id: str):
    """Drop the rendered tutorial_samples folder and clear the pack record
    on this beatmap. Useful for switching from one pack to none without
    leaving stale OGGs behind."""
    track = get_track(track_id)
    if track is None:
        raise HTTPException(404, 'Track not found')
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        raise HTTPException(404, 'Beatmap not found')
    samples_dir = bm_dir / 'tutorial_samples'
    if samples_dir.is_dir():
        import shutil as _sh
        _sh.rmtree(samples_dir, ignore_errors=True)
    cleared = False
    for rec in track.beatmaps:
        if rec.get('id') == beatmap_id:
            if 'sample_pack' in rec:
                rec.pop('sample_pack', None)
                cleared = True
            break
    if cleared:
        track.save()
    return {'cleared': cleared}


@router.get('/tracks/{track_id}/beatmaps/{beatmap_id}/sample/{slot}')
async def get_beatmap_sample(track_id: str, beatmap_id: str, slot: str):
    """Serve one of the rendered slot OGGs from the beatmap's
    tutorial_samples/ folder. Used by the editor preview playback."""
    if slot not in sample_packs.SLOT_ORDER:
        raise HTTPException(400, f'Unknown slot: {slot}')
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        raise HTTPException(404, 'Beatmap not found')
    p = bm_dir / 'tutorial_samples' / f'{slot}.ogg'
    if not p.exists():
        raise HTTPException(404, 'Sample not rendered for this beatmap')
    return FileResponse(str(p), media_type='audio/ogg', filename=f'{slot}.ogg')


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
