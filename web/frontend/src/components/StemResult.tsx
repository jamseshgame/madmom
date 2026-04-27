import { useCallback, useEffect, useState } from 'react'

interface StemResultProps {
  jobId: string
  metadata: Record<string, unknown>
}

const STEM_LABELS: Record<string, { label: string; color: string }> = {
  vocals: { label: 'Vocals', color: 'text-pink-400' },
  drums: { label: 'Drums', color: 'text-amber-400' },
  bass: { label: 'Bass', color: 'text-green-400' },
  guitar: { label: 'Guitar', color: 'text-orange-400' },
  piano: { label: 'Piano', color: 'text-violet-400' },
  other: { label: 'Other', color: 'text-blue-400' },
  rhythm: { label: 'Rhythm', color: 'text-green-400' },
  crowd: { label: 'Crowd', color: 'text-blue-400' },
  song: { label: 'Full Mix', color: 'text-gray-300' },
  song_ini: { label: 'song.ini', color: 'text-yellow-400' },
  no_vocals: { label: 'Instrumental', color: 'text-cyan-400' },
  no_drums: { label: 'No Drums', color: 'text-cyan-400' },
  no_bass: { label: 'No Bass', color: 'text-cyan-400' },
  no_guitar: { label: 'No Guitar', color: 'text-cyan-400' },
  no_piano: { label: 'No Piano', color: 'text-cyan-400' },
  no_other: { label: 'No Other', color: 'text-cyan-400' },
}

type BeatmapState = 'idle' | 'generating' | 'done' | 'error'

interface StemBeatmap {
  state: BeatmapState
  beatmapJobId: string
  progress: number
  message: string
  error: string
}

function StemBeatmapTracker({ stemJobId, stem, beatmapJobId }: { stemJobId: string; stem: string; beatmapJobId: string }) {
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState('Starting...')
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const evtSource = new EventSource(`/api/beatmap/${beatmapJobId}/status`)

    evtSource.onmessage = (e) => {
      const data = JSON.parse(e.data)
      if (data.progress >= 0) setProgress(data.progress)
      setMessage(data.message)

      if (data.step === 'done') {
        evtSource.close()
        setDone(true)
      } else if (data.step === 'error') {
        evtSource.close()
        setError(data.message)
      }
    }

    evtSource.onerror = () => {
      evtSource.close()
      setError('Connection lost')
    }

    return () => evtSource.close()
  }, [beatmapJobId])

  if (error) {
    return <div className="text-xs text-red-400 mt-1">{error}</div>
  }

  if (done) {
    return (
      <div className="flex flex-wrap gap-1.5 mt-1">
        <a
          href={`/api/beatmap/${beatmapJobId}/download/zip`}
          className="px-2.5 py-1 bg-jam-600 hover:bg-jam-500 text-white rounded text-xs font-medium transition-colors"
        >
          Download ZIP
        </a>
        <a
          href={`/api/beatmap/${beatmapJobId}/download/notes.chart`}
          className="px-2.5 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded text-xs font-medium transition-colors"
        >
          .chart
        </a>
      </div>
    )
  }

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

