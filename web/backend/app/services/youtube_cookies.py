"""Per-user YouTube cookies storage for yt-dlp.

YouTube increasingly gates anonymous cloud IPs behind a bot wall. Users
upload a Netscape-format cookies.txt exported from their signed-in
browser session (via the 'Get cookies.txt LOCALLY' extension), which
yt-dlp then uses to authenticate.

Layout: <upload_dir>/youtube-cookies/<username>.txt. One file per user.
Files are mode 0o600 so other accounts on the host can't read them.
"""
from __future__ import annotations

import contextlib
import os
import re
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from ..config import settings


_NETSCAPE_HEADER_RE = re.compile(r'^#\s*Netscape HTTP Cookie File', re.IGNORECASE)

# Cookies that only exist for a signed-in Google session. Their absence means
# yt-dlp is effectively anonymous — exactly what the datacenter bot wall blocks.
_AUTH_COOKIE_NAMES = frozenset({
    'SID', 'HSID', 'SSID', 'APISID', 'SAPISID', 'LOGIN_INFO',
    '__Secure-1PSID', '__Secure-3PSID',
    '__Secure-1PAPISID', '__Secure-3PAPISID',
})
# Sanity-check filename: alphanum, dot, underscore, hyphen. Matches the
# username constraints in services/users.py — no path traversal.
_SAFE_NAME_RE = re.compile(r'^[A-Za-z0-9._-]{1,64}$')


def _cookies_dir() -> Path:
    d = Path(settings.upload_dir) / 'youtube-cookies'
    d.mkdir(parents=True, exist_ok=True)
    return d


def cookies_path(username: str | None) -> Path | None:
    if not username or not _SAFE_NAME_RE.match(username):
        return None
    return _cookies_dir() / f'{username}.txt'


def save_cookies(username: str, content: bytes | str) -> dict[str, Any]:
    """Validate + persist cookies for a user. Returns status dict.

    Validation is light: the file must look like Netscape format (first
    non-blank, non-comment lines have 7 tab-separated fields, or carry
    the standard `# Netscape HTTP Cookie File` banner). Rejects HTML,
    PDFs, etc. that users sometimes upload by mistake.
    """
    p = cookies_path(username)
    if p is None:
        raise ValueError(f'invalid username for cookies storage: {username!r}')

    if isinstance(content, bytes):
        try:
            text = content.decode('utf-8', errors='replace')
        except Exception as e:
            raise ValueError(f'cookies file is not valid UTF-8: {e}')
    else:
        text = content

    has_header = False
    has_cookie_row = False
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith('#'):
            if _NETSCAPE_HEADER_RE.match(stripped):
                has_header = True
            continue
        # Real cookie rows: 7 tab-separated fields (Netscape spec).
        if stripped.count('\t') >= 6:
            has_cookie_row = True
            break
    if not (has_header or has_cookie_row):
        raise ValueError(
            'file does not look like a Netscape cookies.txt — '
            'export with the "Get cookies.txt LOCALLY" extension and try again'
        )

    p.write_text(text, encoding='utf-8')
    try:
        os.chmod(p, 0o600)
    except OSError:
        # chmod fails silently on Windows; OK
        pass
    return cookies_status(username)


def delete_cookies(username: str) -> bool:
    p = cookies_path(username)
    if p is None or not p.exists():
        return False
    p.unlink()
    return True


def cookies_status(username: str | None) -> dict[str, Any]:
    p = cookies_path(username)
    if p is None or not p.exists():
        return {'has_cookies': False, 'uploaded_at': None, 'size_bytes': 0, 'signed_in': False}
    stat = p.stat()
    import datetime as dt
    return {
        'has_cookies': True,
        'uploaded_at': dt.datetime.utcfromtimestamp(stat.st_mtime).isoformat() + 'Z',
        'size_bytes': stat.st_size,
        'signed_in': has_auth_cookies(p),
    }


def has_auth_cookies(path: Path | str) -> bool:
    """True if the cookies file carries a signed-in Google session."""
    p = Path(path)
    if not p.is_file():
        return False
    try:
        text = p.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return False
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            continue
        fields = stripped.split('\t')
        if len(fields) >= 7 and fields[5] in _AUTH_COOKIE_NAMES:
            return True
    return False


def resolve_cookies_for_user(username: str | None) -> str | None:
    """Return the cookies file path to pass to yt-dlp. Per-user file if
    present; falls back to the global YOUTUBE_COOKIES_FILE setting; None
    if neither is configured."""
    p = cookies_path(username)
    if p is not None and p.exists():
        return str(p)
    global_path = (settings.youtube_cookies_file or '').strip()
    if global_path and Path(global_path).is_file():
        return global_path
    return None


@contextlib.contextmanager
def ytdlp_cookiefile(username: str | None) -> Iterator[str | None]:
    """Yield a disposable copy of the user's cookies for one yt-dlp run.

    yt-dlp saves its cookie jar back to `cookiefile` when it closes — even
    after failed runs. Handing it the canonical file means a bot-walled or
    invalidated session overwrites the user's upload with an anonymous jar
    (this happened in production: only YSC/VISITOR_INFO survived). So:

    - yt-dlp always gets a temp copy, never the canonical file;
    - after the run, rotated cookies are persisted back to the per-user
      file ONLY if the jar still looks signed in (rotation keeps the
      session fresh; a stripped jar is discarded);
    - the admin-managed global fallback is never written back to.
    """
    src = resolve_cookies_for_user(username)
    if src is None:
        yield None
        return

    per_user = cookies_path(username)
    is_per_user = per_user is not None and str(per_user) == src

    # Same dir as the canonical file so os.replace stays on one filesystem.
    fd, tmp_name = tempfile.mkstemp(
        suffix='.tmp', prefix='ytdlp-', dir=str(Path(src).parent),
    )
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(Path(src).read_bytes())
        with contextlib.suppress(OSError):
            os.chmod(tmp_name, 0o600)
        try:
            yield tmp_name
        finally:
            if is_per_user and has_auth_cookies(tmp_name) and Path(src).exists():
                os.replace(tmp_name, src)
    finally:
        with contextlib.suppress(OSError):
            os.unlink(tmp_name)
