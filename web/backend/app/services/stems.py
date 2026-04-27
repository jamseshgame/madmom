"""Stem separation using Demucs (htdemucs model family)."""

import asyncio
import re
import shutil
import sys
from pathlib import Path


# Model → available stems
MODEL_STEMS = {
    'htdemucs': ['vocals', 'drums', 'bass', 'other'],
    'htdemucs_ft': ['vocals', 'drums', 'bass', 'other'],
    'htdemucs_6s': ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'],
}

DEFAULT_MODEL = 'htdemucs'

# Demucs stem name → Jamsesh Quest game stem name
DEMUCS_TO_GAME = {
    'vocals': 'vocals',
    'drums': 'drums',
    'guitar': 'guitar',
    'bass': 'rhythm',
    'other': 'other',
    'piano': 'piano',
}

# Clone Hero song.ini field order
_SONG_INI_FIELDS = [
    'name', 'artist', 'album', 'genre', 'year', 'song_length', 'charter',
    'diff_band', 'diff_guitar', 'diff_rhythm', 'diff_bass', 'diff_drums', 'diff_keys',
    'diff_guitarghl', 'diff_bassghl', 'diff_rhythmghl',
    'preview_start_time', 'icon', 'playlist_track', 'track', 'album_track',
    'delay', 'loading_phrase',
]


def write_song_ini(output_dir: Path, fields: dict) -> Path:
    """Write a Clone Hero-compatible song.ini file."""
    ini_path = output_dir / 'song.ini'
    lines = ['[song]']
    for key in _SONG_INI_FIELDS:
        value = fields.get(key, '')
        lines.append(f'{key} = {value}')
    ini_path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return ini_path


# Matches tqdm-style progress: " 42%|████      | 6/14 [00:12<00:16,  2.0s/it]"
_PROGRESS_RE = re.compile(r'(\d+)%\|')
_BAG_RE = re.compile(r'bag of (\d+) model')


async def _convert_to_ogg(src: Path, dst: Path, progress_callback=None) -> Path:
    """Convert an audio file to OGG Vorbis using ffmpeg."""
    cmd = ['ffmpeg', '-y', '-i', str(src), '-c:a', 'libvorbis', '-q:a', '6', str(dst)]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        msg = stderr.decode('utf-8', errors='replace').strip().splitlines()[-3:]
        raise RuntimeError(f'ffmpeg failed converting {src.name}: {" ".join(msg)}')
    if progress_callback:
        await progress_callback('convert', -1, f'Converted {src.name} → {dst.name}')
    return dst


async def _mix_to_ogg(src_paths: list[Path], dst: Path) -> Path:
    """Sum multiple stems into a single OGG using ffmpeg's amix filter.

    `normalize=0` keeps the natural relative levels of each stem instead of
    dividing by N (which would make the result very quiet). Stems for a single
    song are typically already balanced, so straight summation is the right
    default — at the small risk of clipping when several loud stems align.
    """
    if not src_paths:
        raise RuntimeError('No stems provided to mix')
    n = len(src_paths)
    cmd: list[str] = ['ffmpeg', '-y']
    for p in src_paths:
        cmd.extend(['-i', str(p)])
    cmd.extend([
        '-filter_complex', f'amix=inputs={n}:duration=longest:normalize=0',
        '-c:a', 'libvorbis', '-q:a', '6', str(dst),
    ])
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        msg = stderr.decode('utf-8', errors='replace').strip().splitlines()[-3:]
        raise RuntimeError(f'ffmpeg amix failed: {" ".join(msg)}')
    return dst


def _debug_env() -> str:
    import asyncio as _a

    loop = _a.get_event_loop_policy().__class__.__name__
    try:
        running = _a.get_running_loop().__class__.__name__
    except RuntimeError:
        running = '(no running loop)'
    return f'policy={loop} running={running}'


