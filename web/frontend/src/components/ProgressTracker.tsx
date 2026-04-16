import { useEffect, useState } from 'react'

interface ProgressEvent {
  step: string
  progress: number
  message: string
  metadata?: Record<string, unknown>
}

interface ProgressTrackerProps {
  jobId: string
  onDone: (metadata: Record<string, unknown>) => void
  onError: (message: string) => void
}

export default function ProgressTracker({ jobId, onDone, onError }: ProgressTrackerProps) {
  const [events, setEvents] = useState<ProgressEvent[]>([])
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    const evtSource = new EventSource(`/api/beatmap/${jobId}/status`)

    evtSource.onmessage = (e) => {
      const data: ProgressEvent = JSON.parse(e.data)
      setEvents((prev) => [...prev, data])
      if (data.progress >= 0) setProgress(data.progress)

      if (data.step === 'done') {
        evtSource.close()
        onDone(data.metadata || {})
      } else if (data.step === 'error') {
        evtSource.close()
        onError(data.message)
      }
    }

    evtSource.onerror = () => {
      evtSource.close()
      onError('Connection lost')
    }

    return () => evtSource.close()
  }, [jobId, onDone, onError])

  const currentMessage = events.length > 0 ? events[events.length - 1].message : 'Starting...'

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="animate-spin h-5 w-5 border-2 border-jam-400 border-t-transparent rounded-full" />
        <span className="text-gray-300">{currentMessage}</span>
      </div>
      <div className="w-full bg-gray-800 rounded-full h-3 overflow-hidden">
        <div
          className="bg-jam-500 h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.max(progress, 2)}%` }}
        />
      </div>
      <div className="text-xs text-gray-500 max-h-32 overflow-y-auto space-y-0.5">
        {events.map((ev, i) => (
          <div key={i}>
            [{ev.step}] {ev.message}
          </div>
        ))}
      </div>
    </div>
  )
}
