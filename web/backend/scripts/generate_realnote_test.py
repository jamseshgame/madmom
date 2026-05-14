"""Generate the "Realnote Test v1" acid-test track for the Unity dev.

For every (pack, scale, slot) combination in the catalog, drop one R note in
the chart, with an ElevenLabs-synthesized VO before each (pack, scale)
section explaining what's coming. The Unity dev plays the song through and
hears every pre-rendered sample once, in a known order, with audible
spoken context.

Layout:
  - 8 packs × 4 scales = 32 sections
  - Each section: VO (~3s) + small gap + 10 R notes (1 per slot, 1s apart)
                  + small trailing gap → ~17s
  - Intro + outro VOs around the run.

Total song duration: ~9.5 min, silent backing track.

Run from web/backend/ with the venv active:
  python -m scripts.generate_realnote_test

Prints the editor URL on success.
"""
from __future__ import annotations

import asyncio
import shutil
import sys
import tempfile
import uuid
from pathlib import Path

# Allow `python -m scripts.generate_realnote_test` from web/backend.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Force stdout to UTF-8 so our print()s with arrows / ellipses don't blow up
# on the Windows CP-1252 console codepage.
try:
    sys.stdout.reconfigure(encoding='utf-8')  # Python 3.7+
    sys.stderr.reconfigure(encoding='utf-8')
except AttributeError:
    pass

from app.config import settings  # noqa: E402
from app.services import sample_packs, tts  # noqa: E402
from app.services.tracks import add_beatmap_record, create_track  # noqa: E402

# ── Constants ───────────────────────────────────────────────────────────────
NAME = 'Realnote Test v1'
ARTIST = 'Jamsesh QA'
RESOLUTION = 192
BPM = 120
TICKS_PER_SECOND = (BPM * RESOLUTION) / 60  # 384

# Pacing (seconds). Each (pack, scale) section runs:
#   [VO_LEN_SEC | GAP_AFTER_VO_SEC | 10 × NOTE_GAP_SEC | TRAILING_GAP_SEC]
VO_LEN_SEC = 4
GAP_AFTER_VO_SEC = 1
NOTE_GAP_SEC = 1
TRAILING_GAP_SEC = 2
SECTION_LEN_SEC = VO_LEN_SEC + GAP_AFTER_VO_SEC + 10 * NOTE_GAP_SEC + TRAILING_GAP_SEC  # 17s

INTRO_LEN_SEC = 6   # intro VO + breath
OUTRO_LEN_SEC = 6   # outro VO + tail silence

# Pass-gate config for the section STEPs. Player must hit every slot in the
# section (one note per slot, 10 slots = 10 hits) before the engine advances.
# Intro / outro STEPs stay at required=0 (transport markers only).
REQUIRED_PER_SECTION = 10

# Retry clip lives inside the collated tutorial.ogg as a named slice (slug =
# RETRY_SLUG) so future retry-VO variants can be appended alongside section
# VOs. Each STEP's retry_vo field references the collated file plus the
# slug's (start_ms, duration_ms) offsets resolved at chart-emit time.
RETRY_VO_TEXT = "Oops, let's try that again."
RETRY_SLUG = 'retry'
TUTORIAL_OGG_REL = 'vo/tutorial.ogg'

# Slot → playable lanes. Mirrors SLOT_ORDER in services/sample_packs.py.
# Each entry tells the chart-emitter which lane(s) to drop at the slot's
# beat: single notes for lane_*, two-lane chords for chord_*, lane 7 for
# open. The game derives the same slot back from the lanes when firing the
# sample (single → lane_x, two adjacent → chord_xy, lane 7 → open).
SLOT_TO_LANES: list[tuple[str, list[int]]] = [
    ('lane_1',   [0]),
    ('lane_2',   [1]),
    ('lane_3',   [2]),
    ('lane_4',   [3]),
    ('lane_5',   [4]),
    ('chord_12', [0, 1]),
    ('chord_23', [1, 2]),
    ('chord_34', [2, 3]),
    ('chord_45', [3, 4]),
    ('open',     [7]),
]

