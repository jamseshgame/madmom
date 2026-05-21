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
