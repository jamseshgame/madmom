import { useState } from 'react'

interface BeatmapResultProps {
  jobId: string
  metadata: Record<string, unknown>
}

export default function BeatmapResult({ jobId, metadata }: BeatmapResultProps) {
  const [publishing, setPublishing] = useState(false)
  const [publishResult, setPublishResult] = useState<{ commit_url: string; folder: string } | null>(null)
  const [publishError, setPublishError] = useState('')

  const handlePublish = async () => {
    setPublishing(true)
    setPublishError('')
    try {
      const res = await fetch(`/api/beatmap/${jobId}/publish`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Publish failed')
      }
      setPublishResult(await res.json())
    } catch (e) {
      setPublishError((e as Error).message)
    } finally {
      setPublishing(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h3 className="text-lg font-semibold text-jam-300 mb-4">Generation Complete</h3>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
          <dt className="text-gray-500">Song</dt>
          <dd>{metadata.song_name as string}</dd>
          <dt className="text-gray-500">Artist</dt>
          <dd>{metadata.artist as string}</dd>
          <dt className="text-gray-500">BPM</dt>
          <dd>{(metadata.bpm as number)?.toFixed(1)}</dd>
          <dt className="text-gray-500">Onsets</dt>
          <dd>{metadata.num_onsets as number}</dd>
        </dl>
      </div>

      <div className="flex flex-wrap gap-3">
        <a
          href={`/api/beatmap/${jobId}/download/zip`}
          className="px-5 py-2.5 bg-jam-600 hover:bg-jam-500 text-white rounded-lg font-medium transition-colors"
        >
          Download ZIP
        </a>
        <a
          href={`/api/beatmap/${jobId}/download/notes.chart`}
          className="px-5 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg font-medium transition-colors"
        >
          Download .chart
        </a>
        <button
          onClick={handlePublish}
          disabled={publishing || !!publishResult}
          className="px-5 py-2.5 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white rounded-lg font-medium transition-colors"
        >
          {publishing ? 'Publishing...' : publishResult ? 'Published' : 'Publish to GitHub'}
        </button>
      </div>

      {publishResult && (
        <div className="bg-green-900/30 border border-green-800 rounded-lg p-4 text-sm">
          Published to{' '}
          <a href={publishResult.commit_url} target="_blank" rel="noopener" className="text-green-400 underline">
            {publishResult.folder}
          </a>
        </div>
      )}
      {publishError && (
        <div className="bg-red-900/30 border border-red-800 rounded-lg p-4 text-sm text-red-400">
          {publishError}
        </div>
      )}
    </div>
  )
}
