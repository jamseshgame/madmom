# Chart iteration loop — design

Date: 2026-05-22
Status: Draft

## Problem

We can now generate many beatmap variants per stem (V1 — defaults, V2 — tonal, …, V10 — polyphonic, etc.) and publish them all into the same `notes.chart` as numbered alternate sections (see [2026-05-22 multi-beatmap chart](2026-05-22-multi-beatmap-chart-design.md)). What's missing to close the iteration loop:

1. **The Unity game can't discover the variants.** It would need to parse `notes.chart` itself to learn that `[ExpertSingle2]` and `[ExpertSingle3]` exist and which preset each came from. `song.ini` — the lightweight metadata file every CH-style tool reads first — only describes the active beatmap.
2. **There is no in-app way to record subjective feedback on a generated chart.** Today the only signal we have on chart quality is "the user re-generates with a different preset" — a coarse, ambiguous signal that doesn't say *what* was wrong.
3. **There is no path from accumulated feedback to a new preset.** If across 30 drum charts the player consistently writes "too crampy at high tempo", that pattern goes nowhere — nobody is reading it and proposing a `v12 — anti-cramp drums` preset that addresses it.

We want the loop: generate variants → play and leave feedback → Claude reads the corpus and proposes new presets → generate more variants → repeat, until charts feel like you're actually playing the track.

## Goal

Ship three integrated capabilities in one design:

- **A. song.ini multi-chart metadata** — mirror the `[Beatmaps]` block already in `notes.chart` into `song.ini` as numbered `[beatmap_N]` sections so a Unity client can build its variant picker without parsing the chart file.
- **B. Per-chart text feedback** — structured tags + 1-5 rating + free-form text, tagged with the logged-in user, stored as append-only JSONL inside each beatmap folder.
- **C. Claude-driven preset proposals** — an admin-only Generation Presets page with a per-stem "Propose new presets from feedback" button. The backend calls the Anthropic API with the aggregated stem-scoped feedback, the engine catalog, and the current preset library; returns up to N candidate presets. The user reviews each draft and saves the ones they want as new user-saved presets.

**Non-goals:**
- Streaming Claude responses — v1 is synchronous wait-for-completion (15-60 s).
- Rate limiting / cost tracking on the proposal endpoint beyond admin-only gating.
- Notification system for new feedback or new proposals.
- Edit history on feedback notes (PUT overwrites).
- Per-user "private" feedback — all feedback is visible to all logged-in users.
- Iteration tracking on proposals — every proposal call sends the full feedback corpus for that stem (cheap thanks to prompt caching).
- Auto-saving Claude's proposals into the preset library — the user is the gatekeeper.
- Unity-side parsing of the new `song.ini` blocks — that's a separate Jamsesh game ticket; this spec only emits the metadata.

## Background

**Existing identifiers** — established by the multi-beatmap chart work:
- `track_id` (folder under `<upload_dir>`)
- `beatmap_id` (folder under `<track>/beatmaps/`)
- `preset_name` (key in `generation_presets`, e.g. `v10-polyphonic-basic-pitch`)
- `stem` (one of `drums`, `guitar`, `bass`, `vocal`, …)

**Existing storage layout:**
- Per-track: `<upload_dir>/<track_id>/`
- Per-beatmap: `<upload_dir>/<track_id>/beatmaps/<beatmap_id>/` containing `notes.chart`, `song.ini`, and stem audio.
- Per-user: `<upload_dir>/users/users.json` with `{username → {password_hash, role, avatar, ...}}` (`web/backend/app/services/users.py`).
- Per-session: `<upload_dir>/users/sessions.json` (token → username, 30-day TTL).
- Presets: `<upload_dir>/generation_presets.json` for user-saved; built-ins live in code at `web/backend/app/routers/generation_presets.py:BUILTIN_PRESETS`. Each preset is `{name, description, builtin?, stems?: [str], generation: {<stage>: {engine, params}}}`.

**Existing song.ini writer** — `web/backend/app/services/chart_generator.py:write_chart_song_ini` (line 259). Currently emits `[song]` + one `[<diff>_stats]` block per difficulty. Reads chart stats via `chart_analyser.analyse_chart_file`.

