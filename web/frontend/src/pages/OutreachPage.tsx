import { useEffect, useMemo, useState } from 'react'

import {
  filterRows,
  RedditRow,
  sortRows,
  SortCol,
  SortDir,
  Status,
  Verdict,
} from '../outreach/redditSort'

const STATUS_OPTIONS: Status[] = ['Not posted', 'Awaiting mod', 'Posted', 'Approved', 'Removed', 'Banned']

const VERDICT_STYLE: Record<Verdict, { label: string; cls: string }> = {
  Allowed: { label: 'Allowed', cls: 'bg-green-900/40 text-green-300 border-green-800' },
  Limited: { label: 'Limited', cls: 'bg-yellow-900/40 text-yellow-300 border-yellow-800' },
  ModApproval: { label: 'Mod approval', cls: 'bg-orange-900/40 text-orange-300 border-orange-800' },
  Banned: { label: 'Banned', cls: 'bg-red-900/40 text-red-300 border-red-800' },
  Unknown: { label: 'Unknown', cls: 'bg-gray-800 text-gray-400 border-gray-700' },
}

const STATUS_STYLE: Record<Status, string> = {
  'Not posted': 'bg-gray-800 text-gray-400 border-gray-700',
  'Awaiting mod': 'bg-blue-900/40 text-blue-300 border-blue-800',
  Posted: 'bg-indigo-900/40 text-indigo-300 border-indigo-800',
  Approved: 'bg-green-900/40 text-green-300 border-green-800',
  Removed: 'bg-orange-900/40 text-orange-300 border-orange-800',
  Banned: 'bg-red-900/40 text-red-300 border-red-800',
}

function fmtSubs(n: number, approx: boolean): string {
  const s = n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n)
  return approx ? `~${s}` : s
}

const CHANNELS = [
  { key: 'reddit', label: 'Reddit', enabled: true },
  { key: 'discord', label: 'Discord', enabled: false },
  { key: 'twitter', label: 'X / Twitter', enabled: false },
] as const

