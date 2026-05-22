"""Per-chart feedback storage.

Each beatmap has a `feedback.jsonl` file inside its folder containing one
JSON object per line. Notes are append-only on write; edits and deletes
rewrite the file under a per-beatmap lock so concurrent CRUD doesn't
interleave partial lines.

The Claude-driven preset proposer reads aggregated feedback across all
beatmaps for a stem; see `aggregate_for_stem`.
"""
from __future__ import annotations

import datetime
import json
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from . import tracks as tracks_service


# ── Tag vocabulary ──────────────────────────────────────────────────────────
# Adding a new tag requires editing this constant and deploying. The frontend
# reads the categorised structure via GET /api/feedback/tags.
FEEDBACK_TAGS: dict[str, list[str]] = {
    'Density':       ['too-sparse', 'too-dense'],
    'Lane spread':   ['too-crampy', 'over-spread'],
    'Pitch mapping': ['wrong-pitch-mapping', 'tonic-anchored'],
    'Chords':        ['too-many-chords', 'not-enough-chords', 'weird-chord-shapes'],
    'Open notes':    ['too-many-opens', 'not-enough-opens'],
    'Rhythm':        ['off-beat', 'missed-section-changes'],
    'Overall':       ['feels-great', 'feels-random', 'unplayable'],
}

ALL_TAGS: set[str] = {t for ts in FEEDBACK_TAGS.values() for t in ts}


# ── Concurrency ─────────────────────────────────────────────────────────────
_locks: dict[tuple[str, str], threading.Lock] = {}
_locks_lock = threading.Lock()


def _lock_for(track_id: str, beatmap_id: str) -> threading.Lock:
    key = (track_id, beatmap_id)
    with _locks_lock:
        lk = _locks.get(key)
        if lk is None:
            lk = _locks[key] = threading.Lock()
        return lk


# ── ID + timestamp helpers ──────────────────────────────────────────────────
def _new_note_id() -> str:
    """Lexicographically time-sortable ID without external deps.

    `fb_<ms-hex>_<rand>`. The hex-ms prefix gives natural ordering when scanning
    JSONL by created_at.
    """
    return f'fb_{int(time.time() * 1000):x}_{secrets.token_hex(4)}'


