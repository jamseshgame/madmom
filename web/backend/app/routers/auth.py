"""Cookie-based site auth, multi-user via users.json + bcrypt.

Backwards compatible with the old single-password cookie: if a browser
presents the legacy literal-password cookie value, we resolve it to the
seed admin user (see services/users.py::resolve_session)."""

from __future__ import annotations

from contextvars import ContextVar

from fastapi import APIRouter, Cookie, Depends, Form, HTTPException, Response, status
from fastapi.responses import JSONResponse

from ..services import users as users_service

router = APIRouter(prefix='/api/auth', tags=['auth'])

COOKIE_NAME = 'auth'
COOKIE_MAX_AGE = 60 * 60 * 24 * 30  # 30 days

# Set by require_auth on every authenticated request so create_job can
# attribute jobs to the actually authenticated user without every route
# having to thread the user dict through.
current_user: ContextVar[dict | None] = ContextVar('current_user', default=None)


def require_auth(auth: str | None = Cookie(default=None, alias=COOKIE_NAME)) -> dict:
    """FastAPI dependency: returns the authenticated user dict
    {username, role, has_avatar} or raises 401."""
    user = users_service.resolve_session(auth)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Not authenticated')
    current_user.set(user)
    return user


def require_admin(user: dict = Depends(require_auth)) -> dict:
    """FastAPI dependency for admin-only routes. Chains through
    require_auth, then refuses non-admins with 403."""
    if user.get('role') != 'admin':
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail='Admin only')
    return user


@router.post('/login')
async def login(
    response: Response,
    username: str = Form(...),
    password: str = Form(...),
):
    # Ensure the seed admin exists on first ever login attempt.
    users_service.ensure_seed_admin()
    user = users_service.authenticate(username, password)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Invalid credentials')
    token = users_service.issue_session(username)
    response.set_cookie(
        COOKIE_NAME,
        token,
        httponly=True,
        samesite='lax',
        max_age=COOKIE_MAX_AGE,
        path='/',
    )
    return {
        'ok': True,
        'username': username,
        'role': user.get('role', 'user'),
        'has_avatar': bool(user.get('avatar')),
    }


@router.post('/logout')
async def logout(
    response: Response,
    auth: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    users_service.revoke_session(auth)
    response.delete_cookie(COOKIE_NAME, path='/')
    return {'ok': True}


@router.get('/me')
async def me(auth: str | None = Cookie(default=None, alias=COOKIE_NAME)):
    user = users_service.resolve_session(auth)
    if user is None:
        return {'authenticated': False}
    return {
        'authenticated': True,
        'username': user['username'],
        'role': user['role'],
        'has_avatar': user.get('has_avatar', False),
    }


@router.post('/change-password')
async def change_password(
    new_password: str = Form(...),
    user: dict = Depends(require_auth),
):
    """Self-service password change. update_user wipes existing sessions
    for this user, so we issue a fresh one and set the cookie."""
    try:
        users_service.update_user(user['username'], password=new_password)
    except ValueError as e:
        raise HTTPException(400, str(e))
    new_token = users_service.issue_session(user['username'])
    resp = JSONResponse({'ok': True})
    resp.set_cookie(
        COOKIE_NAME,
        new_token,
        httponly=True,
        samesite='lax',
        max_age=COOKIE_MAX_AGE,
        path='/',
    )
    return resp
