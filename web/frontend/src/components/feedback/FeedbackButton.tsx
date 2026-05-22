import { useEffect, useState } from 'react'
import FeedbackPanel from './FeedbackPanel'

interface FeedbackButtonProps {
  trackId: string
  beatmapId: string
  currentUsername: string
  isAdmin: boolean
}

export default function FeedbackButton({ trackId, beatmapId, currentUsername, isAdmin }: FeedbackButtonProps) {
  const [open, setOpen] = useState(false)
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    fetch(`/api/feedback/tracks/${trackId}/beatmaps/${beatmapId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d: unknown[]) => {
        if (alive) setCount(d.length)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [trackId, beatmapId])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="shrink-0 px-2 py-0.5 bg-gray-700/60 hover:bg-gray-700 border border-gray-700 hover:border-gray-600 rounded text-[10px] text-gray-200 hover:text-gray-100 transition-colors"
        title="View or add feedback for this beatmap"
        aria-expanded={open}
      >
        Feedback{count != null && count > 0 ? ` (${count})` : ''}
      </button>
      {open && (
        <div className="col-span-full mt-2 w-full">
          <FeedbackPanel
            trackId={trackId}
            beatmapId={beatmapId}
            currentUsername={currentUsername}
            isAdmin={isAdmin}
            onCountChange={setCount}
          />
        </div>
      )}
    </>
  )
}
