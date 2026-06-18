// web/frontend/src/pages/CalibrationPage.tsx
import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'

interface Row {
  track_id: string
  song_name: string
  artist: string
  stem: string
  instrument: string
  beatmap_id: string
  preset: string | null
  active: boolean
  difficulty: string
  section: string
  pct_of_expert_gpm: number | null
  total_gems: number
  total_notes: number
  total_holds: number
  total_chords: number
  total_chord_holds: number
  total_slides: number
  total_chord_slides: number
  open_notes: number
  hold_pct: number
  chord_pct: number
  lane_lo: number | null
  lane_hi: number | null
  distinct_lanes: number
  duration_s: number
  gems_per_min: number
  peak_nps: number
  busiest_measure: number
  min_gap_s: number | null
  longest_run: number
  avg_chord_size: number
}

type MetricSummary = { min: number; q1: number; median: number; q3: number; max: number; mean: number; count: number }
type Summary = Record<string, Record<string, MetricSummary>>

interface CompareResponse {
  rows: Row[]
  summary: Summary
  skipped: { track_id: string; beatmap_id: string; reason: string }[]
}

const DIFFICULTY_ORDER = ['Expert', 'Hard', 'Medium', 'Easy']

// Columns: key, header, numeric (drives sort + outliers), desc (hover tooltip), optional formatter.
const COLUMNS: { key: keyof Row; label: string; numeric: boolean; desc: string; fmt?: (r: Row) => string }[] = [
  { key: 'song_name', label: 'Song', numeric: false, desc: 'Track — artist and title.', fmt: (r) => (r.artist ? `${r.artist} — ${r.song_name}` : r.song_name) },
  { key: 'instrument', label: 'Instrument', numeric: false, desc: 'Instrument this chart is for, derived from the stem (e.g. Guitar, Drums, Bass).' },
  { key: 'difficulty', label: 'Difficulty', numeric: false, desc: 'Difficulty tier: Expert, Hard, Medium, or Easy.' },
  { key: 'total_gems', label: 'Gems', numeric: true, desc: 'Total individual gem objects. A 2-fret chord counts as 2 gems.' },
  { key: 'gems_per_min', label: 'Gems/min', numeric: true, desc: "Gems per minute over the chart's full length — overall note density." },
  { key: 'pct_of_expert_gpm', label: '% of Expert', numeric: true, desc: "This chart's gems/min as a percentage of its own Expert tier. Flags uneven Easy→Expert difficulty staircases.", fmt: (r) => (r.pct_of_expert_gpm == null ? '—' : `${r.pct_of_expert_gpm}%`) },
  { key: 'peak_nps', label: 'Peak NPS', numeric: true, desc: 'Peak density: the most note-groups packed into any 1-second window (a chord counts as one hit).' },
  // numeric: false intentionally — busiest_measure is a bar index; outlier shading on an index is meaningless
  { key: 'busiest_measure', label: 'Busy bar', numeric: false, desc: 'Bar (measure) number where peak density occurs. Assumes 4/4.' },
  { key: 'total_notes', label: 'Notes', numeric: true, desc: 'Total note-groups (strums). Simultaneous gems count as one note-group.' },
  { key: 'total_holds', label: 'Holds', numeric: true, desc: 'Sustained notes, including chord holds and open holds.' },
  { key: 'total_chords', label: 'Strum chords', numeric: true, desc: 'Strummed 2-fret chords only. Chord holds and slide chords are counted in their own columns.' },
  { key: 'total_chord_holds', label: 'Chord holds', numeric: true, desc: 'Sustained 2-fret chords.' },
  { key: 'total_slides', label: 'Slides', numeric: true, desc: 'Single-fret slide notes.' },
  { key: 'total_chord_slides', label: 'Slide chords', numeric: true, desc: 'Two-fret (adjacent) chord slides.' },
  { key: 'open_notes', label: 'Opens', numeric: true, desc: 'Open notes — strummed with no fret held.' },
  { key: 'avg_chord_size', label: 'Avg chord', numeric: true, desc: 'Average number of simultaneous gems across chords (note-groups with 2+ frets).' },
  { key: 'hold_pct', label: 'Hold %', numeric: true, desc: 'Percentage of note-groups that are holds.' },
  { key: 'chord_pct', label: 'Chord %', numeric: true, desc: 'Percentage of note-groups that are chords (includes strum chords, chord holds, and slide chords).' },
  { key: 'distinct_lanes', label: 'Lanes', numeric: true, desc: 'Number of distinct colored frets used.' },
  { key: 'lane_lo', label: 'Range', numeric: false, desc: 'Lowest–highest colored fret used (0 = green … 4 = orange).', fmt: (r) => (r.lane_lo == null ? '—' : `${r.lane_lo}–${r.lane_hi}`) },
  { key: 'min_gap_s', label: 'Min gap (s)', numeric: true, desc: 'Shortest time between consecutive note-groups, in seconds. Captures hand-speed demand.', fmt: (r) => (r.min_gap_s == null ? '—' : r.min_gap_s.toFixed(3)) },
  { key: 'longest_run', label: 'Run', numeric: true, desc: 'Longest streak of consecutive fast notes (gaps ≤ 0.25s).' },
  { key: 'duration_s', label: 'Dur (s)', numeric: true, desc: 'Chart length in seconds (time of the last note or sustain end).' },
]

