import { useCallback, useEffect, useMemo, useState } from 'react'

type Song = {
  folder: string
  has_ini: boolean
  name: string
  artist: string
  album: string
  genre: string
  year: string
  charter: string
  song_length: string
  local_pulled: boolean
}

const META_FIELDS: Array<{ key: string; label: string; type?: 'text' | 'number' }> = [
  { key: 'name', label: 'Song Name' },
  { key: 'artist', label: 'Artist' },
  { key: 'album', label: 'Album' },
  { key: 'genre', label: 'Genre' },
  { key: 'year', label: 'Year' },
  { key: 'charter', label: 'Charter' },
  { key: 'loading_phrase', label: 'Loading Phrase' },
]

const TIMING_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'delay', label: 'Delay (ms)' },
  { key: 'preview_start_time', label: 'Preview Start (ms)' },
  { key: 'song_length', label: 'Song Length (ms)' },
]

const DIFF_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'diff_band', label: 'Band' },
  { key: 'diff_guitar', label: 'Guitar' },
  { key: 'diff_rhythm', label: 'Rhythm' },
  { key: 'diff_bass', label: 'Bass' },
  { key: 'diff_drums', label: 'Drums' },
  { key: 'diff_keys', label: 'Keys' },
  { key: 'diff_guitar_coop', label: 'Co-op Guitar' },
  { key: 'diff_drums_real', label: 'Pro Drums' },
  { key: 'diff_guitarghl', label: 'GHL Guitar' },
  { key: 'diff_bassghl', label: 'GHL Bass' },
]

