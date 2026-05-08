"""Generate a synthetic tutorial track + beatmap end-to-end.

For the Unity dev to test all logic without manual authoring:
  - Silent placeholder song.ogg (180s, 120 BPM)
  - Every onboard_* scene event from SCENE_EVENT_CATALOG distributed across
    the timeline so the show controller hits all known cue types
  - [TutorialScript] with VO + STEP events; each VO is synthesized by
    ElevenLabs into vo/*.ogg using whatever voice the account has first
  - [ExpertSingle] notes covering: singles on every lane, all chord pairs,
    short + long sustains, an open note, an open with sustain, a HOPO
    modifier, and a tap modifier

Run from the repo root:
  cd web/backend && python -m scripts.generate_test_tutorial

Prints the track_id, beatmap_id, and editor URL on success.
"""
from __future__ import annotations

import asyncio
import shutil
import sys
import tempfile
import uuid
from pathlib import Path

# Allow `python -m scripts.generate_test_tutorial` from web/backend.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import settings  # noqa: E402
from app.services import elevenlabs_client  # noqa: E402
from app.services.tracks import add_beatmap_record, create_track  # noqa: E402

# ── Constants ───────────────────────────────────────────────────────────────
RESOLUTION = 192
BPM = 120
DURATION_SECONDS = 180
TICKS_PER_SECOND = (BPM * RESOLUTION) / 60  # 384
TOTAL_TICKS = int(DURATION_SECONDS * TICKS_PER_SECOND)

NAME = 'Tutorial Test Bench'
ARTIST = 'Jamsesh QA'

# Mirror SCENE_EVENT_CATALOG from web/frontend/src/components/sceneEvents.ts.
# Each entry: (name, accepts_duration). We scatter every name; entries that
# accept duration get a 768-tick (1 measure) span so the renderer exercises
# both the instantaneous and ranged code paths.
SCENE_EVENTS = [
    # Controllers L
    ('onboard_L', True),
    ('onboard_L_rotate', True),
    ('onboard_L_primary', True),
    ('onboard_L_secondary', True),
    ('onboard_L_menu', True),
    ('onboard_L_trigger', True),
    ('onboard_L_grip', True),
    ('onboard_L_thumbstick', True),
    ('onboard_L_stickclick', True),
    # Controllers R
    ('onboard_R', True),
    ('onboard_R_rotate', True),
    ('onboard_R_primary', True),
    ('onboard_R_secondary', True),
    ('onboard_R_menu', True),
    ('onboard_R_trigger', True),
    ('onboard_R_grip', True),
    ('onboard_R_thumbstick', True),
    ('onboard_R_stickclick', True),
    # Hand
    ('onboard_handindicator_show', True),
    ('onboard_handindicator_hide', False),
    ('onboard_handindicator_flash', False),
    # Highway
    ('onboard_highway_show', True),
    ('onboard_highway_hide', False),
    # Beatline
    ('onboard_beatline_show', True),
    ('onboard_beatline_hide', False),
    ('onboard_beatline_flash', False),
    ('onboard_beatline_showsequence', True),
    ('onboard_beatline_hidesequence', False),
    # Misc
    ('onboard_controllerfretslide', True),
]

# Tutorial VO + STEP sequence. (kind, tick, payload). Ticks are 192/beat;
# 768 = 1 measure at 4/4. The script paces ~3 minutes so VO clips have time
# to play without overlapping.
TUTORIAL_LINES = [
    ('vo',   384,   'tut_intro',     'Welcome to the JamSesh tutorial test bench. Get ready to play.'),
    ('step', 2304,  'intro',         {'required': 0, 'timing': 'any', 'next': 'warmup'}),
    ('vo',   2688,  'tut_singles',   'Hit each single note as it crosses the strike line.'),
    ('step', 7680,  'warmup',        {'required': 5, 'timing': 'any', 'next': 'chords'}),
    ('vo',   8064,  'tut_chords',    'Now try chord shapes. Press both notes together.'),
    ('step', 13056, 'chords',        {'required': 4, 'timing': 'any', 'next': 'sustains'}),
    ('vo',   13440, 'tut_sustains',  'Hold sustains for the full length of the tail.'),
    ('step', 18432, 'sustains',      {'required': 2, 'timing': 'any', 'next': 'opens'}),
    ('vo',   18816, 'tut_opens',     'Open notes are full-width strums. Strum without holding any fret.'),
    ('step', 23808, 'opens',         {'required': 2, 'timing': 'any', 'next': 'flags'}),
    ('vo',   24192, 'tut_flags',     'Force HOPO and tap notes require different inputs from regular notes.'),
    ('step', 29184, 'flags',         {'required': 4, 'timing': 'perfect', 'next': 'ending'}),
    ('vo',   29568, 'tut_outro',     'Great work. Tutorial complete.'),
    ('step', 32256, 'ending',        {'required': 0, 'timing': 'any', 'next': ''}),
]


