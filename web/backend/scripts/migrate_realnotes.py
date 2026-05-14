"""One-time migration: lane-8 sample-pack scheme → R notes + E events.

The old encoding was a lane-8 marker note at the same tick as a playable
note, with the slot index packed into the sustain field. The slot pointed
back into the beatmap's ``rec['sample_packs']`` list (a roster of pack/scale
combos). This made the chart non-self-describing and added a fragile
indirection.

The new encoding lives entirely in the chart:
  - Playable real-notes become ``<tick> = R <lane> <sustain>`` lines.
  - Active (pack, scale) is declared via section-scoped E events:
      ``<tick> = E realnotes_pack <pack-id>``
      ``<tick> = E realnotes_scale <scale-id>``
  - State propagates forward within a section; the publish bundler walks
    these events to figure out which (pack, scale) bundles to ship.

This script walks every beatmap's chart under UPLOAD_DIR, rewrites lane-8
markers + their paired playable notes into R notes with the appropriate E
events, strips ``sample_packs`` / ``sample_pack`` records from each
``track.json``, and removes the now-orphaned ``tutorial_samples*/``
directories. Idempotent — skips beatmaps whose chart already contains R
notes or whose record has no slot roster.

Usage:
  python -m scripts.migrate_realnotes          # uses settings.upload_dir
  python -m scripts.migrate_realnotes /some/dir
"""
from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path


_LANE8_RE = re.compile(r'^(\s*)(\d+)\s*=\s*N\s+8\s+(\d+)\s*$', re.IGNORECASE)
_PLAYABLE_RE = re.compile(r'^(\s*)(\d+)\s*=\s*N\s+(\d+)\s+(\d+)\s*$', re.IGNORECASE)
_R_NOTE_RE = re.compile(r'^\s*\d+\s*=\s*R\s+\d+\s+\d+', re.IGNORECASE)
_SECTION_RE = re.compile(r'(\[[^\]]+\]\s*\{)([^}]*)(\})', re.DOTALL)


def _transform_section_body(body: str, slot_to_combo: dict[int, tuple[str, str]]) -> str:
    """Rewrite one section body. Returns the new body string."""
    # Parse lines into (tick, original-line, kind, payload) tuples while
    # remembering source order. lane-8 markers contribute a "slot" annotation
    # to the matching playable note at the same tick.
    lines = body.splitlines()
    if not lines:
        return body
    if any(_R_NOTE_RE.match(l) for l in lines):
        # Already migrated — short-circuit so re-runs are idempotent.
        return body
    if not any(_LANE8_RE.match(l) for l in lines):
        # Nothing to migrate; preserve exact whitespace.
        return body

    # Bucket per tick: keep all lines plus per-tick (slot if any).
    slot_by_tick: dict[int, int] = {}
    line_ticks: list[int | None] = []
    for raw in lines:
        m = _LANE8_RE.match(raw)
        if m:
            tick = int(m.group(2))
            slot_by_tick[tick] = int(m.group(3))
            line_ticks.append(tick)
        else:
            mp = _PLAYABLE_RE.match(raw)
            line_ticks.append(int(mp.group(2)) if mp else None)

    # Build output: drop lane-8 lines, convert paired playables to R when the
    # tick had a marker AND the slot resolves to a known (pack, scale), and
    # emit declaration E events at the first tick where the active combo
    # changes (or just before the first R note).
    out: list[str] = []
    active_pack: str | None = None
    active_scale: str | None = None
    for raw, lt in zip(lines, line_ticks):
        m8 = _LANE8_RE.match(raw)
        if m8:
            # Marker line — emitted out implicitly through its paired playable.
            continue
        mp = _PLAYABLE_RE.match(raw)
        if not mp:
            out.append(raw)
            continue
        indent, tick_s, lane_s, sustain_s = mp.group(1), mp.group(2), mp.group(3), mp.group(4)
        lane = int(lane_s)
        tick = int(tick_s)
        slot = slot_by_tick.get(tick)
        # Real-note iff (a) the tick has a marker, (b) the playable lane is a
        # real-note candidate (0-4 frets or 7 open — not modifier 5/6), and
        # (c) the slot resolves to a known (pack, scale).
        combo: tuple[str, str] | None = None
        if slot is not None and (lane <= 4 or lane == 7):
            combo = slot_to_combo.get(slot)
        if combo:
            pack, scale = combo
            if pack != active_pack:
                out.append(f'{indent}{tick} = E realnotes_pack {pack}')
                active_pack = pack
            if scale != active_scale:
                out.append(f'{indent}{tick} = E realnotes_scale {scale}')
                active_scale = scale
            out.append(f'{indent}{tick} = R {lane} {sustain_s}')
        else:
            out.append(raw)

    return '\n'.join(out)


