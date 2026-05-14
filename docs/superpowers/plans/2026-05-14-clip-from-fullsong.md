# Clip-from-Full-Song Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Studio editor gains a waveform strip below the existing tutorial timeline, drag-region clip authoring against the track's `song.ogg`, and a sidebar Clips library that places saved clips into the tutorial as slice-mode `MUSIC` events.

**Architecture:** Frontend computes the note slice from the in-memory chart and persists it as a new `[MusicSeg_<id>]` chart section with a `; name=...` comment header. Audio stays as one whole `song.ogg`; chart `MUSIC` events gain optional `start_ms` / `duration_ms` fields (mirrors VO collated-bundle pattern). Backend gets one new endpoint (`song-peaks`) and one publish-time tweak (strip orphan `MusicSeg` sections).

**Tech Stack:** Backend: FastAPI, numpy, ffmpeg subprocess, pytest. Frontend: React 18 + TypeScript + Tailwind, no test scaffold (manual smoke).

---

## Task 1: Backend — `compute_audio_peaks` helper

**Files:**
- Modify: `web/backend/app/services/audio.py` (append at end of file)
- Test: `web/backend/tests/test_song_peaks.py` (create)

- [ ] **Step 1: Write the failing tests**

Create `web/backend/tests/test_song_peaks.py`:

```python
"""Tests for the audio-peaks helper used by the WaveformStrip endpoint."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import scipy.io.wavfile as wav

from app.services.audio import compute_audio_peaks


def _write_wav(path: Path, samples: np.ndarray, sample_rate: int = 44100) -> None:
    """Write a mono int16 wav. Samples are float32 in [-1, 1]; we scale
    to int16 for a lossless round-trip through madmom's loader."""
    int16 = np.clip(samples, -1.0, 1.0)
    int16 = (int16 * 32767.0).astype(np.int16)
    wav.write(str(path), sample_rate, int16)


def test_silent_audio_peaks_are_zero(tmp_path):
    """1 s of literal silence → ~50 buckets at 20 ms each, all zero."""
    audio = tmp_path / 'silent.wav'
    _write_wav(audio, np.zeros(44100, dtype=np.float32))
    blob = compute_audio_peaks(audio, bucket_ms=20)
    peaks = np.frombuffer(blob, dtype=np.float32)
    assert 49 <= len(peaks) <= 51
    assert peaks.max() == 0.0


def test_peaks_track_amplitude(tmp_path):
    """A pure 1 kHz sine at peak amplitude 0.5 should produce per-bucket
    peaks at ~0.5. Lossless wav → peaks land within int16 quantization
    tolerance of the input level."""
    sr = 44100
    t = np.arange(sr) / sr
    sine = (0.5 * np.sin(2 * np.pi * 1000 * t)).astype(np.float32)
    audio = tmp_path / 'tone.wav'
    _write_wav(audio, sine, sample_rate=sr)
    blob = compute_audio_peaks(audio, bucket_ms=20)
    peaks = np.frombuffer(blob, dtype=np.float32)
    assert 49 <= len(peaks) <= 51
    # 1 kHz period (1 ms) << 20 ms bucket → every bucket contains many
    # full cycles, so peak per bucket = sine peak. Tolerance covers
    # int16 quantization (~3e-5 absolute error).
    assert 0.495 <= peaks.mean() <= 0.505
    assert 0.495 <= peaks.min() <= peaks.max() <= 0.505


def test_compute_raises_on_missing_file(tmp_path):
    with pytest.raises(Exception):
        compute_audio_peaks(tmp_path / 'does-not-exist.wav', bucket_ms=20)
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `web/backend/`:
```
venv/Scripts/python.exe -m pytest tests/test_song_peaks.py -v
```
Expected: 3 errors / failures (`compute_audio_peaks` import doesn't resolve).

- [ ] **Step 3: Implement the helper using madmom**

Append to `web/backend/app/services/audio.py`:

```python
from pathlib import Path

import numpy as np


def compute_audio_peaks(audio_path: Path, bucket_ms: int = 20) -> bytes:
    """Load `audio_path` via madmom's Signal and collapse each `bucket_ms`
    window into its absolute-peak amplitude in [0, 1].

    Returns the binary representation of a Float32 array — small enough
    to ship over the wire as application/octet-stream and `Float32Array`
    -decode directly in the browser. madmom handles decoding (delegating
    to ffmpeg internally for non-wav formats) and gives us a numpy array
    + sample-rate in one call, which keeps this helper tiny.
    """
    from madmom.audio.signal import Signal

    sig = Signal(str(audio_path), num_channels=1)
    samples = np.asarray(sig)
    if samples.size == 0:
        return b''
    # madmom returns int16 for integer source formats and float for
    # everything else. Normalize both to float32 in [-1, 1].
    if np.issubdtype(samples.dtype, np.integer):
        info = np.iinfo(samples.dtype)
        samples = samples.astype(np.float32) / max(abs(info.min), info.max)
    else:
        samples = samples.astype(np.float32, copy=False)

    sr = int(sig.sample_rate)
    spb = max(1, int(sr * bucket_ms / 1000))
    n_buckets = (samples.size + spb - 1) // spb
    pad = n_buckets * spb - samples.size
    if pad > 0:
        samples = np.pad(samples, (0, pad))
    reshaped = samples.reshape(n_buckets, spb)
    peaks = np.abs(reshaped).max(axis=1).astype(np.float32)
    return peaks.tobytes()
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```
venv/Scripts/python.exe -m pytest tests/test_song_peaks.py -v
```
Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```
git add web/backend/app/services/audio.py web/backend/tests/test_song_peaks.py
git commit -m "feat(audio): compute_audio_peaks helper for waveform display"
```

---

## Task 2: Backend — `GET /song-peaks` endpoint with on-disk caching

**Files:**
- Modify: `web/backend/app/routers/tracks.py` (add new route handler near other `@router.get('/{track_id}/...')` handlers, around the stem-serving routes)
- Modify: `web/backend/tests/test_song_peaks.py` (append endpoint tests)

- [ ] **Step 1: Write the failing endpoint tests**

Append to `web/backend/tests/test_song_peaks.py`:

```python
import time
from fastapi.testclient import TestClient

from app.main import app
from app.services import tracks as tracks_service


@pytest.fixture
def authed_client():
    c = TestClient(app)
    r = c.post('/api/auth/login', data={'username': 'admin', 'password': 'SlayTheStage'})
    assert r.status_code == 200
    return c


def test_song_peaks_endpoint_returns_binary_blob(tmp_path, monkeypatch, authed_client):
    """Endpoint creates a track with a song.ogg, requests peaks, gets back
    a binary octet-stream that decodes as Float32 array."""
    monkeypatch.setattr(tracks_service, 'TRACKS_DIR', tmp_path / '_tracks')
    audio = tmp_path / 'src.ogg'
    _silent_ogg(audio, seconds=1.0)
    track = tracks_service.create_track(
        name='peaks-test', stems={'song': 'song.ogg'},
        source_stems_dir=tmp_path, model='manual', output_format='ogg',
    )
    # The fixture creates from source_stems_dir / filename; we created src.ogg, but
    # the stem map says 'song.ogg' — copy the source so create_track sees it.
    (tmp_path / 'song.ogg').write_bytes(audio.read_bytes())
    # Re-create with the right filename present this time.
    (track.stems_dir / 'song.ogg').write_bytes(audio.read_bytes())

    r = authed_client.get(f'/api/tracks/{track.id}/song-peaks')
    assert r.status_code == 200
    assert r.headers['content-type'] == 'application/octet-stream'
    peaks = np.frombuffer(r.content, dtype=np.float32)
    assert 49 <= len(peaks) <= 51

    # Cache file should now exist.
    cache = track.stems_dir / 'song.peaks.f32'
    assert cache.exists()
    assert cache.read_bytes() == r.content


def test_song_peaks_404_for_unknown_track(authed_client):
    r = authed_client.get('/api/tracks/nope-not-real/song-peaks')
    assert r.status_code == 404


def test_song_peaks_404_for_missing_stem(tmp_path, monkeypatch, authed_client):
    monkeypatch.setattr(tracks_service, 'TRACKS_DIR', tmp_path / '_tracks')
    track = tracks_service.create_track(
        name='no-song', stems={'song': 'song.ogg'},
        source_stems_dir=tmp_path, model='manual', output_format='ogg',
    )
    # Don't create the stem file
    r = authed_client.get(f'/api/tracks/{track.id}/song-peaks')
    assert r.status_code == 404


def test_song_peaks_cache_hit_skips_recompute(tmp_path, monkeypatch, authed_client):
    monkeypatch.setattr(tracks_service, 'TRACKS_DIR', tmp_path / '_tracks')
    audio = tmp_path / 'src.ogg'
    _silent_ogg(audio, seconds=1.0)
    track = tracks_service.create_track(
        name='cache-test', stems={'song': 'song.ogg'},
        source_stems_dir=tmp_path, model='manual', output_format='ogg',
    )
    (track.stems_dir / 'song.ogg').write_bytes(audio.read_bytes())

    # Prime the cache
    r1 = authed_client.get(f'/api/tracks/{track.id}/song-peaks')
    assert r1.status_code == 200
    cache = track.stems_dir / 'song.peaks.f32'
    cached_bytes = cache.read_bytes()

    # Stamp the cache as newer than song.ogg, then write garbage to it
    # so we can detect whether the endpoint served the cache or recomputed.
    import time as _t
    _t.sleep(0.05)
    cache.write_bytes(b'\x00' * 16)
    cache_mtime = cache.stat().st_mtime
    audio_path = track.stems_dir / 'song.ogg'
    # Cache must remain newer than audio
    import os
    os.utime(audio_path, (cache_mtime - 1, cache_mtime - 1))

    r2 = authed_client.get(f'/api/tracks/{track.id}/song-peaks')
    assert r2.status_code == 200
    assert r2.content == b'\x00' * 16  # served straight from cache, not recomputed
```

- [ ] **Step 2: Run tests to verify they fail**

```
venv/Scripts/python.exe -m pytest tests/test_song_peaks.py -v -k endpoint
```
Expected: 4 failures (the route doesn't exist).

- [ ] **Step 3: Implement the endpoint**

Open `web/backend/app/routers/tracks.py`. Find the imports at the top; add `Response`:

```python
from fastapi.responses import FileResponse, Response, StreamingResponse
```

Find the existing `@router.get('/{track_id}/stems/{slot}')` handler. Add this new handler just below it:

```python
@router.get('/{track_id}/song-peaks')
async def get_song_peaks(track_id: str, stem: str = 'song', bucket_ms: int = 20):
    """Return per-bucket audio-peak amplitudes for a stem as a Float32
    binary blob. The WaveformStrip in the editor reads this directly into
    a Float32Array. Cached on disk per stem; re-extracted when the source
    audio is newer than the cache.
    """
    track = get_track(track_id)
    if track is None:
        raise HTTPException(404, 'Track not found')
    filename = track.stems.get(stem)
    if not filename:
        raise HTTPException(404, f'Stem {stem!r} not on this track')
    audio_path = track.stems_dir / filename
    if not audio_path.exists():
        raise HTTPException(404, 'Audio file missing')
    cache_path = track.stems_dir / f'{stem}.peaks.f32'
    if cache_path.exists() and cache_path.stat().st_mtime >= audio_path.stat().st_mtime:
        return Response(content=cache_path.read_bytes(), media_type='application/octet-stream')
    try:
        from ..services.audio import compute_audio_peaks
        blob = compute_audio_peaks(audio_path, bucket_ms=bucket_ms)
    except RuntimeError as e:
        raise HTTPException(500, f'Peak extraction failed: {e}')
    cache_path.write_bytes(blob)
    return Response(content=blob, media_type='application/octet-stream')
```

- [ ] **Step 4: Run tests to verify they pass**

```
venv/Scripts/python.exe -m pytest tests/test_song_peaks.py -v
```
Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```
git add web/backend/app/routers/tracks.py web/backend/tests/test_song_peaks.py
git commit -m "feat(api): GET /tracks/<id>/song-peaks endpoint with on-disk cache"
```

---

## Task 3: Frontend — extend chart parser/serializer for clip metadata

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx` (around `parseMusicSections` ≈ line 615 and `serializeMusicSections`)

- [ ] **Step 1: Add the `Clip` interface near the other tutorial interfaces**

Find the block defining `TutorialMusicEvent` (around line 65). Right below `TutorialEvent` type union (around line 81), add:

```ts
// A library of clipped audio sections, derived at parse-time from
// [MusicSeg_*] chart sections. A clip is a slice into the track's
// song.ogg (startSec/endSec set) or an upload-derived standalone file
// (startSec/endSec both 0). The library panel shows both kinds; only
// slice clips render as draggable regions on the WaveformStrip.
interface Clip {
  id: string                 // matches the section name's id suffix
  sectionName: string        // e.g. 'MusicSeg_a3f8c2'
  name: string               // user-facing label
  startSec: number           // 0 for upload-based clips
  endSec: number             // 0 for upload-based clips
  notesCount: number
  bpm: number                // local tempo at startSec, for display
}
```

- [ ] **Step 2: Add `clips: Clip[]` to `ChartState`**

Find the `ChartState` interface (around line 72-100). Add a field:

```ts
interface ChartState {
  // ... existing fields ...
  musicSections: Record<string, string>
  clips: Clip[]              // NEW
  // ... existing fields ...
}
```

- [ ] **Step 3: Add the `parseClipMetadata` helper**

Find the `parseMusicSections` function (around line 615). Above it, add:

```ts
// Each [MusicSeg_<id>] section can carry optional clip metadata in a
// comment line at the top of its body:
//   ; name="Guitar solo" start_sec=18.300 end_sec=42.300
// The clip authoring flow writes this; upload-based segments don't.
function parseClipMetadata(body: string): { name: string; startSec: number; endSec: number } | null {
  const m = body.match(/;\s*name="([^"]*)"\s+start_sec=([\d.]+)\s+end_sec=([\d.]+)/)
  if (!m) return null
  return { name: m[1], startSec: Number(m[2]), endSec: Number(m[3]) }
}
```

- [ ] **Step 4: Add the `deriveClips` helper**

Below `parseClipMetadata`, add:

```ts
function deriveClips(
  musicSections: Record<string, string>,
  events: TutorialEvent[],
): Clip[] {
  const out: Clip[] = []
  for (const [sectionName, body] of Object.entries(musicSections)) {
    const meta = parseClipMetadata(body)
    const ev = events.find(
      (e): e is TutorialMusicEvent => e.kind === 'music' && e.sectionName === sectionName,
    )
    const id = sectionName.replace(/^MusicSeg_/, '')
    const noteLines = body.split('\n').filter((l) => /^\s*\d+\s*=\s*[NR]\s+/.test(l))
    out.push({
      id,
      sectionName,
      name: meta?.name ?? (ev?.file?.split('/').pop() ?? sectionName),
      startSec: meta?.startSec ?? 0,
      endSec: meta?.endSec ?? 0,
      notesCount: noteLines.length,
      bpm: ev?.bpm ?? 120,
    })
  }
  return out
}
```

- [ ] **Step 5: Wire `clips` into `parseChart`**

Find where `parseChart` builds the returned `ChartState` (around line 837 — search for `musicSections = parseMusicSections(text)`). After that line, add:

```ts
const clips = deriveClips(musicSections, tutorial)
```

In the returned object (around line 856), add `clips,` to the property list.

- [ ] **Step 6: Update `serializeMusicSections` to emit the comment line**

Find `serializeMusicSections` (around line 683). Before it emits each section's body, prepend the comment line if the matching clip has metadata. Replace the body emission with:

```ts
function serializeMusicSections(
  musicSections: Record<string, string>,
  events: TutorialEvent[],
  clips: Clip[],
): string {
  const out: string[] = []
  for (const [sectionName, body] of Object.entries(musicSections)) {
    const clip = clips.find((c) => c.sectionName === sectionName)
    let prefix = ''
    if (clip && (clip.startSec > 0 || clip.endSec > 0 || clip.name !== sectionName)) {
      prefix = `\n  ; name="${clip.name.replace(/"/g, '')}" start_sec=${clip.startSec.toFixed(3)} end_sec=${clip.endSec.toFixed(3)}\n`
      // If body already has a leading comment line, strip it so we don't dupe.
      const stripped = body.replace(/^\n?\s*;\s*name="[^"]*"\s+start_sec=[\d.]+\s+end_sec=[\d.]+\s*\n?/, '\n')
      out.push(`[${sectionName}]\n{${prefix.trimEnd()}${stripped}}\n`)
    } else {
      out.push(`[${sectionName}]\n{${body}}\n`)
    }
  }
  return out.join('')
}
```

Find any caller of `serializeMusicSections` (search for the function name) and add `chart.clips` as the third argument.

- [ ] **Step 7: TypeScript check**

```
cd web/frontend && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 8: Smoke test in browser**

