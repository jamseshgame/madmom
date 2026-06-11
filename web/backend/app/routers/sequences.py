"""Cross-track gem-sequence library.

A sequence is a named, tick-normalized run of notes saved from the beatmap
editor's selection. Sequences are shared by all users and persist to
`<upload_dir>/sequences.json` (same file-backed pattern as
generation_presets). Ticks are stored at the source chart's resolution; the
client rescales on paste, so a sequence works in any track regardless of
BPM or tick resolution.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..config import settings


router = APIRouter(prefix='/api/sequences', tags=['sequences'])


class SequenceNote(BaseModel):
    tick: int = Field(ge=0)
    lane: int = Field(ge=0, le=7)
    sustain: int = Field(default=0, ge=0)
    slideId: int | None = None
    type: str | None = None
    pack: str | None = None
    scale: str | None = None


class SequenceCreate(BaseModel):
    name: str
    resolution: int = Field(gt=0)
    notes: list[SequenceNote] = Field(min_length=1)


class SequenceRename(BaseModel):
    name: str


def _sequences_path() -> Path:
    return Path(settings.upload_dir) / 'sequences.json'


def _load() -> list[dict[str, Any]]:
    p = _sequences_path()
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding='utf-8'))
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    return [x for x in data if isinstance(x, dict) and 'id' in x and 'name' in x and 'notes' in x]


def _save(seqs: list[dict[str, Any]]) -> None:
    p = _sequences_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(seqs, indent=2), encoding='utf-8')
    tmp.replace(p)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@router.get('')
async def list_sequences() -> list[dict[str, Any]]:
    return _load()


@router.post('')
async def create_sequence(body: SequenceCreate) -> dict[str, Any]:
    name = body.name.strip()
    if not name:
        raise HTTPException(400, '`name` is required')
    # Normalize so the earliest note sits at tick 0 regardless of what the
    # client sent — paste math assumes a zero-based sequence. None-valued
    # optional fields are dropped to keep the stored JSON compact.
    min_tick = min(n.tick for n in body.notes)
    notes = [
        {k: v for k, v in {**n.model_dump(), 'tick': n.tick - min_tick}.items() if v is not None}
        for n in sorted(body.notes, key=lambda n: (n.tick, n.lane))
    ]
    record: dict[str, Any] = {
        'id': uuid.uuid4().hex[:12],
        'name': name,
        'created_at': _now(),
        'updated_at': _now(),
        'resolution': body.resolution,
        'notes': notes,
    }
    seqs = _load()
    seqs.append(record)
    _save(seqs)
    return record


@router.patch('/{seq_id}')
async def rename_sequence(seq_id: str, body: SequenceRename) -> dict[str, Any]:
    name = body.name.strip()
    if not name:
        raise HTTPException(400, '`name` is required')
    seqs = _load()
    for s in seqs:
        if s['id'] == seq_id:
            s['name'] = name
            s['updated_at'] = _now()
            _save(seqs)
            return s
    raise HTTPException(404, f'No sequence `{seq_id}`')


@router.post('/{seq_id}/clone')
async def clone_sequence(seq_id: str) -> dict[str, Any]:
    seqs = _load()
    for s in seqs:
        if s['id'] == seq_id:
            copy = json.loads(json.dumps(s))
            copy['id'] = uuid.uuid4().hex[:12]
            copy['name'] = f"{s['name']} (copy)"
            copy['created_at'] = _now()
            copy['updated_at'] = _now()
            seqs.append(copy)
            _save(seqs)
            return copy
    raise HTTPException(404, f'No sequence `{seq_id}`')


@router.delete('/{seq_id}')
async def delete_sequence(seq_id: str) -> dict[str, str]:
    seqs = _load()
    kept = [s for s in seqs if s['id'] != seq_id]
    if len(kept) == len(seqs):
        raise HTTPException(404, f'No sequence `{seq_id}`')
    _save(kept)
    return {'id': seq_id, 'deleted': 'true'}