def build_chart_text(vo_offsets: dict[str, tuple[int, int]]) -> str:
    """Compose the .chart text including [Song], [SyncTrack], [Events],
    [ExpertSingle], and [TutorialScript].

    vo_offsets: slug -> (start_ms, duration_ms) inside vo/tutorial.ogg.
    """
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

    # [Events]: one onboard_* event per measure (768 ticks). Wrap if we run
    # out of timeline. Each ranged event lasts one measure.
    event_lines = []
    section_lines = [
        '  192 = E "section Intro"',
        '  7680 = E "section Singles drill"',
        '  13056 = E "section Chord drill"',
        '  18432 = E "section Sustain drill"',
        '  23808 = E "section Open notes"',
        '  29184 = E "section HOPO and tap"',
        '  32256 = E "section Outro"',
    ]
    base_tick = 768  # start at measure 1 so the intro VO has clear air
    spacing = 768    # one event per measure
    for i, (name, accepts_duration) in enumerate(SCENE_EVENTS):
        tick = base_tick + i * spacing
        if tick >= TOTAL_TICKS - spacing:
            break
        if accepts_duration:
            event_lines.append(f'  {tick} = E "{name} 384"')  # 2 beats
        else:
            event_lines.append(f'  {tick} = E "{name}"')
    # Stack a few overlapping cues near the end to exercise concurrent
    # rendering paths.
    overlap_tick = base_tick + len(SCENE_EVENTS) * spacing + 768
    for i, (name, _) in enumerate(SCENE_EVENTS[:5]):
        event_lines.append(f'  {overlap_tick + i * 96} = E "{name} 192"')

    all_event_lines = sorted(
        section_lines + event_lines,
        key=lambda s: int(s.strip().split('=')[0].strip()),
    )
    lines.append('[Events]')
    lines.append('{')
    lines.extend(all_event_lines)
    lines.append('}')

    # [ExpertSingle]: every gem type the editor supports.
    note_lines = build_note_lines()
    lines.append('[ExpertSingle]')
    lines.append('{')
    lines.extend(note_lines)
    lines.append('}')

    # [TutorialScript]: VO + STEP entries. VO entries point into a single
    # collated vo/tutorial.ogg with start_ms / duration_ms offsets so the
    # engine plays from the right slice without juggling N audio handles.
    lines.append('[TutorialScript]')
    lines.append('{')
    for entry in TUTORIAL_LINES:
        kind, tick = entry[0], entry[1]
        if kind == 'vo':
            slug = entry[2]
            text = entry[3].replace('"', "'")
            offsets = vo_offsets.get(slug)
            if offsets is None:
                # Fall back to whole-file playback if probing failed.
                lines.append(
                    f'  {tick} = VO "vo/tutorial.ogg" text="{text}" engine=elevenlabs voice=""'
                )
            else:
                start_ms, duration_ms = offsets
                lines.append(
                    f'  {tick} = VO "vo/tutorial.ogg" start_ms={start_ms} duration_ms={duration_ms} text="{text}" engine=elevenlabs voice=""'
                )
        elif kind == 'step':
            step_id = entry[2]
            fields = entry[3]
            req = fields.get('required', 0)
            timing = fields.get('timing', 'any')
            nxt = fields.get('next', '')
            tail = f'"{step_id}" required={req} timing={timing}'
            if nxt:
                tail += f' next="{nxt}"'
            lines.append(f'  {tick} = STEP {tail}')
    lines.append('}')

    return '\n'.join(lines) + '\n'


