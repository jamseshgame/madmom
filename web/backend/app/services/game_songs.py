"""Read, pull, edit, and push songs in the GitHub SongInbox/ folder."""

from __future__ import annotations

import asyncio
import base64
import shutil
from pathlib import Path

import httpx

from ..config import settings
from .github_publisher import _api, _headers, publish_song_folder

LOCAL_DIR = Path(settings.upload_dir) / '_game-songs'


def _ensure_token():
    if not settings.github_token:
        raise RuntimeError('GITHUB_TOKEN is not configured in web/.env')


def _parse_song_ini(text: str) -> dict[str, str]:
    """Parse a Clone Hero song.ini into a flat dict. Ignores section headers."""
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith(('#', ';', '[')):
            continue
        if '=' not in line:
            continue
        key, _, value = line.partition('=')
        out[key.strip().lower()] = value.strip()
    return out


def _local_path(folder: str) -> Path:
    return LOCAL_DIR / folder


async def list_game_songs() -> list[dict]:
    """List every folder under SongInbox/ with parsed song.ini metadata."""
    _ensure_token()
    inbox = settings.github_inbox_prefix
    async with httpx.AsyncClient(timeout=30) as client:
        tree_resp = await client.get(
            _api(f'/git/trees/{settings.github_branch}'),
            headers=_headers(),
            params={'recursive': '1'},
        )
        tree_resp.raise_for_status()
        tree = tree_resp.json().get('tree', [])

        # Collect folders directly under SongInbox/ and their song.ini blob SHA
        folders: dict[str, dict] = {}
        for entry in tree:
            path = entry.get('path', '')
            if not path.startswith(f'{inbox}/'):
                continue
            rest = path[len(inbox) + 1 :]
            parts = rest.split('/')
            if len(parts) < 2:
                continue
            folder_name = parts[0]
            folders.setdefault(folder_name, {'folder': folder_name, 'has_ini': False, 'sha': None})
            if len(parts) == 2 and parts[1].lower() == 'song.ini' and entry.get('type') == 'blob':
                folders[folder_name]['has_ini'] = True
                folders[folder_name]['sha'] = entry.get('sha')

        # Fetch every song.ini blob in parallel
        async def _fetch(folder_name: str, sha: str | None):
            if not sha:
                return folder_name, {}
            r = await client.get(_api(f'/git/blobs/{sha}'), headers=_headers())
            if r.status_code != 200:
                return folder_name, {}
            blob = r.json()
            if blob.get('encoding') == 'base64':
                content = base64.b64decode(blob.get('content', '')).decode('utf-8', errors='replace')
            else:
                content = blob.get('content', '')
            return folder_name, _parse_song_ini(content)

        results = await asyncio.gather(
            *[_fetch(f['folder'], f['sha']) for f in folders.values()],
        )

    songs = []
    ini_map = dict(results)
    for name, entry in sorted(folders.items()):
        ini = ini_map.get(name, {})
        songs.append({
            'folder': name,
            'has_ini': entry['has_ini'],
            'name': ini.get('name', name),
            'artist': ini.get('artist', ''),
            'album': ini.get('album', ''),
            'genre': ini.get('genre', ''),
            'year': ini.get('year', ''),
            'charter': ini.get('charter', ''),
            'song_length': ini.get('song_length', ''),
            'local_pulled': _local_path(name).exists(),
        })
    return songs


async def pull_game_song(folder: str) -> Path:
    """Download every file in SongInbox/{folder}/ into {UPLOAD_DIR}/_game-songs/{folder}/."""
    _ensure_token()
    inbox = settings.github_inbox_prefix
    dest = _local_path(folder)
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)

    async with httpx.AsyncClient(timeout=60) as client:
        contents = await client.get(
            _api(f'/contents/{inbox}/{folder}'),
            headers=_headers(),
            params={'ref': settings.github_branch},
        )
        contents.raise_for_status()
        items = contents.json()

        async def _download(item):
            if item.get('type') != 'file':
                return
            sha = item.get('sha')
            name = item.get('name')
            r = await client.get(_api(f'/git/blobs/{sha}'), headers=_headers())
            r.raise_for_status()
            blob = r.json()
            data = (
                base64.b64decode(blob.get('content', ''))
                if blob.get('encoding') == 'base64'
                else blob.get('content', '').encode('utf-8')
            )
            (dest / name).write_bytes(data)

        await asyncio.gather(*[_download(item) for item in items])

    return dest


def get_local_song_ini(folder: str) -> dict[str, str]:
    """Read the local pulled song.ini. Returns {} if the folder was pulled but has no song.ini."""
    folder_dir = _local_path(folder)
    if not folder_dir.exists():
        raise FileNotFoundError(f'{folder} not pulled locally')
    path = folder_dir / 'song.ini'
    if not path.exists():
        return {}
    return _parse_song_ini(path.read_text(encoding='utf-8'))


def update_local_song_ini(folder: str, fields: dict[str, str]) -> dict[str, str]:
    """Merge fields into the local song.ini, creating the file if missing."""
    folder_dir = _local_path(folder)
    if not folder_dir.exists():
        raise FileNotFoundError(f'{folder} not pulled locally')
    path = folder_dir / 'song.ini'
    existing = _parse_song_ini(path.read_text(encoding='utf-8')) if path.exists() else {}
    existing.update({k.lower(): str(v) for k, v in fields.items() if v is not None})
    lines = ['[song]'] + [f'{k} = {v}' for k, v in existing.items()]
    path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return existing


async def push_game_song(folder: str) -> str:
    """Push the local folder back to GitHub SongInbox/{folder}/."""
    _ensure_token()
    local = _local_path(folder)
    if not local.exists():
        raise FileNotFoundError(f'{folder} not pulled locally')
    return await publish_song_folder(local, folder)
