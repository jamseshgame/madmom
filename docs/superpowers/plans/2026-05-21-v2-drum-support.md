# V2 Pipeline Drum Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable V2 pipeline for the drums stem so the cog UI, presets, and per-stage engine controls work for drums identically to other stems.

**Architecture:** Add a new `pitches_centroid` engine that mirrors what the legacy drum pipeline does (spectral centroid → fake-MIDI), drop in a `drums-v1` built-in preset that bundles centroid + drum-tuned defaults, add `?stem=` filter to the presets endpoint so drum-only presets surface only on drum rows, and remove the four `stem !== 'drums'` exclusions across the codebase. The V2 chart serializer and publish-time section-renamer are unchanged — drums go through V2 the same way as guitar.

**Tech Stack:** FastAPI (Python 3.9+), pydantic-settings, pytest. React 18 + TypeScript + Vite. Vitest for any new frontend unit tests (none needed in this plan). madmom audio library via the bundled `bin/JamseshChartGenerator` for the centroid helpers.

**Spec:** `docs/superpowers/specs/2026-05-21-v2-drum-support-design.md`

---

## File Map

| Path | Action | Purpose |
|---|---|---|
| `web/backend/app/services/pipeline/engines/pitches_centroid.py` | Create | New PITCHES-stage engine: spectral centroid → fake-MIDI per onset |
| `web/backend/app/services/pipeline/engines/__init__.py` | Modify | Register the new engine (side-effect import next to `pitches_yin`) |
| `web/backend/tests/test_pitches_centroid.py` | Create | Unit tests for the engine with synthesized audio |
| `web/backend/app/routers/generation_presets.py` | Modify | Add `drums-v1` to `BUILTIN_PRESETS`; add `stem` query filter on `GET /` |
| `web/backend/tests/test_generation_presets.py` | Create | Endpoint tests covering universal-vs-stem-filtered behavior |
| `web/backend/app/routers/tracks.py` | Modify | Remove V2 drums guard (lines 483-484); update docstring |
| `web/frontend/src/components/pipeline/generationTypes.ts` | Modify | Add optional `stems?: string[]` field to `GenerationPreset` |
| `web/frontend/src/components/pipeline/GenerationSettings.tsx` | Modify | Accept `stem: string` prop; thread into the presets fetch URL |
| `web/frontend/src/components/StemGenerationModal.tsx` | Modify | Pass `stem` prop through to `<GenerationSettings>` |
| `web/frontend/src/pages/TracksPage.tsx` | Modify | `BeatmapPanel` passes `stem` to `<GenerationSettings>`; remove `stem !== 'drums'` from its render gate |
| `web/frontend/src/components/StemResult.tsx` | Modify | Remove `stem !== 'drums'` from cog gate, badge gate, and `useV2` condition |

---

## Task 1: Backend — `pitches_centroid` engine (TDD)

**Files:**
- Create: `web/backend/app/services/pipeline/engines/pitches_centroid.py`
- Modify: `web/backend/app/services/pipeline/engines/__init__.py`
- Create: `web/backend/tests/test_pitches_centroid.py`

- [ ] **Step 1: Write the failing tests first**

Create `web/backend/tests/test_pitches_centroid.py`:

