# Vocal Beatmaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a per-syllable, pitched vocal beatmap from any track's vocals stem (via `torchcrepe` pitch detection + `pyphen` syllabification) and embed it as a custom `[JamseshVocals]` block in the published Clone Hero `notes.chart`. The vocals stem card's **Generate Beatmap** button rewires to drive the full pipeline (auto-fetch lyrics → pitch detect → build notes → save).

**Architecture:** New `app/services/vocals.py` owns pitch detection, syllabification, voicing classification, persistence, and chart injection. `app/routers/vocals.py` exposes REST + an SSE Job for `Generate Beatmap`. The Job orchestrates lyrics fetch (LRClib → Whisper fallback, both already implemented in Plan A), then runs CREPE on the vocals stem, aligns f0 frames to syllable windows, classifies voicing, and persists `vocal_notes.json` next to `lyrics.json`. Publish-to-Game writes `[JamseshVocals]` (preferred) or falls back to Plan A's `[Events]` lyric events when only lyrics exist.

**Tech Stack:** FastAPI, httpx, faster-whisper (already pinned), torchcrepe (new), pyphen (new), numpy, torch / torchaudio (already present). React + TypeScript on the frontend. pytest + pytest-asyncio for backend tests.

**Spec:** `docs/superpowers/specs/2026-05-05-vocal-beatmaps-design.md`
**Predecessor spec (Plan A):** `docs/superpowers/specs/2026-05-05-timestamped-lyrics-design.md`
**Predecessor plan (Plan A):** `docs/superpowers/plans/2026-05-05-timestamped-lyrics-plan-A.md`

**Notable references in existing code (verified during brainstorming):**
- Job system: `from app.services.jobs import create_job, JobKind`, `await job.send(step, pct, msg)`, `await job.send_done(metadata)`, `await job.send_error(str)`. Pattern: `asyncio.create_task(_run())`, `job.task =` for cancellation.
- Track lookup: `from app.services.tracks import get_track`, attribute `track.stems_dir` (Path).
- Existing lyrics service: `app/services/lyrics.py` — `_is_lyric_event_line`, `parse_sync_track`, `seconds_to_tick`, `load_lyrics`, `write_lyrics`, `inject_into_chart`. Reuse these.
- Auth dep override pattern in tests: `app.dependency_overrides[require_auth] = lambda: None`.

---

## File map

### New files
- `web/backend/app/services/vocals.py` — pitch detection, syllabify, voicing classify, build_vocal_notes, write_vocal_notes, load_vocal_notes, inject_vocals_into_chart.
- `web/backend/app/routers/vocals.py` — REST + SSE routes.
- `web/backend/tests/test_vocals.py` — unit + integration tests.
- `web/backend/tests/fixtures/sample_vocal_chart.chart` — fixture chart for `inject_vocals_into_chart` round-trip + idempotency.

### Modified files
- `web/backend/requirements.txt` — pin `torchcrepe`, `pyphen`.
- `web/backend/app/main.py` — register vocals router.
- `web/backend/app/routers/tracks.py` — extend `publish_track_to_game` to write `[JamseshVocals]` when vocal notes exist.
- `web/frontend/src/components/StemResult.tsx` — rewire vocals-stem Generate Beatmap to `/api/vocals/generate` + SSE progress.

---

## Phase 1 — Backend service (TDD)

### Task 1: Scaffold vocals router and pin dependencies

**Files:**
- Modify: `web/backend/requirements.txt`
- Create: `web/backend/app/routers/vocals.py`
- Modify: `web/backend/app/main.py`

- [ ] **Step 1: Pin the new dependencies**

Append to `web/backend/requirements.txt`:

```
# Pitch detection for vocal beatmaps. CPU-runnable; first call downloads
# the ~30 MB CREPE 'full' model from HuggingFace.
torchcrepe>=0.0.23
# English syllable splitter for vocal beatmap note granularity.
pyphen>=0.14
```

- [ ] **Step 2: Create router stub**

Create `web/backend/app/routers/vocals.py`:

```python
"""Vocal beatmap fetch / persist / generate routes.

See docs/superpowers/specs/2026-05-05-vocal-beatmaps-design.md.
"""
from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix='/api/vocals', tags=['vocals'])
```

- [ ] **Step 3: Register router in main.py**

Open `web/backend/app/main.py`. Find the routers import line that currently includes `lyrics`. Add `vocals` to it alphabetically (after `versions`, before `youtube` if those are present in the same import). Then add `app.include_router(vocals.router, dependencies=_auth_dep)` next to the other auth-gated registrations.

- [ ] **Step 4: Install and verify**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pip install -r requirements.txt
./venv/Scripts/python.exe -c "from app.main import app; print('vocals routes:', [r.path for r in app.routes if '/vocals' in r.path])"
```

Expected: `vocals routes: []` (empty list, no routes yet) and no import errors.

- [ ] **Step 5: Commit + push + deploy**

```bash
cd C:\Users\Admin\Documents\GitHub\madmom
git add web/backend/requirements.txt web/backend/app/routers/vocals.py web/backend/app/main.py
git commit -m "feat(vocals): scaffold router and pin torchcrepe + pyphen"
git push origin main
ssh -i ~/.ssh/id_ed25519_beatmap -o StrictHostKeyChecking=no root@137.184.217.203 \
  "cd /opt/madmom && git fetch origin main && git reset --hard origin/main \
   && cd web/backend && ./venv/bin/pip install -r requirements.txt 2>&1 | tail -5 \
   && cd ../frontend && npm run build 2>&1 | tail -5 \
   && systemctl restart beatmap-backend && systemctl is-active beatmap-backend"
```

---

### Task 2: Syllabify (TDD)

**Files:**
- Create: `web/backend/app/services/vocals.py`
- Create: `web/backend/tests/test_vocals.py`

- [ ] **Step 1: Write the failing tests**

Create `web/backend/tests/test_vocals.py`:

```python
"""Unit + integration tests for the vocals service."""
from __future__ import annotations

from app.services.vocals import syllabify


def test_syllabify_three_word_english():
    words = [
        {"time_s": 1.0, "text": "Hello", "phrase_start": True},
        {"time_s": 1.5, "text": "wonderful"},
        {"time_s": 2.6, "text": "world", "phrase_end": True},
    ]
    sylls = syllabify(words, language="en")
    # "Hello" → "Hel-lo" (2), "wonderful" → "won-der-ful" (3), "world" → "world" (1)
    assert [s["text"] for s in sylls] == [
        "Hel", "lo", "won", "der", "ful", "world",
    ]
    # First and last syllables carry phrase boundaries
    assert sylls[0].get("phrase_start") is True
    assert sylls[-1].get("phrase_end") is True
    # Middle syllables don't
    assert "phrase_start" not in sylls[1]
    assert "phrase_end" not in sylls[-2]
    # Times are monotonically non-decreasing
    times = [s["time_s"] for s in sylls]
    assert times == sorted(times)


def test_syllabify_single_syllable_word():
    words = [{"time_s": 0.0, "text": "yeah", "phrase_start": True, "phrase_end": True}]
    sylls = syllabify(words, language="en")
    assert sylls == [{
        "time_s": 0.0,
        "duration_s": 0.0,
        "text": "yeah",
        "phrase_start": True,
        "phrase_end": True,
    }]


def test_syllabify_non_english_falls_back_to_per_word():
    words = [
        {"time_s": 0.0, "text": "bonjour", "phrase_start": True},
        {"time_s": 0.5, "text": "monde", "phrase_end": True},
    ]
    sylls = syllabify(words, language="fr")
    # Each word kept whole — no syllabifier for fr in v1
    assert [s["text"] for s in sylls] == ["bonjour", "monde"]
    assert sylls[0]["phrase_start"] is True
    assert sylls[-1]["phrase_end"] is True


def test_syllabify_distributes_word_duration_across_syllables():
    # Two-word lyric where each word has a known duration_s window.
    words = [
        {"time_s": 1.0, "duration_s": 1.0, "text": "Hello", "phrase_start": True, "phrase_end": True},
    ]
    sylls = syllabify(words, language="en")
    # "Hello" → "Hel" (3 chars) + "lo" (2 chars). Distribute by char count: 0.6s + 0.4s.
    assert len(sylls) == 2
    assert sylls[0]["text"] == "Hel"
    assert sylls[0]["time_s"] == 1.0
    assert abs(sylls[0]["duration_s"] - 0.6) < 0.01
    assert sylls[1]["text"] == "lo"
    assert abs(sylls[1]["time_s"] - 1.6) < 0.01
    assert abs(sylls[1]["duration_s"] - 0.4) < 0.01
```

- [ ] **Step 2: Verify the tests fail**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_vocals.py -v
```

Expected: ImportError on `app.services.vocals.syllabify`.

- [ ] **Step 3: Implement**

Create `web/backend/app/services/vocals.py`:

