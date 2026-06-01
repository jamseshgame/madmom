import { useEffect, useMemo, useState } from 'react'

// Mirrors STEM_TO_SECTION_SUFFIX in the backend (chart_generator.py). Used only
// as a fallback when the source chart has no sections to derive the suffix from.
const STEM_SECTION_SUFFIX: Record<string, string> = {
  guitar: 'Single',
  drums: 'Drums',
  bass: 'DoubleBass',
  rhythm: 'DoubleBass',
  piano: 'Keyboard',
  song: 'Single',
}

export interface ChartRow {
  id: string
  stem: string
  label: string // e.g. "V11 — chain playability"
}

interface Diff {
  name: string
  note_count: number
}

interface Props {
  trackId: string
  /** The row the action was invoked from — the SOURCE of the difficulty. */
  source: ChartRow
  /** Other charts on the same stem — possible targets. */
  targets: ChartRow[]
  onClose: () => void
  onDone: (msg: string) => void
}

async function fetchDiffs(trackId: string, beatmapId: string): Promise<Diff[]> {
  const r = await fetch(`/api/tracks/${trackId}/beatmaps/${beatmapId}/difficulties`)
  if (!r.ok) return []
  const data = await r.json()
  return data.difficulties ?? []
}

export default function CloneDifficultyModal({ trackId, source, targets, onClose, onDone }: Props) {
  const [sourceDiffs, setSourceDiffs] = useState<Diff[]>([])
  const [sourceDiff, setSourceDiff] = useState('')
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '')
  const [targetDiffs, setTargetDiffs] = useState<Diff[]>([])
  const [targetDiff, setTargetDiff] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Difficulty slots for this stem's section family — derived from whatever
  // sections the source chart exposes (they share the stem suffix).
  const suffix = useMemo(() => {
    if (sourceDiffs.length > 0) {
      return sourceDiffs[0].name.replace(/^(Expert|Hard|Medium|Easy)/, '')
    }
    return STEM_SECTION_SUFFIX[source.stem] ?? 'Single'
  }, [sourceDiffs, source.stem])
  const allSlots = useMemo(
    () => ['Expert', 'Hard', 'Medium', 'Easy'].map((p) => `${p}${suffix}`),
    [suffix],
  )

  useEffect(() => {
    fetchDiffs(trackId, source.id).then((d) => {
      setSourceDiffs(d)
      setSourceDiff(d[0]?.name ?? '')
    })
  }, [trackId, source.id])

  // Fetch the target chart's existing difficulties whenever the target changes.
  useEffect(() => {
    if (!targetId) return
    fetchDiffs(trackId, targetId).then((d) => {
      setTargetDiffs(d)
      setTargetDiff(d[0]?.name ?? '')
    })
  }, [trackId, targetId])

  // Once the stem's slot list is known (source loaded), seed the target
  // difficulty if the fetch above didn't already pick one.
  useEffect(() => {
    if (!targetDiff) setTargetDiff(allSlots[0] ?? '')
  }, [allSlots, targetDiff])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const targetHasNotes =
    targetDiffs.find((d) => d.name === targetDiff && d.note_count > 0) != null
  const targetLabel = targets.find((t) => t.id === targetId)?.label ?? ''

  async function submit() {
    setBusy(true)
    setError('')
    try {
      const r = await fetch(`/api/tracks/${trackId}/beatmaps/${targetId}/clone-difficulty`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_beatmap_id: source.id,
          source_difficulty: sourceDiff,
          target_difficulty: targetDiff,
        }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.detail ?? `HTTP ${r.status}`)
      }
      onDone(`Copied ${sourceDiff} → ${targetLabel} (${targetDiff})`)
      onClose()
    } catch (e: any) {
      setError(e.message ?? 'Clone failed')
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = !!sourceDiff && !!targetId && !!targetDiff && !busy

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-md mx-4 rounded-lg bg-slate-800 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 text-lg font-semibold text-white">Clone difficulty</h3>
        <p className="mb-4 text-sm text-slate-400">
          From <span className="text-purple-300">{source.label}</span> into another{' '}
          {source.stem} chart.
        </p>

        <label className="mb-1 block text-xs uppercase text-slate-400">Source difficulty</label>
        <select
          className="mb-3 w-full rounded bg-slate-700 px-2 py-1.5 text-sm text-white"
          value={sourceDiff}
          onChange={(e) => setSourceDiff(e.target.value)}
        >
          {sourceDiffs.map((d) => (
            <option key={d.name} value={d.name}>
              {d.name} ({d.note_count} notes)
            </option>
          ))}
        </select>

        <label className="mb-1 block text-xs uppercase text-slate-400">Target chart</label>
        <select
          className="mb-3 w-full rounded bg-slate-700 px-2 py-1.5 text-sm text-white"
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
        >
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>

        <label className="mb-1 block text-xs uppercase text-slate-400">Target difficulty</label>
        <select
          className="mb-2 w-full rounded bg-slate-700 px-2 py-1.5 text-sm text-white"
          value={targetDiff}
          onChange={(e) => setTargetDiff(e.target.value)}
        >
          {allSlots.map((name) => {
            const existing = targetDiffs.find((d) => d.name === name)
            return (
              <option key={name} value={name}>
                {name}
                {existing ? ` (${existing.note_count} notes)` : ' (empty)'}
              </option>
            )
          })}
        </select>

        {targetHasNotes && (
          <p className="mb-2 text-sm text-amber-400">
            ⚠ This will overwrite {targetLabel}'s {targetDiff} difficulty.
          </p>
        )}
        {error && <p className="mb-2 text-sm text-red-400">{error}</p>}

        <div className="mt-3 flex justify-end gap-2">
          <button
            className="rounded px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="rounded bg-purple-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-50"
            onClick={submit}
            disabled={!canSubmit}
          >
            {busy ? 'Working…' : targetHasNotes ? 'Overwrite' : 'Clone'}
          </button>
        </div>
      </div>
    </div>
  )
}
