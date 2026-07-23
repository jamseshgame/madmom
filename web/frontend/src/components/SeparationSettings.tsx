import { useEffect, useMemo, useState } from 'react'

/**
 * Stem-separation settings UI.
 *
 * Nothing about the individual knobs is hardcoded here — the backend ships a
 * declarative parameter schema at `GET /api/stems/engines` and this component
 * renders whatever it finds, grouped by `group` and split into a primary set
 * plus an "advanced" disclosure. Adding a parameter in
 * `app/services/separators.py` surfaces it here with no frontend change.
 */

export type ParamSpec = {
  key: string
  label: string
  type: 'int' | 'float' | 'bool' | 'enum' | 'str' | 'model'
  default: unknown
  help: string
  group: string
  minimum: number | null
  maximum: number | null
  step: number | null
  options: string[]
  advanced: boolean
  applies_to: string
}

export type EngineSpec = {
  key: string
  label: string
  description: string
  quality: string
  speed: string
  params: ParamSpec[]
}

export type SeparatorModel = {
  filename: string
  name: string
  arch: string
  stems: string[]
  scores: Record<string, { SDR?: number }>
}

export type EnginesPayload = {
  engines: EngineSpec[]
  default_engine: string
  defaults: Record<string, Record<string, unknown>>
  demucs_models: Record<string, string[]>
  audio_separator: { available: boolean; models: SeparatorModel[]; error: string }
}

export type ParamValues = Record<string, unknown>

/**
 * Quality presets layered on top of the backend defaults (which are already
 * max quality). "Balanced" and "Fast" exist because max quality on CPU is
 * genuinely slow — 10 Demucs shifts is ten full passes over the audio — and a
 * one-click way back down beats hunting through sliders.
 */
export const QUALITY_PRESETS: Record<string, { label: string; note: string; overrides: ParamValues }> = {
  max: {
    label: 'Max quality',
    note: 'Every pass the models support. Slowest by a wide margin.',
    overrides: {},
  },
  balanced: {
    label: 'Balanced',
    note: 'Quality plateau for most music at a fraction of the time.',
    overrides: {
      shifts: 2,
      overlap: 0.25,
      mdxc_overlap: 8,
      vr_enable_tta: true,
      mdx_enable_denoise: false,
    },
  },
  fast: {
    label: 'Fast',
    note: 'Single pass everywhere. For rough drafts and timing checks.',
    overrides: {
      shifts: 1,
      overlap: 0.1,
      mdxc_overlap: 2,
      vr_enable_tta: false,
      mdx_enable_denoise: false,
      use_autocast: true,
    },
  },
}

function bestSdr(model: SeparatorModel): number | null {
  const values = Object.values(model.scores || {})
    .map((s) => (typeof s?.SDR === 'number' ? s.SDR : null))
    .filter((v): v is number => v != null)
  return values.length ? Math.max(...values) : null
}

