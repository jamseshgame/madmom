"""Persistent track store — saves stem separations as reusable tracks on disk."""

import json
import shutil
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from ..config import settings

TRACKS_DIR = Path(settings.upload_dir) / '_tracks'


@dataclass
class Track:
    id: str
    name: str
    created_at: float
    stems: dict[str, str]  # stem_name → filename
    model: str = 'htdemucs'
    output_format: str = 'mp3'
    # Optional metadata carried from the original file
    artist: str = ''
    album: str = ''
    genre: str = ''
    year: str = ''
    # Beatmap records: each {id, stem, generated_at, folder_name, song_name}
    beatmaps: list[dict[str, Any]] = field(default_factory=list)
    # Set when this Track was created from a Game-Library pull (the value is
    # the SongInbox folder name). Tracks with this set live in `_tracks/` but
    # their stem + beatmap files symlink back to `_game-songs/<folder>/` so
    # edits in the Studio editor flow back to the same place "Push to game
    # repo" pushes from. Empty string for normal Studio-created tracks.
    source_game_song: str = ''
    # 'draft'  — the master audio is staged but separation hasn't run (or
    #            failed). The track shows in the library as resumable work.
    # 'ready'  — stems exist; the normal, fully-usable state.
    # Defaults to 'ready' so every track.json written before drafts existed
    # keeps working without a migration.
    status: str = 'ready'
    # Filename (inside `source_dir`) of the untouched master a draft was
    # created from. Kept after separation too, so a track can be re-split with
    # a different engine without re-uploading.
    source_audio: str = ''
    # YouTube URL this track was imported from, when applicable.
    youtube_source_url: str = ''

    @property
    def dir(self) -> Path:
        return TRACKS_DIR / self.id

    @property
    def stems_dir(self) -> Path:
        return self.dir / 'stems'

    @property
    def beatmaps_dir(self) -> Path:
        return self.dir / 'beatmaps'

    @property
    def source_dir(self) -> Path:
        """Holds the original master audio (separate from `stems/` so it never
        gets mistaken for a stem or swept up by the publish/zip helpers)."""
        return self.dir / 'source'

    @property
    def source_path(self) -> Path | None:
        if not self.source_audio:
            return None
        path = self.source_dir / self.source_audio
        return path if path.exists() else None

    @property
    def is_draft(self) -> bool:
        return self.status == 'draft'

    @property
    def meta_path(self) -> Path:
        return self.dir / 'track.json'

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d['stem_count'] = len(self.stems)
        return d

    def save(self):
        self.dir.mkdir(parents=True, exist_ok=True)
        self.meta_path.write_text(json.dumps(asdict(self), indent=2))

    @classmethod
    def load(cls, track_id: str) -> 'Track | None':
        meta_path = TRACKS_DIR / track_id / 'track.json'
        if not meta_path.exists():
            return None
        data = json.loads(meta_path.read_text())
        # Tolerate older track.json files written before new fields existed
        valid = {f.name for f in cls.__dataclass_fields__.values()}
        data = {k: v for k, v in data.items() if k in valid}
        return cls(**data)


def create_track(
    name: str,
    stems: dict[str, str],
    source_stems_dir: Path,
    model: str = 'htdemucs',
    output_format: str = 'mp3',
    artist: str = '',
    album: str = '',
    genre: str = '',
    year: str = '',
) -> Track:
    """Create a new track by copying stem files to persistent storage."""
    track = Track(
        id=uuid.uuid4().hex[:12],
        name=name,
        created_at=time.time(),
        stems=stems,
        model=model,
        output_format=output_format,
        artist=artist,
        album=album,
        genre=genre,
        year=year,
    )

    track.stems_dir.mkdir(parents=True, exist_ok=True)

    # Copy stem files to track storage
    for stem_name, filename in stems.items():
        src = source_stems_dir / filename
        if src.exists():
            shutil.copy2(str(src), str(track.stems_dir / filename))

    track.save()
    return track


