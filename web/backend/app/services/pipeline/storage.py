"""On-disk layout + versioning for pipeline stage outputs.

Layout per spec §7:
  <track_dir>/grid.json                          (S1 active)
  <track_dir>/grid_versions/<iso>_<engine>.json  (S1 snapshots)
  <track_dir>/grid_versions/_meta.json           (versions index)
  <track_dir>/stems/<stem>/v2/<stage>.json       (S2..S7 active)
  <track_dir>/stems/<stem>/v2/<stage>_versions/  (snapshots)
"""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any

from .registry import Stage


# Stage IDs that live at the Track level (no stem). Everything else is stem-scoped.
_TRACK_LEVEL_STAGES = {Stage.GRID}


def _is_track_level(stage: Stage) -> bool:
    return stage in _TRACK_LEVEL_STAGES


def track_dir(path: Path) -> Path:
    """Identity helper that exists so callers don't construct paths inline."""
    return path


def stem_v2_dir(track_dir_: Path, stem: str) -> Path:
    return track_dir_ / 'stems' / stem / 'v2'


def stage_path(track_dir_: Path, stage: Stage, stem: str | None) -> Path:
    if _is_track_level(stage):
        return track_dir_ / f'{stage.value}.json'
    if stem is None:
        raise ValueError(f"stage {stage.value!r} requires a stem")
    return stem_v2_dir(track_dir_, stem) / f'{stage.value}.json'


def versions_dir(track_dir_: Path, stage: Stage, stem: str | None) -> Path:
    if _is_track_level(stage):
        return track_dir_ / f'{stage.value}_versions'
    if stem is None:
        raise ValueError(f"stage {stage.value!r} requires a stem")
    return stem_v2_dir(track_dir_, stem) / f'{stage.value}_versions'


def archive_dir(track_dir_: Path, stage: Stage, stem: str | None) -> Path:
    return versions_dir(track_dir_, stage, stem) / '_archive'


def stale_dir(track_dir_: Path, stage: Stage, stem: str | None) -> Path:
    if _is_track_level(stage):
        return track_dir_ / '_stale'
    if stem is None:
        raise ValueError(f"stage {stage.value!r} requires a stem")
    return stem_v2_dir(track_dir_, stem) / '_stale'


def _iso_stamp() -> str:
    return dt.datetime.utcnow().strftime('%Y-%m-%dT%H-%M-%S')


def _meta_path(vdir: Path) -> Path:
    return vdir / '_meta.json'


def _read_meta(vdir: Path) -> list[dict[str, Any]]:
    p = _meta_path(vdir)
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        return []


def _write_meta(vdir: Path, entries: list[dict[str, Any]]) -> None:
    _meta_path(vdir).write_text(json.dumps(entries, indent=2))


def save_version_and_activate(
    track_dir_: Path,
    stage: Stage,
    stem: str | None,
    payload: dict[str, Any],
) -> str:
    """Write payload to a timestamped snapshot under `<stage>_versions/`,
    activate it (copy to `<stage>.json`), and update _meta.json.

    Returns the snapshot filename (not the full path).
    """
    active = stage_path(track_dir_, stage, stem)
    vdir = versions_dir(track_dir_, stage, stem)
    active.parent.mkdir(parents=True, exist_ok=True)
    vdir.mkdir(parents=True, exist_ok=True)

    engine = payload.get('engine', 'unknown')
    filename = f'{_iso_stamp()}_{engine}.json'
    snapshot = vdir / filename

    body = json.dumps(payload, indent=2)
    snapshot.write_text(body)
    active.write_text(body)

    entries = _read_meta(vdir)
    entries.insert(0, {
        'filename': filename,
        'engine': engine,
        'params': payload.get('params', {}),
        'created_at': payload.get('generated_at') or dt.datetime.utcnow().isoformat() + 'Z',
        'starred': False,
    })
    _write_meta(vdir, entries)
    return filename


def list_versions(
    track_dir_: Path,
    stage: Stage,
    stem: str | None,
) -> list[dict[str, Any]]:
    """Return _meta.json entries enriched with `active: bool`."""
    vdir = versions_dir(track_dir_, stage, stem)
    entries = _read_meta(vdir)
    if not entries:
        return []
    active = stage_path(track_dir_, stage, stem)
    active_payload = None
    if active.exists():
        try:
            active_payload = json.loads(active.read_text())
        except (OSError, json.JSONDecodeError):
            active_payload = None
    for e in entries:
        is_active = (
            active_payload is not None
            and e['engine'] == active_payload.get('engine')
            and e['created_at'] == active_payload.get('generated_at')
        )
        e['active'] = is_active
    return entries


def move_active_to_stale(
    track_dir_: Path,
    stage: Stage,
    stem: str | None,
) -> Path | None:
    """Move the active file for `stage` (if any) into the `_stale/` folder
    with a timestamp suffix. Returns the destination path, or None if there
    was no active file to move."""
    active = stage_path(track_dir_, stage, stem)
    if not active.exists():
        return None
    sdir = stale_dir(track_dir_, stage, stem)
    sdir.mkdir(parents=True, exist_ok=True)
    dest = sdir / f'{stage.value}_{_iso_stamp()}.json'
    active.rename(dest)
    return dest
