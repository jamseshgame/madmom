# Create-page Preset Cog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-stem cog buttons + modal to `StemResult.tsx` so the Create-page generate flow can use V2 presets and engine settings (currently only available on the Tracks-page modal).

**Architecture:** Extract the V2 generation UI block out of `BeatmapPanel` in `TracksPage.tsx` into a shared `GenerationSettings` component. Reuse it from both the Tracks-page modal and a new Create-page modal triggered by cog buttons on Bass/Guitar/Other rows. Drums stays on the legacy single-shot endpoint. Preset choice persists across reloads via `localStorage`.

**Tech Stack:** React 18 + TypeScript + Vite + Tailwind. Vitest for pure-helper unit tests (existing infrastructure in `web/frontend/src/chart/slides.test.ts`). No React component test framework — UI verification is manual.

**Spec:** `docs/superpowers/specs/2026-05-21-stem-result-preset-cog-design.md`

---

## File Map

| Path | Action | Purpose |
|---|---|---|
| `web/frontend/src/components/pipeline/generationTypes.ts` | Create | `GenerationStage` type, `GENERATION_STAGE_LABELS`, `GENERATION_DEFAULTS`, `GenerationPreset` interface, `GenerationState` type alias |
| `web/frontend/src/components/pipeline/generationStorage.ts` | Create | `loadStoredGeneration()` / `saveStoredGeneration()` localStorage helpers |
| `web/frontend/src/components/pipeline/generationStorage.test.ts` | Create | Vitest tests for the storage helpers |
| `web/frontend/src/components/pipeline/GenerationSettings.tsx` | Create | Shared V2 generation UI: preset picker + Save-as/Delete + 5-stage editor |
| `web/frontend/src/components/StemGenerationModal.tsx` | Create | Create-page modal wrapping `<GenerationSettings>` + Generate footer; POSTs to `/api/tracks/{trackId}/generate-beatmap-v2` |
| `web/frontend/src/pages/TracksPage.tsx` | Modify | Remove duplicated V2 state + JSX, import + render `<GenerationSettings>` |
| `web/frontend/src/components/StemResult.tsx` | Modify | Add cog buttons, modal trigger, persistence, main-button V2 routing, preset badge |

---

## Task 1: Extract generation types + constants into shared module

**Files:**
- Create: `web/frontend/src/components/pipeline/generationTypes.ts`
- Modify: `web/frontend/src/pages/TracksPage.tsx:1-115`

- [ ] **Step 1: Create the shared types module**

Create `web/frontend/src/components/pipeline/generationTypes.ts` with the exact contents below. These are lifted verbatim from `TracksPage.tsx:89-115` so behavior is unchanged.

```ts
// V2 pipeline stages exposed in the Generate Beatmap modal. Each maps to a
// per-stage dropdown of engines (fetched from /api/pipeline/engines) plus the
// engine-specific numeric/boolean/enum knobs rendered via <ParamControl>.
export type GenerationStage = 'onsets' | 'pitches' | 'quantized' | 'lanes_expert' | 'lanes_filtered'

export const GENERATION_STAGE_LABELS: Record<GenerationStage, string> = {
  onsets: 'Onset detection',
  pitches: 'Pitch detection',
  quantized: 'Quantization',
  lanes_expert: 'Lane mapping',
  lanes_filtered: 'Playability filter',
}

export type StageSelection = { engine: string; params: Record<string, unknown> }
export type GenerationState = Record<GenerationStage, StageSelection>

export const GENERATION_DEFAULTS: GenerationState = {
  onsets: { engine: 'librosa-onset', params: {} },
  pitches: { engine: 'yin', params: {} },
  quantized: { engine: 'metric-weighted', params: {} },
  lanes_expert: { engine: 'section-sliding', params: {} },
  lanes_filtered: { engine: 'identity', params: {} },
}

// A saved bundle of {engine, params} choices for each V2 stage. Built-in
// presets ship with the backend; user-saved ones live in
// <upload_dir>/generation_presets.json. The picker on the modal lists both.
export interface GenerationPreset {
  name: string
  description?: string
  builtin?: boolean
  generation: GenerationState
}
```

- [ ] **Step 2: Update `TracksPage.tsx` imports**

Remove lines 86-115 (the V2 types/constants block) and add this import near the top of the file (alongside other component imports):

```ts
import {
  GENERATION_DEFAULTS,
  GENERATION_STAGE_LABELS,
  type GenerationPreset,
  type GenerationStage,
  type GenerationState,
} from '../components/pipeline/generationTypes'
```

Replace the inline `Record<GenerationStage, { engine: string; params: Record<string, unknown> }>` annotation on line 143 (the `useState<...>(GENERATION_DEFAULTS)` line) with `GenerationState`. Replace the same shape on line 114 (inside `GenerationPreset.generation`) — already done by the import.

