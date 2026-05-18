import { useEffect, useState } from 'react'
import { StageCard } from './StageCard'
import type { EngineSpec, PipelineStateDto, StageId } from '../../api/pipelineClient'
import { fetchEnginesCatalog, fetchPipelineState, fetchStems } from '../../api/pipelineClient'

interface Props {
  trackId: string
}

const STAGE_TITLES: Record<StageId, string> = {
  grid: 'S1 · Grid (track-level)',
  onsets: 'S2 · Onset detection',
  pitches: 'S3 · Pitch + polyphony',
  quantized: 'S4 · Quantization',
  lanes_expert: 'S5 · Lane mapping',
  lanes_filtered: 'S6 · Playability filter',
  lanes_hard: 'S7 · Hard',
  lanes_medium: 'S7 · Medium',
  lanes_easy: 'S7 · Easy',
}

export function GenerateTab({ trackId }: Props) {
  const [catalog, setCatalog] = useState<Record<StageId, EngineSpec[]> | null>(null)
  const [state, setState] = useState<PipelineStateDto | null>(null)
  const [stems, setStems] = useState<string[]>([])
  const [activeStem, setActiveStem] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    fetchEnginesCatalog().then(setCatalog).catch(console.error)
  }, [])

  useEffect(() => {
    fetchPipelineState(trackId).then(setState).catch(console.error)
    fetchStems(trackId).then(s => {
      setStems(s.map(x => x.name))
      if (!activeStem && s.length > 0) setActiveStem(s[0].name)
    }).catch(console.error)
  }, [trackId, refreshKey])

  if (!catalog || !state) return <div className="p-4 text-zinc-400">Loading…</div>

  const onRunComplete = () => setRefreshKey(k => k + 1)

  return (
    <div className="p-4">
      <div className="mb-4 flex gap-2 items-center">
        <span className="text-sm text-zinc-400">Stem:</span>
        {stems.map(s => (
          <button key={s}
            onClick={() => setActiveStem(s)}
            className={`px-3 py-1 text-sm rounded ${activeStem === s ? 'bg-indigo-600' : 'bg-zinc-700'}`}>
            {s}
          </button>
        ))}
      </div>

      <StageCard
        stage="grid"
        trackId={trackId}
        stem={null}
        title={STAGE_TITLES.grid}
        engines={catalog.grid}
        activeEngineId={state.grid?.engine ?? null}
        stale={state.grid?.stale ?? false}
        onRunComplete={onRunComplete}
      />

      {activeStem && (
        <>
          {(['onsets', 'pitches', 'quantized', 'lanes_expert', 'lanes_filtered',
             'lanes_hard', 'lanes_medium', 'lanes_easy'] as StageId[]).map(stage => {
            const ss = state.stems[activeStem]
            const stageState = ss ? ss[stage as keyof typeof ss] as { engine: string | null, stale: boolean } : null
            return (
              <StageCard
                key={stage}
                stage={stage}
                trackId={trackId}
                stem={activeStem}
                title={STAGE_TITLES[stage]}
                engines={catalog[stage]}
                activeEngineId={stageState?.engine ?? null}
                stale={stageState?.stale ?? false}
                onRunComplete={onRunComplete}
              />
            )
          })}
        </>
      )}
    </div>
  )
}
