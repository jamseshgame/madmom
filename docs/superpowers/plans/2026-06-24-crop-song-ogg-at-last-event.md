# Crop song.ogg at last event — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Crop audio" button to the beatmap editor that trims `song.ogg` to end just after the last charted event, with selectable trailing-padding presets.

**Architecture:** A new backend service (`crop_audio.py`) exposes pure chart-parsing helpers (last-event tick, tick→ms, song.ini length update) plus an ffmpeg-backed orchestration function. A new `POST /api/tracks/{tid}/beatmaps/{bid}/crop-audio` endpoint wires it up, computing the crop point authoritatively from the saved `notes.chart`. The editor adds a header button + popover that auto-saves, calls the endpoint, then reloads the audio + waveform.

**Tech Stack:** FastAPI (Python 3.9+), ffmpeg/ffprobe (subprocess), React 18 + TypeScript (Vite).

## Global Constraints

- Black formatter: line length 120, single quotes, target Python 3.9+.
- All Python files start with `from __future__ import annotations`.
- Frontend: TypeScript strict; production gate is `npm run build` (tsc + vite) from `web/frontend/`.
- Run backend tests from the repo root: `pytest web/backend/tests/<file> -v`.
- ffmpeg-dependent tests must be skipped gracefully when ffmpeg/ffprobe is unavailable (match existing audio-test pattern).
- Scope is `song.ogg` only — never touch `sources/*/*.ogg` stems. Overwrite in place (no backup). Update `song_length` in the beatmap's `song.ini`.
- Ogg encode settings must match the codebase: `libvorbis -q:a 6`.

---

### Task 1: Pure chart-parsing helpers in `crop_audio.py`

**Files:**
- Create: `web/backend/app/services/crop_audio.py`
- Test: `web/backend/tests/test_crop_audio.py`

**Interfaces:**
- Consumes: nothing (pure string/number functions).
- Produces:
  - `last_event_tick(content: str) -> int` — max event tick (incl. sustain tails) across every section of a `notes.chart`; `0` if none.
  - `tick_to_ms(content: str, tick: int) -> float` — convert a tick to milliseconds using the `[SyncTrack]` BPM map and `[Song] Resolution`.
  - `update_song_length(ini_text: str, length_ms: int) -> str` — return `song.ini` text with `song_length` set to `length_ms` under `[song]` (replacing or inserting the line).

- [ ] **Step 1: Write the failing tests**

```python
# web/backend/tests/test_crop_audio.py
from __future__ import annotations

from app.services.crop_audio import last_event_tick, tick_to_ms, update_song_length

CHART = """[Song]
{
  Name = "X"
  Resolution = 192
}
[SyncTrack]
{
  0 = TS 4
  0 = B 120000
}
[Events]
{
  768 = E "section intro"
}
[ExpertSingle]
{
  0 = N 0 0
  384 = N 1 96
  1920 = N 2 0
}
[HardSingle]
{
  0 = N 0 0
  2304 = N 0 0
}
"""


def test_last_event_tick_takes_max_across_sections_and_sustains():
    # HardSingle 2304 is the latest start; ExpertSingle 384+96 sustain = 480.
    assert last_event_tick(CHART) == 2304


def test_last_event_tick_includes_sustain_tail():
    chart = '[ExpertSingle]\n{\n  100 = N 0 500\n  200 = N 1 0\n}\n'
    assert last_event_tick(chart) == 600  # 100 + 500 sustain tail


def test_last_event_tick_ignores_non_integer_lhs():
    # Resolution/Name lines must not be parsed as ticks.
    chart = '[Song]\n{\n  Resolution = 192\n  Name = "Y"\n}\n'
    assert last_event_tick(chart) == 0


def test_tick_to_ms_single_tempo():
    # 120 BPM, resolution 192 → 1 beat (192 ticks) = 500 ms.
    assert tick_to_ms(CHART, 192) == 500.0
    assert tick_to_ms(CHART, 384) == 1000.0


def test_tick_to_ms_multi_tempo():
    chart = (
        '[Song]\n{\n  Resolution = 192\n}\n'
        '[SyncTrack]\n{\n  0 = B 120000\n  192 = B 240000\n}\n'
    )
    # First beat at 120 BPM = 500 ms; second beat at 240 BPM = 250 ms.
    assert tick_to_ms(chart, 384) == 750.0


def test_update_song_length_replaces_existing():
    ini = '[song]\nname = X\nsong_length = 99\nartist = Y\n'
    out = update_song_length(ini, 18000)
    assert 'song_length = 18000' in out
    assert 'song_length = 99' not in out


def test_update_song_length_inserts_when_absent():
    ini = '[song]\nname = X\nartist = Y\n'
    out = update_song_length(ini, 18000)
    assert 'song_length = 18000' in out
    assert out.index('[song]') < out.index('song_length = 18000')
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest web/backend/tests/test_crop_audio.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.crop_audio'`.

