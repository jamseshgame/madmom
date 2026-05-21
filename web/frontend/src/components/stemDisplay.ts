// Shared stem display constants used by StemResult, StemGenerationModal, and
// any other component that needs to render a human-readable stem name or colour.
// The full map includes all variants produced by Demucs / manual uploads.

export const STEM_COLORS: Record<string, string> = {
  vocals: 'text-pink-400',
  drums: 'text-amber-400',
  bass: 'text-green-400',
  rhythm: 'text-green-400',
  guitar: 'text-orange-400',
  piano: 'text-violet-400',
  other: 'text-blue-400',
  crowd: 'text-blue-400',
  song: 'text-gray-300',
  no_vocals: 'text-cyan-400',
  no_drums: 'text-cyan-400',
  no_bass: 'text-cyan-400',
  no_guitar: 'text-cyan-400',
  no_piano: 'text-cyan-400',
  no_other: 'text-cyan-400',
}

export const STEM_LABELS: Record<string, string> = {
  vocals: 'Vocals',
  drums: 'Drums',
  bass: 'Bass',
  rhythm: 'Bass',
  guitar: 'Guitar',
  piano: 'Piano',
  other: 'Other',
  crowd: 'Crowd',
  song: 'Master Mix',
  no_vocals: 'Instrumental',
  no_drums: 'No Drums',
  no_bass: 'No Bass',
  no_guitar: 'No Guitar',
  no_piano: 'No Piano',
  no_other: 'No Other',
}