```python
"""Unit tests for the centroid pitch engine.

The engine wraps the legacy chart_generator's spectral-centroid helpers
to produce per-onset fake-MIDI values. Tests use synthesized audio
(low-frequency sine vs high-frequency noise) to confirm the engine
spreads its output across the configured MIDI range monotonically with
centroid frequency.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from app.services.pipeline.engines.pitches_centroid import run_centroid


@pytest.fixture
def tmp_audio(tmp_path: Path):
    """Factory: write a numpy mono signal to a .wav and return its path."""
    def _make(signal: np.ndarray, sr: int = 44100) -> Path:
        out = tmp_path / 'test.wav'
        sf.write(str(out), signal, sr)
        return out
    return _make


def _onsets_payload(times_s: list[float]) -> dict:
    return {'onsets': [{'time_s': float(t)} for t in times_s]}


def _silence(seconds: float, sr: int = 44100) -> np.ndarray:
    return np.zeros(int(seconds * sr), dtype=np.float32)


def _sine_pulses(freqs_hz: list[float], pulse_ms: int = 100, gap_ms: int = 400, sr: int = 44100) -> np.ndarray:
    """One sine burst at each frequency, separated by silence. Returns the
    concatenated mono signal."""
    parts = []
    pulse_n = int(pulse_ms / 1000 * sr)
    gap_n = int(gap_ms / 1000 * sr)
    t = np.arange(pulse_n) / sr
    env = np.hanning(pulse_n).astype(np.float32)
    for f in freqs_hz:
        pulse = (0.5 * np.sin(2 * np.pi * f * t) * env).astype(np.float32)
        parts.append(pulse)
        parts.append(np.zeros(gap_n, dtype=np.float32))
    return np.concatenate(parts)


def _pulse_onset_times(num: int, pulse_ms: int = 100, gap_ms: int = 400) -> list[float]:
    """Onset start times for _sine_pulses output — one onset per pulse start."""
    step_s = (pulse_ms + gap_ms) / 1000.0
    return [i * step_s + 0.005 for i in range(num)]  # +5 ms inside the pulse


def test_empty_onsets_returns_empty_per_onset(tmp_audio):
    path = tmp_audio(_silence(1.0))
    out = run_centroid(path, {'onsets': _onsets_payload([])['onsets']}, {}, lambda *a: None)
    assert out['engine'] == 'centroid'
    assert out['per_onset'] == []


def test_silent_audio_yields_none_midi(tmp_audio):
    path = tmp_audio(_silence(2.0))
    payload = _onsets_payload([0.1, 0.5, 1.0])
    out = run_centroid(path, payload, {}, lambda *a: None)
    assert len(out['per_onset']) == 3
    for entry in out['per_onset']:
        assert entry['dominant_midi'] is None
        assert entry['polyphony'] == 1


def test_low_frequency_pulses_yield_low_midi(tmp_audio):
    # 100 Hz pulses — should map to the low end of the configured MIDI range
    signal = _sine_pulses([100.0, 100.0, 100.0])
    path = tmp_audio(signal)
    payload = _onsets_payload(_pulse_onset_times(3))
    out = run_centroid(path, payload, {}, lambda *a: None)
    midis = [e['dominant_midi'] for e in out['per_onset'] if e['dominant_midi'] is not None]
    assert len(midis) >= 2, f'expected ≥2 non-None midis, got {midis}'
    # Default range maps centroid 100 Hz → fake-MIDI near 40 (bottom)
    assert max(midis) <= 55, f'low-freq pulses should map to low MIDI; got {midis}'


def test_high_frequency_pulses_yield_high_midi(tmp_audio):
    # 6 kHz pulses — should map to the high end of the configured MIDI range
    signal = _sine_pulses([6000.0, 6000.0, 6000.0])
    path = tmp_audio(signal)
    payload = _onsets_payload(_pulse_onset_times(3))
    out = run_centroid(path, payload, {}, lambda *a: None)
    midis = [e['dominant_midi'] for e in out['per_onset'] if e['dominant_midi'] is not None]
    assert len(midis) >= 2, f'expected ≥2 non-None midis, got {midis}'
    assert min(midis) >= 70, f'high-freq pulses should map to high MIDI; got {midis}'


def test_mixed_frequencies_spread_across_midi_range(tmp_audio):
    # 100 Hz then 6 kHz pulses — low should map low, high should map high
    signal = _sine_pulses([100.0, 6000.0, 100.0, 6000.0])
    path = tmp_audio(signal)
    payload = _onsets_payload(_pulse_onset_times(4))
    out = run_centroid(path, payload, {}, lambda *a: None)
    midis = [e['dominant_midi'] for e in out['per_onset']]
    valid = [m for m in midis if m is not None]
    assert len(valid) >= 3
    assert max(valid) - min(valid) >= 15, f'mixed freqs should span ≥15 MIDI; got {midis}'


def test_per_onset_schema_matches_yin(tmp_audio):
    """Every entry must carry the same five keys other PITCHES engines emit."""
    signal = _sine_pulses([440.0, 440.0])
    path = tmp_audio(signal)
    payload = _onsets_payload(_pulse_onset_times(2))
    out = run_centroid(path, payload, {}, lambda *a: None)
    for entry in out['per_onset']:
        assert set(entry.keys()) == {
            'time_s', 'dominant_midi', 'dominant_confidence', 'polyphony', 'all_pitches_midi',
        }
        assert entry['polyphony'] == 1


def test_audio_path_none_raises(tmp_audio):
    with pytest.raises(ValueError, match='centroid requires a stem audio file'):
        run_centroid(None, _onsets_payload([0.1]), {}, lambda *a: None)


def test_engine_registers_for_pitches_stage():
    """Importing the engine module side-registers it for the PITCHES stage."""
    from app.services.pipeline.registry import Stage, get_engine
    from app.services.pipeline.engines import pitches_centroid  # noqa: F401
    spec = get_engine(Stage.PITCHES, 'centroid')
    assert spec is not None
    assert spec.engine_id == 'centroid'
    assert spec.display_name == 'Spectral centroid (drum-friendly)'
    assert 'min_centroid_hz' in spec.params_schema
    assert 'max_centroid_hz' in spec.params_schema
    assert 'window_ms' in spec.params_schema
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `web/backend/`:
```
cd web/backend && venv/Scripts/python.exe -m pytest tests/test_pitches_centroid.py -v 2>&1 | tail -30
```
(On macOS/Linux substitute `venv/bin/python` for `venv/Scripts/python.exe`.)

Expected: import error / module not found for `pitches_centroid`.

- [ ] **Step 3: Create the engine module**

Create `web/backend/app/services/pipeline/engines/pitches_centroid.py`:

```python
"""S3 engine: `centroid` — onset spectral centroids as fake-MIDI values.

Mirrors what the legacy chart_generator does for drum stems: spectral
centroid is the audio's "brightness" at each onset (kick = low, snare =
mid, cymbal = high). Mapping that to a fake-MIDI value lets the lane
engine's percentile binning spread drum hits across frets the same way
it spreads pitched notes for guitar.

Works for non-drum stems too — it gives a centroid-based alternative
to YIN/CREPE for any stem, but the display name flags drums as the
primary use case.
"""
from __future__ import annotations

