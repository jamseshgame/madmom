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
- **`bin/`** — 27 CLI programs supporting `single`, `batch`, `online`, and `pickle` modes. 25 are upstream madmom tools; `JamseshChartGenerator` and `JamseshMenu` are Jamsesh additions that emit Clone Hero-style chart/menu assets.

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

- **Backend** (`web/backend/`): FastAPI app with pydantic-settings config. Routers under `app/routers/`: `auth`, `beatmap`, `elevenlabs`, `feedback`, `game_songs`, `gem_meshes`, `generation_presets`, `highways`, `jobs`, `lyrics`, `pipeline`, `sample_packs`, `scene_events`, `stems`, `tracks`, `tutorial`, `users`, `versions`, `vocals`, `youtube` (mounted in `app/main.py`). Note: `routers/pipeline_order.py` is *not* a router — it's a tiny per-stage upstream-dependency lookup imported by the pipeline runner. Services under `app/services/` cover: audio processing (shells out to madmom CLI tools in `bin/`), chart generation + analysis (`chart_generator`, `chart_analyser`), the staged chart pipeline V2 (`pipeline/` package — see below), stem separation (`stems.py` + `separators.py` — see below), YouTube ingest (yt-dlp, with per-user cookie handling in `youtube_cookies.py`), lyrics + vocals alignment (faster-whisper, torchcrepe, syllabipy), Karplus-Strong "real-notes" sample-pack synthesis (`sample_packs`), Chatterbox TTS for tutorial VO (`tts`), per-beatmap reviewer `feedback` (CRUD + tagged aggregation), an Anthropic-backed `preset_proposer` that turns aggregated feedback into new generation-preset proposals, and GitHub publishing. The `gem_meshes` and `highways` routers stream FBX/texture assets straight from a sibling Unity project checkout (`JamseshQuest`) for the editor's 3D runway preview — paths live in `config.py` (`jamseshquest_gems_dir`, `jamseshquest_highways_dir`) and default to a Windows path; override per environment. `app/main.py` sets `WindowsProactorEventLoopPolicy` so Demucs/ffmpeg subprocesses work under Windows.

- **Frontend** (`web/frontend/`): React 18 + TypeScript + Vite + Tailwind CSS. Pages: `CreatePage`, `TracksPage`, `GameSongsPage`, `UsersPage`, `LogsPage`, `DependenciesPage`, `ChangelogPage`, `GenerationPresetsPage` (manage saved presets + review proposer suggestions). SPA with react-router-dom. The app version is hardcoded in `web/frontend/src/version.ts` (`STUDIO_VERSION`), currently `1.12.1` — there is no separate changelog file, so release notes live inline in this document. The in-browser beatmap editor lives in `web/frontend/src/components/BeatmapEditor.tsx` (plus `VocalEditor.tsx` for vocal beatmaps) — this is where the bulk of recent 1.x work has landed (tempo map, click track, hold-note authoring, waveform-on-highway overlay, stem vs. full-mix playback, three.js 3D runway preview, scoring HUD + live-play mode, custom scene events, per-beatmap real-notes sample packs, shift-click range select + alt-drag marquee selection, and a cross-track sequence library — `SequencesPanel.tsx` + pure helpers in `src/chart/selection.ts`/`sequences.ts`, backed by the `sequences` router persisting to `<upload_dir>/sequences.json`, with ×½/×1/×2 paste scaling and automatic tick-resolution rescale). Difficulty-section parse/serialize lives in `src/chart/chartio.ts`; slide grouping persists in editor-owned `[SlideMeta_<section>]` chart blocks (the game and Clone Hero ignore unknown sections) because the in-section `E slide` format carries no group identity — re-deriving slides from it heuristically is lossy and used to corrupt slides on every difficulty switch. Three.js (`three`, `@types/three`) drives the 3D view; `fflate` handles client-side zip work. Tutorial scene scripting, shared scene-event types, and the real-notes format are documented in `web/docs/SCENE_EVENTS.md`, `web/docs/TUTORIAL_SPEC.md`, and `web/docs/REALNOTES_SPEC.md`.
- **Deployment**: DigitalOcean droplet with nginx + systemd. `web/deploy.sh` provisions a fresh Ubuntu instance. nginx config in `web/nginx/`, systemd unit in `web/systemd/`.

### Chart Pipeline V2

`app/services/pipeline/` (shipped in web release 1.8.0) is a staged, resumable chart-generation pipeline. Stages are an enum (`registry.Stage`): `grid` → `onsets` → `pitches` → `quantized` → `lanes_expert` → `lanes_filtered` → `{lanes_hard, lanes_medium, lanes_easy}`. Per-stage upstream dependencies live in `routers/pipeline_order.py`; editing one stage marks downstream stages stale (`state.mark_downstream_stale`).

