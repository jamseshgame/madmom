import { useEffect, useState } from 'react'

export interface BeatmapRecord {
  id: string
  stem: string
  generated_at: number
  folder_name: string
  song_name: string
  active?: boolean
}

const STEM_COLORS: Record<string, string> = {
  vocals: 'text-pink-400',
  drums: 'text-amber-400',
  bass: 'text-green-400',
  rhythm: 'text-green-400',
  guitar: 'text-orange-400',
  piano: 'text-violet-400',
  other: 'text-blue-400',
  song: 'text-gray-300',
}

const STEM_LABELS: Record<string, string> = {
  vocals: 'Vocals',
  drums: 'Drums',
  bass: 'Bass',
  rhythm: 'Bass',
  guitar: 'Guitar',
  piano: 'Piano',
  other: 'Other',
  song: 'Master Mix',
}

const DIFF_ORDER = ['expert_stats', 'hard_stats', 'medium_stats', 'easy_stats']
const DIFF_LABELS: Record<string, string> = {
  expert_stats: 'Expert',
  hard_stats: 'Hard',
  medium_stats: 'Medium',
  easy_stats: 'Easy',
}
const LANE_LABELS = ['Green (0)', 'Red (1)', 'Yellow (2)', 'Blue (3)', 'Orange (4)']