- [ ] **Step 3: Write the implementation**

```python
# web/backend/app/services/crop_audio.py
"""Crop a beatmap's song.ogg to end just after its last charted event."""
from __future__ import annotations

import re

# Matches a chart event line: "<tick> = <rest>" with an integer left-hand side.
_EVENT_RE = re.compile(r'^\s*(\d+)\s*=\s*(.*)$')
# Note/star-power lines carry a trailing sustain length: "N <fret> <length>".
_NOTE_RE = re.compile(r'^[NSR]\s+\d+\s+(\d+)\s*$')


def last_event_tick(content: str) -> int:
    """Largest event tick across every section, including sustain tails."""
    max_tick = 0
    for m in _EVENT_RE.finditer(content):
        tick = int(m.group(1))
        rest = m.group(2).strip()
        note = _NOTE_RE.match(rest)
        if note:
            tick += int(note.group(1))
        if tick > max_tick:
            max_tick = tick
    return max_tick


def _resolution(content: str) -> int:
    m = re.search(r'Resolution\s*=\s*(\d+)', content)
    return int(m.group(1)) if m else 192


def _tempo_segments(content: str) -> list[tuple[int, float]]:
    """Ordered (tick, micro_bpm) BPM markers from [SyncTrack]. micro_bpm is the
    raw `B` value (bpm * 1000). Always starts at tick 0."""
    sync = re.search(r'\[SyncTrack\]\s*\n\{([^}]*)\}', content)
    markers: list[tuple[int, float]] = []
    if sync:
        for line in sync.group(1).splitlines():
            bm = re.match(r'\s*(\d+)\s*=\s*B\s+(\d+)', line)
            if bm:
                markers.append((int(bm.group(1)), float(bm.group(2))))
    markers.sort(key=lambda x: x[0])
    if not markers or markers[0][0] != 0:
        markers.insert(0, (0, 120000.0))
    return markers


def tick_to_ms(content: str, tick: int) -> float:
    """Convert a tick to milliseconds using the chart's tempo map.

    ms-per-beat = 60_000_000 / micro_bpm; ms-per-tick = ms-per-beat / resolution.
    Mirrors the editor's frontend tickToSec helper.
    """
    resolution = _resolution(content)
    segs = _tempo_segments(content)
    ms = 0.0
    for i, (seg_tick, micro_bpm) in enumerate(segs):
        next_tick = segs[i + 1][0] if i + 1 < len(segs) else None
        ms_per_tick = (60_000_000.0 / micro_bpm) / resolution
        if next_tick is not None and tick >= next_tick:
            ms += (next_tick - seg_tick) * ms_per_tick
        else:
            ms += (tick - seg_tick) * ms_per_tick
            break
    return ms


def update_song_length(ini_text: str, length_ms: int) -> str:
    """Set song_length under [song], replacing an existing line or inserting one."""
    if re.search(r'(?im)^\s*song_length\s*=.*$', ini_text):
        return re.sub(r'(?im)^\s*song_length\s*=.*$', f'song_length = {length_ms}', ini_text)
    # No song_length line — insert right after the [song] header (case-insensitive).
    m = re.search(r'(?im)^\s*\[song\]\s*$', ini_text)
    if m:
        idx = m.end()
        return ini_text[:idx] + f'\nsong_length = {length_ms}' + ini_text[idx:]
    # No [song] section at all — prepend one.
    return f'[song]\nsong_length = {length_ms}\n' + ini_text
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest web/backend/tests/test_crop_audio.py -v`
Expected: PASS (7 passed).

