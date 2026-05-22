"""Anthropic-backed preset proposer.

Reads aggregated feedback for a stem + the current preset library + the
engine catalog, builds a system prompt with prompt caching on the
large prefix, calls Claude, parses the response, and returns
schema-validated proposals.

The caller (the generation_presets router) is responsible for HTTP
response shaping. This module raises ProposalError for all user-facing
failure modes."""
from __future__ import annotations

import json
import re
from typing import Any

import anthropic

from ..config import settings
from .feedback import FEEDBACK_TAGS, aggregate_for_stem


class ProposalError(RuntimeError):
    pass


_PROPOSAL_SCHEMA_INSTRUCTIONS = """
Return JSON with this exact shape:

{
  "proposals": [
    {
      "name": "<short slug-style name, e.g. v12-anti-cramp>",
      "description": "<one sentence — what this preset addresses>",
      "stems": ["<stem>"] | null,
      "generation": {
        "onsets":         {"engine": "<one of the catalogued engine ids>", "params": {...}},
        "pitches":        {"engine": "...", "params": {...}},
        "quantized":      {"engine": "...", "params": {...}},
        "lanes_expert":   {"engine": "...", "params": {...}},
        "lanes_filtered": {"engine": "...", "params": {...}}
      },
      "rationale": "<paragraph citing specific feedback by (track_name, preset_name) and explaining why this preset addresses it>"
    }
  ]
}

Hard rules:
- Use only engines that appear in the engine catalog above.
- `rationale` MUST cite at least one feedback note by its (track_name, preset_name).
- Return at most `n` proposals. Return fewer if you don't see distinct patterns worth N proposals.
- Do NOT propose presets that duplicate the current preset library.
- Output ONLY the JSON object — no surrounding prose, no markdown fences.
"""


def _anthropic_client_factory():
    return anthropic.Anthropic(api_key=settings.anthropic_api_key)


# Module-level so tests can patch it.
_anthropic_client: Any = None


def _build_engine_catalog_text() -> str:
    """Pull the engine catalog from the registry and render as a stable text block.

    The registry returns each engine as `{engine_id, display_name, params_schema}`
    where `params_schema` is a dict keyed by parameter name. We render the
    parameter names as a comma-separated list — the LLM gets the engine IDs +
    short descriptions, which is enough to choose between engines without
    drowning it in the full UI param schema.
    """
    # Local import to keep services free of router/registry imports at module load.
    from .pipeline.registry import engines_catalog
    cat = engines_catalog()  # {stage: [{engine_id, display_name, params_schema}, ...]}
    parts = ['## Engine catalog\n']
    for stage, engines in cat.items():
        parts.append(f'### {stage}')
        for e in engines:
            schema = e.get('params_schema') or {}
            params_text = ', '.join(schema.keys()) or '(no params)'
            parts.append(f"- `{e['engine_id']}` — {e.get('display_name', '')}; params: {params_text}")
        parts.append('')
    return '\n'.join(parts)


def _build_existing_presets_text(stem: str) -> str:
    from ..routers.generation_presets import BUILTIN_PRESETS, _load_user_presets
    relevant = []
    for p in list(BUILTIN_PRESETS) + _load_user_presets():
        s = p.get('stems') or []
        if not s or stem in s:
            relevant.append(p)
    lines = [f'## Existing presets applicable to stem "{stem}"\n']
    for p in relevant:
        lines.append(f"- **{p['name']}** — {p.get('description', '')}; engines: {json.dumps(p.get('generation', {}))}")
    return '\n'.join(lines)


