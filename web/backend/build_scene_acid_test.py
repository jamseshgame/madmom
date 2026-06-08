#!/usr/bin/env python3
"""One-shot builder for the "scene acid test v1" tutorial.

Creates a fresh track + one tutorial beatmap whose chart fires every built-in
scene event, each overlapping a matching VO clip for that clip's full duration.

Run ON the droplet (needs ffmpeg/ffprobe). Reads the 33 staged clips from
CLIPS_DIR (NN.mp3, 01..33 in scene-catalog order) and writes into TRACKS_DIR.

Idempotent-ish: pass --track-id / --beatmap-id to overwrite a prior run,
otherwise fresh random ids are minted and printed at the end.
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import time
import uuid
from pathlib import Path

TRACKS_DIR = Path('/var/lib/beatmap-uploads/_tracks')
CLIPS_DIR = Path('/tmp/acidtest_clips')

RESOLUTION = 192
BPM = 120  # → ticks_per_sec = RESOLUTION * BPM/60
TICKS_PER_SEC = RESOLUTION * BPM / 60.0  # 384
GAP_SEC = 1.5
GAP_TICKS = round(GAP_SEC * TICKS_PER_SEC)

# (scene_event_name, accepts_duration, script_line) in catalog order = clip order.
EVENTS: list[tuple[str, bool, str]] = [
    ('onboard_L', True, 'This is testing show left controller. The left controller should appear now.'),
    ('onboard_L_rotate', True, 'This is testing left controller rotate. The left controller should spin in place now.'),
    ('onboard_L_primary', True, 'This is testing the left primary button. The primary face button on the left controller should glow now.'),
    ('onboard_L_secondary', True, 'This is testing the left secondary button. The secondary face button on the left controller should glow now.'),
    ('onboard_L_menu', True, 'This is testing the left menu button. The menu button on the left controller should glow now.'),
    ('onboard_L_trigger', True, 'This is testing the left trigger. The trigger on the left controller should glow now.'),
    ('onboard_L_grip', True, 'This is testing the left grip. The grip on the left controller should glow now.'),
    ('onboard_L_thumbstick', True, 'This is testing the left thumbstick. The thumbstick on the left controller should glow now.'),
    ('onboard_L_stickclick', True, 'This is testing the left stick click. The thumbstick-click on the left controller should glow now.'),
    ('onboard_R', True, 'This is testing show right controller. The right controller should appear now.'),
    ('onboard_R_rotate', True, 'This is testing right controller rotate. The right controller should spin in place now.'),
    ('onboard_R_primary', True, 'This is testing the right primary button. The primary face button on the right controller should glow now.'),
    ('onboard_R_secondary', True, 'This is testing the right secondary button. The secondary face button on the right controller should glow now.'),
    ('onboard_R_menu', True, 'This is testing the right menu button. The menu button on the right controller should glow now.'),
    ('onboard_R_trigger', True, 'This is testing the right trigger. The trigger on the right controller should glow now.'),
    ('onboard_R_grip', True, 'This is testing the right grip. The grip on the right controller should glow now.'),
    ('onboard_R_thumbstick', True, 'This is testing the right thumbstick. The thumbstick on the right controller should glow now.'),
    ('onboard_R_stickclick', True, 'This is testing the right stick click. The thumbstick-click on the right controller should glow now.'),
    ('onboard_handindicator_show', True, 'This is testing show hand indicator. The hand-position indicator should appear now.'),
    ('onboard_handindicator_hide', False, 'This is testing hide hand indicator. The hand-position indicator should disappear now.'),
    ('onboard_handindicator_flash', False, 'This is testing the hand indicator flash. The hand indicator should flash once now.'),
    ('onboard_highway_show', True, 'This is testing show highway. The note highway should come into view now.'),
    ('onboard_highway_hide', False, 'This is testing hide highway. The note highway should disappear now.'),
    ('onboard_beatline_show', True, 'This is testing show beatline. The strike line should appear at the bottom of the highway now.'),
    ('onboard_beatline_hide', False, 'This is testing hide beatline. The strike line should disappear now.'),
    ('onboard_beatline_flash', False, 'This is testing the beatline flash. The strike line should flash once on the beat now.'),
    ('onboard_beatline_showsequence', True, 'This is testing the beatline sequence. The strike line should start pulsing in time with the music now.'),
    ('onboard_beatline_hidesequence', False, 'This is testing hide beatline sequence. The strike-line pulsing should stop now.'),
    ('onboard_floorcrowd', True, 'This is testing the floor crowd. The audience on the floor should cheer and move now.'),
    ('onboard_lasers_center', True, 'This is testing the center lasers. The center laser bank should switch on now.'),
    ('onboard_lasers_left', True, 'This is testing the left lasers. The left laser bank should switch on now.'),
    ('onboard_lasers_right', True, 'This is testing the right lasers. The right laser bank should switch on now.'),
    ('onboard_controllerfretslide', True, 'This is testing the controller fret slide. The controller should demonstrate a slide between fret positions now.'),
]


def probe_duration(path: Path) -> float:
    out = subprocess.run(
        ['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
         '-of', 'default=noprint_wrappers=1:nokey=1', str(path)],
        capture_output=True, text=True,
    )
    return float(out.stdout.strip() or 0)


def transcode_ogg(src: Path, dst: Path) -> None:
    proc = subprocess.run(
        ['ffmpeg', '-y', '-i', str(src), '-vn', '-c:a', 'libvorbis', '-q:a', '5', str(dst)],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f'ffmpeg transcode failed for {src}: {proc.stderr.decode()[-300:]}')


def make_silence(dst: Path, seconds: float) -> None:
    proc = subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
         '-t', f'{seconds:.3f}', '-c:a', 'libvorbis', '-q:a', '0', str(dst)],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f'ffmpeg silence failed: {proc.stderr.decode()[-300:]}')


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--track-id', default=uuid.uuid4().hex[:12])
    ap.add_argument('--beatmap-id', default=uuid.uuid4().hex[:12])
    ap.add_argument('--name', default='scene acid test v1')
    args = ap.parse_args()

    track_id = args.track_id
    beatmap_id = args.beatmap_id
    track_dir = TRACKS_DIR / track_id
    stems_dir = track_dir / 'stems'
    bm_dir = track_dir / 'beatmaps' / beatmap_id
    vo_dir = bm_dir / 'vo'
    for d in (stems_dir, vo_dir):
        d.mkdir(parents=True, exist_ok=True)

    # 1) Transcode clips + probe durations, lay down VO files + TutorialScript +
    #    Events lines as we walk the timeline.
    vo_lines: list[str] = []
    event_lines: list[str] = []
    tick = 0
    print(f'{"clip":>4} {"event":<32} {"dur(s)":>7} {"tick":>7} {"durTicks":>8}')
    for idx, (name, accepts_dur, line) in enumerate(EVENTS, start=1):
        nn = f'{idx:02d}'
        src = CLIPS_DIR / f'{nn}.mp3'
        if not src.exists():
            raise SystemExit(f'Missing clip: {src}')
        vo_name = f'{nn}_{name}.ogg'
        transcode_ogg(src, vo_dir / vo_name)
        dur_s = probe_duration(vo_dir / vo_name)
        dur_ticks = max(1, round(dur_s * TICKS_PER_SEC))

        # VO event: whole-clip playback (no duration_ms ⇒ plays to end).
        vo_lines.append(
            f'  {tick} = VO "vo/{vo_name}" text="{line}" engine=elevenlabs'
        )
        # Scene event: span the clip when the event accepts a duration token;
        # otherwise fire instantaneously at the clip's start (hide/flash cues).
        if accepts_dur:
            event_lines.append(f'  {tick} = E "{name} {dur_ticks}"')
        else:
            event_lines.append(f'  {tick} = E "{name}"')

        print(f'{nn:>4} {name:<32} {dur_s:>7.2f} {tick:>7} {dur_ticks:>8}')
        tick += dur_ticks + GAP_TICKS

    end_tick = tick
    total_sec = end_tick / TICKS_PER_SEC
    song_sec = math.ceil(total_sec) + 5  # small tail so the last cue isn't clipped

    # 2) Silent backing track (VO events provide all audio).
    make_silence(stems_dir / 'song.ogg', song_sec)
    (bm_dir / 'song.ogg').write_bytes((stems_dir / 'song.ogg').read_bytes())

    # 3) notes.chart
    chart = f'''[Song]
{{
  Name = "{args.name}"
  Artist = "Jamsesh"
  Charter = "Jamsesh"
  Offset = 0
  Resolution = {RESOLUTION}
  Player2 = bass
  Difficulty = 0
  PreviewStart = 0
  PreviewEnd = 0
  Genre = "tutorial"
  MediaType = "cd"
  MusicStream = "song.ogg"
}}
[SyncTrack]
{{
  0 = TS 4
  0 = B {BPM * 1000}
}}
[ExpertSingle]
{{
}}
[TutorialScript]
{{
{chr(10).join(vo_lines)}
}}
[Events]
{{
{chr(10).join(event_lines)}
}}
'''
    (bm_dir / 'notes.chart').write_text(chart, encoding='utf-8')

    # 4) song.ini
    song_ini = f'''[song]
name = {args.name}
artist = Jamsesh
album =
genre = tutorial
year =
song_length = {song_sec * 1000}
charter = Jamsesh
preview_start_time = 0
delay = 0
loading_phrase =

[onboarding]
onboarding = True
'''
    (bm_dir / 'song.ini').write_text(song_ini, encoding='utf-8')

    # 5) track.json
    track_json = {
        'id': track_id,
        'name': args.name,
        'created_at': time.time(),
        'stems': {'song': 'song.ogg'},
        'model': 'manual',
        'output_format': 'ogg',
        'artist': 'Jamsesh',
        'album': '',
        'genre': 'tutorial',
        'year': '',
        'beatmaps': [
            {
                'id': beatmap_id,
                'stem': 'song',
                'generated_at': time.time(),
                'folder_name': f'Jamsesh - {args.name}',
                'song_name': args.name,
                'active': True,
                'model': 'manual',
                'model_version': None,
                'preset': None,
            }
        ],
        'source_game_song': '',
    }
    (track_dir / 'track.json').write_text(json.dumps(track_json, indent=2), encoding='utf-8')

    print('\n--- DONE ---')
    print(f'track_id   = {track_id}')
    print(f'beatmap_id = {beatmap_id}')
    print(f'events     = {len(EVENTS)}  (duration-capable: {sum(1 for e in EVENTS if e[1])}, instant: {sum(1 for e in EVENTS if not e[1])})')
    print(f'timeline   = {total_sec:.1f}s of cues, {song_sec}s silent backing')
    print(f'editor URL = /tracks/{track_id}/beatmaps/{beatmap_id}')


if __name__ == '__main__':
    main()
