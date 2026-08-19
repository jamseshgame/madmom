"""Admin-only PostHog analytics proxy.

Keeps the personal API key off the client and converts HogQL results into a
small, stable response tailored to the Studio dashboard.
"""

import asyncio
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from ..config import settings
from .auth import require_admin

router = APIRouter(prefix='/api/analytics', tags=['analytics'])


def _literal(value: str) -> str:
    """Return a safely quoted HogQL string literal."""
    return "'" + value.replace('\\', '\\\\').replace("'", "\\'") + "'"


async def _hogql(client: httpx.AsyncClient, query: str) -> list[dict[str, Any]]:
    response = await client.post(
        f'{settings.posthog_host.rstrip("/")}/api/projects/{settings.posthog_project_id}/query/',
        headers={'Authorization': f'Bearer {settings.posthog_personal_api_key}'},
        json={'query': {'kind': 'HogQLQuery', 'query': query}},
    )
    response.raise_for_status()
    payload = response.json()
    columns = payload.get('columns', [])
    return [dict(zip(columns, row)) for row in payload.get('results', [])]


@router.get('')
async def dashboard(
    days: int = Query(30, ge=1, le=365),
    event: str | None = Query(None, max_length=200),
    search: str | None = Query(None, max_length=200),
    limit: int = Query(50, ge=10, le=200),
    offset: int = Query(0, ge=0, le=10000),
    _admin: dict = Depends(require_admin),
):
    if not settings.posthog_personal_api_key:
        raise HTTPException(503, 'PostHog is not configured. Set POSTHOG_PERSONAL_API_KEY.')

    filters = [f'timestamp >= now() - INTERVAL {days} DAY']
    if event:
        filters.append(f'event = {_literal(event)}')
    if search:
        needle = _literal(f'%{search}%')
        filters.append(f'(event ILIKE {needle} OR distinct_id ILIKE {needle} OR toString(properties) ILIKE {needle})')
    where = ' AND '.join(filters)

    queries = [
        f"""SELECT count() AS events, uniq(distinct_id) AS users,
                   uniq(event) AS event_types, max(timestamp) AS latest
            FROM events WHERE {where}""",
        f"""SELECT toDate(timestamp) AS day, count() AS events, uniq(distinct_id) AS users
            FROM events WHERE {where} GROUP BY day ORDER BY day""",
        f"""SELECT event, count() AS count, uniq(distinct_id) AS users
            FROM events WHERE {where} GROUP BY event ORDER BY count DESC LIMIT 30""",
        f"""SELECT uuid, timestamp, event, distinct_id, properties
            FROM events WHERE {where} ORDER BY timestamp DESC LIMIT {limit + 1} OFFSET {offset}""",
    ]
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            summary_rows, trend, breakdown, activity = await asyncio.gather(*(_hogql(client, q) for q in queries))
    except httpx.HTTPStatusError as exc:
        detail = 'PostHog rejected the analytics request.'
        if exc.response.status_code in (401, 403):
            detail = 'PostHog credentials do not have access to this project.'
        raise HTTPException(502, detail) from exc
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(502, 'PostHog is currently unavailable.') from exc

    has_more = len(activity) > limit
    return {
        'summary': summary_rows[0] if summary_rows else {'events': 0, 'users': 0, 'event_types': 0, 'latest': None},
        'trend': trend,
        'breakdown': breakdown,
        'activity': activity[:limit],
        'pagination': {'limit': limit, 'offset': offset, 'has_more': has_more},
        'range_days': days,
    }