def _build_system_prompt(stem: str) -> list[dict]:
    """System prompt is split into a stable (cacheable) prefix and a small tail."""
    prefix = (
        f"You are an audio engineering assistant proposing new chart-generation presets "
        f"for the Jamsesh rhythm game. Each preset configures five pipeline stages "
        f"(onsets, pitches, quantized, lanes_expert, lanes_filtered). You will be given "
        f"player feedback on charts generated with the existing presets for the **{stem}** "
        f"stem; your job is to propose up to N new presets that address recurring complaints "
        f"and aren't already covered.\n\n"
        f"{_build_engine_catalog_text()}\n\n"
        f"{_build_existing_presets_text(stem)}\n\n"
        f"## Tag vocabulary used in player feedback\n{json.dumps(FEEDBACK_TAGS, indent=2)}\n\n"
        f"{_PROPOSAL_SCHEMA_INSTRUCTIONS}"
    )
    return [{
        'type': 'text',
        'text': prefix,
        'cache_control': {'type': 'ephemeral'},
    }]


def _build_user_prompt(stem: str, n: int, aggregated: list[dict]) -> str:
    lines = [f'# Feedback corpus for stem: {stem}', f'Propose up to N={n} presets.\n']
    for group in aggregated:
        lines.append(f"## Track: {group['track_name']} — preset: {group['preset_name']} (beatmap_id: {group['beatmap_id']})")
        for note in group['notes']:
            tags = ', '.join(note.get('tags') or [])
            lines.append(f"- rating {note['rating']}, tags [{tags}] — \"{note.get('text', '')}\" (by {note.get('author', '?')})")
        lines.append('')
    return '\n'.join(lines)


def _extract_json(text: str) -> dict:
    """Tolerate small wrapping (e.g. accidental code fences) but require a JSON object."""
    text = text.strip()
    # Strip a wrapping ```json ... ``` if present.
    fence = re.match(r'^```(?:json)?\s*(.*?)\s*```$', text, re.DOTALL)
    if fence:
        text = fence.group(1)
    return json.loads(text)


def _validate_proposal(p: Any) -> dict | None:
    """Reject anything that can't pass the existing preset schema check."""
    if not isinstance(p, dict):
        return None
    if not isinstance(p.get('name'), str) or not p['name'].strip():
        return None
    if not isinstance(p.get('generation'), dict):
        return None
    try:
        from ..routers.generation_presets import _validate_generation
        gen = _validate_generation(p['generation'])
    except Exception:
        return None
    out = {
        'name': p['name'].strip(),
        'description': str(p.get('description', '')).strip(),
        'generation': gen,
        'rationale': str(p.get('rationale', '')).strip(),
    }
    stems = p.get('stems')
    if isinstance(stems, list) and all(isinstance(s, str) for s in stems) and stems:
        out['stems'] = stems
    return out


def propose_presets(stem: str, n: int) -> list[dict]:
    global _anthropic_client
    if not settings.anthropic_api_key:
        raise ProposalError('Anthropic API key not configured')
    if _anthropic_client is None:
        _anthropic_client = _anthropic_client_factory()

    aggregated = aggregate_for_stem(stem)
    if not aggregated:
        raise ProposalError(f"No feedback to aggregate for stem '{stem}'")

    system_blocks = _build_system_prompt(stem)
    user_text = _build_user_prompt(stem, n, aggregated)

    try:
        message = _anthropic_client.messages.create(
            model=settings.anthropic_model,
            max_tokens=settings.anthropic_max_tokens,
            system=system_blocks,
            messages=[{'role': 'user', 'content': user_text}],
        )
    except anthropic.APIError as e:
        raise ProposalError(f'Anthropic API error: {e}') from e

    raw = ''.join(b.text for b in message.content if getattr(b, 'type', '') == 'text')
    try:
        payload = _extract_json(raw)
    except json.JSONDecodeError as e:
        raise ProposalError(f'Claude returned invalid JSON: {e}') from e

    proposals = payload.get('proposals')
    if not isinstance(proposals, list) or not proposals:
        raise ProposalError('Response contained no proposals')

    valid = [v for v in (_validate_proposal(p) for p in proposals) if v]
    if not valid:
        raise ProposalError('No valid proposals returned')
    return valid[:n]
