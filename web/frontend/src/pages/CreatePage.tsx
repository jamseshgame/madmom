import { useCallback, useState } from 'react'
import FileUpload from '../components/FileUpload.tsx'
import ProgressTracker from '../components/ProgressTracker.tsx'
import BeatmapResult from '../components/BeatmapResult.tsx'

type Phase = 'upload' | 'metadata' | 'generating' | 'done' | 'error'

export default function CreatePage() {
  const [phase, setPhase] = useState<Phase>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [artist, setArtist] = useState('')
  const [album, setAlbum] = useState('')
  const [year, setYear] = useState('')
  const [genre, setGenre] = useState('')
  const [jobId, setJobId] = useState('')
  const [metadata, setMetadata] = useState<Record<string, unknown>>({})
  const [error, setError] = useState('')
  const [loadingMeta, setLoadingMeta] = useState(false)

  const handleFile = async (f: File) => {
    setFile(f)
    const fallbackName = f.name.replace(/\.[^.]+$/, '').replace(/[._]/g, ' ')
    setTitle(fallbackName)
    setPhase('metadata')
    setLoadingMeta(true)

    // Fetch real metadata from server via ffprobe
    try {
      const fd = new FormData()
      fd.append('file', f)
      const res = await fetch('/api/beatmap/metadata', { method: 'POST', body: fd })
      if (res.ok) {
        const meta = await res.json()
        if (meta.title) setTitle(meta.title)
        if (meta.artist) setArtist(meta.artist)
        if (meta.album) setAlbum(meta.album)
        if (meta.year) setYear(meta.year)
        if (meta.genre) setGenre(meta.genre)
      }
    } catch {
      // Metadata extraction failed — keep filename fallback, not a blocker
    } finally {
      setLoadingMeta(false)
    }
  }

  const handleGenerate = async () => {
    if (!file) return
    setPhase('generating')
    setError('')

    const formData = new FormData()
    formData.append('file', file)
    if (title) formData.append('title', title)
    if (artist) formData.append('artist', artist)
    if (album) formData.append('album', album)
    if (year) formData.append('year', year)
    if (genre) formData.append('genre', genre)

    try {
      const res = await fetch('/api/beatmap/create', { method: 'POST', body: formData })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Upload failed')
      }
      const { job_id } = await res.json()
      setJobId(job_id)
    } catch (e) {
      setError((e as Error).message)
      setPhase('error')
    }
  }

  const handleDone = useCallback((meta: Record<string, unknown>) => {
    setMetadata(meta)
    setPhase('done')
  }, [])

  const handleError = useCallback((msg: string) => {
    setError(msg)
    setPhase('error')
  }, [])

  const reset = () => {
    setPhase('upload')
    setFile(null)
    setTitle('')
    setArtist('')
    setAlbum('')
    setYear('')
    setGenre('')
    setJobId('')
    setMetadata({})
    setError('')
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Create Beatmap</h1>
        <p className="text-gray-500 mt-1">Upload audio to generate a Clone Hero chart with 4 difficulty levels.</p>
      </div>

      {phase === 'upload' && (
        <FileUpload accept=".flac,.mp3,.ogg,.wav" label="Drop your audio file here" onFile={handleFile} />
      )}

      {phase === 'metadata' && file && (
        <div className="space-y-4">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
            <p className="text-sm text-gray-400">
              File: <span className="text-gray-200">{file.name}</span>{' '}
              <span className="text-gray-600">({(file.size / 1024 / 1024).toFixed(1)} MB)</span>
            </p>
            <div className="grid grid-cols-2 gap-4">
              {[
                { label: 'Title', value: title, set: setTitle },
                { label: 'Artist', value: artist, set: setArtist },
                { label: 'Album', value: album, set: setAlbum },
                { label: 'Year', value: year, set: setYear },
                { label: 'Genre', value: genre, set: setGenre },
              ].map(({ label, value, set }) => (
                <label key={label} className="block">
                  <span className="text-xs text-gray-500 uppercase tracking-wider">{label}</span>
                  <input
                    type="text"
                    value={value}
                    onChange={(e) => set(e.target.value)}
                    className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-jam-500"
                    placeholder={label}
                  />
                </label>
              ))}
            </div>
          </div>
          {loadingMeta && (
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <div className="animate-spin h-4 w-4 border-2 border-jam-400 border-t-transparent rounded-full" />
              Reading metadata...
            </div>
          )}
          <div className="flex gap-3">
            <button
              onClick={handleGenerate}
              disabled={loadingMeta}
              className="px-6 py-2.5 bg-jam-600 hover:bg-jam-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors"
            >
              {loadingMeta ? 'Reading metadata...' : 'Generate Beatmap'}
            </button>
            <button onClick={reset} className="px-4 py-2.5 text-gray-400 hover:text-gray-200 transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase === 'generating' && jobId && (
        <ProgressTracker jobId={jobId} onDone={handleDone} onError={handleError} />
      )}

      {phase === 'done' && <BeatmapResult jobId={jobId} metadata={metadata} />}

      {phase === 'error' && (
        <div className="space-y-4">
          <div className="bg-red-900/30 border border-red-800 rounded-lg p-4 text-red-400">{error}</div>
          <button onClick={reset} className="px-4 py-2 text-gray-400 hover:text-gray-200 transition-colors">
            Try again
          </button>
        </div>
      )}

      {(phase === 'done' || phase === 'error') && (
        <button
          onClick={reset}
          className="px-4 py-2 text-sm text-gray-500 hover:text-gray-300 transition-colors"
        >
          Create another
        </button>
      )}
    </div>
  )
}