def build_note_lines() -> list[str]:
    """Pack every gem type into the singles drill window (7680..13056) and
    the chord/sustain/open windows."""
    notes: list[tuple[int, int, int]] = []  # (tick, lane, sustain)

    # Singles drill: one note per lane, on the beat (7680, +192, +192, ...)
    base = 7680
    for i, lane in enumerate([0, 1, 2, 3, 4, 0, 2, 4, 1, 3]):
        notes.append((base + i * 384, lane, 0))

    # Chord drill (13056..18432): all four adjacent chord pairs.
    base = 13056
    pairs = [(0, 1), (1, 2), (2, 3), (3, 4)]
    for i, (a, b) in enumerate(pairs):
        tick = base + i * 1536
        notes.append((tick, a, 0))
        notes.append((tick, b, 0))

    # Sustain drill (18432..23808): two short, two long.
    base = 18432
    notes.append((base + 0,    0, 384))    # 2-beat sustain
    notes.append((base + 1536, 2, 768))    # 4-beat sustain
    notes.append((base + 3072, 4, 1536))   # 8-beat sustain

    # Open notes drill (23808..29184): one bare open, one open with sustain.
    base = 23808
    notes.append((base + 0,    7, 0))      # bare open
    notes.append((base + 1536, 7, 768))    # open with 4-beat sustain
    notes.append((base + 3072, 7, 0))      # bare open
    notes.append((base + 4608, 7, 384))    # open with 2-beat sustain

    # HOPO + tap drill (29184..32256): a HOPO chord, a tap chord, and a
    # mixed cluster with both flags.
    base = 29184
    # HOPO chord at base: green + red, with HOPO flag (lane 5)
    notes.append((base, 0, 0))
    notes.append((base, 1, 0))
    notes.append((base, 5, 0))  # HOPO flag

    # Tap chord at base+768
    notes.append((base + 768, 2, 0))
    notes.append((base + 768, 3, 0))
    notes.append((base + 768, 6, 0))  # tap flag

    # Both flags at base+1536 — exercises the case where an engine has to
    # decide which flag wins (Moonscraper convention: tap dominates).
    notes.append((base + 1536, 4, 0))
    notes.append((base + 1536, 5, 0))
    notes.append((base + 1536, 6, 0))

    # Sort and emit
    notes.sort(key=lambda t: (t[0], t[1]))
    return [f'  {tick} = N {lane} {sustain}' for (tick, lane, sustain) in notes]


VO_GAP_MS = 250  # silence between clips so cues don't bleed into each other


