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
) -> Track | None:
    """Copy a freshly generated beatmap folder into the track's beatmaps_dir
    and append a record to the track. Returns the updated track."""
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
    }
    # Replace any prior record with the same id (shouldn't happen, but keeps it tidy)
    track.beatmaps = [b for b in track.beatmaps if b.get('id') != beatmap_id]
    track.beatmaps.append(record)
    track.save()
    return track


def get_beatmap_dir(track_id: str, beatmap_id: str) -> Path | None:
    track = Track.load(track_id)
    if not track:
        return None
    if not any(b.get('id') == beatmap_id for b in track.beatmaps):
        return None
    d = track.beatmaps_dir / beatmap_id
    return d if d.exists() else None


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