async def _stream_demucs(
    audio_path: str,
    output_dir: str,
    model: str,
    output_format: str,
    mp3_bitrate: int,
    shifts: int,
    two_stems: str | None,
    segment: int | None,
    overlap: float,
    clip_mode: str,
    jobs: int,
    progress_callback,
    set_process=None,
) -> int:
    """Run demucs as an async subprocess, streaming stderr in real time."""
    cmd = [
        sys.executable, '-u', '-m', 'demucs',
        '--name', model,
        '--out', output_dir,
        '--shifts', str(shifts),
        '--overlap', str(overlap),
        '--clip-mode', clip_mode,
        '-j', str(jobs),
    ]

    if segment is not None:
        cmd += ['--segment', str(segment)]

    if two_stems:
        cmd += ['--two-stems', two_stems]

    if output_format == 'mp3':
        cmd += ['--mp3', '--mp3-bitrate', str(mp3_bitrate)]
    elif output_format == 'flac':
        cmd += ['--flac']

    cmd.append(audio_path)

    if progress_callback:
        await progress_callback('demucs', 8, f'$ {" ".join(Path(c).name if "/" in c or "\\\\" in c else c for c in cmd)}')

    import os as _os

    child_env = {**_os.environ, 'PYTHONUNBUFFERED': '1', 'PYTHONIOENCODING': 'utf-8'}
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=child_env,
        )
    except NotImplementedError as e:
        raise RuntimeError(
            f'asyncio subprocess not supported on this event loop ({_debug_env()}). '
            f'Start the server via run.py so the Windows Proactor policy is set.'
        ) from e
    if set_process is not None:
        set_process(proc)

    stderr_lines: list[str] = []
    state = {
        'bag_size': 1,
        'total_passes': max(1, shifts),
        'current_pass': 1,
        'last_pct': -1,
    }

    async def _read_stream(stream: asyncio.StreamReader):
        buf = ''
        while True:
            chunk = await stream.read(256)
            if not chunk:
                break
            buf += chunk.decode('utf-8', errors='replace')
            # Split on newlines and carriage returns (tqdm uses \r)
            while '\n' in buf or '\r' in buf:
                line, _, buf = buf.partition('\n') if '\n' in buf else buf.partition('\r')
                line = line.strip()
                if not line:
                    continue
                stderr_lines.append(line)

                # Pick up model bag size so we can compute total passes accurately
                bag_m = _BAG_RE.search(line)
                if bag_m:
                    state['bag_size'] = max(1, int(bag_m.group(1)))
                    state['total_passes'] = max(1, shifts) * state['bag_size']

                if progress_callback:
                    m = _PROGRESS_RE.search(line)
                    if m:
                        pct = int(m.group(1))
                        if pct < state['last_pct']:
                            state['current_pass'] = min(state['total_passes'], state['current_pass'] + 1)
                        state['last_pct'] = pct
                        overall_fraction = ((state['current_pass'] - 1) + pct / 100) / state['total_passes']
                        overall_pct = int(overall_fraction * 100)
                        mapped = 10 + int(overall_fraction * 75)  # 10–85 band on the UI bar
                        msg = (
                            f'Pass {state["current_pass"]}/{state["total_passes"]} '
                            f'({pct}% of pass) — {overall_pct}% overall'
                        )
                        await progress_callback('demucs', mapped, msg)
                    else:
                        await progress_callback('log', -1, line)
        # Flush remaining buffer
        if buf.strip():
            stderr_lines.append(buf.strip())
            if progress_callback:
                await progress_callback('log', -1, buf.strip())

    # Read stdout too (usually empty, but capture it)
    async def _drain_stdout(stream: asyncio.StreamReader):
        while True:
            chunk = await stream.read(4096)
            if not chunk:
                break
            for line in chunk.decode('utf-8', errors='replace').splitlines():
                line = line.strip()
                if line and progress_callback:
                    await progress_callback('log', -1, line)

    await asyncio.gather(
        _read_stream(proc.stderr),
        _drain_stdout(proc.stdout),
    )
    returncode = await proc.wait()

    if returncode != 0:
        tail = '\n'.join(stderr_lines[-10:])
        raise RuntimeError(f'Demucs failed (exit {returncode}):\n{tail}')

    return returncode


