"""Custom scene event type registry.

The editor ships a builtin catalog of `onboard_*` scene events. This router
lets users register additional event types at runtime so the Unity engineer
can implement them on the game side. Types are stored globally in a single
JSON file under the configured upload dir; any beatmap can reference any
registered type.

A new type's POST response includes a markdown "handover doc" that
documents the payload format and proposes a Unity subscription hook —
handy to paste into a Jira ticket or DM.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from ..config import settings

router = APIRouter(prefix='/api/scene-events', tags=['scene-events'])

_NAME_RE = re.compile(r'^[a-z][a-z0-9_]{2,63}$')
_RESERVED_NAMES: set[str] = set()  # filled below


# ── Storage ─────────────────────────────────────────────────────────────────


def _store_path() -> Path:
    return Path(settings.upload_dir) / 'scene_event_types.json'


def _load() -> dict:
    p = _store_path()
    if not p.exists():
        return {'types': []}
    try:
        return json.loads(p.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return {'types': []}


def _save(data: dict) -> None:
    p = _store_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2), encoding='utf-8')


# ── Schema ──────────────────────────────────────────────────────────────────


class ParamNone(BaseModel):
    type: Literal['none'] = 'none'


class ParamDuration(BaseModel):
    type: Literal['duration'] = 'duration'


class ParamHexColor(BaseModel):
    type: Literal['hex_color'] = 'hex_color'


class ParamNumber(BaseModel):
    type: Literal['number'] = 'number'
    min: Optional[float] = None
    max: Optional[float] = None
    step: Optional[float] = None


class ParamEnum(BaseModel):
    type: Literal['enum'] = 'enum'
    options: list[str] = Field(default_factory=list)

    @field_validator('options')
    @classmethod
    def _non_empty(cls, v: list[str]) -> list[str]:
        opts = [o.strip() for o in v if o and o.strip()]
        if not opts:
            raise ValueError('enum requires at least one option')
        return opts


SceneEventParam = ParamNone | ParamDuration | ParamHexColor | ParamNumber | ParamEnum


class SceneEventType(BaseModel):
    name: str
    item_label: str
    group_label: str = 'Custom'
    description: str = ''
    param: SceneEventParam

    @field_validator('name')
    @classmethod
    def _valid_name(cls, v: str) -> str:
        v = v.strip()
        if not _NAME_RE.match(v):
            raise ValueError(
                'name must be lowercase letters/digits/underscores, '
                '3-64 chars, starting with a letter',
            )
        return v


# ── Routes ──────────────────────────────────────────────────────────────────


@router.get('/types')
async def list_types() -> list[dict]:
    return _load().get('types', [])


@router.post('/types')
async def create_type(t: SceneEventType) -> dict:
    if t.name in _RESERVED_NAMES:
        raise HTTPException(409, f'Name "{t.name}" is reserved for a builtin event')
    data = _load()
    types = data.setdefault('types', [])
    if any(existing.get('name') == t.name for existing in types):
        raise HTTPException(409, f'A scene event type named "{t.name}" already exists')
    entry = t.model_dump()
    types.append(entry)
    _save(data)
    return {'type': entry, 'handover_md': _handover_doc(t)}


@router.delete('/types/{name}')
async def delete_type(name: str) -> dict:
    data = _load()
    types = data.get('types', [])
    next_types = [t for t in types if t.get('name') != name]
    if len(next_types) == len(types):
        raise HTTPException(404, 'Not found')
    data['types'] = next_types
    _save(data)
    return {'ok': True}


@router.get('/types/{name}/handover')
async def get_handover(name: str) -> dict:
    data = _load()
    for raw in data.get('types', []):
        if raw.get('name') == name:
            return {'handover_md': _handover_doc(SceneEventType(**raw))}
    raise HTTPException(404, 'Not found')


# ── Handover doc ────────────────────────────────────────────────────────────


def _handover_doc(t: SceneEventType) -> str:
    _, value_example, csharp_parse = _examples(t.param)
    name = t.name
    desc = t.description.strip() or '_no description provided_'
    param_block = _param_block(t.param)
    payload = f'{name} {value_example}'.rstrip()
    return (
        f'# Scene event: `{name}`\n\n'
        f'**Display name:** {t.item_label}\n'
        f'**Group:** {t.group_label}\n\n'
        f'## What it does\n{desc}\n\n'
        f'## Chart payload\n'
        f'```\n'
        f'<tick> = E "{payload}"\n'
        f'```\n\n'
        f'## Parameter\n{param_block}\n\n'
        f'## Unity hook (suggested)\n'
        f'```csharp\n'
        f'// Register once during scene init:\n'
        f'SceneEventBus.OnEvent("{name}", (tick, rawValue, durationTicks) => {{\n'
        f'{csharp_parse}'
        f'    // TODO: drive your visual / audio here using the parsed value.\n'
        f'}});\n'
        f'```\n\n'
        f'## Notes for the engineer\n'
        f'- The chart payload column is whatever the value editor wrote — strip and parse on receipt.\n'
        f'- Multiple events of the same `name` may overlap; pick the latest active one or layer them as appropriate.\n'
        f'- If you need an off-state, register a counterpart event (e.g. `{name}_off`) and emit it at the end tick.\n'
        f'\n_Generated from the editor — keep the payload/value format in sync with whatever the engineer ships._\n'
    )


def _param_block(p: SceneEventParam) -> str:
    if isinstance(p, ParamNone):
        return '_No parameter — fires as a bare cue._'
    if isinstance(p, ParamDuration):
        return (
            'Duration in **chart ticks**. Resize the event in the editor to set it.\n'
            'The token after the name is an integer (no units).'
        )
    if isinstance(p, ParamHexColor):
        return (
            'A hex colour in `#RRGGBB` form (lower or upper case).\n'
            'Parse on the Unity side with `ColorUtility.TryParseHtmlString`.'
        )
    if isinstance(p, ParamNumber):
        rng = []
        if p.min is not None:
            rng.append(f'min `{p.min}`')
        if p.max is not None:
            rng.append(f'max `{p.max}`')
        if p.step is not None:
            rng.append(f'step `{p.step}`')
        rng_str = ' · '.join(rng) if rng else 'unbounded'
        return f'A number ({rng_str}). Token is the value as written (decimal or integer).'
    if isinstance(p, ParamEnum):
        return 'One of: ' + ', '.join(f'`{o}`' for o in p.options)
    return ''


def _examples(p: SceneEventParam) -> tuple[str, str, str]:
    """Return (full_payload, value_only, csharp_parse_snippet)."""
    if isinstance(p, ParamNone):
        return ('event_name', '', '    // no value — bare cue\n')
    if isinstance(p, ParamDuration):
        return ('event_name 384', '384', '    // durationTicks already parsed for you\n')
    if isinstance(p, ParamHexColor):
        return (
            'event_name #FF8800',
            '#FF8800',
            '    if (ColorUtility.TryParseHtmlString(rawValue, out var color)) {\n'
            '        // use color\n'
            '    }\n',
        )
    if isinstance(p, ParamNumber):
        sample = '0.75'
        if p.max is not None and p.min is not None:
            sample = f'{(p.min + p.max) / 2:g}'
        return (
            f'event_name {sample}',
            sample,
            f'    if (float.TryParse(rawValue, out var value)) {{\n'
            f'        // use value (expected range: '
            f'{p.min if p.min is not None else "-∞"}..{p.max if p.max is not None else "+∞"})\n'
            f'    }}\n',
        )
    if isinstance(p, ParamEnum):
        sample = p.options[0] if p.options else 'option'
        cases = '\n'.join(f'        case "{o}":\n            // handle {o}\n            break;' for o in p.options[:4])
        return (
            f'event_name {sample}',
            sample,
            '    switch (rawValue) {\n' + cases + '\n    }\n',
        )
    return ('event_name', '', '')