# Iterate by pack-major: easier to listen to a single instrument timbre
# across all four scales before switching instruments.
PACK_ORDER = list(sample_packs.PACKS.keys())
SCALE_ORDER = list(sample_packs.SCALES.keys())

NUM_SECTIONS = len(PACK_ORDER) * len(SCALE_ORDER)
DURATION_SECONDS = INTRO_LEN_SEC + NUM_SECTIONS * SECTION_LEN_SEC + OUTRO_LEN_SEC


def _t(seconds: float) -> int:
    """Convert seconds to ticks, rounded to the nearest integer."""
    return int(round(seconds * TICKS_PER_SECOND))


def _section_start_sec(idx: int) -> float:
    return INTRO_LEN_SEC + idx * SECTION_LEN_SEC


def _scale_pretty(scale_id: str) -> str:
    """Pull the short ABCD-style scale name out of the catalog entry's full
    name, e.g. 'C major pentatonic (2 octaves)' → 'C major pentatonic'."""
    name = sample_packs.SCALES[scale_id].name
    return name.split(' (')[0]


def build_tutorial_lines() -> list[tuple]:
    """Compose the (kind, tick, slug, payload) sequence for [TutorialScript].

    Includes one VO per section + an intro + outro VO, and a STEP marker per
    section so the engine can paginate through them. STEPs are
    `required=0, timing=any` so they don't gate progress — the test bench is
    a play-through, not a pass-fail drill.
    """
    lines: list[tuple] = []

    # Intro at tick ~half a second so the first VO has clean air before it.
    lines.append((
        'vo', _t(0.5), 'tut_intro',
        'Realnote acid test, version one. Every pack and progression. Listen for slot order: lane one through five, then chord pairs, then open.',
    ))
    lines.append((
        'step', _t(0.5), 'intro_step',
        {'required': 0, 'timing': 'any', 'next': 'sec_0'},
    ))

    for pack_idx, pack_id in enumerate(PACK_ORDER):
        for scale_idx, scale_id in enumerate(SCALE_ORDER):
            section_idx = pack_idx * len(SCALE_ORDER) + scale_idx
            sec_start = _section_start_sec(section_idx)
            tick = _t(sec_start)
            pack_name = sample_packs.PACKS[pack_id].name
            scale_name = _scale_pretty(scale_id)
            slug = f'sec_{section_idx}'
            text = f'{pack_name}. {scale_name}.'
            lines.append(('vo', tick, slug, text))
            next_step = (
                f'sec_{section_idx + 1}'
                if section_idx + 1 < NUM_SECTIONS
                else 'outro_step'
            )
            lines.append((
                'step', tick, slug,
                {
                    'required': REQUIRED_PER_SECTION,
                    'timing': 'any',
                    'retry_vo': TUTORIAL_OGG_REL,
                    'retry_vo_slug': RETRY_SLUG,
                    'next': next_step,
                },
            ))

    # Outro VO ~1s into the trailing window so it lands after the last note.
    outro_tick = _t(INTRO_LEN_SEC + NUM_SECTIONS * SECTION_LEN_SEC + 1)
    lines.append((
        'vo', outro_tick, 'tut_outro',
        'End of realnote acid test.',
    ))
    lines.append((
        'step', outro_tick, 'outro_step',
        {'required': 0, 'timing': 'any', 'next': ''},
    ))
    return lines


def build_note_lines() -> list[str]:
    """Emit the [ExpertSingle] body: one R note per slot per (pack, scale).

    Each section emits an `E realnotes_pack` and `E realnotes_scale` event
    at the first R-note's tick, so the editor + game's state-machine pick
    up the right combo before any R note fires.
    """
    out: list[str] = []
    for pack_idx, pack_id in enumerate(PACK_ORDER):
        for scale_idx, scale_id in enumerate(SCALE_ORDER):
            section_idx = pack_idx * len(SCALE_ORDER) + scale_idx
            sec_start = _section_start_sec(section_idx)
            first_note_sec = sec_start + VO_LEN_SEC + GAP_AFTER_VO_SEC
            first_tick = _t(first_note_sec)
            # Pack/scale declarations at the first R note's tick.
            out.append(f'  {first_tick} = E realnotes_pack {pack_id}')
            out.append(f'  {first_tick} = E realnotes_scale {scale_id}')
            # 10 R notes (one per slot), 1 second apart.
            for slot_idx, (_slot_name, lanes) in enumerate(SLOT_TO_LANES):
                tick = _t(first_note_sec + slot_idx * NOTE_GAP_SEC)
                for lane in lanes:
                    out.append(f'  {tick} = R {lane} 0')
    # Sort by tick (E events at the same tick as their R notes; sort is
    # stable by source order within a tick, so the prelude stays first).
    out.sort(key=lambda s: int(s.strip().split('=')[0].strip()))
    return out


