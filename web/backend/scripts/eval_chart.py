#!/usr/bin/env python3
"""Score a generated notes.chart against a reference chart for the same audio.

    python scripts/eval_chart.py REFERENCE.chart CANDIDATE.chart [--tol-ms 50] [--drums|--guitar] [--json]

Run several candidates (one per preset) against the same reference to rank
presets objectively; pair with GET /api/feedback/scoreboard for the
reviewer-side numbers.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.pipeline.evaluate import evaluate_charts, format_report  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('reference')
    ap.add_argument('candidates', nargs='+')
    ap.add_argument('--tol-ms', type=float, default=50.0)
    g = ap.add_mutually_exclusive_group()
    g.add_argument('--drums', action='store_true')
    g.add_argument('--guitar', action='store_true')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    drums = True if args.drums else False if args.guitar else None
    ref = Path(args.reference).read_text(encoding='utf-8', errors='replace')
    results = {}
    for cand in args.candidates:
        text = Path(cand).read_text(encoding='utf-8', errors='replace')
        results[cand] = evaluate_charts(ref, text, tol_ms=args.tol_ms, drums=drums)
    if args.json:
        print(json.dumps(results, indent=2))
        return 0
    for cand, res in results.items():
        print(f'== {cand}')
        print(format_report(res))
        print()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
