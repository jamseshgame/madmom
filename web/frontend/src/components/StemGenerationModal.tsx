import { useState } from 'react'
import GenerationSettings from './pipeline/GenerationSettings'
import {
  GENERATION_STAGE_LABELS,
  type GenerationStage,
  type GenerationState,
} from './pipeline/generationTypes'

const STEM_COLORS: Record<string, string> = {
  bass: 'text-green-400',
  rhythm: 'text-green-400',
  guitar: 'text-orange-400',
  piano: 'text-violet-400',
  other: 'text-blue-400',
}

const STEM_LABELS: Record<string, string> = {
  bass: 'Bass',
  rhythm: 'Bass',
  guitar: 'Guitar',
  piano: 'Piano',
  other: 'Other',
}

interface StemGenerationModalProps {
  trackId: string
  stem: string
  songIni: Record<string, unknown>
  generation: GenerationState
  activePreset: string
  onGenerationChange: (next: GenerationState) => void
  onActivePresetChange: (name: string) => void
  onClose: () => void
  onGenerated: (jobId: string) => void
}

export default function StemGenerationModal({
  trackId, stem, songIni,
  generation, activePreset,
  onGenerationChange, onActivePresetChange,
  onClose, onGenerated,
}: StemGenerationModalProps) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleGenerate = async () => {
    setSubmitting(true)
    setError('')
    try {
      const formData = new FormData()
      formData.append('stem', stem)
      for (const [key, val] of Object.entries(songIni)) {
        formData.append(key, String(val ?? ''))
      }
      for (const stage of Object.keys(GENERATION_STAGE_LABELS) as GenerationStage[]) {
        const sel = generation[stage]
        const fieldPrefix =
          stage === 'lanes_expert' ? 'lanes' :
          stage === 'lanes_filtered' ? 'playability' :
          stage
        formData.append(`${fieldPrefix}_engine`, sel.engine)
        formData.append(`${fieldPrefix}_params`, JSON.stringify(sel.params))
      }
      if (activePreset) formData.append('preset', activePreset)

      const res = await fetch(`/api/tracks/${trackId}/generate-beatmap-v2`, {
        method: 'POST',
        body: formData,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }
      const { job_id } = await res.json()
      onGenerated(job_id)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-start justify-center overflow-y-auto py-8">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl mx-4">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h3 className="text-lg font-semibold">
            Generate Beatmap — <span className={STEM_COLORS[stem] || 'text-gray-300'}>{STEM_LABELS[stem] || stem}</span>
          </h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">&times;</button>
        </div>

        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          <GenerationSettings
            generation={generation}
            activePreset={activePreset}
            onGenerationChange={onGenerationChange}
            onActivePresetChange={onActivePresetChange}
          />
        </div>

        <div className="p-5 border-t border-gray-800 flex flex-wrap items-center gap-2 justify-end">
          {error && <div className="mr-auto text-xs text-red-400 max-w-md truncate" title={error}>{error}</div>}
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 text-gray-200 rounded-lg text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={submitting}
            className="px-6 py-2 bg-jam-600 hover:bg-jam-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {submitting ? 'Starting…' : 'Generate'}
          </button>
        </div>
      </div>
    </div>
  )
}
