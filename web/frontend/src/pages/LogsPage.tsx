import { useEffect, useMemo, useState } from 'react'

type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
type JobKind = 'separate' | 'manual_stems' | 'beatmap' | 'youtube' | 'other'

interface JobEvent {
  step: string
  progress: number
  message: string
  ts: number
  metadata?: Record<string, unknown>
}

interface JobRow {
  id: string
  kind: JobKind | string
  title: string
  status: JobStatus
  progress: number
  last_message: string
  created_at: number
  updated_at: number
  finished_at: number | null
  error: string | null
  metadata: Record<string, unknown>
  track_id: string | null
  beatmap_id: string | null
  user: string | null
  event_log?: JobEvent[]
}

const STATUS_FILTERS: { key: 'all' | 'active' | 'done' | 'failed'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'done', label: 'Done' },
  { key: 'failed', label: 'Failed' },
]

const STATUS_COLORS: Record<JobStatus, string> = {
  queued: 'text-gray-400 bg-gray-700/40',
  running: 'text-jam-200 bg-jam-700/40',
  done: 'text-emerald-300 bg-emerald-900/40',
  failed: 'text-red-300 bg-red-900/40',
  cancelled: 'text-gray-400 bg-gray-700/40',
}

const KIND_LABELS: Record<string, string> = {
  separate: 'Separate stems',
  manual_stems: 'Manual stems',
  beatmap: 'Beatmap',
  youtube: 'YouTube ingest',
  other: 'Other',
}

const fmtTime = (ts: number) => new Date(ts * 1000).toLocaleString()

