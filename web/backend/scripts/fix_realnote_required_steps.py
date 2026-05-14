"""Add pass-gates to the realnote-test sections.

Every per-(pack, scale) section's STEP gets `required=10 timing=any` (hit all
ten slot notes to progress) plus `retry_vo="vo/retry.ogg"` (so the Unity dev
hears a brief retry cue on fail). The intro / outro STEPs stay at
`required=0` — those are just transport markers.

This script also synthesizes the retry clip via Chatterbox if it doesn't
already exist on disk.

Usage (from web/backend/):
  python -m scripts.fix_realnote_required_steps
"""
from __future__ import annotations

import asyncio
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except AttributeError:
    pass

from app.services import tts  # noqa: E402
from scripts.fix_realnote_pacing import _find_track_dir  # noqa: E402

RETRY_VO_TEXT = "Oops, let's try that again."
RETRY_VO_REL = 'vo/retry.ogg'
REQUIRED_PER_SECTION = 10


# Matches `<tick> = STEP "<id>" required=<n> timing=<any|perfect> [retry_vo="..."] [next="..."]`.
STEP_RE = re.compile(
    r'^(?P<indent>\s*)(?P<tick>\d+)\s*=\s*STEP\s+'
    r'"(?P<id>[^"]*)"\s+'
    r'required=(?P<required>\d+)\s+'
    r'timing=(?P<timing>\w+)'
    r'(?P<rest>.*)$'
)


def _rewrite_step_line(line: str) -> str:
    """If `line` is a section STEP (stepId begins with `sec_`), set
    required=REQUIRED_PER_SECTION, timing=any, ensure retry_vo points at
    RETRY_VO_REL. Other STEPs (intro/outro) pass through untouched."""
    m = STEP_RE.match(line)
    if not m:
        return line
    step_id = m.group('id')
    if not step_id.startswith('sec_'):
        return line
    rest = m.group('rest')

    # Strip any existing retry_vo / next args from `rest` so we can rebuild
    # the suffix deterministically.
    rest = re.sub(r'\s+retry_vo="[^"]*"', '', rest)
    next_m = re.search(r'\s+next="([^"]*)"', rest)
    next_id = next_m.group(1) if next_m else ''
    rest = re.sub(r'\s+next="[^"]*"', '', rest)
    leftover = rest.strip()

    parts = [
        f'{m.group("indent")}{m.group("tick")} = STEP "{step_id}"',
        f'required={REQUIRED_PER_SECTION}',
        'timing=any',
        f'retry_vo="{RETRY_VO_REL}"',
    ]
    if next_id:
        parts.append(f'next="{next_id}"')
    if leftover:
        parts.append(leftover)
    return ' '.join(parts)


async def main() -> None:
    bm_dir = _find_track_dir()
    if bm_dir is None:
        sys.exit('Could not locate a Realnote Test v1 track.')
    chart_path = bm_dir / 'notes.chart'
    if not chart_path.exists():
        sys.exit(f'Chart not found: {chart_path}')

    # 1. Synthesize retry.ogg if missing.
    retry_path = bm_dir / RETRY_VO_REL
    if retry_path.exists():
        print(f'  retry clip already present: {retry_path} ({retry_path.stat().st_size} bytes)')
    else:
        retry_path.parent.mkdir(parents=True, exist_ok=True)
        print(f'  synthesizing retry clip: "{RETRY_VO_TEXT}"')
        await tts.synth_async(RETRY_VO_TEXT, retry_path)
        print(f'  wrote {retry_path} ({retry_path.stat().st_size} bytes)')

    # 2. Rewrite STEP lines.
    text = chart_path.read_text(encoding='utf-8')
    out_lines: list[str] = []
    changed = 0
    for line in text.splitlines():
        new_line = _rewrite_step_line(line)
        if new_line != line:
            changed += 1
        out_lines.append(new_line)
    new_text = '\n'.join(out_lines)
    if not new_text.endswith('\n'):
        new_text += '\n'
    chart_path.write_text(new_text, encoding='utf-8')
    print(f'  rewrote {changed} STEP lines')
    print(f'  wrote {chart_path}')


if __name__ == '__main__':
    asyncio.run(main())