// Outlier: cell value vs its difficulty tier's IQR fence. Needs >=4 samples.
function outlierClass(row: Row, key: keyof Row, summary: Summary): string {
  const tier = summary[row.difficulty]
  const s = tier?.[key as string]
  const v = row[key]
  if (!s || s.count < 4 || typeof v !== 'number') return ''
  const iqr = s.q3 - s.q1
  if (iqr <= 0) return ''
  if (v > s.q3 + 1.5 * iqr) return 'bg-red-900/40 text-red-200'
  if (v < s.q1 - 1.5 * iqr) return 'bg-amber-900/30 text-amber-200'
  return ''
}

function fmtCell(r: Row, col: (typeof COLUMNS)[number]): string {
  if (col.fmt) return col.fmt(r)
  const v = r[col.key]
  return v == null ? '—' : String(v)
}

export default function CalibrationPage() {
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const stateIds = (location.state as { trackIds?: string[] } | null)?.trackIds
  const queryIds = (searchParams.get('ids') || '').split(',').filter(Boolean)
  const trackIds = stateIds && stateIds.length ? stateIds : queryIds

  const [data, setData] = useState<CompareResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sortKey, setSortKey] = useState<keyof Row>('gems_per_min')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [instrumentFilter, setInstrumentFilter] = useState<string>('')
  const [difficultyFilter, setDifficultyFilter] = useState<string>('')
  const [primaryOnly, setPrimaryOnly] = useState(false)

  useEffect(() => {
    if (!trackIds.length) {
      setError('No tracks selected.')
      setLoading(false)
      return
    }
    setLoading(true)
    fetch('/api/calibration/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ track_ids: trackIds }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((d: CompareResponse) => setData(d))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackIds.join(',')])

  const instruments = useMemo(
    () => Array.from(new Set((data?.rows || []).map((r) => r.instrument))).sort(),
    [data],
  )

  const rows = useMemo(() => {
    let rs = data?.rows || []
    if (primaryOnly) rs = rs.filter((r) => r.active)
    if (instrumentFilter) rs = rs.filter((r) => r.instrument === instrumentFilter)
    if (difficultyFilter) rs = rs.filter((r) => r.difficulty === difficultyFilter)
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rs].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv)) * dir
    })
  }, [data, primaryOnly, instrumentFilter, difficultyFilter, sortKey, sortDir])

  function setSort(key: keyof Row) {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  function toTSV(): string {
    const header = COLUMNS.map((c) => c.label).join('\t')
    const body = rows.map((r) => COLUMNS.map((c) => fmtCell(r, c)).join('\t')).join('\n')
    return `${header}\n${body}`
  }

  function copyTSV() {
    navigator.clipboard.writeText(toTSV()).catch(() => {})
  }

  function downloadCSV() {
    const csv = [
      COLUMNS.map((c) => `"${c.label}"`).join(','),
      ...rows.map((r) => COLUMNS.map((c) => `"${fmtCell(r, c).replace(/"/g, '""')}"`).join(',')),
    ].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'calibration.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200 p-6 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Difficulty Calibration</h1>
          <p className="text-gray-500 text-sm mt-1">
            {rows.length} chart{rows.length === 1 ? '' : 's'} across {trackIds.length} song
            {trackIds.length === 1 ? '' : 's'}. Cells far outside their difficulty tier are highlighted.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={copyTSV} className="px-3 py-1.5 rounded-md text-sm bg-gray-800 hover:bg-gray-700">Copy TSV</button>
          <button onClick={downloadCSV} className="px-3 py-1.5 rounded-md text-sm bg-gray-800 hover:bg-gray-700">Download CSV</button>
          <Link to="/" className="px-3 py-1.5 rounded-md text-sm bg-gray-800 hover:bg-gray-700">← Library</Link>
        </div>
      </div>

      <div className="flex items-center gap-3 text-sm">
        <select
          value={instrumentFilter}
          onChange={(e) => setInstrumentFilter(e.target.value)}
          className="bg-gray-900 border border-gray-800 rounded-md px-2 py-1"
        >
          <option value="">All instruments</option>
          {instruments.map((i) => (<option key={i} value={i}>{i}</option>))}
        </select>
        <select
          value={difficultyFilter}
          onChange={(e) => setDifficultyFilter(e.target.value)}
          className="bg-gray-900 border border-gray-800 rounded-md px-2 py-1"
        >
          <option value="">All difficulties</option>
          {DIFFICULTY_ORDER.map((d) => (<option key={d} value={d}>{d}</option>))}
        </select>
        <label
          className="flex items-center gap-2 cursor-pointer select-none text-gray-300"
          title="Show only each stem's primary (active) chart, hiding alternate beatmaps."
        >
          <input
            type="checkbox"
            className="w-4 h-4 accent-jam-500 cursor-pointer"
            checked={primaryOnly}
            onChange={(e) => setPrimaryOnly(e.target.checked)}
          />
          Primary chart(s) only
        </label>
      </div>

      {loading && <p className="text-gray-400">Loading…</p>}
      {error && <p className="text-red-400">{error}</p>}

      {data && !loading && (
        <>
          <div className="overflow-x-auto border border-gray-800 rounded-lg">
            <table className="text-xs whitespace-nowrap w-full">
              <thead className="bg-gray-900 sticky top-0">
                <tr>
                  {COLUMNS.map((c) => (
                    <th
                      key={String(c.key)}
                      onClick={() => setSort(c.key)}
                      title={c.desc}
                      className="px-2 py-2 text-left font-semibold cursor-pointer hover:text-jam-300 border-b border-gray-800 decoration-dotted decoration-gray-600 underline-offset-4 hover:underline"
                    >
                      {c.label}{sortKey === c.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.beatmap_id}-${r.section}-${i}`} className="odd:bg-gray-900/40 hover:bg-gray-800/40">
                    {COLUMNS.map((c) => (
                      <td key={String(c.key)} className={`px-2 py-1 ${c.numeric ? outlierClass(r, c.key, data.summary) : ''}`}>
                        {fmtCell(r, c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <SummaryTables summary={data.summary} />

          {data.skipped.length > 0 && (
            <p className="text-amber-400/80 text-xs">
              {data.skipped.length} beatmap(s) couldn't be analyzed (missing/unreadable chart).
            </p>
          )}
        </>
      )}
    </div>
  )
}

// Per-difficulty summary (median / min / max) for the key calibration metrics.
function SummaryTables({ summary }: { summary: Summary }) {
  // Descriptions reused from the main table's column definitions.
  const descOf = (key: string) => COLUMNS.find((c) => c.key === key)?.desc
  const metricKeys: { key: string; label: string }[] = [
    { key: 'gems_per_min', label: 'Gems/min' },
    { key: 'peak_nps', label: 'Peak NPS' },
    { key: 'avg_chord_size', label: 'Avg chord' },
    { key: 'hold_pct', label: 'Hold %' },
    { key: 'min_gap_s', label: 'Min gap (s)' },
    { key: 'distinct_lanes', label: 'Lanes' },
  ]
  const tiers = DIFFICULTY_ORDER.filter((t) => summary[t])
  if (!tiers.length) return null
  return (
    <div className="space-y-2">
      <h2 className="text-lg font-semibold">Per-difficulty baselines (median · min–max)</h2>
      <div className="overflow-x-auto border border-gray-800 rounded-lg">
        <table className="text-xs w-full">
          <thead className="bg-gray-900">
            <tr>
              <th className="px-2 py-2 text-left border-b border-gray-800">Tier</th>
              {metricKeys.map((m) => (
                <th
                  key={m.key}
                  title={descOf(m.key)}
                  className="px-2 py-2 text-left border-b border-gray-800 decoration-dotted decoration-gray-600 underline-offset-4 hover:underline"
                >
                  {m.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tiers.map((t) => (
              <tr key={t} className="odd:bg-gray-900/40">
                <td className="px-2 py-1 font-medium">{t}</td>
                {metricKeys.map((m) => {
                  const s = summary[t][m.key]
                  return (
                    <td key={m.key} className="px-2 py-1">
                      {s ? `${s.median} · ${s.min}–${s.max}` : '—'}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
