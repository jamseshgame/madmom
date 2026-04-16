import { useState } from 'react'
import FileUpload from '../components/FileUpload.tsx'
import AnalyseReport from '../components/AnalyseReport.tsx'

export default function AnalysePage() {
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState('')

  const handleFile = async (file: File) => {
    setLoading(true)
    setError('')
    setData(null)

    const formData = new FormData()
    formData.append('file', file)

    try {
      const res = await fetch('/api/analyse', { method: 'POST', body: formData })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Analysis failed')
      }
      setData(await res.json())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Analyse Beatmap</h1>
        <p className="text-gray-500 mt-1">Upload a .chart file to see per-difficulty note statistics.</p>
      </div>

      <FileUpload accept=".chart" label="Drop your .chart file here" onFile={handleFile} maxMb={50} />

      {loading && (
        <div className="flex items-center gap-3 text-gray-400">
          <div className="animate-spin h-5 w-5 border-2 border-jam-400 border-t-transparent rounded-full" />
          Analysing...
        </div>
      )}

      {error && <div className="bg-red-900/30 border border-red-800 rounded-lg p-4 text-red-400">{error}</div>}

      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      {data && <AnalyseReport data={data as any} />}
    </div>
  )
}