import datetime as dt
import math
from pathlib import Path
from typing import Any, Callable

import numpy as np

from ..registry import EngineSpec, Stage, register_engine


_PARAMS_SCHEMA = {
    'min_centroid_hz': {'type': 'number', 'min': 50, 'max': 500, 'step': 10, 'default': 100,
                        'label': 'Min expected centroid (Hz)'},
    'max_centroid_hz': {'type': 'number', 'min': 2000, 'max': 12000, 'step': 100, 'default': 8000,
                        'label': 'Max expected centroid (Hz)'},
    'window_ms': {'type': 'number', 'min': 5, 'max': 200, 'step': 5, 'default': 30,
                  'label': 'Window around onset (ms)'},
}


def _centroid_to_fake_midi(c_hz: float, min_hz: float, max_hz: float) -> int:
    """Log-scale centroid (Hz) → MIDI value in the range [40, 90].

    Lane engine's percentile binning normalises whatever distribution it
    gets, so the absolute MIDI numbers don't matter — what matters is
    monotonicity (higher centroid → higher fake-MIDI)."""
    if not math.isfinite(c_hz) or c_hz <= 0:
        return 40
    c = max(min_hz, min(max_hz, float(c_hz)))
    span_log = math.log2(max(max_hz / min_hz, 1.0001))  # avoid /0
    frac = math.log2(c / min_hz) / span_log
    return int(40 + max(0.0, min(1.0, frac)) * 50)


def run_centroid(
    audio_path: Path | None,
    upstream: dict,
    params: dict,
    on_progress: Callable[[str, int, str], None],
) -> dict[str, Any]:
    if audio_path is None:
        raise ValueError('centroid requires a stem audio file')

    onsets_payload = upstream.get('onsets')
    if onsets_payload is None:
        raise ValueError('S3 requires upstream onsets')

    onset_times = [float(o['time_s']) for o in onsets_payload['onsets']]
    if not onset_times:
        return {
            'engine': 'centroid', 'params': params,
            'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
            'per_onset': [],
        }

    min_hz = float(params.get('min_centroid_hz', 100))
    max_hz = float(params.get('max_centroid_hz', 8000))
    if max_hz <= min_hz:
        max_hz = min_hz + 1.0
    # window_ms is informational for the schema; the legacy helpers compute
    # centroids per frame at 100 fps so the effective window is one frame
    # (~10 ms). Keeping the param for forward compatibility.

    on_progress('analyse', 30, 'Computing spectral centroids…')

    # Re-use the legacy generator's compute_*_centroids helpers via the
    # same lazy-import path chart_generator.py uses. Avoids re-implementing
    # the (well-tested) spectral analysis.
    from ...chart_generator import _load_generator
    from madmom.audio.spectrogram import Spectrogram

    gen = _load_generator()
    spec = Spectrogram(str(audio_path), frame_size=4096, fps=100, num_channels=1, sample_rate=44100)
    centroids, spreads = gen.compute_spectral_centroids(spec, 100)
    onset_arr = np.asarray(onset_times, dtype=np.float64)
    onset_centroids, onset_spreads = gen.compute_onset_centroids(onset_arr, centroids, spreads, 100)

    on_progress('analyse', 70, f'Mapping {len(onset_times)} onsets to fake-MIDI…')

    per_onset = []
    for i, t in enumerate(onset_times):
        c = float(onset_centroids[i]) if i < len(onset_centroids) else float('nan')
        if not math.isfinite(c) or c <= 0:
            per_onset.append({
                'time_s': t, 'dominant_midi': None,
                'dominant_confidence': None, 'polyphony': 1, 'all_pitches_midi': [],
            })
            continue
        midi = _centroid_to_fake_midi(c, min_hz, max_hz)
        # Spread (variance) inversely correlates with confidence: a peaky
        # centroid distribution = high confidence in the centroid value.
        spread = float(onset_spreads[i]) if i < len(onset_spreads) else 1.0
        conf = float(1.0 / (1.0 + spread))
        per_onset.append({
            'time_s': t, 'dominant_midi': midi,
            'dominant_confidence': conf, 'polyphony': 1, 'all_pitches_midi': [midi],
        })

    on_progress('done', 100, f'{len(per_onset)} per-onset entries')
    return {
        'engine': 'centroid', 'params': params,
        'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
        'per_onset': per_onset,
    }


register_engine(Stage.PITCHES, EngineSpec(
    id='centroid', display_name='Spectral centroid (drum-friendly)',
    params_schema=_PARAMS_SCHEMA, runner=run_centroid,
))
```

- [ ] **Step 4: Register the engine in `engines/__init__.py`**

Find the existing pitch-engine imports (around line 25-27):

```python
from . import pitches_passthrough  # noqa: F401

from . import pitches_yin  # noqa: F401
```

Add the centroid import immediately after `pitches_yin`:

```python
from . import pitches_passthrough  # noqa: F401

from . import pitches_yin  # noqa: F401