export function formatBeatmapTimestamp(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export default function BeatmapStatsModal({
  trackId,
  beatmap,
  onClose,
  onDeleted,
  onRenamed,
  onCloned,
}: {
  trackId: string
  beatmap: BeatmapRecord
  onClose: () => void
  onDeleted?: () => void
  onRenamed?: (record: BeatmapRecord) => void
  onCloned?: (record: BeatmapRecord) => void
}) {
  const [data, setData] = useState<{
    sections: Record<string, Record<string, string>>
    chart_bytes: number
  } | null>(null)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [draftName, setDraftName] = useState(beatmap.song_name)
  const [savingName, setSavingName] = useState(false)
  const [renameError, setRenameError] = useState('')
  const [currentName, setCurrentName] = useState(beatmap.song_name)
  const [cloning, setCloning] = useState(false)
  const [cloneError, setCloneError] = useState('')

  const handleRename = async () => {
    const next = draftName.trim()
    if (!next || next === currentName) {
      setEditingName(false)
      return
    }
    setSavingName(true)
    setRenameError('')
    try {
      const fd = new FormData()
      fd.append('song_name', next)
      const res = await fetch(`/api/tracks/${trackId}/beatmaps/${beatmap.id}`, {
        method: 'PATCH',
        body: fd,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Rename failed (${res.status})`)
      }
      const updated = (await res.json()) as BeatmapRecord
      setCurrentName(updated.song_name)
      setEditingName(false)
      if (onRenamed) onRenamed(updated)
    } catch (e) {
      setRenameError((e as Error).message)
    } finally {
      setSavingName(false)
    }
  }

  useEffect(() => {
    fetch(`/api/tracks/${trackId}/beatmaps/${beatmap.id}/stats`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then(setData)
      .catch((e) => setError((e as Error).message))
  }, [trackId, beatmap.id])

  const handleClone = async () => {
    setCloning(true)
    setCloneError('')
    try {
      const res = await fetch(`/api/tracks/${trackId}/beatmaps/${beatmap.id}/clone`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Clone failed (${res.status})`)
      }
      const cloned = (await res.json()) as BeatmapRecord
      if (onCloned) onCloned(cloned)
    } catch (e) {
      setCloneError((e as Error).message)
    } finally {
      setCloning(false)
    }
  }

  const handleDelete = async () => {
    if (!onDeleted) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/tracks/${trackId}/beatmaps/${beatmap.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`${res.status}`)
      onDeleted()
    } catch (e) {
      setError((e as Error).message)
      setDeleting(false)
    }
  }

  const sections = data?.sections ?? {}
  // song.ini's [song] header puts all metadata fields under sections.song;
  // _root only contains keys that appeared before any [section] header,
  // which is normally empty.
  const root = { ...(sections._root ?? {}), ...(sections.song ?? {}) }
  const presentDiffs = DIFF_ORDER.filter((d) => sections[d] && Object.keys(sections[d]).length > 0)

  const sumLane = (sec: Record<string, string>, prefix: string) =>
    Array.from({ length: 5 }, (_, i) => Number(sec[`${prefix}_${i}`] || 0))

  const fmtCount = (count: number, total: number) => {
    if (count === 0) return '0'
    if (total <= 0) return String(count)
    const pct = (count / total) * 100
    const pctStr = pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)
    return `${count} (${pctStr}%)`
  }

  const chordRows: { key: string; label: string }[] = [
    { key: 'chord_0+1', label: '0+1 Green+Red' },
    { key: 'chord_1+2', label: '1+2 Red+Yellow' },
    { key: 'chord_2+3', label: '2+3 Yellow+Blue' },
    { key: 'chord_3+4', label: '3+4 Blue+Orange' },
  ]

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-start justify-center overflow-y-auto py-8 px-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-3xl">
        <div className="flex items-start justify-between gap-4 p-5 border-b border-gray-800">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-gray-100">
              Beatmap — <span className={STEM_COLORS[beatmap.stem] || 'text-gray-300'}>
                {STEM_LABELS[beatmap.stem] || beatmap.stem}
              </span>
            </h3>
            {editingName ? (
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="text"
                  autoFocus
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRename()
                    if (e.key === 'Escape') {
                      setDraftName(currentName)
                      setEditingName(false)
                      setRenameError('')
                    }
                  }}
                  disabled={savingName}
                  className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 font-mono focus:outline-none focus:border-jam-500"
                />
                <button
                  onClick={handleRename}
                  disabled={savingName || !draftName.trim()}
                  className="px-2 py-1 bg-jam-600 hover:bg-jam-500 disabled:opacity-40 text-white rounded text-[11px] font-medium transition-colors"
                >
                  {savingName ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={() => {
                    setDraftName(currentName)
                    setEditingName(false)
                    setRenameError('')
                  }}
                  disabled={savingName}
                  className="px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-[11px] transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => {
                  setDraftName(currentName)
                  setEditingName(true)
                  setRenameError('')
                }}
                className="mt-0.5 flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 font-mono truncate transition-colors"
                title="Rename this beatmap"
              >
                <span className="truncate">{currentName}</span>
                <span className="text-[10px] text-gray-500">✏ rename</span>
              </button>
            )}
            {renameError && (
              <p className="text-[11px] text-red-400 mt-0.5">{renameError}</p>
            )}
            <p className="text-xs text-gray-600 mt-0.5">Generated {formatBeatmapTimestamp(beatmap.generated_at)}</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-2xl leading-none">&times;</button>
        </div>

        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {error && (
            <div className="bg-red-900/30 border border-red-800 rounded-lg p-3 text-sm text-red-400">{error}</div>
          )}

          {!error && !data && (
            <div className="flex items-center gap-2 text-gray-400">
              <div className="animate-spin h-4 w-4 border-2 border-jam-400 border-t-transparent rounded-full" />
              <span className="text-sm">Loading stats...</span>
            </div>
          )}

          {data && (
            <>
              <section>
                <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Song</h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-sm">
                  {[
                    ['name', root.name],
                    ['artist', root.artist],
                    ['album', root.album],
                    ['genre', root.genre],
                    ['year', root.year],
                    ['charter', root.charter],
                    ['delay', root.delay],
                    ['song_length', root.song_length],
                    ['preview_start_time', root.preview_start_time],
                    ['five_lane_drums', root.five_lane_drums],
                    ['hopo_frequency', root.hopo_frequency],
                    ['sustain_cutoff_threshold', root.sustain_cutoff_threshold],
                  ].map(([k, v]) => (
                    <div key={k as string} className="flex justify-between gap-3 border-b border-gray-800/60 py-1">
                      <span className="text-gray-500 font-mono text-xs">{k}</span>
                      <span className="text-gray-300 truncate">{v || '—'}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Difficulty ratings</h4>
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                  {['diff_guitar', 'diff_drums', 'diff_bass', 'diff_rhythm', 'diff_keys', 'diff_guitar_coop'].map((k) => (
                    <div key={k} className="bg-gray-800/40 border border-gray-800 rounded px-2 py-1.5 text-center">
                      <div className="text-xs text-gray-600">{k.replace('diff_', '')}</div>
                      <div className="text-sm font-mono text-gray-200">{root[k] ?? '—'}</div>
                    </div>
                  ))}
                </div>
              </section>

              {presentDiffs.length > 0 && (
                <section>
                  <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Notes per difficulty</h4>
                  <div className="overflow-x-auto -mx-1 px-1">
                    <table className="w-full text-xs border-collapse">
                      <thead>
                        <tr className="text-gray-500">
                          <th className="text-left py-1.5 pr-3 font-medium">Metric</th>
                          {presentDiffs.map((d) => (
                            <th key={d} className="text-right py-1.5 px-2 font-medium">{DIFF_LABELS[d]}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="text-gray-300 font-mono">
                        <tr className="border-t border-gray-800">
                          <td className="py-1 pr-3 text-gray-200">Total events</td>
                          {presentDiffs.map((d) => (
                            <td key={d} className="text-right px-2 text-gray-100 font-semibold">
                              {sections[d].total_events || 0}
                            </td>
                          ))}
                        </tr>

                        {LANE_LABELS.map((label, i) => (
                          <tr key={`single_${i}`} className="border-t border-gray-800/60">
                            <td className="py-1 pr-3">Singles · {label}</td>
                            {presentDiffs.map((d) => {
                              const total = Number(sections[d].total_events || 0)
                              return (
                                <td key={d} className="text-right px-2">
                                  {fmtCount(sumLane(sections[d], 'single')[i], total)}
                                </td>
                              )
                            })}
                          </tr>
                        ))}

                        {LANE_LABELS.map((label, i) => (
                          <tr key={`hold_${i}`} className="border-t border-gray-800/60">
                            <td className="py-1 pr-3">Holds · {label}</td>
                            {presentDiffs.map((d) => {
                              const total = Number(sections[d].total_events || 0)
                              return (
                                <td key={d} className="text-right px-2">
                                  {fmtCount(sumLane(sections[d], 'hold')[i], total)}
                                </td>
                              )
                            })}
                          </tr>
                        ))}

                        {LANE_LABELS.map((label, i) => (
                          <tr key={`slide_${i}`} className="border-t border-gray-800/60">
                            <td className="py-1 pr-3">Slides · {label}</td>
                            {presentDiffs.map((d) => {
                              const total = Number(sections[d].total_events || 0)
                              return (
                                <td key={d} className="text-right px-2">
                                  {fmtCount(sumLane(sections[d], 'slide')[i], total)}
                                </td>
                              )
                            })}
                          </tr>
                        ))}

                        {chordRows.map(({ key, label }) => (
                          <tr key={key} className="border-t border-gray-800/60">
                            <td className="py-1 pr-3">Chord · {label}</td>
                            {presentDiffs.map((d) => {
                              const total = Number(sections[d].total_events || 0)
                              return (
                                <td key={d} className="text-right px-2">
                                  {fmtCount(Number(sections[d][key] || 0), total)}
                                </td>
                              )
                            })}
                          </tr>
                        ))}

                        {chordRows.map(({ key, label }) => (
                          <tr key={`hold_${key}`} className="border-t border-gray-800/60">
                            <td className="py-1 pr-3">Chord hold · {label}</td>
                            {presentDiffs.map((d) => {
                              const total = Number(sections[d].total_events || 0)
                              const v = Number(sections[d][`chord_hold_${key.replace('chord_', '')}`] || 0)
                              return (
                                <td key={d} className="text-right px-2">{fmtCount(v, total)}</td>
                              )
                            })}
                          </tr>
                        ))}

                        {chordRows.map(({ key, label }) => (
                          <tr key={`slide_${key}`} className="border-t border-gray-800/60">
                            <td className="py-1 pr-3">Chord slide · {label}</td>
                            {presentDiffs.map((d) => {
                              const total = Number(sections[d].total_events || 0)
                              const v = Number(sections[d][`chord_slide_${key.replace('chord_', '')}`] || 0)
                              return (
                                <td key={d} className="text-right px-2">{fmtCount(v, total)}</td>
                              )
                            })}
                          </tr>
                        ))}

                        <tr className="border-t border-gray-800">
                          <td className="py-1 pr-3">Open · normal</td>
                          {presentDiffs.map((d) => {
                            const total = Number(sections[d].total_events || 0)
                            return (
                              <td key={d} className="text-right px-2">
                                {fmtCount(Number(sections[d].open_normal || 0), total)}
                              </td>
                            )
                          })}
                        </tr>
                        <tr className="border-t border-gray-800/60">
                          <td className="py-1 pr-3">Open · hold</td>
                          {presentDiffs.map((d) => {
                            const total = Number(sections[d].total_events || 0)
                            return (
                              <td key={d} className="text-right px-2">
                                {fmtCount(Number(sections[d].open_hold || 0), total)}
                              </td>
                            )
                          })}
                        </tr>
                        <tr className="border-t border-gray-800/60">
                          <td className="py-1 pr-3">Open · slide</td>
                          {presentDiffs.map((d) => {
                            const total = Number(sections[d].total_events || 0)
                            return (
                              <td key={d} className="text-right px-2">
                                {fmtCount(Number(sections[d].open_slide || 0), total)}
                              </td>
                            )
                          })}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              <section className="text-xs text-gray-600">
                notes.chart size: <span className="text-gray-400 font-mono">{(data.chart_bytes / 1024).toFixed(1)} KB</span>
              </section>
            </>
          )}
        </div>

        <div className="p-5 border-t border-gray-800 flex flex-wrap items-center gap-2">
          <a
            href={`/api/tracks/${trackId}/beatmaps/${beatmap.id}/download/zip`}
            className="px-4 py-2 bg-jam-600 hover:bg-jam-500 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Download ZIP
          </a>
          <a
            href={`/api/tracks/${trackId}/beatmaps/${beatmap.id}/download/notes.chart`}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-lg text-sm font-medium transition-colors"
          >
            notes.chart
          </a>
          <a
            href={`/api/tracks/${trackId}/beatmaps/${beatmap.id}/download/song.ogg`}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-lg text-sm font-medium transition-colors"
          >
            song.ogg
          </a>
          <a
            href={`/api/tracks/${trackId}/beatmaps/${beatmap.id}/download/song.ini`}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-lg text-sm font-medium transition-colors"
          >
            song.ini
          </a>
          <button
            onClick={handleClone}
            disabled={cloning}
            className="px-4 py-2 bg-jam-700/40 hover:bg-jam-600/60 disabled:opacity-50 border border-jam-600/40 hover:border-jam-500 text-jam-200 hover:text-jam-100 rounded-lg text-sm font-medium transition-colors"
            title="Make an editable copy of this beatmap"
          >
            {cloning ? 'Cloning…' : 'Clone'}
          </button>
          {cloneError && (
            <span className="text-xs text-red-400">{cloneError}</span>
          )}
          {onDeleted && (
            <div className="ml-auto flex items-center gap-2">
              {!confirming ? (
                <button
                  onClick={() => setConfirming(true)}
                  className="px-3 py-2 bg-red-900/30 hover:bg-red-800/60 border border-red-800/50 hover:border-red-700 text-red-300 hover:text-red-200 rounded-lg text-sm font-medium transition-colors"
                >
                  Delete
                </button>
              ) : (
                <>
                  <span className="text-xs text-gray-400">Delete this beatmap?</span>
                  <button
                    onClick={() => setConfirming(false)}
                    disabled={deleting}
                    className="px-3 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-200 rounded-lg text-sm transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="px-3 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white rounded-lg text-sm font-medium transition-colors"
                  >
                    {deleting ? 'Deleting...' : 'Delete'}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