export default function OutreachPage() {
  const [rows, setRows] = useState<RedditRow[]>([])
  const [asOf, setAsOf] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sortCol, setSortCol] = useState<SortCol>('subscribers')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/outreach/reddit')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (cancelled) return
        setRows(d.rows)
        setAsOf(d.as_of)
      })
      .catch((e) => !cancelled && setError((e as Error).message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  const categories = useMemo(() => Array.from(new Set(rows.map((r) => r.category))).sort(), [rows])

  const visible = useMemo(
    () => sortRows(filterRows(rows, query, category), sortCol, sortDir),
    [rows, query, category, sortCol, sortDir],
  )

  const patch = async (name: string, fields: Partial<Pick<RedditRow, 'status' | 'last_posted' | 'notes' | 'discord'>>) => {
    // Optimistic: update local state, then persist. On failure, surface the error.
    setRows((prev) => prev.map((r) => (r.name === name ? { ...r, ...fields } : r)))
    try {
      const res = await fetch(`/api/outreach/reddit/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      })
      if (!res.ok) setError(`Save failed for ${name}: HTTP ${res.status}`)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const toggleSort = (col: SortCol) => {
    if (col === sortCol) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortCol(col)
      // Numbers default to biggest-first; text to A-Z.
      setSortDir(col === 'subscribers' ? 'desc' : 'asc')
    }
  }

  const Header = ({ col, children, className }: { col: SortCol; children: React.ReactNode; className?: string }) => (
    <th
      onClick={() => toggleSort(col)}
      className={`px-3 py-2 text-left font-medium text-gray-400 cursor-pointer select-none hover:text-gray-200 ${className || ''}`}
    >
      {children}
      {sortCol === col && <span className="ml-1 text-jam-300">{sortDir === 'asc' ? '▲' : '▼'}</span>}
    </th>
  )

  const summary = useMemo(() => {
    const total = rows.length
    const posted = rows.filter((r) => r.status !== 'Not posted').length
    const safe = rows.filter((r) => r.self_promo_verdict === 'Allowed' || r.self_promo_verdict === 'Limited').length
    return { total, posted, safe }
  }, [rows])

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Outreach</h1>
        <p className="text-sm text-gray-500 mt-1">
          Where we can post about Jamsesh, the rules for each community, and where we've already posted. Subscriber
          counts are a snapshot{asOf ? ` (as of ${asOf})` : ''} — they drift over time.
        </p>
      </div>

      {/* Channel subtabs */}
      <div className="flex gap-1 border-b border-gray-800">
        {CHANNELS.map((c) => (
          <button
            key={c.key}
            disabled={!c.enabled}
            title={c.enabled ? undefined : 'Coming soon'}
            className={`px-3 py-1.5 text-sm font-medium rounded-t-md -mb-px border-b-2 transition-colors ${
              c.enabled
                ? 'border-jam-500 text-jam-300 bg-jam-600/10'
                : 'border-transparent text-gray-600 cursor-not-allowed'
            }`}
          >
            {c.label}
            {!c.enabled && <span className="ml-1 text-[10px] text-gray-700">soon</span>}
          </button>
        ))}
      </div>

      {error && <div className="bg-red-900/30 border border-red-800 rounded p-3 text-sm text-red-200">{error}</div>}

      {loading ? (
        <div className="text-gray-500 text-sm">Loading…</div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search subreddits, rules, notes…"
              className="flex-1 min-w-[200px] bg-gray-900 border border-gray-800 rounded px-3 py-1.5 text-gray-200 placeholder-gray-600"
            />
            <select
              value={category || ''}
              onChange={(e) => setCategory(e.target.value || null)}
              className="bg-gray-900 border border-gray-800 rounded px-2 py-1.5 text-gray-300"
            >
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <span className="text-gray-600">
              {visible.length}/{summary.total} shown · {summary.posted} posted · {summary.safe} promo-friendly
            </span>
          </div>

          <div className="overflow-x-auto border border-gray-800 rounded-lg">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-900/60 border-b border-gray-800">
                <tr>
                  <Header col="name">Subreddit</Header>
                  <Header col="category">Category</Header>
                  <Header col="subscribers" className="text-right">
                    Subscribers
                  </Header>
                  <Header col="self_promo_verdict">Self-promo</Header>
                  <th className="px-3 py-2 text-left font-medium text-gray-400">Rule</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-400">Discord</th>
                  <Header col="status">Status</Header>
                  <Header col="last_posted">Last posted</Header>
                  <th className="px-3 py-2 text-left font-medium text-gray-400">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/70">
                {visible.map((r) => {
                  const v = VERDICT_STYLE[r.self_promo_verdict] || VERDICT_STYLE.Unknown
                  const isOpen = expanded === r.name
                  return (
                    <tr key={r.name} className="hover:bg-gray-900/40 align-top">
                      <td className="px-3 py-2 whitespace-nowrap">
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-jam-300 hover:underline font-medium"
                        >
                          {r.name}
                        </a>
                        {r.description && <div className="text-[11px] text-gray-600 max-w-[220px]">{r.description}</div>}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-gray-400">{r.category}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-300 whitespace-nowrap">
                        {fmtSubs(r.subscribers, r.subscribers_approx)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className={`inline-block px-2 py-0.5 rounded border text-[11px] ${v.cls}`}>{v.label}</span>
                      </td>
                      <td className="px-3 py-2 w-[340px]">
                        <div
                          onClick={() => setExpanded(isOpen ? null : r.name)}
                          className={`cursor-pointer text-gray-400 hover:text-gray-200 ${isOpen ? '' : 'line-clamp-2'}`}
                          title={isOpen ? 'Click to collapse' : 'Click to expand'}
                        >
                          {r.self_promo_detail || '—'}
                        </div>
                      </td>
                      <td className="px-3 py-2 min-w-[150px]">
                        {r.discord && (
                          <a
                            href={r.discord}
                            target="_blank"
                            rel="noreferrer"
                            className="text-indigo-300 hover:underline text-[11px] block mb-0.5 truncate max-w-[150px]"
                            title={r.discord}
                          >
                            Join ↗
                          </a>
                        )}
                        <input
                          key={r.discord || ''}
                          defaultValue={r.discord || ''}
                          onBlur={(e) => {
                            const v = e.target.value.trim()
                            if (v !== (r.discord || '')) patch(r.name, { discord: v || null })
                          }}
                          placeholder="discord.gg/…"
                          className="w-full bg-gray-900 border border-gray-800 rounded px-1.5 py-0.5 text-[11px] text-indigo-200 placeholder-gray-700"
                        />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <select
                          value={r.status}
                          onChange={(e) => patch(r.name, { status: e.target.value as Status })}
                          className={`rounded border px-1.5 py-0.5 text-[11px] ${STATUS_STYLE[r.status]}`}
                        >
                          {STATUS_OPTIONS.map((s) => (
                            <option key={s} value={s} className="bg-gray-900 text-gray-200">
                              {s}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <input
                          type="date"
                          value={r.last_posted || ''}
                          onChange={(e) => patch(r.name, { last_posted: e.target.value || null })}
                          className="bg-gray-900 border border-gray-800 rounded px-1.5 py-0.5 text-[11px] text-gray-300"
                        />
                      </td>
                      <td className="px-3 py-2 min-w-[160px]">
                        <input
                          defaultValue={r.notes}
                          onBlur={(e) => e.target.value !== r.notes && patch(r.name, { notes: e.target.value })}
                          placeholder="…"
                          className="w-full bg-gray-900 border border-gray-800 rounded px-1.5 py-0.5 text-[11px] text-gray-300 placeholder-gray-700"
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-gray-600">
            Status &amp; notes save automatically and are shared across the whole team. Verdict is our read of each
            community's self-promotion rule — always sanity-check the linked rules before posting.
          </p>
        </>
      )}
    </div>
  )
}
