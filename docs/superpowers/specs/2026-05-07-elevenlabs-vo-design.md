# ElevenLabs + VO bundle — design

**Status:** draft
**Date:** 2026-05-07
**Author:** Freshdex
**Scope:** Add ElevenLabs as a TTS option alongside Chatterbox, let authors pull existing ElevenLabs Studio generations into the editor, and bundle all VOs into a single `vo_bundle.ogg` (with offset-based chart references) at publish-to-Unity time. Per-file VOs in the editor stay unchanged.

---

## Goals

1. **Alt TTS engine.** ElevenLabs available per-VO, alongside Chatterbox. Voice picked per-track with per-VO override.
2. **Studio import.** Browse the user's ElevenLabs Studio projects/chapters/lines and drop existing generations into a beatmap as VOs (single line, or multi-select + insert).
3. **Single VO file in Unity builds.** Publish concatenates every VO into `vo_bundle.ogg` and rewrites the chart's VO lines to reference offsets in that file. Engineer wants one VO asset per song for performance.

## Non-goals

- No editor-side bundling. The editor keeps per-file VOs for cheap playback; bundling happens only when publishing to the Unity repo.
- No backwards migration of existing published charts. Forward-only.
- No deep ElevenLabs feature support beyond what these three goals need (no audio-isolation, no dubbing, no voice cloning UI in v1 — Chatterbox already covers cloning).
- No public exposure of the ElevenLabs API key. Backend-only.

## Storage and key handling

- API key resolution order:
  1. `ELEVENLABS_API_KEY` env var (read by `web/backend/app/config.py`, pydantic-settings).
  2. Fallback: read `elevenapi.txt` from the repo root. `web/backend/app/config.py` is 4 levels deep, so the lookup is `Path(__file__).resolve().parents[3] / 'elevenapi.txt'`. Already in `.gitignore`.
  3. If neither resolves, the ElevenLabs router returns `503 ElevenLabs not configured` from any of its endpoints.
- The key never reaches the frontend. All frontend calls go through the backend.

### Per-track default voice

`song.ini` gains a new optional key:

```
[song]
elevenlabs_voice_id = 21m00Tcm4TlvDq8ikWAM
```

Read/written by the existing song.ini handling on the track detail page.

### Per-VO override (editor only)

The `[TutorialScript]` `VO` line format gains two optional, editor-only attributes:

```
192 = VO "vo/intro.ogg" text="Welcome." engine=elevenlabs voice=21m00Tcm4TlvDq8ikWAM
```

Rules:
- `engine` — `chatterbox` (default) or `elevenlabs`. Missing means chatterbox, matching today's behavior.
- `voice` — only meaningful when `engine=elevenlabs`. Missing means inherit the track's `elevenlabs_voice_id`. If both are missing, synth fails with a 400 ("no voice configured").
- Both attributes are stripped on publish (Unity never sees them).

## Backend

### New service: `web/backend/app/services/elevenlabs_client.py`

Thin wrapper over the REST API. Handles:
- Lazy key resolution (env, then file fallback).
- Voice list with 5-minute in-memory cache.
- TTS synth (`POST /v1/text-to-speech/{voice_id}`, format `audio/ogg`, output written to disk).
- Studio: `GET /v1/studio/projects`, `GET /v1/studio/projects/{project_id}` (returns chapters), `GET /v1/studio/projects/{project_id}/chapters/{chapter_id}` (returns blocks/lines + per-line audio asset URL).
- Audio download for a Studio line (proxies the asset URL with auth).

All HTTP calls use `httpx.AsyncClient` with a 30-second default timeout.