export default function GameSongsPage() {
  const [songs, setSongs] = useState<Song[] | null>(null)
  const [listError, setListError] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [meta, setMeta] = useState<Record<string, string> | null>(null)
  const [metaError, setMetaError] = useState('')
  const [busy, setBusy] = useState<string>('') // 'pulling' | 'saving' | 'pushing'
  const [flash, setFlash] = useState('')
  const [sortKey, setSortKey] = useState<keyof Song>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const sorted = useMemo(() => {
    if (!songs) return null
    const NUMERIC_KEYS = new Set(['year', 'song_length'])
    const copy = [...songs]
    copy.sort((a, b) => {
      const av = String(a[sortKey] ?? '')
      const bv = String(b[sortKey] ?? '')
      let cmp: number
      if (NUMERIC_KEYS.has(sortKey)) {
        const an = Number(av)
        const bn = Number(bv)
        const aNum = isNaN(an) ? Infinity : an
        const bNum = isNaN(bn) ? Infinity : bn
        cmp = aNum - bNum
      } else {
        cmp = av.toLowerCase().localeCompare(bv.toLowerCase())
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return copy
  }, [songs, sortKey, sortDir])

  const toggleSort = (key: keyof Song) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const loadList = useCallback(async () => {
    setListError('')
    try {
      const res = await fetch('/api/game-songs')
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `${res.status} ${res.statusText}`)
      }
      setSongs(await res.json())
    } catch (e) {
      setListError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    loadList()
  }, [loadList])

  const startEdit = async (folder: string) => {
    setEditing(folder)
    setMeta(null)
    setMetaError('')
    setFlash('')
    setBusy('pulling')
    try {
      const pullRes = await fetch(`/api/game-songs/${encodeURIComponent(folder)}/pull`, { method: 'POST' })
      if (!pullRes.ok) {
        const err = await pullRes.json().catch(() => ({}))
        throw new Error(err.detail || `Pull failed: ${pullRes.status}`)
      }
      const metaRes = await fetch(`/api/game-songs/${encodeURIComponent(folder)}/meta`)
      if (!metaRes.ok) {
        const err = await metaRes.json().catch(() => ({}))
        throw new Error(err.detail || `Meta fetch failed: ${metaRes.status}`)
      }
      setMeta(await metaRes.json())
    } catch (e) {
      setMetaError((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const updateField = (key: string, value: string) => {
    setMeta((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  const saveLocal = async () => {
    if (!editing || !meta) return
    setBusy('saving')
    setFlash('')
    try {
      const fd = new FormData()
      fd.append('fields', JSON.stringify(meta))
      const res = await fetch(`/api/game-songs/${encodeURIComponent(editing)}/meta`, { method: 'PATCH', body: fd })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Save failed: ${res.status}`)
      }
      setMeta(await res.json())
      setFlash('Saved locally')
    } catch (e) {
      setMetaError((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const pushToRepo = async () => {
    if (!editing) return
    // Save any pending edits first so push reflects what the user sees
    await saveLocal()
    setBusy('pushing')
    setFlash('')
    try {
      const res = await fetch(`/api/game-songs/${encodeURIComponent(editing)}/push`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Push failed: ${res.status}`)
      }
      const { commit_url } = await res.json()
      setFlash(`Pushed to GitHub`)
      if (commit_url) window.open(commit_url, '_blank')
      loadList()
    } catch (e) {
      setMetaError((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const closeEdit = () => {
    setEditing(null)
    setMeta(null)
    setMetaError('')
    setFlash('')
  }

  // ── Edit view ─────────────────────────────────────────────────────────────
  if (editing) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <button onClick={closeEdit} className="text-sm text-gray-400 hover:text-gray-200">
              ← Back to Game Library
            </button>
            <h1 className="text-2xl font-bold mt-1">{editing}</h1>
          </div>
          <div className="flex gap-2">
            <button
              onClick={saveLocal}
              disabled={!meta || !!busy}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 rounded-lg text-sm"
            >
              {busy === 'saving' ? 'Saving...' : 'Save locally'}
            </button>
            <button
              onClick={pushToRepo}
              disabled={!meta || !!busy}
              className="px-4 py-2 bg-jam-600 hover:bg-jam-500 disabled:opacity-40 rounded-lg text-sm font-medium"
            >
              {busy === 'pushing' ? 'Pushing...' : 'Push to game repo'}
            </button>
          </div>
        </div>

        {busy === 'pulling' && (
          <div className="flex items-center gap-3 text-gray-400">
            <div className="animate-spin h-5 w-5 border-2 border-jam-400 border-t-transparent rounded-full" />
            Pulling song folder from GitHub...
          </div>
        )}

        {metaError && (
          <div className="bg-red-900/30 border border-red-800 rounded-lg p-4 text-red-400">{metaError}</div>
        )}

        {flash && (
          <div className="bg-emerald-900/30 border border-emerald-800 rounded-lg p-3 text-emerald-300 text-sm">
            {flash}
          </div>
        )}

        {meta && Object.keys(meta).length === 0 && (
          <div className="bg-amber-900/20 border border-amber-800/60 rounded-lg p-3 text-amber-300 text-sm">
            No <code className="font-mono">song.ini</code> on this folder — fill in fields and Save to create one.
          </div>
        )}

        {meta && (
          <div className="space-y-6">
            <Section title="Metadata">
              <Grid>
                {META_FIELDS.map((f) => (
                  <Field key={f.key} label={f.label}>
                    <input
                      type="text"
                      value={meta[f.key] ?? ''}
                      onChange={(e) => updateField(f.key, e.target.value)}
                      className="block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-jam-500"
                    />
                  </Field>
                ))}
              </Grid>
            </Section>

            <Section title="Timing">
              <Grid cols={3}>
                {TIMING_FIELDS.map((f) => (
                  <Field key={f.key} label={f.label}>
                    <input
                      type="number"
                      value={meta[f.key] ?? ''}
                      onChange={(e) => updateField(f.key, e.target.value)}
                      className="block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-jam-500"
                    />
                  </Field>
                ))}
              </Grid>
            </Section>

            <Section title="Difficulties">
              <p className="text-xs text-gray-600 mb-3">-1 = uncharted · 0–6 = difficulty tier</p>
              <Grid cols={5}>
                {DIFF_FIELDS.map((f) => (
                  <Field key={f.key} label={f.label}>
                    <input
                      type="number"
                      min={-1}
                      max={6}
                      value={meta[f.key] ?? ''}
                      onChange={(e) => updateField(f.key, e.target.value)}
                      className="block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-jam-500 text-center"
                    />
                  </Field>
                ))}
              </Grid>
            </Section>

            <Section title="Other song.ini fields">
              <p className="text-xs text-gray-600 mb-2">
                Any field not in the forms above. One <code className="text-gray-400">key = value</code> per line.
              </p>
              <textarea
                rows={8}
                value={Object.entries(meta)
                  .filter(
                    ([k]) =>
                      !META_FIELDS.some((f) => f.key === k) &&
                      !TIMING_FIELDS.some((f) => f.key === k) &&
                      !DIFF_FIELDS.some((f) => f.key === k),
                  )
                  .map(([k, v]) => `${k} = ${v}`)
                  .join('\n')}
                onChange={(e) => {
                  const known = new Set<string>([
                    ...META_FIELDS.map((f) => f.key),
                    ...TIMING_FIELDS.map((f) => f.key),
                    ...DIFF_FIELDS.map((f) => f.key),
                  ])
                  const next: Record<string, string> = {}
                  for (const [k, v] of Object.entries(meta)) if (known.has(k)) next[k] = v
                  for (const line of e.target.value.split('\n')) {
                    const idx = line.indexOf('=')
                    if (idx < 0) continue
                    const key = line.slice(0, idx).trim().toLowerCase()
                    const val = line.slice(idx + 1).trim()
                    if (key) next[key] = val
                  }
                  setMeta(next)
                }}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-jam-500"
              />
            </Section>
          </div>
        )}
      </div>
    )
  }

  // ── List view ─────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Game Library</h1>
          <p className="text-gray-500 mt-1">Songs published to the Jamsesh game repo.</p>
        </div>
        <button
          onClick={loadList}
          className="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200 border border-gray-800 rounded-lg"
        >
          Refresh
        </button>
      </div>

      {listError && (
        <div className="bg-red-900/30 border border-red-800 rounded-lg p-4 text-red-400">
          {listError}
          {listError.includes('GITHUB_TOKEN') && (
            <p className="text-red-300/80 text-sm mt-2">
              Set <code>GITHUB_TOKEN</code> in <code>web/.env</code> to a PAT with <code>repo</code> scope, then restart the backend.
            </p>
          )}
        </div>
      )}

      {songs === null && !listError && (
        <div className="flex items-center gap-3 text-gray-400">
          <div className="animate-spin h-5 w-5 border-2 border-jam-400 border-t-transparent rounded-full" />
          Loading songs from GitHub...
        </div>
      )}

      {songs && songs.length === 0 && !listError && (
        <div className="text-gray-500 text-sm">No songs in SongInbox yet.</div>
      )}

      {sorted && sorted.length > 0 && (
        <div className="overflow-x-auto border border-gray-800 rounded-xl">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-400 uppercase text-xs tracking-wider">
              <tr>
                <SortHeader col="name" label="Name" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
                <SortHeader col="artist" label="Artist" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
                <SortHeader col="album" label="Album" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
                <SortHeader col="genre" label="Genre" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
                <SortHeader col="year" label="Year" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
                <SortHeader col="song_length" label="Length" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
                <SortHeader col="charter" label="Charter" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
                <th className="px-3 py-2 text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {sorted.map((s) => (
                <tr key={s.folder} className="hover:bg-gray-900/50">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-100 truncate">{s.name || s.folder}</span>
                      {s.local_pulled && (
                        <span className="text-xs px-1.5 py-0.5 bg-emerald-900/40 text-emerald-400 rounded">
                          local
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-gray-300">{s.artist}</td>
                  <td className="px-3 py-2 text-gray-400">{s.album}</td>
                  <td className="px-3 py-2 text-gray-400">{s.genre}</td>
                  <td className="px-3 py-2 text-gray-400">{s.year}</td>
                  <td className="px-3 py-2 text-gray-400 tabular-nums">{formatLength(s.song_length)}</td>
                  <td className="px-3 py-2 text-gray-400">{s.charter}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => startEdit(s.folder)}
                      className="px-3 py-1 bg-jam-600 hover:bg-jam-500 text-white rounded-md text-xs font-medium"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function SortHeader({
  col,
  label,
  sortKey,
  sortDir,
  onClick,
}: {
  col: keyof Song
  label: string
  sortKey: keyof Song
  sortDir: 'asc' | 'desc'
  onClick: (col: keyof Song) => void
}) {
  const active = sortKey === col
  return (
    <th
      onClick={() => onClick(col)}
      className={`px-3 py-2 text-left cursor-pointer select-none hover:text-gray-200 ${active ? 'text-gray-200' : ''}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={active ? '' : 'text-gray-700'}>
          {active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </span>
    </th>
  )
}

function formatLength(ms: string): string {
  const n = Number(ms)
  if (!ms || isNaN(n) || n <= 0) return ''
  const total = Math.round(n / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// ── Small layout helpers ────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
      <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">{title}</h3>
      {children}
    </div>
  )
}

function Grid({ cols = 2, children }: { cols?: number; children: React.ReactNode }) {
  const map: Record<number, string> = {
    2: 'grid-cols-1 sm:grid-cols-2',
    3: 'grid-cols-2 sm:grid-cols-3',
    5: 'grid-cols-3 sm:grid-cols-5',
  }
  return <div className={`grid ${map[cols] || map[2]} gap-3`}>{children}</div>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-gray-500">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  )
}
