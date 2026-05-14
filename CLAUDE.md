# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

madmom is a Python audio signal processing library focused on music information retrieval (MIR). It provides reference implementations for beat tracking, onset detection, chord recognition, key recognition, tempo estimation, and piano note transcription. The library combines Python with Cython extensions for performance-critical paths and ships pre-trained models as a git submodule.

## Build & Development Commands

```bash
# Install in development mode (requires Cython, NumPy headers, and system deps)
# System deps (Ubuntu): sudo apt install ffmpeg libfftw3-dev
git submodule update --init --remote   # fetch pre-trained models
pip install -e .                        # editable install, compiles Cython extensions

# Build Cython extensions in-place (without full install)
python setup.py build_ext --inplace

# Run full test suite with doctests and coverage
pytest --cov --doctest-ignore-import-errors madmom tests

# Run a single test file
pytest tests/test_features_beats.py

# Run a single test function
pytest tests/test_features_beats.py::TestBeatTrackingFunction -v

# Pre-commit hooks (black, isort, flake8, pyupgrade, autoflake, prospector, codespell)
pre-commit run --all-files
```

The repo-root `conftest.py` puts both the repo root and `web/backend/` on `sys.path` so tests can use `from web.backend.app...` or the runtime-style `from app.services import ...` interchangeably. Run web-app tests from the repo root, not from `web/backend/`.

## Code Style

- **Black** formatter: line length 120, target Python 3.9+, single quotes (`-S` flag)
- **isort**: profile=black, line_length=120, custom section ordering (see `.isort.cfg`)
- All files include `from __future__ import annotations` (enforced by isort pre-commit hook)
- **Flake8**: max-line-length 120, max-complexity 18, ignores E203/W503
- F401 (unused imports) ignored in `__init__.py`; F405 (wildcard imports) ignored in `tests/`

## Architecture

### Processor Pattern

The central abstraction is `Processor` (in `madmom/processors.py`). All feature extractors follow a dual-class pattern:

- **Data class** (e.g., `Spectrogram`, `Beats`): operates on signals, holds results as numpy arrays
- **Processor class** (e.g., `SpectrogramProcessor`, `BeatTrackingProcessor`): inherits from `Processor`, implements `process()`, handles CLI argument parsing

Processors are composable via `SequentialProcessor` (chaining) and `ParallelProcessor` (fan-out). The `IOProcessor` connects input and output processors for the CLI tools in `bin/`.

### Package Layout

- **`madmom/audio/`** — Low-level signal processing: `Signal`, `FramedSignal`, `STFT`, `Spectrogram`, filters, chroma, comb filters, HPSS
- **`madmom/features/`** — High-level MIR tasks (beats, onsets, chords, downbeats, key, notes, tempo). Each module typically defines activation functions and post-processing (DBN, HMM, CRF, peak picking)
- **`madmom/ml/`** — Machine learning: HMM (Cython), CRF, GMM, neural network layers and activations
- **`madmom/evaluation/`** — Evaluation metrics for each task (beat, onset, chord, key, note, tempo)
- **`madmom/io/`** — Audio file I/O (via ffmpeg) and MIDI handling
- **`madmom/models/`** — Pre-trained model files (git submodule, must be initialized)
- **`bin/`** — 27 CLI programs supporting `single`, `batch`, `online`, and `pickle` modes

### Cython Extensions

Four modules are compiled from Cython for performance:
- `madmom/audio/comb_filters.pyx` — comb filter implementations
- `madmom/features/beats_crf.pyx` — CRF-based beat detection
- `madmom/ml/hmm.pyx` — Hidden Markov Model inference
- `madmom/ml/nn/layers.py` — neural network layers (compiled via Cython `.pxd` header)

All extensions require NumPy headers at build time.

### Doctest Normalization

The package registers custom doctest flags (`NORMALIZE_ARRAYS`, `NORMALIZE_FFT`) in `madmom/__init__.py` to handle cross-platform and cross-NumPy-version differences in array formatting. Use these flags in doctests when output includes floating-point arrays or FFT results.

## Dependencies

- **Runtime**: numpy, scipy (>=1.13), mido (MIDI)
- **Build**: cython (>=0.25), numpy (>2 for build, >=1.13.4 for runtime)
- **Optional**: pyfftw (faster FFT), pyaudio (live audio input)
- **System**: ffmpeg (audio decoding), libfftw3-dev (FFTW bindings)

## Web Application (beatmap.jamsesh.co)

The `web/` directory contains a separate web application built on top of madmom for audio analysis, beatmap generation, stem separation, and track management.

### Web Architecture