### New router: `web/backend/app/routers/elevenlabs.py`

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/api/elevenlabs/voices` | — | `{ voices: [{ voice_id, name, labels }] }` |
| POST | `/api/elevenlabs/synth` | `{ text, voice_id, track_id, beatmap_id }` | `{ filename, rel_path, voice_id, engine: 'elevenlabs' }` |
| GET | `/api/elevenlabs/studio/projects` | `?page_size=50&cursor=...` | `{ projects: [{ project_id, name, … }], next_cursor }` |
| GET | `/api/elevenlabs/studio/projects/{project_id}/chapters` | — | `{ chapters: [{ chapter_id, name }] }` |
| GET | `/api/elevenlabs/studio/projects/{project_id}/chapters/{chapter_id}` | — | `{ chapter_id, name, lines: [{ block_id, text, duration_s }] }` |
| GET | `/api/elevenlabs/studio/stream-line/{project_id}/{chapter_id}/{block_id}` | — | streams `audio/ogg` (so the browser can preview without ever seeing the API key) |
| POST | `/api/elevenlabs/studio/import-line` | `{ project_id, chapter_id, block_id, track_id, beatmap_id }` | `{ filename, rel_path, text }` |
| GET | `/api/elevenlabs/studio/parse-url` | `?url=...` | `{ project_id, chapter_id }` or 400 |

Synth output is saved to `<beatmap>/vo/<uuid>.ogg`, mirroring the existing chatterbox path. The 12-char hex UUID prefix convention is preserved so file ownership stays consistent across engines. ElevenLabs synth requires a `beatmap_id`; preview mode (no beatmap) is not supported in v1, since every Generate click in the editor already has a beatmap context.

### Modify: `web/backend/app/services/github_publisher.py`

Before pushing top-level files, run a new `_bundle_vos(folder_path)` step:

1. Parse the chart in `folder_path`. Locate every `VO` line. Resolve audio paths under `folder_path/vo/`. Skip lines whose file is missing on disk.
2. If there are zero usable VOs, return early (no bundle, no chart rewrite).
3. Sort the VO lines by tick.
4. Probe each clip's duration via `ffprobe -v error -show_entries format=duration -of csv=p=0`. Build the cumulative offset table:
   ```
   line[0]: offset = 0.000, length = clip0_dur
   line[1]: offset = clip0_dur, length = clip1_dur
   ...
   ```
5. Concatenate clips with ffmpeg into `folder_path/vo_bundle.ogg`. Use the concat demuxer:
   - If all source clips are OGG/Opus: `ffmpeg -f concat -safe 0 -i list.txt -c copy vo_bundle.ogg` (no re-encode → no seam noise).
   - Otherwise re-encode to libopus 64k mono.
6. Rewrite the chart's `[TutorialScript]` body in-place: each `VO` line becomes:
   ```
   <tick> = VO offset=<sec, 3 dp> length=<sec, 3 dp> text="<draft text>"
   ```
   Editor-only `engine=` and `voice=` attributes are dropped.
7. Continue the existing publisher loop, which iterates top-level files of `folder_path`. The new `vo_bundle.ogg` is now a top-level file and gets pushed alongside `notes.chart`/`song.ogg`/`cover.png`.

`vo_bundle.ogg` and the rewritten chart are written into the song folder before the publisher's existing iter loop runs, so no additional logic is needed in the upload step.

The original `vo/` directory and per-file VOs remain untouched — they're never published; they stay in place for editor playback.

## Frontend

### Track detail page (`web/frontend/src/pages/TracksPage.tsx`)

Add an **ElevenLabs voice** dropdown to the existing Tutorial samples panel section (vocals stem). Voices come from `/api/elevenlabs/voices`. Selection writes to `song.ini` `elevenlabs_voice_id` via the existing song.ini editing flow.

If `/api/elevenlabs/voices` returns 503 ("not configured"), the dropdown shows a one-line "ElevenLabs not configured — add ELEVENLABS_API_KEY or elevenapi.txt" hint.

### BeatmapEditor — VO card (`web/frontend/src/components/BeatmapEditor.tsx`)

Each VO card grows two new controls under the textarea:

- **Engine** — radio buttons: `Chatterbox` / `ElevenLabs`. Defaults from the chart line's `engine=` attr, else `chatterbox`.
- **Voice** — visible only when `Engine = ElevenLabs`. Dropdown populated from `/api/elevenlabs/voices`. First option is `inherit (track default)`; selecting a specific voice writes the `voice=` attr.

The existing `🔊 Generate` button calls `/api/tutorial/tts/synth` (chatterbox) or `/api/elevenlabs/synth` (elevenlabs) based on the engine choice. On success it sets the VO's `file` field as today.

### New component: `ElevenLabsImportModal.tsx`

Opened from a new `📁 Import Studio` button next to `+ VO` in the Tutorial sidebar card.

Modal layout (top-down):

- Header: `Import from ElevenLabs Studio` + close button.
- URL strip: `Paste Studio URL: [____] [Fetch]` — calls `/api/elevenlabs/studio/parse-url`, then jumps to that chapter's line list.
- Tabs (visible only after fetching): `Browse` (default) / `Selected (n)`.
- **Browse tab**:
  - Breadcrumbs: `Projects → <Project name> → <Chapter name>`.
  - Project list view: paginated list, click to open chapters.
  - Chapter list view: list of chapters, click to open lines.
  - Line list view: each row is `[checkbox] ▶ <line text> (<duration>s)`. ▶ streams `/api/elevenlabs/studio/stream-line/...`.
- Footer: `[Cancel] [Insert N selected]` — calls `/api/elevenlabs/studio/import-line` for each selected block, sequentially, spacing them by their own audio length so they don't overlap. The first goes at the current playhead tick; each subsequent line is placed at `prev_tick + ceil(prev_length_seconds * ticks_per_second)`.

If only one line is selected, it inserts at the playhead with no auto-spacing logic. The modal stays open until explicitly closed (so authors can keep pulling lines).

## Unity-side contract — addition to `web/docs/TUTORIAL_SPEC.md`

```
## VO bundle