**Existing chart merger** — `merge_beatmap_charts` already produces the `[Beatmaps]` metadata block in `notes.chart`. The new song.ini blocks are a one-for-one mirror of those rows.

## High-level design

```
┌────────────────────────────────────────────────────────────────────┐
│  Publish path (subsystem A)                                        │
│                                                                    │
│  publish_track_to_game                                             │
│     │                                                              │
│     ├─▶ merge_beatmap_charts (existing) ──▶ notes.chart [Beatmaps] │
│     │                                                              │
│     └─▶ write_chart_song_ini (modified) ─▶ song.ini [beatmap_N]    │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  Feedback path (subsystem B)                                       │
│                                                                    │
│  Tracks page chart row ──▶ FeedbackPanel ──▶ feedback router       │
│                                                       │            │
│                                                       ▼            │
│                                     <upload_dir>/<track>/beatmaps/ │
│                                       <beatmap_id>/feedback.jsonl  │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  Proposal path (subsystem C)                                       │
│                                                                    │
│  Generation Presets page                                           │
│     │                                                              │
│     └─▶ "Propose new presets for <stem>" ──▶ preset_proposer       │
│                                                       │            │
│                ┌──────────────────────────────────────┤            │
│                ▼                                      ▼            │
│        feedback_aggregate(stem)             engines_catalog()      │
│        + BUILTIN_PRESETS / user-saved                              │
│                │                                                   │
│                └──────────────▶ Anthropic API (cached system msg)  │
│                                          │                         │
│                                          ▼                         │
│                                  N candidate presets               │
│                                          │                         │
│                                          ▼                         │
│                              ProposalReviewModal                   │
│                                          │                         │
│                                          ▼ (per card)              │
│                              Save → user-saved presets             │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

**Component diffs:**

| Path | Action |
|---|---|
| `web/backend/app/services/chart_generator.py` | Modify — `write_chart_song_ini` gains an optional `beatmaps=[…]` argument; emits `[beatmap_N]` sections after `[song]` and the `[<diff>_stats]` blocks |
| `web/backend/app/routers/tracks.py` | Modify — `publish_track_to_game` passes the same `(id, name, preset, stem, is_active, sections)` list that's already built for `merge_beatmap_charts` into `write_chart_song_ini` |
| `web/backend/app/services/feedback.py` | Create — `FEEDBACK_TAGS` constant + CRUD helpers + `aggregate_for_stem` |
| `web/backend/app/routers/feedback.py` | Create — new router under `/api/feedback` |
| `web/backend/app/services/preset_proposer.py` | Create — Anthropic client wrapper + system-prompt builder + response validator |
| `web/backend/app/routers/generation_presets.py` | Modify — add `POST /propose-from-feedback?stem=<stem>&n=<n>` |
| `web/backend/app/config.py` | Modify — add `anthropic_api_key`, `anthropic_model`, `anthropic_max_tokens` |
| `web/backend/app/main.py` | Modify — mount the new `feedback` router |
| `web/backend/requirements.txt` | Modify — add `anthropic` SDK |
| `web/frontend/src/components/feedback/FeedbackPanel.tsx` | Create — listing + new-note form, mountable in chart rows and the editor |
| `web/frontend/src/components/feedback/FeedbackButton.tsx` | Create — the "Feedback (N)" toggle button shown on each chart row |
| `web/frontend/src/pages/GenerationPresetsPage.tsx` | Create — admin-only top-level page listing presets grouped by stem |
| `web/frontend/src/components/presets/ProposalReviewModal.tsx` | Create — N-card side-by-side review modal |
| `web/frontend/src/App.tsx` | Modify — add `/presets` route (alongside the existing `/tracks`, `/users`, …) gated by `role === 'admin'` |
| `web/backend/tests/test_feedback_crud.py` | Create |
| `web/backend/tests/test_feedback_aggregate.py` | Create |
| `web/backend/tests/test_preset_proposer.py` | Create |
| `web/backend/tests/test_write_chart_song_ini.py` | Modify — extend to cover the new `beatmaps` parameter |

## Subsystem A — song.ini multi-chart metadata

`write_chart_song_ini` signature gains an optional `beatmaps: list[dict] | None = None`. Each entry has the same shape `publish_track_to_game` already builds for the chart merger:

```python
{
  'id': 'a91b4d038f0672dc',
  'name': 'V10 — POLYPHONIC (BASIC-PITCH)',
  'preset': 'v10-polyphonic-basic-pitch',
  'stem': 'guitar',
  'is_active': False,
  'sections': ['ExpertSingle2', 'HardSingle2', 'MediumSingle2', 'EasySingle2'],
}
```

When `beatmaps` is None or empty, song.ini is written exactly as today. When provided, after the existing `[<diff>_stats]` blocks the writer appends:

```ini
[beatmap_1]
id = 4d038f0672dc
name = V10 — POLYPHONIC (BASIC-PITCH)
preset = v10-polyphonic-basic-pitch
stem = guitar
is_active = true
sections = ExpertSingle,HardSingle,MediumSingle,EasySingle

