import type { ParamSpec } from '../../api/pipelineClient'

export function ParamControl({
  keyName, spec, value, onChange,
}: {
  keyName: string
  spec: ParamSpec
  value: unknown
  onChange: (v: unknown) => void
}) {
  const label = ('label' in spec && spec.label) || keyName
  if (spec.type === 'number') {
    return (
      <label className="block text-xs">
        {label}: <span className="text-indigo-300">{String(value ?? spec.default ?? '')}</span>
        <input type="range"
          min={spec.min ?? 0} max={spec.max ?? 1} step={spec.step ?? 0.01}
          value={Number(value ?? spec.default ?? 0)}
          onChange={e => onChange(Number(e.target.value))}
          className="w-full" />
      </label>
    )
  }
  if (spec.type === 'boolean') {
    return (
      <label className="block text-xs">
        <input type="checkbox" checked={Boolean(value ?? spec.default)}
          onChange={e => onChange(e.target.checked)} />
        <span className="ml-2">{label}</span>
      </label>
    )
  }
  if (spec.type === 'enum') {
    return (
      <label className="block text-xs">
        {label}:
        <select value={String(value ?? spec.default ?? '')}
          onChange={e => onChange(e.target.value)}
          className="ml-2 bg-zinc-800 border border-zinc-600 rounded px-1">
          {spec.options.map(o => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
        </select>
      </label>
    )
  }
  return <div className="text-xs text-zinc-500">[unsupported param type]</div>
}
