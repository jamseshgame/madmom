import { useEffect, useMemo, useState } from 'react'

type Row = Record<string, unknown>
type Analytics = {
  summary: { events: number; users: number; event_types: number; latest: string | null }
  trend: { day: string; events: number; users: number }[]
  breakdown: { event: string; count: number; users: number }[]
  activity: { uuid: string; timestamp: string; event: string; distinct_id: string; properties: unknown }[]
  pagination: { limit: number; offset: number; has_more: boolean }
}

const number = new Intl.NumberFormat()

function LineChart({ rows }: { rows: Analytics['trend'] }) {
  const width = 800
  const height = 220
  const pad = 28
  const max = Math.max(1, ...rows.map((r) => Number(r.events)))
  const points = rows.map((r, i) => {
    const x = pad + (i * (width - pad * 2)) / Math.max(1, rows.length - 1)
    const y = height - pad - (Number(r.events) / max) * (height - pad * 2)
    return `${x},${y}`
  }).join(' ')
  if (!rows.length) return <div className="h-52 grid place-items-center text-gray-500">No events in this period</div>
  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-56" role="img" aria-label="Events over time">
        {[0, .25, .5, .75, 1].map((ratio) => <line key={ratio} x1={pad} x2={width - pad} y1={pad + ratio * (height - pad * 2)} y2={pad + ratio * (height - pad * 2)} stroke="#374151" strokeWidth="1" />)}
        <polyline points={points} fill="none" stroke="#a78bfa" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        {rows.map((r, i) => {
          const [x, y] = points.split(' ')[i].split(',')
          return <circle key={r.day} cx={x} cy={y} r="3" fill="#c4b5fd"><title>{`${r.day}: ${number.format(r.events)} events`}</title></circle>
        })}
      </svg>
      <div className="flex justify-between text-xs text-gray-500 px-7"><span>{rows[0]?.day}</span><span>{rows[rows.length - 1]?.day}</span></div>
    </div>
  )
}

function Properties({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false)
  const parsed = useMemo<Row>(() => {
    if (typeof value === 'object' && value) return value as Row
    try { return JSON.parse(String(value || '{}')) as Row } catch { return { value } }
  }, [value])
  const entries = Object.entries(parsed)
  return (
    <div className="max-w-xl">
      <button onClick={() => setOpen(!open)} className="text-jam-300 hover:text-jam-200 text-xs">
        {entries.length} propert{entries.length === 1 ? 'y' : 'ies'} {open ? '▴' : '▾'}
      </button>
      {open && <pre className="mt-2 p-3 rounded bg-gray-950 text-[11px] text-gray-300 overflow-auto max-h-72 whitespace-pre-wrap">{JSON.stringify(parsed, null, 2)}</pre>}
    </div>
  )
}

