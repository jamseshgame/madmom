import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import VocalBeatmapTracker from './VocalBeatmapTracker'

export type VocalmapScope = { jobId: string } | { trackId: string }

interface VocalmapParams {
  model_size: 'full' | 'tiny'
  fmin: number
  fmax: number
  periodicity_threshold: number
  transpose_semitones: number
  min_note_duration_s: number
}

interface VocalmapVersion {
  file: string
  source: 'torchcrepe'
  fetched_at: string
  syllable_count: number
  pitch_model_version?: string | null
  pitch_model?: string | null
  syllabified_from?: string | null
  params?: VocalmapParams | null
  active: boolean
}

const DEFAULT_PARAMS: VocalmapParams = {
  model_size: 'full',
  fmin: 50,
  fmax: 1000,
  periodicity_threshold: 0.21,
  transpose_semitones: 0,
  min_note_duration_s: 0,
}

const PARAMS_STORAGE_KEY = 'vocalmap-params-v1'

function loadStoredParams(): VocalmapParams {
  try {
    const raw = localStorage.getItem(PARAMS_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_PARAMS }
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_PARAMS, ...parsed }
  } catch {
    return { ...DEFAULT_PARAMS }
  }
}

function summarizeParams(p: VocalmapParams | null | undefined): string {
  if (!p) return ''
  const bits: string[] = []
  if (p.model_size && p.model_size !== DEFAULT_PARAMS.model_size) bits.push(p.model_size)
  if (p.fmin !== DEFAULT_PARAMS.fmin || p.fmax !== DEFAULT_PARAMS.fmax) {
    bits.push(`${Math.round(p.fmin)}–${Math.round(p.fmax)} Hz`)
  }
  if (p.periodicity_threshold !== DEFAULT_PARAMS.periodicity_threshold) {
    bits.push(`thr ${p.periodicity_threshold.toFixed(2)}`)
  }
  if (p.transpose_semitones) bits.push(`${p.transpose_semitones > 0 ? '+' : ''}${p.transpose_semitones} st`)
  if (p.min_note_duration_s) bits.push(`min ${(p.min_note_duration_s * 1000).toFixed(0)} ms`)
  return bits.join(' · ')
}

interface VocalNotes {
  version?: number
  syllabified_from?: string
  pitch_model?: string
  pitch_model_version?: string | null
  frame_hop_s?: number
  fetched_at?: string
  syllables: Array<{
    time_s: number
    duration_s: number
    text: string
    midi_pitch: number
    voicing: string
    confidence: number
  }>
}

type Props = {
  scope: VocalmapScope
  meta: { artist: string; title: string; album?: string; duration_s?: number }
  hasActive: boolean
  // Parent passes a callback so it can refresh its own hasVocalNotes flag
  // (so the unrelated × delete button on the parent stays in sync).
  onActiveChange: () => void
}

const fmtFetchedAt = (iso: string): string => {
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    })
  } catch { return iso }
}

function scopeQuery(scope: VocalmapScope): string {
  return 'jobId' in scope ? `job_id=${scope.jobId}` : `track_id=${scope.trackId}`
}

const SOURCE_BADGE = 'bg-pink-700/40 text-pink-200 border-pink-700/60'

