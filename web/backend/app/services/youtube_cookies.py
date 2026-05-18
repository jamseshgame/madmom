"""Per-user YouTube cookies storage for yt-dlp.

YouTube increasingly gates anonymous cloud IPs behind a bot wall. Users
upload a Netscape-format cookies.txt exported from their signed-in
browser session (via the 'Get cookies.txt LOCALLY' extension), which
yt-dlp then uses to authenticate.

Layout: <upload_dir>/youtube-cookies/<username>.txt. One file per user.
Files are mode 0o600 so other accounts on the host can't read them.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from ..config import settings


_NETSCAPE_HEADER_RE = re.compile(r'^#\s*Netscape HTTP Cookie File', re.IGNORECASE)
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
        return {'has_cookies': False, 'uploaded_at': None, 'size_bytes': 0}
    stat = p.stat()
    import datetime as dt
    return {
        'has_cookies': True,
        'uploaded_at': dt.datetime.utcfromtimestamp(stat.st_mtime).isoformat() + 'Z',
        'size_bytes': stat.st_size,
    }


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