```python
"""Vocal beatmap service — pitch detection, syllabify, voicing classify,
chart injection, persistence.

See docs/superpowers/specs/2026-05-05-vocal-beatmaps-design.md.
"""
from __future__ import annotations

import pyphen


_DICS: dict[str, pyphen.Pyphen] = {}


def _get_dic(language: str) -> pyphen.Pyphen | None:
    if language not in _DICS:
        try:
            _DICS[language] = pyphen.Pyphen(lang=language)
        except KeyError:
            _DICS[language] = None  # type: ignore[assignment]
    return _DICS.get(language)


def syllabify(words: list[dict], language: str = "en") -> list[dict]:
    """Split each word into syllables using pyphen for the given language.

    For unsupported languages, falls back to one-syllable-per-word. Each input
    word may carry `time_s`, `duration_s` (optional), `text`, `phrase_start`,
    `phrase_end`. The output preserves phrase boundaries on the first/last
    syllable of each phrase respectively. Each word's time window is split
    across its syllables proportional to character count.
    """
    dic = _get_dic(language) if language else None
    out: list[dict] = []
    for w in words:
        text = (w.get("text") or "").strip()
        if not text:
            continue
        # pyphen.inserted returns 'Hel-lo' etc.; split on '-'
        parts: list[str]
        if dic is not None:
            hyphenated = dic.inserted(text)
            parts = [p for p in hyphenated.split("-") if p]
            if not parts:
                parts = [text]
        else:
            parts = [text]
        word_start = float(w.get("time_s", 0.0))
        word_dur = float(w.get("duration_s", 0.0) or 0.0)
        total_chars = sum(len(p) for p in parts) or 1
        cumulative = 0
        for i, syl in enumerate(parts):
            ratio = cumulative / total_chars
            t = word_start + ratio * word_dur
            cumulative += len(syl)
            next_ratio = cumulative / total_chars
            d = (next_ratio - ratio) * word_dur
            entry: dict = {
                "time_s": round(t, 3),
                "duration_s": round(d, 3),
                "text": syl,
            }
            if i == 0 and w.get("phrase_start"):
                entry["phrase_start"] = True
            if i == len(parts) - 1 and w.get("phrase_end"):
                entry["phrase_end"] = True
            out.append(entry)
    return out
```

- [ ] **Step 4: Verify tests pass**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_vocals.py -v
```

Expected: 4 passed.

- [ ] **Step 5: Commit + push + deploy**

```bash
cd C:\Users\Admin\Documents\GitHub\madmom
git add web/backend/app/services/vocals.py web/backend/tests/test_vocals.py
git commit -m "feat(vocals): pyphen-backed syllabify with non-English fallback"
git push origin main
ssh -i ~/.ssh/id_ed25519_beatmap -o StrictHostKeyChecking=no root@137.184.217.203 \
  "cd /opt/madmom && git fetch origin main && git reset --hard origin/main \
   && cd web/frontend && npm run build 2>&1 | tail -5 \
   && systemctl restart beatmap-backend && systemctl is-active beatmap-backend"
```

---

### Task 3: Voicing classifier (TDD)

**Files:**
- Modify: `web/backend/app/services/vocals.py`
- Modify: `web/backend/tests/test_vocals.py`

- [ ] **Step 1: Write the failing tests**

Append to `web/backend/tests/test_vocals.py`:

```python
from app.services.vocals import voicing_classify


def test_voicing_classify_sung_is_high_conf_steady_pitch():
    # High median confidence, low pitch std-dev → sung
    curve = [64.0, 64.1, 64.0, 63.9, 64.0]
    assert voicing_classify(curve, confidence=0.85, dynamics_db=[-15, -14, -13, -14, -15]) == "sung"


def test_voicing_classify_whispered_is_low_energy_low_conf():
    # Whisper has very low RMS, low confidence
    curve = [55.0, 56.0, 54.0, 55.5, 55.0]
    assert voicing_classify(curve, confidence=0.30, dynamics_db=[-45, -47, -44, -46, -45]) == "whispered"


def test_voicing_classify_spoken_is_mid_confidence():
    curve = [50.0, 52.0, 49.0, 51.0, 50.0]
    assert voicing_classify(curve, confidence=0.55, dynamics_db=[-22, -20, -23, -21, -22]) == "spoken"


def test_voicing_classify_high_conf_unsteady_pitch_is_spoken():
    # Confident but pitch jumps around → declamatory speech, not sung
    curve = [50.0, 60.0, 55.0, 65.0, 52.0]  # > 1.5 semitone std
    assert voicing_classify(curve, confidence=0.85, dynamics_db=[-20, -19, -20, -21, -20]) == "spoken"
```

- [ ] **Step 2: Verify tests fail**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_vocals.py -v -k voicing
```

Expected: ImportError.

- [ ] **Step 3: Implement**

Append to `web/backend/app/services/vocals.py`:

```python
import statistics


_SUNG_CONF_MIN = 0.7
_SUNG_PITCH_STD_MAX = 1.5            # semitones
_WHISPER_DB_MAX = -40.0              # median dB
_WHISPER_CONF_MAX = 0.4


def voicing_classify(
    curve: list[float],
    confidence: float,
    dynamics_db: list[float],
) -> str:
    """Classify a single syllable as sung / spoken / whispered.

    `curve` is a per-frame list of float MIDI semitones (NaN frames already
    removed by caller); `confidence` is the syllable's median CREPE confidence
    in [0, 1]; `dynamics_db` is the syllable's per-frame RMS in dB."""
    median_db = statistics.median(dynamics_db) if dynamics_db else 0.0
    if confidence <= _WHISPER_CONF_MAX and median_db <= _WHISPER_DB_MAX:
        return "whispered"
    if confidence >= _SUNG_CONF_MIN and len(curve) >= 2:
        pitch_std = statistics.pstdev(curve)
        if pitch_std <= _SUNG_PITCH_STD_MAX:
            return "sung"
    return "spoken"
```

- [ ] **Step 4: Verify all tests pass**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_vocals.py -v
```

Expected: 8 passed (4 syllabify + 4 voicing).

- [ ] **Step 5: Commit + push + deploy**

```bash
cd C:\Users\Admin\Documents\GitHub\madmom
git add web/backend/app/services/vocals.py web/backend/tests/test_vocals.py
git commit -m "feat(vocals): heuristic voicing classifier (sung/spoken/whispered)"
git push origin main
ssh -i ~/.ssh/id_ed25519_beatmap -o StrictHostKeyChecking=no root@137.184.217.203 \
  "cd /opt/madmom && git fetch origin main && git reset --hard origin/main \
   && cd web/frontend && npm run build 2>&1 | tail -5 \
   && systemctl restart beatmap-backend && systemctl is-active beatmap-backend"
```

---

### Task 4: CREPE pitch detection wrapper

**Files:**
- Modify: `web/backend/app/services/vocals.py`
- Modify: `web/backend/tests/test_vocals.py`

- [ ] **Step 1: Add a smoke test (skipped by default)**

Append to `web/backend/tests/test_vocals.py`:

```python
import os
import math
import subprocess
import pytest
from pathlib import Path


