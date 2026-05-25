import { useCallback, useEffect, useRef, useState } from 'react'
import { ParamControl } from './ParamControl'
import type { EngineSpec } from '../../api/pipelineClient'
import {
  GENERATION_STAGE_LABELS,
  presetToGeneration,
  type GenerationPreset,
  type GenerationStage,
  type GenerationState,
} from './generationTypes'

// Single-select mode keeps the existing string-based API used by the
// TracksPage BeatmapPanel and the editor's GenerateTab.
//
// Multi-select mode replaces the single dropdown with a checkbox list and
// hides the per-stage cards when 2+ presets are picked. The picker stores
// an array of preset names; empty string ('') means "Custom" — i.e. run the
// current `generation` state as one of the picks.
type SharedProps = {
  generation: GenerationState
  onGenerationChange: (next: GenerationState) => void
  // The stem this settings panel is generating for. Threaded into the
  // presets fetch URL so the backend's stem filter narrows the dropdown
  // to applicable presets.
  stem: string
}

type SingleSelectProps = SharedProps & {
  mode?: 'single'
  activePreset: string
  onActivePresetChange: (name: string) => void
}

type MultiSelectProps = SharedProps & {
  mode: 'multi'
  activePresets: string[]
  onActivePresetsChange: (names: string[]) => void
}

type GenerationSettingsProps = SingleSelectProps | MultiSelectProps

