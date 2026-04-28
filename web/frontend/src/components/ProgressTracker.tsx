import { useEffect, useRef, useState } from 'react'

interface ProgressEvent {
  step: string
  progress: number
  message: string
  metadata?: Record<string, unknown>
}

interface ProgressTrackerProps {
  jobId: string
  statusUrl?: string
  onDone: (metadata: Record<string, unknown>) => void
  onError: (message: string) => void
}

const STEP_COLORS: Record<string, string> = {
  init: 'text-blue-400',
  demucs: 'text-jam-400',
  log: 'text-gray-500',
  done: 'text-green-400',
  error: 'text-red-400',
}

export default function ProgressTracker({ jobId, statusUrl, onDone, onError }: ProgressTrackerProps) {
  const [events, setEvents] = useState<ProgressEvent[]>([])
  const [progress, setProgress] = useState(0)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const evtSource = new EventSource(statusUrl || `/api/beatmap/${jobId}/status`)

    evtSource.onmessage = (e) => {
      const data: ProgressEvent = JSON.parse(e.data)
      setEvents((prev) => [...prev, data])
      if (data.progress >= 0) setProgress(data.progress)

      // Only treat 'done' as terminal when it carries metadata. Some workers
      // emit progress events with step='done' as a non-terminal milestone
      // (e.g. "stems ready"); without this guard the SSE closes early and
      // the result view never sees the real send_done() metadata.
      if (data.step === 'done' && data.metadata) {
        evtSource.close()
        onDone(data.metadata)
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

  // Auto-scroll log to bottom
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [events])

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
      {progress > 0 && (
        <div className="text-xs text-gray-500 text-right">{progress}%</div>
      )}
      <div
        ref={logRef}
        className="bg-gray-950 border border-gray-800 rounded-lg p-3 font-mono text-xs max-h-64 overflow-y-auto space-y-0.5"
      >
        {events.length === 0 && (
          <div className="text-gray-600">Waiting for logs...</div>
        )}
        {events.map((ev, i) => (
          <div key={i} className={STEP_COLORS[ev.step] || 'text-gray-500'}>
            <span className="text-gray-700 select-none">{String(i + 1).padStart(3, ' ')} </span>
            <span className="text-gray-600">[{ev.step}]</span> {ev.message}
          </div>
        ))}
      </div>
    </div>
  )
}