const fmtDuration = (sec: number) => {
  if (sec < 1) return '<1s'
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}m ${s}s`
}

const jobDuration = (j: JobRow): number => {
  const end = j.finished_at ?? j.updated_at
  return Math.max(0, end - j.created_at)
}

export default function LogsPage() {
  const [jobs, setJobs] = useState<JobRow[]>([])
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'done' | 'failed'>('all')
  const [kindFilter, setKindFilter] = useState<string>('')
  const [userFilter, setUserFilter] = useState<string>('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = () => {
    const qs = new URLSearchParams({ limit: '100', include_events: '1' })
    if (kindFilter) qs.set('kind', kindFilter)
    if (userFilter) qs.set('user', userFilter)
    if (statusFilter === 'active') qs.set('active', '1')
    fetch(`/api/jobs?${qs.toString()}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data: JobRow[]) => {
        let filtered = data
        if (statusFilter === 'done') filtered = filtered.filter((j) => j.status === 'done')
        if (statusFilter === 'failed')
          filtered = filtered.filter((j) => j.status === 'failed' || j.status === 'cancelled')
        setJobs(filtered)
        setError('')
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
    // Re-create the interval whenever filters change so the URL params follow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, kindFilter, userFilter])

  const users = useMemo(() => {
    const s = new Set<string>()
    for (const j of jobs) if (j.user) s.add(j.user)
    return Array.from(s).sort()
  }, [jobs])

  const kinds = useMemo(() => {
    const s = new Set<string>()
    for (const j of jobs) s.add(typeof j.kind === 'string' ? j.kind : String(j.kind))
    return Array.from(s).sort()
  }, [jobs])

  const toggle = (id: string) => setExpanded((p) => ({ ...p, [id]: !p[id] }))

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Logs</h1>
          <p className="text-sm text-gray-500 mt-1">
            Every long-running job: separation, beatmap generation, vocal beatmaps,
            transcription, publishes. Click a row to see its full event log.
          </p>
        </div>
        <button
          onClick={load}
          className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-md text-xs font-medium text-gray-300"
        >
          Refresh
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s.key}
              onClick={() => setStatusFilter(s.key)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                statusFilter === s.key
                  ? 'bg-jam-600/30 text-jam-200 border border-jam-600/50'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700 border border-gray-800'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <select
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300"
        >
          <option value="">All kinds</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k] || k}
            </option>
          ))}
        </select>
        <select
          value={userFilter}
          onChange={(e) => setUserFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300"
        >
          <option value="">All users</option>
          {users.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="bg-red-900/40 border border-red-800 rounded p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {loading && jobs.length === 0 && (
        <div className="text-sm text-gray-500">Loading…</div>
      )}

      {!loading && jobs.length === 0 && (
        <div className="text-sm text-gray-500">No jobs match these filters.</div>
      )}

      <div className="space-y-1">
        {jobs.map((j) => {
          const isOpen = !!expanded[j.id]
          const dur = jobDuration(j)
          return (
            <div key={j.id} className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
              <button
                onClick={() => toggle(j.id)}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-800/50 transition-colors"
              >
                <span className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${STATUS_COLORS[j.status] || ''}`}>
                  {j.status}
                </span>
                <span className="text-xs text-gray-500 w-28 shrink-0">
                  {KIND_LABELS[j.kind as string] || j.kind}
                </span>
                <span className="text-sm text-gray-200 flex-1 truncate">
                  {j.title || j.id}
                </span>
                <span className="text-xs text-gray-500 w-20 text-right">
                  {j.user || '—'}
                </span>
                <span className="text-xs text-gray-500 w-32 text-right hidden sm:inline">
                  {fmtTime(j.created_at)}
                </span>
                <span className="text-xs text-gray-500 w-16 text-right tabular-nums">
                  {fmtDuration(dur)}
                </span>
                <span className="text-gray-600 text-xs w-4 text-right">{isOpen ? '▾' : '▸'}</span>
              </button>
              {isOpen && (
                <div className="border-t border-gray-800 bg-gray-950/50 px-4 py-3 space-y-2">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <div>
                      <div className="text-gray-600 text-[10px] uppercase tracking-wider">Job ID</div>
                      <div className="text-gray-300 font-mono">{j.id}</div>
                    </div>
                    <div>
                      <div className="text-gray-600 text-[10px] uppercase tracking-wider">Started</div>
                      <div className="text-gray-300">{fmtTime(j.created_at)}</div>
                    </div>
                    <div>
                      <div className="text-gray-600 text-[10px] uppercase tracking-wider">
                        {j.finished_at ? 'Finished' : 'Last update'}
                      </div>
                      <div className="text-gray-300">{fmtTime(j.finished_at ?? j.updated_at)}</div>
                    </div>
                    <div>
                      <div className="text-gray-600 text-[10px] uppercase tracking-wider">Progress</div>
                      <div className="text-gray-300">{j.progress}%</div>
                    </div>
                    {j.track_id && (
                      <div>
                        <div className="text-gray-600 text-[10px] uppercase tracking-wider">Track</div>
                        <div className="text-gray-300 font-mono">{j.track_id}</div>
                      </div>
                    )}
                    {j.beatmap_id && (
                      <div>
                        <div className="text-gray-600 text-[10px] uppercase tracking-wider">Beatmap</div>
                        <div className="text-gray-300 font-mono">{j.beatmap_id}</div>
                      </div>
                    )}
                  </div>

                  {j.error && (
                    <div className="bg-red-900/30 border border-red-800/60 rounded p-2 text-xs text-red-200">
                      <div className="text-[10px] uppercase tracking-wider text-red-400 mb-1">Error</div>
                      {j.error}
                    </div>
                  )}

                  {j.metadata && Object.keys(j.metadata).length > 0 && (
                    <details className="text-xs">
                      <summary className="text-gray-500 hover:text-gray-300 cursor-pointer">
                        Result metadata
                      </summary>
                      <pre className="mt-1 p-2 bg-black/40 rounded text-gray-400 overflow-x-auto text-[11px] leading-relaxed">
{JSON.stringify(j.metadata, null, 2)}
                      </pre>
                    </details>
                  )}

                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-gray-600 mb-1">
                      Event log ({(j.event_log || []).length})
                    </div>
                    <div className="bg-black/40 rounded p-2 max-h-72 overflow-y-auto font-mono text-[11px] leading-relaxed text-gray-400 space-y-0.5">
                      {(j.event_log || []).length === 0 ? (
                        <div className="text-gray-600">No events recorded.</div>
                      ) : (
                        (j.event_log || []).map((e, i) => (
                          <div key={i} className="flex gap-2">
                            <span className="text-gray-600 shrink-0">
                              {new Date(e.ts * 1000).toLocaleTimeString()}
                            </span>
                            <span className="text-jam-300 shrink-0 w-16 truncate">{e.step}</span>
                            <span className="text-gray-500 shrink-0 w-10 text-right">
                              {e.progress >= 0 ? `${e.progress}%` : ''}
                            </span>
                            <span className="text-gray-300 truncate">{e.message}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