export default function VocalmapButtons({ scope, meta, hasActive, onActiveChange }: Props) {
  const navigate = useNavigate()
  const [versions, setVersions] = useState<VocalmapVersion[]>([])
  const [error, setError] = useState('')
  const [busyStart, setBusyStart] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const [previewVersion, setPreviewVersion] = useState<{ meta: VocalmapVersion; notes: VocalNotes } | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [installedTorchcrepe, setInstalledTorchcrepe] = useState<string | null>(null)
  const [params, setParams] = useState<VocalmapParams>(() => loadStoredParams())
  const [settingsOpen, setSettingsOpen] = useState(false)

  const refetchVersions = useCallback(async () => {
    try {
      const r = await fetch(`/api/vocals/versions?${scopeQuery(scope)}`)
      if (!r.ok) return
      setVersions(await r.json())
    } catch { /* non-critical */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(scope)])

  useEffect(() => { refetchVersions() // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(scope)])

  // Pull installed torchcrepe version for the button label / staleness badge.
  useEffect(() => {
    fetch('/api/versions')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.packages) return
        const t = d.packages.find((p: { name: string }) => p.name === 'torchcrepe')
        if (t?.installed) setInstalledTorchcrepe(t.installed)
      })
      .catch(() => {})
  }, [])

  const startGenerate = async (overrideParams?: VocalmapParams) => {
    setError('')
    setBusyStart(true)
    try {
      const used = overrideParams ?? params
      const body = {
        artist: meta.artist || '',
        title: meta.title || '',
        album: meta.album || undefined,
        duration_s: meta.duration_s,
        ...used,
      }
      const res = await fetch(`/api/vocals/generate?${scopeQuery(scope)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.detail || `HTTP ${res.status}`)
      }
      const { job_id } = await res.json()
      setJobId(job_id)
      // Persist for next time
      try { localStorage.setItem(PARAMS_STORAGE_KEY, JSON.stringify(used)) } catch { /* quota */ }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusyStart(false)
    }
  }

  const openPreview = async (v: VocalmapVersion) => {
    setLoadingPreview(true)
    try {
      const r = await fetch(`/api/vocals/versions/${encodeURIComponent(v.file)}?${scopeQuery(scope)}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data: VocalNotes = await r.json()
      setPreviewVersion({ meta: v, notes: data })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoadingPreview(false)
    }
  }

  const activate = async (v: VocalmapVersion) => {
    if (v.active) return
    try {
      const r = await fetch(`/api/vocals/versions/${encodeURIComponent(v.file)}/activate?${scopeQuery(scope)}`, { method: 'POST' })
      if (!r.ok) {
        const e = await r.json().catch(() => ({}))
        throw new Error(e.detail || `HTTP ${r.status}`)
      }
      await refetchVersions()
      onActiveChange()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // Build the Generate button label including the installed torchcrepe version.
  const genLabel = installedTorchcrepe
    ? `Generate Vocalmap with torchcrepe ${installedTorchcrepe}`
    : 'Generate Vocalmap'

  // Resolve the trackId for navigation (Edit vocalmap requires a trackId).
  const trackId = 'trackId' in scope ? scope.trackId : null

  return (
    <div className="space-y-1.5 w-full">
      <div className="flex items-stretch gap-1">
        <button
          onClick={() => startGenerate()}
          disabled={busyStart || !!jobId}
          className="flex-1 px-3 py-1.5 bg-green-700/60 hover:bg-green-600/70 disabled:opacity-50 text-green-100 rounded text-xs font-medium transition-colors"
          title="Detect pitch with torchcrepe and align lyrics into per-syllable notes"
        >
          {busyStart ? 'Starting…' : jobId ? 'Generating…' : genLabel}
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          disabled={busyStart || !!jobId}
          className="px-2 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-200 rounded text-xs font-medium transition-colors"
          title="Vocalmap settings (model size, pitch range, threshold, transpose)"
          aria-label="Vocalmap settings"
        >
          ⚙
        </button>
      </div>

      {jobId && (
        <VocalBeatmapTracker
          beatmapJobId={jobId}
          onDone={async () => {
            setJobId(null)
            await refetchVersions()
            onActiveChange()
          }}
          onCancelled={() => { setJobId(null) }}
        />
      )}

      {error && (
        <div className="text-[10px] text-red-300 truncate" title={error}>{error}</div>
      )}

      {versions.length > 0 && (
        <div className="space-y-1 pt-0.5">
          {versions.map((v) => (
            <div
              key={v.file}
              className={`flex items-center gap-1 text-[10px] rounded border px-1.5 py-1 ${
                v.active ? 'border-jam-600/60 bg-jam-700/20' : 'border-gray-800 bg-gray-900/40'
              }`}
              title={`${v.syllable_count} syllables${v.syllabified_from ? ` · lyrics from ${v.syllabified_from}` : ''}${v.pitch_model_version ? ` · torchcrepe ${v.pitch_model_version}` : ''}`}
            >
              <input
                type="radio"
                name={`active-vocalmap-${trackId ?? 'job'}`}
                checked={v.active}
                onChange={() => { if (!v.active) activate(v) }}
                className="shrink-0 h-3.5 w-3.5 accent-jam-500 cursor-pointer"
                title={v.active ? 'Active vocalmap' : 'Use this version'}
              />
              <span className={`shrink-0 inline-block px-1 py-0.5 rounded border text-[9px] font-semibold uppercase ${SOURCE_BADGE}`}>
                CREPE{v.pitch_model_version ? ` ${v.pitch_model_version}` : ''}
              </span>
              <span className="text-gray-400 truncate flex-1" title={summarizeParams(v.params) || undefined}>
                {fmtFetchedAt(v.fetched_at)}
                {v.params && summarizeParams(v.params) && (
                  <span className="ml-1 text-gray-500">· {summarizeParams(v.params)}</span>
                )}
                {v.pitch_model_version
                  && installedTorchcrepe
                  && v.pitch_model_version !== installedTorchcrepe && (
                  <span className="ml-1 text-amber-400" title={`Re-generating would use ${installedTorchcrepe}`}>
                    (older)
                  </span>
                )}
              </span>
              <button
                onClick={() => openPreview(v)}
                disabled={loadingPreview}
                className="shrink-0 px-1 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-[10px]"
              >
                preview
              </button>
            </div>
          ))}
        </div>
      )}

      {hasActive && trackId && (
        <button
          onClick={() => navigate(`/edit-vocals/${trackId}`)}
          className="px-3 py-1.5 bg-pink-700/40 hover:bg-pink-600/60 border border-pink-700/60 text-pink-200 rounded text-xs font-medium transition-colors w-full"
          title="Open the vocalmap editor for this track"
        >
          Edit vocalmap
        </button>
      )}

      {previewVersion && (
        <PreviewModal
          version={previewVersion.meta}
          notes={previewVersion.notes}
          onClose={() => setPreviewVersion(null)}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          initial={params}
          installed={installedTorchcrepe}
          onCancel={() => setSettingsOpen(false)}
          onSave={(p) => { setParams(p); setSettingsOpen(false) }}
          onSaveAndGenerate={(p) => {
            setParams(p)
            setSettingsOpen(false)
            startGenerate(p)
          }}
        />
      )}
    </div>
  )
}

function SettingsModal({
  initial, installed, onCancel, onSave, onSaveAndGenerate,
}: {
  initial: VocalmapParams
  installed: string | null
  onCancel: () => void
  onSave: (p: VocalmapParams) => void
  onSaveAndGenerate: (p: VocalmapParams) => void
}) {
  const [p, setP] = useState<VocalmapParams>(initial)

  const set = <K extends keyof VocalmapParams>(k: K, v: VocalmapParams[K]) =>
    setP((prev) => ({ ...prev, [k]: v }))

  const reset = () => setP({ ...DEFAULT_PARAMS })

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-100">Vocalmap settings</h3>
          <button onClick={onCancel} className="text-gray-500 hover:text-gray-300 text-xl leading-none">&times;</button>
        </div>
        <p className="text-[11px] text-gray-500">
          Pitch detector tunables. {installed ? <>Currently torchcrepe <span className="font-mono text-gray-300">{installed}</span>.</> : null}
        </p>

        <Field label="Model size" hint="full = best accuracy (slow). tiny = ~50× faster on CPU, less accurate.">
          <div className="grid grid-cols-2 gap-1">
            {(['full', 'tiny'] as const).map((m) => (
              <button
                key={m}
                onClick={() => set('model_size', m)}
                className={`px-2 py-1.5 rounded text-xs font-medium transition-colors ${
                  p.model_size === m ? 'bg-jam-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="fmin (Hz)" hint="Lower bound on pitch search">
            <input
              type="number" min={20} max={2000} step={1} value={p.fmin}
              onChange={(e) => set('fmin', parseFloat(e.target.value) || 0)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
            />
          </Field>
          <Field label="fmax (Hz)" hint="Upper bound on pitch search">
            <input
              type="number" min={50} max={4000} step={1} value={p.fmax}
              onChange={(e) => set('fmax', parseFloat(e.target.value) || 0)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
            />
          </Field>
        </div>

        <Field label="Periodicity threshold" hint="Below this, frames are unvoiced (NaN). Default 0.21.">
          <div className="flex items-center gap-2">
            <input
              type="range" min={0.05} max={0.6} step={0.01} value={p.periodicity_threshold}
              onChange={(e) => set('periodicity_threshold', parseFloat(e.target.value))}
              className="flex-1 accent-jam-500"
            />
            <span className="text-xs font-mono text-gray-400 w-10 text-right">{p.periodicity_threshold.toFixed(2)}</span>
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Transpose (semitones)" hint="Shift every detected note by N">
            <input
              type="number" min={-24} max={24} step={1} value={p.transpose_semitones}
              onChange={(e) => set('transpose_semitones', parseInt(e.target.value) || 0)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
            />
          </Field>
          <Field label="Min note (ms)" hint="Drop syllables shorter than this. 0 = keep all.">
            <input
              type="number" min={0} max={1000} step={10}
              value={Math.round(p.min_note_duration_s * 1000)}
              onChange={(e) => set('min_note_duration_s', (parseInt(e.target.value) || 0) / 1000)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
            />
          </Field>
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-gray-800">
          <button
            onClick={reset}
            className="text-[11px] text-gray-500 hover:text-gray-300"
          >
            Reset to defaults
          </button>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded"
            >
              Cancel
            </button>
            <button
              onClick={() => onSave(p)}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs rounded"
              title="Save these as the new defaults without generating"
            >
              Save
            </button>
            <button
              onClick={() => onSaveAndGenerate(p)}
              className="px-3 py-1.5 bg-jam-600 hover:bg-jam-500 text-white text-xs rounded font-medium"
            >
              Save &amp; generate
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <p className="text-[10px] text-gray-600 mt-0.5">{hint}</p>}
    </label>
  )
}

function PreviewModal({
  version, notes, onClose,
}: {
  version: VocalmapVersion; notes: VocalNotes; onClose: () => void
}) {
  const sylls = notes.syllables || []
  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg p-5 space-y-3 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-lg font-semibold text-gray-100">Vocalmap</h3>
          <span className="text-xs text-gray-500">
            <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-semibold uppercase mr-2 ${SOURCE_BADGE}`}>
              CREPE{version.pitch_model_version ? ` ${version.pitch_model_version}` : ''}
            </span>
            {fmtFetchedAt(version.fetched_at)} · {sylls.length} syllables
            {version.syllabified_from ? ` · ${version.syllabified_from}` : ''}
            {version.active ? ' · active' : ''}
          </span>
        </div>
        <div className="flex-1 overflow-auto font-mono text-xs space-y-0.5 bg-black/30 rounded p-3">
          {sylls.map((s, i) => (
            <div key={i} className="flex gap-2">
              <span className="text-gray-600 w-12 shrink-0 text-right">
                {Math.floor(s.time_s / 60)}:{(s.time_s % 60).toFixed(2).padStart(5, '0')}
              </span>
              <span className="text-gray-200 w-24 shrink-0 truncate">{s.text}</span>
              <span className="text-jam-300 w-12 shrink-0 text-right">midi {s.midi_pitch}</span>
              <span className="text-gray-500 truncate">{s.voicing}</span>
            </div>
          ))}
        </div>
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-md text-sm"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
