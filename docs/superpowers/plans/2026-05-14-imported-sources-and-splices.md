# Imported Sources & Splices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Studio tutorial editor gains the ability to import another beatmap as a "source", view its waveform + chart, splice a section, and place the splice as a `MUSIC` event in the tutorial.

**Architecture:** A tutorial's chart gains an `[ImportedSources]` section mapping local ids → `(track_id, beatmap_id, name)`. `MUSIC` events reference splices via `source="<local_id>"` + `start_ms`/`duration_ms`. `[MusicSeg_<id>]` sections hold trimmed slice notes. At publish time, the backend copies each imported source's `song.ogg` into `sources/<local_id>/song.ogg` and strips the `[ImportedSources]` section + orphan `[MusicSeg_*]` sections.

**Tech Stack:** Backend: FastAPI, madmom (existing dep), pytest. Frontend: React 18 + TypeScript + Tailwind, no test scaffold (manual smoke).

**Reuses from prior work:** `compute_audio_peaks` in `web/backend/app/services/audio.py` (commit `40de948`, already on main).

---

## Task 1: Backend — per-beatmap `song-peaks` endpoint

**Files:**
- Modify: `web/backend/app/routers/tracks.py` (add new route handler near other `@router.get('/{track_id}/beatmaps/{beatmap_id}/...')` routes)
- Modify: `web/backend/tests/test_song_peaks.py` (append endpoint test)

- [ ] **Step 1: Write the failing test**

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


def test_beatmap_song_peaks_endpoint_returns_binary(tmp_path, monkeypatch, authed_client):
    """Per-beatmap endpoint serves the beatmap's song.ogg peaks."""
    monkeypatch.setattr(tracks_service, 'TRACKS_DIR', tmp_path / '_tracks')
    audio = tmp_path / 'src.wav'
    _write_wav(audio, np.zeros(44100, dtype=np.float32))
    track = tracks_service.create_track(
        name='per-bm-peaks', stems={'song': 'song.ogg'},
        source_stems_dir=tmp_path, model='manual', output_format='ogg',
    )
    # Write the beatmap's song.ogg in the per-beatmap dir
    bm_id = 'beatmap_x'
    bm_dir = track.beatmaps_dir / bm_id
    bm_dir.mkdir(parents=True, exist_ok=True)
    (bm_dir / 'song.ogg').write_bytes(audio.read_bytes())

    r = authed_client.get(f'/api/tracks/{track.id}/beatmaps/{bm_id}/song-peaks')
    assert r.status_code == 200
    assert r.headers['content-type'] == 'application/octet-stream'
    peaks = np.frombuffer(r.content, dtype=np.float32)
    assert 49 <= len(peaks) <= 51
    cache = bm_dir / 'song.peaks.f32'
    assert cache.exists()
    assert cache.read_bytes() == r.content


def test_beatmap_song_peaks_404_for_missing_audio(tmp_path, monkeypatch, authed_client):
    monkeypatch.setattr(tracks_service, 'TRACKS_DIR', tmp_path / '_tracks')
    track = tracks_service.create_track(
        name='no-audio', stems={'song': 'song.ogg'},
        source_stems_dir=tmp_path, model='manual', output_format='ogg',
    )
    r = authed_client.get(f'/api/tracks/{track.id}/beatmaps/missing/song-peaks')
    assert r.status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

```
cd web/backend && venv/Scripts/python.exe -m pytest tests/test_song_peaks.py -v -k beatmap
```
Expected: 2 failures (route not registered).

- [ ] **Step 3: Implement the endpoint**

In `web/backend/app/routers/tracks.py`, find the existing `@router.get('/{track_id}/beatmaps/{beatmap_id}/download/{filename}')` handler. Add immediately below it:

```python
@router.get('/{track_id}/beatmaps/{beatmap_id}/song-peaks')
async def get_beatmap_song_peaks(track_id: str, beatmap_id: str, bucket_ms: int = 20):
    """Per-bucket peak amplitudes for a beatmap's song.ogg, as a Float32
    binary blob. The editor's WaveformStrip reads this directly into a
    Float32Array. Cached on disk per beatmap; re-extracted when the
    source audio is newer than the cache. Used both for the tutorial's
    own song display and for any imported source beatmap's song display.
    """
    bm_dir = get_beatmap_dir(track_id, beatmap_id)
    if bm_dir is None:
        raise HTTPException(404, 'Beatmap not found')
    audio_path = bm_dir / 'song.ogg'
    if not audio_path.exists():
        raise HTTPException(404, 'song.ogg missing for this beatmap')
    cache_path = bm_dir / 'song.peaks.f32'
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

If `Response` isn't already in the imports at the top, add it: `from fastapi.responses import FileResponse, Response, StreamingResponse`.

- [ ] **Step 4: Run tests to verify they pass**

```
cd web/backend && venv/Scripts/python.exe -m pytest tests/test_song_peaks.py -v
```
Expected: all 5 tests pass (3 from prior task + 2 new).

- [ ] **Step 5: Commit**

```
git add web/backend/app/routers/tracks.py web/backend/tests/test_song_peaks.py
git commit -m "feat(api): per-beatmap GET /song-peaks endpoint"
```

---

## Task 2: Frontend — chart parser/serializer for `[ImportedSources]` + extended MUSIC fields

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx`

- [ ] **Step 1: Add the `ImportedSource` interface**

Find the block defining `TutorialMusicEvent` (around line 65). Below the existing `TutorialEvent` type union, add:

```ts
// A reference to another beatmap that this tutorial splices from.
// Stored as `[ImportedSources]` chart-section entries; the user-chosen
// `id` is stable and survives renames.
interface ImportedSource {
  id: string                 // local id — `[a-z][a-z0-9_]*`, e.g. 'src_a', 'verse_riff'
  trackId: string            // Studio-side track id
  beatmapId: string          // Studio-side beatmap id
  name: string               // display label (the source's song_name at import time)
}

// A clip = a saved [MusicSeg_<id>] section. Source-based clips
// reference an ImportedSource by its local id. Upload-based clips
// (legacy) have no sourceId.
interface Clip {
  id: string                 // matches the section name's id suffix
  sectionName: string
  name: string
  sourceId: string | null    // null = upload-based; else = ImportedSource.id
  startSec: number           // 0 for upload-based
  endSec: number             // 0 for upload-based
  notesCount: number
  bpm: number
}
```

- [ ] **Step 2: Add fields to `TutorialMusicEvent`**

In the `TutorialMusicEvent` interface, add the new optional fields:

```ts
interface TutorialMusicEvent {
  kind: 'music'
  // ... existing fields ...
  retryVo: string
  next: string
  // NEW — present when the event references an imported source. The engine
  // resolves audio to `sources/<source>/<stem>.ogg`. start_ms/duration_ms
  // give the slice window (mirrors VO's pattern).
  source?: string            // ImportedSource.id
  stem?: string              // default 'song'
  startMs?: number
  durationMs?: number
}
```