- [ ] **Step 5: Commit**

```bash
git add web/backend/app/services/crop_audio.py web/backend/tests/test_crop_audio.py
git commit -m "feat(crop): chart-parsing helpers for song.ogg cropping"
```

---

### Task 2: Crop orchestration + `crop-audio` endpoint

**Files:**
- Modify: `web/backend/app/services/crop_audio.py` (add `crop_song_ogg`)
- Modify: `web/backend/app/routers/tracks.py` (add endpoint near the song-peaks route, ~line 772)
- Test: `web/backend/tests/test_crop_audio_endpoint.py`

**Interfaces:**
- Consumes: `last_event_tick`, `tick_to_ms`, `update_song_length` (Task 1); `read_audio_metadata` from `app.services.audio`; `get_beatmap_dir` (already imported in `tracks.py`).
- Produces:
  - `crop_song_ogg(bm_dir: Path, padding_ms: int) -> dict` — performs the crop; returns `{'last_event_ms', 'crop_ms', 'duration_ms', 'noop', 'clamped'}`. Raises `ValueError('no-events')` when there is nothing to crop to.
  - Endpoint `POST /{track_id}/beatmaps/{beatmap_id}/crop-audio` accepting JSON `{ "padding_ms": int }`, returning that dict.

- [ ] **Step 1: Write the failing endpoint test**

```python
# web/backend/tests/test_crop_audio_endpoint.py
from __future__ import annotations

import shutil
import subprocess

import pytest

ffmpeg_missing = shutil.which('ffmpeg') is None or shutil.which('ffprobe') is None
pytestmark = pytest.mark.skipif(ffmpeg_missing, reason='ffmpeg/ffprobe not installed')

from app.services.crop_audio import crop_song_ogg

CHART = """[Song]
{
  Name = "X"
  Resolution = 192
}
[SyncTrack]
{
  0 = B 120000
}
[ExpertSingle]
{
  384 = N 0 0
}
"""


def _make_ogg(path, seconds):
    subprocess.run(
        ['ffmpeg', '-y', '-f', 'lavfi', '-i', f'anullsrc=r=44100:cl=mono',
         '-t', str(seconds), '-c:a', 'libvorbis', '-q:a', '6', str(path)],
        capture_output=True, check=True,
    )


def test_crop_trims_to_last_event_plus_padding(tmp_path):
    _make_ogg(tmp_path / 'song.ogg', 10)  # 10s source
    (tmp_path / 'notes.chart').write_text(CHART)
    (tmp_path / 'song.ini').write_text('[song]\nname = X\n')

    # Last event tick 384 @120BPM/res192 = 1000 ms; +500 ms pad → ~1.5 s.
    res = crop_song_ogg(tmp_path, padding_ms=500)

    assert res['last_event_ms'] == 1000.0
    assert res['crop_ms'] == 1500.0
    assert 1.3 < res['duration_ms'] / 1000 < 1.7
    assert res['noop'] is False
    assert 'song_length = ' in (tmp_path / 'song.ini').read_text()


def test_crop_noop_when_source_already_shorter(tmp_path):
    _make_ogg(tmp_path / 'song.ogg', 1)  # 1s source, shorter than 1.5s target
    (tmp_path / 'notes.chart').write_text(CHART)
    (tmp_path / 'song.ini').write_text('[song]\nname = X\n')
    res = crop_song_ogg(tmp_path, padding_ms=500)
    assert res['noop'] is True


def test_crop_raises_when_no_events(tmp_path):
    _make_ogg(tmp_path / 'song.ogg', 5)
    (tmp_path / 'notes.chart').write_text('[Song]\n{\n  Resolution = 192\n}\n')
    (tmp_path / 'song.ini').write_text('[song]\nname = X\n')
    with pytest.raises(ValueError):
        crop_song_ogg(tmp_path, padding_ms=0)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest web/backend/tests/test_crop_audio_endpoint.py -v`
Expected: FAIL with `ImportError: cannot import name 'crop_song_ogg'` (or all skipped if ffmpeg absent — install ffmpeg to exercise).

