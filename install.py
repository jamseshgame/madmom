"""Local-dev installer for the madmom + beatmap.jamsesh.co stack.

Single-command setup for running the FastAPI backend and Vite frontend on
your machine. Does NOT touch system packages (ffmpeg, git, node, python) —
those are prereqs you install via your OS package manager.

Usage:
    python install.py

What it does, in order:
    1. Verify prereqs are on PATH (python>=3.9, node>=18, npm, ffmpeg, git).
    2. Init the `madmom/models/` git submodule (pre-trained models).
    3. Create `web/backend/venv/` (skipped if it already exists).
    4. pip install madmom in editable mode + the backend's requirements.txt.
    5. Build the Cython extensions in place.
    6. npm install in `web/frontend/`.
    7. Copy `web/env.example` → `web/.env` if missing.

Heavy ML models (Chatterbox ~3 GB, Whisper "medium" ~1.5 GB, CREPE "full"
~30 MB) are NOT downloaded here — they lazy-load on first endpoint call.
Pre-rendered sample packs are committed at `web/backend/sample_packs_data/`
so the realnotes subsystem works out of the box.

Re-run safely: the script is idempotent. Existing venv, populated submodule,
and existing .env are left untouched.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

# Force UTF-8 so the section banners (≈, →, …) survive the Windows CP-1252
# console.
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except AttributeError:
    pass

REPO = Path(__file__).resolve().parent
WEB = REPO / 'web'
BACKEND = WEB / 'backend'
FRONTEND = WEB / 'frontend'
VENV = BACKEND / 'venv'

IS_WINDOWS = sys.platform == 'win32'
VENV_PY = VENV / ('Scripts' if IS_WINDOWS else 'bin') / ('python.exe' if IS_WINDOWS else 'python')
VENV_PIP = VENV / ('Scripts' if IS_WINDOWS else 'bin') / ('pip.exe' if IS_WINDOWS else 'pip')

# Windows ships npm + node as `.cmd` shims; everywhere else they're plain.
NPM = 'npm.cmd' if IS_WINDOWS else 'npm'
NODE = 'node.exe' if IS_WINDOWS else 'node'


# ── Helpers ───────────────────────────────────────────────────────────────


def _section(title: str) -> None:
    print()
    print(f'== {title} '.ljust(72, '='))


def _run(cmd: list[str], *, cwd: Optional[Path] = None, env: Optional[dict] = None) -> None:
    """Run a command, abort the installer on non-zero exit."""
    print(f'  $ {" ".join(str(c) for c in cmd)}')
    proc = subprocess.run(cmd, cwd=str(cwd) if cwd else None, env=env)
    if proc.returncode != 0:
        sys.exit(f'!! Command failed (exit {proc.returncode}): {cmd[0]}')


def _which(name: str) -> Optional[str]:
    return shutil.which(name)


def _version_of(cmd: list[str]) -> str:
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True, timeout=10)
        return out.strip().splitlines()[0]
    except (subprocess.CalledProcessError, OSError, subprocess.TimeoutExpired) as e:
        return f'(failed: {e})'


# ── Steps ─────────────────────────────────────────────────────────────────


def check_prereqs() -> None:
    _section('Prerequisites')
    problems: list[str] = []

    # Python ≥3.9 (the running interpreter; we'll use it for the venv too)
    py = sys.version_info
    print(f'  python    : {sys.version.split()[0]}  ({sys.executable})')
    if py < (3, 9):
        problems.append(f'Python 3.9+ required, found {py.major}.{py.minor}')

    # node + npm
    node = _which(NODE)
    npm = _which(NPM)
    print(f'  node      : {_version_of([NODE, "--version"]) if node else "MISSING"}')
    print(f'  npm       : {_version_of([NPM, "--version"]) if npm else "MISSING"}')
    if not node or not npm:
        problems.append('Install Node 18+ (https://nodejs.org / brew install node / winget install OpenJS.NodeJS)')

    # ffmpeg + ffprobe
    ffmpeg = _which('ffmpeg')
    print(f'  ffmpeg    : {"on PATH" if ffmpeg else "MISSING"}')
    if not ffmpeg:
        problems.append('Install ffmpeg (https://ffmpeg.org / brew install ffmpeg / winget install Gyan.FFmpeg)')

    # git
    git = _which('git')
    print(f'  git       : {_version_of(["git", "--version"]) if git else "MISSING"}')
    if not git:
        problems.append('Install git')

    if problems:
        print()
        print('!! Missing prerequisites:')
        for p in problems:
            print(f'   - {p}')
        sys.exit(1)


def init_submodule() -> None:
    _section('Pre-trained models (git submodule)')
    # Cheap check: a populated submodule has README.rst inside it.
    if (REPO / 'madmom' / 'models' / 'README.rst').exists():
        print('  already initialized — skipping')
        return
    _run(['git', 'submodule', 'update', '--init', '--remote', 'madmom/models'], cwd=REPO)


def create_venv() -> None:
    _section('Backend venv')
    if VENV_PY.exists():
        print(f'  venv already exists at {VENV}')
        return
    _run([sys.executable, '-m', 'venv', str(VENV)])
    _run([str(VENV_PY), '-m', 'pip', 'install', '--upgrade', 'pip'])


def install_backend() -> None:
    _section('Backend Python deps (Cython + madmom editable + requirements.txt)')
    # Cython + numpy headers must be present in the venv before setup.py
    # build_ext runs (PEP-517 isolation doesn't apply to a direct setup.py
    # invocation). The editable madmom install pulls numpy via its deps but
    # not Cython.
    _run([str(VENV_PY), '-m', 'pip', 'install', 'cython>=0.25'])
    _run([str(VENV_PY), '-m', 'pip', 'install', '-e', str(REPO)])
    _run([str(VENV_PY), '-m', 'pip', 'install', '-r', str(BACKEND / 'requirements.txt')])


def build_cython() -> None:
    _section('Cython extensions (in-place)')
    _run([str(VENV_PY), 'setup.py', 'build_ext', '--inplace'], cwd=REPO)


def install_frontend() -> None:
    _section('Frontend npm install')
    _run([NPM, 'install'], cwd=FRONTEND)


def scaffold_env() -> None:
    _section('Backend .env')
    env_file = WEB / '.env'
    example = WEB / '.env.example'
    if env_file.exists():
        print(f'  {env_file} already exists — leaving alone')
        return
    if not example.exists():
        print(f'  !! {example} missing; cannot scaffold .env')
        return
    shutil.copy2(example, env_file)
    print(f'  copied {example.name} -> .env')
    print('  Edit web/.env to set GITHUB_TOKEN, ELEVENLABS_API_KEY, JAMSESHQUEST_*_DIR paths.')


def print_next_steps() -> None:
    _section('Done. Next steps')
    py_rel = VENV_PY.relative_to(REPO)
    if IS_WINDOWS:
        run_py = f'{py_rel}'
    else:
        run_py = f'./{py_rel}'
    print('  Backend  (from web/backend/):')
    print(f'    {run_py} run.py')
    print('    → http://localhost:8000/docs')
    print()
    print('  Frontend (from web/frontend/):')
    print('    npm run dev')
    print('    → http://localhost:5173')
    print()
    print('  Tests    (from repo root):')
    print(f'    {run_py} -m pytest')


def main() -> None:
    check_prereqs()
    init_submodule()
    create_venv()
    install_backend()
    build_cython()
    install_frontend()
    scaffold_env()
    print_next_steps()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        sys.exit('\nAborted.')
