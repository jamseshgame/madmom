"""Fold vo/retry.ogg into vo/tutorial.ogg + rewrite STEP retry refs.

The original design shipped retry as a standalone ogg the engine played whole.
We're moving to a single collated VO bundle so retry *variants* (multiple
distinct clips the engine can pick from per fail) live alongside section VOs
with the same start_ms/duration_ms slice semantics.

This script:
  1. Probes vo/tutorial.ogg and vo/retry.ogg durations.
  2. Concats `tutorial.ogg` + 250 ms silence + `retry.ogg` → new tutorial.ogg.
  3. Rewrites every STEP line whose `retry_vo` points at the standalone file:
       retry_vo="vo/retry.ogg"
       → retry_vo="vo/tutorial.ogg" retry_start_ms=N retry_duration_ms=M
  4. Deletes the standalone `vo/retry.ogg`.

Usage (from web/backend/):
  python -m scripts.merge_retry_into_tutorial
"""
from __future__ import annotations

import asyncio
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except AttributeError:
    pass

from scripts.fix_realnote_pacing import _find_track_dir  # noqa: E402

VO_GAP_MS = 250


async def _probe_ms(path: Path) -> int:
    proc = await asyncio.create_subprocess_exec(
        'ffprobe', '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        str(path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    if proc.returncode != 0:
        return 0
    try:
        return max(0, int(round(float(stdout.decode().strip()) * 1000)))
    except ValueError:
        return 0


async def main() -> None:
    bm_dir = _find_track_dir()
    if bm_dir is None:
        sys.exit('Could not locate a Realnote Test v1 track.')
    vo_dir = bm_dir / 'vo'
    tutorial = vo_dir / 'tutorial.ogg'
    retry = vo_dir / 'retry.ogg'
    chart_path = bm_dir / 'notes.chart'
    if not tutorial.exists():
        sys.exit(f'Missing {tutorial}')
    if not retry.exists():
        sys.exit(f'Missing {retry} — already merged?')

    tutorial_ms = await _probe_ms(tutorial)
    retry_ms = await _probe_ms(retry)
    print(f'  tutorial.ogg : {tutorial_ms} ms')
    print(f'  retry.ogg    : {retry_ms} ms')
    if tutorial_ms == 0 or retry_ms == 0:
        sys.exit('ffprobe failed on one of the inputs.')

    # The retry slice will live at the very end of tutorial.ogg, after a
    # standard 250 ms silence gap (matches synth_collated_vo's spacing so a
    # later regeneration produces the same layout).
    retry_start_ms = tutorial_ms + VO_GAP_MS

    # Concat tutorial.ogg + gap + retry.ogg → tutorial.ogg.tmp, then atomic
    # replace. Re-encode at libvorbis -q:a 4 so the output matches the rest
    # of the collated file's quality.
    gap = vo_dir / '_gap.ogg'
    concat_list = vo_dir / '_concat.txt'
    new_tutorial = vo_dir / '_tutorial_new.ogg'

    print('  building 250 ms silence gap…')
    proc = await asyncio.create_subprocess_exec(
        'ffmpeg', '-y',
        '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
        '-t', f'{VO_GAP_MS / 1000:.3f}',
        '-c:a', 'libvorbis', '-q:a', '3',
        str(gap),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate()
    if proc.returncode != 0:
        sys.exit(f'silence gen failed: {err.decode()[-200:]}')

    concat_list.write_text(
        f"file '{tutorial.as_posix()}'\n"
        f"file '{gap.as_posix()}'\n"
        f"file '{retry.as_posix()}'\n",
        encoding='utf-8',
    )

    print(f'  concatenating → {new_tutorial.name}…')
    proc = await asyncio.create_subprocess_exec(
        'ffmpeg', '-y',
        '-f', 'concat', '-safe', '0',
        '-i', str(concat_list),
        '-c:a', 'libvorbis', '-q:a', '4',
        str(new_tutorial),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate()
    if proc.returncode != 0:
        sys.exit(f'concat failed: {err.decode()[-300:]}')

    # Replace the old tutorial.ogg, drop the helper files.
    tutorial.unlink()
    new_tutorial.rename(tutorial)
    gap.unlink(missing_ok=True)
    concat_list.unlink(missing_ok=True)
    retry.unlink()
    print(f'  wrote {tutorial} ({tutorial.stat().st_size} bytes)')
    print(f'  retry slice: start_ms={retry_start_ms}, duration_ms={retry_ms}')

    # Rewrite STEP lines: any retry_vo="vo/retry.ogg" → retry_vo="vo/tutorial.ogg"
    # with the new offset fields. Match the whole STEP line so we can rebuild
    # the suffix without disturbing surrounding fields.
    text = chart_path.read_text(encoding='utf-8')
    step_re = re.compile(
        r'^(?P<head>(?P<indent>\s*)(?P<tick>\d+)\s*=\s*STEP\s+"[^"]+"\s+'
        r'required=\d+\s+timing=\w+)'
        r'(?P<mid>.*?)'
        r'\s+retry_vo="vo/retry\.ogg"'
        r'(?P<tail>.*)$',
        re.MULTILINE,
    )

    def repl(m: re.Match) -> str:
        # Insert retry slice info where the old retry_vo lived so the field
        # order stays predictable for downstream parsers.
        slice_attrs = (
            f' retry_vo="vo/tutorial.ogg"'
            f' retry_start_ms={retry_start_ms}'
            f' retry_duration_ms={retry_ms}'
        )
        return m.group('head') + m.group('mid') + slice_attrs + m.group('tail')

    new_text, count = step_re.subn(repl, text)
    if not new_text.endswith('\n'):
        new_text += '\n'
    chart_path.write_text(new_text, encoding='utf-8')
    print(f'  rewrote {count} STEP retry refs')
    print(f'  wrote {chart_path}')


if __name__ == '__main__':
    asyncio.run(main())
