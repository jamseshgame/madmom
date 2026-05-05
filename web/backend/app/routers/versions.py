"""Versions of the open-source dependencies we ship.

The Changelog page renders a single table listing every package below; the
VersionBanner alerts when any of them are behind PyPI's latest. To add a new
dep, just append to ``PACKAGES``.
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
from importlib.metadata import PackageNotFoundError, version as installed_version
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException

from ..services.jobs import JobKind, create_job

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
        # Local editable install (`pip install -e ../../`). Upgrading from
        # PyPI would clobber the local fork, so the UI hides the button.
        'pinned': True,
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
        'name': 'faster-whisper',
        'used_for': 'CPU-friendly Whisper transcription for vocal lyrics',
        'license': 'MIT',
    },
    {
        'name': 'torchcrepe',
        'used_for': 'Per-frame pitch detection on vocal stems for beatmaps',
        'license': 'MIT',
    },
    {
        'name': 'syllabipy',
        'used_for': 'English syllable splitting (Sonority Sequencing) for per-syllable vocal notes',
        'license': 'MIT',
    },
    {
        'name': 'bcrypt',
        'used_for': 'Password hashing for the multi-user account store',
        'license': 'Apache-2.0',
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
            'pinned': bool(cfg.get('pinned', False)),
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


# ── Upgrade + restart ──────────────────────────────────────────────────────

# Block any package not in this allow-list — both as a sanity check on the
# request body and as a guard against arbitrary remote pip-install execution.
_ALLOWED_NAMES: set[str] = {str(p['name']) for p in PACKAGES}


@router.post('/{package}/upgrade')
async def upgrade_package(package: str):
    """Run ``pip install --upgrade <package>`` in the backend's venv as a
    tracked Job. Streams pip's stdout/stderr through the universal SSE
    endpoint (/api/jobs/{id}/events) so the UI can show live progress.

    Refuses to upgrade pinned packages (madmom — local editable install) or
    anything not declared in PACKAGES."""
    if package not in _ALLOWED_NAMES:
        raise HTTPException(404, f'Unknown package: {package}')
    cfg = next((p for p in PACKAGES if p['name'] == package), None)
    if cfg and cfg.get('pinned'):
        raise HTTPException(409, f'{package} is pinned (local install) — upgrade manually')

    job = create_job(kind=JobKind.OTHER, title=f'pip upgrade {package}')

    async def _run() -> None:
        try:
            await job.send('pip', 5, f'Resolving latest {package} on PyPI…')
            cmd = [sys.executable, '-m', 'pip', 'install', '--upgrade', '--no-input', package]
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            job.process = proc
            assert proc.stdout is not None
            line_count = 0
            while True:
                raw = await proc.stdout.readline()
                if not raw:
                    break
                line = raw.decode('utf-8', errors='replace').rstrip()
                if not line:
                    continue
                line_count += 1
                # Map progress to a vague 5–95 band as pip output streams in.
                # Real progress would need parsing; this is a usable proxy.
                pct = min(95, 5 + line_count)
                await job.send('pip', pct, line[:240])
            rc = await proc.wait()
            if rc != 0:
                await job.send_error(f'pip exited {rc}')
                return
            # Re-read installed version
            new_version: str | None
            try:
                new_version = installed_version(package)
            except PackageNotFoundError:
                new_version = None
            await job.send_done({
                'package': package,
                'new_version': new_version,
                'restart_required': True,
            })
        except asyncio.CancelledError:
            return
        except Exception as e:  # noqa: BLE001
            if not job.cancelled:
                await job.send_error(str(e) or 'pip upgrade failed')

    job.task = asyncio.create_task(_run())
    return {'job_id': job.id}


@router.post('/restart-backend')
async def restart_backend():
    """Schedule a detached ``systemctl restart beatmap-backend`` so the new
    pip-installed code becomes live. Returns immediately so the response can
    land before the service drops. The frontend polls /api/health to know
    when the backend is back."""
    if sys.platform != 'linux':
        raise HTTPException(
            501,
            f'Auto-restart only implemented on Linux (current: {sys.platform}). '
            f'Restart the dev server manually.',
        )
    if not Path('/usr/bin/systemctl').exists() and not Path('/bin/systemctl').exists():
        raise HTTPException(501, 'systemctl not on $PATH — restart manually')
    # Detach via setsid + nohup so the restart survives this process going
    # away. Schedule a 1s sleep so this response can reach the client.
    cmd = 'sleep 1 && systemctl restart beatmap-backend'
    try:
        # Popen with detached flags. We DON'T await this.
        import subprocess

        subprocess.Popen(
            ['nohup', 'sh', '-c', cmd],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            preexec_fn=os.setsid,
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f'Could not schedule restart: {e}')
    return {'scheduled': True}