@pytest.mark.skipif(
    os.environ.get('VOCALS_CREPE_SMOKE') != '1',
    reason='set VOCALS_CREPE_SMOKE=1 to run (downloads CREPE model)',
)
def test_crepe_detects_a440_within_one_semitone(tmp_path):
    """Generate a 2-second A4 (440 Hz) sine via ffmpeg, run detect_pitches,
    assert median MIDI pitch ≈ 69 (= A4). Smoke-only: gated to avoid the
    30 MB model download on every test run."""
    wav = tmp_path / "a440.wav"
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
         '-ac', '1', '-ar', '16000', '-loglevel', 'error', str(wav)],
        check=True,
    )
    from app.services.vocals import detect_pitches
    f0_hz, confidence = detect_pitches(wav)
    voiced = [f for f, c in zip(f0_hz, confidence) if not math.isnan(f) and c >= 0.5]
    assert len(voiced) > 0
    median_hz = sorted(voiced)[len(voiced) // 2]
    median_midi = 69 + 12 * math.log2(median_hz / 440.0)
    assert abs(median_midi - 69) < 1.0     # within 1 semitone
```

- [ ] **Step 2: Implement**

Append to `web/backend/app/services/vocals.py`:

```python
import math
from pathlib import Path

import numpy as np


_CREPE_MODEL = None  # Lazy singleton


def _load_crepe_model():
    """Lazy-load the CREPE 'full' model. Returns the torchcrepe module so
    callers can use its predict() function. Idempotent."""
    global _CREPE_MODEL
    if _CREPE_MODEL is None:
        import torchcrepe
        # Force model download by calling load.model with capacity 'full'.
        torchcrepe.load.model(device='cpu', capacity='full')
        _CREPE_MODEL = torchcrepe
    return _CREPE_MODEL


def detect_pitches(vocals_path: Path) -> tuple[list[float], list[float]]:
    """Detect per-frame pitch (Hz) and confidence on a vocals stem.

    Returns (f0_hz, confidence). Frames where the model is unsure (periodicity
    < 0.21) have f0_hz set to NaN. 10 ms hop. Loads the model on first call.
    """
    import torch
    import torchaudio

    audio, sr = torchaudio.load(str(vocals_path))
    # Mono down-mix
    if audio.shape[0] > 1:
        audio = audio.mean(dim=0, keepdim=True)
    # Resample to 16 kHz for CREPE (it expects 16 kHz internally)
    target_sr = 16000
    if sr != target_sr:
        audio = torchaudio.functional.resample(audio, sr, target_sr)
        sr = target_sr

    hop_samples = round(sr * 0.010)  # 10 ms hop
    torchcrepe = _load_crepe_model()

    pitch, periodicity = torchcrepe.predict(
        audio,
        sr,
        hop_length=hop_samples,
        model='full',
        batch_size=128,
        device='cpu',
        decoder=torchcrepe.decode.viterbi,
        return_periodicity=True,
    )

    # Mask low-periodicity frames as NaN
    threshold = 0.21
    f0 = pitch.squeeze(0).numpy().astype(float)
    conf = periodicity.squeeze(0).numpy().astype(float)
    f0_masked = np.where(conf < threshold, np.nan, f0)
    return f0_masked.tolist(), conf.tolist()
```

- [ ] **Step 3: Verify import works (smoke test skipped by default)**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_vocals.py -v
```

Expected: 8 passed, 1 skipped.

- [ ] **Step 4: Commit + push + deploy**

```bash
cd C:\Users\Admin\Documents\GitHub\madmom
git add web/backend/app/services/vocals.py web/backend/tests/test_vocals.py
git commit -m "feat(vocals): torchcrepe pitch detection wrapper, lazy singleton"
git push origin main
ssh -i ~/.ssh/id_ed25519_beatmap -o StrictHostKeyChecking=no root@137.184.217.203 \
  "cd /opt/madmom && git fetch origin main && git reset --hard origin/main \
   && cd web/backend && ./venv/bin/pip install -r requirements.txt 2>&1 | tail -5 \
   && cd ../frontend && npm run build 2>&1 | tail -5 \
   && systemctl restart beatmap-backend && systemctl is-active beatmap-backend"
```

---

### Task 5: build_vocal_notes orchestrator (TDD with mocked CREPE)

**Files:**
- Modify: `web/backend/app/services/vocals.py`
- Modify: `web/backend/tests/test_vocals.py`

- [ ] **Step 1: Write the failing test**

Append to `web/backend/tests/test_vocals.py`:

```python
def test_build_vocal_notes_orchestrates_syllabify_and_pitch_alignment(monkeypatch, tmp_path):
    """Stub detect_pitches; assert build_vocal_notes assembles the right shape."""
    fake_audio = tmp_path / "vocals.wav"
    fake_audio.write_bytes(b"")  # not actually read since we stub detect_pitches

    # Fake CREPE output: 200 frames at 10 ms hop = 2.0 seconds, all A4 (440 Hz)
    n_frames = 200
    fake_f0 = [440.0] * n_frames
    fake_conf = [0.9] * n_frames

    from app.services import vocals as vocals_service
    monkeypatch.setattr(vocals_service, 'detect_pitches', lambda p: (fake_f0, fake_conf))

    # Lyrics: two LRClib-style lines spanning 0..1.0 and 1.0..2.0
    lyrics = {
        "source": "lrclib",
        "language": "en",
        "words": [
            {"time_s": 0.0, "duration_s": 1.0, "text": "Hello", "phrase_start": True, "phrase_end": True},
            {"time_s": 1.0, "duration_s": 1.0, "text": "world", "phrase_start": True, "phrase_end": True},
        ],
    }

    notes = vocals_service.build_vocal_notes(fake_audio, lyrics)

    # Three syllables: "Hel", "lo", "world"
    assert len(notes["syllables"]) == 3
    assert [s["text"] for s in notes["syllables"]] == ["Hel", "lo", "world"]
    # All notes detect MIDI 69 (A4 = 440 Hz)
    assert all(s["midi_pitch"] == 69 for s in notes["syllables"])
    # All sung (high confidence, steady pitch)
    assert all(s["voicing"] == "sung" for s in notes["syllables"])
    # Phrase boundaries preserved
    assert notes["syllables"][0]["phrase_start"] is True
    assert notes["syllables"][1].get("phrase_start") is None or notes["syllables"][1].get("phrase_start") is not True
    assert notes["syllables"][-1].get("phrase_end") is True
    # Top-level metadata
    assert notes["version"] == 1
    assert notes["pitch_model"] == "torchcrepe-full"
    assert notes["syllabified_from"] == "lrclib"
    assert notes["syllabifier"] == "pyphen-en"
    assert notes["frame_hop_s"] == 0.010
    assert "lyrics_etag" in notes
```

- [ ] **Step 2: Verify the test fails**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_vocals.py -v -k build_vocal_notes
```

Expected: ImportError on `build_vocal_notes`.

- [ ] **Step 3: Implement**

Append to `web/backend/app/services/vocals.py`:

```python
import datetime
import hashlib
import json


def _hz_to_midi(hz: float) -> float:
    if not hz or math.isnan(hz) or hz <= 0:
        return float("nan")
    return 69.0 + 12.0 * math.log2(hz / 440.0)


def _slice_frames(
    f0: list[float],
    conf: list[float],
    start_s: float,
    duration_s: float,
    hop_s: float,
) -> tuple[list[float], list[float]]:
    """Slice the f0 + confidence frame arrays to [start_s, start_s + duration_s].
    Returns (curve_midi_floats_voiced_only, confidences_for_those_frames)."""
    if duration_s <= 0:
        return [], []
    start_idx = max(0, int(round(start_s / hop_s)))
    end_idx = min(len(f0), int(round((start_s + duration_s) / hop_s)))
    curve_midi: list[float] = []
    conf_voiced: list[float] = []
    for i in range(start_idx, end_idx):
        if math.isnan(f0[i]):
            continue
        curve_midi.append(_hz_to_midi(f0[i]))
        conf_voiced.append(conf[i])
    return curve_midi, conf_voiced


def _downsample(values: list[float], target: int) -> list[float]:
    """Reduce a list to `target` evenly-spaced samples (max-pool style for
    pitch curves; simple stride otherwise)."""
    if len(values) <= target:
        return values[:]
    out = []
    for i in range(target):
        idx = (i * len(values)) // target
        out.append(values[idx])
    return out


def build_vocal_notes(
    vocals_path: Path,
    lyrics: dict,
    progress_callback=None,
) -> dict:
    """Run pitch detection on the vocals stem, syllabify the lyrics, and
    align pitch frames to syllable windows. Returns the normalized
    `vocal_notes.json` shape."""
    if progress_callback:
        progress_callback('crepe', 70, 'Detecting pitch...')
    f0, conf = detect_pitches(vocals_path)
    hop_s = 0.010

    if progress_callback:
        progress_callback('syllabify', 60, 'Splitting into syllables...')
    language = lyrics.get('language') or 'en'
    sylls = syllabify(lyrics.get('words', []), language=language)

    if progress_callback:
        progress_callback('align', 92, 'Aligning pitch to syllables...')

    out_sylls: list[dict] = []
    for s in sylls:
        curve_midi, conf_voiced = _slice_frames(
            f0, conf, s['time_s'], s['duration_s'], hop_s,
        )
        if curve_midi:
            median_midi = sorted(curve_midi)[len(curve_midi) // 2]
            midi_pitch = int(round(median_midi))
            median_conf = sorted(conf_voiced)[len(conf_voiced) // 2]
        else:
            # No voiced frames in this syllable — borrow nearest neighbor's pitch
            midi_pitch = out_sylls[-1]['midi_pitch'] if out_sylls else 60
            median_conf = 0.0
            curve_midi = []

        # Dynamics — compute over the syllable window even if unvoiced
        # (uses RMS proxy: confidence × 60 + offset for now; refined in build).
        # In v1 we only have the f0/conf signal exposed by detect_pitches.
        # A future task can wire RMS through; for now derive a synthetic envelope
        # from confidence so the field is populated and shape-stable.
        dyn_proxy = [-30.0 + 30.0 * c for c in (conf_voiced or [median_conf])]

        voicing = voicing_classify(curve_midi, median_conf, dyn_proxy)

        entry: dict = {
            'time_s': s['time_s'],
            'duration_s': s['duration_s'],
            'text': s['text'],
            'midi_pitch': midi_pitch,
            'confidence': round(median_conf, 3),
            'voicing': voicing,
            'pitch_curve_st': [round(v, 2) for v in _downsample(curve_midi, 5)] if curve_midi else [],
            'dynamics_db': [round(v, 1) for v in _downsample(dyn_proxy, 5)],
        }
        if s.get('phrase_start'):
            entry['phrase_start'] = True
        if s.get('phrase_end'):
            entry['phrase_end'] = True
        out_sylls.append(entry)

    lyrics_etag = hashlib.sha1(
        json.dumps(lyrics, sort_keys=True, ensure_ascii=False).encode('utf-8')
    ).hexdigest()

    if progress_callback:
        progress_callback('write', 96, 'Building vocal notes...')

    return {
        'version': 1,
        'syllabified_from': lyrics.get('source') or 'unknown',
        'pitch_model': 'torchcrepe-full',
        'syllabifier': f'pyphen-{language}' if _get_dic(language) else 'per-word',
        'frame_hop_s': hop_s,
        'lyrics_etag': lyrics_etag,
        'fetched_at': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'syllables': out_sylls,
    }
```

- [ ] **Step 4: Verify all tests pass**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_vocals.py -v
```

Expected: 9 passed, 1 skipped.

- [ ] **Step 5: Commit + push + deploy**

```bash
cd C:\Users\Admin\Documents\GitHub\madmom
git add web/backend/app/services/vocals.py web/backend/tests/test_vocals.py
git commit -m "feat(vocals): build_vocal_notes orchestrator with CREPE/syllable alignment"
git push origin main
ssh -i ~/.ssh/id_ed25519_beatmap -o StrictHostKeyChecking=no root@137.184.217.203 \
  "cd /opt/madmom && git fetch origin main && git reset --hard origin/main \
   && cd web/frontend && npm run build 2>&1 | tail -5 \
   && systemctl restart beatmap-backend && systemctl is-active beatmap-backend"
```

---

### Task 6: Persistence helpers

**Files:**
- Modify: `web/backend/app/services/vocals.py`
- Modify: `web/backend/tests/test_vocals.py`

- [ ] **Step 1: Write tests**

Append to `web/backend/tests/test_vocals.py`:

```python
def test_write_then_load_vocal_notes(tmp_path):
    from app.services.vocals import write_vocal_notes, load_vocal_notes
    notes = {
        "version": 1, "syllabified_from": "lrclib",
        "pitch_model": "torchcrepe-full", "frame_hop_s": 0.010,
        "syllables": [
            {"time_s": 1.0, "duration_s": 0.3, "text": "Hi",
             "midi_pitch": 60, "confidence": 0.9, "voicing": "sung",
             "pitch_curve_st": [60.0], "dynamics_db": [-15.0]},
        ],
    }
    path = write_vocal_notes(tmp_path, notes)
    assert path == tmp_path / "vocal_notes.json"
    assert load_vocal_notes(tmp_path) == notes


def test_load_vocal_notes_missing(tmp_path):
    from app.services.vocals import load_vocal_notes
    assert load_vocal_notes(tmp_path) is None
```

- [ ] **Step 2: Implement**

Append to `web/backend/app/services/vocals.py`:

```python
def write_vocal_notes(target_dir: Path, notes: dict) -> Path:
    """Persist vocal_notes.json in target_dir."""
    path = target_dir / 'vocal_notes.json'
    path.write_text(
        json.dumps(notes, ensure_ascii=False, indent=2),
        encoding='utf-8',
    )
    return path


def load_vocal_notes(target_dir: Path) -> dict | None:
    """Read vocal_notes.json from target_dir. Returns None if absent."""
    path = target_dir / 'vocal_notes.json'
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding='utf-8'))
```

- [ ] **Step 3: Verify**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_vocals.py -v
```

Expected: 11 passed, 1 skipped.

- [ ] **Step 4: Commit + push + deploy**

```bash
cd C:\Users\Admin\Documents\GitHub\madmom
git add web/backend/app/services/vocals.py web/backend/tests/test_vocals.py
git commit -m "feat(vocals): persistence helpers (write/load vocal_notes.json)"
git push origin main
ssh -i ~/.ssh/id_ed25519_beatmap -o StrictHostKeyChecking=no root@137.184.217.203 \
  "cd /opt/madmom && git fetch origin main && git reset --hard origin/main \
   && cd web/frontend && npm run build 2>&1 | tail -5 \
   && systemctl restart beatmap-backend && systemctl is-active beatmap-backend"
```

---

### Task 7: inject_vocals_into_chart (TDD with fixture)

**Files:**
- Modify: `web/backend/app/services/vocals.py`
- Modify: `web/backend/tests/test_vocals.py`
- Create: `web/backend/tests/fixtures/sample_vocal_chart.chart`

- [ ] **Step 1: Create fixture chart**

Create `web/backend/tests/fixtures/sample_vocal_chart.chart`:

```
[Song]
{
  Name = "VocalTest"
  Resolution = 192
}
[SyncTrack]
{
  0 = TS 4
  0 = B 120000
}
[Events]
{
  192 = E "section Intro"
  384 = E "phrase_start"
  384 = E "lyric Stale"
  384 = E "phrase_end"
}
[ExpertSingle]
{
  0 = N 0 0
}
```

- [ ] **Step 2: Write the failing tests**

Append to `web/backend/tests/test_vocals.py`:

```python
FIXTURE = Path(__file__).parent / "fixtures" / "sample_vocal_chart.chart"


def test_inject_vocals_writes_block_and_clears_old_lyric_events(tmp_path):
    """Fixture chart has stale [Events] phrase/lyric entries from Plan A.
    Injecting vocals should write [JamseshVocals] AND clear those events."""
    from app.services.vocals import inject_vocals_into_chart
    chart_path = tmp_path / "out.chart"
    chart_path.write_text(FIXTURE.read_text(encoding='utf-8'), encoding='utf-8')

    notes = {
        "version": 1, "syllabified_from": "lrclib",
        "pitch_model": "torchcrepe-full", "frame_hop_s": 0.010,
        "syllables": [
            {"time_s": 0.5, "duration_s": 0.3, "text": "Hel",
             "midi_pitch": 64, "confidence": 0.92, "voicing": "sung",
             "phrase_start": True,
             "pitch_curve_st": [64.0, 64.1], "dynamics_db": [-15.0, -14.5]},
            {"time_s": 1.0, "duration_s": 0.3, "text": "lo",
             "midi_pitch": 66, "confidence": 0.88, "voicing": "sung",
             "phrase_end": True,
             "pitch_curve_st": [66.0], "dynamics_db": [-14.0]},
        ],
    }
    inserted = inject_vocals_into_chart(chart_path, notes)
    assert inserted == 2

    text = chart_path.read_text(encoding='utf-8')

    # JamseshVocals block exists with header lines
    assert "[JamseshVocals]" in text
    assert "Version = 1" in text
    assert 'PitchModel = "torchcrepe-full"' in text
    assert "HopMs = 10" in text

    # Note + lyric + voicing lines for each syllable.
    # 120 BPM, 192 ppq → 1s = 384 ticks. Syllable 1 at 0.5s..0.8s → 192..307 (dur 115).
    # Syllable 2 at 1.0s..1.3s → 384..499 (dur 115).
    assert "192 = N 64 115 92" in text
    assert '192 = E lyric Hel' in text
    assert "192 = V sung" in text
    assert "192 = P start" in text
    assert "384 = N 66 115 88" in text
    assert '384 = E lyric lo' in text
    assert "384 = V sung" in text
    assert "384 = P end" in text

    # Pitch curve uses :.2f, dynamics uses :.1f
    assert "192 = C 64.00,64.10" in text
    assert "192 = D -15.0,-14.5" in text

    # Old [Events] lyric/phrase entries are cleared
    assert "phrase_start" not in text.split("[JamseshVocals]")[0]
    assert "phrase_end" not in text.split("[JamseshVocals]")[0]
    assert 'lyric Stale' not in text
    # Non-lyric event preserved
    assert '192 = E "section Intro"' in text


def test_inject_vocals_idempotent(tmp_path):
    from app.services.vocals import inject_vocals_into_chart
    chart_path = tmp_path / "out.chart"
    chart_path.write_text(FIXTURE.read_text(encoding='utf-8'), encoding='utf-8')
    notes = {
        "version": 1, "syllabified_from": "lrclib",
        "pitch_model": "torchcrepe-full", "frame_hop_s": 0.010,
        "syllables": [{"time_s": 1.0, "duration_s": 0.3, "text": "Hi",
                       "midi_pitch": 60, "confidence": 0.9, "voicing": "sung",
                       "phrase_start": True, "phrase_end": True,
                       "pitch_curve_st": [60.0], "dynamics_db": [-15.0]}],
    }
    inject_vocals_into_chart(chart_path, notes)
    first = chart_path.read_text(encoding='utf-8')
    inject_vocals_into_chart(chart_path, notes)
    second = chart_path.read_text(encoding='utf-8')
    assert first == second
```

- [ ] **Step 3: Verify tests fail**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_vocals.py -v -k inject_vocals
```

Expected: ImportError.

- [ ] **Step 4: Implement**

Append to `web/backend/app/services/vocals.py`:

```python
import re

from app.services.lyrics import (
    parse_sync_track,
    seconds_to_tick,
    _is_lyric_event_line,
)


_VOCAL_HEADER_LINES = ('[JamseshVocals]',)


def _escape_chart_text(text: str) -> str:
    return text.replace('\\', '\\\\').replace('"', '\\"')


def _format_curve(curve: list[float]) -> str:
    return ','.join(f'{v:.2f}' for v in curve)


def _format_dynamics(dyn: list[float]) -> str:
    return ','.join(f'{v:.1f}' for v in dyn)


def inject_vocals_into_chart(chart_path: Path, notes: dict) -> int:
    """Rewrite the [JamseshVocals] block in `chart_path`. Idempotent: strips
    any prior [JamseshVocals] block plus any prior [Events] lyric/phrase
    events from Plan A (single source of truth). Returns syllable count."""
    text = chart_path.read_text(encoding='utf-8')
    resolution, segments = parse_sync_track(text)

    syllables = notes.get('syllables', [])

    # Build the new [JamseshVocals] body lines
    new_body: list[str] = [
        f'  Version = {int(notes.get("version", 1))}',
        f'  PitchModel = "{notes.get("pitch_model", "torchcrepe-full")}"',
        f'  HopMs = {int(round(notes.get("frame_hop_s", 0.010) * 1000))}',
    ]
    for s in syllables:
        tick = seconds_to_tick(float(s['time_s']), resolution, segments)
        end_tick = seconds_to_tick(
            float(s['time_s']) + float(s.get('duration_s', 0.0)), resolution, segments,
        )
        duration_ticks = max(1, end_tick - tick)
        confidence_int = int(round(float(s.get('confidence', 0.0)) * 100))
        new_body.append(f'  {tick} = N {int(s["midi_pitch"])} {duration_ticks} {confidence_int}')
        new_body.append(f'  {tick} = E lyric {_escape_chart_text(s["text"])}')
        new_body.append(f'  {tick} = V {s.get("voicing", "sung")}')
        if s.get('dynamics_db'):
            new_body.append(f'  {tick} = D {_format_dynamics(s["dynamics_db"])}')
        if s.get('pitch_curve_st'):
            new_body.append(f'  {tick} = C {_format_curve(s["pitch_curve_st"])}')
        if s.get('phrase_start'):
            new_body.append(f'  {tick} = P start')
        if s.get('phrase_end'):
            new_body.append(f'  {tick} = P end')

    new_block_lines = ['[JamseshVocals]', '{', *new_body, '}']

    # Strip any existing [JamseshVocals] block
    lines = text.splitlines()
    out_lines: list[str] = []
    i = 0
    while i < len(lines):
        if lines[i].strip() == '[JamseshVocals]':
            # Skip until matching '}'
            depth = 0
            j = i + 1
            while j < len(lines):
                if lines[j].strip() == '{':
                    depth += 1
                elif lines[j].strip() == '}':
                    if depth <= 1:
                        j += 1
                        break
                    depth -= 1
                j += 1
            i = j
            continue
        out_lines.append(lines[i])
        i += 1

    # Strip any [Events] lyric/phrase events authored by Plan A
    cleaned: list[str] = []
    in_events = False
    for line in out_lines:
        stripped = line.strip()
        if stripped == '[Events]':
            in_events = True
            cleaned.append(line)
            continue
        if in_events:
            if stripped == '}':
                in_events = False
                cleaned.append(line)
                continue
            if _is_lyric_event_line(line):
                continue
        cleaned.append(line)

    cleaned.extend(new_block_lines)
    chart_path.write_text('\n'.join(cleaned) + '\n', encoding='utf-8')

    return len(syllables)
```

- [ ] **Step 5: Verify all tests pass**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_vocals.py -v
```

Expected: 13 passed, 1 skipped.

- [ ] **Step 6: Commit + push + deploy**

```bash
cd C:\Users\Admin\Documents\GitHub\madmom
git add web/backend/app/services/vocals.py web/backend/tests/test_vocals.py web/backend/tests/fixtures/sample_vocal_chart.chart
git commit -m "feat(vocals): idempotent inject_vocals_into_chart with [Events] cleanup"
git push origin main
ssh -i ~/.ssh/id_ed25519_beatmap -o StrictHostKeyChecking=no root@137.184.217.203 \
  "cd /opt/madmom && git fetch origin main && git reset --hard origin/main \
   && cd web/frontend && npm run build 2>&1 | tail -5 \
   && systemctl restart beatmap-backend && systemctl is-active beatmap-backend"
```

---

### Task 8: REST routes — GET / PUT / DELETE

**Files:**
- Modify: `web/backend/app/routers/vocals.py`
- Modify: `web/backend/tests/test_vocals.py`

- [ ] **Step 1: Write integration tests**

Append to `web/backend/tests/test_vocals.py`:

```python
from fastapi.testclient import TestClient
from app.main import app
from app.routers.auth import require_auth


@pytest.fixture
def _no_auth():
    app.dependency_overrides[require_auth] = lambda: None
    yield
    app.dependency_overrides.pop(require_auth, None)


def test_vocals_get_404_when_missing(_no_auth, monkeypatch, tmp_path):
    from app.routers import vocals as vocals_router
    monkeypatch.setattr(vocals_router, '_resolve_dir', lambda **kw: tmp_path)
    client = TestClient(app)
    r = client.get('/api/vocals?track_id=tx')
    assert r.status_code == 404


def test_vocals_put_then_get(_no_auth, monkeypatch, tmp_path):
    from app.routers import vocals as vocals_router
    monkeypatch.setattr(vocals_router, '_resolve_dir', lambda **kw: tmp_path)
    client = TestClient(app)
    body = {"version": 1, "syllabified_from": "lrclib",
            "pitch_model": "torchcrepe-full", "frame_hop_s": 0.010,
            "syllables": []}
    r = client.put('/api/vocals?track_id=t1', json=body)
    assert r.status_code == 200
    r = client.get('/api/vocals?track_id=t1')
    assert r.status_code == 200
    assert r.json() == body


def test_vocals_delete(_no_auth, monkeypatch, tmp_path):
    from app.routers import vocals as vocals_router
    monkeypatch.setattr(vocals_router, '_resolve_dir', lambda **kw: tmp_path)
    client = TestClient(app)
    body = {"version": 1, "syllabified_from": "lrclib",
            "pitch_model": "torchcrepe-full", "frame_hop_s": 0.010,
            "syllables": []}
    client.put('/api/vocals?track_id=t1', json=body)
    r = client.delete('/api/vocals?track_id=t1')
    assert r.status_code == 200
    r = client.get('/api/vocals?track_id=t1')
    assert r.status_code == 404
```

- [ ] **Step 2: Verify tests fail**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_vocals.py -v -k 'vocals_get_404 or vocals_put_then or vocals_delete'
```

Expected: AttributeError on `_resolve_dir`.

- [ ] **Step 3: Implement routes**

Replace `web/backend/app/routers/vocals.py` with:

```python
"""Vocal beatmap fetch / persist / generate routes.

See docs/superpowers/specs/2026-05-05-vocal-beatmaps-design.md.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Body, HTTPException, Query

from app.services import vocals as vocals_service
from app.services.jobs import get_job
from app.services.tracks import get_track


router = APIRouter(prefix='/api/vocals', tags=['vocals'])


def _resolve_dir(job_id: str | None = None, track_id: str | None = None) -> Path:
    """Mirror of lyrics router's _resolve_dir. track_id wins if both supplied."""
    if track_id:
        track = get_track(track_id)
        if not track:
            raise HTTPException(404, f'Track not found: {track_id}')
        return track.stems_dir
    if job_id:
        job = get_job(job_id)
        if not job or not job.output_dir:
            raise HTTPException(404, f'Job not found: {job_id}')
        return job.output_dir / 'stems'
    raise HTTPException(400, 'Provide job_id or track_id')


@router.get('')
async def get_vocals(
    job_id: str | None = Query(default=None),
    track_id: str | None = Query(default=None),
):
    target = _resolve_dir(job_id=job_id, track_id=track_id)
    data = vocals_service.load_vocal_notes(target)
    if data is None:
        raise HTTPException(404, 'No vocal notes for this scope')
    return data


@router.put('')
async def put_vocals(
    body: dict = Body(...),
    job_id: str | None = Query(default=None),
    track_id: str | None = Query(default=None),
):
    target = _resolve_dir(job_id=job_id, track_id=track_id)
    target.mkdir(parents=True, exist_ok=True)
    vocals_service.write_vocal_notes(target, body)
    return {'ok': True, 'syllable_count': len(body.get('syllables', []))}


@router.delete('')
async def delete_vocals(
    job_id: str | None = Query(default=None),
    track_id: str | None = Query(default=None),
):
    target = _resolve_dir(job_id=job_id, track_id=track_id)
    p = target / 'vocal_notes.json'
    if p.exists():
        p.unlink()
    return {'ok': True}
```

- [ ] **Step 4: Verify all tests pass**

```bash
cd web/backend && ./venv/Scripts/python.exe -m pytest tests/test_vocals.py -v
```

Expected: 16 passed, 1 skipped.

- [ ] **Step 5: Commit + push + deploy**

```bash
cd C:\Users\Admin\Documents\GitHub\madmom
git add web/backend/app/routers/vocals.py web/backend/tests/test_vocals.py
git commit -m "feat(vocals): GET/PUT/DELETE /api/vocals"
git push origin main
ssh -i ~/.ssh/id_ed25519_beatmap -o StrictHostKeyChecking=no root@137.184.217.203 \
  "cd /opt/madmom && git fetch origin main && git reset --hard origin/main \
   && cd web/frontend && npm run build 2>&1 | tail -5 \
   && systemctl restart beatmap-backend && systemctl is-active beatmap-backend"
```

---

### Task 9: POST /api/vocals/generate — full SSE pipeline

**Files:**
- Modify: `web/backend/app/routers/vocals.py`

This is the orchestrator endpoint. It checks for existing lyrics; if missing, fetches from LRClib (using metadata in the request body); if LRClib misses, runs Whisper. Then runs CREPE + alignment. All progress flows through one Job's SSE stream.

- [ ] **Step 1: Implement**

Append to `web/backend/app/routers/vocals.py`:

```python
import asyncio

from app.services.jobs import create_job, JobKind
from app.services import lyrics as lyrics_service


@router.post('/generate')
async def post_generate(
    body: dict = Body(...),
    job_id: str | None = Query(default=None),
    track_id: str | None = Query(default=None),
):
    """Full vocals pipeline: fetch lyrics if missing → CREPE → align → write.

    Body fields used only when lyrics need fetching:
      artist, title, album?, duration_s?
    Returns {job_id} for SSE subscription on /api/jobs/{job_id}/events.
    """
    target = _resolve_dir(job_id=job_id, track_id=track_id)

    # Find vocals stem
    candidates = list(target.glob('vocals.*'))
    audio_exts = {'.ogg', '.wav', '.mp3', '.flac'}
    vocals = next((p for p in candidates if p.suffix.lower() in audio_exts), None)
    if vocals is None or not vocals.exists():
        raise HTTPException(404, 'No vocals stem available for this scope')

    work_job = create_job(kind=JobKind.OTHER, title='Vocal beatmap generation')

    async def _run() -> None:
        loop = asyncio.get_running_loop()
        try:
            await work_job.send('init', 2, 'Resolving track...')

            # 1. Lyrics: load existing if present
            lyrics = lyrics_service.load_lyrics(target)

            if lyrics is None:
                # 2a. Try LRClib
                await work_job.send('lyrics-fetch', 10, 'Fetching synced lyrics from LRClib...')
                lyrics = await lyrics_service.fetch_from_lrclib(
                    artist=(body.get('artist') or '').strip(),
                    title=(body.get('title') or '').strip(),
                    album=body.get('album'),
                    duration_s=body.get('duration_s'),
                )
                if lyrics is None:
                    # 2b. Fall back to Whisper
                    await work_job.send('lyrics-fetch', 25, 'No LRClib match — transcribing with Whisper...')

                    def sync_whisper_progress(step: str, pct: int, msg: str) -> None:
                        # Whisper covers 25..55 of our composite progress
                        scaled = 25 + int(0.30 * pct / 100 * 100)
                        scaled = min(55, max(25, scaled))
                        asyncio.run_coroutine_threadsafe(
                            work_job.send('whisper', scaled, msg), loop,
                        )

                    lyrics = await loop.run_in_executor(
                        None,
                        lambda: lyrics_service.transcribe_with_whisper(vocals, sync_whisper_progress),
                    )
                target.mkdir(parents=True, exist_ok=True)
                lyrics_service.write_lyrics(target, lyrics)

            # 3. Build vocal notes (syllabify + CREPE + align)
            await work_job.send('crepe-load', 65, 'Loading pitch model...')

            def sync_build_progress(step: str, pct: int, msg: str) -> None:
                asyncio.run_coroutine_threadsafe(work_job.send(step, pct, msg), loop)

            notes = await loop.run_in_executor(
                None,
                lambda: vocals_service.build_vocal_notes(vocals, lyrics, sync_build_progress),
            )

            # 4. Persist
            target.mkdir(parents=True, exist_ok=True)
            vocals_service.write_vocal_notes(target, notes)

            voicing_breakdown: dict[str, int] = {'sung': 0, 'spoken': 0, 'whispered': 0}
            for s in notes.get('syllables', []):
                v = s.get('voicing', 'sung')
                voicing_breakdown[v] = voicing_breakdown.get(v, 0) + 1

            await work_job.send_done({
                'syllable_count': len(notes.get('syllables', [])),
                'voicing': voicing_breakdown,
                'source': lyrics.get('source'),
                'pitch_model': notes.get('pitch_model'),
            })
        except asyncio.CancelledError:
            return
        except Exception as e:
            await work_job.send_error(str(e) or 'Vocal beatmap generation failed')

    work_job.task = asyncio.create_task(_run())
    return {'job_id': work_job.id}
```

- [ ] **Step 2: Manual sanity check**

```bash
cd web/backend && ./venv/Scripts/python.exe -c "from app.main import app; print(sorted([r.path for r in app.routes if '/vocals' in r.path]))"
```

Expected: `['/api/vocals', '/api/vocals', '/api/vocals', '/api/vocals/generate']` (GET/PUT/DELETE on `''`, POST on `/generate`).

- [ ] **Step 3: Commit + push + deploy**

```bash
cd C:\Users\Admin\Documents\GitHub\madmom
git add web/backend/app/routers/vocals.py
git commit -m "feat(vocals): POST /api/vocals/generate — full SSE pipeline"
git push origin main
ssh -i ~/.ssh/id_ed25519_beatmap -o StrictHostKeyChecking=no root@137.184.217.203 \
  "cd /opt/madmom && git fetch origin main && git reset --hard origin/main \
   && cd web/frontend && npm run build 2>&1 | tail -5 \
   && systemctl restart beatmap-backend && systemctl is-active beatmap-backend"
```

---

## Phase 2 — Publish-to-Game integration

### Task 10: Wire vocal notes into publish_track_to_game

**Files:**
- Modify: `web/backend/app/routers/tracks.py`

- [ ] **Step 1: Locate the existing lyrics-injection block**

Open `web/backend/app/routers/tracks.py`. Find the lines added by Plan A (search for `lyrics_service.load_lyrics(track.stems_dir)` — should be around line 875). The current code looks like:

```python
lyrics_data = lyrics_service.load_lyrics(track.stems_dir)
...
lyrics_summary = {'source': None, 'word_count': 0, 'included': False}
if lyrics_data:
    chart_path = tmp_dir / 'notes_fixed_slides.chart'
    if chart_path.exists():
        inserted = lyrics_service.inject_into_chart(chart_path, lyrics_data)
        lyrics_service.write_lyrics(tmp_dir, lyrics_data)
        lyrics_summary = {...}
```

- [ ] **Step 2: Replace the block with the either/or vocals-vs-lyrics flow**

Replace the lyrics-only block with:

```python
from app.services import vocals as vocals_service

vocal_notes_data = vocals_service.load_vocal_notes(track.stems_dir)
lyrics_data = lyrics_service.load_lyrics(track.stems_dir)

vocals_summary = {'source': None, 'syllable_count': 0, 'voicing': {}, 'pitch_model': None, 'included': False}
lyrics_summary = {'source': None, 'word_count': 0, 'included': False}

chart_path = tmp_dir / 'notes_fixed_slides.chart'

if vocal_notes_data and chart_path.exists():
    inserted = vocals_service.inject_vocals_into_chart(chart_path, vocal_notes_data)
    vocals_service.write_vocal_notes(tmp_dir, vocal_notes_data)
    voicing: dict[str, int] = {'sung': 0, 'spoken': 0, 'whispered': 0}
    for s in vocal_notes_data.get('syllables', []):
        v = s.get('voicing', 'sung')
        voicing[v] = voicing.get(v, 0) + 1
    vocals_summary = {
        'source': vocal_notes_data.get('syllabified_from'),
        'syllable_count': inserted,
        'voicing': voicing,
        'pitch_model': vocal_notes_data.get('pitch_model'),
        'included': True,
    }
    # Always copy lyrics.json into the published folder too if it exists
    if lyrics_data:
        lyrics_service.write_lyrics(tmp_dir, lyrics_data)
elif lyrics_data and chart_path.exists():
    # No vocals — fall back to Plan A's [Events] lyric/phrase events
    inserted = lyrics_service.inject_into_chart(chart_path, lyrics_data)
    lyrics_service.write_lyrics(tmp_dir, lyrics_data)
    lyrics_summary = {
        'source': lyrics_data.get('source'),
        'word_count': inserted,
        'included': True,
    }
```

- [ ] **Step 3: Add `vocals` to the response dict**

Locate the function's return value (the dict that includes `commit_url`, `folder`, `chart`, `tutorial`, `lyrics`). Add `vocals_summary`:

```python
return {
    'commit_url': ...,
    'folder': folder_name,
    'chart': {...},
    'tutorial': {...},
    'lyrics': lyrics_summary,
    'vocals': vocals_summary,
}
```

- [ ] **Step 4: Sanity check**

```bash
cd web/backend && ./venv/Scripts/python.exe -c "from app.routers.tracks import router; print('publish endpoints:', [r.path for r in router.routes if 'publish' in r.path])"
```

Expected: existing publish endpoint listed, no import errors.

- [ ] **Step 5: Commit + push + deploy**

```bash
cd C:\Users\Admin\Documents\GitHub\madmom
git add web/backend/app/routers/tracks.py
git commit -m "feat(vocals): publish-to-game writes [JamseshVocals] when notes exist"
git push origin main
ssh -i ~/.ssh/id_ed25519_beatmap -o StrictHostKeyChecking=no root@137.184.217.203 \
  "cd /opt/madmom && git fetch origin main && git reset --hard origin/main \
   && cd web/frontend && npm run build 2>&1 | tail -5 \
   && systemctl restart beatmap-backend && systemctl is-active beatmap-backend"
```

---

## Phase 3 — Frontend

### Task 11: Rewire vocals card Generate Beatmap to /api/vocals/generate

**Files:**
- Modify: `web/frontend/src/components/StemResult.tsx`

The vocals card already shows Get Lyrics + Transcribe Vocals (Plan A). The `Generate Beatmap` button currently calls `generateBeatmap(stem)` → `POST /api/beatmap/from-stem`. For `stem === 'vocals'` only, we wire it to `POST /api/vocals/generate` instead, with progress via the same SSE Job pattern.

- [ ] **Step 1: Locate `generateBeatmap` and the per-stem render**

Open `web/frontend/src/components/StemResult.tsx`. Find:
- The `generateBeatmap` function (search for `/api/beatmap/from-stem`).
- The per-stem render where it's called from a button (search for `Generate Beatmap`).
- The `bm` state shape (likely `{jobId, state}` per stem in a `Record<string, ...>`).

- [ ] **Step 2: Add a vocals-specific generator**

Add this function alongside `generateBeatmap`:

```tsx
const generateVocalBeatmap = async () => {
  setBeatmaps((prev) => ({ ...prev, vocals: { jobId: '', state: 'generating' } }))
  const meta = {
    artist: songIni.artist || '',
    title: songIni.name || '',
    album: songIni.album || undefined,
    duration_s: typeof metadata.duration === 'number' ? metadata.duration : undefined,
  }
  try {
    const res = await fetch(`/api/vocals/generate?job_id=${jobId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(meta),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.detail || `HTTP ${res.status}`)
    }
    const { job_id } = await res.json()
    setBeatmaps((prev) => ({ ...prev, vocals: { jobId: job_id, state: 'generating' } }))
  } catch (e) {
    console.error('vocal beatmap start failed:', e)
    setBeatmaps((prev) => ({ ...prev, vocals: { jobId: '', state: 'error' } }))
  }
}
```

- [ ] **Step 3: Use generateVocalBeatmap when stem === 'vocals'**

In the per-stem render where `Generate Beatmap` is clicked, change the onClick to dispatch by stem:

```tsx
<button
  onClick={() => stem === 'vocals' ? generateVocalBeatmap() : generateBeatmap(stem)}
  className="px-3 py-1.5 bg-green-700/60 hover:bg-green-600/70 text-green-200 rounded text-xs font-medium transition-colors w-full"