def create_draft_track(
    name: str,
    audio_bytes: bytes,
    audio_filename: str,
    artist: str = '',
    album: str = '',
    genre: str = '',
    year: str = '',
    youtube_source_url: str = '',
) -> Track:
    """Persist freshly-staged master audio as a resumable draft track.

    Called the moment audio is staged — a YouTube pull or a file upload —
    *before* the user has picked separation settings. Without this the audio
    only ever existed as a File object in the browser tab, so closing the tab
    at the settings screen threw away a download that can take minutes, with
    nothing left in the library to resume from.

    The track appears in the Studio Library straight away with
    ``status='draft'`` and no stems. Running separation on it later promotes it
    to 'ready' in place, keeping the same id — so any link to the draft stays
    valid.
    """
    ext = Path(audio_filename).suffix.lower() or '.mp3'
    track = Track(
        id=uuid.uuid4().hex[:12],
        name=name,
        created_at=time.time(),
        stems={},
        model='',
        output_format='',
        artist=artist,
        album=album,
        genre=genre,
        year=year,
        status='draft',
        source_audio=f'source{ext}',
        youtube_source_url=youtube_source_url,
    )
    track.source_dir.mkdir(parents=True, exist_ok=True)
    (track.source_dir / track.source_audio).write_bytes(audio_bytes)
    track.stems_dir.mkdir(parents=True, exist_ok=True)
    track.save()
    return track


def promote_draft(
    track: Track,
    stems: dict[str, str],
    model: str,
    output_format: str,
) -> Track:
    """Flip a draft to 'ready' once its stems exist."""
    track.stems = stems
    track.model = model
    track.output_format = output_format
    track.status = 'ready'
    track.save()
    return track


def _read_song_ini_metadata(stems_dir: Path) -> dict[str, str]:
    """Pull just name/artist/album/genre/year from a track's song.ini if present."""
    path = stems_dir / 'song.ini'
    if not path.exists():
        return {}
    out: dict[str, str] = {}
    try:
        for raw in path.read_text(encoding='utf-8', errors='replace').splitlines():
            line = raw.strip()
            if not line or line.startswith(('#', ';', '[')) or '=' not in line:
                continue
            k, _, v = line.partition('=')
            key = k.strip().lower()
            if key in ('name', 'artist', 'album', 'genre', 'year'):
                val = v.strip()
                if val:
                    out[key] = val
    except Exception:
        return {}
    return out


def list_tracks() -> list[dict[str, Any]]:
    """List all saved tracks, newest first.

    Enriches each track with metadata from its song.ini (if present), so the
    library shows the clean title even when the track.json was created before
    the user filled in the form.
    """
    TRACKS_DIR.mkdir(parents=True, exist_ok=True)
    tracks = []
    for d in TRACKS_DIR.iterdir():
        if d.is_dir() and (d / 'track.json').exists():
            t = Track.load(d.name)
            if not t:
                continue
            data = t.to_dict()
            ini = _read_song_ini_metadata(t.stems_dir)
            for key in ('name', 'artist', 'album', 'genre', 'year'):
                if ini.get(key):
                    data[key] = ini[key]
            tracks.append(data)
    tracks.sort(key=lambda t: t['created_at'], reverse=True)
    return tracks


def get_track(track_id: str) -> Track | None:
    return Track.load(track_id)


def get_track_enriched(track_id: str) -> dict[str, Any] | None:
    """Same as get_track().to_dict() but with song.ini metadata layered on."""
    t = Track.load(track_id)
    if not t:
        return None
    data = t.to_dict()
    data['has_grid'] = (t.dir / 'grid.json').exists()
    ini = _read_song_ini_metadata(t.stems_dir)
    for key in ('name', 'artist', 'album', 'genre', 'year'):
        if ini.get(key):
            data[key] = ini[key]
    return data


def delete_track(track_id: str) -> bool:
    track_dir = TRACKS_DIR / track_id
    if track_dir.exists():
        shutil.rmtree(track_dir, ignore_errors=True)
        return True
    return False


def update_track_meta(track_id: str, **kwargs) -> Track | None:
    """Update metadata fields on an existing track."""
    track = Track.load(track_id)
    if not track:
        return None
    for key, val in kwargs.items():
        if hasattr(track, key) and key not in ('id', 'created_at', 'stems', 'beatmaps'):
            setattr(track, key, val)
    track.save()
    return track


