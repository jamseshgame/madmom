import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import LyricsButtons from '../components/LyricsButtons'
import StemPlayer from '../components/StemPlayer.tsx'
import BeatmapStatsModal, { BeatmapRecord as BeatmapStatsRecord } from '../components/BeatmapStatsModal.tsx'
import FeedbackButton from '../components/feedback/FeedbackButton'
import VocalmapButtons from '../components/VocalmapButtons'
import useInstalledVersion from '../components/useInstalledVersion'
import { BusyProvider, useExclusiveTask } from '../components/useExclusiveTask'
import {
  GENERATION_DEFAULTS,
  GENERATION_STAGE_LABELS,
  type GenerationStage,
  type GenerationState,
  type QueuedGeneration,
} from '../components/pipeline/generationTypes'
import { materializeQueue } from '../components/pipeline/queueBuilder'
import GenerationSettings from '../components/pipeline/GenerationSettings'
import { STEM_COLORS, STEM_LABELS } from '../components/stemDisplay'
import CloneDifficultyModal, { ChartRow } from '../components/tracks/CloneDifficultyModal'

type BeatmapRecord = BeatmapStatsRecord

interface Track {
  id: string
  name: string
  created_at: number
  stems: Record<string, string>
  stem_count: number
  model: string
  output_format: string
  artist: string
  album: string
  genre: string
  year: string
  beatmaps?: BeatmapRecord[]
}

interface SongIniField {
  type: string
  default: unknown
  label: string
}

// Mirrors LyricsButtons / VocalmapButtons SOURCE_BADGE: short uppercase badge
// matching the model that produced the beatmap. Legacy records (no model
// field) fall through to the neutral gray badge.
const BEATMAP_MODEL_BADGE: Record<string, string> = {
  madmom: 'bg-green-700/40 text-green-200 border-green-700/60',
  manual: 'bg-gray-700/40 text-gray-200 border-gray-700/60',
  imported: 'bg-blue-700/40 text-blue-200 border-blue-700/60',
}

// Group song.ini fields for the form
const FIELD_GROUPS = [
  {
    title: 'Metadata',
    fields: ['name', 'artist', 'album', 'genre', 'year', 'charter', 'loading_phrase', 'icon', 'album_track', 'playlist_track'],
  },
  {
    title: 'Timing',
    fields: ['delay', 'preview_start_time', 'video_start_time', 'song_length'],
  },
  {
    title: 'Difficulty Ratings',
    fields: ['diff_guitar', 'diff_rhythm', 'diff_bass', 'diff_guitar_coop', 'diff_drums', 'diff_drums_real', 'diff_keys', 'diff_guitarghl', 'diff_bassghl'],
  },
  {
    title: 'Gameplay',
    fields: ['hopo_frequency', 'sustain_cutoff_threshold', 'five_lane_drums', 'modchart'],
  },
]


function BeatmapPanel({
  track,
  stem,
  onClose,
  onBatchGenerate,
}: {
  track: Track
  stem: string
  onClose: () => void
  // Called with the resolved queue + song.ini overrides when the user clicks
  // Generate. The parent owns sequential firing + per-stem lock holding;
  // the modal just hands off and closes — same pattern StemGenerationModal
  // uses on the Create page.
  onBatchGenerate: (queue: QueuedGeneration[], values: Record<string, unknown>) => void
}) {
  const navigate = useNavigate()
  const [schema, setSchema] = useState<Record<string, SongIniField>>({})
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [submitting, setSubmitting] = useState(false)
  const [creatingEmpty, setCreatingEmpty] = useState(false)
  const [emptyError, setEmptyError] = useState('')
  const [error, setError] = useState('')
  // V2 pipeline state — user's per-stage engine + params selection, and the
  // multi-select picker state. Both flow through GenerationSettings as
  // controlled props and get read at submit time.
  const [generation, setGeneration] = useState<GenerationState>(GENERATION_DEFAULTS)
  const [activePresets, setActivePresets] = useState<string[]>([])

  useEffect(() => {
    fetch('/api/tracks/schema/song-ini')
      .then((r) => r.json())
      .then((s: Record<string, SongIniField>) => {
        setSchema(s)
        // Initialize values from schema defaults + track metadata
        const init: Record<string, unknown> = {}
        for (const [key, field] of Object.entries(s)) {
          init[key] = field.default
        }
        init.name = `${track.name} (${STEM_LABELS[stem] || stem})`
        init.artist = track.artist || 'Unknown'
        init.album = track.album || 'Unknown'
        init.genre = track.genre || 'Unknown'
        init.year = track.year || ''
        setValues(init)
      })
  }, [track, stem])


  const setValue = (key: string, val: unknown) => {
    setValues((prev) => ({ ...prev, [key]: val }))
  }

  const handleGenerate = async () => {
    if (activePresets.length === 0) return
    setSubmitting(true)
    setError('')
    try {
      const queue = await materializeQueue(activePresets, generation, stem)
      onBatchGenerate(queue, values)
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

  const renderField = (key: string) => {
    const field = schema[key]
    if (!field) return null
    const val = values[key]

    if (field.type === 'bool') {
      return (
        <label key={key} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={!!val}
            onChange={(e) => setValue(key, e.target.checked)}
            className="rounded border-gray-600 bg-gray-800"
          />
          <span className="text-sm text-gray-300">{field.label}</span>
        </label>
      )
    }

    if (field.type === 'int') {
      return (
        <label key={key} className="block">
          <span className="text-xs text-gray-500">{field.label}</span>
          <input
            type="number"
            value={val as number}
            onChange={(e) => setValue(key, parseInt(e.target.value) || 0)}
            className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-jam-500"
          />
        </label>
      )
    }

    return (
      <label key={key} className="block">
        <span className="text-xs text-gray-500">{field.label}</span>
        <input
          type="text"
          value={(val as string) || ''}
          onChange={(e) => setValue(key, e.target.value)}
          className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-jam-500"
        />
      </label>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-start justify-center overflow-y-auto py-8">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl mx-4">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h3 className="text-lg font-semibold">
            Generate Beatmap — <span className={STEM_COLORS[stem] || 'text-gray-300'}>{STEM_LABELS[stem] || stem}</span>
          </h3>
          <div className="flex items-center gap-2">
            <a
              href={`/api/tracks/${track.id}/stems/${stem}`}
              className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-gray-600 text-gray-200 rounded-md text-xs font-medium transition-colors"
              title={`Download ${STEM_LABELS[stem] || stem} stem`}
            >
              Download stem
            </a>
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">&times;</button>
          </div>
        </div>

        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {FIELD_GROUPS.map((group, idx) => (
            <Fragment key={group.title}>
              <div>
                <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{group.title}</h4>
                <div className="grid grid-cols-2 gap-3">
                  {group.fields.map((f) => renderField(f))}
                </div>
              </div>
              {/* GENERATION section: sits between Metadata (idx 0) and Timing. */}
              {idx === 0 && (
                <GenerationSettings
                  mode="multi"
                  generation={generation}
                  activePresets={activePresets}
                  onGenerationChange={setGeneration}
                  onActivePresetsChange={setActivePresets}
                  stem={stem}
                />
              )}
            </Fragment>
          ))}
        </div>

        <div className="p-5 border-t border-gray-800 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleGenerate}
              disabled={submitting || creatingEmpty || activePresets.length === 0}
              className="px-6 py-2.5 bg-jam-600 hover:bg-jam-500 disabled:opacity-50 text-white rounded-lg font-medium transition-colors"
              title={activePresets.length === 0 ? 'Pick at least one preset' : undefined}
            >
              {generateLabel}
            </button>
            <button
              onClick={async () => {
                setCreatingEmpty(true)
                setEmptyError('')
                try {
                  const fd = new FormData()
                  fd.append('stem', stem)
                  const res = await fetch(`/api/tracks/${track.id}/empty-beatmap`, {
                    method: 'POST',
                    body: fd,
                  })
                  if (!res.ok) {
                    const err = await res.json().catch(() => ({}))
                    throw new Error(err.detail || `Failed (${res.status})`)
                  }
                  const data = await res.json()
                  onClose()
                  navigate(`/edit/${data.track_id}/${data.beatmap_id}`)
                } catch (e) {
                  setEmptyError((e as Error).message)
                } finally {
                  setCreatingEmpty(false)
                }
              }}
              disabled={submitting || creatingEmpty}
              className="px-4 py-2.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 hover:border-gray-600 text-gray-200 rounded-lg text-sm font-medium transition-colors"
              title="Skip beat detection — open the editor with an empty chart"
            >
              {creatingEmpty ? 'Creating…' : 'Open empty editor →'}
            </button>
            {emptyError && <span className="text-xs text-red-400">{emptyError}</span>}
          </div>

          {error && (
            <div className="bg-red-900/30 border border-red-800 rounded-lg p-3 text-sm text-red-400">{error}</div>
          )}
        </div>
      </div>
    </div>
  )
}


// ── Tutorial samples + voice reference manager ────────────────────────────
const TUTORIAL_SAMPLE_SLOTS: { slot: string; label: string; cls: string }[] = [
  { slot: 'lane_1', label: 'Lane 1 (Green)', cls: 'text-emerald-400' },
  { slot: 'lane_2', label: 'Lane 2 (Red)', cls: 'text-red-400' },
  { slot: 'lane_3', label: 'Lane 3 (Yellow)', cls: 'text-amber-400' },
  { slot: 'lane_4', label: 'Lane 4 (Blue)', cls: 'text-sky-400' },
  { slot: 'lane_5', label: 'Lane 5 (Orange)', cls: 'text-orange-400' },
  { slot: 'chord_12', label: 'Chord 1+2', cls: 'text-amber-200' },
  { slot: 'chord_23', label: 'Chord 2+3', cls: 'text-amber-200' },
  { slot: 'chord_34', label: 'Chord 3+4', cls: 'text-amber-200' },
  { slot: 'chord_45', label: 'Chord 4+5', cls: 'text-amber-200' },
  { slot: 'open', label: 'Open strum', cls: 'text-purple-300' },
]

function TutorialSamplesPanel({ track }: { track: Track }) {
  const [expanded, setExpanded] = useState(false)
  const [samples, setSamples] = useState<Record<string, { filename: string; size_bytes: number; mtime: number }>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [hasVoiceRef, setHasVoiceRef] = useState(false)
  const [voiceRefBust, setVoiceRefBust] = useState(0)

  const loadSamples = useCallback(() => {
    fetch(`/api/tutorial/${track.id}/samples`)
      .then((r) => (r.ok ? r.json() : {}))
      .then(setSamples)
      .catch(() => undefined)
    fetch(`/api/tutorial/${track.id}/voice-ref`, { method: 'HEAD' })
      .then((r) => setHasVoiceRef(r.ok))
      .catch(() => setHasVoiceRef(false))
  }, [track.id])

  useEffect(() => {
    if (expanded) loadSamples()
  }, [expanded, loadSamples])

  const uploadSample = async (slot: string, file: File) => {
    setBusy(slot)
    setError('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`/api/tutorial/${track.id}/samples/${slot}`, { method: 'PUT', body: fd })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Upload failed (${res.status})`)
      }
      loadSamples()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const deleteSample = async (slot: string) => {
    setBusy(slot)
    setError('')
    try {
      await fetch(`/api/tutorial/${track.id}/samples/${slot}`, { method: 'DELETE' })
      loadSamples()
    } finally {
      setBusy(null)
    }
  }

  const uploadVoiceRef = async (file: File) => {
    setBusy('_voice_ref')
    setError('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`/api/tutorial/${track.id}/voice-ref`, { method: 'POST', body: fd })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Upload failed (${res.status})`)
      }
      setHasVoiceRef(true)
      setVoiceRefBust((v) => v + 1)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const deleteVoiceRef = async () => {
    setBusy('_voice_ref')
    try {
      await fetch(`/api/tutorial/${track.id}/voice-ref`, { method: 'DELETE' })
      setHasVoiceRef(false)
    } finally {
      setBusy(null)
    }
  }

  const slotsFilled = Object.keys(samples).length

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="mt-3 w-full py-2.5 border border-purple-800 bg-purple-900/20 hover:bg-purple-900/40 text-purple-300 rounded-lg text-sm font-medium transition-colors"
      >
        Tutorial samples + voice clone {slotsFilled > 0 ? `· ${slotsFilled}/10 slots filled` : ''}
      </button>
    )
  }

  return (
    <div className="mt-4 border border-purple-900/50 rounded-xl overflow-hidden">
      <div className="bg-purple-900/20 px-4 py-3 flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold text-purple-300">Tutorial samples + voice clone</h4>
          <p className="text-xs text-gray-500">
            10 instrument samples (slide_up / slide_down auto-generated at publish)
            + an optional 5–30s voice reference for Chatterbox to clone.
          </p>
        </div>
        <button onClick={() => setExpanded(false)} className="text-gray-500 hover:text-gray-300 text-lg">&times;</button>
      </div>

      {error && (
        <div className="mx-4 mt-3 bg-red-900/30 border border-red-800 rounded p-2 text-xs text-red-300">{error}</div>
      )}

      <div className="p-4 space-y-4">
        {/* Voice ref */}
        <div className="bg-gray-950 border border-gray-800 rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-sky-300">Voice reference</span>
            <span className="text-[11px] text-gray-500">5–30s clip · cloned by TTS</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="px-2.5 py-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-xs text-gray-200 cursor-pointer">
              {hasVoiceRef ? 'Replace' : 'Upload'}
              <input
                type="file"
                accept=".wav,.ogg,.mp3,.flac,.m4a"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) uploadVoiceRef(f)
                }}
              />
            </label>
            {hasVoiceRef && (
              <>
                <audio
                  controls
                  src={`/api/tutorial/${track.id}/voice-ref?t=${voiceRefBust}`}
                  className="h-6 max-w-xs"
                />
                <button
                  onClick={deleteVoiceRef}
                  disabled={busy === '_voice_ref'}
                  className="px-2 py-1 bg-red-900/40 hover:bg-red-800/60 border border-red-800 text-red-300 rounded text-[11px]"
                >
                  Delete
                </button>
              </>
            )}
            {busy === '_voice_ref' && <span className="text-xs text-gray-500">Uploading…</span>}
          </div>
        </div>

        {/* Sample slots */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {TUTORIAL_SAMPLE_SLOTS.map(({ slot, label, cls }) => {
            const filled = samples[slot]
            return (
              <div key={slot} className="bg-gray-950 border border-gray-800 rounded p-2 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-xs font-medium ${cls}`}>{label}</span>
                  {filled && (
                    <button
                      onClick={() => deleteSample(slot)}
                      disabled={busy === slot}
                      className="text-[10px] text-red-400 hover:text-red-200"
                    >
                      delete
                    </button>
                  )}
                </div>
                {filled ? (
                  <audio
                    controls
                    src={`/api/tutorial/${track.id}/samples/${slot}/file?t=${filled.mtime}`}
                    className="w-full h-7"
                  />
                ) : (
                  <span className="text-[11px] text-gray-600">empty</span>
                )}
                <label className="block px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-center text-[11px] text-gray-300 cursor-pointer">
                  {filled ? 'Replace' : 'Upload OGG / WAV / MP3'}
                  <input
                    type="file"
                    accept=".ogg,.wav,.mp3,.flac,.m4a"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) uploadSample(slot, f)
                    }}
                  />
                </label>
                {busy === slot && <span className="text-[10px] text-gray-500">Working…</span>}
              </div>
            )
          })}
        </div>

        <p className="text-[11px] text-gray-600">
          slide_up / slide_down variants for each slot are synthesised automatically
          at publish time via ffmpeg pitch-shift (±2 semitones). No upload required.
        </p>
      </div>
    </div>
  )
}