from . import pitches_centroid  # noqa: F401
```

No `try/except ImportError` wrapper — `madmom` is mandatory and the bundled `bin/JamseshChartGenerator` is always present.

- [ ] **Step 5: Run tests to verify they pass**

```
cd web/backend && venv/Scripts/python.exe -m pytest tests/test_pitches_centroid.py -v 2>&1 | tail -30
```

Expected: 8 passing tests.

If `test_silent_audio_yields_none_midi` fails because `compute_spectral_centroids` returns small non-zero numerical noise instead of zeros on silent input, relax the check in the engine: treat centroids below `min_centroid_hz * 0.5` as effectively silent → `dominant_midi: None`. Reflect that adjustment in the engine and re-run.

- [ ] **Step 6: Commit**

```bash
git add web/backend/app/services/pipeline/engines/pitches_centroid.py \
        web/backend/app/services/pipeline/engines/__init__.py \
        web/backend/tests/test_pitches_centroid.py
git commit -m "feat(pipeline): pitches_centroid engine for drum-friendly lane variation

Wraps the legacy generator's compute_spectral_centroids /
compute_onset_centroids helpers and maps centroid Hz to fake-MIDI
values (log-scale, 40-90 range). Drum hits with different brightness
(kick = low, snare = mid, cymbal = high) get spread across the MIDI
space the lane engine bins, mirroring legacy drum chart variation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Backend — `drums-v1` preset + stem-aware filter (TDD)

**Files:**
- Modify: `web/backend/app/routers/generation_presets.py`
- Create: `web/backend/tests/test_generation_presets.py`

- [ ] **Step 1: Write the failing tests**

Create `web/backend/tests/test_generation_presets.py`:

```python
"""Endpoint tests for /api/generation-presets.

Covers built-in vs user-saved listing, the new stem-aware filter (so
drum-only presets surface only when the modal is open on a drum row),
and save/delete protections.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """Point the user-presets file at a fresh tmp dir so tests don't touch
    the real generation_presets.json."""
    from app import config
    monkeypatch.setattr(config.settings, 'upload_dir', tmp_path)
    return TestClient(app)


def _names(presets: list[dict]) -> set[str]:
    return {p['name'] for p in presets}


def test_list_returns_all_builtins_when_unfiltered(client: TestClient):
    r = client.get('/api/generation-presets')
    assert r.status_code == 200
    names = _names(r.json())
    assert 'v1' in names
    assert 'drums-v1' in names


def test_drums_filter_includes_universal_and_drum_presets(client: TestClient):
    r = client.get('/api/generation-presets?stem=drums')
    assert r.status_code == 200
    names = _names(r.json())
    assert 'v1' in names              # universal preset, always included
    assert 'drums-v1' in names        # explicitly stems=['drums']


def test_guitar_filter_excludes_drum_only_presets(client: TestClient):
    r = client.get('/api/generation-presets?stem=guitar')
    assert r.status_code == 200
    names = _names(r.json())
    assert 'v1' in names
    assert 'drums-v1' not in names    # stems=['drums'] excludes guitar


def test_bogus_stem_returns_only_universal_presets(client: TestClient):
    r = client.get('/api/generation-presets?stem=accordion')
    assert r.status_code == 200
    names = _names(r.json())
    assert 'v1' in names
    assert 'drums-v1' not in names


def test_drums_v1_uses_centroid_pitch_engine(client: TestClient):
    r = client.get('/api/generation-presets?stem=drums')
    drums_v1 = next(p for p in r.json() if p['name'] == 'drums-v1')
    assert drums_v1['stems'] == ['drums']
    assert drums_v1['generation']['pitches']['engine'] == 'centroid'
    assert drums_v1['generation']['lanes_expert']['params'].get('chord_polyphony_threshold') == 6


def test_user_saved_preset_appears_in_all_filtered_lists(client: TestClient):
    """User-saved presets don't carry a `stems` field, so they're universal."""
    save = client.post('/api/generation-presets', json={
        'name': 'my-test-preset',
        'description': 'test',
        'generation': {
            'onsets': {'engine': 'librosa-onset', 'params': {}},
            'pitches': {'engine': 'yin', 'params': {}},
            'quantized': {'engine': 'metric-weighted', 'params': {}},
            'lanes_expert': {'engine': 'section-sliding', 'params': {}},
            'lanes_filtered': {'engine': 'identity', 'params': {}},
        },
    })
    assert save.status_code == 200

    for stem in ('drums', 'guitar', 'bass'):
        r = client.get(f'/api/generation-presets?stem={stem}')
        assert 'my-test-preset' in _names(r.json()), f'missing from {stem} filter'


def test_cannot_overwrite_builtin_drums_v1(client: TestClient):
    r = client.post('/api/generation-presets', json={
        'name': 'drums-v1',
        'description': 'attempt to overwrite',
        'generation': {
            'onsets': {'engine': 'librosa-onset', 'params': {}},
            'pitches': {'engine': 'yin', 'params': {}},
            'quantized': {'engine': 'metric-weighted', 'params': {}},
            'lanes_expert': {'engine': 'section-sliding', 'params': {}},
            'lanes_filtered': {'engine': 'identity', 'params': {}},
        },
    })
    assert r.status_code == 409
```