- [ ] **Step 3: Add `importedSources` and `clips` to `ChartState`**

Find the `ChartState` interface (around line 72-100). Add:

```ts
interface ChartState {
  // ... existing fields ...
  musicSections: Record<string, string>
  importedSources: ImportedSource[]   // NEW
  clips: Clip[]                       // NEW
  // ... existing fields ...
}
```

- [ ] **Step 4: Add `parseImportedSources` / `serializeImportedSources`**

Near `parseMusicSections` (around line 615), add:

```ts
function parseImportedSources(text: string): ImportedSource[] {
  const m = text.match(/\[ImportedSources\]\s*\{([^}]*)\}/)
  if (!m) return []
  const body = m[1]
  const out: ImportedSource[] = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith(';')) continue
    // <id> = track="..." beatmap="..." name="..."
    const idM = line.match(/^([a-z][a-z0-9_]*)\s*=/)
    if (!idM) continue
    const id = idM[1]
    const trackM = line.match(/track="([^"]*)"/)
    const beatmapM = line.match(/beatmap="([^"]*)"/)
    const nameM = line.match(/name="([^"]*)"/)
    if (!trackM || !beatmapM) continue
    out.push({
      id,
      trackId: trackM[1],
      beatmapId: beatmapM[1],
      name: nameM?.[1] ?? id,
    })
  }
  return out
}

function serializeImportedSources(sources: ImportedSource[]): string {
  if (sources.length === 0) return ''
  const lines = sources.map((s) =>
    `  ${s.id} = track="${s.trackId}" beatmap="${s.beatmapId}" name="${s.name.replace(/"/g, '')}"`,
  )
  return `[ImportedSources]\n{\n${lines.join('\n')}\n}\n`
}
```

- [ ] **Step 5: Wire into `parseChart`**

Find where `parseChart` builds the returned `ChartState` (around line 837). Add:

```ts
const importedSources = parseImportedSources(text)
const clips = deriveClips(musicSections, tutorial)  // see Step 6 for deriveClips
```

In the returned object, add `importedSources, clips,`.

- [ ] **Step 6: Add `parseClipMetadata` + `deriveClips` helpers**

Near `parseImportedSources`, add:

```ts
function parseClipMetadata(body: string): { name: string; sourceId: string | null; startSec: number; endSec: number } | null {
  const m = body.match(
    /;\s*(?:source="([^"]*)"\s+)?start_sec=([\d.]+)\s+end_sec=([\d.]+)\s+name="([^"]*)"/,
  )
  if (!m) return null
  return {
    sourceId: m[1] || null,
    startSec: Number(m[2]),
    endSec: Number(m[3]),
    name: m[4],
  }
}

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
      sourceId: meta?.sourceId ?? ev?.source ?? null,
      startSec: meta?.startSec ?? 0,
      endSec: meta?.endSec ?? 0,
      notesCount: noteLines.length,
      bpm: ev?.bpm ?? 120,
    })
  }
  return out
}
```

- [ ] **Step 7: Extend MUSIC event parser**

Find `parseTutorialSection` (around line 581+). Find the MUSIC parsing block. After the existing fields are read into `fields`, add:

```ts
source: fields.source || undefined,
stem: fields.stem || undefined,
startMs: fields.start_ms !== undefined ? Number(fields.start_ms) : undefined,
durationMs: fields.duration_ms !== undefined ? Number(fields.duration_ms) : undefined,
```

- [ ] **Step 8: Extend MUSIC event serializer**

Find `serializeTutorialEvents` (around line 642+). Replace the music-line emission with:

```ts
if (e.kind === 'music') {
  // Source-based events use `source="..."` + slice fields; legacy
  // upload-based events still emit `file="..."`. Both shapes coexist.
  const head = e.source
    ? `source="${e.source}" stem="${e.stem || 'song'}"`
    : `"${e.file}"`
  return (
    `  ${e.tick} = MUSIC ${head} section="${e.sectionName}"`
    + (e.startMs !== undefined ? ` start_ms=${e.startMs}` : '')
    + (e.durationMs !== undefined ? ` duration_ms=${e.durationMs}` : '')
    + ` bpm=${e.bpm.toFixed(2)} resolution=${e.resolution}`
    + ` duration=${e.durationSeconds.toFixed(2)} notes=${e.notesCount}`
    + ` required=${e.required} timing=${e.timing}`
    + (e.retryVo ? ` retry_vo="${e.retryVo}"` : '')
    + (e.next ? ` next="${e.next}"` : '')
  )
}
```

- [ ] **Step 9: Extend `serializeMusicSections` to write the comment header**

Find `serializeMusicSections` (around line 683). Update to take `clips` as a third arg and emit the source-aware header:

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
    if (clip && (clip.sourceId || clip.startSec > 0 || clip.endSec > 0 || clip.name !== sectionName)) {
      const sourceFrag = clip.sourceId ? `source="${clip.sourceId}" ` : ''
      prefix = `\n  ; ${sourceFrag}start_sec=${clip.startSec.toFixed(3)} end_sec=${clip.endSec.toFixed(3)} name="${clip.name.replace(/"/g, '')}"\n`
      const stripped = body.replace(/^\n?\s*;\s*(?:source="[^"]*"\s+)?start_sec=[\d.]+\s+end_sec=[\d.]+\s+name="[^"]*"\s*\n?/, '\n')
      out.push(`[${sectionName}]\n{${prefix.trimEnd()}${stripped}}\n`)
    } else {
      out.push(`[${sectionName}]\n{${body}}\n`)
    }
  }
  return out.join('')
}
```

Find any caller of `serializeMusicSections` and update to pass `chart.clips` as the third arg.

- [ ] **Step 10: Add `[ImportedSources]` to chart serialization**

Find where the full chart text is rebuilt for save (search for `applyTutorialToFullText` or similar). After tutorial sections are emitted, also emit `serializeImportedSources(chart.importedSources)`. The exact integration point depends on the existing code's structure — add it where the other tutorial-related sections (TutorialScript, MusicSeg) get rebuilt.

- [ ] **Step 11: TypeScript check**

```
cd web/frontend && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 12: Commit**

```
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): parse + serialize [ImportedSources] and source-aware MUSIC events"
```

---

