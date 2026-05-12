"""Pre-render every (pack, scale) combo using fluidsynth + FluidR3_GM.

Run once on a host with fluidsynth + a GM soundfont installed (Ubuntu:
`apt-get install fluidsynth fluid-soundfont-gm`). Output ships in the repo
under `web/backend/sample_packs_data/<pack>/<scale>/<slot>.ogg`; the apply
endpoint copies these into a track's tutorial_samples/ on demand.

Usage (from web/backend/):
    python scripts/render_sample_packs.py
    python scripts/render_sample_packs.py --packs acoustic-nylon,bass-finger
    python scripts/render_sample_packs.py --force      # re-render existing
"""
from __future__ import annotations

import argparse
import shutil
import sys
import time
from pathlib import Path

# Ensure app.* is importable when run from web/backend/.
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from app.services import sample_packs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--packs', default='',
                    help='Comma-separated pack ids (default: all)')
    ap.add_argument('--scales', default='',
                    help='Comma-separated scale ids (default: all)')
    ap.add_argument('--force', action='store_true',
                    help='Re-render even if pre-rendered files already exist')
    args = ap.parse_args()

    if not sample_packs._have_fluidsynth():
        sf2 = sample_packs._resolve_sf2()
        print('ERROR: fluidsynth or a GM SoundFont is missing.')
        print('  fluidsynth on PATH:', shutil.which('fluidsynth'))
        print('  SF2 candidates checked:', sample_packs._SF2_CANDIDATES)
        print('  found:', sf2)
        print('  Install: sudo apt-get install fluidsynth fluid-soundfont-gm')
        return 1

    pack_ids = [p.strip() for p in args.packs.split(',') if p.strip()] or list(sample_packs.PACKS)
    scale_ids = [s.strip() for s in args.scales.split(',') if s.strip()] or list(sample_packs.SCALES)

    out_root = sample_packs._PRERENDERED_DIR
    out_root.mkdir(parents=True, exist_ok=True)

    total_combos = len(pack_ids) * len(scale_ids)
    print(f'Rendering {total_combos} pack/scale combos → {out_root}')
    n = 0
    t0 = time.perf_counter()
    for pack_id in pack_ids:
        pack = sample_packs.get_pack(pack_id)
        if pack is None:
            print(f'  ! skipping unknown pack: {pack_id}')
            continue
        for scale_id in scale_ids:
            scale = sample_packs.get_scale(scale_id)
            if scale is None:
                print(f'  ! skipping unknown scale: {scale_id}')
                continue
            out_dir = out_root / pack_id / scale_id
            if not args.force and sample_packs.prerendered_path(pack_id, scale_id):
                print(f'  · {pack_id}/{scale_id} already rendered — skip')
                n += 1
                continue
            t_combo = time.perf_counter()
            sample_packs._render_pack_sf2(pack, scale, out_dir)
            elapsed = time.perf_counter() - t_combo
            sizes = sum((out_dir / f'{s}.ogg').stat().st_size for s in sample_packs.SLOT_ORDER)
            print(f'  ✓ {pack_id}/{scale_id}  {sizes/1024:.0f} KB total  {elapsed:.1f}s')
            n += 1
    print(f'\nDone. {n}/{total_combos} combos in {time.perf_counter() - t0:.1f}s.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
