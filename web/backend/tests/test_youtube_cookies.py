"""Tests for per-user YouTube cookie handling.

The dangerous behavior under test: yt-dlp saves its cookie jar back to
`cookiefile` on close — even after failed runs. If YouTube invalidates the
session, the write-back strips every auth cookie and silently destroys the
user's upload. ytdlp_cookiefile() must therefore hand yt-dlp a disposable
copy and only persist rotation back when the jar still looks signed in.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.services import youtube_cookies as yc


def _row(name: str, value: str, domain: str = '.youtube.com') -> str:
    # Netscape format: domain, include-subdomains, path, secure, expiry, name, value
    return f'{domain}\tTRUE\t/\tTRUE\t1999999999\t{name}\t{value}'

ANON_COOKIES = '\n'.join([
    '# Netscape HTTP Cookie File',
    _row('YSC', 'abc123'),
    _row('VISITOR_INFO1_LIVE', 'xyz'),
    _row('PREF', 'hl=en'),
]) + '\n'

AUTH_COOKIES = ANON_COOKIES + '\n'.join([
    _row('SAPISID', 'auth-value-1'),
    _row('__Secure-3PSID', 'auth-value-2'),
    _row('LOGIN_INFO', 'auth-value-3'),
]) + '\n'

ROTATED_AUTH_COOKIES = ANON_COOKIES + '\n'.join([
    _row('SAPISID', 'rotated-1'),
    _row('__Secure-3PSID', 'rotated-2'),
]) + '\n'


@pytest.fixture
def cookies_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    from app import config
    monkeypatch.setattr(config.settings, 'upload_dir', str(tmp_path))
    monkeypatch.setattr(config.settings, 'youtube_cookies_file', '')
    return tmp_path


class TestHasAuthCookies:
    def test_signed_in_file(self, tmp_path: Path):
        p = tmp_path / 'c.txt'
        p.write_text(AUTH_COOKIES, encoding='utf-8')
        assert yc.has_auth_cookies(p) is True

    def test_anonymous_file(self, tmp_path: Path):
        p = tmp_path / 'c.txt'
        p.write_text(ANON_COOKIES, encoding='utf-8')
        assert yc.has_auth_cookies(p) is False

    def test_missing_file(self, tmp_path: Path):
        assert yc.has_auth_cookies(tmp_path / 'nope.txt') is False


class TestStatusSignedIn:
    def test_status_reports_signed_in(self, cookies_env: Path):
        yc.save_cookies('alice', AUTH_COOKIES)
        status = yc.cookies_status('alice')
        assert status['has_cookies'] is True
        assert status['signed_in'] is True

    def test_status_reports_signed_out(self, cookies_env: Path):
        yc.save_cookies('alice', ANON_COOKIES)
        status = yc.cookies_status('alice')
        assert status['has_cookies'] is True
        assert status['signed_in'] is False

    def test_status_no_cookies(self, cookies_env: Path):
        status = yc.cookies_status('alice')
        assert status['has_cookies'] is False
        assert status['signed_in'] is False


class TestYtdlpCookiefile:
    def test_no_cookies_yields_none(self, cookies_env: Path):
        with yc.ytdlp_cookiefile('alice') as path:
            assert path is None

    def test_yields_disposable_copy(self, cookies_env: Path):
        yc.save_cookies('alice', AUTH_COOKIES)
        canonical = yc.cookies_path('alice')
        with yc.ytdlp_cookiefile('alice') as path:
            assert path is not None
            assert Path(path) != canonical
            assert Path(path).read_text(encoding='utf-8') == AUTH_COOKIES
            # Mutating the copy mid-run must not touch the canonical file.
            Path(path).write_text(ANON_COOKIES, encoding='utf-8')
            assert canonical.read_text(encoding='utf-8') == AUTH_COOKIES

    def test_rotation_persisted_when_still_signed_in(self, cookies_env: Path):
        yc.save_cookies('alice', AUTH_COOKIES)
        canonical = yc.cookies_path('alice')
        with yc.ytdlp_cookiefile('alice') as path:
            Path(path).write_text(ROTATED_AUTH_COOKIES, encoding='utf-8')
        assert canonical.read_text(encoding='utf-8') == ROTATED_AUTH_COOKIES

    def test_clobber_not_persisted_when_auth_lost(self, cookies_env: Path):
        """yt-dlp writing back an anonymous jar must not destroy the upload."""
        yc.save_cookies('alice', AUTH_COOKIES)
        canonical = yc.cookies_path('alice')
        with yc.ytdlp_cookiefile('alice') as path:
            Path(path).write_text(ANON_COOKIES, encoding='utf-8')
        assert canonical.read_text(encoding='utf-8') == AUTH_COOKIES

    def test_persists_even_when_run_raises(self, cookies_env: Path):
        """A failed extract can still have rotated cookies worth keeping."""
        yc.save_cookies('alice', AUTH_COOKIES)
        canonical = yc.cookies_path('alice')
        with pytest.raises(RuntimeError):
            with yc.ytdlp_cookiefile('alice') as path:
                Path(path).write_text(ROTATED_AUTH_COOKIES, encoding='utf-8')
                raise RuntimeError('boom')
        assert canonical.read_text(encoding='utf-8') == ROTATED_AUTH_COOKIES

    def test_temp_copies_cleaned_up(self, cookies_env: Path):
        yc.save_cookies('alice', AUTH_COOKIES)
        with yc.ytdlp_cookiefile('alice') as path:
            pass
        assert not Path(path).exists() or Path(path) == yc.cookies_path('alice')
        leftovers = [p for p in yc.cookies_path('alice').parent.iterdir()
                     if p.name != 'alice.txt']
        assert leftovers == []

    def test_global_fallback_never_written_back(self, cookies_env: Path, monkeypatch: pytest.MonkeyPatch):
        from app import config
        global_file = cookies_env / 'global-cookies.txt'
        global_file.write_text(AUTH_COOKIES, encoding='utf-8')
        monkeypatch.setattr(config.settings, 'youtube_cookies_file', str(global_file))
        with yc.ytdlp_cookiefile('alice') as path:
            assert path is not None
            assert Path(path) != global_file
            Path(path).write_text(ROTATED_AUTH_COOKIES, encoding='utf-8')
        # Admin-managed global file is read-only to the session machinery.
        assert global_file.read_text(encoding='utf-8') == AUTH_COOKIES