export default function StemResult({ jobId, metadata }: StemResultProps) {
  const stems = (metadata.stems || {}) as Record<string, string>
  const trackName = (metadata.original_name as string) || 'track'
  const isGameReady = !!metadata.game_ready
  const [playing, setPlaying] = useState<string | null>(null)
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null)
  const [beatmaps, setBeatmaps] = useState<Record<string, { jobId: string; state: BeatmapState }>>({})
  const [publishing, setPublishing] = useState<'idle' | 'publishing' | 'done' | 'error'>('idle')
  const [publishResult, setPublishResult] = useState<{ commitUrl: string; folder: string } | null>(null)
  const [publishError, setPublishError] = useState('')

  const publishToGame = async () => {
    setPublishing('publishing')
    setPublishError('')
    try {
      const res = await fetch(`/api/stems/${jobId}/publish`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Publish failed')
      }
      const data = await res.json()
      setPublishResult({ commitUrl: data.commit_url, folder: data.folder })
      setPublishing('done')
    } catch (e) {
      setPublishError((e as Error).message)
      setPublishing('error')
    }
  }

  const togglePlay = (stem: string) => {
    if (playing === stem && audioEl) {
      audioEl.pause()
      setPlaying(null)
      setAudioEl(null)
      return
    }
    if (audioEl) audioEl.pause()
    const audio = new Audio(`/api/stems/${jobId}/download/${stem}`)
    audio.play()
    audio.onended = () => { setPlaying(null); setAudioEl(null) }
    setPlaying(stem)
    setAudioEl(audio)
  }

  const generateBeatmap = async (stem: string) => {
    const info = STEM_LABELS[stem] || { label: stem }
    setBeatmaps((prev) => ({ ...prev, [stem]: { jobId: '', state: 'generating' } }))

    const formData = new FormData()
    formData.append('stem_job_id', jobId)
    formData.append('stem', stem)
    formData.append('title', `${trackName} (${info.label})`)

    try {
      const res = await fetch('/api/beatmap/from-stem', { method: 'POST', body: formData })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Failed to start beatmap generation')
      }
      const { job_id } = await res.json()
      setBeatmaps((prev) => ({ ...prev, [stem]: { jobId: job_id, state: 'generating' } }))
    } catch (e) {
      setBeatmaps((prev) => ({ ...prev, [stem]: { jobId: '', state: 'error' } }))
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h3 className="text-lg font-semibold text-jam-300 mb-1">Separation Complete</h3>
        <p className="text-sm text-gray-500 mb-5">{trackName}</p>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {Object.entries(stems).map(([stem, filename]) => {
            const info = STEM_LABELS[stem] || { label: stem, color: 'text-gray-300' }
            const isPlaying = playing === stem
            const bm = beatmaps[stem]
            return (
              <div
                key={stem}
                className="bg-gray-800 border border-gray-700 rounded-lg p-4 flex flex-col items-center gap-2"
              >
                <span className={`text-sm font-semibold ${info.color}`}>{info.label}</span>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => togglePlay(stem)}
                    className={`px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
                      isPlaying
                        ? 'bg-jam-600 text-white'
                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}
                  >
                    {isPlaying ? 'Stop' : 'Play'}
                  </button>
                  <a
                    href={`/api/stems/${jobId}/download/${stem}`}
                    className="px-2.5 py-1.5 bg-gray-700 text-gray-300 hover:bg-gray-600 rounded text-xs font-medium transition-colors"
                  >
                    Download
                  </a>
                </div>

                {/* Beatmap generation */}
                {!bm && (
                  <button
                    onClick={() => generateBeatmap(stem)}
                    className="mt-1 px-3 py-1.5 bg-green-700/60 hover:bg-green-600/70 text-green-200 rounded text-xs font-medium transition-colors w-full"
                  >
                    Generate Beatmap
                  </button>
                )}

                {bm?.state === 'generating' && !bm.jobId && (
                  <div className="flex items-center gap-1.5 mt-1">
                    <div className="animate-spin h-3 w-3 border-2 border-jam-400 border-t-transparent rounded-full" />
                    <span className="text-xs text-gray-500">Starting...</span>
                  </div>
                )}

                {bm?.state === 'generating' && bm.jobId && (
                  <div className="w-full">
                    <StemBeatmapTracker stemJobId={jobId} stem={stem} beatmapJobId={bm.jobId} />
                  </div>
                )}

                {bm?.state === 'error' && (
                  <div className="text-xs text-red-400 mt-1">Failed</div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <a
          href={`/api/stems/${jobId}/download/zip`}
          className="px-5 py-2.5 bg-jam-600 hover:bg-jam-500 text-white rounded-lg font-medium transition-colors"
        >
          Download All Stems (ZIP)
        </a>

        {isGameReady && publishing === 'idle' && (
          <button
            onClick={publishToGame}
            className="px-5 py-2.5 bg-green-700 hover:bg-green-600 text-white rounded-lg font-medium transition-colors"
          >
            Publish to Game
          </button>
        )}

        {publishing === 'publishing' && (
          <div className="flex items-center gap-2 px-4 py-2.5">
            <div className="animate-spin h-4 w-4 border-2 border-green-400 border-t-transparent rounded-full" />
            <span className="text-sm text-gray-400">Publishing to GitHub...</span>
          </div>
        )}

        {publishing === 'done' && publishResult && (
          <div className="flex items-center gap-3">
            <span className="text-sm text-green-400">Published!</span>
            <a
              href={publishResult.commitUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-jam-400 hover:text-jam-300 underline transition-colors"
            >
              View commit
            </a>
            <span className="text-xs text-gray-600 font-mono">{publishResult.folder}</span>
          </div>
        )}

        {publishing === 'error' && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-red-400">{publishError}</span>
            <button
              onClick={() => setPublishing('idle')}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {(metadata.track_id as string) && (
          <a
            href="/tracks"
            className="px-4 py-2.5 text-sm text-gray-400 hover:text-jam-300 transition-colors"
          >
            Saved to Track Library &rarr;
          </a>
        )}
      </div>
    </div>
  )
}