- [ ] **Step 3: Build to catch TS errors**

```
cd web/frontend && npx vite build 2>&1 | tail -10
```

Expected: `✓ built in <N>s`. No TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add web/frontend/src/components/pipeline/generationTypes.ts web/frontend/src/pages/TracksPage.tsx
git commit -m "refactor(pipeline): hoist V2 generation types + constants into shared module

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add localStorage helpers with vitest tests (TDD)

**Files:**
- Create: `web/frontend/src/components/pipeline/generationStorage.ts`
- Create: `web/frontend/src/components/pipeline/generationStorage.test.ts`

- [ ] **Step 1: Write failing tests first**

Create `web/frontend/src/components/pipeline/generationStorage.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { loadStoredGeneration, saveStoredGeneration, STORAGE_KEY } from './generationStorage'
import { GENERATION_DEFAULTS } from './generationTypes'

describe('generationStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns defaults when no entry stored', () => {
    const { generation, activePreset } = loadStoredGeneration()
    expect(generation).toEqual(GENERATION_DEFAULTS)
    expect(activePreset).toBe('v1')
  })

  it('round-trips a stored value', () => {
    const custom = {
      ...GENERATION_DEFAULTS,
      onsets: { engine: 'aubio-onset', params: { threshold: 0.4 } },
    }
    saveStoredGeneration(custom, 'v4 — chord-heavy')
    const out = loadStoredGeneration()
    expect(out.generation).toEqual(custom)
    expect(out.activePreset).toBe('v4 — chord-heavy')
  })

  it('falls back to defaults when stored JSON is malformed', () => {
    localStorage.setItem(STORAGE_KEY, '{not json')
    const { generation, activePreset } = loadStoredGeneration()
    expect(generation).toEqual(GENERATION_DEFAULTS)
    expect(activePreset).toBe('v1')
  })

  it('falls back to defaults when stored value is missing keys', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ generation: { onsets: { engine: 'aubio-onset', params: {} } } }))
    const { generation, activePreset } = loadStoredGeneration()
    // Missing stages get filled with defaults so the UI doesn't crash on
    // partial state shipped from an older version of the app.
    expect(generation.pitches).toEqual(GENERATION_DEFAULTS.pitches)
    expect(generation.lanes_expert).toEqual(GENERATION_DEFAULTS.lanes_expert)
    expect(generation.onsets).toEqual({ engine: 'aubio-onset', params: {} })
    expect(activePreset).toBe('v1')
  })

  it('save followed by clear-and-reload returns defaults', () => {
    saveStoredGeneration(GENERATION_DEFAULTS, 'v1')
    localStorage.clear()
    const { generation, activePreset } = loadStoredGeneration()
    expect(generation).toEqual(GENERATION_DEFAULTS)
    expect(activePreset).toBe('v1')
  })

  it('saveStoredGeneration tolerates localStorage quota errors silently', () => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    try {
      expect(() => saveStoredGeneration(GENERATION_DEFAULTS, 'v1')).not.toThrow()
    } finally {
      Storage.prototype.setItem = original
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```
cd web/frontend && npx vitest run pipeline/generationStorage.test.ts 2>&1 | tail -20
```

Expected: FAIL with module-not-found for `./generationStorage`.

If vitest is not installed locally, install it first:

```
cd web/frontend && npm install
```

- [ ] **Step 3: Write the implementation**

Create `web/frontend/src/components/pipeline/generationStorage.ts`:

```ts
import { GENERATION_DEFAULTS, type GenerationState } from './generationTypes'

export const STORAGE_KEY = 'stem-result-generation-v1'

interface StoredShape {
  generation: GenerationState
  activePreset: string
}

const DEFAULT_PRESET = 'v1'

export function loadStoredGeneration(): StoredShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { generation: structuredClone(GENERATION_DEFAULTS), activePreset: DEFAULT_PRESET }
    }
    const parsed = JSON.parse(raw) as Partial<StoredShape>
    // Merge stored stages over defaults so a partial shape from an older
    // version of the app still produces a valid state object.
    const generation = { ...structuredClone(GENERATION_DEFAULTS) }
    if (parsed.generation && typeof parsed.generation === 'object') {
      for (const stage of Object.keys(generation) as (keyof GenerationState)[]) {
        const stored = parsed.generation[stage]
        if (stored && typeof stored.engine === 'string') {
          generation[stage] = {
            engine: stored.engine,
            params: (stored.params && typeof stored.params === 'object') ? stored.params : {},
          }
        }
      }
    }
    const activePreset = (typeof parsed.activePreset === 'string') ? parsed.activePreset : DEFAULT_PRESET
    return { generation, activePreset }
  } catch {
    return { generation: structuredClone(GENERATION_DEFAULTS), activePreset: DEFAULT_PRESET }
  }
}

