"""Admin-only user management.

Every route under /api/users requires an admin session. The single exception
is GET /api/users/{username}/avatar which is reachable by any authenticated
user (so navigation chrome can show avatars).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from ..services import users as users_service
from .auth import require_admin, require_auth

router = APIRouter(prefix='/api/users', tags=['users'])


@router.get('')
async def list_users(_admin: dict = Depends(require_admin)):
    return users_service.list_users_public()


@router.post('')
async def create_user(
    username: str = Form(...),
    password: str = Form(...),
    role: str = Form('user'),
    _admin: dict = Depends(require_admin),
):
    try:
        users_service.create_user(username.strip(), password, role)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {'ok': True, 'username': username.strip()}


@router.put('/{username}')
async def update_user(
    username: str,
    password: str | None = Form(None),
    role: str | None = Form(None),
    _admin: dict = Depends(require_admin),
):
    if password is None and role is None:
        raise HTTPException(400, 'Provide at least one of password, role')
    try:
        users_service.update_user(username, password=password or None, role=role or None)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {'ok': True, 'username': username}


@router.delete('/{username}')
async def delete_user(username: str, admin: dict = Depends(require_admin)):
    if username == admin['username']:
        raise HTTPException(400, 'Cannot delete your own account while signed in')
    try:
        users_service.delete_user(username)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {'ok': True}


@router.put('/{username}/avatar')
async def upload_avatar(
    username: str,
    avatar: UploadFile = File(...),
    user: dict = Depends(require_auth),
):
    """Allow either an admin or the user themselves to set their avatar."""
    if user['role'] != 'admin' and user['username'] != username:
        raise HTTPException(403, 'Forbidden')
    if users_service.get_user(username) is None:
        raise HTTPException(404, f'User not found: {username}')
    filename = (avatar.filename or '').lower()
    ext = filename.rsplit('.', 1)[-1] if '.' in filename else ''
    if ext == 'jpeg':
        ext = 'jpg'
    payload = await avatar.read()
    try:
        saved = users_service.set_avatar(username, payload, ext)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {'ok': True, 'avatar': saved}


@router.get('/{username}/avatar')
async def get_avatar(username: str, _user: dict = Depends(require_auth)):
    p = users_service.avatar_path(username)
    if p is None:
        raise HTTPException(404, 'No avatar set')
    from fastapi.responses import FileResponse
    media = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    }.get(p.suffix.lower(), 'application/octet-stream')
    return FileResponse(str(p), media_type=media)
