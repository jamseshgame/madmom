"""Rebuild the realnote-test chart's tick layout from actual VO durations.

The original generator scheduled each section on a fixed 17s budget assuming
~4s per VO. Chatterbox's actual clips run 3–9s, so longer VOs (like the
intro) overlap into the next section. This script reads the existing
[TutorialScript] entries' `duration_ms` fields, recomputes a non-overlapping
schedule, and rewrites every tick in the chart accordingly.

No re-synthesis: the existing vo/tutorial.ogg + the start_ms/duration_ms
embedded in the chart are reused verbatim.

Usage (from web/backend/):
  python -m scripts.fix_realnote_pacing <track_id>/<beatmap_id>

If you omit the path, the script looks for a track named "Realnote Test v1".
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402

RESOLUTION = 192
BPM = 120
TPS = (BPM * RESOLUTION) / 60  # 384 ticks/sec

# Same schedule constants the (fixed) generator uses.
PRE_PAD = 0.5
INTER_VO_BUFFER = 0.5
POST_VO_GAP = 1.0
NOTE_SPACING = 1.0
SECTION_TRAILING_GAP = 1.5
EOF_PAD = 2.0

NOTE_SPACING_TICKS = int(round(NOTE_SPACING * TPS))


def _t(sec: float) -> int:
    return int(round(sec * TPS))


def _find_track_dir() -> Path | None:
    """Look up the beatmap dir for the 'Realnote Test v1' track."""
    tracks_root = Path(settings.upload_dir) / '_tracks'
    for td in tracks_root.iterdir() if tracks_root.is_dir() else []:
        tj = td / 'track.json'
        if not tj.exists():
            continue
        try:
            data = json.loads(tj.read_text(encoding='utf-8'))
        except json.JSONDecodeError:
            continue
        if data.get('name') == 'Realnote Test v1':
            beatmaps = data.get('beatmaps') or []
            if beatmaps:
                bm_id = beatmaps[0].get('id')
                if bm_id:
                    return td / 'beatmaps' / bm_id
    return None


def rebuild_chart_from_durations(chart_path: Path) -> dict:
    """Read the chart at `chart_path`, recompute non-overlapping ticks from
    the embedded VO duration_ms fields, rewrite the file in place.

    Returns a small stats dict (`new_total_sec`, `lines_rewritten`).
    """
    text = chart_path.read_text(encoding='utf-8')

    # Pull every VO entry's tick + duration_ms in source order.
    vo_re = re.compile(
        r'^\s*(\d+)\s*=\s*VO\s+"vo/tutorial\.ogg"\s+'
        r'start_ms=(\d+)\s+duration_ms=(\d+)',
        re.MULTILINE,
    )
    vos: list[tuple[int, int, int]] = [
        (int(m.group(1)), int(m.group(2)), int(m.group(3)))
        for m in vo_re.finditer(text)
    ]
    if len(vos) < 3:
        sys.exit(f'Expected ≥3 VO entries (intro, sections, outro); found {len(vos)}.')
    vos.sort()

    intro_old_tick, _, intro_dur_ms = vos[0]
    outro_old_tick, _, outro_dur_ms = vos[-1]
    section_vos = vos[1:-1]   # the per-(pack, scale) VOs in order

    print(f'  intro VO     : tick {intro_old_tick}, {intro_dur_ms} ms')
    print(f'  sections     : {len(section_vos)}')
    print(f'  outro VO     : tick {outro_old_tick}, {outro_dur_ms} ms')

    # Build the new schedule, remapping every old tick that appears in the
    # chart to its new home. Section structure: each VO is followed by a
    # POST_VO_GAP, 10 R notes at NOTE_SPACING apart, then SECTION_TRAILING_GAP
    # before the next VO. The intro VO has no trailing notes; the outro VO
    # comes after the last section's trailing gap.
    cursor = PRE_PAD
    remap: dict[int, int] = {}

    # Intro VO + STEP at the same tick.
    remap[intro_old_tick] = _t(cursor)
    cursor += intro_dur_ms / 1000.0 + INTER_VO_BUFFER

    # Per the generator, each section's first R note (+ E declarations) sits
    # 5 seconds after the section's VO tick (VO_LEN_SEC=4 + GAP_AFTER_VO_SEC=1).
    OLD_FIRST_NOTE_OFFSET = _t(5)

    for sec_tick_old, _, sec_dur_ms in section_vos:
        sec_new = _t(cursor)
        remap[sec_tick_old] = sec_new
        cursor += sec_dur_ms / 1000.0 + POST_VO_GAP
        first_note_new = _t(cursor)
        old_first_note = sec_tick_old + OLD_FIRST_NOTE_OFFSET
        for j in range(10):
            remap[old_first_note + j * NOTE_SPACING_TICKS] = first_note_new + j * NOTE_SPACING_TICKS
        # Last note plays at first_note + 9*NOTE_SPACING; after its 1-second
        # length, we add the trailing gap before the next VO.
        cursor = (first_note_new + 9 * NOTE_SPACING_TICKS) / TPS + NOTE_SPACING + SECTION_TRAILING_GAP

    remap[outro_old_tick] = _t(cursor)
    cursor += outro_dur_ms / 1000.0 + EOF_PAD
    new_total_sec = cursor

    print(f'  ticks remapped: {len(remap)}')
    print(f'  new total     : {new_total_sec:.1f}s')

    # Rewrite each line whose tick prefix is in the remap. Lines without a
    # leading "<digits> =" prefix (headers, braces, comments) pass through.
    line_re = re.compile(r'^(\s*)(\d+)(\s*=)')
    out_lines: list[str] = []
    rewritten = 0
    for line in text.splitlines():
        m = line_re.match(line)
        if m:
            old = int(m.group(2))
            new = remap.get(old)
            if new is not None and new != old:
                line = f'{m.group(1)}{new}{m.group(3)}{line[m.end():]}'
                rewritten += 1
        out_lines.append(line)

    new_text = '\n'.join(out_lines)
    if not new_text.endswith('\n'):
        new_text += '\n'
    chart_path.write_text(new_text, encoding='utf-8')
    print(f'  lines rewritten: {rewritten}')
    print(f'  wrote {chart_path}')
    return {'new_total_sec': new_total_sec, 'lines_rewritten': rewritten}


def main() -> None:
    if len(sys.argv) > 1:
        bm_dir = Path(sys.argv[1])
    else:
        found = _find_track_dir()
        if found is None:
            sys.exit('Could not locate a Realnote Test v1 track. Pass the beatmap dir as arg.')
        bm_dir = found

    chart_path = bm_dir / 'notes.chart'
    if not chart_path.exists():
        sys.exit(f'Chart not found: {chart_path}')

    rebuild_chart_from_durations(chart_path)


if __name__ == '__main__':
    main()
