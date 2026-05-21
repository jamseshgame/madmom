# Create-page preset cog — design

Date: 2026-05-21
Status: Draft

## Problem

The Tracks-page Generate Beatmap modal (shipped in `3be66ae1`, 2026-05-20) has a preset picker and per-stage engine/params editor that drives the V2 staged pipeline through `POST /api/tracks/{track_id}/generate-beatmap-v2`. The Create page (`StemResult.tsx`, shown after Demucs splits a track or after a manual stem upload) has no equivalent — its per-stem "Generate Beatmap with madmom" button calls the legacy single-shot `POST /api/beatmap/from-stem` endpoint, which has no preset/engine surface.

Users who want a non-default preset for a freshly converted track have to wait for the row to appear in the Studio Library and use the Tracks-page modal instead — friction in the most common authoring path.

## Goal

Add per-row preset/engine controls to `StemResult.tsx` that match the Tracks-page modal's V2 generation surface, so the Create-page flow can use V2 with any preset directly.

**Non-goals:**
- V2 support for the drums stem. The V2 endpoint rejects drums (`tracks.py:483`) and the V2 serializer emits guitar-style `[ExpertSingle]` sections (`pipeline/serialize.py:62`) — Clone Hero drum charts need `[ExpertDrums]` plus drum-aware note assignment. Tracked as a separate follow-up project.
- Backend changes. The V2 endpoint, presets API, and engines catalog all support the new flow as-is.
- Component tests for the new UI. The frontend has no React component test infrastructure; verification is manual.

## High-level design

Extract the V2 generation block out of `BeatmapPanel` in `TracksPage.tsx` into a new shared component, then use that component from both the Tracks-page modal and a new Create-page modal triggered by per-row cog buttons.

```
                   ┌──────────────────────────────┐
                   │  GenerationSettings.tsx      │
                   │  (shared)                    │
                   │  - presets list + activePreset│
                   │  - engines catalog            │
                   │  - per-stage engine + params  │
                   │  - Save-as / delete preset    │
                   └──────────┬───────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
   ┌──────────▼──────────┐         ┌──────────▼──────────┐
   │ TracksPage          │         │ StemResult          │
   │  BeatmapPanel modal │         │  cog → modal        │
   │  (existing)         │         │  (new)              │
   └─────────────────────┘         └─────────────────────┘
```

Drums row keeps its current legacy behavior. Vocals row is unchanged (it has its own `VocalmapButtons` cog for torchcrepe params).

## Component boundary

**New file:** `web/frontend/src/components/GenerationSettings.tsx`

**Owns** (controlled by props from parent):
- `presets: GenerationPreset[]` — loaded from `/api/generation-presets` on mount
- `engines: Record<string, EngineSpec[]> | null` — loaded from `/api/pipeline/engines` on mount
- Render of preset dropdown, Save-as button, delete-preset button, per-stage `<select>` + param editors

**Props:**

```ts
type StageSelection = { engine: string; params: Record<string, unknown> }
type GenerationState = Record<GenerationStage, StageSelection>

interface GenerationSettingsProps {
  generation: GenerationState
  activePreset: string
  onGenerationChange: (next: GenerationState) => void
  onActivePresetChange: (name: string) => void
}
```

The parent (`BeatmapPanel` or new `StemResult` modal) keeps the canonical `generation` + `activePreset` state and forwards updates received from `GenerationSettings`. This keeps persistence policy (localStorage on Create page, none on Tracks page) and submission policy (which endpoint, which song.ini fields) in the parent — `GenerationSettings` itself is a presentation component with two narrow side effects (fetching the presets list and the engines catalog).

**Refactor target inside `BeatmapPanel` (`TracksPage.tsx`):**
- `presets`, `activePreset`, `presetSaving`, `presetError`, `engines`, `generation` state moves into `GenerationSettings`
- The `refreshPresets`, `applyPreset`, `markCustom`, `savePresetAs`, `deleteActivePreset` callbacks move into `GenerationSettings`
- `BeatmapPanel` retains: `generation` + `activePreset` as controlled state (so it can forward to `formData` in `handleGenerate`), and renders `<GenerationSettings>` in place of the inlined ~200-line block

## Create-page modal

**New file:** `web/frontend/src/components/StemGenerationModal.tsx`

A thin modal that wraps `<GenerationSettings>` plus a footer with Cancel/Generate buttons. Owns the modal-local concerns (open/close, focus trap, error banner) but delegates settings UI to `GenerationSettings`.

**Props:**

```ts
interface StemGenerationModalProps {
  trackId: string
  stem: string              // 'bass' | 'guitar' | 'other' | ... (never 'drums' or 'vocals')
  songIni: Record<string, unknown>   // mirrors the Create page's existing songIni state
  generation: GenerationState
  activePreset: string
  onGenerationChange: (next: GenerationState) => void
  onActivePresetChange: (name: string) => void
  onClose: () => void
  onGenerated: (jobId: string) => void  // parent opens StemBeatmapTracker for SSE
}
```

