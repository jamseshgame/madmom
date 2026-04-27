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

    @property
    def dir(self) -> Path:
        return TRACKS_DIR / self.id

    @property
    def stems_dir(self) -> Path:
        return self.dir / 'stems'

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


def list_tracks() -> list[dict[str, Any]]:
    """List all saved tracks, newest first."""
    TRACKS_DIR.mkdir(parents=True, exist_ok=True)
    tracks = []
    for d in TRACKS_DIR.iterdir():
        if d.is_dir() and (d / 'track.json').exists():
            t = Track.load(d.name)
            if t:
                tracks.append(t.to_dict())
    tracks.sort(key=lambda t: t['created_at'], reverse=True)
    return tracks


def get_track(track_id: str) -> Track | None:
    return Track.load(track_id)


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
        if hasattr(track, key) and key not in ('id', 'created_at', 'stems'):
            setattr(track, key, val)
    track.save()
    return track
