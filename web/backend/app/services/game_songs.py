"""Read, pull, edit, and push songs in the GitHub SongInbox/ folder."""

from __future__ import annotations

import asyncio
import base64
import json
import shutil
import time
import uuid
from pathlib import Path

import httpx

from ..config import settings
from .github_publisher import _api, _headers, publish_song_folder
from .tracks import TRACKS_DIR, Track

LOCAL_DIR = Path(settings.upload_dir) / '_game-songs'


def _ensure_token():
    if not settings.github_token:
        raise RuntimeError('GITHUB_TOKEN is not configured in web/.env')


def _parse_song_ini(text: str) -> dict[str, str]:
    """Parse a song.ini into a flat dict. Ignores section headers."""
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


def _link_or_copy(src: Path, dst: Path) -> None:
    """Symlink src→dst, falling back to a file copy if the OS refuses
    (Windows without Developer Mode, exotic filesystems). Idempotent."""
    if dst.exists() or dst.is_symlink():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        dst.symlink_to(src)
    except (OSError, NotImplementedError):
        shutil.copy2(str(src), str(dst))


def _link_or_copy_dir(src: Path, dst: Path) -> None:
    """Directory variant. Same fallback semantics."""
    if dst.exists() or dst.is_symlink():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        dst.symlink_to(src, target_is_directory=True)
    except (OSError, NotImplementedError):
        shutil.copytree(str(src), str(dst))


def _find_track_by_source_game_song(folder: str) -> Track | None:
    """Scan the Tracks store for one already shimmed off this game-song folder.
    Used to keep `clone_game_song_to_studio_track` idempotent across repeat
    pulls of the same song."""
    if not TRACKS_DIR.exists():
        return None
    for d in TRACKS_DIR.iterdir():
        meta = d / 'track.json'
        if not meta.is_file():
            continue
        try:
            data = json.loads(meta.read_text(encoding='utf-8'))
        except json.JSONDecodeError:
            continue
        if data.get('source_game_song') == folder:
            return Track.load(d.name)
    return None


def clone_game_song_to_studio_track(folder: str) -> tuple[str, str]:
    """Create (or reuse) a Studio Track whose files symlink back into the
    pulled game-song folder, so the editor can open it and edits flow back
    to the same on-disk paths "Push to game repo" reads from.

    Returns (track_id, beatmap_id). Raises FileNotFoundError if the
    game-song hasn't been pulled yet.
    """
    src = _local_path(folder)
    if not src.exists():
        raise FileNotFoundError(f'{folder} not pulled locally')

    existing = _find_track_by_source_game_song(folder)
    if existing and existing.beatmaps:
        # Re-pull may have brought down subdirectories (vo/, realnotes/) that
        # weren't present last time. Refresh the symlinks so the editor can
        # see them without forcing the user to delete the shim first.
        bm_id = existing.beatmaps[0]['id']
        bm_dir = existing.beatmaps_dir / bm_id
        for subdir in ('vo', 'realnotes'):
            sub = src / subdir
            if sub.is_dir() and not (bm_dir / subdir).exists():
                _link_or_copy_dir(sub, bm_dir / subdir)
        return existing.id, bm_id

    ini_path = src / 'song.ini'
    ini = _parse_song_ini(ini_path.read_text(encoding='utf-8', errors='replace')) if ini_path.exists() else {}

    track = Track(
        id=uuid.uuid4().hex[:12],
        name=ini.get('name', folder),
        created_at=time.time(),
        stems={'song': 'song.ogg'},
        model='manual',
        output_format='ogg',
        artist=ini.get('artist', ''),
        album=ini.get('album', ''),
        genre=ini.get('genre', ''),
        year=ini.get('year', ''),
        source_game_song=folder,
    )
    track.stems_dir.mkdir(parents=True, exist_ok=True)
    if (src / 'song.ogg').exists():
        _link_or_copy(src / 'song.ogg', track.stems_dir / 'song.ogg')
    if ini_path.exists():
        # Studio's track-level metadata reader looks at stems_dir/song.ini.
        _link_or_copy(ini_path, track.stems_dir / 'song.ini')

    beatmap_id = uuid.uuid4().hex[:12]
    bm_dir = track.beatmaps_dir / beatmap_id
    bm_dir.mkdir(parents=True, exist_ok=True)

    # Editor prefers `notes.chart`; the pulled file is `notes_fixed_slides.chart`.
    # Link both names so the chart is found whichever the editor asks for.
    chart_src = src / 'notes_fixed_slides.chart'
    if not chart_src.exists():
        candidate = next(iter(src.glob('*.chart')), None)
        if candidate:
            chart_src = candidate
    if chart_src.exists():
        _link_or_copy(chart_src, bm_dir / 'notes.chart')

    if (src / 'song.ogg').exists():
        _link_or_copy(src / 'song.ogg', bm_dir / 'song.ogg')
    if ini_path.exists():
        _link_or_copy(ini_path, bm_dir / 'song.ini')
    # vo/ and realnotes/ — link the whole subdir so any new clips/packs added
    # later show up automatically without re-running this function.
    for subdir in ('vo', 'realnotes'):
        sub = src / subdir
        if sub.is_dir():
            _link_or_copy_dir(sub, bm_dir / subdir)

    track.beatmaps.append({
        'id': beatmap_id,
        'stem': 'song',
        'generated_at': time.time(),
        'folder_name': folder,
        'song_name': ini.get('name', folder),
        'active': True,
        'model': 'imported',
        'model_version': None,
    })
    track.save()
    return track.id, beatmap_id


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
    """Recursively download SongInbox/{folder}/ into _game-songs/{folder}/.

    Uses the tree API with `recursive=1` so subdirectories like `vo/`,
    `vo/clips/`, and `realnotes/<pack>/<scale>/` all come down — the older
    `/contents/<path>` walk only covered the top level and silently dropped
    any nested asset.
    """
    _ensure_token()
    inbox = settings.github_inbox_prefix
    dest = _local_path(folder)
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)

    prefix = f'{inbox}/{folder}/'
    async with httpx.AsyncClient(timeout=60) as client:
        tree_resp = await client.get(
            _api(f'/git/trees/{settings.github_branch}'),
            headers=_headers(),
            params={'recursive': '1'},
        )
        tree_resp.raise_for_status()
        tree = tree_resp.json()
        if tree.get('truncated'):
            # GitHub truncates trees above ~100k entries / 7 MB. Songs with
            # large realnotes/ subtrees can push the repo over the limit;
            # we'd need a per-subdir fallback to handle that. Flag it
            # loudly so the operator notices.
            raise RuntimeError(
                f'GitHub tree response was truncated; cannot reliably pull {folder}'
            )
        # Filter to blobs under our folder, preserving the relative path.
        targets: list[tuple[str, str]] = []
        for entry in tree.get('tree', []):
            if entry.get('type') != 'blob':
                continue
            path = entry.get('path', '')
            if not path.startswith(prefix):
                continue
            rel = path[len(prefix):]
            if not rel:
                continue
            targets.append((rel, entry.get('sha', '')))

        sem = asyncio.Semaphore(8)

        async def _download(rel: str, sha: str):
            async with sem:
                r = await client.get(_api(f'/git/blobs/{sha}'), headers=_headers())
            r.raise_for_status()
            blob = r.json()
            data = (
                base64.b64decode(blob.get('content', ''))
                if blob.get('encoding') == 'base64'
                else blob.get('content', '').encode('utf-8')
            )
            out_path = dest / rel
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(data)

        await asyncio.gather(*[_download(rel, sha) for rel, sha in targets])

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