def add_beatmap_record(
    track_id: str,
    beatmap_id: str,
    stem: str,
    folder_name: str,
    song_name: str,
    source_dir: Path,
    *,
    model: str | None = None,
    model_version: str | None = None,
    preset: str | None = None,
) -> Track | None:
    """Copy a freshly generated beatmap folder into the track's beatmaps_dir
    and append a record to the track. Returns the updated track.

    `model` / `model_version` capture provenance the same way lyrics_versions
    and vocal_notes_versions do, so the picker UI can badge each row with
    `MADMOM 0.17.dev0` / `MANUAL` / `IMPORTED` and flag stale versions when
    the installed package moves on. `preset` records which generation-preset
    name produced the beatmap (V2 pipeline only); the picker renders it as a
    second badge next to the model badge so A/B comparisons stay legible."""
    track = Track.load(track_id)
    if not track:
        return None

    track.beatmaps_dir.mkdir(parents=True, exist_ok=True)
    dest = track.beatmaps_dir / beatmap_id
    if source_dir.exists() and not dest.exists():
        shutil.copytree(str(source_dir), str(dest))

    record = {
        'id': beatmap_id,
        'stem': stem,
        'generated_at': time.time(),
        'folder_name': folder_name,
        'song_name': song_name,
        'active': True,
        'model': model,
        'model_version': model_version,
        'preset': preset,
    }
    # Replace any prior record with the same id (shouldn't happen, but keeps it tidy)
    track.beatmaps = [b for b in track.beatmaps if b.get('id') != beatmap_id]
    # New beatmap takes the active slot for its stem; clear it on siblings so
    # publish defaults to the freshest result.
    for b in track.beatmaps:
        if b.get('stem') == stem:
            b['active'] = False
    track.beatmaps.append(record)
    track.save()
    return track


def clone_beatmap_record(track_id: str, beatmap_id: str) -> dict | None:
    """Duplicate a beatmap's folder + record. The clone gets a new id, a
    "(copy)"-suffixed song_name to keep it distinct in the picker, and is
    marked active for its stem so the user lands on the edited copy first."""
    track = Track.load(track_id)
    if not track:
        return None
    src_record = next((b for b in track.beatmaps if b.get('id') == beatmap_id), None)
    if src_record is None:
        return None
    src_dir = track.beatmaps_dir / beatmap_id
    if not src_dir.exists():
        return None

    new_id = uuid.uuid4().hex[:12]
    dst_dir = track.beatmaps_dir / new_id
    shutil.copytree(str(src_dir), str(dst_dir))

    base_name = (src_record.get('song_name') or '').strip()
    new_song_name = f'{base_name} (copy)' if base_name else 'Copy'

    # Rewrite [Song] name inside the cloned song.ini + notes.chart so any
    # downstream tooling sees the new title; mirrors rename_beatmap_record.
    for fname in ('song.ini', 'notes.chart'):
        path = dst_dir / fname
        if not path.exists():
            continue
        try:
            text = path.read_text(encoding='utf-8', errors='replace')
            lines = text.splitlines()
            in_song_section = False
            for i, line in enumerate(lines):
                stripped = line.strip()
                if stripped.startswith('[') and stripped.endswith(']'):
                    in_song_section = stripped.lower() in ('[song]',)
                    continue
                if in_song_section and '=' in stripped:
                    k, _, _ = stripped.partition('=')
                    if k.strip().lower() == 'name':
                        indent = line[: len(line) - len(line.lstrip())]
                        lines[i] = f'{indent}name = {new_song_name}' if fname.endswith('.ini') else f'{indent}Name = "{new_song_name}"'
            path.write_text('\n'.join(lines) + ('\n' if text.endswith('\n') else ''), encoding='utf-8')
        except Exception:
            # Best-effort — chart still works with stale name.
            pass

    record = {
        'id': new_id,
        'stem': src_record.get('stem', ''),
        'generated_at': time.time(),
        'folder_name': src_record.get('folder_name', ''),
        'song_name': new_song_name,
        'active': True,
        'model': src_record.get('model'),
        'model_version': src_record.get('model_version'),
    }
    for b in track.beatmaps:
        if b.get('stem') == record['stem']:
            b['active'] = False
    track.beatmaps.append(record)
    track.save()
    return record


class CloneDifficultyError(Exception):
    """Raised for cross-stem / mismatched-family / missing-source-section
    clone-difficulty attempts. The router maps it to HTTP 422."""