async def separate_stems(
    audio_path: str,
    output_dir: str,
    model: str = DEFAULT_MODEL,
    stems: list[str] | None = None,
    output_format: str = 'mp3',
    mp3_bitrate: int = 320,
    shifts: int = 1,
    two_stems: str | None = None,
    segment: int | None = None,
    overlap: float = 0.25,
    clip_mode: str = 'rescale',
    jobs: int = 0,
    game_ready: bool = False,
    progress_callback=None,
    set_process=None,
) -> dict:
    """Run Demucs to split audio into stems."""
    audio = Path(audio_path)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    available = MODEL_STEMS.get(model, MODEL_STEMS[DEFAULT_MODEL])
    if stems is None:
        stems = available

    # Game-ready mode: run Demucs as wav, then convert to ogg and rename
    demucs_format = 'wav' if game_ready else output_format
    final_format = 'ogg' if game_ready else output_format

    if progress_callback:
        mode_label = ' | Mode: Game-ready (Jamsesh Quest)' if game_ready else ''
        await progress_callback('init', 2, f'Model: {model} | Format: {final_format} | Shifts: {shifts}{mode_label}')
        await progress_callback('init', 5, f'Stems requested: {", ".join(stems)}')

    await _stream_demucs(
        str(audio), str(out), model, demucs_format, mp3_bitrate,
        shifts, two_stems, segment, overlap, clip_mode, jobs,
        progress_callback,
        set_process=set_process,
    )

    if progress_callback:
        await progress_callback('collect', 86, 'Collecting stem files...')

    # Demucs outputs to: <out>/<model_name>/<track_name>/<stem>.<ext>
    track_name = audio.stem
    demucs_dir = out / model / track_name

    if not demucs_dir.exists():
        demucs_dir = out / track_name
        if not demucs_dir.exists():
            raise RuntimeError(f'Demucs output not found at {out / model / track_name}')

    ext_map = {'mp3': '.mp3', 'flac': '.flac', 'wav': '.wav'}
    demucs_ext = ext_map.get(demucs_format, '.wav')

    # Collect requested stems, move to output root
    stem_files = {}
    for stem in stems:
        src = demucs_dir / f'{stem}{demucs_ext}'
        if not src.exists():
            src = demucs_dir / f'no_{stem}{demucs_ext}'
        if src.exists():
            dst = out / src.name
            shutil.move(str(src), str(dst))
            stem_files[stem] = dst.name

    # If two_stems mode, also grab the "no_" counterpart
    if two_stems:
        no_stem = f'no_{two_stems}'
        src = demucs_dir / f'{no_stem}{demucs_ext}'
        if src.exists():
            dst = out / src.name
            shutil.move(str(src), str(dst))
            stem_files[no_stem] = dst.name

    # Clean up demucs intermediate directories
    model_dir = out / model
    if model_dir.exists():
        shutil.rmtree(model_dir, ignore_errors=True)

    # Game-ready post-processing: rename stems + convert to ogg
    if game_ready:
        stems_to_convert = list(stem_files.items())
        total_stems = len(stems_to_convert)
        if progress_callback:
            await progress_callback('convert', 88, f'Converting {total_stems} stems to OGG...')

        game_stems = {}
        for idx, (demucs_name, filename) in enumerate(stems_to_convert, 1):
            game_name = DEMUCS_TO_GAME.get(demucs_name, demucs_name)
            if progress_callback:
                pct = 88 + int(5 * idx / total_stems)
                await progress_callback('convert', pct, f'Converting stem {idx}/{total_stems} → {game_name}.ogg')
            src_path = out / filename
            ogg_path = out / f'{game_name}.ogg'
            await _convert_to_ogg(src_path, ogg_path, progress_callback)
            src_path.unlink(missing_ok=True)
            game_stems[game_name] = ogg_path.name

        # Convert the original audio to song.ogg (full mix)
        if progress_callback:
            await progress_callback('convert', 93, 'Converting original audio → song.ogg (full mix)')
        song_ogg = out / 'song.ogg'
        await _convert_to_ogg(audio, song_ogg, progress_callback)
        game_stems['song'] = 'song.ogg'

        stem_files = game_stems
        output_format = 'ogg'

    if progress_callback:
        stem_list = ', '.join(f'{k} ({v})' for k, v in stem_files.items())
        await progress_callback('done', 95, f'Stems ready: {stem_list}')

    return {
        'stems': stem_files,
        'track_name': track_name,
        'model': model,
        'output_format': output_format,
        'game_ready': game_ready,
    }