export default function GenerationSettings(props: GenerationSettingsProps) {
  const { generation, onGenerationChange, stem } = props
  const isMulti = props.mode === 'multi'

  // Normalised view of the selection. Multi mode is the array as-is; single
  // mode wraps the string into an array (empty string => []). This lets the
  // rest of the component reason in one model.
  const selected: string[] = isMulti
    ? props.activePresets
    : (props.activePreset ? [props.activePreset] : [])

  const setSelected = useCallback((next: string[]) => {
    if (isMulti) {
      props.onActivePresetsChange(next)
    } else {
      // Single mode collapses to the last entry (or empty for Custom).
      props.onActivePresetChange(next.length > 0 ? next[next.length - 1] : '')
    }
  }, [isMulti, props])

  const [engines, setEngines] = useState<Record<string, EngineSpec[]> | null>(null)
  const [presets, setPresets] = useState<GenerationPreset[]>([])
  const [presetSaving, setPresetSaving] = useState(false)
  const [presetError, setPresetError] = useState('')

  // Custom-dropdown open state (multi mode only). Tracked here so the
  // click-outside listener can close it.
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!pickerOpen) return
    const onMouseDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [pickerOpen])

  // Always-latest snapshot of `generation` so the async engines-fetch
  // callback below seeds against current props, not the value captured at
  // mount. Without this, a parent update arriving before the fetch resolves
  // would be silently clobbered when the seeding runs.
  const generationRef = useRef(generation)
  generationRef.current = generation

  // Load engine catalog; seed default params for any stage that's currently
  // empty {} so the displayed knobs match what the backend will use. Stages
  // with non-empty params (e.g. restored from localStorage) are left alone.
  useEffect(() => {
    const ctrl = new AbortController()
    fetch('/api/pipeline/engines', { signal: ctrl.signal })
      .then((r) => r.json())
      .then((catalog: Record<string, EngineSpec[]>) => {
        setEngines(catalog)
        const next: GenerationState = { ...generationRef.current }
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
      .catch((e) => { if (e?.name !== 'AbortError') console.error(e) })
    return () => ctrl.abort()
    // onGenerationChange is a setter from useState in the parent — always
    // stable; intentionally omitted from deps to keep this effect mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Imperative refetch helper — called after save/delete operations so the
  // dropdown reflects the new list immediately. Does NOT run the v1-fallback;
  // that lives in its own effect below to avoid coupling.
  const refreshPresets = useCallback(() => {
    const url = stem
      ? `/api/generation-presets?stem=${encodeURIComponent(stem)}`
      : '/api/generation-presets'
    fetch(url)
      .then((r) => r.json())
      .then((list: GenerationPreset[]) => setPresets(list))
      .catch(console.error)
  }, [stem])

  // Initial presets load — aborts if the component unmounts before resolving.
  // Re-runs when `stem` changes so the dropdown narrows to applicable presets.
  useEffect(() => {
    const ctrl = new AbortController()
    const url = stem
      ? `/api/generation-presets?stem=${encodeURIComponent(stem)}`
      : '/api/generation-presets'
    fetch(url, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((list: GenerationPreset[]) => setPresets(list))
      .catch((e) => { if (e?.name !== 'AbortError') console.error(e) })
    return () => ctrl.abort()
  }, [stem])

  // When presets load (or refresh after save/delete), drop any stored
  // selections that no longer exist. If that empties the selection, snap to
  // v1 so the engine cards have something honest to render — and overwrite
  // `generation` to match so the dropdown label and the cards agree.
  // Empty-string ('Custom') entries are always valid and pass through.
  useEffect(() => {
    if (presets.length === 0) return
    const valid = selected.filter((n) => n === '' || presets.find((p) => p.name === n))
    if (valid.length === 0) {
      const v1 = presets.find((p) => p.name === 'v1')
      if (v1) {
        setSelected(['v1'])
        onGenerationChange(presetToGeneration(v1))
      }
    } else if (valid.length !== selected.length) {
      setSelected(valid)
    }
    // setSelected and onGenerationChange are stable parent setters —
    // omitted intentionally so the effect only re-runs on presets/selected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presets, selected.join(' ')])

  const applySinglePreset = (name: string) => {
    setSelected(name ? [name] : [])
    if (!name) return
    const p = presets.find((x) => x.name === name)
    if (!p) return
    onGenerationChange(presetToGeneration(p))
  }

  // Multi-select toggle. When the selection lands on exactly one named
  // preset, snap `generation` to that preset so the engine cards (which
  // re-appear at 0-or-1 selected) reflect what's actually about to run.
  // Custom ('') is left alone — its settings live in the engine cards.
  const togglePreset = (name: string) => {
    const isOn = selected.includes(name)
    const next = isOn ? selected.filter((n) => n !== name) : [...selected, name]
    setSelected(next)
    if (next.length === 1) {
      const sole = next[0]
      if (sole !== '') {
        const p = presets.find((x) => x.name === sole)
        if (p) onGenerationChange(presetToGeneration(p))
      }
    }
  }

  // Any manual edit to engine/params drops the picker into "Custom" so the
  // dropdown doesn't lie about what's running. In multi mode this collapses
  // the selection to just Custom; multi-preset runs aren't compatible with
  // editing the cards (cards are hidden then).
  const markCustom = () => {
    if (selected.length === 1 && selected[0] === '') return
    setSelected([''])
  }

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
      setSelected([name.trim()])
      refreshPresets()
    } catch (e) {
      setPresetError((e as Error).message)
    } finally {
      setPresetSaving(false)
    }
  }

  // Delete is only offered when exactly one custom (non-builtin) preset is
  // the sole selection. Builtins can't be deleted; multi-selection makes
  // "which preset to delete?" ambiguous so we hide the button.
  const soleCustomPresetName = (() => {
    if (selected.length !== 1) return ''
    const name = selected[0]
    if (!name) return ''
    const p = presets.find((x) => x.name === name)
    return p && !p.builtin ? name : ''
  })()

  const deleteSolePreset = async () => {
    const name = soleCustomPresetName
    if (!name) return
    if (!window.confirm(`Delete preset "${name}"?`)) return
    try {
      const res = await fetch(`/api/generation-presets/${encodeURIComponent(name)}`, { method: 'DELETE' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }
      setSelected([])
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

  const showCards = selected.length <= 1
  const customSelected = selected.includes('')
  const namedSelected = selected.filter((n) => n !== '')

  const pickerLabel = (() => {
    if (selected.length === 0) return 'Pick preset…'
    const labels = selected.map((n) => n === '' ? 'Custom' : n)
    if (labels.length <= 2) return labels.join(', ')
    return `${labels.slice(0, 2).join(', ')} + ${labels.length - 2} more`
  })()

  // Single-line description hint when exactly one preset is selected.
  const soleDescription = (() => {
    if (selected.length !== 1) return ''
    const name = selected[0]
    if (!name) return ''
    return presets.find((p) => p.name === name)?.description || ''
  })()

  return (
    <div>
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Generation</h4>
        <div className="flex items-center gap-2">
          {isMulti ? (
            <div className="relative" ref={pickerRef}>
              <button
                type="button"
                onClick={() => setPickerOpen((o) => !o)}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs min-w-[10rem] max-w-[18rem] text-left flex items-center justify-between gap-2"
                title="Pick one or more presets to batch-generate"
              >
                <span className="truncate">{pickerLabel}</span>
                <span className="text-gray-500 text-[10px]">▾</span>
              </button>
              {pickerOpen && (
                <div className="absolute right-0 mt-1 z-20 bg-gray-800 border border-gray-700 rounded-md shadow-lg py-1 min-w-[16rem] max-w-[22rem] max-h-72 overflow-y-auto">
                  <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-700 cursor-pointer text-xs">
                    <input
                      type="checkbox"
                      checked={customSelected}
                      onChange={() => togglePreset('')}
                      className="accent-jam-500"
                    />
                    <span className="text-gray-200">Custom</span>
                    <span className="text-gray-500 text-[10px] ml-auto">edit knobs</span>
                  </label>
                  {presets.length > 0 && (
                    <div className="border-t border-gray-700/60 my-1" />
                  )}
                  {presets.map((p) => (
                    <label
                      key={p.name}
                      className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-700 cursor-pointer text-xs"
                      title={p.description || ''}
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(p.name)}
                        onChange={() => togglePreset(p.name)}
                        className="accent-jam-500"
                      />
                      <span className="text-gray-200 shrink-0">{p.builtin ? p.name : `★ ${p.name}`}</span>
                      {p.description && (
                        <span className="text-gray-500 truncate text-[11px]">— {p.description}</span>
                      )}
                    </label>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <select
              value={selected[0] ?? ''}
              onChange={(e) => applySinglePreset(e.target.value)}
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
          )}
          <button
            type="button"
            onClick={savePresetAs}
            disabled={presetSaving}
            className="px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 rounded"
            title="Save current settings as a new preset"
          >
            Save as…
          </button>
          {soleCustomPresetName && (
            <button
              type="button"
              onClick={deleteSolePreset}
              className="px-2 py-1 text-xs bg-red-900/40 hover:bg-red-800/60 border border-red-800 text-red-300 rounded"
              title={`Delete preset "${soleCustomPresetName}"`}
            >
              Delete
            </button>
          )}
        </div>
      </div>
      {presetError && <div className="mb-2 text-xs text-red-400">{presetError}</div>}
      {soleDescription && (
        <p className="text-[11px] text-gray-500 italic mb-2">{soleDescription}</p>
      )}

      {showCards ? (
        <div className="space-y-3">
          {(Object.keys(GENERATION_STAGE_LABELS) as GenerationStage[]).map((stage) => {
            const stageEngines = engines[stage] || []
            const stageSelection = generation[stage]
            const spec = stageEngines.find((e) => e.engine_id === stageSelection.engine)
            return (
              <div key={stage} className="border border-gray-700 rounded-lg p-3 space-y-2">
                <label className="block text-xs">
                  <span className="text-gray-500">{GENERATION_STAGE_LABELS[stage]}</span>
                  <select
                    value={stageSelection.engine}
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
                        value={stageSelection.params[key]}
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
      ) : (
        <div className="border border-gray-700/60 rounded-lg p-3 text-xs text-gray-400">
          <span className="text-gray-200 font-medium">{selected.length} presets queued.</span>{' '}
          Each runs its own settings — uncheck down to one to edit the knobs.
          {customSelected && namedSelected.length > 0 && (
            <span className="block mt-1 text-[11px] text-gray-500">
              Custom will run with the engine settings last edited above.
            </span>
          )}
        </div>
      )}
    </div>
  )
}
