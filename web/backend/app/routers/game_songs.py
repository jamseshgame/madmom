"""Game Songs router — list, pull, edit, and push songs in the GitHub SongInbox."""

from __future__ import annotations

import json

from fastapi import APIRouter, Form, HTTPException

from ..services.game_songs import (
    clone_game_song_to_studio_track,
    get_local_song_ini,
    list_game_songs,
    pull_game_song,
    push_game_song,
    update_local_song_ini,
)

router = APIRouter(prefix='/api/game-songs', tags=['game-songs'])


@router.get('')
async def get_all():
    try:
        return await list_game_songs()
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    except Exception as e:
        raise HTTPException(502, f'GitHub list failed: {e}')


@router.post('/{folder}/pull')
async def pull(folder: str):
    try:
        dest = await pull_game_song(folder)
        # Also stand up (or reuse) a Studio Track shim so the song is
        # editable from the beatmap editor. Idempotent across re-pulls.
        track_id, beatmap_id = clone_game_song_to_studio_track(folder)
        return {
            'folder': folder,
            'local_path': str(dest),
            'track_id': track_id,
            'beatmap_id': beatmap_id,
        }
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    except Exception as e:
        raise HTTPException(502, f'Pull failed: {e}')


@router.get('/{folder}/meta')
async def get_meta(folder: str):
    try:
        return get_local_song_ini(folder)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@router.patch('/{folder}/meta')
async def update_meta(folder: str, fields: str = Form(...)):
    try:
        parsed = json.loads(fields)
    except json.JSONDecodeError:
        raise HTTPException(400, 'fields must be JSON')
    try:
        return update_local_song_ini(folder, parsed)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@router.post('/{folder}/push')
async def push(folder: str):
    try:
        commit_url = await push_game_song(folder)
        return {'commit_url': commit_url}
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    except Exception as e:
        raise HTTPException(502, f'Push failed: {e}')
