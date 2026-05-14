"""Publish a song folder to GitHub via the Git Data API (atomic commit)."""

import asyncio
import base64
from pathlib import Path

import httpx

from ..config import settings


# Cap on simultaneous /git/blobs POSTs. GitHub's authenticated rate limit is
# 5000/hour and the abuse-detection limit kicks in around 10 concurrent
# requests against the same endpoint; 8 leaves headroom while still cutting
# wall time on multi-file pushes (e.g. the realnotes/ subtree with 32 packs
# × 10 oggs) by ~8x.
_BLOB_CONCURRENCY = 8

API = 'https://api.github.com'


def _headers():
    return {
        'Authorization': f'Bearer {settings.github_token}',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    }


def _api(path: str) -> str:
    return f'{API}/repos/{settings.github_owner}/{settings.github_repo}{path}'


async def publish_song_folder(folder_path: Path, folder_name: str) -> str:
    """
    Push all files in folder_path to SongInbox/{folder_name}/ via Git Data API.

    Returns the commit URL.
    """
    async with httpx.AsyncClient(timeout=60) as client:
        # 1. Get current commit SHA of the branch
        ref_resp = await client.get(
            _api(f'/git/ref/heads/{settings.github_branch}'),
            headers=_headers(),
        )
        ref_resp.raise_for_status()
        base_commit_sha = ref_resp.json()['object']['sha']

        # Get the tree SHA of that commit
        commit_resp = await client.get(
            _api(f'/git/commits/{base_commit_sha}'),
            headers=_headers(),
        )
        commit_resp.raise_for_status()
        base_tree_sha = commit_resp.json()['tree']['sha']

        # 2. Create blobs for each file in parallel. rglob walks subdirectories
        # so tutorial bundles (vo/*.ogg) and realnotes packs ride along with
        # the top-level chart + song.ini + song.ogg. Files whose name starts
        # with `_` are treated as scratch artefacts and skipped at any depth.
        files: list[Path] = []
        for fp in sorted(folder_path.rglob('*')):
            if not fp.is_file():
                continue
            rel = fp.relative_to(folder_path)
            if any(part.startswith('_') for part in rel.parts):
                continue
            files.append(fp)

        sem = asyncio.Semaphore(_BLOB_CONCURRENCY)

        async def upload_blob(fp: Path) -> dict:
            rel = fp.relative_to(folder_path)
            content_bytes = fp.read_bytes()
            async with sem:
                blob_resp = await client.post(
                    _api('/git/blobs'),
                    headers=_headers(),
                    json={
                        'content': base64.b64encode(content_bytes).decode(),
                        'encoding': 'base64',
                    },
                )
            blob_resp.raise_for_status()
            # Preserve subdir structure under SongInbox/<folder>/. POSIX
            # path is mandatory — Git's API rejects backslashes on Windows.
            return {
                'path': f'{settings.github_inbox_prefix}/{folder_name}/{rel.as_posix()}',
                'mode': '100644',
                'type': 'blob',
                'sha': blob_resp.json()['sha'],
            }

        tree_entries = await asyncio.gather(*[upload_blob(fp) for fp in files])

        # 3. Create tree
        tree_resp = await client.post(
            _api('/git/trees'),
            headers=_headers(),
            json={
                'base_tree': base_tree_sha,
                'tree': tree_entries,
            },
        )
        tree_resp.raise_for_status()
        new_tree_sha = tree_resp.json()['sha']

        # 4. Create commit
        commit_resp = await client.post(
            _api('/git/commits'),
            headers=_headers(),
            json={
                'message': f'Add {folder_name} via beatmap.jamsesh.co',
                'tree': new_tree_sha,
                'parents': [base_commit_sha],
            },
        )
        commit_resp.raise_for_status()
        new_commit_sha = commit_resp.json()['sha']
        commit_url = commit_resp.json()['html_url']

        # 5. Update ref
        ref_update = await client.patch(
            _api(f'/git/refs/heads/{settings.github_branch}'),
            headers=_headers(),
            json={'sha': new_commit_sha},
        )
        ref_update.raise_for_status()

        return commit_url