def clone_difficulty_across_beatmaps(
    track_id: str,
    source_beatmap_id: str,
    source_difficulty: str,
    target_beatmap_id: str,
    target_difficulty: str,
) -> dict | None:
    """Copy one difficulty section from one beatmap's notes.chart into another
    beatmap's notes.chart on the same track. Both beatmaps must be on the same
    stem; source/target difficulty names must belong to that stem's section
    family (remap across difficulties is allowed). Overwrites the target
    difficulty in place, preserving every other section.

    Returns a result dict, or None when the track / either beatmap record /
    either notes.chart is missing. Raises CloneDifficultyError on validation
    failures (cross-stem, mismatched family, source section absent).
    """
    from app.services.chart_generator import STEM_TO_SECTION_SUFFIX, splice_difficulty

    track = Track.load(track_id)
    if not track:
        return None
    src = next((b for b in track.beatmaps if b.get('id') == source_beatmap_id), None)
    tgt = next((b for b in track.beatmaps if b.get('id') == target_beatmap_id), None)
    if src is None or tgt is None:
        return None

    src_stem = src.get('stem') or ''
    tgt_stem = tgt.get('stem') or ''
    if not src_stem:
        raise CloneDifficultyError('source beatmap has no stem')
    if src_stem != tgt_stem:
        raise CloneDifficultyError('source and target beatmaps are on different stems')
    suffix = STEM_TO_SECTION_SUFFIX.get(src_stem)
    if not suffix:
        raise CloneDifficultyError(f'stem {src_stem!r} has no chart section family')
    valid = {f'{p}{suffix}' for p in ('Expert', 'Hard', 'Medium', 'Easy')}
    if source_difficulty not in valid or target_difficulty not in valid:
        raise CloneDifficultyError(
            f'difficulty must be one of {sorted(valid)} for stem {src_stem!r}'
        )

    src_chart = track.beatmaps_dir / source_beatmap_id / 'notes.chart'
    tgt_chart = track.beatmaps_dir / target_beatmap_id / 'notes.chart'
    if not src_chart.exists() or not tgt_chart.exists():
        return None

    try:
        src_text = src_chart.read_text(encoding='utf-8')
        tgt_text = tgt_chart.read_text(encoding='utf-8')
    except UnicodeDecodeError as exc:
        raise CloneDifficultyError(f'chart file is not valid UTF-8: {exc}') from exc
    try:
        new_text, overwrote = splice_difficulty(
            src_text, source_difficulty, tgt_text, target_difficulty
        )
    except ValueError as exc:
        raise CloneDifficultyError(str(exc))
    tgt_chart.write_text(new_text, encoding='utf-8')

    return {
        'target_beatmap_id': target_beatmap_id,
        'target_difficulty': target_difficulty,
        'source_beatmap_id': source_beatmap_id,
        'source_difficulty': source_difficulty,
        'overwrote': overwrote,
    }


def set_active_beatmap(track_id: str, beatmap_id: str) -> dict | None:
    """Mark `beatmap_id` as the active beatmap for its stem. Returns the
    updated record, or None if not found."""
    track = Track.load(track_id)
    if not track:
        return None
    target = next((b for b in track.beatmaps if b.get('id') == beatmap_id), None)
    if target is None:
        return None
    stem = target.get('stem', '')
    for b in track.beatmaps:
        if b.get('stem') == stem:
            b['active'] = (b.get('id') == beatmap_id)
    track.save()
    return target


def set_beatmap_included(track_id: str, beatmap_id: str, included: bool) -> dict | None:
    """Toggle whether `beatmap_id` is included in the published chart.

    Independent of `active` — multiple beatmaps per stem can be included
    simultaneously (they appear as numbered alternates in the published
    notes.chart). When a stem has zero included beatmaps, that stem is
    skipped from the publish bundle entirely.

    Missing field on the record is treated as included (backward compat).
    """
    track = Track.load(track_id)
    if not track:
        return None
    target = next((b for b in track.beatmaps if b.get('id') == beatmap_id), None)
    if target is None:
        return None
    target['included'] = bool(included)
    track.save()
    return target


def get_beatmap_dir(track_id: str, beatmap_id: str) -> Path | None:
    track = Track.load(track_id)
    if not track:
        return None
    if not any(b.get('id') == beatmap_id for b in track.beatmaps):
        return None
    d = track.beatmaps_dir / beatmap_id
    return d if d.exists() else None