When a tutorial chart is published to the Unity repo, every VO is concatenated
into a single file `vo_bundle.ogg` (mono, OGG container) sitting alongside
song.ogg. The chart's VO lines are rewritten to reference offsets in that
bundle:

  <tick> = VO offset=<sec> length=<sec> text="<draft narration>"

- offset: float seconds from the start of vo_bundle.ogg
- length: float seconds of the VO's clip (length of audio to play)
- text: optional informational draft script — engine ignores

When the playhead crosses <tick>, the engine plays vo_bundle.ogg from offset
for length seconds. No editor-side per-file VOs ship in the published payload.
If a chart has no VOs, vo_bundle.ogg is omitted entirely.
```

## Phasing (informs the implementation plan)

Each phase ends with a deployable, working app:

- **Phase 1 — ElevenLabs as alt engine.** Backend voices/synth endpoints + per-VO engine/voice attrs in chart + editor VO card UI + track-level default voice. No Studio import, no bundling.
- **Phase 2 — Studio import.** Backend project/chapter/line endpoints + import modal (browse + URL fallback + multi-select).
- **Phase 3 — publish-time bundling.** ffmpeg concat in publisher + chart format transform + handover-doc update.

Phase 3 is independent of 1+2 in principle — it works on any per-file VOs regardless of how they were created.

## Risks

- **Studio audio streaming.** The modal's preview button needs auth-friendly streaming. Solved by backend proxying through `/api/elevenlabs/studio/stream-line/...`.
- **ffmpeg concat seam noise.** Avoided by `-c copy` when sources are OGG/Opus (Chatterbox + ElevenLabs both output OGG). Re-encode is a fallback for mixed-format input.
- **Voice list freshness.** 5-min cache; modal has manual `Refresh` button.
- **Forward-incompatible chart.** Unity engine that doesn't know about `offset=…/length=…` will fail to play VOs. The handover doc + the engineer's awareness of this change handle that. Older charts that used file-path VOs are unaffected (bundling only fires at publish, on charts that go through the publisher after this lands).
- **Bundle staleness vs the chart.** If someone hand-edits the published chart out-of-band, offsets won't match `vo_bundle.ogg`. Mitigation: publisher always regenerates both atomically; never reuses a stale bundle.
