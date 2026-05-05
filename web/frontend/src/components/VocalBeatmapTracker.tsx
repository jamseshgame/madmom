import { useEffect, useState } from 'react'

export default function VocalBeatmapTracker({
  beatmapJobId,
  onCancelled,
  onDone,
}: {
  beatmapJobId: string
  onCancelled?: () => void
  onDone?: () => void
}) {
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState('Starting...')
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const es = new EventSource(`/api/jobs/${beatmapJobId}/events`)
    es.onmessage = (e) => {
      const data = JSON.parse(e.data)
      if (typeof data.progress === 'number' && data.progress >= 0) setProgress(data.progress)
      if (data.message) setMessage(data.message)
      if (data.step === 'done') {
        es.close()
        setDone(true)
        onDone?.()
      } else if (data.step === 'error') {
        es.close()
        setError(data.message || 'Failed')
      } else if (data.step === 'cancelled') {
        es.close()
        onCancelled?.()
      }
    }
    es.onerror = () => {
      es.close()
      setError('Connection lost')
    }
    return () => es.close()
  }, [beatmapJobId, onCancelled, onDone])

  if (done) return <div className="text-xs text-emerald-400 mt-1">Done — {Math.max(progress, 100)}%</div>
  if (error) return <div className="text-xs text-red-400 mt-1">{error}</div>
  return (
    <div className="mt-1 space-y-1">
      <div className="w-full bg-gray-900 rounded-full h-1.5 overflow-hidden">
        <div
          className="bg-jam-500 h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.max(progress, 2)}%` }}
        />
      </div>
      <div className="text-xs text-gray-500 truncate">{message}</div>
    </div>
  )
}