/** Searchable model picker over the live audio-separator catalog. */
function ModelPicker({
  value,
  models,
  error,
  onChange,
}: {
  value: string
  models: SeparatorModel[]
  error: string
  onChange: (v: string) => void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const pool = q
      ? models.filter((m) => `${m.name} ${m.filename} ${m.arch}`.toLowerCase().includes(q))
      : models
    // Best-scoring first so the strongest checkpoint is the obvious pick.
    return [...pool]
      .sort((a, b) => (bestSdr(b) ?? -1) - (bestSdr(a) ?? -1))
      .slice(0, 60)
  }, [models, query])

  const selected = models.find((m) => m.filename === value)

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-jam-500"
        />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="px-3 py-2 text-xs rounded-lg border border-gray-700 text-gray-300 hover:border-gray-500"
        >
          {open ? 'Close' : `Browse (${models.length})`}
        </button>
      </div>

      {selected && (
        <div className="text-xs text-gray-500">
          {selected.name} · <span className="text-gray-400">{selected.arch}</span>
          {selected.stems.length > 0 && <> · stems: {selected.stems.join(', ')}</>}
          {bestSdr(selected) != null && <> · best SDR {bestSdr(selected)!.toFixed(2)}</>}
        </div>
      )}

      {error && <div className="text-xs text-amber-400">{error}</div>}

      {open && (
        <div className="border border-gray-700 rounded-lg overflow-hidden">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name, architecture or filename…"
            className="w-full bg-gray-800 border-b border-gray-700 px-3 py-2 text-sm focus:outline-none"
          />
          <div className="max-h-72 overflow-y-auto divide-y divide-gray-800">
            {filtered.length === 0 && (
              <div className="px-3 py-3 text-xs text-gray-500">No models match that filter.</div>
            )}
            {filtered.map((m) => {
              const sdr = bestSdr(m)
              return (
                <button
                  key={m.filename}
                  type="button"
                  onClick={() => {
                    onChange(m.filename)
                    setOpen(false)
                  }}
                  className={`w-full text-left px-3 py-2 hover:bg-gray-800 ${
                    m.filename === value ? 'bg-jam-600/10' : ''
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm text-gray-200 truncate">{m.name}</span>
                    <span className="text-[11px] text-gray-500 shrink-0">
                      {m.arch}
                      {sdr != null && ` · SDR ${sdr.toFixed(2)}`}
                    </span>
                  </div>
                  <div className="text-[11px] text-gray-600 font-mono truncate">{m.filename}</div>
                  {m.stems.length > 0 && (
                    <div className="text-[11px] text-gray-600">{m.stems.join(' · ')}</div>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function ParamField({
  spec,
  value,
  models,
  modelsError,
  onChange,
}: {
  spec: ParamSpec
  value: unknown
  models: SeparatorModel[]
  modelsError: string
  onChange: (v: unknown) => void
}) {
  const label = (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-gray-400">{spec.label}</span>
      {spec.applies_to && <span className="text-[10px] text-gray-600">{spec.applies_to}</span>}
    </div>
  )

  let control: JSX.Element

  if (spec.type === 'model') {
    control = (
      <ModelPicker
        value={String(value ?? '')}
        models={models}
        error={modelsError}
        onChange={onChange}
      />
    )
  } else if (spec.type === 'bool') {
    control = (
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={`mt-1 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
          value
            ? 'border-jam-500 bg-jam-600/15 text-jam-300'
            : 'border-gray-700 text-gray-500 hover:border-gray-500'
        }`}
      >
        {value ? 'On' : 'Off'}
      </button>
    )
  } else if (spec.type === 'enum') {
    control = (
      <select
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-jam-500"
      >
        {spec.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  } else if (spec.type === 'str') {
    control = (
      <input
        type="text"
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-jam-500"
      />
    )
  } else if (spec.minimum != null && spec.maximum != null) {
    const step = spec.step ?? (spec.type === 'int' ? 1 : 0.01)
    const num = typeof value === 'number' ? value : Number(value ?? 0)
    control = (
      <div className="flex items-center gap-2 mt-1">
        <input
          type="range"
          min={spec.minimum}
          max={spec.maximum}
          step={step}
          value={num}
          onChange={(e) => onChange(spec.type === 'int' ? Math.round(Number(e.target.value)) : Number(e.target.value))}
          className="flex-1"
        />
        <input
          type="number"
          min={spec.minimum}
          max={spec.maximum}
          step={step}
          value={num}
          onChange={(e) => onChange(spec.type === 'int' ? Math.round(Number(e.target.value)) : Number(e.target.value))}
          className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-right focus:outline-none focus:border-jam-500"
        />
      </div>
    )
  } else {
    control = (
      <input
        type="number"
        value={typeof value === 'number' ? value : Number(value ?? 0)}
        onChange={(e) => onChange(spec.type === 'int' ? Math.round(Number(e.target.value)) : Number(e.target.value))}
        className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-jam-500"
      />
    )
  }

  return (
    <div className="space-y-1">
      {label}
      {control}
      {spec.help && <p className="text-[11px] leading-snug text-gray-600">{spec.help}</p>}
    </div>
  )
}

export default function SeparationSettings({
  payload,
  engine,
  params,
  onEngineChange,
  onParamChange,
  onApplyPreset,
}: {
  payload: EnginesPayload
  engine: string
  params: ParamValues
  onEngineChange: (key: string) => void
  onParamChange: (key: string, value: unknown) => void
  onApplyPreset: (preset: keyof typeof QUALITY_PRESETS) => void
}) {
  const [showAdvanced, setShowAdvanced] = useState(false)
  const spec = payload.engines.find((e) => e.key === engine)

  // Which preset the current values correspond to, so the row reflects manual
  // edits instead of staying stuck on whatever was last clicked.
  const activePreset = useMemo(() => {
    for (const [key, preset] of Object.entries(QUALITY_PRESETS)) {
      const relevant = Object.entries(preset.overrides).filter(([k]) => k in params)
      if (relevant.length > 0 && relevant.every(([k, v]) => params[k] === v)) return key
    }
    const defaults = payload.defaults[engine] || {}
    if (Object.entries(defaults).every(([k, v]) => params[k] === v)) return 'max'
    return ''
  }, [params, engine, payload.defaults])

  useEffect(() => {
    setShowAdvanced(false)
  }, [engine])

  if (!spec) return null

  const models = payload.audio_separator?.models || []
  const modelsError = payload.audio_separator?.error || ''

  const visible = spec.params.filter((p) => showAdvanced || !p.advanced)
  const groups: { name: string; items: ParamSpec[] }[] = []
  for (const p of visible) {
    let g = groups.find((x) => x.name === p.group)
    if (!g) {
      g = { name: p.group, items: [] }
      groups.push(g)
    }
    g.items.push(p)
  }
  const advancedCount = spec.params.filter((p) => p.advanced).length

  return (
    <div className="space-y-6">
      {/* Engine picker */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Separation engine</h3>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {payload.engines.map((e) => {
            const active = e.key === engine
            const unavailable = e.key !== 'demucs' && !payload.audio_separator?.available
            return (
              <button
                key={e.key}
                type="button"
                disabled={unavailable}
                onClick={() => onEngineChange(e.key)}
                className={`text-left p-4 rounded-lg border transition-colors ${
                  active ? 'border-jam-500 bg-jam-600/10' : 'border-gray-700 hover:border-gray-500'
                } ${unavailable ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <div className="text-sm font-medium text-gray-200">{e.label}</div>
                <div className="flex gap-3 mt-1 text-[11px]">
                  <span className="text-emerald-400">Quality: {e.quality}</span>
                  <span className="text-amber-400">Speed: {e.speed}</span>
                </div>
                <p className="text-[11px] leading-snug text-gray-500 mt-2">{e.description}</p>
                {unavailable && (
                  <p className="text-[11px] text-amber-400 mt-2">
                    Needs audio-separator: <span className="font-mono">pip install "audio-separator[cpu]"</span>
                  </p>
                )}
              </button>
            )
          })}
        </div>
        {!payload.audio_separator?.available && payload.audio_separator?.error && (
          <p className="text-xs text-amber-400">{payload.audio_separator.error}</p>
        )}
      </div>

      {/* Quality presets */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Quality preset</h3>
          <span className="text-[11px] text-gray-600">Defaults to max quality</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {Object.entries(QUALITY_PRESETS).map(([key, preset]) => (
            <button
              key={key}
              type="button"
              onClick={() => onApplyPreset(key as keyof typeof QUALITY_PRESETS)}
              className={`text-left p-3 rounded-lg border transition-colors ${
                activePreset === key ? 'border-jam-500 bg-jam-600/10' : 'border-gray-700 hover:border-gray-500'
              }`}
            >
              <div className="text-sm font-medium text-gray-200">{preset.label}</div>
              <div className="text-[11px] text-gray-500 mt-0.5 leading-snug">{preset.note}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Parameters */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-6">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
            {spec.label} settings
          </h3>
          {advancedCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="text-xs text-jam-400 hover:text-jam-300"
            >
              {showAdvanced ? 'Hide' : 'Show'} advanced ({advancedCount})
            </button>
          )}
        </div>

        {groups.map((g) => (
          <div key={g.name} className="space-y-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-600 border-b border-gray-800 pb-1">
              {g.name}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-5">
              {g.items.map((p) => (
                <div key={p.key} className={p.type === 'model' ? 'md:col-span-2' : ''}>
                  <ParamField
                    spec={p}
                    value={params[p.key]}
                    models={models}
                    modelsError={modelsError}
                    onChange={(v) => onParamChange(p.key, v)}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