- [ ] **Step 3: Add `crop_song_ogg` to `crop_audio.py`**

Add these imports at the top of `web/backend/app/services/crop_audio.py` (below `import re`):

```python
import os
import subprocess
from pathlib import Path

from .audio import read_audio_metadata
```

Append this function to `crop_audio.py`:

```python
def crop_song_ogg(bm_dir: Path, padding_ms: int) -> dict:
    """Crop bm_dir/song.ogg to (last event + padding). Overwrites in place and
    updates song_length in song.ini. Returns a result summary.

    Raises ValueError('no-events') if the chart has no croppable events.
    """
    bm_dir = Path(bm_dir)
    song = bm_dir / 'song.ogg'
    chart_path = bm_dir / 'notes.chart'
    padding_ms = max(0, int(padding_ms))

    content = chart_path.read_text(encoding='utf-8', errors='ignore') if chart_path.exists() else ''
    last_tick = last_event_tick(content)
    if last_tick <= 0:
        raise ValueError('no-events')

    last_event_ms = tick_to_ms(content, last_tick)
    crop_ms = last_event_ms + padding_ms

    actual_ms = float(read_audio_metadata(song).get('duration', 0.0)) * 1000.0
    clamped = False
    if actual_ms and crop_ms >= actual_ms:
        # Nothing to trim — target is at or past the file end.
        return {
            'last_event_ms': last_event_ms,
            'crop_ms': crop_ms,
            'duration_ms': actual_ms,
            'noop': True,
            'clamped': True,
        }

    tmp = bm_dir / 'song.crop.ogg'
    proc = subprocess.run(
        ['ffmpeg', '-y', '-i', str(song), '-t', f'{crop_ms / 1000.0:.3f}',
         '-vn', '-c:a', 'libvorbis', '-q:a', '6', str(tmp)],
        capture_output=True, text=True, timeout=120,
    )
    if proc.returncode != 0:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f'ffmpeg crop failed: {proc.stderr[-400:]}')
    os.replace(tmp, song)

    # Invalidate the cached waveform peaks so the editor re-extracts them.
    (bm_dir / 'song.peaks.f32').unlink(missing_ok=True)

    new_ms = float(read_audio_metadata(song).get('duration', crop_ms / 1000.0)) * 1000.0

    ini_path = bm_dir / 'song.ini'
    if ini_path.exists():
        ini_path.write_text(update_song_length(ini_path.read_text(encoding='utf-8'), round(new_ms)),
                            encoding='utf-8')

    return {
        'last_event_ms': last_event_ms,
        'crop_ms': crop_ms,
        'duration_ms': new_ms,
        'noop': False,
        'clamped': clamped,
    }
```

- [ ] **Step 4: Run the service tests to verify they pass**

Run: `pytest web/backend/tests/test_crop_audio_endpoint.py -v`
Expected: PASS (3 passed) when ffmpeg present; SKIPPED otherwise.

- [ ] **Step 5: Add the endpoint to `tracks.py`**

First add the import. Find the existing crop-related import block near the top of `web/backend/app/routers/tracks.py` and add:

```python
from ..services.crop_audio import crop_song_ogg
```

Then insert this route immediately after the `get_beatmap_song_peaks` function (after line ~771, before `@router.get('/{track_id}/beatmaps/{beatmap_id}/chart')`):

```python
@router.post('/{track_id}/beatmaps/{beatmap_id}/crop-audio')
async def crop_beatmap_audio(track_id: str, beatmap_id: str, body: dict):
    """Crop song.ogg to end just after the last charted event, plus padding_ms.
    Overwrites song.ogg and updates song_length in song.ini."""
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        raise HTTPException(404, 'Beatmap not found')
    if not (bm_dir / 'song.ogg').exists():
        raise HTTPException(404, 'song.ogg missing for this beatmap')
    padding_ms = int(body.get('padding_ms', 0) or 0)
    try:
        return crop_song_ogg(bm_dir, padding_ms)
    except ValueError:
        raise HTTPException(400, 'No events to crop to')
    except (RuntimeError, OSError) as e:
        raise HTTPException(500, f'Crop failed: {e}')
```

