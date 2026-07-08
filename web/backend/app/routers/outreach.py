"""Outreach tracker — Reddit channel.

A team-shared reference table of VR / music-game / rhythm-game subreddits: how
big each is, whether self-promotion is allowed there, its Discord invite, plus
editable tracking of where we've actually posted.

Reference data is a baked seed (`services.outreach_reddit_seed`) captured on a
snapshot date. Per-subreddit tracking (status / last-posted / notes) and any
team-added custom subreddits persist to `<upload_dir>/outreach_reddit.json`
(same file-backed pattern as generation_presets / sequences).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel, Field

from ..config import settings
from ..services.outreach_reddit_seed import SEED_ROWS, SUBSCRIBERS_AS_OF

router = APIRouter(prefix='/api/outreach', tags=['outreach'])


VALID_STATUS = {'Not posted', 'Posted', 'Approved', 'Removed', 'Banned', 'Awaiting mod'}
VALID_VERDICT = {'Allowed', 'Limited', 'ModApproval', 'Banned', 'Unknown'}


class TrackingPatch(BaseModel):
    status: str | None = None
    last_posted: str | None = None
    notes: str | None = None
    # Team-editable override for the Discord invite. Falls back to the seed
    # link when never set; an explicit empty string clears it to none.
    discord: str | None = None


class CustomSubreddit(BaseModel):
    name: str = Field(max_length=120)
    url: str | None = None
    category: str = Field(default='Other', max_length=40)
    subscribers: int = Field(default=0, ge=0)
    subscribers_approx: bool = True
    self_promo_verdict: str = 'Unknown'
    self_promo_detail: str = ''
    discord: str | None = None


def _store_path() -> Path:
    return Path(settings.upload_dir) / 'outreach_reddit.json'


def _empty_store() -> dict[str, Any]:
    return {'tracking': {}, 'custom': []}


def _load_store() -> dict[str, Any]:
    """Return `{tracking: {name: {...}}, custom: [row, ...]}`.

    Tolerant of a missing/corrupt file — falls back to an empty store so the
    reference table always renders.
    """
    p = _store_path()
    if not p.exists():
        return _empty_store()
    try:
        data = json.loads(p.read_text(encoding='utf-8'))
    except json.JSONDecodeError:
        return _empty_store()
    if not isinstance(data, dict):
        return _empty_store()
    tracking = data.get('tracking')
    custom = data.get('custom')
    return {
        'tracking': tracking if isinstance(tracking, dict) else {},
        'custom': [c for c in custom if isinstance(c, dict) and c.get('name')] if isinstance(custom, list) else [],
    }


def _save_store(store: dict[str, Any]) -> None:
    p = _store_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(store, indent=2), encoding='utf-8')
    tmp.replace(p)


def _now_date() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _default_tracking() -> dict[str, Any]:
    return {'status': 'Not posted', 'last_posted': None, 'notes': ''}


def _normalize_discord(value: str | None) -> str | None:
    """Empty → None; bare `discord.gg/…` / codes get an https:// scheme."""
    if not value or not value.strip():
        return None
    v = value.strip()
    if not v.startswith(('http://', 'https://')):
        v = 'https://' + v.lstrip('/')
    return v


def _merge_rows(store: dict[str, Any]) -> list[dict[str, Any]]:
    """Seed rows + custom rows, each with its tracking overlay applied."""
    tracking: dict[str, Any] = store['tracking']
    rows: list[dict[str, Any]] = []
    for base in list(SEED_ROWS) + [{**c, 'custom': True} for c in store['custom']]:
        row = dict(base)
        row.setdefault('custom', False)
        row.setdefault('subscribers_as_of', SUBSCRIBERS_AS_OF)
        t = tracking.get(row['name']) or {}
        merged = _default_tracking()
        merged.update({k: v for k, v in t.items() if k in merged})
        row.update(merged)
        # Discord isn't a default-tracking field (it seeds from the row), so
        # apply the override only when the team has explicitly set one.
        if 'discord' in t:
            row['discord'] = t['discord'] or None
        rows.append(row)
    return rows


@router.get('/reddit')
async def list_reddit() -> dict[str, Any]:
    store = _load_store()
    return {'as_of': SUBSCRIBERS_AS_OF, 'rows': _merge_rows(store)}


@router.patch('/reddit/{name:path}')
async def update_tracking(name: str, patch: TrackingPatch) -> dict[str, Any]:
    """Update the team-editable tracking fields for one subreddit (seed or custom)."""
    name = unquote(name)
    store = _load_store()
    known = {r['name'] for r in _merge_rows(store)}
    if name not in known:
        raise HTTPException(404, f'No subreddit `{name}`')

    if patch.status is not None and patch.status not in VALID_STATUS:
        raise HTTPException(400, f'status must be one of {sorted(VALID_STATUS)}')

    entry = store['tracking'].get(name) or _default_tracking()
    if patch.status is not None:
        entry['status'] = patch.status
    if patch.last_posted is not None:
        entry['last_posted'] = patch.last_posted or None
    if patch.notes is not None:
        entry['notes'] = patch.notes
    # Use fields_set so an explicit `discord: ""` (clear) is distinguishable
    # from the field being omitted entirely.
    if 'discord' in patch.model_fields_set:
        entry['discord'] = _normalize_discord(patch.discord)
    store['tracking'][name] = entry
    _save_store(store)
    return {'name': name, **entry}


@router.post('/reddit')
async def add_custom(body: CustomSubreddit = Body(...)) -> dict[str, Any]:
    name = body.name.strip()
    if not name:
        raise HTTPException(400, '`name` is required')
    if not name.lower().startswith('r/'):
        name = f'r/{name.lstrip("/")}'
    if body.self_promo_verdict not in VALID_VERDICT:
        raise HTTPException(400, f'self_promo_verdict must be one of {sorted(VALID_VERDICT)}')

    store = _load_store()
    if any(r['name'].lower() == name.lower() for r in _merge_rows(store)):
        raise HTTPException(409, f'`{name}` already exists')

    record = body.model_dump()
    record['name'] = name
    record['url'] = record.get('url') or f'https://www.reddit.com/{name}/'
    record['subscribers_as_of'] = _now_date()
    store['custom'].append(record)
    _save_store(store)
    return {**record, 'custom': True, **_default_tracking()}


@router.delete('/reddit/{name:path}')
async def delete_custom(name: str) -> dict[str, str]:
    """Delete a custom subreddit. Seed rows can't be deleted — only their
    tracking reset (send an empty PATCH)."""
    name = unquote(name)
    if any(r['name'] == name for r in SEED_ROWS):
        raise HTTPException(409, f'`{name}` is a built-in subreddit and cannot be deleted')
    store = _load_store()
    before = len(store['custom'])
    store['custom'] = [c for c in store['custom'] if c.get('name') != name]
    if len(store['custom']) == before:
        raise HTTPException(404, f'No custom subreddit `{name}`')
    store['tracking'].pop(name, None)
    _save_store(store)
    return {'name': name, 'deleted': 'true'}
