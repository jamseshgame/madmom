import {
  presetToGeneration,
  type GenerationPreset,
  type GenerationState,
  type QueuedGeneration,
} from './generationTypes'

/**
 * Turn the user's preset picks into a concrete batch queue.
 *
 * Empty string ('Custom') in `activePresets` carries the live engine-cards
 * state through verbatim. Every other entry is looked up against the server's
 * current preset list — re-fetching guards against the case where the user
 * deleted a preset in another tab between opening the modal and clicking
 * Generate. Throws if a named pick no longer resolves.
 *
 * Skips the network call entirely when the queue is Custom-only.
 */
export async function materializeQueue(
  activePresets: string[],
  generation: GenerationState,
  stem: string,
): Promise<QueuedGeneration[]> {
  if (activePresets.length === 0) return []

  const needsLookup = activePresets.some((n) => n !== '')
  let presetsList: GenerationPreset[] = []
  if (needsLookup) {
    const r = await fetch(`/api/generation-presets?stem=${encodeURIComponent(stem)}`)
    if (!r.ok) throw new Error(`Failed to load presets (${r.status})`)
    presetsList = (await r.json()) as GenerationPreset[]
  }

  const queue: QueuedGeneration[] = []
  for (const name of activePresets) {
    if (name === '') {
      queue.push({ preset: '', generation })
    } else {
      const p = presetsList.find((x) => x.name === name)
      if (!p) throw new Error(`Preset "${name}" no longer exists`)
      queue.push({ preset: name, generation: presetToGeneration(p) })
    }
  }
  return queue
}