- **Backend** (`web/backend/`): FastAPI app with pydantic-settings config. Routers under `app/routers/`: `auth`, `beatmap`, `elevenlabs`, `game_songs`, `gem_meshes`, `highways`, `jobs`, `lyrics`, `sample_packs`, `scene_events`, `stems`, `tracks`, `tutorial`, `users`, `versions`, `vocals`, `youtube`. Services under `app/services/` cover: audio processing (shells out to madmom CLI tools in `bin/`), chart generation + analysis (`chart_generator`, `chart_analyser`), stem separation (Demucs), YouTube ingest (yt-dlp), lyrics + vocals alignment (faster-whisper, torchcrepe, syllabipy), Karplus-Strong "real-notes" sample-pack synthesis (`sample_packs`), Chatterbox TTS for tutorial VO (`tts`), and GitHub publishing. The `gem_meshes` and `highways` routers stream FBX/texture assets straight from a sibling Unity project checkout (`JamseshQuest`) for the editor's 3D runway preview — paths live in `config.py` (`jamseshquest_gems_dir`, `jamseshquest_highways_dir`) and default to a Windows path; override per environment. `app/main.py` sets `WindowsProactorEventLoopPolicy` so Demucs/ffmpeg subprocesses work under Windows.
- **Frontend** (`web/frontend/`): React 18 + TypeScript + Vite + Tailwind CSS. Pages: `CreatePage`, `TracksPage`, `GameSongsPage`, `UsersPage`, `LogsPage`, `DependenciesPage`, `ChangelogPage`. SPA with react-router-dom. The in-browser beatmap editor lives in `web/frontend/src/components/BeatmapEditor.tsx` (plus `VocalEditor.tsx` for vocal beatmaps) — this is where the bulk of recent 1.x work has landed (tempo map, click track, hold-note authoring, waveform-on-highway overlay, stem vs. full-mix playback, three.js 3D runway preview, scoring HUD + live-play mode, custom scene events, per-beatmap real-notes sample packs). Three.js (`three`, `@types/three`) drives the 3D view; `fflate` handles client-side zip work. Tutorial scene scripting and shared scene-event types are documented in `web/docs/SCENE_EVENTS.md` and `web/docs/TUTORIAL_SPEC.md`.
- **Deployment**: DigitalOcean droplet with nginx + systemd. `web/deploy.sh` provisions a fresh Ubuntu instance. nginx config in `web/nginx/`, systemd unit in `web/systemd/`.

### Web Development Commands

```bash
# One-shot local-dev install (cross-platform):
python install.py
# Verifies prereqs (python>=3.9, node>=18, npm, ffmpeg, git), inits the
# madmom/models git submodule, creates web/backend/venv, pip-installs
# Cython + madmom (editable) + requirements.txt, builds the Cython
# extensions in-place, runs npm install, and scaffolds web/.env from
# .env.example. Idempotent — safe to re-run.

# Backend dev server — from web/backend/:
venv/Scripts/python.exe run.py     # Windows
./venv/bin/python run.py           # macOS/Linux
# → http://localhost:8000  (Swagger at /docs)

# Frontend dev server — from web/frontend/:
npm run dev    # Vite dev server on :5173
npm run build  # production build (tsc + vite build)
```

The backend install is heavy: `torch`, `torchcodec`, `demucs`, `chatterbox-tts`, `faster-whisper`, `torchcrepe`. Several models (Chatterbox ~3 GB, Whisper "medium" ~1.5 GB, CREPE "full" ~30 MB) lazy-download on the first call to their respective endpoints — first-request latency is dominated by the download, not inference.

### Web Environment Variables

The backend reads from `web/.env` (path overridable via `BEATMAP_ENV`). See `web/.env.example` and `web/backend/app/config.py` for the full list. Notable variables:

- **Server**: `HOST`, `PORT`, `ALLOWED_ORIGINS`
- **File handling**: `UPLOAD_DIR`, `MAX_UPLOAD_MB`, `JOB_TTL_MINUTES`
- **Auth**: `STUDIO_USERNAME`, `STUDIO_PASSWORD` (seed admin)
- **GitHub publishing**: `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH`, `GITHUB_INBOX_PREFIX`
- **External services**: `ELEVENLABS_API_KEY`, `DO_API_TOKEN`
- **Library / Unity coupling**: `MADMOM_ROOT` (parent of `web/`, used to locate the `bin/` CLI tools), `JAMSESHQUEST_GEMS_DIR` and `JAMSESHQUEST_HIGHWAYS_DIR` (paths to the local Unity project the editor pulls 3D meshes/textures from — default to a Windows path)

## Licensing

Dual license: BSD for source code, CC BY-NC-SA 4.0 for model/data files. Commercial use of models requires contacting the original authors.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs pytest on Python 3.9–3.12 (Ubuntu). Tests require the models submodule to be initialized.