export function saveStoredGeneration(generation: GenerationState, activePreset: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ generation, activePreset }))
  } catch {
    // Quota or disabled storage — silently drop, in-memory state stays valid.
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd web/frontend && npx vitest run pipeline/generationStorage.test.ts 2>&1 | tail -20
```

Expected: 6 passing tests, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add web/frontend/src/components/pipeline/generationStorage.ts web/frontend/src/components/pipeline/generationStorage.test.ts
git commit -m "feat(pipeline): localStorage helpers for V2 generation state

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Extract GenerationSettings component

**Files:**
- Create: `web/frontend/src/components/pipeline/GenerationSettings.tsx`
- Modify: `web/frontend/src/pages/TracksPage.tsx:117-547` (remove V2 state/effects/actions/JSX from `BeatmapPanel`; replace JSX with `<GenerationSettings>`)

- [ ] **Step 1: Create `GenerationSettings.tsx`**

Create `web/frontend/src/components/pipeline/GenerationSettings.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react'
import { ParamControl } from './ParamControl'
import type { EngineSpec } from '../../api/pipelineClient'
import {
  GENERATION_DEFAULTS,
  GENERATION_STAGE_LABELS,
  type GenerationPreset,
  type GenerationStage,
  type GenerationState,
} from './generationTypes'

interface GenerationSettingsProps {
  generation: GenerationState
  activePreset: string
  onGenerationChange: (next: GenerationState) => void
  onActivePresetChange: (name: string) => void
}

export default function GenerationSettings({
  generation,
  activePreset,
  onGenerationChange,
  onActivePresetChange,
}: GenerationSettingsProps) {
  const [engines, setEngines] = useState<Record<string, EngineSpec[]> | null>(null)
  const [presets, setPresets] = useState<GenerationPreset[]>([])
  const [presetSaving, setPresetSaving] = useState(false)
  const [presetError, setPresetError] = useState('')

  // Load engine catalog; seed default params for any stage that's currently
  // empty {} so the displayed knobs match what the backend will use. Stages
  // with non-empty params (e.g. restored from localStorage) are left alone.
  useEffect(() => {
    fetch('/api/pipeline/engines')
      .then((r) => r.json())
      .then((catalog: Record<string, EngineSpec[]>) => {
        setEngines(catalog)
        const next: GenerationState = { ...generation }
        let dirty = false
        ;(Object.keys(next) as GenerationStage[]).forEach((stage) => {
          if (Object.keys(next[stage].params).length > 0) return
          const spec = catalog[stage]?.find((e) => e.engine_id === next[stage].engine)
          if (!spec) return
          const defaults: Record<string, unknown> = {}
          for (const [k, p] of Object.entries(spec.params_schema || {})) {
            if ('default' in p && p.default !== undefined) defaults[k] = p.default
          }
          if (Object.keys(defaults).length === 0) return
          next[stage] = { engine: next[stage].engine, params: defaults }
          dirty = true
        })
        if (dirty) onGenerationChange(next)
      })
      .catch(console.error)
    // Intentionally only on mount — re-firing on every generation change would
    // loop the seeding logic.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refreshPresets = useCallback(() => {
    fetch('/api/generation-presets')
      .then((r) => r.json())
      .then((list: GenerationPreset[]) => {
        setPresets(list)
        // First-time bootstrap: when no preset is selected, fall back to v1
        // so the dropdown isn't empty and the modal state matches the
        // label. Also covers the recovery case where the stored preset
        // was deleted by another session.
        if (!activePreset || !list.find((p) => p.name === activePreset)) {
          const v1 = list.find((p) => p.name === 'v1')
          if (v1) onActivePresetChange('v1')
        }
      })
      .catch(console.error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePreset])

  useEffect(() => { refreshPresets() }, [refreshPresets])

  const applyPreset = (name: string) => {
    onActivePresetChange(name)
    if (!name) return
    const p = presets.find((x) => x.name === name)
    if (!p) return
    // Deep-copy params so subsequent edits don't mutate the stored preset.
    const next: GenerationState = { ...structuredClone(GENERATION_DEFAULTS) }
    ;(Object.keys(GENERATION_STAGE_LABELS) as GenerationStage[]).forEach((stage) => {
      const s = p.generation[stage]
      if (s) next[stage] = { engine: s.engine, params: { ...s.params } }
    })
    onGenerationChange(next)
  }

  // Any manual edit to engine/params drops the picker into "Custom" so the
  // dropdown doesn't lie about what's running.
  const markCustom = () => { if (activePreset) onActivePresetChange('') }

  const savePresetAs = async () => {
    setPresetError('')
    const usedV = new Set(presets.filter((p) => /^v\d+/i.test(p.name)).map((p) => p.name))
    let suggestion = ''
    for (let i = 12; i < 200; i++) {
      const candidate = `v${i}`
      if (!usedV.has(candidate)) { suggestion = candidate; break }
    }
    const name = window.prompt('Save current settings as preset (name):', suggestion)
    if (!name) return
    setPresetSaving(true)
    try {
      const res = await fetch('/api/generation-presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), generation }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }
      onActivePresetChange(name.trim())
      refreshPresets()
    } catch (e) {
      setPresetError((e as Error).message)
    } finally {
      setPresetSaving(false)
    }
  }

  const deleteActivePreset = async () => {
    if (!activePreset) return
    const target = presets.find((p) => p.name === activePreset)
    if (!target || target.builtin) return
    if (!window.confirm(`Delete preset "${activePreset}"?`)) return
    try {
      const res = await fetch(`/api/generation-presets/${encodeURIComponent(activePreset)}`, { method: 'DELETE' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }
      onActivePresetChange('')
      refreshPresets()
    } catch (e) {
      setPresetError((e as Error).message)
    }
  }

  if (!engines) {
    return (
      <div className="text-xs text-gray-500 italic">Loading engine catalog…</div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Generation</h4>
        <div className="flex items-center gap-2">
          <select
            value={activePreset}
            onChange={(e) => applyPreset(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs"
            title="Apply a saved preset"
          >
            <option value="">Custom</option>
            {presets.map((p) => (
              <option key={p.name} value={p.name}>
                {p.builtin ? p.name : `★ ${p.name}`}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={savePresetAs}
            disabled={presetSaving}
            className="px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 rounded"
            title="Save current settings as a new preset"
          >
            Save as…
          </button>
          {activePreset && !presets.find((p) => p.name === activePreset)?.builtin && (
            <button
              type="button"
              onClick={deleteActivePreset}
              className="px-2 py-1 text-xs bg-red-900/40 hover:bg-red-800/60 border border-red-800 text-red-300 rounded"
              title={`Delete preset "${activePreset}"`}
            >
              Delete
            </button>
          )}
        </div>
      </div>
      {presetError && <div className="mb-2 text-xs text-red-400">{presetError}</div>}
      {activePreset && (
        <p className="text-[11px] text-gray-500 italic mb-2">
          {presets.find((p) => p.name === activePreset)?.description || ''}
        </p>
      )}
      <div className="space-y-3">
        {(Object.keys(GENERATION_STAGE_LABELS) as GenerationStage[]).map((stage) => {
          const stageEngines = engines[stage] || []
          const selected = generation[stage]
          const spec = stageEngines.find((e) => e.engine_id === selected.engine)
          return (
            <div key={stage} className="border border-gray-700 rounded-lg p-3 space-y-2">
              <label className="block text-xs">
                <span className="text-gray-500">{GENERATION_STAGE_LABELS[stage]}</span>
                <select
                  value={selected.engine}
                  onChange={(e) => {
                    markCustom()
                    const nextEngineId = e.target.value
                    const nextSpec = stageEngines.find((s) => s.engine_id === nextEngineId)
                    const nextParams: Record<string, unknown> = {}
                    for (const [k, p] of Object.entries(nextSpec?.params_schema || {})) {
                      if ('default' in p && p.default !== undefined) nextParams[k] = p.default
                    }
                    onGenerationChange({
                      ...generation,
                      [stage]: { engine: nextEngineId, params: nextParams },
                    })
                  }}
                  className="ml-2 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm"
                >
                  {stageEngines.map((s) => (
                    <option key={s.engine_id} value={s.engine_id}>{s.display_name}</option>
                  ))}
                </select>
              </label>
              {spec && Object.keys(spec.params_schema || {}).length > 0 && (
                <div className="pl-3 border-l border-gray-700 space-y-2">
                  {Object.entries(spec.params_schema).map(([key, pspec]) => (
                    <ParamControl
                      key={key}
                      keyName={key}
                      spec={pspec}
                      value={selected.params[key]}
                      onChange={(v) => {
                        markCustom()
                        onGenerationChange({
                          ...generation,
                          [stage]: { ...generation[stage], params: { ...generation[stage].params, [key]: v } },
                        })
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Refactor `BeatmapPanel` in `TracksPage.tsx`**

In `TracksPage.tsx`:

(a) Add the import near the existing component imports:

```ts
import GenerationSettings from '../components/pipeline/GenerationSettings'
```

(b) In `BeatmapPanel`, **delete** the following state/effects/actions (currently at approximate line ranges shown):
- `engines` state at line 142
- `presets`, `activePreset`, `presetSaving`, `presetError` state at lines 148-151
- The engines-fetching `useEffect` at lines 177-197
- `refreshPresets` at lines 199-211
- The `useEffect(() => { refreshPresets() }, ...)` at line 213
- `applyPreset` at lines 215-227
- `markCustom` at line 231
- `savePresetAs` at lines 233-262
- `deleteActivePreset` at lines 264-282

(c) **Keep** the `generation` + `activePreset` state in `BeatmapPanel` — they're still needed for `handleGenerate`'s FormData construction. Replace the inline annotation on the `useState` calls with:

```ts
const [generation, setGeneration] = useState<GenerationState>(GENERATION_DEFAULTS)
const [activePreset, setActivePreset] = useState<string>('')
```

(d) Replace the V2 block JSX (`TracksPage.tsx:447-547`, the whole `idx === 0 && stem !== 'drums' && engines && (...)` chunk) with:

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

(e) Remove now-unused imports from `TracksPage.tsx`: `ParamControl` (line 9), `EngineSpec` (line 10). They moved into `GenerationSettings`.

- [ ] **Step 3: Build to catch TS errors**

```
cd web/frontend && npx vite build 2>&1 | tail -10
```

Expected: `✓ built in <N>s`. No TypeScript errors.

- [ ] **Step 4: Manual smoke verify Tracks-page modal still works**

Run locally (`cd web/backend && venv/Scripts/python.exe run.py` for backend; `cd web/frontend && npm run dev` for frontend) and:

1. Open `/tracks` page in browser
2. Click a track with stems → click Generate Beatmap for Bass/Guitar/Other
3. Confirm: preset dropdown shows v1 selected, presets list populated, all 5 stage editors render
4. Switch to v3 → confirm engine selects update, dropdown shows v3
5. Edit any engine → dropdown switches to "Custom"
6. Click Save as… → enter name → confirm new preset appears
7. Click Delete on the saved preset → confirm dropdown empties to Custom
8. Click Generate → confirm progress runs, completes, beatmap appears under the stem
9. Open the modal again for Drums → confirm Generation section is hidden (the `stem !== 'drums'` gate)

Mark all 9 verified before continuing.

- [ ] **Step 5: Commit**

```bash
git add web/frontend/src/components/pipeline/GenerationSettings.tsx web/frontend/src/pages/TracksPage.tsx
git commit -m "refactor(tracks): extract GenerationSettings shared component from BeatmapPanel

Pulls the V2 preset picker + per-stage engine/params editor out of the
inlined BeatmapPanel block so it can be reused by the Create page's
StemResult cog modal in a follow-up commit. Behavior unchanged on the
Tracks page.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Create `StemGenerationModal` component

**Files:**
- Create: `web/frontend/src/components/StemGenerationModal.tsx`

- [ ] **Step 1: Create the modal component**

Create `web/frontend/src/components/StemGenerationModal.tsx`:

```tsx
import { useState } from 'react'
import GenerationSettings from './pipeline/GenerationSettings'
import {
  GENERATION_STAGE_LABELS,
  type GenerationStage,
  type GenerationState,
} from './pipeline/generationTypes'

const STEM_COLORS: Record<string, string> = {
  bass: 'text-green-400',
  rhythm: 'text-green-400',
  guitar: 'text-orange-400',
  piano: 'text-violet-400',
  other: 'text-blue-400',
}

const STEM_LABELS: Record<string, string> = {
  bass: 'Bass',
  rhythm: 'Bass',
  guitar: 'Guitar',
  piano: 'Piano',
  other: 'Other',
}

interface StemGenerationModalProps {
  trackId: string
  stem: string
  songIni: Record<string, unknown>
  generation: GenerationState
  activePreset: string
  onGenerationChange: (next: GenerationState) => void
  onActivePresetChange: (name: string) => void
  onClose: () => void
  onGenerated: (jobId: string) => void
}

export default function StemGenerationModal({
  trackId, stem, songIni,
  generation, activePreset,
  onGenerationChange, onActivePresetChange,
  onClose, onGenerated,
}: StemGenerationModalProps) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleGenerate = async () => {
    setSubmitting(true)
    setError('')
    try {
      const formData = new FormData()
      formData.append('stem', stem)
      for (const [key, val] of Object.entries(songIni)) {
        formData.append(key, String(val ?? ''))
      }
      for (const stage of Object.keys(GENERATION_STAGE_LABELS) as GenerationStage[]) {
        const sel = generation[stage]
        const fieldPrefix =
          stage === 'lanes_expert' ? 'lanes' :
          stage === 'lanes_filtered' ? 'playability' :
          stage
        formData.append(`${fieldPrefix}_engine`, sel.engine)
        formData.append(`${fieldPrefix}_params`, JSON.stringify(sel.params))
      }
      if (activePreset) formData.append('preset', activePreset)

      const res = await fetch(`/api/tracks/${trackId}/generate-beatmap-v2`, {
        method: 'POST',
        body: formData,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }
      const { job_id } = await res.json()
      onGenerated(job_id)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-start justify-center overflow-y-auto py-8">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl mx-4">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h3 className="text-lg font-semibold">
            Generate Beatmap — <span className={STEM_COLORS[stem] || 'text-gray-300'}>{STEM_LABELS[stem] || stem}</span>
          </h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">&times;</button>
        </div>

        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          <GenerationSettings
            generation={generation}
            activePreset={activePreset}
            onGenerationChange={onGenerationChange}
            onActivePresetChange={onActivePresetChange}
          />
        </div>

        <div className="p-5 border-t border-gray-800 flex flex-wrap items-center gap-2 justify-end">
          {error && <div className="mr-auto text-xs text-red-400 max-w-md truncate" title={error}>{error}</div>}
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 text-gray-200 rounded-lg text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={submitting}
            className="px-6 py-2 bg-jam-600 hover:bg-jam-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {submitting ? 'Starting…' : 'Generate'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Build to confirm TS compiles**

```
cd web/frontend && npx vite build 2>&1 | tail -10
```

Expected: `✓ built in <N>s`. No errors. (The new component isn't imported anywhere yet — Vite tree-shakes it out, but tsc-via-`npm run build` still verifies the types. Note: `npx vite build` skips tsc; do a manual review of the file for obvious type errors before continuing.)

- [ ] **Step 3: Commit**

```bash
git add web/frontend/src/components/StemGenerationModal.tsx
git commit -m "feat(create): StemGenerationModal — V2 generation modal for Create page

Thin modal wrapping GenerationSettings + Cancel/Generate footer. Not
yet wired into StemResult — that wiring comes next.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire cog + modal + localStorage persistence into `StemResult`

**Files:**
- Modify: `web/frontend/src/components/StemResult.tsx`

- [ ] **Step 1: Add imports + state in `StemResult`**

At the top of the file (alongside other component imports):

```ts
import StemGenerationModal from './StemGenerationModal'
import {
  GENERATION_DEFAULTS,
  type GenerationState,
} from './pipeline/generationTypes'
import { loadStoredGeneration, saveStoredGeneration } from './pipeline/generationStorage'
```

Inside the `StemResult` component body (alongside the existing `useState` calls — pick a spot near the top of the component for readability, ideally just after `selectedStems` state):

```ts
// Shared generation state for all non-drums stems on this page. Persisted
// to localStorage so the user's preset/engine choices survive reloads.
// Stays in sync with the cog modal: edits via the modal update this state
// and the next click of the green main button picks them up.
//
// useState lazy-init runs the loader twice on mount (once per useState),
// but JSON.parse on a tiny stored object is negligible.
const [generation, setGeneration] = useState<GenerationState>(() => loadStoredGeneration().generation)
const [activePreset, setActivePreset] = useState<string>(() => loadStoredGeneration().activePreset)
const [modalStem, setModalStem] = useState<string | null>(null)

useEffect(() => {
  saveStoredGeneration(generation, activePreset)
}, [generation, activePreset])
```

- [ ] **Step 2: Add the cog button next to the green main Generate button**

Find the per-stem render block in `StemResult.tsx` (currently around line 555-580 — the `stem !== 'vocals'` branch with the Generate Beatmap button). The existing JSX is:

```tsx
{stem !== 'vocals' && (
  <div className="flex items-stretch gap-1">
    {stem === 'song' ? (
      <a href={...} className="...">Download</a>
    ) : (
      !bm && (
        <button onClick={() => generateBeatmap(stem)} ...>
          {installedMadmom ? `Generate Beatmap with madmom ${installedMadmom}` : 'Generate Beatmap'}
        </button>
      )
    )}
  </div>
)}
```

Add a cog button immediately after the main `<button>` (inside the same `<div className="flex items-stretch gap-1">`), gated to non-drums + non-song stems:

```tsx
{!bm && stem !== 'song' && stem !== 'drums' && trackId && (
  <button
    type="button"
    onClick={() => setModalStem(stem)}
    className="px-2 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded text-xs transition-colors"
    title="Change preset / engine settings"
    aria-label={`Open generation settings for ${STEM_LABELS[stem] || stem}`}
  >
    {/* simple gear glyph; matches the visual weight of the existing vocalmap cog */}
    ⚙
  </button>
)}
```

- [ ] **Step 3: Mount the modal once at the bottom of `StemResult`'s root JSX**

Just before the closing `</div>` of the top-level `<div className="space-y-6">` (or wherever the component's root return ends — same place where `BeatmapStatsModal` is mounted at approximately line 1002-1010):

```tsx
{modalStem && trackId && (
  <StemGenerationModal
    trackId={trackId}
    stem={modalStem}
    songIni={songIni}
    generation={generation}
    activePreset={activePreset}
    onGenerationChange={setGeneration}
    onActivePresetChange={setActivePreset}
    onClose={() => setModalStem(null)}
    onGenerated={(beatmapJobId) => {
      // Capture modalStem inside the callback — TS doesn't narrow
      // through closure boundaries even though the surrounding
      // `modalStem && trackId &&` already proved it non-null.
      const stem = modalStem
      if (!stem) return
      setBeatmaps((prev) => ({
        ...prev,
        [stem]: { jobId: beatmapJobId, state: 'generating' },
      }))
    }}
  />
)}
```

The `setBeatmaps((prev) => ...)` line mirrors what the existing `generateBeatmap` already does at line 431 (which kicks off the `StemBeatmapTracker` SSE handler) — so the modal's generation flows through the same progress UI.

- [ ] **Step 4: Build + manual smoke**

```
cd web/frontend && npx vite build 2>&1 | tail -10
```

Then run locally (backend + `npm run dev`) and:

1. Trigger a Demucs split (or open a recent stem-result page)
2. Confirm cog appears on Bass/Guitar/Other rows; no cog on Drums or Vocals or song
3. Click cog → modal opens with v1 preset selected, all 5 stage editors visible
4. Switch preset to v3 → engine selects update → close modal
5. Reopen cog → confirm v3 is still selected (state preserved across open/close)
6. Hard reload page → reopen cog → confirm v3 is STILL selected (localStorage works)
7. Click Generate from inside the modal → modal closes, row shows generation progress, beatmap completes
8. Confirm the beatmap that completed used the V2 endpoint (network tab: `POST /api/tracks/{id}/generate-beatmap-v2`)

- [ ] **Step 5: Commit**

```bash
git add web/frontend/src/components/StemResult.tsx
git commit -m "feat(create): cog button + V2 generation modal on stem rows

Bass/Guitar/Other rows get a gear button next to Generate Beatmap.
Click opens StemGenerationModal with the shared GenerationSettings UI;
generating from the modal hits /api/tracks/{id}/generate-beatmap-v2
and progress streams through the existing StemBeatmapTracker.

Preset and engine choices persist across reloads via localStorage.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Route main button to V2 + add preset badge

**Files:**
- Modify: `web/frontend/src/components/StemResult.tsx` (function `generateBeatmap` around line 428; main button JSX around line 565-580)

- [ ] **Step 1: Branch `generateBeatmap` by stem**

Replace the existing `generateBeatmap` function (currently lines 428-449) with:

```ts
const generateBeatmap = async (stem: string) => {
  if (!lock.acquire(`beatmap:${stem}`)) return
  const label = STEM_LABELS[stem] || stem
  setBeatmaps((prev) => ({ ...prev, [stem]: { jobId: '', state: 'generating' } }))

  // Drums uses the legacy single-shot endpoint — V2 doesn't support drums
  // yet (separate follow-up project). Everything else gets the V2 staged
  // pipeline with whatever preset/engine settings the user has set on
  // this page (defaults to v1).
  const useV2 = stem !== 'drums' && !!trackId
  try {
    let res: Response
    if (useV2) {
      const formData = new FormData()
      formData.append('stem', stem)
      for (const [key, val] of Object.entries(songIni)) {
        formData.append(key, String(val ?? ''))
      }
      for (const stage of Object.keys(GENERATION_STAGE_LABELS) as GenerationStage[]) {
        const sel = generation[stage]
        const fieldPrefix =
          stage === 'lanes_expert' ? 'lanes' :
          stage === 'lanes_filtered' ? 'playability' :
          stage
        formData.append(`${fieldPrefix}_engine`, sel.engine)
        formData.append(`${fieldPrefix}_params`, JSON.stringify(sel.params))
      }
      if (activePreset) formData.append('preset', activePreset)
      res = await fetch(`/api/tracks/${trackId}/generate-beatmap-v2`, { method: 'POST', body: formData })
    } else {
      const formData = new FormData()
      formData.append('stem_job_id', jobId)
      formData.append('stem', stem)
      formData.append('title', `${trackName} (${label})`)
      res = await fetch('/api/beatmap/from-stem', { method: 'POST', body: formData })
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.detail || 'Failed to start beatmap generation')
    }
    const { job_id } = await res.json()
    setBeatmaps((prev) => ({ ...prev, [stem]: { jobId: job_id, state: 'generating' } }))
  } catch (e) {
    setBeatmaps((prev) => ({ ...prev, [stem]: { jobId: '', state: 'error' } }))
    setBatchError((e as Error).message)
    lock.release()
  }
}
```

Add the missing imports at the top of the file (next to the existing `pipeline/generationTypes` import added in Task 5):

```ts
import { GENERATION_STAGE_LABELS, type GenerationStage } from './pipeline/generationTypes'
```

(Adjust the existing import statement if it already exists — extend it to include `GENERATION_STAGE_LABELS` and `GenerationStage` instead of adding a second line.)

- [ ] **Step 2: Add preset badge under the main button**

In the stem row JSX, immediately after the closing `</button>` of the main Generate button (and within the same `<div className="flex flex-col gap-1.5">` actions column at approximately line 527), add:

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

Badge only renders when:
- The stem can use V2 (not vocals, drums, or song)
- No beatmap exists yet (`!bm`)
- A non-default preset is active (skip when v1 to reduce visual noise)

- [ ] **Step 3: Build + manual smoke**

```
cd web/frontend && npx vite build 2>&1 | tail -10
```

Then run locally and:

1. Open a fresh stem-result view
2. Confirm Drums row's Generate button still POSTs to `/api/beatmap/from-stem` (Network tab)
3. Confirm Bass/Guitar/Other rows' Generate button POSTs to `/api/tracks/{id}/generate-beatmap-v2`
4. Switch preset via cog to v3 → close modal → confirm badge "preset: v3 — legacy global bins" appears under each non-drums main button (or just "preset: v3 — legacy global bins" depending on stored name)
5. Switch preset back to v1 via cog → badge disappears
6. Generate beatmap with v3 preset from main button → confirm progress runs, beatmap completes
7. Verify Tracks page modal STILL works identically (no regression — Tracks-page state is independent of localStorage)

- [ ] **Step 4: Commit**

```bash
git add web/frontend/src/components/StemResult.tsx
git commit -m "feat(create): main Generate button routes to V2 for non-drums + preset badge

Bass/Guitar/Other rows now use the V2 staged pipeline with the
persisted preset/engine settings whenever the user clicks the green
Generate Beatmap button. Drums stays on the legacy single-shot
endpoint. A small badge under the button names the active preset
when non-default.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Deploy + final smoke

**Files:** none

- [ ] **Step 1: Push to remote**

```bash
git push origin main
```

- [ ] **Step 2: Deploy (frontend-only)**

```
ssh beatmap 'cd /opt/madmom && git pull --ff-only && cd web/frontend && npm run build'
```

Expected: `✓ built in <N>s`. No need to restart the backend.

- [ ] **Step 3: Verify asset hash changed**

```
curl -s https://beatmap.jamsesh.co/ | grep -oE 'index-[A-Za-z0-9]+\.js'
```

Confirm the printed hash matches the latest `dist/assets/index-*.js` from the SSH build output.

- [ ] **Step 4: Manual checklist on prod**

Log into `https://beatmap.jamsesh.co/`, navigate to a recently converted track, and verify all of:

- [ ] Bass/Guitar/Other rows show a ⚙ cog next to Generate Beatmap; Drums shows none.
- [ ] Cog click opens modal; preset dropdown defaults to v1 (or the last-used).
- [ ] Switching preset persists across page reload.
- [ ] Modal Generate completes a beatmap.
- [ ] Main green button generates with the active preset (Network tab confirms V2 endpoint).
- [ ] Drums main button still hits legacy `/api/beatmap/from-stem`.
- [ ] Preset badge appears below the main button when non-v1 preset selected; disappears for v1.
- [ ] Tracks-page Generate Beatmap modal still works the same as before.
- [ ] Save-as preset works; Delete preset works; "Custom" appears after editing engine/params.

---

## Spec self-review (after writing this plan)

**Spec coverage:**
- Component boundary (`GenerationSettings` + `StemGenerationModal`) → Tasks 3, 4
- Persistence to `stem-result-generation-v1` localStorage key → Tasks 2, 5
- Main button V2 routing for non-drums + drums-stays-legacy → Task 6
- Preset badge under main button when non-default → Task 6
- Recovery from missing preset → Task 3 (`refreshPresets` falls back to v1)
- Engine catalog seeding skips non-empty params → Task 3 (`GenerationSettings` useEffect)
- Tracks page modal still works identically → Task 3 Step 4 manual smoke
- No backend changes → confirmed in spec; no backend tasks present
- Deploy procedure → Task 7

**Placeholders:** none — every code block has full content; every command is executable.

**Type consistency:** `GenerationState`, `GenerationStage`, `GenerationPreset`, `StageSelection` defined once in Task 1's `generationTypes.ts`; all subsequent tasks import them. `STORAGE_KEY` exported from `generationStorage.ts` (Task 2) for the test file. `StemGenerationModalProps` interface in Task 4 matches the call site in Task 5.
