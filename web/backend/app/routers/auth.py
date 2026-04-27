"""Cookie-based site auth. Single hardcoded user from settings."""

from __future__ import annotations

from fastapi import APIRouter, Cookie, Depends, Form, HTTPException, Response, status

from ..config import settings

router = APIRouter(prefix='/api/auth', tags=['auth'])

COOKIE_NAME = 'auth'
COOKIE_MAX_AGE = 60 * 60 * 24 * 30  # 30 days


def _expected_secret() -> str:
    return settings.studio_password


def require_auth(auth: str | None = Cookie(default=None, alias=COOKIE_NAME)) -> None:
    """FastAPI dependency: 401 unless the auth cookie matches the studio password."""
    if not auth or auth != _expected_secret():
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Not authenticated')


@router.post('/login')
async def login(
    response: Response,
    username: str = Form(...),
    password: str = Form(...),
):
    if username != settings.studio_username or password != settings.studio_password:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Invalid credentials')
    response.set_cookie(
        COOKIE_NAME,
        _expected_secret(),
        httponly=True,
        samesite='lax',
        max_age=COOKIE_MAX_AGE,
        path='/',
    )
    return {'ok': True}


@router.post('/logout')
async def logout(response: Response):
    response.delete_cookie(COOKIE_NAME, path='/')
    return {'ok': True}


@router.get('/me')
async def me(auth: str | None = Cookie(default=None, alias=COOKIE_NAME)):
    return {'authenticated': bool(auth) and auth == _expected_secret()}
