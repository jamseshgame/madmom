import { GENERATION_DEFAULTS, type GenerationState } from './generationTypes'

export const STORAGE_KEY = 'stem-result-generation-v1'

interface StoredShape {
  generation: GenerationState
  // Multi-select picker: empty string means "Custom" (use the live `generation`
  // state). Empty array means nothing picked yet — the UI treats that as "fall
  // back to v1 once presets load".
  activePresets: string[]
}

const DEFAULT_PRESETS: string[] = ['v1']

export function loadStoredGeneration(): StoredShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { generation: structuredClone(GENERATION_DEFAULTS), activePresets: [...DEFAULT_PRESETS] }
    }
    const parsed = JSON.parse(raw) as Partial<StoredShape> & { activePreset?: unknown }
    const generation = structuredClone(GENERATION_DEFAULTS)
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
    let activePresets: string[]
    if (Array.isArray(parsed.activePresets)) {
      activePresets = parsed.activePresets.filter((x): x is string => typeof x === 'string')
    } else if (typeof parsed.activePreset === 'string') {
      activePresets = [parsed.activePreset]
    } else {
      activePresets = [...DEFAULT_PRESETS]
    }
    return { generation, activePresets }
  } catch {
    return { generation: structuredClone(GENERATION_DEFAULTS), activePresets: [...DEFAULT_PRESETS] }
  }
}

export function saveStoredGeneration(generation: GenerationState, activePresets: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ generation, activePresets }))
  } catch {
    // Quota or disabled storage — silently drop, in-memory state stays valid.
  }
}
