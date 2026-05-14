"""Serve highway floor textures from the local Unity project.

The 3D-view sidebar in the editor picks one of these and the runway plane
in three.js gets it as a tiled diffuse texture. Files are streamed straight
from disk — no transcoding.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from ..config import settings

router = APIRouter(prefix='/api/highway-textures', tags=['highway-textures'])

_ALLOWED_EXTS = {'.png', '.jpg', '.jpeg', '.webp', '.tga'}


def _dir() -> Path:
    return Path(settings.jamseshquest_highways_dir)


@router.get('')
async def list_textures() -> dict:
    d = _dir()
    if not d.exists():
        return {'dir': str(d), 'available': False, 'textures': []}
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
    return {'dir': str(d), 'available': True, 'textures': out}


@router.get('/{name}')
async def get_texture(name: str) -> FileResponse:
    if '/' in name or '\\' in name or name.startswith('.'):
        raise HTTPException(400, 'Invalid filename')
    p = _dir() / name
    if not p.exists() or not p.is_file():
        raise HTTPException(404, 'Texture not found')
    if p.suffix.lower() not in _ALLOWED_EXTS:
        raise HTTPException(400, f'Unsupported texture format: {p.suffix}')
    media = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.tga': 'image/x-tga',
    }.get(p.suffix.lower(), 'application/octet-stream')
    return FileResponse(p, media_type=media, filename=p.name)
