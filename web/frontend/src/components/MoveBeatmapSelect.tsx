import { useState } from 'react'
import { STEM_LABELS } from './stemDisplay'

export default function MoveBeatmapSelect({ trackId, beatmapId, stem, stems, onMoved }: {
  trackId: string
  beatmapId: string
  stem: string
  stems: Record<string, string>
  onMoved: () => void | Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const targets = Object.keys(stems).filter((s) => s !== stem && !['song_ini', 'album_png'].includes(s))
  if (!targets.length) return null
  return (
    <div className="shrink-0">
      <select
        aria-label="Move beatmap to stem"
        title="Move this beatmap; keep its notes and original audio"
        value=""
        disabled={busy}
        className="max-w-32 rounded border border-gray-700 bg-gray-800 px-1 py-0.5 text-[10px] text-gray-300 disabled:opacity-50"
        onChange={async (event) => {
          const destination = event.target.value
          if (!destination) return
          setBusy(true)
          setError('')
          try {
            const response = await fetch(`/api/tracks/${trackId}/beatmaps/${beatmapId}/move`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ stem: destination }),
            })
            if (!response.ok) {
              const body = await response.json().catch(() => ({}))
              throw new Error(body.detail || `Move failed (${response.status})`)
            }
            await onMoved()
          } catch (e) {
            setError((e as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <option value="">{busy ? 'Moving…' : 'Move to…'}</option>
        {targets.map((s) => <option key={s} value={s}>{STEM_LABELS[s] || s}</option>)}
      </select>
      {error && <span role="alert" className="block text-xs text-red-400">{error}</span>}
    </div>
  )
}