- [ ] **Step 6: Verify the router imports cleanly**

Run: `python -c "import ast,sys; ast.parse(open('web/backend/app/routers/tracks.py').read()); print('ok')"`
Expected: `ok`

- [ ] **Step 7: Commit**

```bash
git add web/backend/app/services/crop_audio.py web/backend/app/routers/tracks.py web/backend/tests/test_crop_audio_endpoint.py
git commit -m "feat(crop): crop-audio endpoint + ffmpeg orchestration"
```

---

### Task 3: Editor "Crop audio" button + popover

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx`

**Interfaces:**
- Consumes: `crop-audio` endpoint (Task 2); existing `tickToSec`, `secToTick`, `handleSave`, `dirty`, `tempoSegments`, `chart`, `trackId`, `beatmapId`, `audioSource`, `setCurrentTime` in `BeatmapEditor`.
- Produces: UI only — no exported symbols.

- [ ] **Step 1: Add crop state next to the existing save state**

Find the `audioSrc` definition (line ~3846) and add a crop-reload counter just above it:

```typescript
  // Bumped after a crop to force <audio> + waveform to refetch the new song.ogg.
  const [cropVersion, setCropVersion] = useState(0)
```

Then change the `audioSrc` beatmap branch to cache-bust on `cropVersion`:

```typescript
  const audioSrc = audioSource === 'track-song'
    ? `/api/tracks/${trackId}/stems/song`
    : `/api/tracks/${trackId}/beatmaps/${beatmapId}/download/song.ogg?v=${cropVersion}`
```

- [ ] **Step 2: Add crop popover UI state and the handler**

Add near the other editor UI state (e.g. just after the `cropVersion` line):

```typescript
  const [cropOpen, setCropOpen] = useState(false)
  const [cropPadMs, setCropPadMs] = useState(1000)
  const [cropBusy, setCropBusy] = useState(false)
  const [cropMsg, setCropMsg] = useState('')

  // Approximate last-event time from the in-memory chart (active difficulty
  // only) — display hint; the backend computes the authoritative value.
  const cropPreviewSec = useMemo(() => {
    if (!chart) return 0
    const tickEnds = [
      0,
      ...chart.notes.map((n) => n.tick + (n.sustain || 0)),
      ...chart.sceneEvents.map((e) => e.tick + (e.duration || 0)),
      ...chart.tutorial.map((e) => e.tick),
    ]
    const lastTick = Math.max(...tickEnds)
    const sec = tickToSec(tempoSegments, chart.resolution, lastTick)
    const clipEnd = Math.max(0, ...chart.clips.map((c) => c.endSec))
    return Math.max(sec, clipEnd)
  }, [chart, tempoSegments])

  const fmtTime = (sec: number) => {
    const m = Math.floor(sec / 60)
    const s = sec - m * 60
    return `${m}:${s.toFixed(1).padStart(4, '0')}`
  }

  const handleCrop = async () => {
    if (!chart) return
    setCropBusy(true)
    setCropMsg('')
    try {
      if (dirty) await handleSave()
      const res = await fetch(`/api/tracks/${trackId}/beatmaps/${beatmapId}/crop-audio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ padding_ms: Math.max(0, Math.round(cropPadMs)) }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Crop failed (${res.status})`)
      }
      const data = await res.json()
      if (data.noop) {
        setCropMsg(`Already ≤ crop length (${fmtTime(data.duration_ms / 1000)})`)
      } else {
        const tail = data.clamped ? ' (file end reached)' : ''
        setCropMsg(`Cropped to ${fmtTime(data.duration_ms / 1000)}${tail}`)
        setCropVersion((v) => v + 1)  // reload audio + waveform
      }
    } catch (e) {
      setCropMsg((e as Error).message || 'Crop failed')
    } finally {
      setCropBusy(false)
    }
  }