- [ ] **Step 2: Run tests to verify they fail**

```
cd web/backend && venv/Scripts/python.exe -m pytest tests/test_generation_presets.py -v 2>&1 | tail -30
```

Expected: most tests fail. Specifically:
- `test_list_returns_all_builtins_when_unfiltered` may fail on `drums-v1` not in names
- `test_drums_filter_*` tests fail because the endpoint doesn't accept `?stem`
- `test_drums_v1_uses_centroid_pitch_engine` fails because `drums-v1` doesn't exist

- [ ] **Step 3: Add the `drums-v1` preset to `BUILTIN_PRESETS`**

In `web/backend/app/routers/generation_presets.py`, immediately after the `v11 — chain playability` entry (around line 193, before the closing `]` of `BUILTIN_PRESETS`), insert:

```python
    {
        'name': 'drums-v1',
        'description': 'Drum-friendly defaults — spectral centroid pitch + raised chord threshold',
        'builtin': True,
        # The `stems` field restricts which stem rows show this preset.
        # Omit or set to None for universal presets (everything above).
        'stems': ['drums'],
        'generation': {
            'onsets': {'engine': 'librosa-onset', 'params': {}},
            # Centroid engine matches what the legacy drum pipeline does:
            # spectral centroid → fake-MIDI, so kick/snare/cymbal get spread
            # across frets via the lane engine's percentile binning.
            'pitches': {'engine': 'centroid', 'params': {}},
            'quantized': {'engine': 'metric-weighted', 'params': {}},
            # Drum hits are almost always single events; raise the chord
            # threshold above where the centroid distribution would push
            # the lane engine into 2-fret chords.
            'lanes_expert': {'engine': 'section-sliding', 'params': {'chord_polyphony_threshold': 6}},
            'lanes_filtered': {'engine': 'identity', 'params': {}},
        },
    },
```

- [ ] **Step 4: Add the `stem` query filter to the GET endpoint**

In the same file, replace the existing `list_presets` handler (currently lines 212-215):

```python
@router.get('')
async def list_presets() -> list[dict[str, Any]]:
    """Built-ins first, then user-saved presets."""
    return list(BUILTIN_PRESETS) + _load_user_presets()
```

with the filtered version:

```python
@router.get('')
async def list_presets(stem: str | None = Query(default=None)) -> list[dict[str, Any]]:
    """Built-ins first, then user-saved presets.

    Optional `stem` query param filters presets to those applicable to the
    given stem — a preset is included when it has no `stems` field
    (universal) OR its `stems` list contains the requested stem. User-saved
    presets are always universal in this scope.
    """
    all_presets = list(BUILTIN_PRESETS) + _load_user_presets()
    if stem is None:
        return all_presets
    return [p for p in all_presets if not p.get('stems') or stem in p['stems']]
```