async def _probe_duration_ms(path: Path) -> int:
    """Use ffprobe to read a clip's exact duration (ms). Falls back to 0
    on probe failure so the caller can still build the chart."""
    proc = await asyncio.create_subprocess_exec(
        'ffprobe', '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        str(path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    if proc.returncode != 0:
        return 0
    try:
        seconds = float(stdout.decode('utf-8', errors='replace').strip())
        return max(0, int(round(seconds * 1000)))
    except ValueError:
        return 0


async def synth_collated_vo(beatmap_dir: Path, voice_id: str) -> dict[str, tuple[int, int]]:
    """Synthesize every VO line, then concat them with VO_GAP_MS silence
    padding into a single beatmap_dir/vo/tutorial.ogg. Returns a mapping
    slug -> (start_ms, duration_ms) so the chart builder can emit accurate
    offsets. The intermediate per-clip files are deleted after concat.
    """
    vo_dir = beatmap_dir / 'vo'
    vo_dir.mkdir(parents=True, exist_ok=True)
    vo_lines = [e for e in TUTORIAL_LINES if e[0] == 'vo']

    # 1. Synthesize each clip to its own temp file inside vo_dir.
    clip_paths: list[Path] = []
    clip_durations_ms: list[int] = []
    for entry in vo_lines:
        slug = entry[2]
        text = entry[3]
        clip = vo_dir / f'_{slug}.ogg'
        print(f'  - synthesizing {slug} -> _{slug}.ogg ({len(text)} chars)')
        await elevenlabs_client.synth_to_ogg(text, voice_id, clip)
        dur_ms = await _probe_duration_ms(clip)
        clip_paths.append(clip)
        clip_durations_ms.append(dur_ms)

    # 2. Compute offsets within the final collated file. Each clip starts
    #    at the running offset; a VO_GAP_MS silence follows each clip
    #    (except the last) so cues don't crossfade.
    offsets: dict[str, tuple[int, int]] = {}
    cursor_ms = 0
    for entry, dur_ms in zip(vo_lines, clip_durations_ms):
        slug = entry[2]
        offsets[slug] = (cursor_ms, dur_ms)
        cursor_ms += dur_ms + VO_GAP_MS

    # 3. Build a silence file once, then assemble a concat list ordering
    #    [clip, silence, clip, silence, ..., clip].
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
        # ffmpeg concat demuxer wants forward slashes + a single-quoted path
        # so spaces survive. Our paths are temp-dir-scoped so safe.
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

    print(f'  - collated {len(clip_paths)} clips -> tutorial.ogg ({out_path.stat().st_size} bytes)')

    # 4. Drop the intermediate per-clip files + concat list + silence.
    for clip in clip_paths:
        clip.unlink(missing_ok=True)
    silence.unlink(missing_ok=True)
    concat_list.unlink(missing_ok=True)

    return offsets


async def main() -> None:
    print('JamSesh test-tutorial generator')
    print('================================')

    # 1. Resolve voice (first voice on the account, or fall back to a known
    #    public voice).
    try:
        voices = await elevenlabs_client.list_voices()
        voice_list = voices.get('voices') or []
        if not voice_list:
            raise RuntimeError('ElevenLabs returned no voices')
        voice_id = voice_list[0]['voice_id']
        voice_name = voice_list[0].get('name', '?')
        print(f'using voice: {voice_name} ({voice_id})')
    except elevenlabs_client.NotConfiguredError as e:
        print(f'ERROR: {e}', file=sys.stderr)
        sys.exit(1)

    # 2. Stage everything in a temp dir so partial failures don't leave
    #    orphans in upload_dir.
    upload_dir = Path(settings.upload_dir)
    upload_dir.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='gen_test_tut_', dir=str(upload_dir)))
    try:
        # 3. Silent song.ogg — same approach the blank-tutorial endpoint uses.
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

        # 4. Persist as a Track in the library.
        track = create_track(
            name=NAME,
            stems={'song': 'song.ogg'},
            source_stems_dir=stems_src,
            model='manual',
            output_format='ogg',
            artist=ARTIST,
        )
        print(f'created track: {track.id}')

        # 5. Build beatmap directory: copy silent ogg, write notes.chart +
        #    song.ini, synthesize VOs.
        beatmap_id = uuid.uuid4().hex[:12]
        bm_src = staging / 'bm'
        bm_src.mkdir()
        shutil.copy2(silent_ogg, bm_src / 'song.ogg')

        # Collate every VO line into a single vo/tutorial.ogg before the
        # chart is written so we have accurate start_ms/duration_ms offsets
        # to embed in the [TutorialScript] entries.
        vo_offsets = await synth_collated_vo(bm_src, voice_id)

        chart_text = build_chart_text(vo_offsets)
        (bm_src / 'notes.chart').write_text(chart_text, encoding='utf-8')
        print(f'notes.chart: {len(chart_text)} chars, {chart_text.count(chr(10))} lines')

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
            'loading_phrase = Test bench tutorial',
            '',
            '[onboarding]',
            'onboarding = True',
        ]) + '\n'
        (bm_src / 'song.ini').write_text(ini_text, encoding='utf-8')

        # 6. Register the beatmap and copy the folder into track storage.
        add_beatmap_record(
            track_id=track.id,
            beatmap_id=beatmap_id,
            stem='guitar',  # tutorial drives playback via [TutorialScript]
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
