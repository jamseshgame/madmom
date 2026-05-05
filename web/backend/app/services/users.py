"""Multi-user account store with bcrypt password hashing and server-side
session tokens.

State lives in two JSON files under settings.upload_dir / 'users':
  users.json    — { "users": { "<username>": {password_hash, role, avatar, ...}}}
  sessions.json — { "<token>": {"username": "...", "created_at": <ts>} }

Avatars are PNG/JPG/WebP files stored next to the JSON in
'avatars/<username>.<ext>'.

Roles:
  admin — can manage users (only role allowed to hit /api/users/*)
  user  — everyday studio user

This file is the single source of truth for password verification and session
issuance. The auth router consumes it; everything else just trusts the
authenticated identity attached to the request.
"""
from __future__ import annotations

import datetime
import json
import re
import secrets
import time
from pathlib import Path
from typing import Optional

import bcrypt

from ..config import settings


_USERNAME_RE = re.compile(r'^[A-Za-z0-9_.-]{2,32}$')
_VALID_ROLES = {'admin', 'user'}
_SESSION_TTL_S = 60 * 60 * 24 * 30  # 30 days
_SESSION_LIMIT = 5000  # cap how many tokens we hold before pruning oldest


def _users_dir() -> Path:
    d = Path(settings.upload_dir) / 'users'
    d.mkdir(parents=True, exist_ok=True)
    return d


def _users_path() -> Path:
    return _users_dir() / 'users.json'


def _sessions_path() -> Path:
    return _users_dir() / 'sessions.json'


def _avatars_dir() -> Path:
    d = _users_dir() / 'avatars'
    d.mkdir(parents=True, exist_ok=True)
    return d


# ---------------------------------------------------------------------------
# Users store

def _load_users() -> dict[str, dict]:
    p = _users_path()
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text(encoding='utf-8'))
        return data.get('users', {}) if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_users(users: dict[str, dict]) -> None:
    p = _users_path()
    p.write_text(json.dumps({'users': users}, indent=2), encoding='utf-8')


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def verify_password(plain: str, hashed: str) -> bool:
    if not plain or not hashed:
        return False
    try:
        return bcrypt.checkpw(plain.encode('utf-8'), hashed.encode('utf-8'))
    except (ValueError, TypeError):
        return False


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def ensure_seed_admin() -> None:
    """Idempotent: if no users exist, seed one admin from settings so the
    cookie-auth flow keeps working out of the box."""
    users = _load_users()
    if users:
        return
    name = settings.studio_username or 'admin'
    pw = settings.studio_password or 'change-me'
    users[name] = {
        'password_hash': hash_password(pw),
        'role': 'admin',
        'avatar': None,
        'created_at': _now_iso(),
        'updated_at': _now_iso(),
    }
    _save_users(users)


def list_users_public() -> list[dict]:
    """Public projection — no password hashes."""
    users = _load_users()
    out = []
    for name, u in users.items():
        out.append({
            'username': name,
            'role': u.get('role', 'user'),
            'has_avatar': bool(u.get('avatar')),
            'created_at': u.get('created_at'),
            'updated_at': u.get('updated_at'),
        })
    out.sort(key=lambda x: (x['role'] != 'admin', x['username'].lower()))
    return out


def get_user(username: str) -> dict | None:
    return _load_users().get(username)


def create_user(username: str, password: str, role: str = 'user') -> dict:
    if not _USERNAME_RE.match(username):
        raise ValueError('Username must be 2–32 chars, letters / digits / _ . - only')
    if not password or len(password) < 4:
        raise ValueError('Password must be at least 4 characters')
    if role not in _VALID_ROLES:
        raise ValueError(f'Role must be one of {sorted(_VALID_ROLES)}')
    users = _load_users()
    if username in users:
        raise ValueError(f'User already exists: {username}')
    now = _now_iso()
    users[username] = {
        'password_hash': hash_password(password),
        'role': role,
        'avatar': None,
        'created_at': now,
        'updated_at': now,
    }
    _save_users(users)
    return users[username]


def update_user(
    username: str,
    *,
    password: Optional[str] = None,
    role: Optional[str] = None,
) -> dict:
    users = _load_users()
    u = users.get(username)
    if u is None:
        raise ValueError(f'User not found: {username}')
    if password is not None:
        if len(password) < 4:
            raise ValueError('Password must be at least 4 characters')
        u['password_hash'] = hash_password(password)
    if role is not None:
        if role not in _VALID_ROLES:
            raise ValueError(f'Role must be one of {sorted(_VALID_ROLES)}')
        if u.get('role') == 'admin' and role != 'admin' and _admin_count(users) <= 1:
            raise ValueError('Cannot demote the last admin')
        u['role'] = role
    u['updated_at'] = _now_iso()
    _save_users(users)
    # Drop any sessions for this user so a password / role change forces re-login.
    _drop_user_sessions(username)
    return u