export default function AnalyticsPage() {
  const [days, setDays] = useState(30)
  const [event, setEvent] = useState('')
  const [search, setSearch] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<Analytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ days: String(days), limit: '50', offset: String(offset) })
    if (event) params.set('event', event)
    if (appliedSearch) params.set('search', appliedSearch)
    setLoading(true); setError('')
    fetch(`/api/analytics?${params}`, { signal: controller.signal })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json()).detail || 'Could not load analytics'); return r.json() })
      .then(setData).catch((e) => { if (e.name !== 'AbortError') setError(e.message) }).finally(() => setLoading(false))
    return () => controller.abort()
  }, [days, event, appliedSearch, offset])

  const setFilter = (fn: () => void) => { setOffset(0); fn() }
  const cards = data ? [
    ['Events', data.summary.events], ['Unique users', data.summary.users], ['Event types', data.summary.event_types],
  ] : []

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div><h1 className="text-2xl font-bold">Analytics</h1><p className="text-sm text-gray-400 mt-1">Live product activity from PostHog</p></div>
        <div className="flex flex-wrap gap-2">
          <select value={days} onChange={(e) => setFilter(() => setDays(Number(e.target.value)))} className="bg-gray-900 border border-gray-700 rounded-md px-3 py-2 text-sm">
            <option value={1}>Last 24 hours</option><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last year</option>
          </select>
          <form onSubmit={(e) => { e.preventDefault(); setFilter(() => setAppliedSearch(search.trim())) }} className="flex">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search events, users, properties" className="w-64 bg-gray-900 border border-gray-700 rounded-l-md px-3 py-2 text-sm" />
            <button className="bg-jam-600 hover:bg-jam-500 px-3 rounded-r-md text-sm">Search</button>
          </form>
        </div>
      </div>
      {error && <div className="border border-red-800 bg-red-950/40 text-red-300 rounded-lg p-4">{error}</div>}
      {loading && !data && <div className="py-24 text-center text-gray-400">Loading PostHog activity…</div>}
      {data && <>
        <div className="grid sm:grid-cols-3 gap-4">
          {cards.map(([label, value]) => <div key={label} className="rounded-xl border border-gray-800 bg-gray-900 p-5"><div className="text-sm text-gray-400">{label}</div><div className="text-3xl font-semibold mt-1">{number.format(Number(value))}</div></div>)}
        </div>
        <div className="grid lg:grid-cols-3 gap-5">
          <div className="lg:col-span-2 rounded-xl border border-gray-800 bg-gray-900 p-5"><h2 className="font-semibold">Activity over time</h2><LineChart rows={data.trend} /></div>
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-5"><h2 className="font-semibold mb-4">Top events</h2><div className="space-y-3 max-h-64 overflow-auto">
            {data.breakdown.map((r) => { const pct = (Number(r.count) / Math.max(1, Number(data.breakdown[0]?.count))) * 100; return <button key={r.event} onClick={() => setFilter(() => setEvent(event === r.event ? '' : r.event))} className="block w-full text-left group"><div className="flex justify-between text-xs gap-2"><span className="truncate group-hover:text-jam-300">{r.event}</span><span className="text-gray-400">{number.format(r.count)}</span></div><div className="h-1.5 bg-gray-800 rounded mt-1"><div className="h-full bg-jam-500 rounded" style={{ width: `${pct}%` }} /></div></button> })}
          </div></div>
        </div>
        {event && <div className="flex items-center gap-2 text-sm">Filtered to <code className="text-jam-300">{event}</code><button onClick={() => setFilter(() => setEvent(''))} className="text-gray-400 hover:text-white">Clear ×</button></div>}
        <div className="rounded-xl border border-gray-800 bg-gray-900 overflow-hidden">
          <div className="p-5 border-b border-gray-800 flex justify-between"><h2 className="font-semibold">Activity stream</h2>{loading && <span className="text-xs text-gray-500">Refreshing…</span>}</div>
          <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="text-left text-xs text-gray-500 bg-gray-950/40"><tr><th className="p-3">Time</th><th className="p-3">Event</th><th className="p-3">Person</th><th className="p-3">Data</th></tr></thead><tbody className="divide-y divide-gray-800">
            {data.activity.map((r) => <tr key={r.uuid} className="align-top hover:bg-gray-800/30"><td className="p-3 whitespace-nowrap text-gray-400" title={r.timestamp}>{new Date(r.timestamp).toLocaleString()}</td><td className="p-3 font-mono text-jam-300">{r.event}</td><td className="p-3 font-mono text-xs text-gray-300 max-w-48 truncate" title={r.distinct_id}>{r.distinct_id}</td><td className="p-3"><Properties value={r.properties} /></td></tr>)}
            {!data.activity.length && <tr><td colSpan={4} className="p-12 text-center text-gray-500">No matching activity</td></tr>}
          </tbody></table></div>
          <div className="p-4 border-t border-gray-800 flex justify-between items-center text-sm"><span className="text-gray-500">Rows {offset + 1}–{offset + data.activity.length}</span><div className="flex gap-2"><button disabled={!offset || loading} onClick={() => setOffset(Math.max(0, offset - 50))} className="px-3 py-1.5 rounded border border-gray-700 disabled:opacity-30">Previous</button><button disabled={!data.pagination.has_more || loading} onClick={() => setOffset(offset + 50)} className="px-3 py-1.5 rounded border border-gray-700 disabled:opacity-30">Next</button></div></div>
        </div>
      </>}
    </section>
  )
}
