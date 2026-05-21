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
