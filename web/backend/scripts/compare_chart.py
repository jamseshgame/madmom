#!/usr/bin/env python3
"""Compare an auto-generated drum chart against a human reference, end to end.

    python scripts/compare_chart.py REFERENCE AUTO [AUTO ...] [--json out.json] [--tol-ms 50]

REFERENCE: a Clone Hero / YARG `.sng`, a `.zip`, a song folder, a `.chart`
or a Rock Band style `notes.mid` (PART DRUMS is converted; a 4-lane MIDI
without tom markers is compared at pad level, which is all it authored).

AUTO: a Jamsesh beatmap `.zip` / folder (notes.chart + song.ogg, the
latter being the stem the chart was made from), or a bare `.chart`.

When both sides have audio, the two recordings are aligned first
(speed + lag via spectral flux; the reference's drum stems are used when
present) so charts made from different masters — a YouTube rip vs a game
master — are compared on one clock. The alignment quality is printed; an
unreliable alignment is flagged rather than silently scored.

Several AUTO charts (one per preset) against one REFERENCE prints a
ranking table at the end.
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.pipeline.align import align_audio  # noqa: E402
from app.services.pipeline.evaluate import compare_drums, format_drum_report  # noqa: E402
from app.services.pipeline.reference_charts import AUDIO_EXTS, load_reference  # noqa: E402


def _load_auto(path: Path, workdir: Path) -> tuple[str, Path | None]:
    path = Path(path)
    if path.suffix.lower() == '.chart':
        audio = next((p for p in path.parent.iterdir() if p.suffix.lower() in AUDIO_EXTS), None)
        return path.read_text(encoding='utf-8', errors='replace'), audio
    if path.suffix.lower() == '.zip':
        folder = workdir / ('auto_' + path.stem)
        with zipfile.ZipFile(path) as zf:
            zf.extractall(folder)
    else:
        folder = path
    chart = next(folder.rglob('notes.chart'), None)
    if chart is None:
        raise SystemExit(f'{path}: no notes.chart found')
    audio = next((p for p in chart.parent.iterdir() if p.suffix.lower() in AUDIO_EXTS), None)
    return chart.read_text(encoding='utf-8', errors='replace'), audio


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('reference')
    ap.add_argument('auto', nargs='+')
    ap.add_argument('--tol-ms', type=float, default=50.0)
    ap.add_argument('--no-align', action='store_true', help='assume both charts share one clock')
    ap.add_argument('--json', type=Path, help='write full results here')
    args = ap.parse_args()

    workdir = Path(tempfile.mkdtemp(prefix='compare_chart_'))
    ref = load_reference(Path(args.reference), workdir)
    title = ref.meta.get('name') or Path(args.reference).stem
    print(f'reference: {title}  ({ref.source})')
    if ref.pro_drums is False:
        print('  note: 4-lane MIDI without tom markers — compared at pad level (kick/snare/yellow/blue/green)')
    ref_audio = ref.drum_stems or ref.audio_path

    results = {}
    for auto_path in args.auto:
        text, auto_audio = _load_auto(Path(auto_path), workdir)
        to_ref = None
        align_info = None
        if not args.no_align and auto_audio and ref_audio:
            al = align_audio(auto_audio, ref_audio)
            align_info = {'speed': al.speed, 'lag_s': al.lag_s, 'ncc': al.ncc,
                          'window_lag_std_ms': al.window_lag_std_ms, 'reliable': al.reliable}
            print(f'\n== {auto_path}\nalignment: speed {al.speed:.4f}, lag {al.lag_s:+.3f} s, ncc {al.ncc:.2f}, '
                  f'window std {al.window_lag_std_ms:.0f} ms  {"OK" if al.reliable else "UNRELIABLE — results may be meaningless"}')
            to_ref = al.to_ref
        else:
            print(f'\n== {auto_path}\nalignment: none (same clock assumed)')
        res = compare_drums(ref.chart_text, text, to_ref, tol_ms=args.tol_ms)
        res['alignment'] = align_info
        results[str(auto_path)] = res
        print(format_drum_report(res))

    if len(results) > 1:
        print('\nranking (Expert):')
        rows = sorted(results.items(), key=lambda kv: -kv[1].get('summary', {}).get('expert_onset_f1', 0))
        for name, r in rows:
            s = r.get('summary', {})
            pads = s.get('expert_pad_f1', {})
            print(f"  {Path(name).name[:40]:40s} onset F1 {s.get('expert_onset_f1', 0):.2f}  "
                  + '  '.join(f'{k[:2]} {v:.2f}' for k, v in pads.items())
                  + f"  exact {s.get('expert_exact_pad_set') or 0:.2f}")
    if args.json:
        args.json.write_text(json.dumps({'reference': ref.source, 'title': title, 'results': results}, indent=1))
        print(f'\nwrote {args.json}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
