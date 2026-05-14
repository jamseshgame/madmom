"""Serve 3D gem mesh files from the local Unity project.

The editor's 3D-preview overlay loads these as FBX in-browser via three.js'
FBXLoader. Files are served straight from disk (the Unity project lives
outside this repo) — no transcoding step.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from ..config import settings

router = APIRouter(prefix='/api/gem-meshes', tags=['gem-meshes'])

_ALLOWED_EXTS = {'.fbx', '.glb', '.gltf', '.obj'}


def _gems_dir() -> Path:
    return Path(settings.jamseshquest_gems_dir)


@router.get('')
async def list_meshes() -> dict:
    d = _gems_dir()
    if not d.exists():
        return {'dir': str(d), 'available': False, 'meshes': []}
    out = []
    for p in sorted(d.iterdir()):
        if not p.is_file() or p.suffix.lower() not in _ALLOWED_EXTS:
            continue
        out.append({
            'name': p.name,
            'stem': p.stem,
            'ext': p.suffix.lower().lstrip('.'),
            'size_bytes': p.stat().st_size,
        })
    return {'dir': str(d), 'available': True, 'meshes': out}


@router.get('/{name}')
async def get_mesh(name: str) -> FileResponse:
    if '/' in name or '\\' in name or name.startswith('.'):
        raise HTTPException(400, 'Invalid filename')
    p = _gems_dir() / name
    if not p.exists() or not p.is_file():
        raise HTTPException(404, 'Mesh not found')
    if p.suffix.lower() not in _ALLOWED_EXTS:
        raise HTTPException(400, f'Unsupported mesh format: {p.suffix}')
    media = {
        '.fbx': 'application/octet-stream',
        '.glb': 'model/gltf-binary',
        '.gltf': 'model/gltf+json',
        '.obj': 'text/plain',
    }.get(p.suffix.lower(), 'application/octet-stream')
    return FileResponse(p, media_type=media, filename=p.name)
