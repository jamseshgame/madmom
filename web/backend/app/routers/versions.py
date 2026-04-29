"""Versions of the open-source dependencies we ship.

The Changelog page renders a single table listing every package below; the
VersionBanner alerts when any of them are behind PyPI's latest. To add a new
dep, just append to ``PACKAGES``.
"""

from __future__ import annotations

import asyncio
import re
from importlib.metadata import PackageNotFoundError, version as installed_version
from pathlib import Path

import httpx
from fastapi import APIRouter

router = APIRouter(prefix='/api/versions', tags=['versions'])

PYPI_URL = 'https://pypi.org/pypi/{package}/json'

# Single source of truth for the table on /changelog. `name` is the
# pip-distribution name; `used_for` is what surfaces in the table; `optional`
# packages won't trip the "update available" banner if missing.
PACKAGES: list[dict[str, str | bool]] = [
    {
        'name': 'madmom',
        'used_for': 'Beat tracking, onset detection, chart generation',
        'license': 'BSD',
    },
    {
        'name': 'demucs',
        'used_for': 'Stem separation (htdemucs / htdemucs_6s)',
        'license': 'MIT',
    },
    {
        'name': 'chatterbox-tts',
        'used_for': 'Tutorial VO synthesis with voice cloning',
        'license': 'MIT',
    },
    {
        'name': 'yt-dlp',
        'used_for': 'YouTube search + audio-as-MP3 download',
        'license': 'Unlicense',
    },
    {
        'name': 'torch',
        'used_for': 'Deep-learning runtime (demucs + chatterbox)',
        'license': 'BSD-3-Clause',
    },
    {
        'name': 'torchaudio',
        'used_for': 'Audio tensor I/O for demucs',
        'license': 'BSD-2-Clause',
    },
    {
        'name': 'torchcodec',
        'used_for': 'FFmpeg-backed audio decoding for torchaudio.save',
        'license': 'BSD-3-Clause',
        'optional': True,
    },
    {
        'name': 'Pillow',
        'used_for': 'Album-art resize to 512×512 PNG',
        'license': 'MIT-CMU',
    },
    {
        'name': 'fastapi',
        'used_for': 'HTTP API framework',
        'license': 'MIT',
    },
    {
        'name': 'uvicorn',
        'used_for': 'ASGI server',
        'license': 'BSD-3-Clause',
    },
    {
        'name': 'httpx',
        'used_for': 'iTunes / MusicBrainz / GitHub HTTP client',
        'license': 'BSD-3-Clause',
    },
    {
        'name': 'numpy',
        'used_for': 'Numerical arrays for madmom + demucs',
        'license': 'BSD-3-Clause',
    },
    {
        'name': 'scipy',
        'used_for': 'Signal processing inside madmom',
        'license': 'BSD-3-Clause',
    },
]


def _installed(pkg: str) -> str | None:
    try:
        return installed_version(pkg)
    except PackageNotFoundError:
        return None


def _madmom_source_version() -> str | None:
    # routers/versions.py → app → backend → web → repo root
    setup = Path(__file__).resolve().parents[4] / 'setup.py'
    if not setup.exists():
        return None
    m = re.search(r"^version\s*=\s*['\"]([^'\"]+)['\"]", setup.read_text(), re.MULTILINE)
    return m.group(1) if m else None


async def _pypi_latest(pkg: str, client: httpx.AsyncClient) -> str | None:
    try:
        r = await client.get(PYPI_URL.format(package=pkg), timeout=5.0)
        r.raise_for_status()
        return r.json()['info']['version']
    except Exception:
        return None


def _is_up_to_date(installed: str | None, latest: str | None) -> bool | None:
    if not installed or not latest:
        return None
    try:
        from packaging.version import Version

        return Version(installed) >= Version(latest)
    except Exception:
        return installed == latest


@router.get('')
async def get_versions():
    """Return a single packages array plus, for backwards compat with the old
    VersionFooter / VersionBanner code paths, top-level `madmom` / `demucs`
    keys mirroring the legacy shape."""

    async with httpx.AsyncClient() as client:
        latest_results = await asyncio.gather(
            *[_pypi_latest(str(p['name']), client) for p in PACKAGES],
            return_exceptions=False,
        )

    packages: list[dict] = []
    for cfg, latest in zip(PACKAGES, latest_results):
        name = str(cfg['name'])
        installed = _installed(name)
        if installed is None and name == 'madmom':
            installed = _madmom_source_version()
        packages.append({
            'name': name,
            'installed': installed,
            'latest': latest,
            'up_to_date': _is_up_to_date(installed, latest),
            'used_for': cfg.get('used_for', ''),
            'license': cfg.get('license', ''),
            'optional': bool(cfg.get('optional', False)),
        })

    by_name = {p['name']: p for p in packages}
    return {
        'packages': packages,
        # Legacy keys for VersionBanner. Only the relevant fields.
        'madmom': {k: by_name['madmom'][k] for k in ('installed', 'latest', 'up_to_date')}
        if 'madmom' in by_name
        else {'installed': None, 'latest': None, 'up_to_date': None},
        'demucs': {k: by_name['demucs'][k] for k in ('installed', 'latest', 'up_to_date')}
        if 'demucs' in by_name
        else {'installed': None, 'latest': None, 'up_to_date': None},
    }