def build_chart_text(vo_offsets: dict[str, tuple[int, int]]) -> str:
    bpm_milli = int(BPM * 1000)
    lines: list[str] = []

    lines += [
        '[Song]', '{',
        f'  Name = "{NAME}"',
        f'  Artist = "{ARTIST}"',
        '  Charter = "Jamsesh QA"',
        '  Offset = 0',
        f'  Resolution = {RESOLUTION}',
        '  Player2 = bass',
        '  Difficulty = 0',
        '  PreviewStart = 0',
        '  PreviewEnd = 0',
        '  Genre = "tutorial"',
        '  MediaType = "cd"',
        '  MusicStream = "song.ogg"',
        '}',
    ]

    lines += [
        '[SyncTrack]', '{',
        '  0 = TS 4',
        f'  0 = B {bpm_milli}',
        '}',
    ]

    # [Events]: section markers so the timeline is readable in the editor.
    lines.append('[Events]')
    lines.append('{')
    lines.append('  0 = E "section Intro"')
    for pack_idx, pack_id in enumerate(PACK_ORDER):
        for scale_idx, scale_id in enumerate(SCALE_ORDER):
            section_idx = pack_idx * len(SCALE_ORDER) + scale_idx
            tick = _t(_section_start_sec(section_idx))
            label = f'{pack_id} / {scale_id}'.replace('"', "'")
            lines.append(f'  {tick} = E "section {label}"')
    outro_tick = _t(INTRO_LEN_SEC + NUM_SECTIONS * SECTION_LEN_SEC)
    lines.append(f'  {outro_tick} = E "section Outro"')
    lines.append('}')

    # [ExpertSingle]: every (pack, scale, slot) tuple as R notes + E events.
    note_lines = build_note_lines()
    lines.append('[ExpertSingle]')
    lines.append('{')
    lines.extend(note_lines)
    lines.append('}')

    # [TutorialScript]: collated VO + STEP entries.
    tutorial_lines = build_tutorial_lines()
    lines.append('[TutorialScript]')
    lines.append('{')
    for entry in tutorial_lines:
        kind, tick = entry[0], entry[1]
        if kind == 'vo':
            slug, text = entry[2], entry[3].replace('"', "'")
            offsets = vo_offsets.get(slug)
            if offsets is None:
                lines.append(
                    f'  {tick} = VO "vo/tutorial.ogg" text="{text}" engine=chatterbox voice=""'
                )
            else:
                start_ms, duration_ms = offsets
                lines.append(
                    f'  {tick} = VO "vo/tutorial.ogg" start_ms={start_ms} duration_ms={duration_ms} text="{text}" engine=chatterbox voice=""'
                )
        elif kind == 'step':
            step_id = entry[2]
            fields = entry[3]
            req = fields.get('required', 0)
            timing = fields.get('timing', 'any')
            retry_vo = fields.get('retry_vo', '')
            retry_slug = fields.get('retry_vo_slug', '')
            nxt = fields.get('next', '')
            tail = f'"{step_id}" required={req} timing={timing}'
            if retry_vo:
                tail += f' retry_vo="{retry_vo}"'
                offsets = vo_offsets.get(retry_slug) if retry_slug else None
                if offsets:
                    start_ms, dur_ms = offsets
                    tail += f' retry_start_ms={start_ms} retry_duration_ms={dur_ms}'
            if nxt:
                tail += f' next="{nxt}"'
            lines.append(f'  {tick} = STEP {tail}')
    lines.append('}')

    return '\n'.join(lines) + '\n'


VO_GAP_MS = 250


