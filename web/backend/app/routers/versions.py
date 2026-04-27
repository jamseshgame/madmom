from __future__ import annotations

import re
from importlib.metadata import PackageNotFoundError, version as installed_version
from pathlib import Path

import httpx
from fastapi import APIRouter

router = APIRouter(prefix='/api/versions', tags=['versions'])

PYPI_URL = 'https://pypi.org/pypi/{package}/json'


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
    madmom_installed = _installed('madmom') or _madmom_source_version()
    demucs_installed = _installed('demucs')
    async with httpx.AsyncClient() as client:
        madmom_latest = await _pypi_latest('madmom', client)
        demucs_latest = await _pypi_latest('demucs', client)
    return {
        'madmom': {
            'installed': madmom_installed,
            'latest': madmom_latest,
            'up_to_date': _is_up_to_date(madmom_installed, madmom_latest),
        },
        'demucs': {
            'installed': demucs_installed,
            'latest': demucs_latest,
            'up_to_date': _is_up_to_date(demucs_installed, demucs_latest),
        },
    }
