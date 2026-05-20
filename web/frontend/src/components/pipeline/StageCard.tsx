import { useEffect, useState } from 'react'
import type {
  EngineSpec, StageId, VersionEntry,
} from '../../api/pipelineClient'
import {
  activateVersion, deleteVersion, fetchVersions, runStage,
} from '../../api/pipelineClient'
import { ParamControl } from './ParamControl'

interface StageCardProps {
  stage: StageId
  trackId: string
  stem: string | null
  title: string
  engines: EngineSpec[]
  activeEngineId: string | null
  stale: boolean
  onRunComplete: () => void
}

export function StageCard({
  stage, trackId, stem, title, engines, activeEngineId, stale, onRunComplete,
}: StageCardProps) {
  const [selectedEngine, setSelectedEngine] = useState<string | null>(activeEngineId || (engines[0]?.engine_id ?? null))
  const [params, setParams] = useState<Record<string, unknown>>({})
  const [running, setRunning] = useState(false)
  const [versions, setVersions] = useState<VersionEntry[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!selectedEngine) return
    const spec = engines.find(e => e.engine_id === selectedEngine)
    if (!spec) return
    const defaults: Record<string, unknown> = {}
    for (const [key, p] of Object.entries(spec.params_schema)) {
      if ('default' in p && p.default !== undefined) defaults[key] = p.default
    }
    setParams(defaults)
  }, [selectedEngine, engines])

  useEffect(() => {
    let cancelled = false
    fetchVersions(stage, trackId, stem).then(v => { if (!cancelled) setVersions(v) }).catch(() => {})
    return () => { cancelled = true }
  }, [stage, trackId, stem])

  async function handleRun() {
    if (!selectedEngine) return
    setRunning(true); setError(null)
    try {
      const { job_id } = await runStage(stage, trackId, stem, selectedEngine, params)
      const es = new EventSource(`/api/jobs/${job_id}/events`)
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data)
          if (data.step === 'done' || data.step === 'error') {
            es.close()
            setRunning(false)
            if (data.step === 'error') setError(data.message || 'failed')
            onRunComplete()
            fetchVersions(stage, trackId, stem).then(setVersions).catch(() => {})
          }
        } catch {}
      }
      es.onerror = () => { es.close(); setRunning(false) }
    } catch (e: any) {
      setError(e.message || 'failed'); setRunning(false)
    }
  }

  const status = stale ? 'stale' : activeEngineId ? 'up-to-date' : 'never run'
  const statusColor = stale ? 'text-orange-500' : activeEngineId ? 'text-emerald-500' : 'text-zinc-400'

  return (
    <div className="border border-zinc-700 rounded p-4 mb-3 bg-zinc-900">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">{title}</h3>
        <div className="flex items-center gap-2">
          <span className={`text-xs ${statusColor}`}>{status}</span>
          <button
            disabled={running || !selectedEngine}
            onClick={handleRun}
            className="px-3 py-1 bg-indigo-600 rounded text-sm disabled:opacity-50">
            {running ? 'Running…' : 'Run'}
          </button>
        </div>
      </div>

      <label className="block text-sm mb-2">
        Engine:
        <select
          value={selectedEngine || ''}
          onChange={e => setSelectedEngine(e.target.value)}
          className="ml-2 bg-zinc-800 border border-zinc-600 rounded px-2 py-1">
          {engines.map(e => (
            <option key={e.engine_id} value={e.engine_id}>{e.display_name}</option>
          ))}
        </select>
      </label>

      {selectedEngine && (
        <div className="space-y-2 pl-2 border-l border-zinc-700">
          {Object.entries(engines.find(e => e.engine_id === selectedEngine)?.params_schema || {}).map(
            ([key, spec]) => (
              <ParamControl key={key} keyName={key} spec={spec}
                value={params[key]}
                onChange={v => setParams(p => ({ ...p, [key]: v }))} />
            )
          )}
        </div>
      )}

      {error && <div className="mt-2 text-sm text-red-400">{error}</div>}

      {versions.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-zinc-400">
            Versions ({versions.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {versions.map(v => (
              <li key={v.filename} className="flex items-center justify-between">
                <span className={v.active ? 'text-emerald-400' : ''}>
                  {v.created_at} · {v.engine}
                </span>
                <span className="flex gap-2">
                  {!v.active && (
                    <button onClick={() => activateVersion(stage, trackId, stem, v.filename).then(onRunComplete)}
                      className="text-xs text-indigo-400">activate</button>
                  )}
                  {!v.active && (
                    <button onClick={() => deleteVersion(stage, trackId, stem, v.filename).then(() => fetchVersions(stage, trackId, stem).then(setVersions))}
                      className="text-xs text-red-400">delete</button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