## Task 3: Frontend — `sliceSourceChartForClip` helper + source-fetch cache

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx`

- [ ] **Step 1: Add the helper**

Near `parseSectionNotes` (around line 362), add:

```ts
// Slice a source beatmap's notes into a [MusicSeg_<id>] section body.
// Same algorithm as the never-shipped sliceChartForClip from the prior
// design (hard clip, sustain trim, (pack, scale) state propagation),
// but operates on a SOURCE beatmap's notes — fetched separately and
// cached. Variable-tempo within a clip not supported (notes
// renormalised linearly using the local tempo at startSec).
function sliceSourceChartForClip(
  sourceNotes: ChartNote[],
  sourceTempoSegments: TempoSegment[],
  sourceResolution: number,
  startSec: number,
  endSec: number,
): { sectionBody: string; notesCount: number; bpm: number } {
  const inTick = secToTick(sourceTempoSegments, sourceResolution, startSec)
  const outTick = secToTick(sourceTempoSegments, sourceResolution, endSec)
  const sorted = [...sourceNotes].sort((a, b) => a.tick - b.tick || a.lane - b.lane)

  let preludePack: string | undefined
  let preludeScale: string | undefined
  for (const n of sorted) {
    if (n.tick > inTick) break
    if (n.type === 'real') {
      if (n.pack) preludePack = n.pack
      if (n.scale) preludeScale = n.scale
    }
  }

  const sliced: ChartNote[] = []
  for (const n of sorted) {
    if (n.tick < inTick) continue
    if (n.tick >= outTick) break
    const newTick = n.tick - inTick
    const newSustain = n.tick + n.sustain > outTick ? outTick - n.tick : n.sustain
    sliced.push({ ...n, tick: newTick, sustain: newSustain })
  }

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

  let microBpm = sourceTempoSegments[0]?.microBpm ?? 120000
  for (const seg of sourceTempoSegments) {
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

- [ ] **Step 2: Add the source-fetch cache**

Near the other useState declarations, add:

```ts
// Per-source chart cache: notes + tempo + resolution + duration + peaks.
// Populated on import / on first selection of an imported source. Keyed
// by the ImportedSource.id (NOT track/beatmap ids — the local id is
// what splices reference).
interface SourceChartCache {
  notes: ChartNote[]
  tempoSegments: TempoSegment[]
  resolution: number
  duration: number
  peaks: Float32Array | null
}
const [sourceCache, setSourceCache] = useState<Record<string, SourceChartCache>>({})
const [activeSourceId, setActiveSourceId] = useState<string | null>(null)

const fetchSourceData = useCallback(async (src: ImportedSource): Promise<SourceChartCache | null> => {
  if (sourceCache[src.id]) return sourceCache[src.id]
  try {
    const [chartRes, peaksRes] = await Promise.all([
      fetch(`/api/tracks/${src.trackId}/beatmaps/${src.beatmapId}/chart`),
      fetch(`/api/tracks/${src.trackId}/beatmaps/${src.beatmapId}/song-peaks`),
    ])
    if (!chartRes.ok) return null
    const { chart: chartText } = await chartRes.json() as { chart: string }
    const parsed = parseChart(chartText)  // reuse existing parser
    const peaks = peaksRes.ok ? new Float32Array(await peaksRes.arrayBuffer()) : null
    // Duration: take the latest note's tick + sustain, convert to seconds.
    const lastTick = parsed.notes.reduce((m, n) => Math.max(m, n.tick + (n.sustain || 0)), 0)
    const duration = tickToSec(parsed.tempoMarkers ? buildTempoSegments(parsed.tempoMarkers, parsed.resolution) : [], parsed.resolution, lastTick)
    const cache: SourceChartCache = {
      notes: parsed.notes,
      tempoSegments: buildTempoSegments(parsed.tempoMarkers, parsed.resolution),
      resolution: parsed.resolution,
      duration,
      peaks,
    }
    setSourceCache((prev) => ({ ...prev, [src.id]: cache }))
    return cache
  } catch {
    return null
  }
}, [sourceCache])
```

- [ ] **Step 3: TypeScript check**

```
cd web/frontend && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Commit**

```
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): sliceSourceChartForClip + source-fetch cache"
```

---

## Task 4: Frontend — `WaveformStrip` component (rendering + scrub)

**Files:**
- Create: `web/frontend/src/components/WaveformStrip.tsx`
- Modify: `web/frontend/src/components/BeatmapEditor.tsx` (slot + own-song peaks fetch + active-source switch)

- [ ] **Step 1: Create the component file**

Write `web/frontend/src/components/WaveformStrip.tsx`:

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
  peaks: Float32Array | null
  duration: number
  bucketSec: number
  currentTime: number
  onSeek: (sec: number) => void
  view: { start: number; end: number }
  onViewChange: (v: { start: number; end: number }) => void
  clips: ClipRegion[]
  onSelectClip?: (id: string | null) => void
  onCommitDragRegion?: (startSec: number, endSec: number) => void
  emptyStateText?: string
}

// Mini horizontal-strip waveform display, designed to live directly
// below the existing TutorialTimeline. Shares its `view` (zoom + pan)
// with the parent so x-pixel ↔ time stays aligned across both strips.
//
// Mouse:
//   plain drag        → define a new clip region
//   shift+click/drag  → scrub the playhead
//   wheel             → zoom centered on the cursor
export function WaveformStrip({
  peaks, duration, bucketSec, currentTime, onSeek, view, onViewChange,
  clips, onSelectClip, onCommitDragRegion, emptyStateText,
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
        {emptyStateText ?? 'No audio loaded — waveform unavailable.'}
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
    if (e.shiftKey) { onSeek(sec); return }
    for (const c of clips) {
      if (sec >= c.startSec && sec <= c.endSec) {
        onSelectClip?.(c.id)
        return
      }
    }
    onSelectClip?.(null)
    if (onCommitDragRegion) setDrag({ startSec: sec, curSec: sec })
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
    if (b - a > 0.05) onCommitDragRegion?.(a, b)
    else onSeek(drag.startSec)
    setDrag(null)
  }

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

- [ ] **Step 2: Wire own-song peaks fetch + active-source switch into BeatmapEditor**

In `BeatmapEditor.tsx`, near the other useState declarations, add:

```ts
const [tutorialPeaks, setTutorialPeaks] = useState<Float32Array | null>(null)
const [peaksBucketSec] = useState(0.020)
const [stripView, setStripView] = useState<{ start: number; end: number }>({ start: 0, end: 0 })

// Sync the strip view to song duration when it lands.
useEffect(() => {
  if (duration > 0) setStripView((v) => v.end <= 0 ? { start: 0, end: duration } : v)
}, [duration])

// Fetch the tutorial's own song peaks.
useEffect(() => {
  if (!trackId || !beatmapId) return
  let cancelled = false
  fetch(`/api/tracks/${trackId}/beatmaps/${beatmapId}/song-peaks`)
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((buf) => { if (!cancelled && buf) setTutorialPeaks(new Float32Array(buf)) })
    .catch(() => undefined)
  return () => { cancelled = true }
}, [trackId, beatmapId])

// When the user picks an imported source, prefetch its data into the cache.
useEffect(() => {
  if (!activeSourceId || !chart) return
  const src = chart.importedSources.find((s) => s.id === activeSourceId)
  if (src) fetchSourceData(src)
}, [activeSourceId, chart, fetchSourceData])

// Resolve the WaveformStrip props from the active source (or own).
const activePeaks = activeSourceId
  ? sourceCache[activeSourceId]?.peaks ?? null
  : tutorialPeaks
const activeDuration = activeSourceId
  ? sourceCache[activeSourceId]?.duration ?? 0
  : duration
```

- [ ] **Step 3: Slot the WaveformStrip into the editor's top header**

Find the existing `<TutorialTimeline ... />` usage. Immediately below it, add:

```tsx
<WaveformStrip
  peaks={activePeaks}
  duration={activeDuration}
  bucketSec={peaksBucketSec}
  currentTime={currentTime}
  onSeek={(s) => {
    if (audioRef.current) audioRef.current.currentTime = s
    setCurrentTime(s)
  }}
  view={stripView}
  onViewChange={setStripView}
  clips={(chart?.clips ?? []).filter((c) => c.endSec > c.startSec && c.sourceId === activeSourceId).map((c) => ({
    id: c.id,
    startSec: c.startSec,
    endSec: c.endSec,
    name: c.name,
    selected: c.id === selectedClipId,
  }))}
  onSelectClip={setSelectedClipId}
  onCommitDragRegion={activeSourceId ? (s, e) => setPendingClip({ startSec: s, endSec: e, name: '', sourceId: activeSourceId }) : undefined}
  emptyStateText={activeSourceId ? 'Loading source…' : 'No audio attached.'}
/>
```

Add the import at the top: `import { WaveformStrip } from './WaveformStrip'`. Lift `selectedClipId: string | null` state and `pendingClip` state (referenced above; defined in next task — for now, define them as `useState` placeholders to satisfy TS).

- [ ] **Step 4: TypeScript check**

```
cd web/frontend && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Smoke test**

Reload the editor on any tutorial track. The waveform strip should render below the tutorial timeline showing the tutorial's own song peaks. Click-to-seek and wheel-zoom both work; wheel-zoom on either strip zooms both.

- [ ] **Step 6: Commit**

```
git add web/frontend/src/components/WaveformStrip.tsx web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): WaveformStrip component + active-source switching"
```

---

## Task 5: Frontend — drag-region commit + clip persistence

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx`

- [ ] **Step 1: Add the popover state + commit handler**

Near `selectedClipId`, add:

```ts
const [pendingClip, setPendingClip] = useState<{ startSec: number; endSec: number; name: string; sourceId: string }
| null>(null)

const saveClipFromPending = async () => {
  if (!chart || !pendingClip) return
  const { startSec, endSec, name, sourceId } = pendingClip
  const cleanName = name.trim() || `Clip ${chart.clips.length + 1}`
  const src = chart.importedSources.find((s) => s.id === sourceId)
  if (!src) return
  const cache = await fetchSourceData(src)
  if (!cache) return
  const slice = sliceSourceChartForClip(cache.notes, cache.tempoSegments, cache.resolution, startSec, endSec)
  let id: string
  do {
    id = Math.random().toString(36).slice(2, 10)
  } while (chart.musicSections[`MusicSeg_${id}`] !== undefined)
  const sectionName = `MusicSeg_${id}`
  const newClip: Clip = {
    id, sectionName, name: cleanName, sourceId,
    startSec, endSec, notesCount: slice.notesCount, bpm: slice.bpm,
  }
  setChart({
    ...chart,
    musicSections: { ...chart.musicSections, [sectionName]: slice.sectionBody },
    clips: [...chart.clips, newClip],
  })
  setDirty(true)
  setSelectedClipId(id)
  setPendingClip(null)
}
```

- [ ] **Step 2: Render the popover near the WaveformStrip**

Just below the `<WaveformStrip ... />`, add:

```tsx
{pendingClip && (
  <div className="px-3 py-2 bg-gray-900 border-y border-gray-800 flex items-center gap-2">
    <span className="text-[10px] text-gray-500 uppercase tracking-wider">New clip</span>
    <input
      autoFocus
      type="text"
      value={pendingClip.name}
      onChange={(e) => setPendingClip({ ...pendingClip, name: e.target.value })}
      placeholder={`Clip name (${(pendingClip.endSec - pendingClip.startSec).toFixed(1)}s)`}
      className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-200 w-48"
      onKeyDown={(e) => {
        if (e.key === 'Enter') saveClipFromPending()
        if (e.key === 'Escape') setPendingClip(null)
      }}
    />
    <button onClick={saveClipFromPending}
      className="text-[11px] px-2 py-1 bg-cyan-700 hover:bg-cyan-600 rounded text-white">
      Save clip
    </button>
    <button onClick={() => setPendingClip(null)}
      className="text-[11px] px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded text-gray-300">
      Cancel
    </button>
  </div>
)}
```

- [ ] **Step 3: TypeScript check + smoke**

```
cd web/frontend && npx tsc --noEmit
```

Smoke (after Tasks 6 + 7 land — the source picker is needed to test). For now just verify TS.

- [ ] **Step 4: Commit**

```
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): save dragged region as a source-based clip"
```

---

## Task 6: Frontend — `SourcePickerModal`

**Files:**
- Create: `web/frontend/src/components/SourcePickerModal.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useEffect, useState } from 'react'

