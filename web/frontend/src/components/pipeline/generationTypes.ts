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
