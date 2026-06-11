"""Read, pull, edit, and push songs in the GitHub SongInbox/ folder."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import shutil
import time
import uuid
from pathlib import Path

import httpx

from ..config import settings
from .chart_generator import _DIFF_SECTION_RE, split_merged_chart, splice_stem_charts_into_merged
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


# Oggs in a game-song folder that aren't instrument/mix stems.
_NON_STEM_OGGS = {'preview'}
# Folder-level files mirrored into the shim track's stems_dir so the Studio
# track page (metadata form, album art) and the vocals/lyrics editors see them.
_STEM_DIR_AUX_FILES = ('song.ini', 'album.png', 'vocal_notes.json', 'lyrics.json')


def _find_published_chart(src: Path) -> Path | None:
    """The canonical published chart in a pulled folder. Game folders may also
    carry notes.chart / notes_original.chart artifacts from older pipelines."""
    for name in ('notes_fixed_slides.chart', 'notes.chart'):
        p = src / name
        if p.exists():
            return p
    return next(iter(src.glob('*.chart')), None)


def _stable_beatmap_id(folder: str, suffix: str, n: int) -> str:
    """Deterministic beatmap id for split chart groups that carry no
    beatmap_id in [Beatmaps] — keeps ids stable across re-pulls."""
    return hashlib.sha1(f'{folder}|{suffix}|{n}'.encode('utf-8')).hexdigest()[:12]


def clone_game_song_to_studio_track(folder: str) -> tuple[str, str]:
    """Create (or refresh) a Studio Track shim for a pulled game-song folder.

    Every stem ogg in the folder (drums.ogg, guitar.ogg, rhythm.ogg, …, plus
    song.ogg as the master mix) is registered as a track stem, linking back
    into the pulled folder. The published chart is split into per-stem
    beatmaps — the inverse of merge_beatmap_charts — so each chart is
    assigned to its stem exactly like freshly generated tracks. Per-beatmap
    notes.chart files are real files (the split content differs from the
    merged chart), so push_game_song splices editor edits back into the
    folder's chart before publishing.

    Rebuilds imported beatmaps on every pull (pull itself resets the local
    folder to repo state); Studio-generated beatmaps on the shim track
    (model != 'imported') are left untouched. Ids are stable across re-pulls
    via the [Beatmaps] block / a folder+section hash.

    Returns (track_id, primary_beatmap_id). Raises FileNotFoundError if the
    game-song hasn't been pulled yet.
    """
    src = _local_path(folder)
    if not src.exists():
        raise FileNotFoundError(f'{folder} not pulled locally')

    ini_path = src / 'song.ini'
    ini = _parse_song_ini(ini_path.read_text(encoding='utf-8', errors='replace')) if ini_path.exists() else {}

    stem_oggs = {p.stem: p.name for p in sorted(src.glob('*.ogg')) if p.stem not in _NON_STEM_OGGS}

    track = _find_track_by_source_game_song(folder)
    if track is None:
        track = Track(
            id=uuid.uuid4().hex[:12],
            name=ini.get('name', folder),
            created_at=time.time(),
            stems={},
            model='manual',
            output_format='ogg',
            source_game_song=folder,
        )
    track.name = ini.get('name', folder)
    track.artist = ini.get('artist', '')
    track.album = ini.get('album', '')
    track.genre = ini.get('genre', '')
    track.year = ini.get('year', '')
    track.stems = dict(stem_oggs)

    track.stems_dir.mkdir(parents=True, exist_ok=True)
    for filename in stem_oggs.values():
        _link_or_copy(src / filename, track.stems_dir / filename)
    for aux in _STEM_DIR_AUX_FILES:
        if (src / aux).exists():
            _link_or_copy(src / aux, track.stems_dir / aux)

    # Drop stale imported beatmaps before rebuilding from the fresh folder.
    for bm in track.beatmaps:
        if bm.get('model') == 'imported':
            shutil.rmtree(track.beatmaps_dir / bm['id'], ignore_errors=True)
    track.beatmaps = [b for b in track.beatmaps if b.get('model') != 'imported']
    used_ids = {b['id'] for b in track.beatmaps}

    chart_path = _find_published_chart(src)
    chart_text = chart_path.read_text(encoding='utf-8', errors='replace') if chart_path else ''
    pieces = split_merged_chart(chart_text, set(stem_oggs)) if chart_text else []

    def _setup_beatmap_dir(bm_id: str, stem: str) -> Path:
        bm_dir = track.beatmaps_dir / bm_id
        bm_dir.mkdir(parents=True, exist_ok=True)
        # The stem's own audio doubles as the beatmap's song.ogg, matching
        # the fresh-generation flow (the editor's scrubber/waveform read it).
        stem_file = stem_oggs.get(stem) or stem_oggs.get('song')
        if stem_file:
            _link_or_copy(src / stem_file, bm_dir / 'song.ogg')
        if ini_path.exists():
            _link_or_copy(ini_path, bm_dir / 'song.ini')
        # vo/ and realnotes/ — link the whole subdir so any new clips/packs
        # added later show up automatically without re-running this function.
        for subdir in ('vo', 'realnotes'):
            sub = src / subdir
            if sub.is_dir():
                _link_or_copy_dir(sub, bm_dir / subdir)
        return bm_dir

    primary_beatmap_id = ''
    if pieces:
        for piece in pieces:
            bm_id = piece['beatmap_id'] or _stable_beatmap_id(folder, piece['suffix'], piece['n'])
            if bm_id in used_ids:
                bm_id = uuid.uuid4().hex[:12]
            used_ids.add(bm_id)
            bm_dir = _setup_beatmap_dir(bm_id, piece['stem'])
            chart_dst = bm_dir / 'notes.chart'
            if chart_dst.is_symlink():  # legacy write-through shim — replace
                chart_dst.unlink()
            chart_dst.write_text(piece['chart_text'], encoding='utf-8')
            track.beatmaps.append({
                'id': bm_id,
                'stem': piece['stem'],
                'generated_at': time.time(),
                'folder_name': folder,
                'song_name': ini.get('name', folder),
                'active': piece['is_active'],
                'model': 'imported',
                'model_version': None,
                'preset': piece['preset'] or None,
            })
            if not primary_beatmap_id:
                primary_beatmap_id = bm_id
    elif chart_path is not None:
        # No recognizable difficulty sections — fall back to the legacy
        # single-beatmap shim with a write-through chart symlink.
        bm_id = _stable_beatmap_id(folder, 'whole-chart', 1)
        bm_dir = _setup_beatmap_dir(bm_id, 'song')
        _link_or_copy(chart_path, bm_dir / 'notes.chart')
        track.beatmaps.append({
            'id': bm_id,
            'stem': 'song',
            'generated_at': time.time(),
            'folder_name': folder,
            'song_name': ini.get('name', folder),
            'active': True,
            'model': 'imported',
            'model_version': None,
        })
        primary_beatmap_id = bm_id

    if not primary_beatmap_id and track.beatmaps:
        primary_beatmap_id = track.beatmaps[0]['id']
    track.save()
    return track.id, primary_beatmap_id


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


def sync_studio_edits_to_game_folder(folder: str) -> bool:
    """Splice the shim track's per-stem chart edits back into the pulled
    folder's published chart, the inverse of the split done at pull time.

    Legacy single-beatmap shims write through a notes.chart symlink and are
    skipped (their bm chart IS the folder chart). Studio-generated beatmaps
    on the shim track are included as alternates, same as the normal track
    publish flow. Returns True when the folder chart was rewritten.
    """
    local = _local_path(folder)
    track = _find_track_by_source_game_song(folder)
    if track is None or not track.beatmaps:
        return False
    # Same ordering rules as the Studio publish flow (primary first per
    # stem, then alternates). Imported from the router lazily — the router
    # imports this module's sibling services at module load.
    from ..routers.tracks import order_beatmaps_for_publish

    contributions: list[tuple[str, str, dict]] = []
    for bm, is_primary in order_beatmaps_for_publish(list(track.beatmaps), {}):
        chart_path = track.beatmaps_dir / bm.get('id', '') / 'notes.chart'
        if not chart_path.exists() or chart_path.is_symlink():
            continue
        text = chart_path.read_text(encoding='utf-8', errors='replace')
        # Legacy shims (pre-split, symlink fell back to a file copy) hold the
        # whole merged chart — splicing one as a per-stem chart would drop
        # every other stem's sections. Per-stem charts only ever carry
        # unnumbered [*Single] sections.
        if any(m.group(2) != 'Single' or m.group(3) for m in _DIFF_SECTION_RE.finditer(text)):
            continue
        contributions.append((
            text,
            bm.get('stem', ''),
            {
                'preset': bm.get('preset', '') or '',
                'beatmap_id': bm.get('id', ''),
                'is_active': is_primary,
            },
        ))
    if not contributions:
        return False

    target = _find_published_chart(local) or (local / 'notes_fixed_slides.chart')
    merged_text = target.read_text(encoding='utf-8', errors='replace') if target.exists() else ''
    target.write_text(splice_stem_charts_into_merged(merged_text, contributions), encoding='utf-8')
    return True


async def push_game_song(folder: str) -> str:
    """Push the local folder back to GitHub SongInbox/{folder}/."""
    _ensure_token()
    local = _local_path(folder)
    if not local.exists():
        raise FileNotFoundError(f'{folder} not pulled locally')
    sync_studio_edits_to_game_folder(folder)
    return await publish_song_folder(local, folder)