>
  Generate Beatmap
</button>
```

- [ ] **Step 4: Confirm SSE progress already renders**

The existing `StemBeatmapTracker` component already subscribes to `/api/beatmap/${beatmapJobId}/status`. Vocals jobs use `/api/jobs/{job_id}/events` instead — the existing tracker can't subscribe to that endpoint.

For Plan A symmetry and minimal change, add a parallel `VocalBeatmapTracker` that mirrors `StemBeatmapTracker` but subscribes to the right URL. Place it next to `StemBeatmapTracker` in the same file:

```tsx
function VocalBeatmapTracker({
  beatmapJobId,
  onCancelled,
  onDone,
}: {
  beatmapJobId: string
  onCancelled?: () => void
  onDone?: () => void
}) {
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState('Starting...')
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const es = new EventSource(`/api/jobs/${beatmapJobId}/events`)
    es.onmessage = (e) => {
      const data = JSON.parse(e.data)
      if (typeof data.progress === 'number' && data.progress >= 0) setProgress(data.progress)
      if (data.message) setMessage(data.message)
      if (data.step === 'done') {
        es.close()
        setDone(true)
        onDone?.()
      } else if (data.step === 'error') {
        es.close()
        setError(data.message || 'Failed')
      } else if (data.step === 'cancelled') {
        es.close()
        onCancelled?.()
      }
    }
    es.onerror = () => { es.close(); setError('Connection lost') }
    return () => es.close()
  }, [beatmapJobId, onCancelled, onDone])

  if (done) return <div className="text-xs text-emerald-400 mt-1">Done — {Math.max(progress, 100)}%</div>
  if (error) return <div className="text-xs text-red-400 mt-1">{error}</div>
  return (
    <div className="mt-1 space-y-1">
      <div className="w-full bg-gray-900 rounded-full h-1.5 overflow-hidden">
        <div className="bg-jam-500 h-full rounded-full transition-all duration-500"
             style={{ width: `${Math.max(progress, 2)}%` }} />
      </div>
      <div className="text-xs text-gray-500 truncate">{message}</div>
    </div>
  )
}
```

In the per-stem render, where `StemBeatmapTracker` is currently rendered for in-flight beatmap jobs, branch on stem:

```tsx
{bm?.state === 'generating' && bm.jobId && (
  stem === 'vocals'
    ? <VocalBeatmapTracker
        beatmapJobId={bm.jobId}
        onCancelled={() => setBeatmaps((prev) => { const n = { ...prev }; delete n.vocals; return n })}
        onDone={() => setBeatmaps((prev) => ({ ...prev, vocals: { ...prev.vocals!, state: 'done' } }))}
      />
    : <StemBeatmapTracker beatmapJobId={bm.jobId} {/* ... existing props */} />
)}
```

- [ ] **Step 5: Type-check**

```bash
cd web/frontend && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit + push + deploy**

