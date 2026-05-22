"""Saved presets for the V2 generate-beatmap modal.

A preset is a named bundle of `{engine, params}` choices for the five
modal-surfaced stages (onsets, pitches, quantized, lanes_expert,
lanes_filtered). Built-in presets ship with the code and can't be
deleted; user-saved presets live in `<upload_dir>/generation_presets.json`
and can be created, updated, or deleted.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query

from ..config import settings
from .auth import require_admin


router = APIRouter(prefix='/api/generation-presets', tags=['generation-presets'])


_STAGE_KEYS = ('onsets', 'pitches', 'quantized', 'lanes_expert', 'lanes_filtered')


def _presets_path() -> Path:
    return Path(settings.upload_dir) / 'generation_presets.json'


def _load_user_presets() -> list[dict[str, Any]]:
    p = _presets_path()
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding='utf-8'))
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    return [x for x in data if isinstance(x, dict) and 'name' in x and 'generation' in x]


def _save_user_presets(presets: list[dict[str, Any]]) -> None:
    p = _presets_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(presets, indent=2), encoding='utf-8')


# Built-in presets seeded into the modal dropdown out of the box. `v1` is the
# default that opens with the modal; the remaining ten cover lane-mapping,
# pitch-engine, chord-density, and playability variations so the user has a
# quick A/B menu without writing their own.
BUILTIN_PRESETS: list[dict[str, Any]] = [
    {
        'name': 'v1',
        'description': 'Defaults — balanced starting point',
        'builtin': True,
        'generation': {
            'onsets': {'engine': 'librosa-onset', 'params': {}},
            'pitches': {'engine': 'yin', 'params': {}},
            'quantized': {'engine': 'metric-weighted', 'params': {}},
            'lanes_expert': {'engine': 'section-sliding', 'params': {}},
            'lanes_filtered': {'engine': 'identity', 'params': {}},
        },
    },
    {
        'name': 'v2 — tonal (key-relative)',
        'description': 'Tonic-anchored lane mapping; the most repeating phrases stay on the same lane',
        'builtin': True,
        'generation': {
            'onsets': {'engine': 'librosa-onset', 'params': {}},
            'pitches': {'engine': 'yin', 'params': {}},
            'quantized': {'engine': 'metric-weighted', 'params': {}},
            'lanes_expert': {'engine': 'key-relative', 'params': {}},
            'lanes_filtered': {'engine': 'identity', 'params': {}},
        },
    },
    {
        'name': 'v3 — legacy global bins',
        'description': 'Whole-song percentile bins — matches pre-V2 behavior for A/B comparison',
        'builtin': True,
        'generation': {
            'onsets': {'engine': 'librosa-onset', 'params': {}},
            'pitches': {'engine': 'yin', 'params': {}},
            'quantized': {'engine': 'metric-weighted', 'params': {}},
            'lanes_expert': {'engine': 'global-percentile', 'params': {}},
            'lanes_filtered': {'engine': 'identity', 'params': {}},
        },
    },
    {
        'name': 'v4 — chord-heavy',
        'description': 'Lower chord polyphony threshold; more 2-fret chords',
        'builtin': True,
        'generation': {
            'onsets': {'engine': 'librosa-onset', 'params': {}},
            'pitches': {'engine': 'yin', 'params': {}},
            'quantized': {'engine': 'metric-weighted', 'params': {}},
            'lanes_expert': {'engine': 'section-sliding', 'params': {'chord_polyphony_threshold': 2}},
            'lanes_filtered': {'engine': 'identity', 'params': {}},
        },
    },
    {
        'name': 'v5 — open-note heavy',
        'description': 'Aggressive open-note thresholds; wider use of fret 7',
        'builtin': True,
        'generation': {
            'onsets': {'engine': 'librosa-onset', 'params': {}},
            'pitches': {'engine': 'yin', 'params': {}},
            'quantized': {'engine': 'metric-weighted', 'params': {}},
            'lanes_expert': {
                'engine': 'section-sliding',
                'params': {'open_high_percentile': 90, 'open_low_percentile': 10},
            },
            'lanes_filtered': {'engine': 'identity', 'params': {}},
        },
    },
    {
        'name': 'v6 — anti-cramps',
        'description': 'Avoid-cramps filter prevents big hand jumps in tight time windows',
        'builtin': True,
        'generation': {
            'onsets': {'engine': 'librosa-onset', 'params': {}},
            'pitches': {'engine': 'yin', 'params': {}},
            'quantized': {'engine': 'metric-weighted', 'params': {}},
            'lanes_expert': {'engine': 'section-sliding', 'params': {}},
            'lanes_filtered': {'engine': 'avoid-cramps', 'params': {}},
        },
    },
    {
        'name': 'v7 — spread fretboard',
        'description': 'Spread-fretboard filter breaks up runs of the same fret',
        'builtin': True,
        'generation': {
            'onsets': {'engine': 'librosa-onset', 'params': {}},
            'pitches': {'engine': 'yin', 'params': {}},
            'quantized': {'engine': 'metric-weighted', 'params': {}},
            'lanes_expert': {'engine': 'section-sliding', 'params': {}},
            'lanes_filtered': {'engine': 'spread-fretboard', 'params': {}},
        },
    },
    {
        'name': 'v8 — CREPE pitch',
        'description': 'Deep-learning pitch via CREPE tiny (full is too slow on CPU for a song-length run)',
        'builtin': True,
        'generation': {
            'onsets': {'engine': 'librosa-onset', 'params': {}},
            # torchcrepe ships `tiny.pth` + `full.pth`; full is great in
            # accuracy but CPU inference on a 3-min song takes >10 min, so
            # the default preset pins tiny — which is still real CREPE and
            # finishes in a comparable time to YIN. Users can switch to
            # full in the Custom view if they want the heavyweight model.
            'pitches': {'engine': 'crepe', 'params': {'model_size': 'tiny'}},
            'quantized': {'engine': 'metric-weighted', 'params': {}},
            'lanes_expert': {'engine': 'section-sliding', 'params': {}},
            'lanes_filtered': {'engine': 'identity', 'params': {}},
        },
    },
    {
        'name': 'v9 — sparse strong-beat',
        'description': 'Strong-beat quantization plus higher chord threshold; emphasises downbeats',
        'builtin': True,
        'generation': {
            'onsets': {'engine': 'librosa-onset', 'params': {}},
            'pitches': {'engine': 'yin', 'params': {}},
            'quantized': {'engine': 'strong-beat-priority', 'params': {}},
            'lanes_expert': {'engine': 'section-sliding', 'params': {'chord_polyphony_threshold': 4}},
            'lanes_filtered': {'engine': 'identity', 'params': {}},
        },
    },
    {
        'name': 'v10 — polyphonic (basic-pitch)',
        'description': 'Polyphonic onset+pitch detection via basic-pitch; catches simultaneous notes',
        'builtin': True,
        'generation': {
            'onsets': {'engine': 'basic-pitch', 'params': {}},
            'pitches': {'engine': 'basic-pitch', 'params': {}},
            'quantized': {'engine': 'metric-weighted', 'params': {}},
            'lanes_expert': {'engine': 'section-sliding', 'params': {}},
            'lanes_filtered': {'engine': 'identity', 'params': {}},
        },
    },
    {
        'name': 'v11 — chain playability',
        'description': 'Chain filter applies spread-fretboard then avoid-cramps in sequence',
        'builtin': True,
        'generation': {
            'onsets': {'engine': 'librosa-onset', 'params': {}},
            'pitches': {'engine': 'yin', 'params': {}},
            'quantized': {'engine': 'metric-weighted', 'params': {}},
            'lanes_expert': {'engine': 'section-sliding', 'params': {}},
            'lanes_filtered': {'engine': 'chain', 'params': {}},
        },
    },
    {
        'name': 'drums-v1',
        'description': 'Drum-friendly defaults — spectral centroid pitch + raised chord threshold',
        'builtin': True,
        # The `stems` field restricts which stem rows show this preset.
        # Omit or set to None for universal presets (everything above).
        'stems': ['drums'],
        'generation': {
            'onsets': {'engine': 'librosa-onset', 'params': {}},
            # Centroid engine matches what the legacy drum pipeline does:
            # spectral centroid → fake-MIDI, so kick/snare/cymbal get spread
            # across frets via the lane engine's percentile binning.
            'pitches': {'engine': 'centroid', 'params': {}},
            'quantized': {'engine': 'metric-weighted', 'params': {}},
            # Drum hits are almost always single events; raise the chord
            # threshold above where the centroid distribution would push
            # the lane engine into 2-fret chords.
            'lanes_expert': {'engine': 'section-sliding', 'params': {'chord_polyphony_threshold': 6}},
            'lanes_filtered': {'engine': 'identity', 'params': {}},
        },
    },
]


def _validate_generation(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(400, 'generation must be a JSON object')
    out: dict[str, Any] = {}
    for key in _STAGE_KEYS:
        stage = payload.get(key)
        if not isinstance(stage, dict) or 'engine' not in stage:
            raise HTTPException(400, f'generation.{key} must be {{engine, params}}')
        out[key] = {
            'engine': str(stage['engine']),
            'params': stage.get('params') or {},
        }
    return out


@router.get('')
async def list_presets(stem: str | None = Query(default=None)) -> list[dict[str, Any]]:
    """Built-ins first, then user-saved presets.

    Optional `stem` query param filters presets to those applicable to the
    given stem — a preset is included when it has no `stems` field
    (universal) OR its `stems` list contains the requested stem. User-saved
    presets are always universal in this scope.
    """
    all_presets = list(BUILTIN_PRESETS) + _load_user_presets()
    if stem is None:
        return all_presets
    return [p for p in all_presets if not p.get('stems') or stem in p['stems']]


@router.post('')
async def save_preset(body: dict = Body(...)) -> dict[str, Any]:
    """Create or overwrite a user preset by name. Built-in names are protected."""
    name = str(body.get('name', '')).strip()
    if not name:
        raise HTTPException(400, '`name` is required')
    if any(p['name'] == name for p in BUILTIN_PRESETS):
        raise HTTPException(409, f'`{name}` is a built-in preset and cannot be overwritten')

    generation = _validate_generation(body.get('generation'))
    description = str(body.get('description', '')).strip()

    # `stems` is an optional list restricting which stem rows surface this
    # preset (mirrors the built-in `drums-v1` shape). Drops silently if the
    # caller doesn't include it — universal preset, unchanged behaviour.
    raw_stems = body.get('stems')
    stems_filter: list[str] | None = None
    if isinstance(raw_stems, list) and raw_stems:
        cleaned = [str(s).strip() for s in raw_stems if isinstance(s, str) and str(s).strip()]
        if cleaned:
            stems_filter = cleaned

    presets = _load_user_presets()
    presets = [p for p in presets if p.get('name') != name]
    record: dict[str, Any] = {
        'name': name,
        'description': description,
        'builtin': False,
        'generation': generation,
    }
    if stems_filter:
        record['stems'] = stems_filter
    presets.append(record)
    _save_user_presets(presets)
    return record


@router.delete('/{name}')
async def delete_preset(name: str) -> dict[str, str]:
    if any(p['name'] == name for p in BUILTIN_PRESETS):
        raise HTTPException(409, f'`{name}` is a built-in preset and cannot be deleted')
    presets = _load_user_presets()
    before = len(presets)
    presets = [p for p in presets if p.get('name') != name]
    if len(presets) == before:
        raise HTTPException(404, f'No preset named `{name}`')
    _save_user_presets(presets)
    return {'name': name, 'deleted': 'true'}


@router.post('/propose-from-feedback')
async def propose_from_feedback(
    stem: str = Query(...),
    n: int = Query(default=3, ge=1, le=5),
    _admin: dict = Depends(require_admin),
) -> dict[str, list[dict[str, Any]]]:
    """Aggregate feedback for `stem`, call Claude, return validated drafts.
    Admin-only. No persistence — the user saves the drafts they want via
    the normal POST / endpoint."""
    from ..services.preset_proposer import ProposalError, propose_presets
    try:
        proposals = propose_presets(stem, n)
    except ProposalError as e:
        msg = str(e)
        if 'not configured' in msg.lower():
            raise HTTPException(503, msg)
        if 'no feedback' in msg.lower():
            raise HTTPException(422, msg)
        raise HTTPException(502, msg)
    return {'proposals': proposals}