Add the `Query` import at the top of the file (it's not currently imported). Update the existing FastAPI import line:

```python
from fastapi import APIRouter, Body, HTTPException
```

to:

```python
from fastapi import APIRouter, Body, HTTPException, Query
```

- [ ] **Step 5: Run tests to verify they pass**

```
cd web/backend && venv/Scripts/python.exe -m pytest tests/test_generation_presets.py -v 2>&1 | tail -30
```

Expected: 7 passing tests.

- [ ] **Step 6: Commit**

```bash
git add web/backend/app/routers/generation_presets.py \
        web/backend/tests/test_generation_presets.py
git commit -m "feat(presets): drums-v1 built-in + stem query filter on GET endpoint

drums-v1 bundles the centroid pitch engine plus chord_polyphony_threshold=6
(drums rarely chord). It carries stems=['drums'] so the new ?stem= filter
on GET /api/generation-presets surfaces it only for drum rows. Universal
presets (v1-v11 + user-saved) appear regardless of stem.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Backend — Remove the V2 drums guard

**Files:**
- Modify: `web/backend/app/routers/tracks.py`

- [ ] **Step 1: Remove the guard**

In `web/backend/app/routers/tracks.py`, find the `generate_beatmap_v2` function (around line 428). At approximately lines 483-484 you'll find:

```python
    if stem == 'drums':
        raise HTTPException(400, 'Drums stem is not supported by V2 pipeline; use /generate-beatmap')
```

Delete those two lines.

- [ ] **Step 2: Update the function docstring**

A few lines above the deleted block (around line 474-480), the function docstring currently includes:

```python
    """Generate a beatmap by driving the V2 staged pipeline end-to-end.

    Unlike `/generate-beatmap` (legacy), this endpoint runs each V2 stage in
    sequence with the caller-selected engines and writes the final
    notes.chart via the V2 serializer. Drums stem is rejected — drums use
    the legacy endpoint for single-hit output.
    """
```

Replace the trailing sentence ("Drums stem is rejected — drums use the legacy endpoint for single-hit output.") with:

```python
    """Generate a beatmap by driving the V2 staged pipeline end-to-end.

    Unlike `/generate-beatmap` (legacy), this endpoint runs each V2 stage in
    sequence with the caller-selected engines and writes the final
    notes.chart via the V2 serializer. All stems including drums go through
    V2 with single-hit semantics — V2 lane engines emit sustain=0 and no
    slide notes by design, matching what the legacy single_hits_only flag
    produced for drums.
    """
```

- [ ] **Step 3: Verify the existing tests don't regress**

```
cd web/backend && venv/Scripts/python.exe -m pytest tests/test_generate_beatmap_v2.py -v 2>&1 | tail -20
```

Expected: most tests pass. One existing test (`test_generate_beatmap_v2_rejects_drums` at `tests/test_generate_beatmap_v2.py:127`) will now FAIL because the guard it was checking is gone.

- [ ] **Step 4: Delete or rewrite the `test_generate_beatmap_v2_rejects_drums` test**

Read `web/backend/tests/test_generate_beatmap_v2.py` around line 127 to find the test. Delete it entirely — drums is no longer rejected, so the test is wrong by construction.

If the test has imports that become unused as a result, clean them up too.

- [ ] **Step 5: Re-run the V2 tests**

```
cd web/backend && venv/Scripts/python.exe -m pytest tests/test_generate_beatmap_v2.py -v 2>&1 | tail -20
```

Expected: all remaining tests pass.

- [ ] **Step 6: Commit**

```bash
git add web/backend/app/routers/tracks.py web/backend/tests/test_generate_beatmap_v2.py
git commit -m "feat(tracks): allow drums stem through V2 pipeline

Removes the unconditional 400 reject on stem='drums' in the
generate-beatmap-v2 handler. V2 already produces single-hit output
(sustain=0, no slides) by design, matching what legacy single_hits_only
produced for drums. Drum lane variation is provided by the new centroid
pitch engine + drums-v1 preset shipped in earlier commits.

Drops the obsolete test_generate_beatmap_v2_rejects_drums test.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Frontend — Add `stems` to `GenerationPreset` + thread `stem` prop through `GenerationSettings`

**Files:**
- Modify: `web/frontend/src/components/pipeline/generationTypes.ts`
- Modify: `web/frontend/src/components/pipeline/GenerationSettings.tsx`

- [ ] **Step 1: Update the `GenerationPreset` interface**

In `web/frontend/src/components/pipeline/generationTypes.ts`, find the existing interface (around lines 28-33):

```ts
export interface GenerationPreset {
  name: string
  description?: string
  builtin?: boolean
  generation: GenerationState
}
```

Add the optional `stems` field:

```ts
export interface GenerationPreset {
  name: string
  description?: string
  builtin?: boolean
  // Optional stem allow-list. Omitted/undefined = universal (preset
  // appears for every stem). When set, the backend filters this preset
  // out of GET /api/generation-presets?stem=... responses whose stem
  // isn't in the list.
  stems?: string[]
  generation: GenerationState
}
```

- [ ] **Step 2: Update `GenerationSettings` props + fetch URL**

In `web/frontend/src/components/pipeline/GenerationSettings.tsx`, find the props interface:

```ts
interface GenerationSettingsProps {
  generation: GenerationState
  activePreset: string
  onGenerationChange: (next: GenerationState) => void
  onActivePresetChange: (name: string) => void
}
```

Add a `stem` prop:

```ts
interface GenerationSettingsProps {
  generation: GenerationState
  activePreset: string
  onGenerationChange: (next: GenerationState) => void
  onActivePresetChange: (name: string) => void
  // The stem this settings panel is generating for. Threaded into the
  // presets fetch URL so the backend's stem filter narrows the dropdown
  // to applicable presets.
  stem: string
}
```

Update the function signature to destructure the new prop:

```ts
export default function GenerationSettings({
  generation,
  activePreset,
  onGenerationChange,
  onActivePresetChange,
  stem,
}: GenerationSettingsProps) {
```

Find the initial-presets-load `useEffect` (the one with `AbortController` that fetches `/api/generation-presets`, after the engines effect). Currently:

```ts
useEffect(() => {
  const ctrl = new AbortController()
  fetch('/api/generation-presets', { signal: ctrl.signal })
    .then((r) => r.json())
    .then((list: GenerationPreset[]) => setPresets(list))
    .catch((e) => { if (e?.name !== 'AbortError') console.error(e) })
  return () => ctrl.abort()
}, [])
```

Change it to include the stem query param and refetch when the stem changes:

```ts
useEffect(() => {
  const ctrl = new AbortController()
  const url = stem
    ? `/api/generation-presets?stem=${encodeURIComponent(stem)}`
    : '/api/generation-presets'
  fetch(url, { signal: ctrl.signal })
    .then((r) => r.json())
    .then((list: GenerationPreset[]) => setPresets(list))
    .catch((e) => { if (e?.name !== 'AbortError') console.error(e) })
  return () => ctrl.abort()
}, [stem])
```

Also find `refreshPresets` (the imperative `useCallback` called after save/delete) — currently fetches the unfiltered URL. Update it to mirror the same query-param behavior:

```ts
const refreshPresets = useCallback(() => {
  const url = stem
    ? `/api/generation-presets?stem=${encodeURIComponent(stem)}`
    : '/api/generation-presets'
  fetch(url)
    .then((r) => r.json())
    .then((list: GenerationPreset[]) => setPresets(list))
    .catch(console.error)
}, [stem])
```

- [ ] **Step 3: Build to verify TypeScript compiles**

```
cd web/frontend && npx vite build 2>&1 | tail -10
```

Expected: TypeScript will FAIL the build because every call site of `<GenerationSettings>` is now missing the required `stem` prop. Errors will name the call sites — that's expected; Task 5 fixes them.

If `npx vite build` doesn't fail and the build succeeds (because vite-build skips tsc), explicitly run tsc:

```
cd web/frontend && npx tsc --noEmit 2>&1 | tail -20
```

You should see errors like:
```
src/components/StemGenerationModal.tsx:NN:N — Property 'stem' is missing in type ...
src/pages/TracksPage.tsx:NN:N — Property 'stem' is missing in type ...
```

- [ ] **Step 4: DO NOT commit yet**

Task 5 fixes the call sites. We commit them together so the codebase never has a broken-build state on `main`. Skip to Task 5.

---

## Task 5: Frontend — Pass `stem` through call sites + remove `stem !== 'drums'` exclusions

**Files:**
- Modify: `web/frontend/src/components/StemGenerationModal.tsx`
- Modify: `web/frontend/src/pages/TracksPage.tsx`
- Modify: `web/frontend/src/components/StemResult.tsx`

- [ ] **Step 1: `StemGenerationModal` — pass `stem` to `<GenerationSettings>`**

In `web/frontend/src/components/StemGenerationModal.tsx`, find the `<GenerationSettings>` render (inside the modal body). Currently:

```tsx
<GenerationSettings
  generation={generation}
  activePreset={activePreset}
  onGenerationChange={onGenerationChange}
  onActivePresetChange={onActivePresetChange}
/>
```

Add the `stem` prop (the modal already receives `stem` from its caller):

```tsx
<GenerationSettings
  generation={generation}
  activePreset={activePreset}
  onGenerationChange={onGenerationChange}
  onActivePresetChange={onActivePresetChange}
  stem={stem}
/>
```

- [ ] **Step 2: `TracksPage.tsx` BeatmapPanel — pass `stem` + remove drums exclusion**

In `web/frontend/src/pages/TracksPage.tsx`, find the BeatmapPanel render where `<GenerationSettings>` is mounted. Currently:

```tsx
{idx === 0 && stem !== 'drums' && (
  <GenerationSettings
    generation={generation}
    activePreset={activePreset}
    onGenerationChange={setGeneration}
    onActivePresetChange={setActivePreset}
  />
)}
```

Replace the entire block with:

```tsx
{idx === 0 && (
  <GenerationSettings
    generation={generation}
    activePreset={activePreset}
    onGenerationChange={setGeneration}
    onActivePresetChange={setActivePreset}
    stem={stem}
  />
)}
```

- [ ] **Step 3: `StemResult.tsx` — remove three `stem !== 'drums'` exclusions**

In `web/frontend/src/components/StemResult.tsx`:

**3a. Cog button gate** — find the cog button (gear icon, `setModalStem(stem)` onClick). Currently:

```tsx
{!bm && stem !== 'song' && stem !== 'drums' && trackId && (
  <button
    type="button"
    onClick={() => setModalStem(stem)}
    className="px-2 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded text-xs transition-colors"
    title="Change preset / engine settings"
    aria-label={`Open generation settings for ${STEM_LABELS[stem] || stem}`}
  >
    ⚙
  </button>
)}
```

Remove `stem !== 'drums' &&` from the gate:

```tsx
{!bm && stem !== 'song' && trackId && (
  <button
    type="button"
    onClick={() => setModalStem(stem)}
    className="px-2 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded text-xs transition-colors"
    title="Change preset / engine settings"
    aria-label={`Open generation settings for ${STEM_LABELS[stem] || stem}`}
  >
    ⚙
  </button>
)}
```

**3b. Preset badge gate** — find the preset badge (the `<span>` rendering `preset: {activePreset}`). Currently:

```tsx
{stem !== 'vocals' && stem !== 'drums' && stem !== 'song' && !bm && activePreset && activePreset !== 'v1' && (
  <span
    className="self-center text-[10px] text-gray-500 italic mt-0.5"
    title={`Generation preset: ${activePreset}`}
  >
    preset: {activePreset}
  </span>
)}
```

Remove `stem !== 'drums' &&`:

```tsx
{stem !== 'vocals' && stem !== 'song' && !bm && activePreset && activePreset !== 'v1' && (
  <span
    className="self-center text-[10px] text-gray-500 italic mt-0.5"
    title={`Generation preset: ${activePreset}`}
  >
    preset: {activePreset}
  </span>
)}
```

**3c. `useV2` calculation** — inside `generateBeatmap`. Currently:

```ts
const useV2 = stem !== 'drums' && !!trackId
```

Drop the drums exclusion:

```ts
const useV2 = !!trackId
```

- [ ] **Step 4: Build to verify the whole frontend type-checks**

```
cd web/frontend && npx vite build 2>&1 | tail -10
```

Expected: `✓ built in <N>s`. No TypeScript errors.

If vite-build skips tsc, also run:
```
cd web/frontend && npx tsc --noEmit 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 5: Run the existing storage tests to confirm no regressions**

```
cd web/frontend && npx vitest run pipeline/generationStorage.test.ts 2>&1 | tail -5
```

Expected: 6/6 passing.

- [ ] **Step 6: Commit Tasks 4 + 5 together**

```bash
git add web/frontend/src/components/pipeline/generationTypes.ts \
        web/frontend/src/components/pipeline/GenerationSettings.tsx \
        web/frontend/src/components/StemGenerationModal.tsx \
        web/frontend/src/pages/TracksPage.tsx \
        web/frontend/src/components/StemResult.tsx
git commit -m "feat(create/tracks): drums get the same cog UI as other stems

GenerationSettings gains a stem prop threaded into the
/api/generation-presets fetch URL so the new ?stem= backend filter
narrows the dropdown to applicable presets. Three stem !== 'drums'
exclusions removed from StemResult (cog gate, badge gate, useV2
routing) plus one from TracksPage's BeatmapPanel (render gate).

GenerationPreset interface picks up the matching stems?: string[]
field. User-saved presets stay universal (no stems field).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Deploy + final smoke

**Files:** none

- [ ] **Step 1: Push to remote**

```
git push origin main
```

- [ ] **Step 2: Deploy (mixed: backend + frontend)**

Per the deploy reference, mixed changes need both an `npm run build` AND a `systemctl restart`:

```
ssh beatmap 'cd /opt/madmom && git pull --ff-only && cd web/frontend && npm run build && systemctl restart beatmap-backend'
```

Expected: `✓ built in <N>s` from vite, then prompt returns (systemctl restart is silent on success).

- [ ] **Step 3: Verify the backend is live**

```
ssh beatmap 'systemctl is-active beatmap-backend'
```

Expected: `active`.

```
curl -s -o /dev/null -w "%{http_code}\n" https://beatmap.jamsesh.co/api/generation-presets
```

Expected: `401` (auth gate — endpoint is mounted).

- [ ] **Step 4: Verify the new bundle hash is live**

```
curl -s https://beatmap.jamsesh.co/ | grep -oE 'index-[A-Za-z0-9]+\.js'
```

Confirm the printed hash matches the latest `dist/assets/index-*.js` from the SSH build output.

- [ ] **Step 5: Manual smoke on production**

Log into `https://beatmap.jamsesh.co/` and verify:

- [ ] Open a recently converted track with a drums stem (Create page).
- [ ] Drums row now shows the ⚙ cog next to Generate Beatmap (didn't before).
- [ ] Click cog → modal opens; dropdown shows `v1` selected by default.
- [ ] `drums-v1` appears in the dropdown.
- [ ] Open the modal on a guitar row → `drums-v1` is NOT in the dropdown.
- [ ] Back on drums, switch to `drums-v1` → pitch engine flips to "Spectral centroid (drum-friendly)", chord_polyphony_threshold becomes 6.
- [ ] Generate from inside the modal → completes; chart appears in the row.
- [ ] Main green Generate Beatmap button on a drums row → Network tab confirms `POST /api/tracks/{id}/generate-beatmap-v2` (was `/api/beatmap/from-stem` before).
- [ ] Preset badge appears under the main button on drums when non-v1 preset selected; disappears for v1.
- [ ] Publish the track to the game; play the resulting chart and confirm the drums track plays on the drums instrument (not guitar). This validates the publish-time section rename still works.
- [ ] Tracks-page Generate Beatmap modal: opening on drums now shows the generation section (was hidden); `drums-v1` available there too.
- [ ] Non-drums stems still work (no regression — Bass/Guitar/Other generation should be unchanged).

---

## Self-review

**Spec coverage:**

- ✅ New `pitches_centroid` engine — Task 1
- ✅ `drums-v1` built-in preset — Task 2
- ✅ Stem-aware `?stem=` filter on presets endpoint — Task 2
- ✅ Remove V2 backend drums guard — Task 3
- ✅ Frontend `GenerationPreset.stems` field — Task 4
- ✅ Frontend `GenerationSettings` accepts `stem` prop, threads into URL — Task 4
- ✅ Frontend call sites pass `stem` — Task 5
- ✅ Frontend `stem !== 'drums'` exclusions removed — Task 5
- ✅ Backend tests for centroid engine — Task 1
- ✅ Backend tests for preset endpoint — Task 2
- ✅ Deploy + smoke — Task 6

**Placeholder scan:** No TBDs, no "implement later", no missing code blocks. Every code change shows the full code.

**Type consistency:**
- `GenerationPreset.stems` defined once in Task 4 (`stems?: string[]`), used in Task 4's fetch URL filter only on the backend side (it's how the backend matches; the frontend doesn't filter again).
- `stem: string` prop on `GenerationSettings` defined in Task 4 step 2, consumed in Task 5 steps 1-2.
- Engine ID `'centroid'` consistent across Task 1 (registration), Task 2 (drums-v1 preset references it), Task 2 tests, and Task 6 smoke checklist.
- `chord_polyphony_threshold: 6` consistent in Task 2 preset and Task 2 test.