```bash
cd C:\Users\Admin\Documents\GitHub\madmom
git add web/frontend/src/components/StemResult.tsx
git commit -m "feat(vocals): rewire vocals Generate Beatmap to /api/vocals/generate"
git push origin main
ssh -i ~/.ssh/id_ed25519_beatmap -o StrictHostKeyChecking=no root@137.184.217.203 \
  "cd /opt/madmom && git fetch origin main && git reset --hard origin/main \
   && cd web/frontend && npm run build 2>&1 | tail -5 \
   && systemctl restart beatmap-backend && systemctl is-active beatmap-backend"
```

---

### Task 12: Library track detail — same rewire on vocals stem

**Files:**
- Modify: `web/frontend/src/pages/TracksPage.tsx`

If the library track detail also renders a `Generate Beatmap` per stem (it does — search for it), do the same conditional dispatch and the same `VocalBeatmapTracker` import. Otherwise skip this task.

- [ ] **Step 1: Locate the per-stem Generate Beatmap on the library detail**

Open `web/frontend/src/pages/TracksPage.tsx`. Search for `Generate Beatmap`. If a per-stem button exists, note where the click handler dispatches.

If the file does NOT have a per-stem Generate Beatmap (only the Studio Library list/grid uses pre-generated beatmaps), skip to step 4 with the message "Library detail has no per-stem generator; nothing to rewire."

