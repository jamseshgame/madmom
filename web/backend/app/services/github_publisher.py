"""Publish a song folder to GitHub via the Git Data API (atomic commit)."""

import base64
from pathlib import Path

import httpx

from ..config import settings

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

        # 2. Create blobs for each file
        tree_entries = []
        for file_path in sorted(folder_path.iterdir()):
            if file_path.is_file() and not file_path.name.startswith('_'):
                content_bytes = file_path.read_bytes()
                blob_resp = await client.post(
                    _api('/git/blobs'),
                    headers=_headers(),
                    json={
                        'content': base64.b64encode(content_bytes).decode(),
                        'encoding': 'base64',
                    },
                )
                blob_resp.raise_for_status()
                blob_sha = blob_resp.json()['sha']

                rel_path = f'{settings.github_inbox_prefix}/{folder_name}/{file_path.name}'
                tree_entries.append({
                    'path': rel_path,
                    'mode': '100644',
                    'type': 'blob',
                    'sha': blob_sha,
                })

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
