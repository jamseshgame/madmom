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

- **Backend** (`web/backend/`): FastAPI app with pydantic-settings config. Routers: `auth`, `beatmap`, `elevenlabs`, `game_songs`, `jobs`, `lyrics`, `stems`, `tracks`, `tutorial`, `users`, `versions`, `vocals`, `youtube`. Services handle audio processing (calling madmom CLI tools from `bin/`), chart generation, stem separation (via Demucs), YouTube ingest, lyrics/vocals alignment, and GitHub publishing. Config in `web/backend/app/config.py` reads from `.env` (see `web/.env.example`).
- **Frontend** (`web/frontend/`): React 18 + TypeScript + Vite + Tailwind CSS. Pages: `CreatePage`, `TracksPage`, `GameSongsPage`, `UsersPage`, `LogsPage`, `DependenciesPage`, `ChangelogPage`. SPA with react-router-dom. The in-browser beatmap editor lives in `web/frontend/src/components/BeatmapEditor.tsx` (plus `VocalEditor.tsx` for vocal beatmaps) — this is where the bulk of recent 1.x work has landed (tempo map, click track, hold-note authoring, waveform-on-highway overlay, stem vs. full-mix playback). Tutorial scene scripting and shared scene-event types are documented in `web/docs/SCENE_EVENTS.md` and `web/docs/TUTORIAL_SPEC.md`.
- **Deployment**: DigitalOcean droplet with nginx + systemd. `web/deploy.sh` provisions a fresh Ubuntu instance. nginx config in `web/nginx/`, systemd unit in `web/systemd/`.

### Web Development Commands

```bash
# Backend — from web/backend/
cp ../env.example ../.env  # first time: configure env vars
python -m venv venv && source venv/bin/activate  # or venv\Scripts\activate on Windows
pip install -e ../../ && pip install -r requirements.txt  # installs madmom + web deps
uvicorn app.main:app --reload  # runs on :8000

# Frontend — from web/frontend/
npm install
npm run dev   # Vite dev server on :5173
npm run build # production build (tsc + vite build)
```

### Web Environment Variables

The backend reads from `web/.env` (path overridable via `BEATMAP_ENV`). Key variables: `ALLOWED_ORIGINS`, `UPLOAD_DIR`, `MAX_UPLOAD_MB`, `GITHUB_TOKEN`, `MADMOM_ROOT`. See `web/.env.example` for the full list.

## Licensing

Dual license: BSD for source code, CC BY-NC-SA 4.0 for model/data files. Commercial use of models requires contacting the original authors.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs pytest on Python 3.9–3.12 (Ubuntu). Tests require the models submodule to be initialized.