- [ ] **Step 2: Apply the conditional dispatch**

Mirror Task 11 — for `stem === 'vocals'`, post to `/api/vocals/generate?track_id=${selectedTrack.id}` (note `track_id` not `job_id`); use the same `VocalBeatmapTracker` (move it to a shared component file if both pages need it: `web/frontend/src/components/VocalBeatmapTracker.tsx`).

If you extract `VocalBeatmapTracker` to a shared file:

```tsx
// web/frontend/src/components/VocalBeatmapTracker.tsx
// (same body as in StemResult.tsx; export default)
```

Then `import VocalBeatmapTracker from '../components/VocalBeatmapTracker'` in both consumers.

- [ ] **Step 3: Type-check**

```bash
cd web/frontend && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit + push + deploy**

```bash
cd C:\Users\Admin\Documents\GitHub\madmom
git add web/frontend/src/pages/TracksPage.tsx web/frontend/src/components/VocalBeatmapTracker.tsx web/frontend/src/components/StemResult.tsx
git commit -m "feat(vocals): library detail also dispatches vocals to /api/vocals/generate"
git push origin main
ssh -i ~/.ssh/id_ed25519_beatmap -o StrictHostKeyChecking=no root@137.184.217.203 \
  "cd /opt/madmom && git fetch origin main && git reset --hard origin/main \
   && cd web/frontend && npm run build 2>&1 | tail -5 \
   && systemctl restart beatmap-backend && systemctl is-active beatmap-backend"
