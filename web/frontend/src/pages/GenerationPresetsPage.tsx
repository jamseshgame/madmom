import { useEffect, useState } from 'react'
import ProposalReviewModal, { Proposal } from '../components/presets/ProposalReviewModal'

type Role = 'admin' | 'user'

interface Me {
  authenticated: boolean
  username?: string
  role?: Role
}

interface Preset {
  name: string
  description?: string
  builtin?: boolean
  stems?: string[]
  generation: Record<string, { engine: string; params: Record<string, unknown> }>
}

const STEM_ORDER = ['drums', 'guitar', 'bass', 'vocal'] as const

export default function GenerationPresetsPage() {
  const [me, setMe] = useState<Me | null>(null)
  const [presets, setPresets] = useState<Preset[]>([])
  const [loading, setLoading] = useState(true)
  const [proposingStem, setProposingStem] = useState<string | null>(null)
  const [proposing, setProposing] = useState(false)
  const [error, setError] = useState('')
  const [proposals, setProposals] = useState<Proposal[]>([])

  const loadPresets = () =>
    fetch('/api/generation-presets')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setPresets)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [meRes, presetsRes] = await Promise.all([
          fetch('/api/auth/me').then((r) => r.json()),
          fetch('/api/generation-presets').then((r) =>
            r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
          ),
        ])
        if (cancelled) return
        setMe(meRes)
        setPresets(presetsRes)
      } catch (e) {
        if (cancelled) return
        setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) return <div className="text-gray-500 text-sm">Loading…</div>
  if (me && !me.authenticated) return <div className="text-amber-300">Not authenticated.</div>
  if (me && me.role !== 'admin') {
    return (
      <div className="bg-red-900/30 border border-red-800 rounded p-4 text-sm text-red-200">
        This page is for admins only. You're signed in as <span className="font-mono">{me.username}</span> with role{' '}
        <span className="font-mono">{me.role}</span>.
      </div>
    )
  }

  const groups = (() => {
    const universal: Preset[] = []
    const byStem: Record<string, Preset[]> = {}
    for (const p of presets) {
      if (!p.stems || p.stems.length === 0) {
        universal.push(p)
        continue
      }
      for (const s of p.stems) (byStem[s] ??= []).push(p)
    }
    return { universal, byStem }
  })()

  const propose = async (stem: string) => {
    setProposingStem(stem)
    setProposing(true)
    setError('')
    setProposals([])
    try {
      const r = await fetch(`/api/generation-presets/propose-from-feedback?stem=${encodeURIComponent(stem)}&n=3`, {
        method: 'POST',
      })
      if (!r.ok) {
        setError(await r.text())
        return
      }
      const data = await r.json()
      setProposals(data.proposals)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setProposing(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Generation Presets</h1>
        <p className="text-sm text-gray-500 mt-1">
          Built-in and user-saved presets that drive the Generate Beatmap V2 pipeline. Use the per-stem button to ask
          Claude to read player feedback and propose new presets.
        </p>
      </div>

      {error && !proposingStem && (
        <div className="bg-red-900/30 border border-red-800 rounded p-3 text-sm text-red-200">{error}</div>
      )}

      {groups.universal.length > 0 && (
        <PresetGroup heading="Universal" stem={null} presets={groups.universal} onPropose={() => {}} proposing={false} />
      )}
      {STEM_ORDER.filter((s) => groups.byStem[s]?.length).map((stem) => (
        <PresetGroup
          key={stem}
          heading={stem[0].toUpperCase() + stem.slice(1)}
          stem={stem}
          presets={groups.byStem[stem] || []}
          onPropose={() => propose(stem)}
          proposing={proposing && proposingStem === stem}
        />
      ))}
      {STEM_ORDER.filter((s) => !groups.byStem[s]?.length).map((stem) => (
        <PresetGroup
          key={stem}
          heading={stem[0].toUpperCase() + stem.slice(1)}
          stem={stem}
          presets={[]}
          onPropose={() => propose(stem)}
          proposing={proposing && proposingStem === stem}
        />
      ))}

      {(proposing || proposals.length > 0 || (error && proposingStem)) && proposingStem && (
        <ProposalReviewModal
          stem={proposingStem}
          loading={proposing}
          proposals={proposals}
          error={error}
          onClose={() => {
            setProposingStem(null)
            setProposals([])
            setError('')
          }}
          onSaved={() => {
            void loadPresets()
          }}
        />
      )}
    </div>
  )
}

function PresetGroup({
  heading,
  stem,
  presets,
  onPropose,
  proposing,
}: {
  heading: string
  stem: string | null
  presets: Preset[]
  onPropose: () => void
  proposing: boolean
}) {
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold">{heading}</h2>
        {stem && (
          <button
            onClick={onPropose}
            disabled={proposing}
            className="bg-purple-700 hover:bg-purple-600 disabled:opacity-50 px-3 py-1 rounded text-sm"
          >
            {proposing ? 'Asking Claude…' : 'Propose new presets from feedback'}
          </button>
        )}
      </div>
      {presets.length === 0 ? (
        <div className="text-xs text-gray-600 italic">No stem-specific presets yet.</div>
      ) : (
        <ul className="space-y-2">
          {presets.map((p) => (
            <li key={p.name} className="bg-gray-900/40 border border-gray-800 rounded p-3">
              <div className="font-semibold">
                {p.name}{' '}
                {p.builtin && <span className="text-xs text-gray-500">(built-in)</span>}
              </div>
              {p.description && <div className="text-sm text-gray-400">{p.description}</div>}
              <div className="text-xs text-gray-500 mt-1">
                {Object.entries(p.generation).map(([stage, cfg]) => (
                  <span key={stage} className="mr-3">
                    {stage}: <code>{cfg.engine}</code>
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