On Generate click, the modal:
1. Builds a `FormData` matching `/api/tracks/{trackId}/generate-beatmap-v2`'s form signature
2. Appends each stage's engine + params (`onsets_engine`, `onsets_params`, ..., `playability_engine`, `playability_params`)
3. Appends song.ini fields from `songIni`
4. Appends `preset` if `activePreset` is non-empty
5. POSTs, reads `{job_id}`, calls `onGenerated(job_id)`, closes itself

## Persistence

Create-page `generation` and `activePreset` persist to `localStorage` under a single key:

```
key:    'stem-result-generation-v1'
value:  JSON.stringify({ generation, activePreset })
```

Load on mount; write after every update. Shared across all non-drums stems on the page (per Section 2 of the brainstorm — same recipe applied to all stems by default). Tracks page does NOT persist — its existing behavior of defaulting to v1 on modal open is preserved.

If the stored `activePreset` no longer exists in the loaded presets list, fall back to `activePreset = 'v1'` and reset `generation` to v1's settings — same recovery the Tracks modal does today.

## Main-button behavior

Existing `generateBeatmap(stem)` in `StemResult.tsx:428` branches by stem:

```ts
if (stem === 'drums') {
  // legacy POST /api/beatmap/from-stem  (unchanged)
} else {
  // V2 POST /api/tracks/{trackId}/generate-beatmap-v2
  //   with current generation/activePreset/songIni
}
```

A small badge below the main button shows the active preset name when non-default:

```
Generate Beatmap with madmom 0.17.dev0
                preset: v3 — legacy global bins
```

Badge styling matches the existing model badge convention (`BEATMAP_MODEL_BADGE` map at `StemResult.tsx:57-61`).

## Stem row layout

Cog button (24×24 px, gear icon) sits to the right of the green Generate button, same visual treatment as the existing Vocals cog from `VocalmapButtons`. Click → opens `StemGenerationModal` with that stem's context. No cog on `drums` or `song` rows.

The existing "Generate beatmap for selected stems" batch button at the bottom of the card uses the same shared `generation`/`activePreset` for every selected non-drums stem.

## Edge cases

| Scenario | Behavior |
|---|---|
| `metadata.track_id` is empty (defensive — shouldn't happen post-conversion) | Cog disabled with tooltip "Track not registered yet"; main button falls back to legacy. |
| Stored preset name no longer exists in `/api/generation-presets` | Silent fall-back to `v1`, localStorage rewritten with `v1`. |
| `/api/pipeline/engines` still loading on cog click | Modal opens; engine selectors show loading state; Generate button disabled until catalog resolves. |
| `/api/generation-presets` fetch fails | Modal renders; preset dropdown shows "Couldn't load presets"; engine/param controls still work with defaults; Generate stays enabled (V2 backend applies its own defaults). |
| Backend `/generate-beatmap-v2` returns 4xx | Inline error banner inside the modal; no SSE opened; user can edit and retry. |
| Save-as duplicate name / write error | Inline `presetError` banner at the top of the modal — same UX as Tracks-page modal. |
| User deletes the active preset | `activePreset` becomes `''` (Custom), badge disappears, localStorage updated. |
| `localStorage.setItem` quota exceeded | Caught silently, generation proceeds with in-memory state. Mirrors `VocalmapButtons.tsx:170`. |

## Backend changes

**None.** This is entirely a frontend feature. The V2 endpoint, presets CRUD, and engines catalog all support the new flow as-is.

## Testing

- **Backend:** no changes → no new tests. `tests/test_generate_beatmap_v2.py` already covers the V2 endpoint surface.
- **Frontend:** no React component test infrastructure exists. Manual smoke checklist:
  - [ ] Create page loads after Demucs job; cog appears on Bass/Guitar/Other rows; no cog on Drums or Vocals.
  - [ ] Clicking cog opens modal with preset dropdown defaulted to v1 (first time) or last-used (subsequent loads).
  - [ ] Editing engine/params drops dropdown to "Custom"; Save-as creates a new preset visible in the dropdown.
  - [ ] Generating from the modal closes the modal and shows progress in the row via the existing `StemBeatmapTracker`.
  - [ ] Clicking the main green button (cog not opened) fires V2 with the persisted preset.
  - [ ] Preset badge appears under the main button when a non-default preset is active.
  - [ ] Drums row's main button still hits `/api/beatmap/from-stem` (legacy path).
  - [ ] Tracks page modal still works identically (preset picker, Save-as, Generate, badge).
  - [ ] Page reload preserves the chosen preset on the Create page.
  - [ ] Generation fails gracefully when offline (error banner, no console explosion).

## Deploy footprint

Frontend-only build: `cd /opt/madmom && git pull --ff-only && cd web/frontend && npm run build`. No backend restart needed. nginx picks up the new bundle.

## Open follow-ups

- **V2 pipeline drum support** — separate project. Needs serializer changes (`[ExpertDrums]` section + drum lane assignment), endpoint guard removal, and ideally a drum-classification engine. Tracked outside this spec.
- **Per-stem preset divergence** — not in scope. If users ask for different presets per stem on the same track later, the current shared-state model can be extended to `Record<stem, GenerationState>` without API changes.