```

---

### Task 13: Stale-lyrics banner

**Files:**
- Modify: `web/frontend/src/components/StemResult.tsx` (and TracksPage if applicable)

When a track has both `lyrics.json` and `vocal_notes.json`, the front-end can detect when the lyrics have changed since the vocal notes were generated by comparing `vocal_notes.lyrics_etag` against a freshly-computed sha1 of the current lyrics JSON. If they differ, show a small inline banner above the Generate Beatmap button: *"Lyrics changed — regenerate vocal beatmap."*

- [ ] **Step 1: Add a small helper hook**

In `StemResult.tsx`, after the existing `useEffect` that loads `stemPeaks`, add another effect that loads vocal notes alongside lyrics and compares:

```tsx
const [vocalNotes, setVocalNotes] = useState<{ lyrics_etag?: string } | null>(null)
const [vocalsStale, setVocalsStale] = useState(false)

useEffect(() => {
  if (!jobId) return
  const ctrl = new AbortController()
  Promise.all([
    fetch(`/api/lyrics?job_id=${jobId}`, { signal: ctrl.signal }).then((r) => r.ok ? r.json() : null),
    fetch(`/api/vocals?job_id=${jobId}`, { signal: ctrl.signal }).then((r) => r.ok ? r.json() : null),
  ])
    .then(async ([lyrics, notes]) => {
      setVocalNotes(notes)
      if (lyrics && notes?.lyrics_etag) {
        // sha1 in the browser via SubtleCrypto
        const canonical = JSON.stringify(lyrics, Object.keys(lyrics).sort())
        const buf = new TextEncoder().encode(canonical)
        const hash = await crypto.subtle.digest('SHA-1', buf)
        const hex = Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('')
        setVocalsStale(hex !== notes.lyrics_etag)
      }
    })
    .catch(() => {})
  return () => ctrl.abort()
}, [jobId])
```

NOTE: the canonical JSON for the etag must match the backend's `json.dumps(lyrics, sort_keys=True, ensure_ascii=False)` byte-for-byte for the sha1 to match. `JSON.stringify(lyrics, Object.keys(lyrics).sort())` is a close approximation only. If etags don't line up at runtime, simplify by storing a smaller deterministic projection of the lyrics (e.g., concatenation of `time_s|text` per word) rather than the full JSON.

- [ ] **Step 2: Render the banner above Generate Beatmap (vocals card only)**

In the per-stem render, just before the Generate Beatmap button, when `stem === 'vocals' && vocalsStale && vocalNotes`:

```tsx
{stem === 'vocals' && vocalsStale && (
  <div className="bg-amber-900/40 border border-amber-800 rounded p-2 text-xs text-amber-200">
    Lyrics changed since vocal beatmap was generated. Click <span className="font-medium">Re-generate</span> to refresh.
  </div>
)}
```

When `vocalNotes` is non-null and not stale, change the button label from `Generate Beatmap` to `Re-generate vocals`:

```tsx
<button
  onClick={() => stem === 'vocals' ? generateVocalBeatmap() : generateBeatmap(stem)}
  ...