Reload the editor on any track that has a music section (or skip if none — the next task creates one). Confirm the editor still loads without errors. Open DevTools → React inspector → confirm `chart.clips` exists on the editor state.

- [ ] **Step 9: Commit**

```
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): derive Clip[] from [MusicSeg_*] sections"
```

---

## Task 4: Frontend — `sliceChartForClip` helper

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx` (add helper near `parseSectionNotes` ≈ line 362)

- [ ] **Step 1: Add the helper**

Just below `emitNoteSectionLines` (search for `function emitNoteSectionLines`), add:

```ts
// Build a [MusicSeg_*] section body that represents the slice of the
// active difficulty's notes from `startSec` to `endSec`. Mirrors the
// backend bundler's per-section walk: hard clip (notes whose start tick
// falls in [inTick, outTick) get included), sustains trimmed at
// outTick, active (pack, scale) state from the source section
// prepended at tick 0.
//
// Variable-tempo within the clip is NOT supported — clip ticks are
// renormalized linearly. If song.ogg has tempo changes inside the
// region, the clip plays correctly (slice of song.ogg) but the
// note positions will only line up at the slice's start tempo. v2.
function sliceChartForClip(
  notes: ChartNote[],
  tempoSegments: TempoSegment[],
  resolution: number,
  startSec: number,
  endSec: number,
): { sectionBody: string; notesCount: number; bpm: number } {
  const inTick = secToTick(tempoSegments, resolution, startSec)
  const outTick = secToTick(tempoSegments, resolution, endSec)
  const sorted = [...notes].sort((a, b) => a.tick - b.tick || a.lane - b.lane)

  // Active (pack, scale) state at inTick — walk forward from start.
  let preludePack: string | undefined
  let preludeScale: string | undefined
  for (const n of sorted) {
    if (n.tick > inTick) break
    if (n.type === 'real') {
      if (n.pack) preludePack = n.pack
      if (n.scale) preludeScale = n.scale
    }
  }

  // Slice + renormalize.
  const sliced: ChartNote[] = []
  for (const n of sorted) {
    if (n.tick < inTick) continue
    if (n.tick >= outTick) break
    const newTick = n.tick - inTick
    const newSustain = (n.tick + n.sustain > outTick) ? outTick - n.tick : n.sustain
    sliced.push({ ...n, tick: newTick, sustain: newSustain })
  }

  // Emit lines.
  const lines: string[] = []
  if (preludePack) lines.push(`  0 = E realnotes_pack ${preludePack}`)
  if (preludeScale) lines.push(`  0 = E realnotes_scale ${preludeScale}`)
  let curPack = preludePack
  let curScale = preludeScale
  for (const n of sliced) {
    if (n.type === 'real') {
      if (n.pack && n.pack !== curPack) {
        lines.push(`  ${n.tick} = E realnotes_pack ${n.pack}`)
        curPack = n.pack
      }
      if (n.scale && n.scale !== curScale) {
        lines.push(`  ${n.tick} = E realnotes_scale ${n.scale}`)
        curScale = n.scale
      }
      lines.push(`  ${n.tick} = R ${n.lane} ${n.sustain}`)
    } else {
      lines.push(`  ${n.tick} = N ${n.lane} ${n.sustain}`)
    }
  }

  // BPM at startSec.
  let microBpm = tempoSegments[0]?.microBpm ?? 120000
  for (const seg of tempoSegments) {
    if (seg.seconds > startSec) break
    microBpm = seg.microBpm
  }

  return {
    sectionBody: '\n' + lines.join('\n') + '\n',
    notesCount: sliced.filter((n) => n.lane <= 4 || n.lane === 7).length,
    bpm: microBpm / 1000,
  }
}
```

- [ ] **Step 2: TypeScript check**

```
cd web/frontend && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): sliceChartForClip helper for clip authoring"
```

---

## Task 5: Frontend — `WaveformStrip` component (rendering + scrub)

**Files:**
- Create: `web/frontend/src/components/WaveformStrip.tsx`
- Modify: `web/frontend/src/components/BeatmapEditor.tsx` (peaks fetch + slot the strip into the layout)

- [ ] **Step 1: Create the component file**

Write `web/frontend/src/components/WaveformStrip.tsx` with full content:

```tsx
import { useEffect, useRef, useState, type MouseEvent, type WheelEvent } from 'react'

export interface ClipRegion {
  id: string
  startSec: number
  endSec: number
  name: string
  selected?: boolean
}

