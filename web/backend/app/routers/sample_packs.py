"""Sample-pack library + per-beatmap multi-slot real-notes packs.

A beatmap can carry an unlimited list of sample packs. Each pack lives in
its own subdirectory `<beatmap_dir>/tutorial_samples_<slot>/` and is
referenced by the chart's lane-8 modifier: the sustain field of a lane-8
row (`tick = N 8 <slot>`) selects which pack a real-note plays.

Slot indices are append-only and stable for the life of the beatmap —
removing a pack tombstones the entry as `null` rather than renumbering,
so existing chart references never break silently.
"""
from __future__ import annotations

import shutil as _sh
from pathlib import Path

from fastapi import APIRouter, Form, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from ..services import sample_packs
from ..services.tracks import Track, get_beatmap_dir, get_track

router = APIRouter(prefix='/api', tags=['sample-packs'])


# ── Per-beatmap multi-slot helpers ───────────────────────────────────────

def _beatmap_record(track: Track, beatmap_id: str) -> dict | None:
    return next((b for b in track.beatmaps if b.get('id') == beatmap_id), None)


def _ensure_sample_packs_list(rec: dict, bm_dir: Path) -> list[dict | None]:
    """Lazily migrate the old single-pack schema to the list-of-packs schema.

    Old: rec['sample_pack'] = {pack_id, scale_id}, files in tutorial_samples/.
    New: rec['sample_packs'] = [{pack_id, scale_id}, ...], files in
         tutorial_samples_<slot>/.

    Called by every endpoint before reading/writing. Idempotent — safe to
    call on already-migrated records.
    """
    packs = rec.get('sample_packs')
    if isinstance(packs, list):
        return packs
    legacy = rec.get('sample_pack')
    if isinstance(legacy, dict) and legacy.get('pack_id'):
        # Migrate file layout: tutorial_samples/ → tutorial_samples_0/
        src = bm_dir / 'tutorial_samples'
        dst = bm_dir / 'tutorial_samples_0'
        if src.is_dir() and not dst.exists():
            try:
                src.rename(dst)
            except OSError:
                pass
        new_list: list[dict | None] = [{
            'pack_id': legacy.get('pack_id'),
            'scale_id': legacy.get('scale_id'),
        }]
        rec['sample_packs'] = new_list
        rec.pop('sample_pack', None)
        return new_list
    rec['sample_packs'] = []
    return rec['sample_packs']


def _pack_dir(bm_dir: Path, slot: int) -> Path:
    return bm_dir / f'tutorial_samples_{slot}'


def _serialize_packs(packs: list[dict | None], bm_dir: Path) -> list[dict | None]:
    """Build the catalog payload returned to the editor."""
    out: list[dict | None] = []
    for slot, entry in enumerate(packs):
        if not entry:
            out.append(None)
            continue
        pdir = _pack_dir(bm_dir, slot)
        slots_present = [
            name for name in sample_packs.SLOT_ORDER
            if (pdir / f'{name}.ogg').exists()
        ] if pdir.is_dir() else []
        out.append({
            'slot': slot,
            'pack_id': entry.get('pack_id'),
            'scale_id': entry.get('scale_id'),
            'slots_present': slots_present,
        })
    return out


@router.get('/sample-packs')
async def list_packs() -> JSONResponse:
    return JSONResponse(content={
        'packs': sample_packs.pack_catalog(),
        'scales': sample_packs.scale_catalog(),
    })


@router.get('/tracks/{track_id}/beatmaps/{beatmap_id}/sample-pack')
async def get_beatmap_packs(track_id: str, beatmap_id: str) -> JSONResponse:
    """List every pack applied to this beatmap. Each entry carries its slot
    index (stable for the life of the beatmap), pack/scale ids, and the
    list of OGGs actually on disk."""
    track = get_track(track_id)
    if track is None:
        raise HTTPException(404, 'Track not found')
    rec = _beatmap_record(track, beatmap_id)
    if rec is None:
        raise HTTPException(404, 'Beatmap not found')
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        raise HTTPException(404, 'Beatmap dir missing')
    packs = _ensure_sample_packs_list(rec, bm_dir)
    return JSONResponse(content={'packs': _serialize_packs(packs, bm_dir)})


