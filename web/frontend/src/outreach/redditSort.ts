// Pure sort/filter helpers for the Outreach → Reddit table. Kept out of the
// page component so the ordering logic can be unit-tested in isolation.

export type Verdict = 'Allowed' | 'Limited' | 'ModApproval' | 'Banned' | 'Unknown'
export type Status = 'Not posted' | 'Posted' | 'Approved' | 'Removed' | 'Banned' | 'Awaiting mod'

export interface RedditRow {
  name: string
  url: string
  category: string
  subscribers: number
  subscribers_approx: boolean
  subscribers_as_of?: string
  self_promo_verdict: Verdict
  self_promo_detail: string
  discord: string | null
  description?: string
  custom?: boolean
  // tracking
  status: Status
  last_posted: string | null
  notes: string
}

export type SortCol =
  | 'name'
  | 'category'
  | 'subscribers'
  | 'self_promo_verdict'
  | 'status'
  | 'last_posted'

export type SortDir = 'asc' | 'desc'

// Verdict ranked best-to-worst for us: where we can freely post sorts first.
const VERDICT_RANK: Record<Verdict, number> = {
  Allowed: 0,
  Limited: 1,
  ModApproval: 2,
  Unknown: 3,
  Banned: 4,
}

// Status ranked by "how far along / how bad": untouched first, bans last.
const STATUS_RANK: Record<Status, number> = {
  'Not posted': 0,
  'Awaiting mod': 1,
  Posted: 2,
  Approved: 3,
  Removed: 4,
  Banned: 5,
}

function compare(a: RedditRow, b: RedditRow, col: SortCol): number {
  switch (col) {
    case 'subscribers':
      return a.subscribers - b.subscribers
    case 'self_promo_verdict':
      return VERDICT_RANK[a.self_promo_verdict] - VERDICT_RANK[b.self_promo_verdict]
    case 'status':
      return STATUS_RANK[a.status] - STATUS_RANK[b.status]
    case 'last_posted': {
      // Nulls (never posted) sort last in ascending order.
      const av = a.last_posted || ''
      const bv = b.last_posted || ''
      if (av === bv) return 0
      if (!av) return 1
      if (!bv) return -1
      return av < bv ? -1 : 1
    }
    default: {
      const av = String(a[col] ?? '').toLowerCase()
      const bv = String(b[col] ?? '').toLowerCase()
      return av < bv ? -1 : av > bv ? 1 : 0
    }
  }
}

export function sortRows(rows: RedditRow[], col: SortCol, dir: SortDir): RedditRow[] {
  const sign = dir === 'asc' ? 1 : -1
  // Stable sort with the subreddit name as a deterministic tiebreak so equal
  // keys don't jump around between renders.
  return [...rows].sort((a, b) => {
    const c = compare(a, b, col)
    if (c !== 0) return c * sign
    return a.name.localeCompare(b.name)
  })
}

export function filterRows(rows: RedditRow[], query: string, category: string | null): RedditRow[] {
  const q = query.trim().toLowerCase()
  return rows.filter((r) => {
    if (category && r.category !== category) return false
    if (!q) return true
    return (
      r.name.toLowerCase().includes(q) ||
      (r.description || '').toLowerCase().includes(q) ||
      r.self_promo_detail.toLowerCase().includes(q) ||
      r.notes.toLowerCase().includes(q)
    )
  })
}