function InlinePublish({ track }: { track: Track }) {
  const [expanded, setExpanded] = useState(false)
  const [schema, setSchema] = useState<Record<string, SongIniField>>({})
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [publishing, setPublishing] = useState(false)
  const [result, setResult] = useState<{
    commitUrl: string
    folder: string
    chart: {
      found: boolean
      source: string | null
      published_as?: string
      beatmap_id?: string
      included_stems?: string[]
      skipped_stems?: string[]
      selected_beatmaps?: Record<string, string>
    }
  } | null>(null)
  const [error, setError] = useState('')

  // Per-stem beatmap selection. Keys: stem name. Values: beatmap_id.
  // Initialised on expand to the most recently generated beatmap per stem,
  // matching the backend default. User can override via the dropdowns below.
  const beatmapsByStem = (track.beatmaps || []).reduce<Record<string, BeatmapRecord[]>>((acc, bm) => {
    if (!acc[bm.stem]) acc[bm.stem] = []
    acc[bm.stem].push(bm)
    return acc
  }, {})
  for (const stem of Object.keys(beatmapsByStem)) {
    beatmapsByStem[stem].sort((a, b) => b.generated_at - a.generated_at)
  }
  const [selectedBeatmaps, setSelectedBeatmaps] = useState<Record<string, string>>({})

  // Lightweight preview of bundle outputs that the backend's publish flow will
  // add on top of song.ogg + song.ini + notes_fixed_slides.chart:
  //   - vo/tutorial.ogg     — emitted when any selected beatmap carries
  //                            [TutorialScript] VO entries
  //   - realnotes/<pack>/<scale>/  — one folder per unique (pack, scale)
  //                                  combo any selected beatmap's R notes
  //                                  reference
  // Computed client-side by fetching each selected beatmap's chart and
  // mirroring the regex walks the backend uses (see _bundle_realnotes in
  // routers/tracks.py). Refreshes whenever the user changes the selection.
  const [publishPreview, setPublishPreview] = useState<{
    hasTutorialVo: boolean
    retryVoPaths: string[]
    realnotesCombos: Array<{ pack: string; scale: string }>
  }>({ hasTutorialVo: false, retryVoPaths: [], realnotesCombos: [] })

  useEffect(() => {
    if (!expanded) return
    if (Object.keys(beatmapsByStem).length === 0) {
      setPublishPreview({ hasTutorialVo: false, retryVoPaths: [], realnotesCombos: [] })
      return
    }
    let cancelled = false
    ;(async () => {
      let hasVo = false
      const retryPaths = new Set<string>()
      const combos = new Set<string>()
      for (const [stem, bms] of Object.entries(beatmapsByStem)) {
        const bmId = selectedBeatmaps[stem] || bms[0]?.id
        if (!bmId) continue
        try {
          const r = await fetch(`/api/tracks/${track.id}/beatmaps/${bmId}/chart`)
          if (!r.ok) continue
          const { chart } = await r.json() as { chart: string }
          // Tutorial VO check: any "<tick> = VO " line inside [TutorialScript].
          const tsMatch = chart.match(/\[TutorialScript\]\s*\{([^}]*)\}/)
          if (tsMatch) {
            if (/\d+\s*=\s*VO\s/.test(tsMatch[1])) hasVo = true
            // STEP retry_vo paths — separate ogg files that the publisher
            // copies alongside tutorial.ogg. Each unique path becomes its
            // own preview row.
            for (const m of tsMatch[1].matchAll(/\d+\s*=\s*STEP\s+[^\n]*?retry_vo="([^"]+)"/g)) {
              retryPaths.add(m[1])
            }
          }
          // Realnote combos: walk each section, track active (pack, scale)
          // from E events, record the combo when an R note follows.
          const secRe = /\[[^\]]+\]\s*\{([^}]*)\}/g
          let sm: RegExpExecArray | null
          while ((sm = secRe.exec(chart)) !== null) {
            let activePack: string | null = null
            let activeScale: string | null = null
            for (const line of sm[1].split('\n')) {
              const pp = line.match(/^\s*\d+\s*=\s*E\s+realnotes_pack\s+(\S+)/)
              if (pp) { activePack = pp[1]; continue }
              const sp = line.match(/^\s*\d+\s*=\s*E\s+realnotes_scale\s+(\S+)/)
              if (sp) { activeScale = sp[1]; continue }
              if (/^\s*\d+\s*=\s*R\s/.test(line) && activePack && activeScale) {
                combos.add(`${activePack}/${activeScale}`)
              }
            }
          }
        } catch {
          // Best-effort — failing to fetch a chart just hides the corresponding
          // preview line; the actual publish still does the right thing.
        }
      }
      if (cancelled) return
      setPublishPreview({
        hasTutorialVo: hasVo,
        retryVoPaths: [...retryPaths].sort(),
        realnotesCombos: [...combos].sort().map((s) => {
          const [pack, scale] = s.split('/')
          return { pack, scale }
        }),
      })
    })()
    return () => { cancelled = true }
    // beatmapsByStem is derived from the track prop every render and is stable
    // enough; chart-fetching only happens when expanded or selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, selectedBeatmaps, track.id])

  useEffect(() => {
    if (!expanded) return
    const init: Record<string, string> = {}
    for (const [stem, bms] of Object.entries(beatmapsByStem)) {
      const active = bms.find((bm) => bm.active)
      init[stem] = (active || bms[0])?.id || ''
    }
    setSelectedBeatmaps(init)
    // We intentionally only initialise on expand; the by-stem map is derived
    // from the prop on every render and is stable enough for this purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, track.id])

  useEffect(() => {
    if (!expanded) return
    fetch('/api/tracks/schema/song-ini')
      .then((r) => r.json())
      .then((s: Record<string, SongIniField>) => {
        setSchema(s)
        const init: Record<string, unknown> = {}
        for (const [key, field] of Object.entries(s)) {
          init[key] = field.default
        }
        init.name = track.name
        init.artist = track.artist || ''
        init.album = track.album || ''
        init.genre = track.genre || ''
        init.year = track.year || ''
        setValues(init)
      })
  }, [track, expanded])

  const setValue = (key: string, val: unknown) => {
    setValues((prev) => ({ ...prev, [key]: val }))
  }

  const handlePublish = async () => {
    setPublishing(true)
    setError('')
    try {
      const formData = new FormData()
      formData.append('song_ini', JSON.stringify(values))
      // Only send overrides for stems that actually have a beatmap selected;
      // empty entries are treated by the backend as "use latest" anyway.
      const overrides = Object.fromEntries(
        Object.entries(selectedBeatmaps).filter(([, bid]) => !!bid),
      )
      if (Object.keys(overrides).length > 0) {
        formData.append('selected_beatmaps', JSON.stringify(overrides))
      }
      const res = await fetch(`/api/tracks/${track.id}/publish-game`, { method: 'POST', body: formData })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Publish failed')
      }
      const data = await res.json()
      setResult({
        commitUrl: data.commit_url,
        folder: data.folder,
        chart: data.chart || { found: false, source: null },
      })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPublishing(false)
    }
  }

  const renderField = (key: string) => {
    const field = schema[key]
    if (!field) return null
    const val = values[key]

    if (field.type === 'bool') {
      return (
        <label key={key} className="flex items-center gap-2">
          <input type="checkbox" checked={!!val} onChange={(e) => setValue(key, e.target.checked)} className="rounded border-gray-600 bg-gray-800" />
          <span className="text-sm text-gray-300">{field.label}</span>
        </label>
      )
    }

    if (field.type === 'int') {
      return (
        <label key={key} className="block">
          <span className="text-xs text-gray-500">{field.label}</span>
          <input type="number" value={val as number} onChange={(e) => setValue(key, parseInt(e.target.value) || 0)} className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-jam-500" />
        </label>
      )
    }

    return (
      <label key={key} className="block">
        <span className="text-xs text-gray-500">{field.label}</span>
        <input type="text" value={(val as string) || ''} onChange={(e) => setValue(key, e.target.value)} className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-jam-500" />
      </label>
    )
  }

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="mt-3 w-full py-2.5 border border-green-800 bg-green-900/20 hover:bg-green-900/40 text-green-400 rounded-lg text-sm font-medium transition-colors"
      >
        Publish to Game
      </button>
    )
  }

  return (
    <div className="mt-4 border border-green-900/50 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="bg-green-900/20 px-4 py-3 flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold text-green-400">Publish to Game</h4>
          <p className="text-xs text-gray-500">Edit song.ini, then publish stems to GitHub</p>
        </div>
        <button onClick={() => setExpanded(false)} className="text-gray-500 hover:text-gray-300 text-lg">&times;</button>
      </div>

      {/* Stem mapping — preview of what lands in the published folder */}
      <div className="px-4 py-2 bg-gray-800/30 border-b border-gray-800">
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs font-mono text-gray-600">
          {Object.keys(track.stems)
            .filter((s) => !NON_AUDIO_KEYS.has(s) && s !== 'song')
            .map((s) => {
              const gameName = ({ bass: 'rhythm', other: 'crowd' } as Record<string, string>)[s] || s
              return (
                <span key={s}>
                  {s !== gameName ? `${s} → ` : ''}
                  <span className={STEM_COLORS[s] || 'text-gray-400'}>{gameName}.ogg</span>
                </span>
              )
            })}
          <span>+ <span className="text-gray-300">song.ogg</span></span>
          <span>+ <span className="text-yellow-400">song.ini</span></span>
          {!!track.stems.album_png && (
            <span>+ <span className="text-pink-300">album.png</span></span>
          )}
          {(track.beatmaps && track.beatmaps.length > 0) ? (
            <span>+ <span className="text-emerald-400">notes_fixed_slides.chart</span></span>
          ) : (
            <span className="text-amber-500/80" title="No beatmap on this track yet — generate one before publishing or the song won't load">
              ⚠ no notes_fixed_slides.chart
            </span>
          )}
          {publishPreview.hasTutorialVo && (
            <span title="Collated VO clips referenced by the chart's [TutorialScript] entries. Played by the engine at each VO event's start_ms/duration_ms offset.">
              + <span className="text-cyan-300">vo/tutorial.ogg</span>
            </span>
          )}
          {publishPreview.retryVoPaths
            .filter((p) => !(publishPreview.hasTutorialVo && p === 'vo/tutorial.ogg'))
            .map((p) => (
              <span key={p} title="Standalone retry clip referenced by STEP retry_vo. The engine plays the whole file when the section's required-hit count isn't met.">
                + <span className="text-cyan-300/80">{p}</span>
              </span>
            ))}
          {publishPreview.realnotesCombos.length > 0 && (
            <span
              title={`Real-note bundles copied verbatim from web/backend/sample_packs_data/. One folder per (pack, scale) combo referenced by R notes:\n${publishPreview.realnotesCombos.map((c) => `  realnotes/${c.pack}/${c.scale}/`).join('\n')}`}
            >
              + <span className="text-purple-300">realnotes/</span>
              <span className="text-gray-600"> ({publishPreview.realnotesCombos.length} {publishPreview.realnotesCombos.length === 1 ? 'combo' : 'combos'})</span>
            </span>
          )}
        </div>
        {publishPreview.realnotesCombos.length > 0 && (
          <details className="mt-1.5 text-[11px] font-mono text-gray-600">
            <summary className="cursor-pointer hover:text-gray-400 select-none">
              realnotes/ folders ({publishPreview.realnotesCombos.length})
            </summary>
            <ul className="mt-1 pl-4 space-y-0.5">
              {publishPreview.realnotesCombos.map((c) => (
                <li key={`${c.pack}/${c.scale}`} className="text-purple-300/80">
                  realnotes/{c.pack}/{c.scale}/
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {/* Beatmaps to publish — one per stem. Defaults to latest per stem; user
          can override via dropdown. Stems with no beatmap are omitted; stems
          with a single beatmap render as a static label. */}
      {Object.keys(beatmapsByStem).length > 0 && (
        <div className="px-4 py-3 border-b border-gray-800 space-y-2">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-emerald-400 text-xs font-mono">notes_fixed_slides.chart</span>
            <span className="text-gray-700 text-xs">beatmaps merged into the published chart</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {Object.entries(beatmapsByStem).map(([stem, bms]) => {
              const colour = STEM_COLORS[stem] || 'text-gray-300'
              const stemLabel = STEM_LABELS[stem] || stem
              // Mirror the per-stem beatmap-list chips so the dropdown speaks
              // the same vocabulary: preset name (or "Custom" for V2 ad-hoc /
              // the model name for V1 / manual / imported records) followed
              // by the generated-at timestamp, plus a custom song_name tail
              // when the user renamed the beatmap away from the default.
              const defaultName = `${track.name} (${stemLabel})`
              const fmtBm = (bm: BeatmapRecord) => {
                const date = new Date(bm.generated_at * 1000).toLocaleString(undefined, {
                  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                })
                const preset = (bm.preset || '').trim()
                const model = (bm.model || '').toLowerCase()
                const modelVer = (bm.model_version || '').trim()
                const isV2 = modelVer.endsWith('+v2')
                let label: string
                if (preset) label = preset
                else if (model === 'madmom' && isV2) label = 'Custom'
                else if (model) label = model
                else label = 'unknown'
                const liveName = (bm.song_name || '').trim()
                const baseName = liveName.replace(/(\s*\(copy\))+$/i, '')
                const isCustomName = !!liveName && baseName !== defaultName
                return isCustomName ? `${label} · ${date} · ${liveName}` : `${label} · ${date}`
              }
              return (
                <div key={stem} className="flex items-center gap-2">
                  <span className={`shrink-0 text-xs font-medium w-16 ${colour}`}>{stemLabel}</span>
                  {bms.length === 1 ? (
                    <span className="text-xs text-gray-400 truncate" title={fmtBm(bms[0])}>
                      {fmtBm(bms[0])}
                    </span>
                  ) : (
                    <select
                      value={selectedBeatmaps[stem] || bms[0].id}
                      onChange={(e) => setSelectedBeatmaps((prev) => ({ ...prev, [stem]: e.target.value }))}
                      className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-jam-500"
                    >
                      {bms.map((bm) => (
                        <option key={bm.id} value={bm.id}>
                          {fmtBm(bm)}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )
            })}
          </div>
          <p className="text-[11px] text-gray-600">
            Latest beatmap per stem is selected by default. Pick a different one to publish that take instead.
          </p>
        </div>
      )}

      {/* song.ini form */}
      <div className="p-4 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-yellow-400 text-xs font-mono">song.ini</span>
          <span className="text-gray-700 text-xs">[song]</span>
        </div>
        {FIELD_GROUPS.map((group) => (
          <div key={group.title}>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">{group.title}</h4>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {group.fields.map((f) => renderField(f))}
            </div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="px-4 py-3 border-t border-gray-800 space-y-3">
        {!result && (
          <button
            onClick={handlePublish}
            disabled={publishing}
            className="px-6 py-2.5 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white rounded-lg font-medium transition-colors"
          >
            {publishing ? 'Publishing...' : 'Publish to GitHub'}
          </button>
        )}

        {publishing && (
          <div className="flex items-center gap-2">
            <div className="animate-spin h-4 w-4 border-2 border-green-400 border-t-transparent rounded-full" />
            <span className="text-sm text-gray-400">Packaging stems and pushing to GitHub...</span>
          </div>
        )}

        {result && (
          <div className="bg-green-900/20 border border-green-800 rounded-lg p-4 space-y-2">
            <p className="text-sm text-green-400 font-medium">Published!</p>
            <p className="text-xs text-gray-500 font-mono">{result.folder}</p>
            {result.chart.found ? (
              <p className="text-xs text-gray-500">
                Included <span className="font-mono text-gray-300">{result.chart.published_as || 'notes_fixed_slides.chart'}</span>
                {result.chart.included_stems && result.chart.included_stems.length > 0 && (
                  <span className="text-gray-600"> · stems: {result.chart.included_stems.join(', ')}</span>
                )}
                {result.chart.skipped_stems && result.chart.skipped_stems.length > 0 && (
                  <span className="text-amber-500/80"> · skipped: {result.chart.skipped_stems.join(', ')}</span>
                )}
              </p>
            ) : (
              <p className="text-xs text-amber-400">
                ⚠ No beatmap found for this track — published without notes_fixed_slides.chart. Generate a beatmap on a stem and re-publish.
              </p>
            )}
            <a href={result.commitUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-jam-400 hover:text-jam-300 underline">
              View commit on GitHub
            </a>
          </div>
        )}

        {error && (
          <div className="bg-red-900/30 border border-red-800 rounded-lg p-3 text-sm text-red-400">{error}</div>
        )}
      </div>
    </div>
  )
}

// Keys that historically appeared in stems map but aren't audio
const NON_AUDIO_KEYS = new Set(['song_ini', 'album_png'])

interface JobRow {
  id: string
  kind: string
  title: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  progress: number
  last_message: string
  created_at: number
  updated_at: number
  error: string | null
  track_id: string | null
}

const JOB_STATUS_PILL: Record<JobRow['status'], { label: string; cls: string }> = {
  queued: { label: 'Queued', cls: 'bg-gray-700/50 text-gray-300 border-gray-600' },
  running: { label: 'Running', cls: 'bg-jam-600/20 text-jam-300 border-jam-600/40' },
  done: { label: 'Done', cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-800/60' },
  failed: { label: 'Failed', cls: 'bg-red-900/40 text-red-300 border-red-800/60' },
  cancelled: { label: 'Cancelled', cls: 'bg-amber-900/30 text-amber-300 border-amber-800/60' },
}

function InlineBeatmapProgress({
  jobId,
  onDone,
  onCancelled,
  onError,
}: {
  jobId: string
  onDone?: () => void
  onCancelled?: () => void
  onError?: () => void
}) {
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState('Starting…')
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  // Keep the latest callbacks in a ref so the SSE effect below depends ONLY on
  // jobId. If these inline props sat in the dep array, every parent re-render
  // (and a running batch triggers many — setBeatmapQueue/loadTracks/etc.) would
  // tear down and reopen the EventSource. That churn is what used to drop the
  // terminal `done` frame mid-batch and silently abandon the remaining presets.
  const cbRef = useRef({ onDone, onCancelled, onError })
  cbRef.current = { onDone, onCancelled, onError }

  useEffect(() => {
    const es = new EventSource(`/api/jobs/${jobId}/events`)
    let settled = false
    let poll: ReturnType<typeof setInterval> | null = null
    const stopPoll = () => { if (poll) { clearInterval(poll); poll = null } }

    // Fire a terminal callback exactly once, from whichever source (the live
    // SSE stream or the poll backstop) observes the terminal state first.
    const settle = (kind: 'done' | 'error' | 'cancelled', msg?: string) => {
      if (settled) return
      settled = true
      stopPoll()
      es.close()
      if (kind === 'done') { setDone(true); cbRef.current.onDone?.() }
      else if (kind === 'cancelled') { cbRef.current.onCancelled?.() }
      else { setError(msg || 'Generation failed'); cbRef.current.onError?.() }
    }

    // Authoritative terminal-state backstop. If the SSE connection is dropping
    // (proxy blip, tab throttling, half-open socket), poll the job snapshot so
    // the batch still advances instead of stalling — or, worse, being wiped.
    const startPoll = () => {
      if (poll || settled) return
      poll = setInterval(async () => {
        try {
          const r = await fetch(`/api/jobs/${jobId}`)
          if (!r.ok) return
          const j = await r.json()
          if (j.status === 'done') settle('done')
          else if (j.status === 'failed') settle('error', j.error || 'Generation failed')
          else if (j.status === 'cancelled') settle('cancelled')
        } catch {
          /* transient — keep polling */
        }
      }, 3000)
    }

    es.onmessage = (e) => {
      const d = JSON.parse(e.data)
      if (typeof d.progress === 'number' && d.progress >= 0) setProgress(d.progress)
      if (d.message) setMessage(d.message)
      if (d.step === 'done' && d.metadata) settle('done')
      else if (d.step === 'error') settle('error', d.message)
      else if (d.step === 'cancelled') settle('cancelled')
    }
    es.onerror = () => {
      // NOT necessarily terminal: EventSource fires onerror on recoverable
      // drops too and reconnects on its own (the /events endpoint replays the
      // full log on reconnect, so no progress is lost). Rather than declaring
      // the job dead and abandoning the batch, lean on the poll backstop to
      // confirm the real terminal state.
      startPoll()
    }

    return () => { settled = true; stopPoll(); es.close() }
  }, [jobId])

  if (done) return <div className="text-[11px] text-emerald-400 mt-1">Generated ✓</div>
  if (error) return <div className="text-[11px] text-red-400 mt-1 truncate" title={error}>{error}</div>
  return (
    <div className="mt-1 space-y-1">
      <div className="w-full bg-gray-900 rounded-full h-1 overflow-hidden">
        <div
          className="bg-jam-500 h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.max(progress, 2)}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-1">
        <span className="text-[10px] text-gray-500 truncate flex-1" title={message}>{message}</span>
        <button
          onClick={async () => {
            try {
              await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' })
            } catch {
              // best-effort
            }
          }}
          className="shrink-0 px-1.5 py-0.5 bg-red-900/40 hover:bg-red-800/60 border border-red-800 text-red-300 hover:text-red-200 rounded text-[9px] font-medium transition-colors"
        >
          Kill
        </button>
      </div>
    </div>
  )
}

export default function TracksPage() {
  // BusyProvider scopes the one-task-at-a-time lock to this page so vocals
  // tasks (LRClib / Whisper / Vocalmap) and inline per-stem beatmap jobs
  // can't overlap.
  return (
    <BusyProvider>
      <TracksPageInner />
    </BusyProvider>
  )
}

function TracksPageInner() {
  const [tracks, setTracks] = useState<Track[]>([])
  const [jobs, setJobs] = useState<JobRow[]>([])
  const [loading, setLoading] = useState(true)
  const [beatmapPanel, setBeatmapPanel] = useState<{ track: Track; stem: string } | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const lock = useExclusiveTask()
  const selectedId = searchParams.get('id')
  const setSelectedId = useCallback(
    (id: string | null) => {
      if (id) setSearchParams({ id }, { replace: false })
      else setSearchParams({}, { replace: false })
    },
    [setSearchParams],
  )
  const [selectedForCompare, setSelectedForCompare] = useState<Set<string>>(new Set())
  const toggleCompare = useCallback((id: string) => {
    setSelectedForCompare((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const [confirmDelete, setConfirmDelete] = useState<Track | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [statsBeatmap, setStatsBeatmap] = useState<BeatmapRecord | null>(null)
  const [cloneDiffFor, setCloneDiffFor] = useState<ChartRow | null>(null)
  const [cloneDiffMsg, setCloneDiffMsg] = useState('')
  const [coverFetchState, setCoverFetchState] = useState<'idle' | 'loading' | 'none' | 'error'>('idle')
  // Inline beatmap generation: per-stem job id when one is in flight, plus
  // tickbox selection for the batch-generate button below the stem grid.
  const [selectedStems, setSelectedStems] = useState<Set<string>>(new Set())
  const [inlineBmJobs, setInlineBmJobs] = useState<Record<string, string>>({})
  // Per-stem queue of V2 generations waiting behind the active inlineBmJobs
  // entry. Populated by BeatmapPanel's onBatchGenerate; drained as each
  // SSE-done fires. queueSongIni carries the modal's song.ini overrides for
  // every item in the same stem's batch (every preset gets the same name/
  // artist/etc.).
  const [beatmapQueue, setBeatmapQueue] = useState<Record<string, QueuedGeneration[]>>({})
  const [queueSongIni, setQueueSongIni] = useState<Record<string, Record<string, unknown>>>({})
  const beatmapQueueRef = useRef(beatmapQueue)
  beatmapQueueRef.current = beatmapQueue
  const queueSongIniRef = useRef(queueSongIni)
  queueSongIniRef.current = queueSongIni
  // Multi-stem queue for the "Generate beatmap for N selected stems" button —
  // stems waiting their turn behind whichever stem is currently in flight.
  // batchTotal is the original size of that batch (only set while a multi-
  // stem batch is running, so a single-stem fire keeps the row clean).
  const [pendingStems, setPendingStems] = useState<string[]>([])
  const [batchTotal, setBatchTotal] = useState<number | null>(null)
  const pendingStemsRef = useRef(pendingStems)
  pendingStemsRef.current = pendingStems
  const [hasVocalNotes, setHasVocalNotes] = useState(false)
  // Current session — surfaced for FeedbackButton (and downstream feedback
  // delete permissions). Cookie auth carries on /api/feedback/* requests, but
  // the FeedbackPanel needs to know who "you" are to enable the delete buttons
  // on your own notes. Fetched once on mount; null until resolved.
  const [me, setMe] = useState<{ username: string; role: string } | null>(null)
  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((d) => {
        if (d && d.authenticated) setMe({ username: d.username, role: d.role })
      })
      .catch(() => {})
  }, [])
  const installedMadmom = useInstalledVersion('madmom')
  const beatmapBtnLabel = installedMadmom
    ? `Generate Beatmap with madmom ${installedMadmom}`
    : 'Generate Beatmap'

  const refetchHasVocalNotes = useCallback(async () => {
    if (!selectedId) { setHasVocalNotes(false); return }
    try {
      // Presence probe — /api/vocals/exists returns 200 with {exists: bool}
      // so the console isn't littered with 404s for tracks that haven't had
      // a vocal beatmap generated yet.
      const r = await fetch(`/api/vocals/exists?track_id=${selectedId}`)
      if (!r.ok) { setHasVocalNotes(false); return }
      const data = await r.json()
      setHasVocalNotes(!!data.exists)
    } catch {
      setHasVocalNotes(false)
    }
  }, [selectedId])

  useEffect(() => { refetchHasVocalNotes() }, [refetchHasVocalNotes])

  // Auto-tick stems that already have a chart on initial load of a track so
  // the user can see at a glance what's covered (and one-click batch-regen
  // those stems via a new preset selection). Tracked per-trackId so manual
  // unticks after the first pass stick. Vocals lags behind beatmaps because
  // its presence comes from a separate async probe, so it gets its own
  // "applied" flag and folds in once `hasVocalNotes` resolves.
  const autoTickRef = useRef<{ trackId: string; vocalsApplied: boolean }>({ trackId: '', vocalsApplied: false })
  useEffect(() => {
    const tid = selectedId || ''
    const track = tracks.find((t) => t.id === tid) || null
    if (!track) {
      autoTickRef.current = { trackId: '', vocalsApplied: false }
      return
    }
    if (autoTickRef.current.trackId !== tid) {
      const next = new Set<string>()
      for (const bm of track.beatmaps || []) next.add(bm.stem)
      setSelectedStems(next)
      autoTickRef.current = { trackId: tid, vocalsApplied: false }
    }
    if (
      hasVocalNotes &&
      !autoTickRef.current.vocalsApplied &&
      Object.prototype.hasOwnProperty.call(track.stems, 'vocals')
    ) {
      setSelectedStems((prev) => {
        if (prev.has('vocals')) return prev
        const next = new Set(prev)
        next.add('vocals')
        return next
      })
      autoTickRef.current.vocalsApplied = true
    }
  }, [selectedId, tracks, hasVocalNotes])

  const deleteVocalNotes = async () => {
    if (!selectedId) return
    if (!window.confirm('Delete the vocal beatmap for this track? Lyrics versions are kept.')) return
    try {
      const r = await fetch(`/api/vocals?track_id=${selectedId}`, { method: 'DELETE' })
      if (!r.ok) {
        const e = await r.json().catch(() => ({}))
        throw new Error(e.detail || `HTTP ${r.status}`)
      }
      setHasVocalNotes(false)
    } catch (e) {
      alert((e as Error).message)
    }
  }
  const [batchError, setBatchError] = useState('')

  // song.ini editor state for the detail view
  const [songIni, setSongIni] = useState<Record<string, string>>({})
  const [iniSaveState, setIniSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [iniError, setIniError] = useState('')
  const [albumArtFile, setAlbumArtFile] = useState<File | null>(null)
  const [albumPreview, setAlbumPreview] = useState<string | null>(null)
  const albumInputRef = useRef<HTMLInputElement | null>(null)
  const updateIni = (key: string, value: string) =>
    setSongIni((prev) => ({ ...prev, [key]: value }))
  const handleAlbumPick = (f: File | null) => {
    if (!f) return
    if (albumPreview && albumPreview.startsWith('blob:')) URL.revokeObjectURL(albumPreview)
    setAlbumArtFile(f)
    setAlbumPreview(URL.createObjectURL(f))
  }

  const loadTracks = useCallback(() => {
    fetch('/api/tracks')
      .then((r) => r.json())
      .then((data) => {
        setTracks(data)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const loadJobs = useCallback(() => {
    // Pull recent stem-related jobs. Beatmap jobs are surfaced inside the track
    // detail view, so they don't belong as ghost rows in the library list.
    fetch('/api/jobs?limit=30')
      .then((r) => (r.ok ? r.json() : []))
      .then((data: JobRow[]) => {
        const filtered = (data || []).filter(
          (j) => j.kind === 'separate' || j.kind === 'manual_stems',
        )
        setJobs(filtered)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => { loadTracks(); loadJobs() }, [loadTracks, loadJobs])

  // Poll jobs while any are still running so the status pill stays live
  useEffect(() => {
    const anyActive = jobs.some((j) => j.status === 'queued' || j.status === 'running')
    if (!anyActive) return
    const t = window.setInterval(() => {
      loadJobs()
      // Also refresh tracks so finished separations appear without a manual refresh
      loadTracks()
    }, 4000)
    return () => window.clearInterval(t)
  }, [jobs, loadJobs, loadTracks])

  // Whenever the user selects a different track, hydrate the metadata panel
  useEffect(() => {
    if (!selectedId) {
      if (albumPreview && albumPreview.startsWith('blob:')) URL.revokeObjectURL(albumPreview)
      setSongIni({})
      setAlbumArtFile(null)
      setAlbumPreview(null)
      setIniSaveState('idle')
      setIniError('')
      return
    }
    const track = tracks.find((t) => t.id === selectedId)
    if (!track) return
    fetch(`/api/tracks/${selectedId}/song-ini`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((data: Record<string, unknown>) => {
        const out: Record<string, string> = {}
        for (const [k, v] of Object.entries(data)) out[k] = String(v ?? '')
        // Fall back to track-level metadata when song.ini is missing fields
        if (!out.name && track.name) out.name = track.name
        if (!out.artist && track.artist) out.artist = track.artist
        if (!out.album && track.album) out.album = track.album
        if (!out.genre && track.genre) out.genre = track.genre
        if (!out.year && track.year) out.year = track.year
        setSongIni(out)
      })
      .catch(() => setSongIni({}))

    if (track.stems.album_png) {
      setAlbumPreview(`/api/tracks/${selectedId}/stems/album_png`)
    } else {
      setAlbumPreview(null)
    }
    setAlbumArtFile(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, tracks])

  const saveTrackSongIni = async () => {
    if (!selectedId) return
    setIniSaveState('saving')
    setIniError('')
    try {
      const fd = new FormData()
      fd.append('fields', JSON.stringify(songIni))
      if (albumArtFile) fd.append('album_art', albumArtFile)
      const res = await fetch(`/api/tracks/${selectedId}/song-ini`, { method: 'PATCH', body: fd })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Save failed: ${res.status}`)
      }
      const updated = await res.json()
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(updated)) out[k] = String(v ?? '')
      setSongIni(out)
      if (albumArtFile) {
        if (albumPreview && albumPreview.startsWith('blob:')) URL.revokeObjectURL(albumPreview)
        setAlbumArtFile(null)
        setAlbumPreview(`/api/tracks/${selectedId}/stems/album_png?t=${Date.now()}`)
      }
      setIniSaveState('saved')
      setTimeout(() => setIniSaveState('idle'), 2000)
      // Refresh track list so the row reflects new name/artist
      loadTracks()
    } catch (e) {
      setIniError((e as Error).message)
      setIniSaveState('error')
    }
  }

  const handleDelete = async (id: string) => {
    await fetch(`/api/tracks/${id}`, { method: 'DELETE' })
    loadTracks()
  }

  // Reset inline beatmap state when switching tracks so jobs don't bleed across rows
  useEffect(() => {
    setSelectedStems(new Set())
    setInlineBmJobs({})
    setBatchError('')
  }, [selectedId])

  const toggleSelectedStem = (stem: string) =>
    setSelectedStems((prev) => {
      const next = new Set(prev)
      if (next.has(stem)) next.delete(stem)
      else next.add(stem)
      return next
    })

  const startQuickBeatmap = useCallback(
    async (stem: string): Promise<string | null> => {
      const track = tracks.find((t) => t.id === selectedId)
      if (!track) return null
      const lockId = stem === 'vocals' ? 'vocalmap' : `beatmap:${stem}`
      if (!lock.acquire(lockId)) return null
      try {
        if (stem === 'vocals') {
          const meta = {
            artist: (songIni.artist || track.artist || '').trim(),
            title: (songIni.name || track.name || '').trim(),
            album: (songIni.album || track.album || '').trim() || undefined,
          }
          const res = await fetch(`/api/vocals/generate?track_id=${track.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(meta),
          })
          if (!res.ok) {
            const err = await res.json().catch(() => ({}))
            throw new Error(err.detail || `Failed (${res.status})`)
          }
          const { job_id } = await res.json()
          setInlineBmJobs((prev) => ({ ...prev, [stem]: job_id }))
          return job_id
        }
        const fd = new FormData()
        fd.append('stem', stem)
        fd.append('name', (songIni.name || track.name || '').trim())
        fd.append('artist', (songIni.artist || track.artist || 'Unknown').trim())
        fd.append('album', (songIni.album || track.album || 'Unknown').trim())
        fd.append('genre', (songIni.genre || track.genre || 'Unknown').trim())
        fd.append('year', (songIni.year || track.year || '').trim())
        // The backend now defaults five_lane_drums=true. Pass it explicitly for
        // drums stems so it sticks regardless of any future schema flip.
        if (stem === 'drums') fd.append('five_lane_drums', 'true')
        const res = await fetch(`/api/tracks/${track.id}/generate-beatmap`, {
          method: 'POST',
          body: fd,
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.detail || `Failed (${res.status})`)
        }
        const { job_id } = await res.json()
        setInlineBmJobs((prev) => ({ ...prev, [stem]: job_id }))
        return job_id
      } catch (e) {
        lock.release()
        setBatchError((e as Error).message)
        return null
      }
    },
    [tracks, selectedId, songIni, lock],
  )

  // Drain the next pending stem (if any) in the multi-stem batch and fire
  // its V1 quick generation. Called from the InlineBeatmapProgress callbacks
  // once the active stem finishes so the queue actually advances instead of
  // getting wedged behind the page-scoped lock (the for-await version below
  // tried to fire them in parallel, which the lock denied silently).
  const triggerNextBatchStem = useCallback(() => {
    const remaining = pendingStemsRef.current
    if (remaining.length === 0) {
      setBatchTotal(null)
      return false
    }
    const [next, ...rest] = remaining
    setPendingStems(rest)
    startQuickBeatmap(next).catch(() => { /* startQuickBeatmap already surfaces errors via setBatchError */ })
    return true
  }, [startQuickBeatmap])

  const generateSelected = useCallback(() => {
    setBatchError('')
    // Vocals lives in selectedStems but its progress doesn't flow through
    // InlineBeatmapProgress (VocalmapButtons owns its own SSE), so the queue
    // can't dequeue past it. Filter it out — users generate vocals from the
    // vocals row's own buttons.
    const targets = Array.from(selectedStems).filter(
      (stem) => stem !== 'vocals' && !inlineBmJobs[stem],
    )
    if (targets.length === 0) return
    if (lock.owner) {
      setBatchError('Wait for the current task to finish.')
      return
    }
    setSelectedStems(new Set())
    if (targets.length > 1) {
      setBatchTotal(targets.length)
      setPendingStems(targets.slice(1))
    } else {
      setBatchTotal(null)
      setPendingStems([])
    }
    startQuickBeatmap(targets[0])
  }, [selectedStems, inlineBmJobs, startQuickBeatmap, lock])

  const performConfirmedDelete = async () => {
    if (!confirmDelete) return
    setDeleting(true)
    try {
      await handleDelete(confirmDelete.id)
      setSelectedId(null)
      setConfirmDelete(null)
    } finally {
      setDeleting(false)
    }
  }

  const formatDate = (ts: number) => {
    return new Date(ts * 1000).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  // V2 batch generation — fires one item against the V2 endpoint with
  // the song.ini overrides the BeatmapPanel collected. Sets inlineBmJobs[stem]
  // so the existing <InlineBeatmapProgress> picks it up. Throws on HTTP failure.
  const fireOneV2 = useCallback(async (
    trackId: string,
    stem: string,
    item: QueuedGeneration,
    values: Record<string, unknown>,
  ) => {
    const fd = new FormData()
    fd.append('stem', stem)
    for (const [key, val] of Object.entries(values)) {
      fd.append(key, String(val ?? ''))
    }
    for (const stage of Object.keys(GENERATION_STAGE_LABELS) as GenerationStage[]) {
      const sel = item.generation[stage]
      const fieldPrefix =
        stage === 'lanes_expert' ? 'lanes' :
        stage === 'lanes_filtered' ? 'playability' :
        stage
      fd.append(`${fieldPrefix}_engine`, sel.engine)
      fd.append(`${fieldPrefix}_params`, JSON.stringify(sel.params))
    }
    if (item.preset) fd.append('preset', item.preset)
    const res = await fetch(`/api/tracks/${trackId}/generate-beatmap-v2`, { method: 'POST', body: fd })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.detail || 'Failed to start beatmap generation')
    }
    const { job_id } = await res.json()
    setInlineBmJobs((prev) => ({ ...prev, [stem]: job_id }))
  }, [])

  // Hand-off target for BeatmapPanel's onBatchGenerate. Acquires the per-stem
  // lock, sets up the queue, and fires the first item. The InlineBeatmapProgress
  // SSE callbacks below drain the rest one at a time.
  const startV2Batch = useCallback((
    trackId: string,
    stem: string,
    queue: QueuedGeneration[],
    values: Record<string, unknown>,
  ) => {
    if (queue.length === 0) return
    if (!lock.acquire(`beatmap:${stem}`)) return
    setBeatmapQueue((prev) => ({ ...prev, [stem]: queue.slice(1) }))
    setQueueSongIni((prev) => ({ ...prev, [stem]: values }))
    fireOneV2(trackId, stem, queue[0], values).catch((e) => {
      setBatchError((e as Error).message)
      setBeatmapQueue((prev) => { const n = { ...prev }; delete n[stem]; return n })
      setQueueSongIni((prev) => { const n = { ...prev }; delete n[stem]; return n })
      lock.release()
    })
  }, [lock, fireOneV2])

  // Drain the next queued item for `stem`. Returns true if it fired the next
  // one; false if the queue was empty (caller should release the lock).
  const dequeueV2 = useCallback((trackId: string, stem: string): boolean => {
    const remaining = beatmapQueueRef.current[stem] || []
    if (remaining.length === 0) return false
    const item = remaining[0]
    const values = queueSongIniRef.current[stem] || {}
    setBeatmapQueue((prev) => {
      const arr = prev[stem] || []
      const n = { ...prev }
      if (arr.length <= 1) delete n[stem]
      else n[stem] = arr.slice(1)
      return n
    })
    setInlineBmJobs((prev) => { const n = { ...prev }; delete n[stem]; return n })
    fireOneV2(trackId, stem, item, values).catch((e) => {
      setBatchError((e as Error).message)
      setBeatmapQueue((prev) => { const n = { ...prev }; delete n[stem]; return n })
      setQueueSongIni((prev) => { const n = { ...prev }; delete n[stem]; return n })
      lock.release()
    })
    return true
  }, [lock, fireOneV2])

  const selectedTrack = tracks.find((t) => t.id === selectedId) || null

  if (selectedTrack) {
    return (
      <div className="space-y-6">
        <button
          onClick={() => setSelectedId(null)}
          className="text-sm text-gray-400 hover:text-gray-200 transition-colors"
        >
          ← Back to library
        </button>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h3 className="font-semibold text-gray-100 text-lg">
                {(() => {
                  const liveName = (songIni.name || '').trim() || selectedTrack.name
                  const liveArtist = (songIni.artist || '').trim() || selectedTrack.artist
                  return liveArtist ? `${liveArtist} — ${liveName}` : liveName
                })()}
              </h3>
              <p className="text-xs text-gray-600 mt-0.5">
                {formatDate(selectedTrack.created_at)} &middot; {selectedTrack.model} &middot;{' '}
                {selectedTrack.output_format.toUpperCase()}
              </p>
            </div>
            <button
              onClick={() => setConfirmDelete(selectedTrack)}
              className="px-3 py-1.5 bg-red-900/40 hover:bg-red-800/60 border border-red-800/60 hover:border-red-700 text-red-300 hover:text-red-200 rounded-md text-xs font-medium transition-colors"
            >
              Delete track
            </button>
          </div>

          <div className="flex flex-col gap-2">
            {Object.entries(selectedTrack.stems)
              .filter(([stem]) => !NON_AUDIO_KEYS.has(stem))
              .map(([stem]) => (
                <div
                  key={stem}
                  className="bg-gray-800 border border-gray-700 rounded-lg p-3 flex flex-col gap-3 relative"
                >
                  {/* Top row: identity + waveform spanning the full width */}
                  <div className="flex items-center gap-3">
                    {/* Identity: checkbox + stem label */}
                    <div className="w-24 shrink-0 flex items-center justify-center gap-2">
                      {stem !== 'song' ? (
                        <input
                          type="checkbox"
                          checked={selectedStems.has(stem)}
                          onChange={() => toggleSelectedStem(stem)}
                          className="h-4 w-4 rounded border-gray-600 bg-gray-900 accent-jam-500 cursor-pointer shrink-0"
                          aria-label={`Select ${STEM_LABELS[stem] || stem} for batch beatmap`}
                          title="Select for batch beatmap generation"
                        />
                      ) : (
                        <div className="h-4 w-4 shrink-0" />
                      )}
                      <span className={`text-sm font-semibold ${STEM_COLORS[stem] || 'text-gray-300'}`}>
                        {STEM_LABELS[stem] || stem}
                      </span>
                    </div>

                    {/* Waveform (gets the rest of the width) */}
                    <div className="flex-1 min-w-0 flex items-center">
                      <StemPlayer src={`/api/tracks/${selectedTrack.id}/stems/${stem}`} />
                    </div>
                  </div>

                  {/* Bottom row: actions + beatmap list, full width so each row stays on one line */}
                  <div className="flex flex-col gap-1.5">
                  {stem === 'vocals' && (
                    <>
                      <LyricsButtons
                        scope={{ trackId: selectedTrack.id }}
                        hasVocals={true}
                        meta={{
                          artist: (songIni.artist || '').trim() || selectedTrack.artist,
                          title: (songIni.name || '').trim() || selectedTrack.name,
                          album: (songIni.album || '').trim() || selectedTrack.album,
                          duration_s: undefined,
                        }}
                      />
                      <VocalmapButtons
                        scope={{ trackId: selectedTrack.id }}
                        meta={{
                          artist: (songIni.artist || '').trim() || selectedTrack.artist,
                          title: (songIni.name || '').trim() || selectedTrack.name,
                          album: (songIni.album || '').trim() || selectedTrack.album,
                        }}
                        hasActive={hasVocalNotes}
                        onActiveChange={refetchHasVocalNotes}
                      />
                      {hasVocalNotes && (
                        <button
                          onClick={deleteVocalNotes}
                          className="self-end px-1.5 py-0.5 bg-red-900/40 hover:bg-red-800/60 border border-red-800/60 text-red-300 hover:text-red-200 rounded text-[10px] transition-colors"
                          title="Delete vocal_notes.json for this track"
                          aria-label="Delete vocalmap"
                        >
                          delete vocalmap
                        </button>
                      )}
                    </>
                  )}
                  {stem !== 'vocals' && (
                    <div className="flex items-stretch gap-1">
                      {stem === 'song' ? (
                        <a
                          href={`/api/tracks/${selectedTrack.id}/stems/${stem}`}
                          className="flex-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded text-xs font-medium transition-colors text-center"
                        >
                          Download
                        </a>
                      ) : (
                        <>
                          <button
                            onClick={() => startQuickBeatmap(stem)}
                            disabled={!!inlineBmJobs[stem] || lock.lockedByOther(`beatmap:${stem}`)}
                            className="flex-1 px-3 py-1.5 bg-green-700/60 hover:bg-green-600/70 disabled:opacity-50 text-green-100 rounded text-xs font-medium transition-colors"
                            title={lock.lockedByOther(`beatmap:${stem}`) ? 'Another task is running' : 'Generate beatmap with the installed madmom model'}
                          >
                            {beatmapBtnLabel}
                          </button>
                          <button
                            onClick={() => setBeatmapPanel({ track: selectedTrack, stem })}
                            disabled={!!inlineBmJobs[stem] || lock.lockedByOther(`beatmap:${stem}`)}
                            className="px-2 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-200 rounded text-xs font-medium transition-colors"
                            title={lock.lockedByOther(`beatmap:${stem}`) ? 'Another task is running' : 'Advanced settings & download stem'}
                            aria-label="Advanced settings & download stem"
                          >
                            ⚙
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {/* Surface the empty-editor entry point on every non-vocals,
                      non-song stem so users can start a fresh manual chart even
                      if a beatmap already exists. Vocals uses VocalmapButtons
                      and doesn't need an empty-editor path. The song-stem
                      gets the link too so tutorial tracks (whose only stem
                      is 'song') aren't stranded without a way to drop new
                      empty beatmaps. */}
                  {stem !== 'vocals' && !inlineBmJobs[stem] && (
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const fd = new FormData()
                            fd.append('stem', stem)
                            const res = await fetch(`/api/tracks/${selectedTrack.id}/empty-beatmap`, { method: 'POST', body: fd })
                            if (!res.ok) {
                              const err = await res.json().catch(() => ({}))
                              throw new Error(err.detail || `Failed (${res.status})`)
                            }
                            const data = await res.json()
                            navigate(`/edit/${data.track_id}/${data.beatmap_id}`)
                          } catch (e) {
                            setBatchError((e as Error).message)
                          }
                        }}
                        className="text-[11px] text-gray-500 hover:text-jam-300 underline-offset-2 hover:underline transition-colors text-center"
                        title="Skip beat detection — open the editor with an empty chart"
                      >
                        or open empty editor →
                      </button>
                    )}
                  {inlineBmJobs[stem] && stem !== 'vocals' && (
                    <InlineBeatmapProgress
                      key={inlineBmJobs[stem]}
                      jobId={inlineBmJobs[stem]}
                      onDone={() => {
                        loadTracks()
                        // First try to drain the V2 per-preset queue for THIS
                        // stem. If that's empty, fall through to the multi-
                        // stem batch queue (V1 quick-generate path).
                        const firedPreset = dequeueV2(selectedTrack.id, stem)
                        if (firedPreset) return
                        setInlineBmJobs((prev) => {
                          const next = { ...prev }
                          delete next[stem]
                          return next
                        })
                        setQueueSongIni((prev) => { const n = { ...prev }; delete n[stem]; return n })
                        lock.release()
                        triggerNextBatchStem()
                      }}
                      onCancelled={() => {
                        setInlineBmJobs((prev) => {
                          const next = { ...prev }
                          delete next[stem]
                          return next
                        })
                        setBeatmapQueue((prev) => { const n = { ...prev }; delete n[stem]; return n })
                        setQueueSongIni((prev) => { const n = { ...prev }; delete n[stem]; return n })
                        // Cancel aborts the multi-stem batch — user asked
                        // the active task to stop, treat as "stop all".
                        setPendingStems([])
                        setBatchTotal(null)
                        lock.release()
                      }}
                      onError={() => {
                        // A single preset failing must NOT discard the rest of
                        // this stem's queued presets. Surface the failure, then
                        // advance to the next queued preset exactly like onDone.
                        setBatchError(`A ${stem} generation failed — continuing with the remaining queued presets.`)
                        const firedPreset = dequeueV2(selectedTrack.id, stem)
                        if (firedPreset) return
                        // Nothing left for this stem — clean up and fall through
                        // to the multi-stem batch queue.
                        setInlineBmJobs((prev) => {
                          const next = { ...prev }
                          delete next[stem]
                          return next
                        })
                        setQueueSongIni((prev) => { const n = { ...prev }; delete n[stem]; return n })
                        lock.release()
                        triggerNextBatchStem()
                      }}
                    />
                  )}
                  {inlineBmJobs[stem] && (beatmapQueue[stem]?.length ?? 0) > 0 && (
                    <div
                      className="text-[10px] text-gray-500 italic mt-1 truncate"
                      title="Generations queued behind the active run"
                    >
                      queued: {(beatmapQueue[stem] || []).map((q) => q.preset || 'Custom').join(' · ')}
                    </div>
                  )}
                  {/* Vocals uses VocalmapButtons → vocal_notes.json, not the
                      tracks.beatmaps array, so skip the legacy chart list here. */}
                  {stem !== 'vocals' && (selectedTrack.beatmaps || [])
                    .filter((bm) => bm.stem === stem)
                    .sort((a, b) => b.generated_at - a.generated_at)
                    .map((bm) => {
                      const liveName = (bm.song_name || '').trim()
                      const dateStr = formatDate(bm.generated_at)
                      const isActive = !!bm.active
                      const defaultName = `${selectedTrack.name} (${STEM_LABELS[stem] || stem})`
                      // Strip "(copy)" suffixes so cloned rows stay on the date
                      // until the user gives them a real custom name.
                      const baseName = liveName.replace(/(\s*\(copy\))+$/i, '')
                      const isCustom = !!liveName && baseName !== defaultName
                      const model = (bm.model || 'madmom').toLowerCase()
                      const modelVer = (bm.model_version || '').trim()
                      const modelLabel = modelVer ? `${model.toUpperCase()} ${modelVer}` : model.toUpperCase()
                      const modelBadgeCls = BEATMAP_MODEL_BADGE[model] || BEATMAP_MODEL_BADGE.manual
                      // model_version uses '<madmom-pkg>+v2' for V2 records,
                      // strip the suffix when comparing against the installed
                      // package so the (older) flag doesn't fire on every V2
                      // beatmap.
                      const baseModelVer = modelVer.endsWith('+v2') ? modelVer.slice(0, -3) : modelVer
                      const isOlder = model === 'madmom' && !!baseModelVer && !!installedMadmom && baseModelVer !== installedMadmom
                      const presetName = (bm.preset || '').trim()
                      const isIncluded = (bm as { included?: boolean }).included ?? true
                      const toggleIncluded = async () => {
                        try {
                          const r = await fetch(`/api/tracks/${selectedTrack.id}/beatmaps/${bm.id}/included`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ included: !isIncluded }),
                          })
                          if (!r.ok) throw new Error(`HTTP ${r.status}`)
                          await loadTracks()
                        } catch (e) {
                          setBatchError((e as Error).message)
                        }
                      }
                      const activate = async () => {
                        if (isActive) return
                        try {
                          const r = await fetch(`/api/tracks/${selectedTrack.id}/beatmaps/${bm.id}/activate`, { method: 'POST' })
                          if (!r.ok) throw new Error(`HTTP ${r.status}`)
                          await loadTracks()
                        } catch (e) {
                          setBatchError((e as Error).message)
                        }
                      }
                      return (
                      <div
                        key={bm.id}
                        className={`mt-1 flex flex-wrap items-center gap-1.5 rounded border px-1.5 py-1 ${
                          isActive ? 'border-jam-600/60 bg-jam-700/20' : 'border-gray-800 bg-gray-900/40'
                        } ${!isIncluded ? 'opacity-50' : ''}`}
                        title={liveName ? `${liveName} · ${dateStr}` : undefined}
                      >
                        <input
                          type="checkbox"
                          checked={isIncluded}
                          onChange={toggleIncluded}
                          className="shrink-0 h-3.5 w-3.5 accent-jam-500 cursor-pointer"
                          title={isIncluded ? 'Included in published chart (click to exclude)' : 'Excluded from publish (click to include)'}
                        />
                        <button
                          onClick={activate}
                          disabled={isActive}
                          className={`shrink-0 text-[10px] px-1 py-0.5 rounded border ${
                            isActive
                              ? 'bg-jam-600/40 text-jam-100 border-jam-500/60 cursor-default'
                              : 'bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 border-gray-700'
                          }`}
                          title={isActive ? 'Primary (unnumbered) chart section' : 'Make this the primary chart section'}
                        >
                          {isActive ? '★ primary' : 'set primary'}
                        </button>
                        <span className={`shrink-0 inline-block px-1 py-0.5 rounded border text-[9px] font-semibold uppercase ${modelBadgeCls}`}>
                          {modelLabel}
                        </span>
                        {presetName && (
                          <span
                            className="shrink-0 inline-block px-1 py-0.5 rounded border text-[9px] font-semibold uppercase bg-indigo-700/40 text-indigo-200 border-indigo-700/60"
                            title={`Generation preset: ${presetName}`}
                          >
                            {presetName}
                          </span>
                        )}
                        <button
                          onClick={() => setStatsBeatmap(bm)}
                          className="flex-1 min-w-0 text-left text-[10px] text-gray-400 hover:text-gray-200 truncate transition-colors"
                          title={liveName ? `${liveName} · ${dateStr}` : 'View beatmap details'}
                        >
                          {dateStr}
                          {isCustom && <span className="ml-1 text-gray-200">· {liveName}</span>}
                          {isOlder && (
                            <span className="ml-1 text-amber-400" title={`Re-generating would use madmom ${installedMadmom}`}>
                              (older)
                            </span>
                          )}
                        </button>
                        <button
                          onClick={() => navigate(`/edit/${selectedTrack.id}/${bm.id}`)}
                          className="shrink-0 px-2 py-0.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-gray-600 rounded text-[10px] text-gray-300 hover:text-gray-100 transition-colors"
                          title="Edit beatmap"
                        >
                          Edit
                        </button>
                        {me && (
                          <FeedbackButton
                            trackId={selectedTrack.id}
                            beatmapId={bm.id}
                            currentUsername={me.username}
                            isAdmin={me.role === 'admin'}
                          />
                        )}
                        {(selectedTrack.beatmaps || []).filter((b) => b.stem === bm.stem).length > 1 && (
                          <button
                            className="shrink-0 rounded border border-slate-600 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-slate-700"
                            onClick={() => {
                              setCloneDiffMsg('')
                              setCloneDiffFor({
                                id: bm.id,
                                stem: bm.stem,
                                label: presetName ? presetName : modelLabel,
                              })
                            }}
                          >
                            Clone diff
                          </button>
                        )}
                        <button
                          onClick={async () => {
                            const msg = isActive
                              ? `Delete the ACTIVE ${STEM_LABELS[stem] || stem} beatmap? No beatmap will be active for this stem until you pick another or generate a fresh one.`
                              : 'Delete this beatmap? The active version is unaffected.'
                            if (!window.confirm(msg)) return
                            try {
                              const r = await fetch(`/api/tracks/${selectedTrack.id}/beatmaps/${bm.id}`, { method: 'DELETE' })
                              if (!r.ok) {
                                const e = await r.json().catch(() => ({}))
                                throw new Error(e.detail || `HTTP ${r.status}`)
                              }
                              await loadTracks()
                            } catch (e) {
                              setBatchError((e as Error).message)
                            }
                          }}
                          className="shrink-0 px-1 py-0.5 bg-red-900/30 hover:bg-red-800/50 text-red-300 rounded text-[10px]"
                          title={isActive ? 'Delete the active beatmap' : 'Delete this beatmap'}
                          aria-label="Delete beatmap"
                        >
                          ×
                        </button>
                      </div>
                      )
                    })}
                  </div>
                </div>
              ))}
          </div>

          {/* Batch generate row */}
          <div className="mt-3 flex flex-col gap-2">
            {batchTotal !== null && (() => {
              const total = batchTotal
              const queued = pendingStems.length
              const activeStem = Object.keys(inlineBmJobs)[0] || null
              const done = total - queued - (activeStem ? 1 : 0)
              const pct = total > 0 ? Math.round((done / total) * 100) : 0
              return (
                <div className="bg-gray-900/60 border border-gray-800 rounded-md p-2 space-y-1.5">
                  <div className="flex items-center justify-between gap-2 text-xs text-gray-400">
                    <span>
                      Batch: <span className="text-gray-200 font-medium">{done} of {total}</span> stems done
                      {activeStem && (
                        <>
                          {' '}· running{' '}
                          <span className={STEM_COLORS[activeStem] || 'text-gray-200'}>
                            {STEM_LABELS[activeStem] || activeStem}
                          </span>
                        </>
                      )}
                    </span>
                    <span className="text-gray-500 text-[10px] tabular-nums">{pct}%</span>
                  </div>
                  <div className="w-full bg-gray-800 rounded-full h-1 overflow-hidden">
                    <div className="bg-jam-500 h-full transition-all duration-500" style={{ width: `${Math.max(pct, 2)}%` }} />
                  </div>
                  {queued > 0 && (
                    <div className="text-[10px] text-gray-500 truncate" title={`queued stems: ${pendingStems.join(', ')}`}>
                      next: {pendingStems.map((s) => STEM_LABELS[s] || s).join(' · ')}
                    </div>
                  )}
                </div>
              )
            })()}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs text-gray-500">
                {batchTotal !== null
                  ? null
                  : selectedStems.size > 0
                    ? `${selectedStems.size} stem${selectedStems.size === 1 ? '' : 's'} selected`
                    : 'Tick stems above to queue multiple beatmap generations.'}
              </div>
              <div className="flex items-center gap-2">
                {batchError && <span className="text-xs text-red-400">{batchError}</span>}
                <button
                  onClick={generateSelected}
                  disabled={selectedStems.size === 0 || batchTotal !== null || !!lock.owner}
                  title={
                    batchTotal !== null
                      ? 'Multi-stem batch already running'
                      : lock.owner
                        ? 'Another task is running'
                        : undefined
                  }
                  className="px-3 py-1.5 bg-jam-600 hover:bg-jam-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-md text-xs font-medium transition-colors"
                >
                  {batchTotal !== null
                    ? 'Batch in progress…'
                    : `Generate beatmap for ${selectedStems.size || 'selected'} stem${selectedStems.size === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
          </div>

          <div className="mt-6 bg-gray-950 border border-gray-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-yellow-400 text-xs font-mono">song.ini</span>
                <span className="text-gray-600 text-xs">[song]</span>
              </div>
              <div className="flex items-center gap-3">
                {iniSaveState === 'saved' && (
                  <span className="text-xs text-emerald-400">Saved</span>
                )}
                {iniSaveState === 'error' && (
                  <span className="text-xs text-red-400">{iniError}</span>
                )}
                <button
                  onClick={saveTrackSongIni}
                  disabled={iniSaveState === 'saving'}
                  className="px-3 py-1.5 bg-jam-600 hover:bg-jam-500 disabled:opacity-40 text-white rounded-md text-xs font-medium"
                >
                  {iniSaveState === 'saving' ? 'Saving...' : 'Save metadata'}
                </button>
              </div>
            </div>

            {/* Album art */}
            <div className="flex gap-4 items-start">
              <button
                type="button"
                onClick={() => albumInputRef.current?.click()}
                className="group relative w-24 h-24 shrink-0 rounded-lg overflow-hidden border border-gray-700 hover:border-jam-500 bg-gray-800"
                title="Click to replace album.png"
              >
                {albumPreview ? (
                  <>
                    <img src={albumPreview} alt="album" className="w-full h-full object-cover" />
                    <span className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-xs text-gray-200">
                      Change
                    </span>
                  </>
                ) : (
                  <span className="w-full h-full flex items-center justify-center text-xs text-gray-500 px-2 text-center">
                    Click to add<br />album.png
                  </span>
                )}
              </button>
              <input
                ref={albumInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => handleAlbumPick(e.target.files?.[0] ?? null)}
              />
              <div className="text-xs text-gray-500 mt-1 flex-1">
                <p>
                  <span className="text-gray-400 font-mono">album.png</span> — included in the published game folder.
                </p>
                <p className="text-gray-600 mt-1">Any image is resized to 512×512 PNG on save.</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      const artist = (songIni.artist || '').trim()
                      const title = (songIni.name || '').trim()
                      const album = (songIni.album || '').trim()
                      if (!artist && !title && !album) {
                        setCoverFetchState('error')
                        return
                      }
                      setCoverFetchState('loading')
                      try {
                        const fd = new FormData()
                        fd.append('artist', artist)
                        fd.append('title', title)
                        fd.append('album', album)
                        const res = await fetch('/api/beatmap/cover-art-search', { method: 'POST', body: fd })
                        if (res.status === 204) {
                          setCoverFetchState('none')
                          return
                        }
                        if (!res.ok) throw new Error(`${res.status}`)
                        const blob = await res.blob()
                        if (blob.size === 0) {
                          setCoverFetchState('none')
                          return
                        }
                        const file = new File([blob], 'album.png', { type: 'image/png' })
                        handleAlbumPick(file)
                        setCoverFetchState('idle')
                      } catch {
                        setCoverFetchState('error')
                      }
                    }}
                    disabled={coverFetchState === 'loading' || (!songIni.name && !songIni.artist && !songIni.album)}
                    className="px-2.5 py-1 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 border border-gray-700 hover:border-gray-600 text-gray-200 rounded-md text-xs font-medium transition-colors"
                    title="Pull cover art from iTunes / MusicBrainz using the name + artist below"
                  >
                    {coverFetchState === 'loading' ? 'Searching…' : 'Auto-fetch from name + artist'}
                  </button>
                  {coverFetchState === 'none' && (
                    <span className="text-amber-400">No cover found for those tags</span>
                  )}
                  {coverFetchState === 'error' && (
                    <span className="text-red-400">Search failed — fill in name + artist first</span>
                  )}
                </div>
              </div>
            </div>

            {/* Primary fields */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {([
                ['name', 'name *'],
                ['artist', 'artist *'],
              ] as const).map(([key, label]) => (
                <label key={key} className="block">
                  <span className="text-xs text-gray-400">{label}</span>
                  <input
                    type="text"
                    value={songIni[key] ?? ''}
                    onChange={(e) => updateIni(key, e.target.value)}
                    className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-jam-500"
                  />
                </label>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {(['album', 'genre', 'year'] as const).map((key) => (
                <label key={key} className="block">
                  <span className="text-xs text-gray-400">{key}</span>
                  <input
                    type="text"
                    value={songIni[key] ?? ''}
                    onChange={(e) => updateIni(key, e.target.value)}
                    className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-jam-500"
                  />
                </label>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(['charter', 'loading_phrase'] as const).map((key) => (
                <label key={key} className="block">
                  <span className="text-xs text-gray-400">{key}</span>
                  <input
                    type="text"
                    value={songIni[key] ?? ''}
                    onChange={(e) => updateIni(key, e.target.value)}
                    className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-jam-500"
                  />
                </label>
              ))}
            </div>

            {/* Timing */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {([
                ['delay', 'delay (ms)'],
                ['song_length', 'song_length (ms)'],
                ['preview_start_time', 'preview_start_time (ms)'],
              ] as const).map(([key, label]) => (
                <label key={key} className="block">
                  <span className="text-xs text-gray-400">{label}</span>
                  <input
                    type="number"
                    value={songIni[key] ?? ''}
                    onChange={(e) => updateIni(key, e.target.value)}
                    className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-jam-500"
                  />
                </label>
              ))}
            </div>

            {/* Difficulties */}
            <div>
              <span className="text-xs text-gray-500 block mb-2">Difficulties</span>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                {(['diff_band', 'diff_guitar', 'diff_drums', 'diff_bass', 'diff_rhythm', 'diff_keys'] as const).map(
                  (key) => (
                    <label key={key} className="block">
                      <span className="text-xs text-gray-600">{key.replace('diff_', '')}</span>
                      <input
                        type="number"
                        min="-1"
                        max="6"
                        value={songIni[key] ?? ''}
                        onChange={(e) => updateIni(key, e.target.value)}
                        className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 text-center focus:outline-none focus:border-jam-500"
                      />
                    </label>
                  ),
                )}
              </div>
              <span className="text-xs text-gray-700 mt-1 block">-1 = uncharted, 0–6 = difficulty tier</span>
            </div>
          </div>

          <TutorialSamplesPanel track={selectedTrack} />
          <InlinePublish track={selectedTrack} />
        </div>

        {beatmapPanel && (
          <BeatmapPanel
            track={beatmapPanel.track}
            stem={beatmapPanel.stem}
            onClose={() => setBeatmapPanel(null)}
            onBatchGenerate={(queue, values) => {
              const { track, stem } = beatmapPanel
              startV2Batch(track.id, stem, queue, values)
            }}
          />
        )}

        {statsBeatmap && selectedTrack && (
          <BeatmapStatsModal
            trackId={selectedTrack.id}
            beatmap={statsBeatmap}
            onClose={() => setStatsBeatmap(null)}
            onDeleted={() => {
              setStatsBeatmap(null)
              loadTracks()
            }}
            onRenamed={(updated) => {
              setStatsBeatmap((prev) => (prev ? { ...prev, song_name: updated.song_name } : prev))
              loadTracks()
            }}
            onCloned={(cloned) => {
              setStatsBeatmap(null)
              navigate(`/edit/${selectedTrack.id}/${cloned.id}`)
            }}
          />
        )}

        {cloneDiffMsg && (
          <div className="mt-2 flex items-center justify-between rounded bg-green-900/40 px-3 py-1.5 text-sm text-green-300">
            <span>{cloneDiffMsg}</span>
            <button className="text-green-400 hover:text-green-200" onClick={() => setCloneDiffMsg('')}>×</button>
          </div>
        )}

        {cloneDiffFor && selectedTrack && (
          <CloneDifficultyModal
            trackId={selectedTrack.id}
            source={cloneDiffFor}
            targets={(selectedTrack.beatmaps || [])
              .filter((b) => b.stem === cloneDiffFor!.stem && b.id !== cloneDiffFor!.id)
              .map((b) => {
                const bPreset = (b.preset || '').trim()
                const bModel = (b.model || 'madmom').toLowerCase()
                const bModelVer = (b.model_version || '').trim()
                const bModelLabel = bModelVer ? `${bModel.toUpperCase()} ${bModelVer}` : bModel.toUpperCase()
                return { id: b.id, stem: b.stem, label: bPreset ? bPreset : bModelLabel }
              })}
            onClose={() => setCloneDiffFor(null)}
            onDone={(msg) => { setCloneDiffMsg(msg); loadTracks() }}
          />
        )}

        {confirmDelete && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center px-4">
            <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-6 space-y-4">
              <h3 className="text-lg font-semibold text-gray-100">Delete this track?</h3>
              <p className="text-sm text-gray-400">
                <span className="text-gray-200 font-medium">{confirmDelete.name}</span> and all of its
                stems, song.ini, and album art will be permanently removed. This cannot be undone.
              </p>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setConfirmDelete(null)}
                  disabled={deleting}
                  className="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-200 rounded-lg text-sm font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={performConfirmedDelete}
                  disabled={deleting}
                  className="px-4 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  {deleting ? 'Deleting...' : 'Delete track'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Studio Library</h1>
          <p className="text-gray-500 mt-1">
            Tracks in progress and finished maps. Click any track to edit metadata, generate beatmaps, or publish.
            {' '}
            <Link to="/create" className="text-jam-300 hover:text-jam-200">+ Create a new track →</Link>
          </p>
        </div>
        {tracks.length > 0 && (
          <div className="flex items-center gap-3 shrink-0">
            <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                className="w-4 h-4 accent-jam-500 cursor-pointer"
                checked={tracks.length > 0 && tracks.every((t) => selectedForCompare.has(t.id))}
                onChange={(e) =>
                  setSelectedForCompare(e.target.checked ? new Set(tracks.map((t) => t.id)) : new Set())
                }
              />
              Select all
            </label>
            <button
              type="button"
              disabled={selectedForCompare.size === 0}
              onClick={() => {
                const ids = tracks.map((t) => t.id).filter((id) => selectedForCompare.has(id))
                navigate(`/compare?ids=${ids.join(',')}`, { state: { trackIds: ids } })
              }}
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-jam-600/20 text-jam-300 hover:bg-jam-600/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Compare{selectedForCompare.size > 0 ? ` (${selectedForCompare.size})` : ''}
            </button>
          </div>
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-gray-400">
          <div className="animate-spin h-5 w-5 border-2 border-jam-400 border-t-transparent rounded-full" />
          Loading tracks...
        </div>
      )}

      {!loading && tracks.length === 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
          <p className="text-gray-400">No tracks saved yet.</p>
          <p className="text-gray-600 text-sm mt-1">Separate a track on the Create page to save it here.</p>
        </div>
      )}

      <div className="space-y-2">
        {/* Running / failed jobs as ghost rows. Done jobs whose track has been
            promoted into the library are filtered out so we don't double-list. */}
        {jobs
          .filter((j) => {
            if (j.status === 'done') return false
            if (j.status === 'cancelled' && Date.now() / 1000 - j.updated_at > 60 * 60) return false
            if (j.track_id && tracks.some((t) => t.id === j.track_id)) return false
            return true
          })
          .map((j) => {
            const pill = JOB_STATUS_PILL[j.status]
            const isActive = j.status === 'running' || j.status === 'queued'
            return (
              <div
                key={j.id}
                onClick={() => navigate(`/?job=${j.id}`)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    navigate(`/?job=${j.id}`)
                  }
                }}
                className="cursor-pointer bg-gray-900 border border-gray-800 hover:border-gray-700 hover:bg-gray-900/70 rounded-xl px-4 py-3 transition-colors"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-12 h-12 shrink-0 rounded-md bg-gray-800 border border-gray-700 flex items-center justify-center">
                      {isActive ? (
                        <div className="animate-spin h-5 w-5 border-2 border-jam-400 border-t-transparent rounded-full" />
                      ) : j.status === 'failed' ? (
                        <span className="text-red-400 text-lg leading-none">!</span>
                      ) : (
                        <span className="text-gray-600 text-[10px] font-mono">job</span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium text-gray-100 truncate">
                          {j.title || j.id}
                        </h3>
                        <span
                          className={`shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-medium uppercase tracking-wider ${pill.cls}`}
                        >
                          {pill.label}
                        </span>
                      </div>
                      <p className="text-xs text-gray-600 mt-0.5 truncate">
                        {j.kind === 'manual_stems' ? 'Stems-only mux' : 'Stem separation'}
                        {' · '}
                        {formatDate(j.created_at)}
                        {isActive && j.last_message ? (
                          <>
                            <span className="text-gray-700"> · </span>
                            <span className="text-gray-500">{j.last_message}</span>
                          </>
                        ) : null}
                        {j.status === 'failed' && j.error ? (
                          <>
                            <span className="text-gray-700"> · </span>
                            <span className="text-red-400/80">{j.error}</span>
                          </>
                        ) : null}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {isActive && (
                      <span className="text-xs font-mono text-gray-500">{j.progress}%</span>
                    )}
                    {!isActive && (
                      <button
                        type="button"
                        onClick={async (e) => {
                          e.stopPropagation()
                          try {
                            await fetch(`/api/jobs/${j.id}`, { method: 'DELETE' })
                            loadJobs()
                          } catch {
                            // best-effort; the row will refresh on next poll
                          }
                        }}
                        className="px-2.5 py-1 bg-red-900/30 hover:bg-red-800/60 border border-red-800/50 hover:border-red-700 text-red-300 hover:text-red-200 rounded-md text-xs font-medium transition-colors"
                        aria-label={`Delete job ${j.title || j.id}`}
                      >
                        Delete
                      </button>
                    )}
                    <span className="text-gray-600">→</span>
                  </div>
                </div>
              </div>
            )
          })}
        {tracks.map((track) => {
          const stemCount = Object.entries(track.stems).filter(
            ([k]) => !NON_AUDIO_KEYS.has(k),
          ).length
          const hasArt = !!track.stems.album_png
          return (
            <div
              key={track.id}
              onClick={() => setSelectedId(track.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setSelectedId(track.id)
                }
              }}
              className="cursor-pointer bg-gray-900 border border-gray-800 hover:border-gray-700 hover:bg-gray-900/70 rounded-xl px-4 py-3 transition-colors"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <input
                    type="checkbox"
                    checked={selectedForCompare.has(track.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleCompare(track.id)}
                    aria-label={`Select ${track.name} for compare`}
                    className="w-4 h-4 shrink-0 accent-jam-500 cursor-pointer"
                  />
                  <div className="w-12 h-12 shrink-0 rounded-md overflow-hidden bg-gray-800 border border-gray-700 flex items-center justify-center">
                    {hasArt ? (
                      <img
                        src={`/api/tracks/${track.id}/stems/album_png`}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-gray-600 text-[10px] font-mono">no art</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-medium text-gray-100 truncate">
                      {track.artist ? `${track.artist} — ${track.name}` : track.name}
                    </h3>
                    <p className="text-xs text-gray-600 mt-0.5">
                      {formatDate(track.created_at)} &middot; {track.model} &middot;{' '}
                      {track.output_format.toUpperCase()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-gray-500">{stemCount} stems</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      setConfirmDelete(track)
                    }}
                    className="px-2.5 py-1 bg-red-900/30 hover:bg-red-800/60 border border-red-800/50 hover:border-red-700 text-red-300 hover:text-red-200 rounded-md text-xs font-medium transition-colors"
                    aria-label={`Delete ${track.name}`}
                  >
                    Delete
                  </button>
                  <span className="text-gray-600">→</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {confirmDelete && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center px-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-6 space-y-4">
            <h3 className="text-lg font-semibold text-gray-100">Delete this track?</h3>
            <p className="text-sm text-gray-400">
              <span className="text-gray-200 font-medium">{confirmDelete.name}</span> and all of its
              stems, song.ini, and album art will be permanently removed. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setConfirmDelete(null)}
                disabled={deleting}
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-200 rounded-lg text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={performConfirmedDelete}
                disabled={deleting}
                className="px-4 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white rounded-lg text-sm font-medium transition-colors"
              >
                {deleting ? 'Deleting...' : 'Delete track'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
