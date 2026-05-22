"""Feedback CRUD + aggregation endpoints.

Any logged-in user can read or write feedback. Edits are author-only.
Deletes are allowed for the author or an admin. The /aggregate endpoint
is admin-only and serves the preset proposer."""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException

from ..services import feedback as feedback_service
from .auth import require_admin, require_auth


router = APIRouter(prefix='/api/feedback', tags=['feedback'])


@router.get('/tags')
async def get_tags(_user: dict = Depends(require_auth)) -> dict[str, list[str]]:
    return feedback_service.FEEDBACK_TAGS


@router.get('/tracks/{track_id}/beatmaps/{beatmap_id}')
async def list_notes(track_id: str, beatmap_id: str,
                     _user: dict = Depends(require_auth)) -> list[dict]:
    return feedback_service.list_notes(track_id, beatmap_id)


@router.post('/tracks/{track_id}/beatmaps/{beatmap_id}')
async def create_note(track_id: str, beatmap_id: str,
                      body: dict = Body(...),
                      user: dict = Depends(require_auth)) -> dict:
    try:
        return feedback_service.add_note(
            track_id, beatmap_id,
            author=user['username'],
            rating=body.get('rating'),
            tags=body.get('tags') or [],
            text=body.get('text') or '',
        )
    except feedback_service.FeedbackError as e:
        # User-facing schema errors → 422 (not 400) for symmetry with FastAPI's defaults
        raise HTTPException(422, str(e))


@router.put('/tracks/{track_id}/beatmaps/{beatmap_id}/{note_id}')
async def edit_note(track_id: str, beatmap_id: str, note_id: str,
                    body: dict = Body(...),
                    user: dict = Depends(require_auth)) -> dict:
    try:
        return feedback_service.update_note(
            track_id, beatmap_id, note_id,
            requester=user['username'],
            rating=body.get('rating'),
            tags=body.get('tags'),
            text=body.get('text'),
        )
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except feedback_service.FeedbackError as e:
        if 'not found' in str(e):
            raise HTTPException(404, str(e))
        raise HTTPException(422, str(e))


@router.delete('/tracks/{track_id}/beatmaps/{beatmap_id}/{note_id}')
async def remove_note(track_id: str, beatmap_id: str, note_id: str,
                      user: dict = Depends(require_auth)) -> dict:
    try:
        feedback_service.delete_note(
            track_id, beatmap_id, note_id,
            requester=user['username'],
            is_admin=(user.get('role') == 'admin'),
        )
        return {'ok': True}
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except feedback_service.FeedbackError as e:
        raise HTTPException(404, str(e))


@router.get('/aggregate')
async def aggregate(stem: str, _admin: dict = Depends(require_admin)) -> list[dict]:
    return feedback_service.aggregate_for_stem(stem)