def _transform_chart_text(text: str, slot_to_combo: dict[int, tuple[str, str]]) -> str:
    """Rewrite every section body in a full chart file."""
    def repl(m: re.Match) -> str:
        head, body, tail = m.group(1), m.group(2), m.group(3)
        return head + _transform_section_body(body, slot_to_combo) + tail
    return _SECTION_RE.sub(repl, text)


def _slot_roster(rec: dict) -> dict[int, tuple[str, str]]:
    """Extract a {slot_index: (pack_id, scale_id)} map from a beatmap record.
    Handles both new (`sample_packs`: list) and legacy (`sample_pack`: dict)
    schemas. Tombstones (None) are skipped."""
    out: dict[int, tuple[str, str]] = {}
    packs = rec.get('sample_packs')
    if isinstance(packs, list):
        for i, entry in enumerate(packs):
            if isinstance(entry, dict) and entry.get('pack_id') and entry.get('scale_id'):
                out[i] = (entry['pack_id'], entry['scale_id'])
        return out
    legacy = rec.get('sample_pack')
    if isinstance(legacy, dict) and legacy.get('pack_id') and legacy.get('scale_id'):
        out[0] = (legacy['pack_id'], legacy['scale_id'])
    return out


def migrate_track_dir(track_dir: Path) -> dict:
    """Run the migration over one track directory. Returns a small stats dict."""
    stats = {'beatmaps_migrated': 0, 'charts_rewritten': 0, 'dirs_removed': 0, 'skipped': 0}
    tj = track_dir / 'track.json'
    if not tj.exists():
        return stats
    data = json.loads(tj.read_text(encoding='utf-8'))
    beatmaps = data.get('beatmaps') or []
    if not isinstance(beatmaps, list):
        return stats

    bm_root = track_dir / 'beatmaps'
    for rec in beatmaps:
        bm_id = rec.get('id')
        if not bm_id:
            stats['skipped'] += 1
            continue
        bm_dir = bm_root / bm_id
        slot_to_combo = _slot_roster(rec)
        had_roster = bool(slot_to_combo) or 'sample_packs' in rec or 'sample_pack' in rec

        # Rewrite any chart in the beatmap dir.
        rewrote_any = False
        if bm_dir.is_dir():
            for chart in bm_dir.glob('*.chart'):
                try:
                    text = chart.read_text(encoding='utf-8', errors='replace')
                except OSError:
                    continue
                new_text = _transform_chart_text(text, slot_to_combo)
                if new_text != text:
                    chart.write_text(new_text, encoding='utf-8')
                    rewrote_any = True

        # Strip slot roster from the record.
        if 'sample_packs' in rec:
            del rec['sample_packs']
        if 'sample_pack' in rec:
            del rec['sample_pack']

        # Drop now-orphan tutorial_samples* dirs.
        if bm_dir.is_dir():
            for d in bm_dir.glob('tutorial_samples*'):
                if d.is_dir():
                    shutil.rmtree(d, ignore_errors=True)
                    stats['dirs_removed'] += 1

        if rewrote_any:
            stats['charts_rewritten'] += 1
        if had_roster or rewrote_any:
            stats['beatmaps_migrated'] += 1

    tj.write_text(json.dumps(data, indent=2), encoding='utf-8')
    return stats


def main() -> None:
    if len(sys.argv) > 1:
        upload_dir = Path(sys.argv[1])
    else:
        from app.config import settings
        upload_dir = Path(settings.upload_dir)
    tracks_root = upload_dir / '_tracks'
    if not tracks_root.is_dir():
        print(f'No tracks dir at {tracks_root}; nothing to do.')
        return
    totals = {'tracks': 0, 'beatmaps_migrated': 0, 'charts_rewritten': 0, 'dirs_removed': 0}
    for td in sorted(tracks_root.iterdir()):
        if not td.is_dir():
            continue
        s = migrate_track_dir(td)
        totals['tracks'] += 1
        for k in ('beatmaps_migrated', 'charts_rewritten', 'dirs_removed'):
            totals[k] += s[k]
        if any(s[k] for k in ('beatmaps_migrated', 'charts_rewritten', 'dirs_removed')):
            print(f'  {td.name}: {s}')
    print(f'Done. Totals: {totals}')


if __name__ == '__main__':
    main()