Each stage has multiple interchangeable **engines** under `pipeline/engines/`:
- Early stages have one file per engine (`grid_librosa`/`grid_allinone`/`grid_manual`, `onsets_aubio`/`onsets_basic_pitch`/`onsets_librosa`, `pitches_crepe`/`pitches_yin`/`pitches_basic_pitch`/`pitches_centroid`/`pitches_passthrough`). `pitches_centroid` is a drum-friendly spectral-centroid engine that maps kick/snare/cymbal to fake MIDI pitches so the lane engine's percentile binning spreads them across frets.
- Later stages are grouped by file: `quantized_engines.py` (snap onsets to grid), `lanes_engines.py` (`lanes_expert`/`lanes_filtered`), `playability_engines.py` and `difficulty_engines.py` (`lanes_hard`/`medium`/`easy`).

Engine modules side-effect-register themselves into `registry._REGISTRY` at import time via `register_engine`; the router and UI read the catalog through `engines_catalog()`. `engines/__init__.py` wraps optional engines (`grid_allinone`, `*_basic_pitch`, `onsets_aubio`, `pitches_crepe`) in `try/except ImportError` so they silently drop out of the catalog when their extras aren't installed — the catalog adapts to the install. Stage I/O is validated against pydantic schemas in `pipeline/schemas/`. The `pipeline` router mounts a uniform per-stage GET/POST/DELETE sub-resource (active file + versioned snapshots) from the `_make_stage_subrouter` factory, plus meta endpoints (engine catalog, pipeline state, `run-from`, `build-chart`). The final `build-chart` step serializes to a Clone Hero `notes.chart`.

The V2 pipeline has three frontend entry points: the editor's **Generate** tab (`frontend/src/components/pipeline/GenerateTab.tsx` + `StageCard.tsx`) for per-stage tweaking, and — since v1.9.0 — one-shot V2 modals on (a) the Tracks page's GENERATION section and (b) per-stem cog buttons on the Create page (`StemGenerationModal.tsx`). Both modals drive the whole pipeline end-to-end via the `/generate-beatmap-v2` endpoint on `tracks.py`; drums now route through V2 alongside the other stems. The modal uses saved **generation presets** (v1.10.0): built-in presets are baked into the `generation_presets` router; user-saved presets persist to `<upload_dir>/generation_presets.json`. A preset is a `{engine, params}` bundle for the five modal-surfaced stages (`onsets`, `pitches`, `quantized`, `lanes_expert`, `lanes_filtered`). Presets may carry an optional `stems` list to restrict which stem rows surface them (e.g. the built-in `drums-v1` preset uses `pitches_centroid` + a raised chord threshold and only shows on drums); the `GET /api/generation-presets?stem=<name>` query applies that filter.

Reviewers attach per-beatmap `feedback` (a rating + tags from `FEEDBACK_TAGS` + free text) via the `feedback` router; the admin-only `/api/feedback/.../aggregate` endpoint rolls this up per stem. The `preset_proposer` service feeds that aggregate, the current preset library, and the engine catalog to Claude (with prompt caching on the large prefix) and returns schema-validated new-preset proposals, surfaced for review on `GenerationPresetsPage`. This needs an Anthropic API key in the backend config.

### Stem separation engines

`app/services/stems.py` owns the Demucs backend plus the shared post-processing helpers (`collect_demucs_outputs`, `finalize_game_ready`, `_convert_to_ogg`, `_write_peaks_file`, `write_song_ini`). `app/services/separators.py` is the multi-engine layer on top and imports from it — keep that dependency one-directional.

Three engines, dispatched by `separate_with_engine(engine=..., params=...)`:

- **`hybrid`** (default) — a Roformer pass extracts vocals, then Demucs splits the *Roformer instrumental* (not the original mix) into the remaining instruments, so no instrument stem carries vocal bleed. Demucs's own vocals stem is discarded. Two full inference passes.
- **`audio-separator`** — [python-audio-separator](https://github.com/nomadkaraoke/python-audio-separator), wrapping MDXC (BS-Roformer / Mel-Band Roformer), MDX-Net, VR Arch and its own Demucs bridge. Driven as a subprocess via `sys.executable -c` (the CLI module has no `__main__` guard in every release and the console script isn't reliably on PATH under systemd). `--custom_output_names` forces deterministic output filenames; `_collect_separator_outputs` falls back to parsing the default `<track>_(Stem)_<model>.<ext>` convention. Most of its best models are two-stem.
- **`demucs`** — the original path. Still the only engine yielding six instrument stems in one pass.

Each engine declares a `list[Param]` schema (label, type, range, default, help, group, `advanced`, `applies_to`) exposed at `GET /api/stems/engines`. `SeparationSettings.tsx` renders that payload generically, so **adding a knob to `ENGINES` surfaces it in the UI with no frontend change**. Defaults are max-quality; `QUALITY_PRESETS` in the frontend layers Balanced/Fast on top.

The audio-separator model catalog is read at runtime via `Separator.list_supported_model_files()` and normalized by `_normalize_catalog`, which tolerates the several JSON shapes that package has shipped. audio-separator is optional: when it's absent, `audio_separator_catalog()` reports `available: False` with the pip command and the two new engines grey out — Demucs keeps working. It installs `--no-deps` from `requirements-extras.txt` because its metadata hard-requires `diffq`/`diffq-fixed` (broken sdist) and caps `beartype<0.19` (which cannot parse Roformer's type hints on Python 3.13+); both only affect its bundled Demucs bridge, which is unused. Its real dependencies live in `requirements.txt`.

**torch/torchaudio/torchvision are pinned in `constraints.txt`, not just `requirements.txt`.** `onnx2torch` (needed for MDX-Net) depends on `torchvision`, and an unpinned resolve drags torch up a minor version, which breaks `torchcodec` — the path `torchaudio.save()` takes — and every Demucs stem write with it.

**FFmpeg shared libraries.** torchcodec dlopen's `libavcodec`/`libavformat`, so `torchaudio.save()` (and therefore every Demucs stem write) fails with `Could not load libtorchcodec` unless they are loadable. Two distinct traps, both seen on Windows:

1. A **static** ffmpeg build (e.g. winget's `Gyan.FFmpeg`) ships only `ffmpeg.exe` — no DLLs. It passes an "is ffmpeg on PATH" check but torchcodec still can't load. Install a shared build (`Gyan.FFmpeg.Shared`, `brew install ffmpeg`, or apt's `ffmpeg`). `install.py` detects this and prints the per-OS fix.
2. Even with a shared build, the Windows DLL search only reliably reaches entries near the **front** of PATH — an install sitting at the end of a long PATH still fails. `stems.ffmpeg_lib_dir()` locates the directory by scanning PATH for `avcodec*.dll` / `libavcodec.so*`, and `stems.separator_child_env()` hoists it to the front of the environment handed to every separator subprocess. Both `_stream_demucs` and `_stream_audio_separator` use it, so the app no longer depends on PATH ordering.

### Multi-beatmap chart publishing

A single stem can carry multiple beatmaps (one primary + numbered alternates) and `chart_generator.merge_beatmap_charts` collapses them into one `notes.chart` at publish time. The first beatmap per stem gets unnumbered section names (`[ExpertDrums]`, `[HardSingle]`, …) and remains the CH-playable default; subsequent beatmaps for the same stem get numeric suffixes (`[ExpertDrums2]`, `[ExpertDrums3]`, …). All four difficulties of one beatmap share the same N, so a missing difficulty just omits its section without burning the slot. A trailing `[Beatmaps]` metadata block enumerates every emitted section with its source preset, active/alt tag, and beatmap_id — Clone Hero ignores unknown sections, but the editor reads it back to know which alternates to expose.

### Web Development Commands

```bash
# One-shot local-dev install (cross-platform):
python install.py
# Verifies prereqs (python>=3.9, node>=18, npm, ffmpeg, git; warns if deno
# is missing — yt-dlp needs Deno to solve YouTube's signature challenges,
# without it downloads fail with "Requested format is not available"),
# inits the
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
- **External services**: `ELEVENLABS_API_KEY`, `DO_API_TOKEN`, `ANTHROPIC_API_KEY` (+ `ANTHROPIC_MODEL`, `ANTHROPIC_MAX_TOKENS`) for the preset proposer
- **Stem separation**: `AUDIO_SEPARATOR_MODEL_DIR` (checkpoint cache for the Roformer / MDX-Net / VR engines; blank = `<upload_dir>/audio-separator-models`. Never point it at `/tmp`)
- **Library / Unity coupling**: `MADMOM_ROOT` (parent of `web/`, used to locate the `bin/` CLI tools), `JAMSESHQUEST_GEMS_DIR` and `JAMSESHQUEST_HIGHWAYS_DIR` (paths to the local Unity project the editor pulls 3D meshes/textures from — default to a Windows path)

## Licensing

Dual license: BSD for source code, CC BY-NC-SA 4.0 for model/data files. Commercial use of models requires contacting the original authors.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs pytest on Python 3.9–3.12 (Ubuntu). Tests require the models submodule to be initialized.
