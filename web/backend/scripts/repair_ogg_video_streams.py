#!/usr/bin/env python3
"""Re-encode .ogg files under the upload dir that carry a non-audio stream.

Before stems._convert_to_ogg passed ``-vn``, converting a master with
embedded cover art or a video stream produced an .ogg with a Theora stream
ahead of the Vorbis audio. Players cope; libsndfile (librosa/soundfile) does
not — "File contains data in an unimplemented format" — so chart generation
failed on those tracks. This finds such files with ffprobe and rewrites them
audio-only (same Vorbis quality), keeping a ``.bak`` unless --no-backup.

    python scripts/repair_ogg_video_streams.py /var/lib/beatmap-uploads [--dry-run] [--no-backup]
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


def stream_types(path: Path) -> list[str]:
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', str(path)],
        capture_output=True, text=True,
    ).stdout
    return [ln.strip() for ln in out.splitlines() if ln.strip()]


def repair(path: Path, backup: bool) -> None:
    tmp = path.with_suffix('.repair.ogg')
    subprocess.run(
        ['ffmpeg', '-v', 'error', '-y', '-i', str(path), '-vn', '-sn', '-dn', '-map_metadata', '-1',
         '-c:a', 'libvorbis', '-q:a', '6', str(tmp)],
        check=True,
    )
    if backup:
        os.replace(path, path.with_suffix('.ogg.bak'))
    os.replace(tmp, path)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('root', type=Path)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--no-backup', action='store_true')
    args = ap.parse_args()
    bad = 0
    for path in sorted(args.root.rglob('*.ogg')):
        try:
            types = stream_types(path)
        except Exception as e:  # noqa: BLE001
            print(f'skip {path}: ffprobe failed ({e})', file=sys.stderr)
            continue
        if types and types[0] == 'audio' and all(t == 'audio' for t in types):
            continue
        bad += 1
        print(f'{"would repair" if args.dry_run else "repairing"} {path}  streams={types}')
        if not args.dry_run:
            repair(path, backup=not args.no_backup)
    print(f'{bad} file(s) {"need" if args.dry_run else "repaired"}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