interface Beatmap {
  id: string
  stem: string
  song_name?: string
  generated_at?: number
}

interface Track {
  id: string
  name: string
  artist?: string
  beatmaps?: Beatmap[]
}

interface Props {
  existingIds: string[]              // already-imported local ids; reject collisions
  onCancel: () => void
  onPick: (localId: string, trackId: string, beatmapId: string, displayName: string) => void
}

export function SourcePickerModal({ existingIds, onCancel, onPick }: Props) {
  const [tracks, setTracks] = useState<Track[]>([])
  const [selectedTrack, setSelectedTrack] = useState<Track | null>(null)
  const [selectedBeatmap, setSelectedBeatmap] = useState<Beatmap | null>(null)
  const [localId, setLocalId] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/tracks').then((r) => r.json()).then(setTracks).catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!selectedTrack) return
    fetch(`/api/tracks/${selectedTrack.id}`)
      .then((r) => r.json())
      .then((data: Track) => setSelectedTrack(data))
      .catch(() => undefined)
  }, [selectedTrack?.id])  // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-suggest a local id.
  useEffect(() => {
    let n = 1
    while (existingIds.includes(`src_${String.fromCharCode(96 + n)}`) && n < 26) n++
    setLocalId(n <= 26 ? `src_${String.fromCharCode(96 + n)}` : `src_${Date.now().toString(36)}`)
  }, [existingIds.length])  // eslint-disable-line react-hooks/exhaustive-deps

  const validId = /^[a-z][a-z0-9_]*$/.test(localId) && !existingIds.includes(localId)

  const handleImport = () => {
    if (!selectedTrack || !selectedBeatmap || !validId) {
      setError(!validId ? 'Local id must match [a-z][a-z0-9_]* and be unique' : 'Pick a track and beatmap')
      return
    }
    onPick(
      localId,
      selectedTrack.id,
      selectedBeatmap.id,
      selectedBeatmap.song_name || selectedTrack.name,
    )
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center" onClick={onCancel}>
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 w-[640px] max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold text-gray-200 mb-3">Pick a beatmap to import</h2>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <div className="text-[10px] text-gray-500 uppercase mb-1">Tracks ({tracks.length})</div>
            <ul className="border border-gray-800 rounded h-64 overflow-y-auto">
              {tracks.map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => { setSelectedTrack(t); setSelectedBeatmap(null) }}
                    className={`w-full text-left px-2 py-1 text-[11px] ${
                      selectedTrack?.id === t.id ? 'bg-cyan-900/30 text-cyan-200' : 'text-gray-300 hover:bg-gray-800'
                    }`}
                  >
                    {t.name}
                    {t.artist && <span className="text-gray-600"> · {t.artist}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-[10px] text-gray-500 uppercase mb-1">Beatmaps</div>
            <ul className="border border-gray-800 rounded h-64 overflow-y-auto">
              {(selectedTrack?.beatmaps ?? []).map((bm) => (
                <li key={bm.id}>
                  <button
                    onClick={() => setSelectedBeatmap(bm)}
                    className={`w-full text-left px-2 py-1 text-[11px] ${
                      selectedBeatmap?.id === bm.id ? 'bg-cyan-900/30 text-cyan-200' : 'text-gray-300 hover:bg-gray-800'
                    }`}
                  >
                    {bm.stem}
                    {bm.song_name && <span className="text-gray-600"> · {bm.song_name}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] text-gray-500 uppercase tracking-wider">Local id</span>
          <input
            type="text"
            value={localId}
            onChange={(e) => { setLocalId(e.target.value); setError('') }}
            className={`bg-gray-800 border ${validId ? 'border-gray-700' : 'border-red-700'} rounded px-2 py-1 text-[11px] text-gray-200 w-32 font-mono`}
          />
          <span className="text-[10px] text-gray-600">a-z, 0-9, _ — must be unique</span>
        </div>
        {error && <p className="text-[11px] text-red-400 mb-2">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="text-[11px] px-3 py-1 bg-gray-800 hover:bg-gray-700 rounded text-gray-300">
            Cancel
          </button>
          <button
            onClick={handleImport}
            disabled={!selectedTrack || !selectedBeatmap || !validId}
            className="text-[11px] px-3 py-1 bg-cyan-700 hover:bg-cyan-600 disabled:opacity-40 rounded text-white"
          >
            Import
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: TypeScript check + commit**

```
cd web/frontend && npx tsc --noEmit
git add web/frontend/src/components/SourcePickerModal.tsx
git commit -m "feat(editor): SourcePickerModal for importing beatmaps"
```

---

## Task 7: Frontend — `ImportedSourcesPanel` + import flow

**Files:**
- Create: `web/frontend/src/components/ImportedSourcesPanel.tsx`
- Modify: `web/frontend/src/components/BeatmapEditor.tsx` (sidebar slot + handlers)

- [ ] **Step 1: Create the panel component**

```tsx
import type { ReactNode } from 'react'

interface SourceRow {
  id: string
  name: string
  spliceCount: number
  selected: boolean
}

interface Props {
  rows: SourceRow[]
  onSelect: (id: string | null) => void
  onOpenPicker: () => void
  onRename: (id: string, newId: string) => void
  onDelete: (id: string) => void
  Wrapper: ({ children, title, right }: { children: ReactNode; title: string; right?: ReactNode }) => ReactNode
}

export function ImportedSourcesPanel({
  rows, onSelect, onOpenPicker, onRename, onDelete, Wrapper,
}: Props) {
  return (
    <Wrapper
      title="Imported sources"
      right={rows.length > 0 ? (
        <span className="text-[10px] text-cyan-300 font-mono">{rows.length}</span>
      ) : undefined}
    >
      <ul className="space-y-1 mb-2">
        {/* Pseudo-row for the tutorial itself — selecting it shows the
            tutorial's own song waveform with no splicing. */}
        <li>
          <button
            onClick={() => onSelect(null)}
            className={`w-full px-2 py-1 text-left text-[11px] rounded border ${
              rows.every((r) => !r.selected)
                ? 'border-cyan-500 bg-cyan-900/15 text-cyan-200'
                : 'border-gray-800 bg-gray-900/40 text-gray-400 hover:bg-gray-800/60'
            }`}
            title="Show this tutorial's own song; cannot splice (it's the tutorial itself)"
          >
            ◯ (this tutorial)
          </button>
        </li>
        {rows.map((r) => (
          <li
            key={r.id}
            className={`px-2 py-1 rounded border ${
              r.selected ? 'border-cyan-500 bg-cyan-900/15' : 'border-gray-800 bg-gray-900/40'
            }`}
          >
            <div className="flex items-center gap-1">
              <button
                onClick={() => onSelect(r.id)}
                className={`shrink-0 w-4 h-4 rounded-full text-[8px] font-mono ${
                  r.selected ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-500'
                }`}
                title="Make this source active for splicing"
              >
                {r.selected ? '◉' : '○'}
              </button>
              <input
                type="text"
                value={r.id}
                onChange={(e) => onRename(r.id, e.target.value)}
                className="flex-1 min-w-0 bg-transparent border-0 text-[11px] text-gray-200 font-mono truncate focus:outline-none focus:bg-gray-800 rounded px-1"
                title="Local id (a-z, 0-9, _) — propagates to MUSIC source= refs on save"
              />
              <button
                onClick={() => onDelete(r.id)}
                className="shrink-0 px-1 py-0.5 bg-red-900/30 hover:bg-red-800/60 border border-red-800/40 rounded text-[10px] text-red-300"
                title="Remove import + any splices that reference it"
              >
                ×
              </button>
            </div>
            <div className="text-[10px] text-gray-500 truncate mt-0.5" title={r.name}>
              {r.name} · {r.spliceCount} splice{r.spliceCount === 1 ? '' : 's'}
            </div>
          </li>
        ))}
      </ul>
      <button
        onClick={onOpenPicker}
        className="w-full text-[10px] px-2 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-gray-200"
      >
        + Import beatmap…
      </button>
    </Wrapper>
  )
}
```

- [ ] **Step 2: Wire into BeatmapEditor sidebar**

In `BeatmapEditor.tsx`, near the existing sidebar `CollapsibleSection`s:

```tsx
import { ImportedSourcesPanel } from './ImportedSourcesPanel'
import { SourcePickerModal } from './SourcePickerModal'

// near other useState
const [pickerOpen, setPickerOpen] = useState(false)

// near other handlers
const importSource = (id: string, trackId: string, beatmapId: string, name: string) => {
  if (!chart) return
  setChart({
    ...chart,
    importedSources: [...chart.importedSources, { id, trackId, beatmapId, name }],
  })
  setDirty(true)
  setActiveSourceId(id)
  setPickerOpen(false)
}

const renameSource = (oldId: string, newId: string) => {
  if (!chart) return
  if (!/^[a-z][a-z0-9_]*$/.test(newId)) return
  if (oldId === newId) return
  if (chart.importedSources.some((s) => s.id === newId)) return
  setChart({
    ...chart,
    importedSources: chart.importedSources.map((s) => s.id === oldId ? { ...s, id: newId } : s),
    clips: chart.clips.map((c) => c.sourceId === oldId ? { ...c, sourceId: newId } : c),
    tutorial: chart.tutorial.map((e) => (e.kind === 'music' && e.source === oldId) ? { ...e, source: newId } : e),
  })
  setDirty(true)
  if (activeSourceId === oldId) setActiveSourceId(newId)
}

const deleteSource = (id: string) => {
  if (!chart) return
  const src = chart.importedSources.find((s) => s.id === id)
  if (!src) return
  if (!window.confirm(`Remove "${src.name}" and any splices that reference it?`)) return
  const sectionsToDrop = new Set(chart.clips.filter((c) => c.sourceId === id).map((c) => c.sectionName))
  const nextSections = { ...chart.musicSections }
  for (const sn of sectionsToDrop) delete nextSections[sn]
  setChart({
    ...chart,
    importedSources: chart.importedSources.filter((s) => s.id !== id),
    musicSections: nextSections,
    clips: chart.clips.filter((c) => c.sourceId !== id),
    tutorial: chart.tutorial.filter((e) => !(e.kind === 'music' && e.source === id)),
  })
  setDirty(true)
  if (activeSourceId === id) setActiveSourceId(null)
}

// in JSX
{chart && (
  <ImportedSourcesPanel
    rows={chart.importedSources.map((s) => ({
      id: s.id,
      name: s.name,
      spliceCount: chart.clips.filter((c) => c.sourceId === s.id).length,
      selected: s.id === activeSourceId,
    }))}
    onSelect={setActiveSourceId}
    onOpenPicker={() => setPickerOpen(true)}
    onRename={renameSource}
    onDelete={deleteSource}
    Wrapper={CollapsibleSection as any}
  />
)}
{pickerOpen && chart && (
  <SourcePickerModal
    existingIds={chart.importedSources.map((s) => s.id)}
    onCancel={() => setPickerOpen(false)}
    onPick={importSource}
  />
)}
```

- [ ] **Step 3: TypeScript check + smoke**

```
cd web/frontend && npx tsc --noEmit
```

Smoke: open the editor, verify the Imported sources panel shows in the sidebar with the "(this tutorial)" pseudo-row. Click + Import beatmap → modal opens → pick a track + beatmap → importing creates a new entry in the panel + activates it. Drag a region on the WaveformStrip → save clip → splice count increments.

- [ ] **Step 4: Commit**

```
git add web/frontend/src/components/ImportedSourcesPanel.tsx web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): ImportedSourcesPanel + SourcePickerModal"
```

---

## Task 8: Frontend — `ClipsLibraryPanel` + place-at-playhead

**Files:**
- Create: `web/frontend/src/components/ClipsLibraryPanel.tsx`
- Modify: `web/frontend/src/components/BeatmapEditor.tsx`

- [ ] **Step 1: Create the panel**

```tsx
import type { ReactNode } from 'react'

interface ClipRow {
  id: string
  name: string
  sourceId: string | null   // null = upload-based
  sourceLabel: string       // display label for the source badge
  startSec: number
  endSec: number
  notesCount: number
  isPlaced: boolean
}

interface Props {
  clips: ClipRow[]
  selectedClipId: string | null
  onSelect: (id: string | null) => void
  onAudition: (id: string) => void
  onPlaceAtPlayhead: (id: string) => void
  onRename: (id: string, newName: string) => void
  onDelete: (id: string) => void
  Wrapper: ({ children, title, right }: { children: ReactNode; title: string; right?: ReactNode }) => ReactNode
}

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
          Import a source above and drag a region on the waveform to author your first clip.
        </p>
      ) : (
        <ul className="space-y-1">
          {clips.map((c) => {
            const sel = c.id === selectedClipId
            return (
              <li
                key={c.id}
                className={`px-2 py-1.5 rounded border ${
                  sel ? 'border-cyan-500 bg-cyan-900/15' : 'border-gray-800 bg-gray-900/40'
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
                  <span className="px-1 bg-gray-800 rounded text-gray-400">{c.sourceLabel}</span>
                  {c.sourceId ? (
                    <span>{(c.endSec - c.startSec).toFixed(1)}s · {c.notesCount}n</span>
                  ) : (
                    <span>(uploaded) · {c.notesCount}n</span>
                  )}
                  {c.isPlaced && <span className="text-emerald-400">placed</span>}
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); onPlaceAtPlayhead(c.id) }}
                  className="mt-1 w-full text-[10px] px-1.5 py-1 bg-gray-800 hover:bg-gray-700 rounded text-gray-200"
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

- [ ] **Step 2: Wire handlers + slot in BeatmapEditor**

```ts
const renameClip = (id: string, name: string) => {
  if (!chart) return
  setChart({ ...chart, clips: chart.clips.map((c) => c.id === id ? { ...c, name } : c) })
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
    tutorial: chart.tutorial.filter((e) => !(e.kind === 'music' && e.sectionName === clip.sectionName)),
  })
  setDirty(true)
  if (selectedClipId === id) setSelectedClipId(null)
}

const placeClipAtPlayhead = (id: string) => {
  if (!chart) return
  const clip = chart.clips.find((c) => c.id === id)
  if (!clip) return
  const tick = secToTick(tempoSegments, chart.resolution, currentTime)
  const ev: TutorialMusicEvent = {
    kind: 'music',
    id: `music-${Date.now()}`,
    tick,
    file: clip.sourceId ? '' : `segments/${clip.sectionName.replace('MusicSeg_', '')}.ogg`,
    sectionName: clip.sectionName,
    bpm: clip.bpm,
    resolution: chart.resolution,
    durationSeconds: clip.sourceId ? (clip.endSec - clip.startSec) : 0,
    notesCount: clip.notesCount,
    required: Math.min(5, clip.notesCount),
    timing: 'any',
    retryVo: '',
    next: '',
    ...(clip.sourceId ? {
      source: clip.sourceId,
      stem: 'song',
      startMs: Math.round(clip.startSec * 1000),
      durationMs: Math.round((clip.endSec - clip.startSec) * 1000),
    } : {}),
  }
  setChart({ ...chart, tutorial: [...chart.tutorial, ev], tutorialEnabled: true })
  setDirty(true)
  setSelectedTutorialId(ev.id)
}
```

JSX:

```tsx
{chart && (
  <ClipsLibraryPanel
    clips={chart.clips.map((c) => ({
      id: c.id,
      name: c.name,
      sourceId: c.sourceId,
      sourceLabel: c.sourceId ?? '(upload)',
      startSec: c.startSec,
      endSec: c.endSec,
      notesCount: c.notesCount,
      isPlaced: chart.tutorial.some((e): e is TutorialMusicEvent => e.kind === 'music' && e.sectionName === c.sectionName),
    }))}
    selectedClipId={selectedClipId}
    onSelect={setSelectedClipId}
    onAudition={(id) => auditionClip(id)}
    onPlaceAtPlayhead={placeClipAtPlayhead}
    onRename={renameClip}
    onDelete={deleteClip}
    Wrapper={CollapsibleSection as any}
  />
)}
```

(`auditionClip` is added in Task 9.)

- [ ] **Step 3: TypeScript check + smoke + commit**

```
cd web/frontend && npx tsc --noEmit
git add web/frontend/src/components/ClipsLibraryPanel.tsx web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): ClipsLibraryPanel + place-at-playhead"
```

---

## Task 9: Frontend — clip audition + slice-mode MUSIC playback

**Files:**
- Modify: `web/frontend/src/components/BeatmapEditor.tsx`

- [ ] **Step 1: Add audition + transport-time slice playback**

Near `voAudiosRef`, add:

```ts
const sliceAudioRef = useRef<HTMLAudioElement | null>(null)

const auditionClip = (id: string) => {
  if (!chart) return
  const clip = chart.clips.find((c) => c.id === id)
  if (!clip) return
  if (sliceAudioRef.current) { sliceAudioRef.current.pause(); sliceAudioRef.current = null }
  let url: string
  let start = 0
  let end: number = Infinity
  if (clip.sourceId) {
    const src = chart.importedSources.find((s) => s.id === clip.sourceId)
    if (!src) return
    url = `/api/tracks/${src.trackId}/beatmaps/${src.beatmapId}/download/song.ogg`
    start = clip.startSec
    end = clip.endSec
  } else {
    url = `/api/tutorial/${trackId}/beatmaps/${beatmapId}/segments/${clip.sectionName.replace('MusicSeg_', '')}.ogg`
  }
  const a = new Audio(url)
  sliceAudioRef.current = a
  const startPlayback = () => {
    if (start > 0) a.currentTime = start
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

- [ ] **Step 2: TypeScript check + smoke + commit**

```
cd web/frontend && npx tsc --noEmit
```

Smoke: import a source, splice a clip, audition it — should play the slice from the source's song.ogg, stop at end.

```
git add web/frontend/src/components/BeatmapEditor.tsx
git commit -m "feat(editor): clip audition for source-based + upload-based clips"
```

---

## Task 10: Backend — publish-time imported-sources bundling + orphan strip (TDD)

**Files:**
- Modify: `web/backend/app/routers/tracks.py`
- Test: `web/backend/tests/test_publish_imported_sources.py` (create)

- [ ] **Step 1: Write failing tests**

```python
"""Tests for the publish-time imported-sources copy + orphan-MusicSeg strip."""
from __future__ import annotations

from pathlib import Path

from app.routers.tracks import _strip_orphan_musicsegs, _parse_imported_sources_section


CHART = """\
[Song]
{
  Resolution = 192
}
[ImportedSources]
{
  src_a = track="trk1" beatmap="bm1" name="Crashing Down"
  src_b = track="trk2" beatmap="bm2" name="Stairway"
}
[ExpertSingle]
{
  100 = N 0 0
}
[TutorialScript]
{
  192 = MUSIC source="src_a" stem="song" section="MusicSeg_used" start_ms=0 duration_ms=1000 bpm=120.00 resolution=192 duration=1.00 notes=2 required=2 timing=any
}
[MusicSeg_used]
{
  ; source="src_a" start_sec=0.000 end_sec=1.000 name="placed"
  0 = N 0 0
}
[MusicSeg_orphan]
{
  ; source="src_b" start_sec=10.000 end_sec=20.000 name="library only"
  0 = N 0 0
}
"""


def test_parse_imported_sources_returns_dict():
    sources = _parse_imported_sources_section(CHART)
    assert sources == {
        'src_a': {'track': 'trk1', 'beatmap': 'bm1', 'name': 'Crashing Down'},
        'src_b': {'track': 'trk2', 'beatmap': 'bm2', 'name': 'Stairway'},
    }


def test_orphan_section_dropped():
    out = _strip_orphan_musicsegs(CHART)
    assert '[MusicSeg_used]' in out
    assert '[MusicSeg_orphan]' not in out
    assert 'source="src_a"' in out


def test_imported_sources_section_can_be_stripped():
    """Helper exists to drop the [ImportedSources] section before publish."""
    from app.routers.tracks import _strip_imported_sources_section
    out = _strip_imported_sources_section(CHART)
    assert '[ImportedSources]' not in out
    # MUSIC events still reference src_a — runtime resolves to sources/src_a/song.ogg
    assert 'source="src_a"' in out
```

- [ ] **Step 2: Run tests to verify they fail**

```
cd web/backend && venv/Scripts/python.exe -m pytest tests/test_publish_imported_sources.py -v
```
Expected: 3 failures (helpers don't exist).

- [ ] **Step 3: Implement the helpers**

In `web/backend/app/routers/tracks.py`:

```python
import re

_IMPORTED_SOURCES_RE = re.compile(r'\[ImportedSources\]\s*\{([^}]*)\}', re.DOTALL)
_IMPORTED_ROW_RE = re.compile(
    r'^\s*([a-z][a-z0-9_]*)\s*=\s*track="([^"]*)"\s+beatmap="([^"]*)"\s+name="([^"]*)"',
    re.MULTILINE,
)


def _parse_imported_sources_section(chart_text: str) -> dict[str, dict[str, str]]:
    """Return {local_id: {track, beatmap, name}} for every entry in the
    [ImportedSources] section. Empty dict if the section is missing."""
    m = _IMPORTED_SOURCES_RE.search(chart_text)
    if not m:
        return {}
    out: dict[str, dict[str, str]] = {}
    for row in _IMPORTED_ROW_RE.finditer(m.group(1)):
        out[row.group(1)] = {'track': row.group(2), 'beatmap': row.group(3), 'name': row.group(4)}
    return out


def _strip_imported_sources_section(chart_text: str) -> str:
    """Drop the [ImportedSources] section. Used at publish time — Unity
    resolves `MUSIC source=` directly to `sources/<source>/song.ogg`,
    no studio-side ids needed."""
    return _IMPORTED_SOURCES_RE.sub('', chart_text).strip() + '\n'


def _strip_orphan_musicsegs(chart_text: str) -> str:
    """Remove [MusicSeg_<id>] sections that no MUSIC event references."""
    tut_match = re.search(r'\[TutorialScript\]\s*\{([^}]*)\}', chart_text, flags=re.DOTALL)
    referenced: set[str] = set()
    if tut_match:
        for m in re.finditer(r'\d+\s*=\s*MUSIC\s+[^\n]*?section="([^"]+)"', tut_match.group(1)):
            referenced.add(m.group(1))

    def repl(m: re.Match) -> str:
        return '' if m.group(1) not in referenced else m.group(0)

    return re.sub(r'\[(MusicSeg_[A-Za-z0-9]+)\]\s*\{[^}]*\}\s*', repl, chart_text, flags=re.DOTALL)
```

- [ ] **Step 4: Wire into `_bundle_tutorial_assets`**

At the end of `_bundle_tutorial_assets`, after the chart is written:

```python
if chart_path.exists():
    text = chart_path.read_text(encoding='utf-8', errors='replace')
    sources = _parse_imported_sources_section(text)
    # Copy each source's song.ogg into sources/<id>/song.ogg
    for local_id, meta in sources.items():
        src_track_dir = Path(settings.upload_dir) / '_tracks' / meta['track']
        src_audio = src_track_dir / 'beatmaps' / meta['beatmap'] / 'song.ogg'
        if not src_audio.exists():
            src_audio = src_track_dir / 'stems' / 'song.ogg'
        if src_audio.exists():
            dst = tmp_dir / 'sources' / local_id / 'song.ogg'
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(str(src_audio), str(dst))
    # Strip ImportedSources + orphan MusicSegs
    text = _strip_imported_sources_section(text)
    text = _strip_orphan_musicsegs(text)
    chart_path.write_text(text, encoding='utf-8')
```

- [ ] **Step 5: Run tests to verify they pass**

```
cd web/backend && venv/Scripts/python.exe -m pytest tests/test_publish_imported_sources.py -v
```
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```
git add web/backend/app/routers/tracks.py web/backend/tests/test_publish_imported_sources.py
git commit -m "feat(publish): bundle imported sources + strip orphan MusicSegs"
```

---

## Task 11: Spec doc + e2e smoke + deploy

**Files:**
- Modify: `web/docs/REALNOTES_SPEC.md`

- [ ] **Step 1: Append the spec section**

Append to `web/docs/REALNOTES_SPEC.md`:

```markdown
## 9. Imported sources + slice-mode MUSIC events

A tutorial chart can import other beatmaps as **sources** to splice
sections from. The published folder layout grows:

```
song.ini
song.ogg                            ; tutorial's own backing
notes_fixed_slides.chart            ; the tutorial chart
sources/                            ; one folder per imported source
  src_a/
    song.ogg                        ; copy of src_a's song.ogg
  src_b/
    song.ogg
realnotes/                          ; (existing — pack/scale bundles)
vo/                                 ; (existing — collated VO)
```

The chart's `MUSIC` events in `[TutorialScript]` reference splices via
the new shape:

```
<tick> = MUSIC source="src_a" stem="song"
         start_ms=18300 duration_ms=24000
         section="MusicSeg_<id>"
         bpm=... resolution=... duration=... notes=...
         required=... timing=...
```

When `source="..."` is present, the engine plays
`sources/<source>/<stem>.ogg` from `start_ms` for `duration_ms`. The
referenced `[MusicSeg_<id>]` section holds the trimmed slice notes
(ticks renormalised to start at 0).

The legacy `MUSIC "<file>"` shape (standalone segment ogg) keeps
working for upload-based events. Distinguish by which fields are
present.

The `[ImportedSources]` section the tutorial editor writes to track
studio-side ids is **stripped at publish time** — the runtime only
needs the `source=` local ids that resolve to `sources/<id>/`.
```

- [ ] **Step 2: End-to-end smoke (manual)**

1. Create a normal track (Create page) — generates stems + per-stem beatmaps + chart.
2. Open a separate tutorial beatmap in the editor.
3. Open the Imported sources panel, click + Import beatmap, pick the track + a beatmap from step 1, give it a local id (e.g. `src_a`).
4. Confirm the row appears + becomes active.
5. WaveformStrip should show the source's song peaks.
6. Drag a region → name it → Save.
7. Confirm the clip appears in the Clips library with `(src_a)` badge.
8. Click ⏵ to audition — slice plays from the source's song.ogg.
9. Move playhead, click + place at playhead — orange MUSIC pill on the runway sidecar.
10. Save chart. Reload editor. Imported source + clip + placement all survive.
11. Push to GitHub via Game Library publish. Inspect the resulting folder:
    - `sources/src_a/song.ogg` exists.
    - `notes_fixed_slides.chart` has the placed `MUSIC source="src_a" start_ms=... duration_ms=...` line + `[MusicSeg_<id>]` section.
    - `[ImportedSources]` section is NOT present in the published chart.
    - Library-only `[MusicSeg_*]` sections (no MUSIC ref) are NOT present.

- [ ] **Step 3: Commit**

```
git add web/docs/REALNOTES_SPEC.md
git commit -m "docs: imported sources + slice-mode MUSIC events"
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

---

## Self-review notes

**Spec coverage:** Each spec section maps to tasks. Chart format → Task 2. Slicing → Task 3. UI WaveformStrip → Task 4. Save flow → Task 5. Source picker → Task 6. Imported sources panel → Task 7. Clips library → Task 8. Audition → Task 9. Publish → Task 10. Spec doc + smoke → Task 11.

**Type consistency:** `ImportedSource` defined Task 2, used in Tasks 3, 5, 7, 8, 9. `Clip` extended in Task 2 with `sourceId`, used everywhere. `TutorialMusicEvent` gains `source`/`stem`/`startMs`/`durationMs` in Task 2, consumed in Tasks 8, 9. `SourceChartCache` interface in Task 3, consumed in Task 4. Function names: `parseImportedSources` / `serializeImportedSources` / `parseClipMetadata` / `deriveClips` / `sliceSourceChartForClip` (frontend); `_parse_imported_sources_section` / `_strip_imported_sources_section` / `_strip_orphan_musicsegs` (backend). Consistent across tasks.

**No placeholders:** every code step shows complete code.

**Granularity:** Backend tasks are TDD with bite-sized steps. Frontend tasks are larger (no test scaffold) — split where it makes sense (separate Tasks for picker, panel, library, audition rather than one mega-task).