def rename_beatmap_record(track_id: str, beatmap_id: str, song_name: str) -> dict | None:
    """Rename a beatmap. Updates the beatmaps[] entry and rewrites the [Song]
    name in the beatmap's song.ini and notes.chart so a downstream Jamsesh
    consumer sees the new title too. Returns the updated record or None."""
    name = (song_name or '').strip()
    if not name:
        return None
    track = Track.load(track_id)
    if not track:
        return None
    record: dict[str, Any] | None = None
    for b in track.beatmaps:
        if b.get('id') == beatmap_id:
            b['song_name'] = name
            record = b
            break
    if record is None:
        return None
    track.save()

    bm_dir = track.beatmaps_dir / beatmap_id
    if bm_dir.exists():
        # song.ini — overwrite the name = ... line if present
        ini_path = bm_dir / 'song.ini'
        if ini_path.exists():
            try:
                lines = ini_path.read_text(encoding='utf-8', errors='replace').splitlines()
                rewrote = False
                for i, line in enumerate(lines):
                    if line.strip().lower().startswith('name'):
                        prefix, _, _ = line.partition('=')
                        if '=' in line:
                            lines[i] = f'{prefix.rstrip()} = {name}'
                            rewrote = True
                            break
                if rewrote:
                    ini_path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
            except OSError as e:
                print(f'[tracks] rename song.ini failed for beatmap {beatmap_id}: {e}')
        # notes.chart — replace the Name = "..." line in [Song]
        chart_path = bm_dir / 'notes.chart'
        if chart_path.exists():
            try:
                import re as _re
                text = chart_path.read_text(encoding='utf-8', errors='replace')
                escaped = name.replace('"', "'")
                new_text = _re.sub(
                    r'(Name\s*=\s*)"[^"]*"',
                    lambda m: f'{m.group(1)}"{escaped}"',
                    text, count=1,
                )
                if new_text != text:
                    chart_path.write_text(new_text, encoding='utf-8')
            except OSError as e:
                print(f'[tracks] rename notes.chart failed for beatmap {beatmap_id}: {e}')
    return record


def delete_beatmap_record(track_id: str, beatmap_id: str) -> bool:
    track = Track.load(track_id)
    if not track:
        return False
    before = len(track.beatmaps)
    track.beatmaps = [b for b in track.beatmaps if b.get('id') != beatmap_id]
    if len(track.beatmaps) == before:
        return False
    bm_dir = track.beatmaps_dir / beatmap_id
    if bm_dir.exists():
        shutil.rmtree(str(bm_dir), ignore_errors=True)
    track.save()
    return True


def read_elevenlabs_voice(track_id: str, beatmap_id: str) -> str:
    """Return the elevenlabs_voice_id from a beatmap's song.ini, or '' if absent."""
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        return ''
    ini = bm_dir / 'song.ini'
    if not ini.exists():
        return ''
    for raw in ini.read_text(encoding='utf-8', errors='replace').splitlines():
        line = raw.strip()
        if not line or line.startswith(('#', ';', '[')) or '=' not in line:
            continue
        k, _, v = line.partition('=')
        if k.strip().lower() == 'elevenlabs_voice_id':
            return v.strip()
    return ''


def write_elevenlabs_voice(track_id: str, beatmap_id: str, voice_id: str) -> bool:
    """Write/replace elevenlabs_voice_id in song.ini. Returns True on success.

    Mirrors the existing line-based song.ini editing pattern: scan for the
    key, replace if found, otherwise append at end (preserving every other
    line verbatim).
    """
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        return False
    ini = bm_dir / 'song.ini'
    if not ini.exists():
        ini.write_text(f'[song]\nelevenlabs_voice_id = {voice_id.strip()}\n', encoding='utf-8')
        return True
    lines = ini.read_text(encoding='utf-8', errors='replace').splitlines()
    needle = 'elevenlabs_voice_id'
    rewrote = False
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith('#') or stripped.startswith(';') or '=' not in stripped:
            continue
        k, _, _ = stripped.partition('=')
        if k.strip().lower() == needle:
            lines[i] = f'{needle} = {voice_id.strip()}'
            rewrote = True
            break
    if not rewrote:
        lines.append(f'{needle} = {voice_id.strip()}')
    ini.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return True