def _now_iso() -> str:
    return datetime.datetime.now(tz=datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


# ── Validation ──────────────────────────────────────────────────────────────
class FeedbackError(ValueError):
    pass


def _validate_payload(rating: Any, tags: Any, text: Any) -> tuple[int, list[str], str]:
    # `bool` is a subclass of `int` in Python, so guard against it explicitly:
    # `rating=True` would otherwise pass and persist as JSON `true`.
    if isinstance(rating, bool) or not isinstance(rating, int) or rating < 1 or rating > 5:
        raise FeedbackError('rating must be an integer between 1 and 5')
    if tags is None:
        tags = []
    if not isinstance(tags, list) or any(not isinstance(t, str) for t in tags):
        raise FeedbackError('tags must be a list of strings')
    unknown = [t for t in tags if t not in ALL_TAGS]
    if unknown:
        raise FeedbackError(f'unknown tag(s): {unknown}')
    if text is None:
        text = ''
    if not isinstance(text, str):
        raise FeedbackError('text must be a string')
    if not tags and not text.strip():
        raise FeedbackError('at least one of tags or text must be non-empty')
    return rating, list(tags), text


# ── Storage paths ───────────────────────────────────────────────────────────
def _feedback_path(track_id: str, beatmap_id: str) -> Path | None:
    bm_dir = tracks_service.get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        return None
    return bm_dir / 'feedback.jsonl'


# ── CRUD ────────────────────────────────────────────────────────────────────
def list_notes(track_id: str, beatmap_id: str) -> list[dict[str, Any]]:
    p = _feedback_path(track_id, beatmap_id)
    if p is None or not p.exists():
        return []
    out: list[dict[str, Any]] = []
    for line in p.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue  # skip malformed lines defensively
    return out


def add_note(
    track_id: str, beatmap_id: str, *, author: str,
    rating: int, tags: list[str], text: str,
) -> dict[str, Any]:
    p = _feedback_path(track_id, beatmap_id)
    if p is None:
        raise FeedbackError('beatmap not found')
    rating, tags, text = _validate_payload(rating, tags, text)
    now = _now_iso()
    note = {
        'id': _new_note_id(),
        'created_at': now,
        'updated_at': now,
        'author': author,
        'rating': rating,
        'tags': tags,
        'text': text,
    }
    with _lock_for(track_id, beatmap_id):
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open('a', encoding='utf-8') as f:
            f.write(json.dumps(note) + '\n')
    return note


# Sentinel: rating/tags/text == None means "leave unchanged". The router is
# responsible for filtering missing-from-payload keys before calling, so an
# explicit `null` in a request body is rejected by validation when the field
# arrives (the router will translate it to a 422 via the payload check).
def update_note(
    track_id: str, beatmap_id: str, note_id: str, *, requester: str,
    rating: Any = None, tags: Any = None, text: Any = None,
) -> dict[str, Any]:
    p = _feedback_path(track_id, beatmap_id)
    if p is None:
        raise FeedbackError('beatmap not found')
    with _lock_for(track_id, beatmap_id):
        if not p.exists():
            raise FeedbackError('note not found')
        raw_lines = p.read_text(encoding='utf-8').splitlines()
        # Find and parse the target; preserve every other line verbatim so a
        # transient parse failure doesn't permanently drop a note on the next edit.
        updated_target: dict[str, Any] | None = None
        out_lines: list[str] = []
        for line in raw_lines:
            stripped = line.strip()
            if not stripped:
                continue
            try:
                obj = json.loads(stripped)
            except json.JSONDecodeError:
                out_lines.append(line)
                continue
            if obj.get('id') != note_id:
                out_lines.append(line)
                continue
            if obj.get('author') != requester:
                raise PermissionError('only the author can edit a note')
            new_rating = obj['rating'] if rating is None else rating
            new_tags = obj['tags'] if tags is None else tags
            new_text = obj['text'] if text is None else text
            new_rating, new_tags, new_text = _validate_payload(new_rating, new_tags, new_text)
            obj.update({
                'rating': new_rating, 'tags': new_tags, 'text': new_text,
                'updated_at': _now_iso(),
            })
            updated_target = obj
            out_lines.append(json.dumps(obj))
        if updated_target is None:
            raise FeedbackError('note not found')
        p.write_text('\n'.join(out_lines) + ('\n' if out_lines else ''), encoding='utf-8')
        return updated_target


def delete_note(
    track_id: str, beatmap_id: str, note_id: str, *, requester: str, is_admin: bool,
) -> None:
    p = _feedback_path(track_id, beatmap_id)
    if p is None:
        raise FeedbackError('beatmap not found')
    with _lock_for(track_id, beatmap_id):
        if not p.exists():
            raise FeedbackError('note not found')
        raw_lines = p.read_text(encoding='utf-8').splitlines()
        found = False
        out_lines: list[str] = []
        for line in raw_lines:
            stripped = line.strip()
            if not stripped:
                continue
            try:
                obj = json.loads(stripped)
            except json.JSONDecodeError:
                # Preserve unparseable lines so a transient parse failure
                # doesn't permanently drop a note on the next edit.
                out_lines.append(line)
                continue
            if obj.get('id') != note_id:
                out_lines.append(line)
                continue
            if not is_admin and obj.get('author') != requester:
                raise PermissionError('only the author or an admin can delete a note')
            found = True
            # drop this line — skip the append
        if not found:
            raise FeedbackError('note not found')
        p.write_text('\n'.join(out_lines) + ('\n' if out_lines else ''), encoding='utf-8')


# ── Aggregation (admin-only consumer) ───────────────────────────────────────
def aggregate_for_stem(stem: str) -> list[dict[str, Any]]:
    """Return per-beatmap groups for every beatmap whose preset applies to `stem`.

    A preset is considered applicable when it has no `stems` field (universal)
    or when its `stems` list includes `stem`. The result is a flat list ready
    to be embedded into the Claude system prompt.
    """
    # Local import to avoid an import cycle on module load.
    from ..routers.generation_presets import BUILTIN_PRESETS, _load_user_presets

    presets = list(BUILTIN_PRESETS) + _load_user_presets()
    by_name = {p['name']: p for p in presets}

    def _preset_applies(name: str) -> bool:
        p = by_name.get(name)
        if p is None:
            return False
        s = p.get('stems') or []
        return not s or stem in s

    # list_tracks() returns enriched DICTS, not Track objects, so reload each
    # by id to get the typed Track (with .beatmaps attribute access).
    out: list[dict[str, Any]] = []
    for td in tracks_service.list_tracks():
        track = tracks_service.get_track(td['id'])
        if track is None:
            continue
        for bm in (track.beatmaps or []):
            preset_name = bm.get('preset', '') or ''
            if not _preset_applies(preset_name):
                continue
            notes = list_notes(track.id, bm.get('id', ''))
            if not notes:
                continue
            out.append({
                'track_id': track.id,
                'track_name': track.name,
                'preset_name': preset_name,
                'beatmap_id': bm.get('id', ''),
                'beatmap_name': bm.get('song_name', preset_name),
                'is_active': bool(bm.get('active')),
                'notes': notes,
            })
    return out
