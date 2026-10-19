// V2 pipeline stages exposed in the Generate Beatmap modal. Each maps to a
// per-stage dropdown of engines (fetched from /api/pipeline/engines) plus the
// engine-specific numeric/boolean/enum knobs rendered via <ParamControl>.
// `grid` is track-level (shared by every stem) — the orchestrator activates
// or computes the version made by the chosen engine before the stem stages
// run. `difficulty` picks the Hard/Medium/Easy reduction engine.
export type GenerationStage =
  | 'grid' | 'onsets' | 'pitches' | 'quantized' | 'lanes_expert' | 'lanes_filtered' | 'difficulty'

export const GENERATION_STAGE_LABELS: Record<GenerationStage, string> = {
  grid: 'Tempo grid (track-level)',
  onsets: 'Onset detection',
  pitches: 'Pitch detection',
  quantized: 'Quantization',
  lanes_expert: 'Lane mapping',
  lanes_filtered: 'Playability filter',
  difficulty: 'Difficulty reduction',
}

// Form-field prefix each stage uses on POST /generate-beatmap-v2
// (`<prefix>_engine` / `<prefix>_params`).
export const GENERATION_STAGE_FIELD_PREFIX: Record<GenerationStage, string> = {
  grid: 'grid',
  onsets: 'onsets',
  pitches: 'pitches',
  quantized: 'quantized',
  lanes_expert: 'lanes',
  lanes_filtered: 'playability',
  difficulty: 'difficulty',
}

export type StageSelection = { engine: string; params: Record<string, unknown> }
export type GenerationState = Record<GenerationStage, StageSelection>

export const GENERATION_DEFAULTS: GenerationState = {
  // Empty grid engine = legacy behaviour (reuse active grid, else librosa-beat).
  grid: { engine: '', params: {} },
  onsets: { engine: 'librosa-onset', params: {} },
  pitches: { engine: 'yin', params: {} },
  quantized: { engine: 'metric-weighted', params: {} },
  lanes_expert: { engine: 'section-sliding', params: {} },
  lanes_filtered: { engine: 'identity', params: {} },
  difficulty: { engine: 'metric-weight', params: {} },
}

// A saved bundle of {engine, params} choices for each V2 stage. Built-in
// presets ship with the backend; user-saved ones live in
// <upload_dir>/generation_presets.json. The picker on the modal lists both.
export interface GenerationPreset {
  name: string
  description?: string
  builtin?: boolean
  // Optional stem allow-list. Omitted/undefined = universal (preset
  // appears for every stem). When set, the backend filters this preset
  // out of GET /api/generation-presets?stem=... responses whose stem
  // isn't in the list.
  stems?: string[]
  // Stages the preset doesn't mention fall back to GENERATION_DEFAULTS (older
  // presets pre-date the `grid` and `difficulty` keys).
  generation: Partial<GenerationState>
}

// Materialise a preset into a full GenerationState, deep-cloning over the
// defaults so callers can mutate the result without corrupting the source.
export function presetToGeneration(p: GenerationPreset): GenerationState {
  const next: GenerationState = structuredClone(GENERATION_DEFAULTS)
  for (const stage of Object.keys(GENERATION_STAGE_LABELS) as GenerationStage[]) {
    const s = p.generation[stage]
    if (s) next[stage] = { engine: s.engine, params: structuredClone(s.params) }
  }
  return next
}

// One queued generation: the preset name to record on the resulting beatmap
// (empty string for "Custom" — the user's live engine-cards settings) and
// the fully-materialised engine/param state to ship to the V2 endpoint.
export interface QueuedGeneration {
  preset: string
  generation: GenerationState
}