def delete_user(username: str) -> None:
    users = _load_users()
    u = users.get(username)
    if u is None:
        raise ValueError(f'User not found: {username}')
    if u.get('role') == 'admin' and _admin_count(users) <= 1:
        raise ValueError('Cannot delete the last admin')
    users.pop(username, None)
    _save_users(users)
    _drop_user_sessions(username)
    # Clean up avatar
    avatar = u.get('avatar')
    if avatar:
        try:
            (_avatars_dir() / avatar).unlink(missing_ok=True)
        except OSError:
            pass


def set_avatar(username: str, payload: bytes, ext: str) -> str:
    """Save an avatar image. ext is the lowercased extension without dot:
    'png', 'jpg', 'jpeg', or 'webp'."""
    if ext not in {'png', 'jpg', 'jpeg', 'webp'}:
        raise ValueError(f'Unsupported avatar format: .{ext}')
    if len(payload) > 4 * 1024 * 1024:
        raise ValueError('Avatar exceeds 4 MB limit')
    users = _load_users()
    u = users.get(username)
    if u is None:
        raise ValueError(f'User not found: {username}')
    # Drop any prior file for this user so format changes don't leave stragglers
    old = u.get('avatar')
    if old:
        try:
            (_avatars_dir() / old).unlink(missing_ok=True)
        except OSError:
            pass
    filename = f'{username}.{ext}'
    (_avatars_dir() / filename).write_bytes(payload)
    u['avatar'] = filename
    u['updated_at'] = _now_iso()
    _save_users(users)
    return filename


def avatar_path(username: str) -> Path | None:
    u = _load_users().get(username)
    if not u or not u.get('avatar'):
        return None
    p = _avatars_dir() / u['avatar']
    return p if p.exists() else None


def _admin_count(users: dict[str, dict]) -> int:
    return sum(1 for u in users.values() if u.get('role') == 'admin')


# ---------------------------------------------------------------------------
# Session tokens (cookie value is one of these)

def _load_sessions() -> dict[str, dict]:
    p = _sessions_path()
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text(encoding='utf-8'))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_sessions(sessions: dict[str, dict]) -> None:
    _sessions_path().write_text(json.dumps(sessions), encoding='utf-8')


def _drop_user_sessions(username: str) -> None:
    sessions = _load_sessions()
    keep = {t: s for t, s in sessions.items() if s.get('username') != username}
    if len(keep) != len(sessions):
        _save_sessions(keep)


def _prune_sessions(sessions: dict[str, dict]) -> dict[str, dict]:
    cutoff = time.time() - _SESSION_TTL_S
    pruned = {t: s for t, s in sessions.items() if s.get('created_at', 0) > cutoff}
    if len(pruned) > _SESSION_LIMIT:
        # Keep newest only
        sorted_items = sorted(pruned.items(), key=lambda kv: kv[1].get('created_at', 0), reverse=True)
        pruned = dict(sorted_items[:_SESSION_LIMIT])
    return pruned


def issue_session(username: str) -> str:
    sessions = _prune_sessions(_load_sessions())
    token = secrets.token_urlsafe(32)
    sessions[token] = {'username': username, 'created_at': time.time()}
    _save_sessions(sessions)
    return token


def resolve_session(token: str | None) -> dict | None:
    """Given a cookie value, return the user dict (with role) it authenticates,
    or None. Falls back to the legacy single-password cookie format so existing
    browsers stay logged in across the multi-user migration."""
    if not token:
        return None
    sessions = _load_sessions()
    s = sessions.get(token)
    if s and time.time() - s.get('created_at', 0) < _SESSION_TTL_S:
        username = s['username']
        u = get_user(username)
        if u is None:
            return None
        return {'username': username, 'role': u.get('role', 'user'), 'has_avatar': bool(u.get('avatar'))}
    # Legacy cookie: literal studio_password value. Treat as the seed admin.
    if settings.studio_password and token == settings.studio_password:
        seed = settings.studio_username or 'admin'
        u = get_user(seed)
        if u is None:
            return None
        return {'username': seed, 'role': u.get('role', 'admin'), 'has_avatar': bool(u.get('avatar'))}
    return None


def revoke_session(token: str | None) -> None:
    if not token:
        return
    sessions = _load_sessions()
    if sessions.pop(token, None) is not None:
        _save_sessions(sessions)


def authenticate(username: str, password: str) -> dict | None:
    """Return the user dict on success, None otherwise."""
    u = get_user(username)
    if u is None:
        return None
    if not verify_password(password, u.get('password_hash', '')):
        return None
    return u