async def _probe_duration_ms(path: Path) -> int:
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
        return max(0, int(round(float(stdout.decode('utf-8', errors='replace').strip()) * 1000)))
    except ValueError:
        return 0


async def synth_collated_vo(
    beatmap_dir: Path,
    tutorial_lines: list[tuple],
    extra_clips: list[tuple[str, str]] = (),
) -> dict[str, tuple[int, int]]:
    """Synthesize every VO line via Chatterbox (local, no API key), concat
    into vo/tutorial.ogg, return slug → (start_ms, duration_ms) offsets.

    `extra_clips` is a list of `(slug, text)` tuples that get appended to the
    collated file after the chart's tutorial VOs. These have no chart tick
    of their own — they're sliced playback targets for fields like a STEP's
    `retry_vo` or future retry variants.

    First call lazy-loads the ~3GB Chatterbox model — expect a few minutes
    delay on a fresh install while it downloads.
    """
    vo_dir = beatmap_dir / 'vo'
    vo_dir.mkdir(parents=True, exist_ok=True)
    tutorial_pairs: list[tuple[str, str]] = [
        (e[2], e[3]) for e in tutorial_lines if e[0] == 'vo'
    ]
    all_pairs: list[tuple[str, str]] = tutorial_pairs + list(extra_clips)

    clip_paths: list[Path] = []
    clip_durations_ms: list[int] = []
    for slug, text in all_pairs:
        clip = vo_dir / f'_{slug}.ogg'
        print(f'  - synthesizing {slug} ({len(text)} chars): "{text[:60]}{"…" if len(text) > 60 else ""}"')
        await tts.synth_async(text, clip)
        dur_ms = await _probe_duration_ms(clip)
        clip_paths.append(clip)
        clip_durations_ms.append(dur_ms)

    offsets: dict[str, tuple[int, int]] = {}
    cursor_ms = 0
    for (slug, _text), dur_ms in zip(all_pairs, clip_durations_ms):
        offsets[slug] = (cursor_ms, dur_ms)
        cursor_ms += dur_ms + VO_GAP_MS

    silence = vo_dir / '_gap.ogg'
    silence_seconds = VO_GAP_MS / 1000
    proc = await asyncio.create_subprocess_exec(
        'ffmpeg', '-y',
        '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
        '-t', f'{silence_seconds:.3f}',
        '-c:a', 'libvorbis', '-q:a', '3',
        str(silence),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f'ffmpeg silence gen failed: {err.decode("utf-8", errors="replace")[-300:]}')

    concat_list = vo_dir / '_concat.txt'
    concat_lines: list[str] = []
    for i, clip in enumerate(clip_paths):
        concat_lines.append(f"file '{clip.as_posix()}'")
        if i != len(clip_paths) - 1:
            concat_lines.append(f"file '{silence.as_posix()}'")
    concat_list.write_text('\n'.join(concat_lines) + '\n', encoding='utf-8')

    out_path = vo_dir / 'tutorial.ogg'
    proc = await asyncio.create_subprocess_exec(
        'ffmpeg', '-y',
        '-f', 'concat', '-safe', '0',
        '-i', str(concat_list),
        '-c:a', 'libvorbis', '-q:a', '4',
        str(out_path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f'ffmpeg concat failed: {err.decode("utf-8", errors="replace")[-400:]}')

    print(f'  - collated {len(clip_paths)} clips → tutorial.ogg ({out_path.stat().st_size} bytes, {cursor_ms/1000:.1f}s)')

    # Preserve the individual clips under vo/clips/<slug>.ogg so the
    # editor can re-edit per-VO after a round-trip through the game repo.
    # Unity clients consume tutorial.ogg + chart slice offsets and ignore
    # this directory entirely (see REALNOTES_SPEC.md).
    clips_dir = vo_dir / 'clips'
    clips_dir.mkdir(exist_ok=True)
    for (slug, _text), clip in zip(all_pairs, clip_paths):
        dest = clips_dir / f'{slug}.ogg'
        if dest.exists():
            dest.unlink()
        clip.rename(dest)
    silence.unlink(missing_ok=True)
    concat_list.unlink(missing_ok=True)

    return offsets


async def main() -> None:
    print('JamSesh realnote acid-test generator')
    print('=====================================')
    print(f'  duration: {DURATION_SECONDS}s ({DURATION_SECONDS/60:.1f} min)')
    print(f'  sections: {NUM_SECTIONS} ({len(PACK_ORDER)} packs × {len(SCALE_ORDER)} scales)')
    print(f'  R notes : {NUM_SECTIONS * sum(len(l) for _, l in SLOT_TO_LANES)}')
    print()

    print('VO engine: Chatterbox (local). First run downloads ~3GB model.')

    upload_dir = Path(settings.upload_dir)
    upload_dir.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='gen_realnote_test_', dir=str(upload_dir)))
    try:
        stems_src = staging / 'stems'
        stems_src.mkdir()
        silent_ogg = stems_src / 'song.ogg'
        proc = await asyncio.create_subprocess_exec(
            'ffmpeg', '-y',
            '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
            '-t', str(DURATION_SECONDS),
            '-c:a', 'libvorbis', '-q:a', '3',
            str(silent_ogg),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f'ffmpeg failed: {err.decode("utf-8", errors="replace")[-300:]}')
        print(f'silent song.ogg: {silent_ogg.stat().st_size} bytes')

        track = create_track(
            name=NAME,
            stems={'song': 'song.ogg'},
            source_stems_dir=stems_src,
            model='manual',
            output_format='ogg',
            artist=ARTIST,
        )
        print(f'created track: {track.id}')

        beatmap_id = uuid.uuid4().hex[:12]
        bm_src = staging / 'bm'
        bm_src.mkdir()
        shutil.copy2(silent_ogg, bm_src / 'song.ogg')

        tutorial_lines = build_tutorial_lines()
        # Pass retry as an "extra" so it lands in the collated tutorial.ogg
        # alongside the section VOs. STEP retry_vo refs then slice into that
        # file via retry_start_ms / retry_duration_ms. Future retry variants
        # are just additional entries in this list.
        extra_clips = [(RETRY_SLUG, RETRY_VO_TEXT)]
        vo_offsets = await synth_collated_vo(bm_src, tutorial_lines, extra_clips)

        chart_text = build_chart_text(vo_offsets)
        chart_target = bm_src / 'notes.chart'
        chart_target.write_text(chart_text, encoding='utf-8')
        print(f'notes.chart: {len(chart_text)} chars, {chart_text.count(chr(10))} lines')

        # Re-pace the chart based on actual VO durations so the section VOs
        # don't fire while the previous clip is still playing. The initial
        # write above uses a fixed-budget schedule that assumes every VO fits
        # in VO_LEN_SEC; reality varies (Chatterbox is 3–9s per clip), so we
        # walk the embedded duration_ms fields and recompute every tick.
        from scripts.fix_realnote_pacing import rebuild_chart_from_durations
        print('Re-pacing chart from actual VO durations…')
        rebuild_chart_from_durations(chart_target)

        ini_text = '\n'.join([
            '[song]',
            f'name = {NAME}',
            f'artist = {ARTIST}',
            'album = ',
            'genre = tutorial',
            'year = ',
            f'song_length = {DURATION_SECONDS * 1000}',
            'charter = Jamsesh QA',
            'preview_start_time = 0',
            'delay = 0',
            'loading_phrase = Realnote acid test',
            '',
            '[onboarding]',
            'onboarding = True',
        ]) + '\n'
        (bm_src / 'song.ini').write_text(ini_text, encoding='utf-8')

        add_beatmap_record(
            track_id=track.id,
            beatmap_id=beatmap_id,
            stem='song',
            folder_name=f'{ARTIST} - {NAME}',
            song_name=NAME,
            source_dir=bm_src,
        )

        print()
        print('SUCCESS')
        print(f'  track_id   = {track.id}')
        print(f'  beatmap_id = {beatmap_id}')
        print(f'  editor URL = /edit/{track.id}/{beatmap_id}')
        print(f'  beatmap dir on disk: {track.beatmaps_dir / beatmap_id}')
    finally:
        shutil.rmtree(staging, ignore_errors=True)


if __name__ == '__main__':
    asyncio.run(main())
