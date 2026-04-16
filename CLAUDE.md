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

## CI

GitHub Actions runs pytest on Python 3.9–3.12 (Ubuntu). Tests require the models submodule to be initialized.