>
  {stem === 'vocals' && vocalNotes ? 'Re-generate vocals' : 'Generate Beatmap'}
</button>
```

- [ ] **Step 3: Type-check**

```bash
cd web/frontend && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit + push + deploy**

```bash
cd C:\Users\Admin\Documents\GitHub\madmom
git add web/frontend/src/components/StemResult.tsx
git commit -m "feat(vocals): stale-lyrics banner + re-generate button on vocals card"
git push origin main
ssh -i ~/.ssh/id_ed25519_beatmap -o StrictHostKeyChecking=no root@137.184.217.203 \
  "cd /opt/madmom && git fetch origin main && git reset --hard origin/main \
   && cd web/frontend && npm run build 2>&1 | tail -5 \
   && systemctl restart beatmap-backend && systemctl is-active beatmap-backend"
```

---

## Phase 4 — Manual verification

### Task 14: End-to-end on a known LRClib track

- [ ] **Step 1: Pick a track that already has lyrics**

You have lyrics for "The Fate of Ophelia" (Track ID `51bfb862866c`) from the Plan A smoke. Open the Studio Library detail for that track in the dev UI: http://localhost:5173/.

- [ ] **Step 2: Click Generate Beatmap on the vocals stem**

Watch the SSE progress bar. Expected steps in order: `init` → `crepe-load` → `crepe` → `align` → `write` → `done` (since lyrics already exist, the `lyrics-fetch` and `whisper` steps are skipped).

First run takes a couple of minutes on CPU and downloads the CREPE model (~30 MB) to `~/.cache/torchcrepe/`.

- [ ] **Step 3: Inspect the persisted vocal_notes.json**

```bash
curl -s "http://127.0.0.1:8000/api/vocals?track_id=51bfb862866c" | python -m json.tool | head -50
```

Verify: `version: 1`, `pitch_model: "torchcrepe-full"`, ~hundreds of `syllables`, each with non-zero `midi_pitch`, `voicing` populated, `pitch_curve_st` non-empty for sung syllables.

- [ ] **Step 4: Publish to Game**

Click Publish to Game on the same track. The published response payload (in the network tab or backend log) should include:

```json
"vocals": {
  "syllable_count": <N>,
  "voicing": { "sung": ..., "spoken": ..., "whispered": ... },
  "pitch_model": "torchcrepe-full",
  "included": true
}
```

- [ ] **Step 5: Inspect the published chart**

Open the SongInbox commit on GitHub. The published `notes.chart` should contain a `[JamseshVocals]` block. Spot-check 3–5 syllables for plausible pitches (e.g., a sustained note shows ≥ 5 entries in `C` curve; a phrase boundary has `P start` / `P end` markers).

The old `[Events]` block should NOT contain `phrase_start` / `phrase_end` / `lyric ` entries from previous Plan A publishes.

---

### Task 15: End-to-end on a Whisper-fallback track

- [ ] **Step 1: Pick or upload an obscure track that LRClib won't have**

Run YouTube ingest on a niche cover or remix where LRClib has no synced lyrics. Wait for separation.

- [ ] **Step 2: Click Generate Beatmap on the vocals card directly**

Don't click Get Lyrics first. The vocals pipeline should: try LRClib (miss), fall back to Whisper, then run CREPE.

Watch the SSE: `init` → `lyrics-fetch` (LRClib) → `lyrics-fetch` (no match — falling to Whisper) → `whisper` (downloading model first time, takes minutes) → `crepe-load` → `crepe` → `align` → `write` → `done`.

- [ ] **Step 3: Verify the persisted artifacts**

Both `lyrics.json` and `vocal_notes.json` should be saved in the track stems dir. The lyrics' `source` should be `"whisper"` and the vocal notes' `syllabified_from` should be `"whisper"`.

---

### Task 16: In-game render check

- [ ] **Step 1: Open the published track in Clone Hero**

Pull the SongInbox commit folder into a CH library, launch CH, play the song. CH may not natively render `[JamseshVocals]` (custom block). What to check:

- The chart still loads cleanly (existing instrument tracks render normally).
- No parse errors / crashes from the unknown `[JamseshVocals]` section.

If you have the Jamsesh client renderer that consumes `[JamseshVocals]`, also verify pitched-vocal lane renders.

---

## Out of scope for this plan (deferred)

- Vibrato / portamento detection beyond the per-frame curve already stored.
- Real RMS dynamics (current implementation derives a confidence-based proxy in Task 5; a future task can plug in `librosa.feature.rms` for the real envelope).
- Phoneme alignment for lipsync.
- Harmony separation (`[JamseshHarmony1..N]`).
- Manual editor UI for editing pitches.
- UltraStar `.txt` export.
- Backfilling the 64 existing `[ExpertVocals]` charts in SongInbox.

---

## Self-review notes (already applied inline)

- The stale-lyrics etag computation (Task 13) flagged a real risk: matching the backend's `json.dumps(sort_keys=True)` byte-for-byte from the browser is fragile. The task includes an explicit fallback (smaller deterministic projection) if the etag comparison drifts in practice.
- Task 5's `dynamics_db` field is populated from a confidence-based proxy because `detect_pitches` (Task 4) only returns f0 + periodicity. A real RMS envelope is left for a follow-up — the field is still shape-stable, so consumers and the chart format don't break when it's upgraded.
- Whisper fallback inside `/api/vocals/generate` calls `transcribe_with_whisper` synchronously inside `loop.run_in_executor` — the `progress_callback` it expects is sync, matching how Task 10 of Plan A wired it. The wrapper `sync_whisper_progress` here scales pct from Whisper's [0, 100] to the composite [25, 55] range so the UI's overall progress bar is monotonic.