```

- [ ] **Step 3: Add the button + popover before the Save button**

In the header, immediately before the `<button onClick={handleSave} ...>` block (line ~7458), insert:

```tsx
        <div className="relative shrink-0">
          <button
            onClick={() => { setCropMsg(''); setCropOpen((o) => !o) }}
            disabled={!chart || audioSource !== 'beatmap'}
            title="Trim song.ogg to end just after the last charted event"
            className="px-3 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-200 rounded-md text-sm font-medium transition-colors"
          >
            Crop audio
          </button>
          {cropOpen && (
            <div className="absolute right-0 top-full mt-1 z-30 w-64 bg-gray-900 border border-gray-700 rounded-lg shadow-xl p-3 space-y-2">
              <div className="text-[11px] text-gray-400">
                Last event ≈ <span className="text-gray-200">{fmtTime(cropPreviewSec)}</span>
                <br />
                Crop to ≈ <span className="text-gray-200">{fmtTime(cropPreviewSec + cropPadMs / 1000)}</span>
              </div>
              <div className="flex gap-1">
                {[0, 500, 1000, 2000].map((ms) => (
                  <button
                    key={ms}
                    onClick={() => setCropPadMs(ms)}
                    className={`flex-1 px-1 py-1 rounded text-[11px] ${cropPadMs === ms ? 'bg-jam-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
                  >
                    {ms === 0 ? '0s' : `${ms / 1000}s`}
                  </button>
                ))}
              </div>
              <label className="block text-[11px] text-gray-500">
                custom pad (ms)
                <input
                  type="number"
                  min={0}
                  value={cropPadMs}
                  onChange={(e) => setCropPadMs(Number(e.target.value))}
                  className="mt-0.5 block w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
                />
              </label>
              <button
                onClick={() => void handleCrop()}
                disabled={cropBusy}
                className="w-full px-2 py-1.5 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded text-xs font-medium"
              >
                {cropBusy ? 'Cropping…' : 'Crop song.ogg (overwrites)'}
              </button>
              {cropMsg && <div className="text-[11px] text-gray-300">{cropMsg}</div>}
            </div>
          )}
        </div>
```

- [ ] **Step 4: Type-check and build**

Run (from `web/frontend/`): `npm run build`
Expected: build succeeds with no TypeScript errors. If `useMemo` is not already imported, add it to the React import at the top of the file.

- [ ] **Step 5: Manual verification**

1. Start backend (`web/backend/`: `venv/Scripts/python.exe run.py`) and frontend (`web/frontend/`: `npm run dev`).
2. Open a beatmap with a `song.ogg` longer than its charted content (the "Guitar Lesson One" tutorial is ideal).
3. Confirm the **Crop audio** button sits left of **Save now** and is disabled when the audio source is the full track song (toggle to beatmap stem to enable).
4. Open the popover, pick **1s**, click **Crop song.ogg**. Confirm: status shows `Cropped to M:SS`, the waveform/timeline shrink to the new length, and playback ends at the new duration.
5. Reload the page; the song stays cropped. Open `song.ini`; `song_length` matches the new duration (ms).
6. Click Crop again with the same padding → status `Already ≤ crop length`.

- [ ] **Step 6: Commit**

```bash
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(crop): editor Crop audio button + padding popover"
```

---

## Self-Review notes

- **Spec coverage:** crop point = max tick incl. sustains/scene/tutorial (Task 1 `last_event_tick` scans all sections; tutorial/scene sections covered by the generic integer-LHS scan) ✓; song.ogg only ✓; overwrite + song_length update (Task 2 `crop_song_ogg`) ✓; seconds padding presets + custom ms (Task 3) ✓; clamp/no-silence + status, no-events 400, already-short noop (Tasks 2/3) ✓; backend unit + endpoint tests ffmpeg-gated ✓.
- **Type consistency:** `crop_song_ogg` returns `{last_event_ms, crop_ms, duration_ms, noop, clamped}` — produced in Task 2, consumed identically by the Task 3 handler. `cropVersion`/`cropPadMs`/`cropOpen`/`cropBusy`/`cropMsg` all declared in Task 3 Steps 1–2 before use in Step 3.
- **VO clip end:** in this editor VO/tutorial cues are placed at chart ticks (`chart.tutorial[].tick`), so they are covered by the tick scan; there is no separate ms-based VO duration to fold in beyond the generic scan. Padding presets give the trailing buffer.
```
