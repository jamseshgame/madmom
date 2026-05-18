// Typed client for /api/pipeline/* endpoints. Mirrors lyricsClient pattern.

export type StageId =
  | 'grid' | 'onsets' | 'pitches' | 'quantized'
  | 'lanes_expert' | 'lanes_filtered'
  | 'lanes_hard' | 'lanes_medium' | 'lanes_easy'

export interface EngineSpec {
  engine_id: string
  display_name: string
  params_schema: Record<string, ParamSpec>
}

export type ParamSpec =
  | { type: 'number', min?: number, max?: number, step?: number, default?: number, label?: string }
  | { type: 'boolean', default?: boolean, label?: string }
  | { type: 'enum', options: (string | number)[], default?: string | number, label?: string }
  | { type: 'range', min: number, max: number, step?: number, default?: [number, number], label?: string }

export interface StageStateDto {
  active_version: string | null
  engine: string | null
  stale: boolean
}

export interface StemStateDto {
  onsets: StageStateDto
  pitches: StageStateDto
  quantized: StageStateDto
  lanes_expert: StageStateDto
  lanes_filtered: StageStateDto
  lanes_hard: StageStateDto
  lanes_medium: StageStateDto
  lanes_easy: StageStateDto
  last_chart_built_at: string | null
}

export interface PipelineStateDto {
  schema_version: number
  grid: StageStateDto | null
  stems: Record<string, StemStateDto>
}

export interface VersionEntry {
  filename: string
  engine: string
  params: Record<string, unknown>
  created_at: string
  starred: boolean
  active: boolean
}

const BASE = '/api/pipeline'

function qs(trackId: string, stem?: string | null): string {
  const p = new URLSearchParams({ track_id: trackId })
  if (stem) p.set('stem', stem)
  return `?${p.toString()}`
}

export async function fetchEnginesCatalog(): Promise<Record<StageId, EngineSpec[]>> {
  const r = await fetch(`${BASE}/engines`)
  if (!r.ok) throw new Error(`engines catalog: ${r.status}`)
  return r.json()
}

export async function fetchPipelineState(trackId: string): Promise<PipelineStateDto> {
  const r = await fetch(`${BASE}/state${qs(trackId)}`)
  if (!r.ok) throw new Error(`pipeline state: ${r.status}`)
  return r.json()
}

export async function fetchStems(trackId: string): Promise<Array<{ name: string, audio_path: string | null, has_v2_pipeline_state: boolean }>> {
  const r = await fetch(`${BASE}/stems${qs(trackId)}`)
  if (!r.ok) throw new Error(`stems: ${r.status}`)
  return r.json()
}

export async function fetchStageActive(stage: StageId, trackId: string, stem: string | null): Promise<unknown | null> {
  const r = await fetch(`${BASE}/${stage}${qs(trackId, stem)}`)
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`stage ${stage}: ${r.status}`)
  return r.json()
}

export async function runStage(
  stage: StageId,
  trackId: string,
  stem: string | null,
  engine: string,
  params: Record<string, unknown>,
): Promise<{ job_id: string }> {
  const r = await fetch(`${BASE}/${stage}${qs(trackId, stem)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine, params }),
  })
  if (r.status === 409) throw new Error('A run for this stage is already in flight')
  if (!r.ok) throw new Error(`run ${stage}: ${r.status} ${await r.text()}`)
  return r.json()
}

export async function fetchVersions(stage: StageId, trackId: string, stem: string | null): Promise<VersionEntry[]> {
  const r = await fetch(`${BASE}/${stage}/versions${qs(trackId, stem)}`)
  if (!r.ok) throw new Error(`versions ${stage}: ${r.status}`)
  return r.json()
}

export async function activateVersion(stage: StageId, trackId: string, stem: string | null, filename: string): Promise<void> {
  const r = await fetch(`${BASE}/${stage}/versions/${encodeURIComponent(filename)}/activate${qs(trackId, stem)}`, {
    method: 'POST',
  })
  if (!r.ok) throw new Error(`activate ${stage}: ${r.status}`)
}

export async function deleteVersion(stage: StageId, trackId: string, stem: string | null, filename: string): Promise<void> {
  const r = await fetch(`${BASE}/${stage}/versions/${encodeURIComponent(filename)}${qs(trackId, stem)}`, {
    method: 'DELETE',
  })
  if (r.status === 409) throw new Error('Cannot delete the active version')
  if (!r.ok) throw new Error(`delete ${stage}: ${r.status}`)
}