[beatmap_2]
id = a91b4d038f0672dc
name = V9 — SPARSE STRONG-BEAT
preset = v9-sparse-strong-beat
stem = guitar
is_active = false
sections = ExpertSingle2,HardSingle2,MediumSingle2,EasySingle2
```

**Numbering rule:** `N` matches the section-number suffix from the chart merger — primary (unnumbered chart sections) = `beatmap_1`, alternates = `beatmap_2+`. The list order is the same as the chart's `[Beatmaps]` block (active-first, then alphabetical by preset name) so Unity can iterate them in order.

**Escaping:** `name`, `preset`, and any other free-text field is run through the same `_esc` helper used by the chart `[Beatmaps]` block — strip newlines and carriage returns; escape embedded double quotes. (song.ini is line-oriented like the chart's row format.)

**CH compatibility:** Clone Hero ignores unknown song.ini sections. The existing `[song]` and `[<diff>_stats]` blocks still describe the active beatmap, so a CH player sees the unchanged chart.

## Subsystem B — Per-chart feedback

### Record shape

```json
{
  "id": "fb_01HZX7Y8...",
  "created_at": "2026-05-22T14:32:11Z",
  "updated_at": "2026-05-22T14:32:11Z",
  "author": "freshdex",
  "rating": 3,
  "tags": ["too-crampy", "wrong-pitch-mapping"],
  "text": "Chorus chord shapes feel random; the kick is on the wrong lane."
}
```

- `id` — `fb_` + ULID. ULID gives lexicographic time ordering for free, useful when scanning JSONL by creation order.
- `rating` — integer 1-5 (1 = unplayable, 5 = feels great). Required.
- `tags` — list drawn from `FEEDBACK_TAGS`; optional (may be empty).
- `text` — free-form; optional (may be empty if tags + rating say enough).
- At least one of `tags` or `text` must be non-empty (a bare rating without commentary is not useful for Claude).

### Tag vocabulary

Fixed list in `web/backend/app/services/feedback.py`:

```python
FEEDBACK_TAGS: dict[str, list[str]] = {
    'Density':       ['too-sparse', 'too-dense'],
    'Lane spread':   ['too-crampy', 'over-spread'],
    'Pitch mapping': ['wrong-pitch-mapping', 'tonic-anchored'],
    'Chords':        ['too-many-chords', 'not-enough-chords', 'weird-chord-shapes'],
    'Open notes':    ['too-many-opens', 'not-enough-opens'],
    'Rhythm':        ['off-beat', 'missed-section-changes'],
    'Overall':       ['feels-great', 'feels-random', 'unplayable'],
}
```

The frontend reads the structure via `GET /api/feedback/tags` and renders categorized checkboxes. Adding a new tag is a code edit + deploy.

### Storage

`<upload_dir>/<track_id>/beatmaps/<beatmap_id>/feedback.jsonl` — append-only, one JSON object per line. Writing a note appends a line; editing rewrites the file (read all, mutate the target, write back); deleting also rewrites the file.

Append concurrency: file writes are serialized by a per-beatmap `threading.Lock` registered in `feedback.py` to avoid interleaved partial lines. (FastAPI's default thread-pool means CRUD endpoints can run concurrently.)

### Auth + visibility

- Any logged-in user can `GET` and `POST`.
- `PUT` allowed only if `request.user.username == note.author`.
- `DELETE` allowed if `request.user.username == note.author` OR `request.user.role == 'admin'`.
- All notes visible to all logged-in users (no per-author privacy).

### Endpoints

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| `GET` | `/api/feedback/tags` | any auth | — | `FEEDBACK_TAGS` |
| `GET` | `/api/feedback/tracks/{track_id}/beatmaps/{beatmap_id}` | any auth | — | `[FeedbackNote, ...]` (oldest first) |
| `POST` | `/api/feedback/tracks/{track_id}/beatmaps/{beatmap_id}` | any auth | `{rating, tags, text}` | created `FeedbackNote` |
| `PUT` | `/api/feedback/tracks/{track_id}/beatmaps/{beatmap_id}/{note_id}` | author only | `{rating, tags, text}` (partial OK) | updated `FeedbackNote` |
| `DELETE` | `/api/feedback/tracks/{track_id}/beatmaps/{beatmap_id}/{note_id}` | author or admin | — | `{ok: true}` |
| `GET` | `/api/feedback/aggregate?stem={stem}` | admin only | — | `[{track_id, track_name, preset_name, beatmap_id, notes: [...]}, …]` |

Errors: 401 unauth, 403 wrong author, 404 track/beatmap/note missing, 422 schema error (missing rating, unknown tag, both tags and text empty).

### Frontend

`FeedbackPanel.tsx`:
- Displays existing notes (oldest first): author avatar + name, timestamp, rating stars, tag chips, prose text.
- Edit/delete pencil/trash icons only on the user's own notes.
- New-note form at the bottom: rating slider (1-5), categorized tag multi-select, textarea, Submit. Submit posts then re-renders.
- Tag list fetched once at mount (cached) via `GET /api/feedback/tags`.

`FeedbackButton.tsx`:
- "Feedback" with a count badge (`Feedback (3)`) when there are notes; just "Feedback" otherwise.
- Sits in the chart row next to Edit/X.
- Click toggles the FeedbackPanel as an inline expandable panel directly below the chart row (same row group; no separate drawer or modal).
- The same `FeedbackPanel` is also mountable inside `BeatmapEditor.tsx` so the user can leave a note while playing the chart in the editor.

## Subsystem C — Claude-driven preset proposals

### Config additions

`web/backend/app/config.py` gains three pydantic fields:

```python
anthropic_api_key: str = ''                    # env: ANTHROPIC_API_KEY
anthropic_model: str = 'claude-sonnet-4-6'     # env: ANTHROPIC_MODEL
anthropic_max_tokens: int = 8192               # env: ANTHROPIC_MAX_TOKENS
```

Default model is Sonnet 4.6 — cheap enough for the iteration loop. Opt into Opus 4.7 by setting `ANTHROPIC_MODEL=claude-opus-4-7` per environment.

`web/backend/requirements.txt` gains `anthropic>=0.40` (the SDK).

### Endpoint

`POST /api/generation-presets/propose-from-feedback?stem=<stem>&n=<n>` (default `n=3`, max `5`), admin-only.

Returns:

```json
{
  "proposals": [
    {
      "name": "v12 — anti-cramp drums",
      "description": "Raises chord threshold further and switches to wider lane spread to address crampy-feel reports on fast tracks.",
      "generation": {
        "onsets":         {"engine": "librosa-onset",  "params": {}},
        "pitches":        {"engine": "centroid",       "params": {}},
        "quantized":      {"engine": "metric-weighted","params": {}},
        "lanes_expert":   {"engine": "section-sliding","params": {"chord_polyphony_threshold": 8}},
        "lanes_filtered": {"engine": "spread-fretboard","params": {}}
      },
      "stems": ["drums"],
      "rationale": "Three notes on drum charts (Song A V8, Song B V10, Song C V9) tagged 'too-crampy' with rating ≤ 2 mentioned fast-tempo cramping at chorus dynamics. Raising chord_polyphony_threshold from 6 to 8 cuts spurious double-fret hits; swapping the filter to spread-fretboard widens the lane usage. Anchored on the drums-v1 base."
    },
    …
  ]
}
```

### Backend flow

`web/backend/app/services/preset_proposer.py::propose_presets(stem: str, n: int) -> list[dict]`:

1. **Aggregate** via `feedback.aggregate_for_stem(stem)` — filters to beatmaps whose preset has `stems: [<stem>]` or no `stems` field. Returns per-beatmap groups with full track + preset context.
2. **Build system prompt** (large; ~3-6 KB) containing:
   - The preset schema (5 stages, what each does, accepted shape).
   - The full engine catalog from `engines_catalog()` — every engine name + its params + a one-line purpose.
   - All existing presets for this stem (built-in + user-saved) so Claude knows what's already covered and what gaps exist.
   - Output contract: `{"proposals": [{name, description, generation, stems?, rationale}, …]}` with `rationale` required to cite specific feedback by `(track_name, preset_name)`.
   - Tag vocabulary so Claude can reference tag patterns directly.
3. **User prompt** — the aggregated feedback bundle rendered as Markdown:
   ```
   ## Feedback corpus for stem: drums
   ### Track: Song A — preset: V8 — CREPE PITCH (id: 4d038f0672dc)
   - rating 2, tags [too-crampy, wrong-pitch-mapping] — "Choruses feel random; kick on right lane"
   - rating 3, tags [too-many-chords] — "OK in verse, too busy in bridge"
   ### Track: Song B — preset: V10 — POLYPHONIC (BASIC-PITCH) (id: ...)
   ...
   ```
4. **Call Anthropic API** with `cache_control: ephemeral` on the system-prompt blocks (the engine catalog + existing-presets text is the bulk and is identical across calls — caching the prefix saves ~90% of input tokens after the first call).
5. **Parse + validate** — JSON decode the response, then for each candidate run `generation_presets._validate_generation()` on its `generation` block. Drop candidates that fail schema; if all fail, raise `ProposalError` → 502.
6. **Return** the validated list to the frontend. Nothing is persisted server-side until the user clicks Save.

### Error handling

| Condition | Response |
|---|---|
| `settings.anthropic_api_key` empty | 503 `{"detail": "Anthropic API key not configured"}` |
| `stem` not in known stems | 422 |
| `n` out of range | 422 (clamp to 1..5) |
| No feedback found for stem | 422 `{"detail": "No feedback to aggregate for stem '<stem>'"}` |
| Anthropic API error | 502 with upstream message |
| Response not parseable JSON | 502 `{"detail": "Claude returned invalid JSON; retry"}` |
| All proposals fail schema validation | 502 `{"detail": "No valid proposals returned"}` |

### Generation Presets page

`web/frontend/src/pages/GenerationPresetsPage.tsx`, mounted at `/presets`, gated by `role === 'admin'`. Lists presets grouped by stem affinity:

- **Universal** group: presets with no `stems` field.
- **Per-stem** groups (`Drums`, `Guitar`, `Bass`, `Vocal`, …): presets with `stems: [<stem>]`. Only stems that have at least one preset show up.

Each preset row shows name, description, the engine choice per stage as collapsed chips, and — for user-saved — Edit/Delete buttons. Built-ins are read-only.

Each group header has a **"Propose new presets from feedback"** button. Click → calls `POST /api/generation-presets/propose-from-feedback?stem=<stem>&n=3`. While the call is in flight (15-60 s), the modal shows a spinner with a Cancel button (which aborts the fetch).

### Review modal

`web/frontend/src/components/presets/ProposalReviewModal.tsx`:
- Renders N candidate cards side-by-side (responsive — stack on narrow viewports).
- Each card shows:
  - **Name** (editable text input; pre-filled from Claude).
  - **Description** (editable textarea; pre-filled).
  - **Stages** — 5 rows, each showing `engine` (read-only chip) and `params` (read-only JSON). Not editable in v1 — if the user wants to tweak, they Save and edit in the regular preset editor afterward.
  - **Stems** — read-only chip(s) populated from Claude's `stems` field (or "Universal" if omitted). Stems filter is fixed by which group's button launched the call (per-stem button → Claude almost always returns `stems: [<stem>]`); to repurpose a draft as universal, save it then edit.
  - **Rationale** — Claude's paragraph, with the cited `(track, preset)` references highlighted (rendered as `<TrackPresetCite>` chips).
  - **Save** / **Discard** buttons.
- **Save** → `POST /api/generation-presets` with `{name, description, generation, stems?}`. Persists to `generation_presets.json`. On 200 the card collapses into a "saved" state with a "Go to preset" link.
- **Discard** → card just dismisses; nothing persisted.
- Closing the modal discards any un-saved drafts (no draft persistence in v1).

## Data flow / identifiers

The four-tuple `(track_id, beatmap_id, preset_name, stem)` is what every layer hangs off:

- **Subsystem A** writes the tuple into `song.ini` so Unity can read it without parsing the chart.
- **Subsystem B** files feedback under `(track_id, beatmap_id)` and stores the user identity (`author = session.username`).
- **Subsystem C** aggregates feedback by `stem`, filtering presets by the `stems` field (or no field = universal). The aggregation joins `(track_id → track_name)` and `(beatmap_id → preset_name)` so Claude sees human-readable context, not opaque IDs.

When a beatmap is deleted (`delete_beatmap_record`), the whole beatmap folder is `shutil.rmtree`'d — its `feedback.jsonl` is removed along with it. This is intentional: feedback referring to a chart that no longer exists is misleading.

## Testing

**Backend:**
- `test_write_chart_song_ini.py` — extend with cases for `beatmaps=None` (unchanged behavior), `beatmaps=[one]`, `beatmaps=[two]`, special chars in name + preset (escaping), inactive beatmap, missing optional fields.
- `test_feedback_crud.py` — happy-path POST/GET/PUT/DELETE; auth rules (anon → 401, non-author PUT → 403, admin DELETE on someone else's note → 200, non-admin DELETE on someone else's → 403); schema validation (missing rating, unknown tag, both tags and text empty → 422); concurrent appends don't interleave (spawn N threads, all notes land).
- `test_feedback_aggregate.py` — multi-track scan; stem filter respects the preset's `stems` field; preset with no `stems` field counts as universal and appears in every stem's aggregate.
- `test_preset_proposer.py` — mock the Anthropic client; verify prompt structure includes engine catalog, current presets, and feedback bundle; parse a known-good response; reject invalid JSON; reject schema-invalid candidates while passing valid ones in the same response.

**Frontend** (smoke-level, following existing patterns):
- `FeedbackPanel.test.tsx` — renders existing notes, form submit calls the right endpoint, edit/delete only visible to author.
- `ProposalReviewModal.test.tsx` — renders N proposals, Save calls the preset endpoint with the right payload, Discard dismisses.

## Open questions / decisions log

| Topic | Decision |
|---|---|
| Scope decomposition | One combined design covering A + B + C (user choice) |
| Where Claude runs | In-app Anthropic API call, server-side |
| Feedback shape | Tags + rating + free-form text |
| Trigger location | Per-stem button on a new admin-only Generation Presets page |
| Review flow | Modal with N drafts + rationale; user picks which to save (no auto-save) |
| Default model | `claude-sonnet-4-6` (env override to `claude-opus-4-7`) |
| Feedback visibility | All notes visible to all logged-in users |
| Feedback edit/delete | Author-only edit; author-or-admin delete |
| Tag vocabulary | Fixed in code; deploy to add tags |
| Iteration tracking | None; every call sends the full corpus (caching makes it cheap) |
| Streaming | No — synchronous wait-for-completion |

## Out of scope (v1)

- Streaming Claude responses to the modal.
- Rate limiting / cost dashboard for the Anthropic endpoint.
- Notifications for new feedback or new proposals.
- Edit history on feedback (PUT overwrites; no audit log).
- Per-user "private" feedback.
- "Apply this preset to all my tracks" bulk-generate flow.
- Surfacing feedback aggregates in the UI (the user only sees per-chart notes; aggregation is a backend concern).
- Unity-side parsing of `[beatmap_N]` blocks — separate Jamsesh game ticket.
- Allowing the user to edit the proposal's `generation` block in-modal — save first, then edit in the regular preset editor.
- Cross-stem proposals — every proposal call is scoped to a single stem.