interface Props {
  peaks: Float32Array | null   // null = empty state (no audio yet)
  duration: number             // seconds — full song length
  bucketSec: number            // each peak's bucket length (e.g. 0.020)
  currentTime: number
  onSeek: (sec: number) => void
  view: { start: number; end: number }
  onViewChange: (v: { start: number; end: number }) => void
  clips: ClipRegion[]
  onSelectClip?: (id: string | null) => void
  onCommitDragRegion?: (startSec: number, endSec: number) => void
}

// Mini horizontal-strip waveform display, designed to live directly
// below the existing TutorialTimeline. Shares its `view` (zoom + pan)
// with the parent so x-pixel ↔ time stays aligned across both strips.
//
// Mouse model:
//   - plain drag        → define a new clip region
//   - shift+click/drag  → scrub the playhead
//   - wheel             → zoom centered on the cursor
//
// Existing library clips render as ghosted regions; selecting one
// (click) fires onSelectClip — caller decides what to highlight in the
// sidebar and whether to snap the strip view.
export function WaveformStrip({
  peaks, duration, bucketSec, currentTime, onSeek, view, onViewChange,
  clips, onSelectClip, onCommitDragRegion,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  const [drag, setDrag] = useState<{ startSec: number; curSec: number } | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setWidth(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  if (!peaks || duration <= 0) {
    return (
      <div className="px-4 py-1.5 text-[11px] text-gray-600 italic bg-gray-950 border-y border-gray-800">
        No song.ogg attached to this track — waveform clipping unavailable.
      </div>
    )
  }

  const span = Math.max(0.001, view.end - view.start)
  const secToX = (s: number) => ((s - view.start) / span) * width
  const xToSec = (x: number) => view.start + (x / Math.max(1, width)) * span

  const handleWheel = (e: WheelEvent) => {
    e.preventDefault()
    const rect = containerRef.current!.getBoundingClientRect()
    const cursorSec = xToSec(e.clientX - rect.left)
    const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2
    const newSpan = Math.min(duration, Math.max(0.5, span * factor))
    let newStart = cursorSec - (cursorSec - view.start) * (newSpan / span)
    let newEnd = newStart + newSpan
    if (newStart < 0) { newEnd -= newStart; newStart = 0 }
    if (newEnd > duration) { newStart -= newEnd - duration; newEnd = duration }
    onViewChange({ start: Math.max(0, newStart), end: Math.min(duration, newEnd) })
  }

  const handleMouseDown = (e: MouseEvent) => {
    const rect = containerRef.current!.getBoundingClientRect()
    const sec = xToSec(e.clientX - rect.left)
    if (e.shiftKey) {
      onSeek(sec)
      return
    }
    // Test: did we click on a library-clip region?
    for (const c of clips) {
      if (sec >= c.startSec && sec <= c.endSec) {
        onSelectClip?.(c.id)
        return
      }
    }
    onSelectClip?.(null)
    setDrag({ startSec: sec, curSec: sec })
  }
  const handleMouseMove = (e: MouseEvent) => {
    if (!drag) return
    const rect = containerRef.current!.getBoundingClientRect()
    setDrag({ ...drag, curSec: xToSec(e.clientX - rect.left) })
  }
  const handleMouseUp = () => {
    if (!drag) return
    const a = Math.max(0, Math.min(drag.startSec, drag.curSec))
    const b = Math.min(duration, Math.max(drag.startSec, drag.curSec))
    if (b - a > 0.05) {
      onCommitDragRegion?.(a, b)
    } else {
      onSeek(drag.startSec)
    }
    setDrag(null)
  }

  // Build peak columns at 2-pixel intervals across the visible window.
  const cols: Array<{ x: number; h: number }> = []
  for (let x = 0; x < width; x += 2) {
    const sec = xToSec(x)
    const idx = Math.floor(sec / bucketSec)
    if (idx >= 0 && idx < peaks.length) {
      cols.push({ x, h: Math.max(1, peaks[idx] * 24) })
    }
  }

  return (
    <div
      ref={containerRef}
      className="relative h-12 bg-gray-950 border-y border-gray-800 select-none cursor-crosshair"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
    >
      <svg width={width} height={48} className="absolute inset-0 pointer-events-none">
        {cols.map(({ x, h }) => (
          <line key={x} x1={x} y1={24 - h / 2} x2={x} y2={24 + h / 2} stroke="#22d3ee" strokeWidth={1} />
        ))}
      </svg>
      {clips.map((c) => (
        <div
          key={c.id}
          className={`absolute top-0 bottom-0 border-x pointer-events-none ${
            c.selected ? 'bg-cyan-500/30 border-cyan-300' : 'bg-cyan-500/12 border-cyan-700/60'
          }`}
          style={{
            left: `${secToX(c.startSec)}px`,
            width: `${Math.max(1, secToX(c.endSec) - secToX(c.startSec))}px`,
          }}
        />
      ))}
      {drag && (
        <div
          className="absolute top-0 bottom-0 bg-fuchsia-400/30 border-x border-fuchsia-300 pointer-events-none"
          style={{
            left: `${secToX(Math.min(drag.startSec, drag.curSec))}px`,
            width: `${Math.abs(secToX(drag.curSec) - secToX(drag.startSec))}px`,
          }}
        />
      )}
      <div
        className="absolute top-0 bottom-0 w-px bg-yellow-400 pointer-events-none"
        style={{ left: `${secToX(currentTime)}px` }}
      />
    </div>
  )
}
```

- [ ] **Step 2: Wire peaks fetch + state into `BeatmapEditor`**

In `web/frontend/src/components/BeatmapEditor.tsx`, near the other useState declarations (search for `const [waveformOnHighway, setWaveformOnHighway]`), add:

```ts
// Which stem the WaveformStrip is showing. 'song' = full mix (default,
// always available). The other option is the active beatmap's own stem
// (drums / guitar / bass / etc.) — visually shows the onsets that match
// the chart's notes. Audio playback for placed MUSIC clips always uses
// the full mix; only the visual changes.
const [waveformStem, setWaveformStem] = useState<'song' | 'active'>('song')
const [songPeaks, setSongPeaks] = useState<Float32Array | null>(null)
const [peaksBucketSec] = useState(0.020) // matches backend default of 20 ms

// Resolve which stem name the endpoint should serve.
const activeBeatmapStem = chart && (() => {
  const bm = (track?.beatmaps ?? []).find((b) => b.id === beatmapId)
  return bm?.stem ?? 'song'
})()
const peaksStemParam = waveformStem === 'song' ? 'song' : (activeBeatmapStem || 'song')
```

Near the other useEffect blocks that fetch initial state (search for `fetch('/api/sample-packs')` or similar), add:

```ts
useEffect(() => {
  if (!trackId || !peaksStemParam) return
  let cancelled = false
  setSongPeaks(null)  // clear stale peaks while the new stem fetches
  fetch(`/api/tracks/${trackId}/song-peaks?stem=${encodeURIComponent(peaksStemParam)}`)
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((buf) => {
      if (!cancelled && buf) setSongPeaks(new Float32Array(buf))
    })
    .catch(() => undefined)
  return () => { cancelled = true }
}, [trackId, peaksStemParam])
```

- [ ] **Step 3: Slot the strip + stem toggle into the editor's top header**

Find the existing `<TutorialTimeline ... />` usage in the JSX (search for `TutorialTimeline`). Immediately below it, add:

```tsx
<WaveformStrip
  peaks={songPeaks}
  duration={duration}
  bucketSec={peaksBucketSec}
  currentTime={currentTime}
  onSeek={(s) => {
    if (audioRef.current) audioRef.current.currentTime = s
    setCurrentTime(s)
  }}
  view={timelineView}
  onViewChange={setTimelineView}
  clips={(chart?.clips ?? []).filter((c) => c.endSec > c.startSec).map((c) => ({
    id: c.id,
    startSec: c.startSec,
    endSec: c.endSec,
    name: c.name,
    selected: c.id === selectedClipId,
  }))}
  onSelectClip={setSelectedClipId}
/>
{/* Tiny toggle below the strip to swap full-mix waveform for the
    active beatmap's own stem — useful when marking clip boundaries
    against the actual instrument's onsets. Audio playback is unaffected. */}
{songPeaks && activeBeatmapStem && activeBeatmapStem !== 'song' && (
  <div className="px-3 py-1 bg-gray-950 border-b border-gray-800 flex items-center gap-2">
    <span className="text-[10px] text-gray-500 uppercase tracking-wider">Waveform</span>
    {(['song', 'active'] as const).map((s) => (
      <button
        key={s}
        onClick={() => setWaveformStem(s)}
        className={`text-[10px] px-2 py-0.5 rounded ${
          waveformStem === s
            ? 'bg-cyan-700/70 text-white'
            : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
        }`}
        title={s === 'song' ? 'Show the full mix (song.ogg)' : `Show the beatmap's stem (${activeBeatmapStem})`}
      >
        {s === 'song' ? 'full mix' : activeBeatmapStem}
      </button>
    ))}
  </div>
)}
```

You'll need to:
- Import `WaveformStrip`: `import { WaveformStrip } from './WaveformStrip'` at the top.
- Lift `selectedClipId: string | null` state to the top of the component (near `selectedTutorialId`).
- Lift the `timelineView` from inside `TutorialTimeline` so both components share it. If the existing `TutorialTimeline` keeps it internal, lift to a parent state and pass via props.

If `timelineView` doesn't exist yet (TutorialTimeline manages its own zoom):
- Add `const [timelineView, setTimelineView] = useState<{ start: number; end: number }>(() => ({ start: 0, end: 0 }))`
- Modify `TutorialTimeline` to accept `view` and `onViewChange` props instead of (or alongside) its own internal state.
- Initialize `timelineView` to `{ start: 0, end: duration }` once `duration` lands (effect on `duration`).

- [ ] **Step 4: TypeScript check**

```
cd web/frontend && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Smoke test**

Reload the editor on a track with a real song. Confirm the waveform strip renders below the tutorial timeline, click-to-seek works, wheel-zoom works on both strips together. Open a silent test bench (Realnote Test v1) → strip shows the empty-state notice.

- [ ] **Step 6: Commit**

```
git add web/frontend/src/components/WaveformStrip.tsx web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): WaveformStrip component for song.ogg peaks"
```

---

## Task 6: Frontend — drag-region commit + clip persistence

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx` (add `commitDragRegion` handler, popover state, save flow)

- [ ] **Step 1: Add popover state + commit handler**

Near the `selectedClipId` state, add:

```ts
const [pendingClip, setPendingClip] = useState<{ startSec: number; endSec: number; name: string } | null>(null)
```

Add a save-clip function:

```ts
const saveClipFromPending = () => {
  if (!chart || !pendingClip) return
  const { startSec, endSec, name } = pendingClip
  const clean = name.trim() || `Clip ${chart.clips.length + 1}`
  const slice = sliceChartForClip(chart.notes, tempoSegments, chart.resolution, startSec, endSec)
  // Generate unique sectionName.
  let id: string
  do {
    id = Math.random().toString(36).slice(2, 10)
  } while (chart.musicSections[`MusicSeg_${id}`] !== undefined)
  const sectionName = `MusicSeg_${id}`
  const nextSections = { ...chart.musicSections, [sectionName]: slice.sectionBody }
  const newClip: Clip = {
    id, sectionName, name: clean, startSec, endSec,
    notesCount: slice.notesCount, bpm: slice.bpm,
  }
  setChart({
    ...chart,
    musicSections: nextSections,
    clips: [...chart.clips, newClip],
  })
  setDirty(true)
  setSelectedClipId(id)
  setPendingClip(null)
}
```

- [ ] **Step 2: Wire the WaveformStrip's `onCommitDragRegion`**

In the `<WaveformStrip ... />` JSX added in Task 5, set `onCommitDragRegion` to:

```tsx
onCommitDragRegion={(s, e) => setPendingClip({ startSec: s, endSec: e, name: '' })}
```

- [ ] **Step 3: Render the popover**

Just below the `<WaveformStrip ... />` element, add an inline popover:

```tsx
{pendingClip && (
  <div className="absolute z-50 mt-1 bg-gray-900 border border-gray-700 rounded p-2 shadow-lg flex items-center gap-2">
    <input
      autoFocus
      type="text"
      value={pendingClip.name}
      onChange={(e) => setPendingClip({ ...pendingClip, name: e.target.value })}
      placeholder={`Clip name (${(pendingClip.endSec - pendingClip.startSec).toFixed(1)}s)`}
      className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-200 w-44"
      onKeyDown={(e) => {
        if (e.key === 'Enter') saveClipFromPending()
        if (e.key === 'Escape') setPendingClip(null)
      }}
    />
    <button
      onClick={saveClipFromPending}
      className="text-[11px] px-2 py-1 bg-cyan-700 hover:bg-cyan-600 rounded text-white"
    >
      Save clip
    </button>
    <button
      onClick={() => setPendingClip(null)}
      className="text-[11px] px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded text-gray-300"
    >
      Cancel
    </button>
  </div>
)}
```

(Position is rough; if the editor's existing layout makes absolute-positioning awkward, render inline within the same flex container as the WaveformStrip.)

- [ ] **Step 4: TypeScript check**

```
cd web/frontend && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Smoke test**

Reload editor on a real-song track. Drag a region on the waveform → popover opens → type a name → Save. The clip should appear as a translucent region on the strip. Save the chart. Reload. The clip should persist (re-derived from the `[MusicSeg_<id>]` section's comment header).

Inspect `notes.chart` directly: confirm a section like:
```
[MusicSeg_a3f8c2]
{
  ; name="My clip" start_sec=18.300 end_sec=42.300
  ...
}
```
exists.

- [ ] **Step 6: Commit**

```
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): save dragged region as a library clip"
```

---

## Task 7: Frontend — `ClipsLibraryPanel` + place-at-playhead

**Files:**
- Create: `web/frontend/src/components/ClipsLibraryPanel.tsx`
- Modify: `web/frontend/src/components/BeatmapEditor.tsx` (slot the panel into the sidebar; wire actions)

- [ ] **Step 1: Create the panel file**

Write `web/frontend/src/components/ClipsLibraryPanel.tsx`:

```tsx
import type { ReactNode } from 'react'

export interface LibraryClipRow {
  id: string
  name: string
  startSec: number
  endSec: number
  notesCount: number
  isPlaced: boolean
  isSliceMode: boolean   // true = drawn from song.ogg, false = upload-based
}

interface Props {
  clips: LibraryClipRow[]
  selectedClipId: string | null
  onSelect: (id: string | null) => void
  onAudition: (id: string) => void
  onPlaceAtPlayhead: (id: string) => void
  onRename: (id: string, newName: string) => void
  onDelete: (id: string) => void
  // Header slot for whatever wrapper the editor uses (CollapsibleSection etc.)
  Wrapper: ({ children, title, right }: { children: ReactNode; title: string; right?: ReactNode }) => ReactNode
}

// Right-sidebar list of every saved clip — both slice clips (drawn
// from song.ogg via WaveformStrip drag) and upload-based clips (created
// by the existing "+ MUSIC" modal). Slice clips are interactive on the
// waveform too; upload-based clips are list-only.
export function ClipsLibraryPanel({
  clips, selectedClipId, onSelect, onAudition, onPlaceAtPlayhead, onRename, onDelete, Wrapper,
}: Props) {
  return (
    <Wrapper
      title="Clips"
      right={clips.length > 0 ? (
        <span className="text-[10px] text-cyan-300 font-mono">{clips.length}</span>
      ) : undefined}
    >
      {clips.length === 0 ? (
        <p className="text-[10px] text-gray-600 leading-snug">
          Drag a region on the waveform above to author your first clip.
        </p>
      ) : (
        <ul className="space-y-1">
          {clips.map((c) => {
            const isSelected = c.id === selectedClipId
            return (
              <li
                key={c.id}
                className={`px-2 py-1.5 rounded border ${
                  isSelected ? 'border-cyan-500 bg-cyan-900/15' : 'border-gray-800 bg-gray-900/40'
                }`}
                onClick={() => onSelect(c.id)}
              >
                <div className="flex items-center gap-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); onAudition(c.id) }}
                    className="shrink-0 px-1 py-0.5 bg-gray-800 hover:bg-gray-700 rounded text-[10px] text-gray-200"
                    title="Audition this clip"
                  >
                    ⏵
                  </button>
                  <input
                    type="text"
                    value={c.name}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onRename(c.id, e.target.value)}
                    className="flex-1 min-w-0 bg-transparent border-0 text-[11px] text-gray-200 truncate focus:outline-none focus:bg-gray-800 rounded px-1"
                    title={c.name}
                  />
                  <button
                    onClick={(e) => { e.stopPropagation(); onDelete(c.id) }}
                    className="shrink-0 px-1 py-0.5 bg-red-900/30 hover:bg-red-800/60 border border-red-800/40 rounded text-[10px] text-red-300"
                    title="Delete clip + any places of it"
                  >
                    ×
                  </button>
                </div>
                <div className="text-[10px] text-gray-500 font-mono mt-0.5 flex items-center gap-2">
                  {c.isSliceMode ? (
                    <span>{(c.endSec - c.startSec).toFixed(1)}s · {c.notesCount}n</span>
                  ) : (
                    <span>(uploaded) · {c.notesCount}n</span>
                  )}
                  {c.isPlaced && <span className="text-emerald-400">placed</span>}
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); onPlaceAtPlayhead(c.id) }}
                  className="mt-1 w-full text-[10px] px-1.5 py-1 bg-gray-800 hover:bg-gray-700 rounded text-gray-200"
                  title="Add a MUSIC event at the current playhead referencing this clip"
                >
                  + place at playhead
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Wrapper>
  )
}
```

- [ ] **Step 2: Slot the panel into the editor sidebar**

In `BeatmapEditor.tsx`, find the existing right-sidebar `CollapsibleSection`s (search for `id="sound-packs"`). Just below or above them, add the clips panel. First import:

```ts
import { ClipsLibraryPanel } from './ClipsLibraryPanel'
```

Then in JSX:

```tsx
{chart && (
  <ClipsLibraryPanel
    clips={chart.clips.map((c) => ({
      id: c.id,
      name: c.name,
      startSec: c.startSec,
      endSec: c.endSec,
      notesCount: c.notesCount,
      isPlaced: chart.tutorial.some(
        (e): e is TutorialMusicEvent => e.kind === 'music' && e.sectionName === c.sectionName,
      ),
      isSliceMode: c.endSec > c.startSec,
    }))}
    selectedClipId={selectedClipId}
    onSelect={setSelectedClipId}
    onAudition={(id) => auditionClip(id)}
    onPlaceAtPlayhead={(id) => placeClipAtPlayhead(id)}
    onRename={(id, name) => renameClip(id, name)}
    onDelete={(id) => deleteClip(id)}
    Wrapper={CollapsibleSection as any}
  />
)}
```

- [ ] **Step 3: Implement the action handlers**

In `BeatmapEditor.tsx`, near the music-segment handlers (search for `addMusicSegment`), add:

```ts
const renameClip = (id: string, name: string) => {
  if (!chart) return
  setChart({
    ...chart,
    clips: chart.clips.map((c) => c.id === id ? { ...c, name } : c),
  })
  setDirty(true)
}

const deleteClip = (id: string) => {
  if (!chart) return
  const clip = chart.clips.find((c) => c.id === id)
  if (!clip) return
  if (!window.confirm(`Delete "${clip.name}" and any places of it?`)) return
  const nextSections = { ...chart.musicSections }
  delete nextSections[clip.sectionName]
  setChart({
    ...chart,
    musicSections: nextSections,
    clips: chart.clips.filter((c) => c.id !== id),
    tutorial: chart.tutorial.filter(
      (e) => !(e.kind === 'music' && e.sectionName === clip.sectionName),
    ),
  })
  setDirty(true)
  if (selectedClipId === id) setSelectedClipId(null)
}

const placeClipAtPlayhead = (id: string) => {
  if (!chart) return
  const clip = chart.clips.find((c) => c.id === id)
  if (!clip) return
  const tick = secToTick(tempoSegments, chart.resolution, currentTime)
  const isSlice = clip.endSec > clip.startSec
  const ev: TutorialMusicEvent = {
    kind: 'music',
    id: `music-${Date.now()}`,
    tick,
    file: isSlice ? 'song.ogg' : `segments/${clip.sectionName.replace('MusicSeg_', '')}.ogg`,
    sectionName: clip.sectionName,
    bpm: clip.bpm,
    resolution: chart.resolution,
    durationSeconds: isSlice ? (clip.endSec - clip.startSec) : 0,
    notesCount: clip.notesCount,
    required: Math.min(5, clip.notesCount),
    timing: 'any',
    retryVo: '',
    next: '',
    ...(isSlice ? {
      startMs: Math.round(clip.startSec * 1000),
      durationMs: Math.round((clip.endSec - clip.startSec) * 1000),
    } : {}),
  }
  setChart({ ...chart, tutorial: [...chart.tutorial, ev], tutorialEnabled: true })
  setDirty(true)
  setSelectedTutorialId(ev.id)
}
```

For `auditionClip`, defer to Task 8.

- [ ] **Step 4: Add `startMs` / `durationMs` fields to `TutorialMusicEvent`**

Find the `TutorialMusicEvent` interface (around line 65 of BeatmapEditor.tsx). Add the optional fields:

```ts
interface TutorialMusicEvent {
  kind: 'music'
  // ... existing fields ...
  retryVo: string
  next: string
  startMs?: number       // when present + file points at song.ogg, slice playback
  durationMs?: number
}
```

Find the MUSIC parsing in `parseTutorialSection` (around line 581+). After the existing fields are read, add:

```ts
startMs: fields.start_ms !== undefined ? Number(fields.start_ms) : undefined,
durationMs: fields.duration_ms !== undefined ? Number(fields.duration_ms) : undefined,
```

Find the MUSIC serializer in `serializeTutorialEvents` (around line 642+). Update the music line to include the new fields:

```ts
return (
  `  ${e.tick} = MUSIC "${e.file}" section="${e.sectionName}"`
  + (e.startMs !== undefined ? ` start_ms=${e.startMs}` : '')
  + (e.durationMs !== undefined ? ` duration_ms=${e.durationMs}` : '')
  + ` bpm=${e.bpm.toFixed(2)} resolution=${e.resolution}`
  + ` duration=${e.durationSeconds.toFixed(2)} notes=${e.notesCount}`
  + ` required=${e.required} timing=${e.timing}`
  + (e.retryVo ? ` retry_vo="${e.retryVo}"` : '')
  + (e.next ? ` next="${e.next}"` : '')
)
```

- [ ] **Step 5: TypeScript check**

```
cd web/frontend && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 6: Smoke test**

Reload the editor. After Task 6's drag-and-save, the new clip should now appear in the right-sidebar Clips panel. Click `+ place at playhead` → an orange MUSIC pill appears on the runway sidecar. Save chart. Reload. Both the library clip and the placed event survive. Inspect chart: the MUSIC event line should have `start_ms=N duration_ms=M`.

- [ ] **Step 7: Commit**

```
git add web/frontend/src/components/ClipsLibraryPanel.tsx web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): Clips library panel + place-at-playhead"
```

---

## Task 8: Frontend — clip audition + slice-mode MUSIC playback

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx` (audition handler + transport-time MUSIC slice playback)

- [ ] **Step 1: Add a shared song.ogg `<audio>` ref + audition function**

Near `voAudiosRef` (search for `voAudiosRef`), add:

```ts
const songSliceAudioRef = useRef<HTMLAudioElement | null>(null)

const auditionClip = (id: string) => {
  if (!chart) return
  const clip = chart.clips.find((c) => c.id === id)
  if (!clip) return
  const isSlice = clip.endSec > clip.startSec
  // Stop any in-flight audition.
  if (songSliceAudioRef.current) {
    songSliceAudioRef.current.pause()
    songSliceAudioRef.current = null
  }
  const url = isSlice
    ? `/api/tracks/${trackId}/stems/song`
    : `/api/tutorial/${trackId}/beatmaps/${beatmapId}/segments/${clip.sectionName.replace('MusicSeg_', '')}.ogg`
  const a = new Audio(url)
  songSliceAudioRef.current = a
  const start = isSlice ? clip.startSec : 0
  const end = isSlice ? clip.endSec : Infinity
  const startPlayback = () => {
    a.currentTime = start
    a.play().catch(() => undefined)
    if (Number.isFinite(end)) {
      const onTick = () => {
        if (a.currentTime >= end - 0.01) {
          a.pause()
          a.removeEventListener('timeupdate', onTick)
        }
      }
      a.addEventListener('timeupdate', onTick)
    }
  }
  if (a.readyState >= 1) startPlayback()
  else a.addEventListener('loadedmetadata', startPlayback, { once: true })
}
```

- [ ] **Step 2: Make placed slice-mode MUSIC events play during transport**

The existing tutorial-event playback effect already handles MUSIC events for upload-based clips. Find it (search for `voAudiosRef` and the surrounding MUSIC playback code; the file is around line 5770-5850). Find where MUSIC events build their HTMLAudioElement URL. Replace whatever URL construction is there with:

```ts
if (ev.kind !== 'music' || !ev.file) continue
const url = ev.file === 'song.ogg' && ev.startMs !== undefined
  ? `/api/tracks/${trackId}/stems/song`
  : `/api/tutorial/${trackId}/beatmaps/${beatmapId}/${ev.file}`
```

In the playback fire path (mirrors VO firing), seek into the slice when `startMs` is present:

```ts
if (ev.startMs !== undefined) {
  a.currentTime = (ev.startMs / 1000) + Math.max(0, currentTime - musicSec)
} else {
  a.currentTime = 0
}
a.play().catch(() => undefined)
firedMusicRef.current.add(ev.id)
if (ev.durationMs && ev.durationMs > 0) {
  const endSec = (ev.startMs ?? 0) / 1000 + ev.durationMs / 1000
  const onTick = () => {
    if (a.currentTime >= endSec - 0.01) {
      a.pause()
      a.removeEventListener('timeupdate', onTick)
    }
  }
  a.addEventListener('timeupdate', onTick)
}
```

(If the existing code didn't yet have a MUSIC fire path — i.e. MUSIC was never auto-fired on transport, only previewed via the side-panel `<audio controls>` — skip the transport-fire step. The audition button is enough for v1.)

- [ ] **Step 3: TypeScript check**

```
cd web/frontend && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Smoke test**

Reload. Drag-save a clip. Click the `⏵` audition button — clip plays, stops at end. Place at playhead. If the editor auto-fires MUSIC during transport, scrubbing across the placed event should fire the slice; otherwise side-panel `<audio>` controls should still play.

- [ ] **Step 5: Commit**

```
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): clip audition + slice-mode MUSIC playback"
```

---

## Task 9: Backend — strip orphan `MusicSeg_*` sections at publish time

**Files:**
- Modify: `web/backend/app/routers/tracks.py` (extend `_bundle_tutorial_assets`)
- Test: `web/backend/tests/test_publish_orphan_strip.py` (create)

- [ ] **Step 1: Write failing test**

Create `web/backend/tests/test_publish_orphan_strip.py`:

```python
"""Tests for the publish-time orphan-MusicSeg-section strip."""
from __future__ import annotations

from app.routers.tracks import _strip_orphan_musicsegs


CHART = """\
[Song]
{
  Resolution = 192
}
[ExpertSingle]
{
  100 = N 0 0
}
[TutorialScript]
{
  192 = MUSIC "song.ogg" section="MusicSeg_used" start_ms=0 duration_ms=1000 bpm=120.00 resolution=192 duration=1.00 notes=4 required=2 timing=any
}
[MusicSeg_used]
{
  0 = N 0 0
  192 = N 1 0
}
[MusicSeg_orphan]
{
  ; name="library only" start_sec=10.000 end_sec=20.000
  0 = N 0 0
}
"""


def test_orphan_section_dropped():
    out = _strip_orphan_musicsegs(CHART)
    assert '[MusicSeg_used]' in out
    assert '[MusicSeg_orphan]' not in out
    # The placed event line stays untouched.
    assert 'section="MusicSeg_used"' in out


def test_no_change_when_no_orphans():
    chart_only_used = CHART.replace(
        '[MusicSeg_orphan]\n{\n  ; name="library only" start_sec=10.000 end_sec=20.000\n  0 = N 0 0\n}\n',
        '',
    )
    out = _strip_orphan_musicsegs(chart_only_used)
    assert out == chart_only_used


def test_no_change_when_no_tutorialscript():
    chart_no_tut = CHART.replace(
        '[TutorialScript]\n{\n  192 = MUSIC "song.ogg" section="MusicSeg_used" start_ms=0 duration_ms=1000 bpm=120.00 resolution=192 duration=1.00 notes=4 required=2 timing=any\n}\n',
        '',
    )
    # Without a TutorialScript, every MusicSeg is orphan; both go.
    out = _strip_orphan_musicsegs(chart_no_tut)
    assert '[MusicSeg_used]' not in out
    assert '[MusicSeg_orphan]' not in out
```

- [ ] **Step 2: Run tests to verify they fail**

```
venv/Scripts/python.exe -m pytest tests/test_publish_orphan_strip.py -v
```
Expected: 3 failures (`_strip_orphan_musicsegs` doesn't exist).

- [ ] **Step 3: Implement the strip helper**

In `web/backend/app/routers/tracks.py`, near `_bundle_tutorial_assets`, add:

```python
def _strip_orphan_musicsegs(chart_text: str) -> str:
    """Remove [MusicSeg_<id>] sections that no MUSIC event references.

    Library-only clips authored in the editor's clip library exist in
    the chart so they survive a save/load round-trip, but the publish
    flow only ships sections that are actually placed.
    """
    # Collect referenced section names from any MUSIC event in [TutorialScript].
    tut_match = re.search(r'\[TutorialScript\]\s*\{([^}]*)\}', chart_text, flags=re.DOTALL)
    referenced: set[str] = set()
    if tut_match:
        for m in re.finditer(r'\d+\s*=\s*MUSIC\s+[^\n]*?section="([^"]+)"', tut_match.group(1)):
            referenced.add(m.group(1))

    def repl(m: re.Match) -> str:
        name = m.group(1)
        if name.startswith('MusicSeg_') and name not in referenced:
            return ''
        return m.group(0)

    return re.sub(r'\[(MusicSeg_[A-Za-z0-9]+)\]\s*\{[^}]*\}\s*', repl, chart_text, flags=re.DOTALL)
```

- [ ] **Step 4: Wire it into `_bundle_tutorial_assets`**

Find `_bundle_tutorial_assets` (around line 1069). At the end of the function (after the chart_path is written if it exists), add:

```python
if chart_path.exists():
    text = chart_path.read_text(encoding='utf-8', errors='replace')
    chart_path.write_text(_strip_orphan_musicsegs(text), encoding='utf-8')
```

- [ ] **Step 5: Run tests to verify they pass**

```
venv/Scripts/python.exe -m pytest tests/test_publish_orphan_strip.py -v
```
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```
git add web/backend/app/routers/tracks.py web/backend/tests/test_publish_orphan_strip.py
git commit -m "feat(publish): strip orphan MusicSeg sections at bundle time"
```

---

## Task 10: Spec doc update + end-to-end smoke

**Files:**
- Modify: `web/docs/REALNOTES_SPEC.md` (append paragraph on MUSIC slice fields)

- [ ] **Step 1: Append the spec paragraph**

In `web/docs/REALNOTES_SPEC.md`, find the section discussing tutorial / MUSIC events (or append a new section near the end). Add:

```markdown
## 9. MUSIC events with slice playback (NEW)

A `MUSIC` event in `[TutorialScript]` can carry two new optional fields:

```
<tick> = MUSIC "song.ogg" section="MusicSeg_<id>"
         start_ms=N duration_ms=M
         bpm=... resolution=... duration=... notes=...
         required=... timing=...
```

When `file="song.ogg"` and both `start_ms` + `duration_ms` are
present, the engine plays a windowed slice of the track's main
`song.ogg` rather than a separate audio file. Identical pattern to
`VO` events that slice into `vo/tutorial.ogg`.

Without these fields (or with a non-`song.ogg` file path), the event
behaves the same as the existing standalone-file MUSIC flow — the
engine plays the referenced file from start to finish.

The chart may contain `[MusicSeg_<id>]` sections that no `MUSIC` event
references — these are Studio-side library clips ("authored but not
placed"). The publish bundler drops them; production charts only carry
sections referenced by an active MUSIC event.
```

- [ ] **Step 2: End-to-end smoke (manual)**

1. Start backend + frontend dev servers.
2. Create a new track from a real song (Create page).
3. Open the generated beatmap in the editor.
4. Confirm the WaveformStrip renders below the tutorial timeline.
5. Drag a region → name it "Solo" → Save.
6. Confirm the clip appears in the right-sidebar Clips panel.
7. Audition the clip — plays slice, stops at end.
8. Move playhead to a different time. Click "+ place at playhead".
9. Confirm an orange MUSIC pill appears on the runway sidecar at that tick.
10. Open the placed event — side panel shows the audio with windowed playback.
11. Save chart. Reload editor. Both the library clip and the placement should survive.
12. Click "Push to game repo" (Game Library page). After the publish completes, open the chart on GitHub: confirm the placed `MUSIC` event line has `start_ms` / `duration_ms`, the placed `[MusicSeg_*]` section is present, and no orphan/library-only sections appear.
13. Delete the placed clip from the library panel → both section and event disappear.

- [ ] **Step 3: Commit**

```
git add web/docs/REALNOTES_SPEC.md
git commit -m "docs: MUSIC slice playback + library-only section semantics"
```

- [ ] **Step 4: Push + deploy**

```
git push origin main
ssh -F /dev/null -i $USERPROFILE/.ssh/jamsesh_deploy_ed25519 root@137.184.217.203 \
  'cd /opt/madmom && git pull --ff-only && \
   source web/backend/venv/bin/activate && \
   pip install --quiet -r web/backend/requirements.txt && \
   cd web/frontend && npm ci --silent && npm run build && cd /opt/madmom && \
   systemctl restart beatmap-backend && systemctl reload nginx && \
   sleep 2 && systemctl --no-pager status beatmap-backend | sed -n "1,4p"'
```

Expected: backend `Active: active (running)`, deploy clean.

---

## Self-review notes

- **Spec coverage:** Every spec section maps to a task. Data model → Tasks 3, 7. UI → Tasks 5, 6, 7. Backend → Tasks 1, 2, 9. Slice computation → Task 4. Save flow → Task 6. Place-at-playhead → Task 7. Audition → Task 8. Publish strip → Task 9. Spec doc → Task 10. Out-of-scope items (snap-to-beat, fade, BPM override, variable-tempo slicing) are deliberately not covered.
- **Type consistency:** `Clip` interface defined once in Task 3 and consumed by Tasks 4, 6, 7. `LibraryClipRow` defined in Task 7 (the panel-only DTO) is constructed from `Clip` at the call site. `TutorialMusicEvent.startMs` / `durationMs` defined in Task 7, used by Task 8. Function names: `sliceChartForClip` (Task 4), `parseClipMetadata` / `deriveClips` (Task 3), `_strip_orphan_musicsegs` (Task 9). Consistent across tasks.
- **No placeholders:** every code step shows complete code.
- **Granularity:** Tasks have 4–9 steps each, mostly 2–5 minutes per step. Larger frontend tasks (5, 6, 7) have one chunky implementation step that's longer — that's unavoidable given the size of WaveformStrip / ClipsLibraryPanel / handler wiring; splitting them further would interleave changes that don't compile/run on their own.
