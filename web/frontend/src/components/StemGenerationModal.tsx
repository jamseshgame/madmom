import { useState } from 'react'
import GenerationSettings from './pipeline/GenerationSettings'
import { type GenerationState, type QueuedGeneration } from './pipeline/generationTypes'
import { materializeQueue } from './pipeline/queueBuilder'
import { STEM_COLORS, STEM_LABELS } from './stemDisplay'

interface StemGenerationModalProps {
  stem: string
  generation: GenerationState
  activePresets: string[]
  onGenerationChange: (next: GenerationState) => void
  onActivePresetsChange: (names: string[]) => void
  onClose: () => void
  // Called with the resolved queue when the user clicks Generate. The parent
  // owns sequential firing + per-stem lock holding; the modal just hands off
  // and closes.
  onBatchGenerate: (queue: QueuedGeneration[]) => void
}

export default function StemGenerationModal({
  stem,
  generation, activePresets,
  onGenerationChange, onActivePresetsChange,
  onClose, onBatchGenerate,
}: StemGenerationModalProps) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleGenerate = async () => {
    if (activePresets.length === 0) return
    setSubmitting(true)
    setError('')
    try {
      const queue = await materializeQueue(activePresets, generation, stem)
      onBatchGenerate(queue)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const generateLabel = (() => {
    if (submitting) return 'Starting…'
    if (activePresets.length <= 1) return 'Generate Beatmap'
    return `Generate ${activePresets.length} beatmaps`
  })()

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
            mode="multi"
            generation={generation}
            activePresets={activePresets}
            onGenerationChange={onGenerationChange}
            onActivePresetsChange={onActivePresetsChange}
            stem={stem}
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
            disabled={submitting || activePresets.length === 0}
            className="px-6 py-2 bg-jam-600 hover:bg-jam-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
            title={activePresets.length === 0 ? 'Pick at least one preset' : undefined}
          >
            {generateLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