@router.post('/tracks/{track_id}/beatmaps/{beatmap_id}/sample-pack')
async def add_or_replace_beatmap_pack(
    track_id: str,
    beatmap_id: str,
    pack_id: str = Form(...),
    scale_id: str = Form(...),
    slot: int | None = Form(default=None),
):
    """Append a new pack (slot omitted) or replace an existing slot. Returns
    the slot index used so the frontend can refer to it from notes."""
    track = get_track(track_id)
    if track is None:
        raise HTTPException(404, 'Track not found')
    rec = _beatmap_record(track, beatmap_id)
    if rec is None:
        raise HTTPException(404, 'Beatmap not found')
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        raise HTTPException(404, 'Beatmap dir missing')
    pack = sample_packs.get_pack(pack_id)
    if pack is None:
        raise HTTPException(404, f'Unknown pack: {pack_id}')
    scale = sample_packs.get_scale(scale_id)
    if scale is None:
        raise HTTPException(404, f'Unknown scale: {scale_id}')

    packs = _ensure_sample_packs_list(rec, bm_dir)
    if slot is None:
        # Reuse the first tombstone if there is one — saves on directory
        # numbering. Otherwise append.
        for i, entry in enumerate(packs):
            if entry is None:
                target_slot = i
                packs[i] = {'pack_id': pack.pack_id, 'scale_id': scale.scale_id}
                break
        else:
            target_slot = len(packs)
            packs.append({'pack_id': pack.pack_id, 'scale_id': scale.scale_id})
    else:
        target_slot = int(slot)
        if target_slot < 0:
            raise HTTPException(400, 'slot must be non-negative')
        # Grow with tombstones so slot indices stay stable.
        while len(packs) <= target_slot:
            packs.append(None)
        packs[target_slot] = {'pack_id': pack.pack_id, 'scale_id': scale.scale_id}

    try:
        rel_paths = sample_packs.render_pack(pack, scale, _pack_dir(bm_dir, target_slot))
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    track.save()
    return {
        'slot': target_slot,
        'pack_id': pack.pack_id,
        'scale_id': scale.scale_id,
        'slots': rel_paths,
        'sample_count': len(rel_paths),
    }


@router.delete('/tracks/{track_id}/beatmaps/{beatmap_id}/sample-pack/{slot}')
async def delete_beatmap_pack(track_id: str, beatmap_id: str, slot: int):
    """Remove the pack at `slot`. Tombstones the list entry (None) so later
    slot indices don't shift — chart references to other slots stay valid.
    Wipes the corresponding tutorial_samples_<slot>/ folder."""
    track = get_track(track_id)
    if track is None:
        raise HTTPException(404, 'Track not found')
    rec = _beatmap_record(track, beatmap_id)
    if rec is None:
        raise HTTPException(404, 'Beatmap not found')
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        raise HTTPException(404, 'Beatmap dir missing')
    packs = _ensure_sample_packs_list(rec, bm_dir)
    if slot < 0 or slot >= len(packs) or packs[slot] is None:
        raise HTTPException(404, f'No pack at slot {slot}')
    pdir = _pack_dir(bm_dir, slot)
    if pdir.is_dir():
        _sh.rmtree(pdir, ignore_errors=True)
    packs[slot] = None
    # Trim trailing tombstones to keep the list short.
    while packs and packs[-1] is None:
        packs.pop()
    track.save()
    return {'slot': slot, 'cleared': True}


@router.get('/tracks/{track_id}/beatmaps/{beatmap_id}/sample/{slot}/{slot_name}')
async def get_beatmap_sample(track_id: str, beatmap_id: str, slot: int, slot_name: str):
    """Serve one rendered OGG (slot_name) from one pack (slot) of a beatmap.
    Used by the editor preview playback."""
    if slot_name not in sample_packs.SLOT_ORDER:
        raise HTTPException(400, f'Unknown slot name: {slot_name}')
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        raise HTTPException(404, 'Beatmap not found')
    p = _pack_dir(bm_dir, slot) / f'{slot_name}.ogg'
    if not p.exists():
        raise HTTPException(404, 'Sample not rendered')
    return FileResponse(str(p), media_type='audio/ogg', filename=f'{slot_name}.ogg')


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
