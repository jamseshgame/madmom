import { useState } from 'react'

export interface Proposal {
  name: string
  description: string
  generation: Record<string, { engine: string; params: Record<string, unknown> }>
  stems?: string[]
  rationale: string
}

interface Props {
  stem: string
  loading: boolean
  proposals: Proposal[]
  error: string
  onClose: () => void
  onSaved: () => void
}

export default function ProposalReviewModal({ stem, loading, proposals, error, onClose, onSaved }: Props) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-lg max-w-6xl w-full max-h-[90vh] overflow-auto p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xl font-semibold">Proposals for {stem}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-200" aria-label="Close">
            ×
          </button>
        </div>
        {loading && (
          <div className="py-8 text-center text-gray-400">
            Asking Claude to read your feedback and propose new presets…
          </div>
        )}
        {error && (
          <div className="bg-red-900/30 border border-red-800 text-red-200 p-2 rounded mb-3 text-sm whitespace-pre-wrap">
            {error}
          </div>
        )}
        {!loading && !error && proposals.length === 0 && (
          <div className="py-4 text-center text-gray-500 text-sm">No proposals returned.</div>
        )}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
          {proposals.map((p, i) => (
            <ProposalCard key={i} proposal={p} onSaved={onSaved} />
          ))}
        </div>
      </div>
    </div>
  )
}

function ProposalCard({ proposal, onSaved }: { proposal: Proposal; onSaved: () => void }) {
  const [name, setName] = useState(proposal.name)
  const [description, setDescription] = useState(proposal.description)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    setError('')
    setSaving(true)
    try {
      const body = {
        name,
        description,
        generation: proposal.generation,
        stems: proposal.stems,
      }
      const r = await fetch('/api/generation-presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) {
        setError(await r.text())
        return
      }
      setSaved(true)
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className={`border rounded p-3 ${
        saved ? 'border-green-700 bg-green-900/10' : 'border-gray-700 bg-gray-950/40'
      }`}
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={saved}
        className="w-full bg-gray-900 border border-gray-700 rounded p-1 mb-2 font-semibold disabled:opacity-70"
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        disabled={saved}
        rows={2}
        className="w-full bg-gray-900 border border-gray-700 rounded p-1 mb-2 text-sm disabled:opacity-70"
      />
      <div className="text-xs text-gray-400 mb-2">
        {Object.entries(proposal.generation).map(([stage, cfg]) => (
          <div key={stage}>
            <strong>{stage}:</strong> <code>{cfg.engine}</code>{' '}
            {Object.keys(cfg.params).length > 0 && (
              <span className="text-gray-500">{JSON.stringify(cfg.params)}</span>
            )}
          </div>
        ))}
      </div>
      <div className="text-xs text-gray-500 italic mb-2 whitespace-pre-wrap">{proposal.rationale}</div>
      {proposal.stems && proposal.stems.length > 0 && (
        <div className="text-xs text-gray-400 mb-2">Stems: {proposal.stems.join(', ')}</div>
      )}
      {error && <div className="text-xs text-red-400 mb-2 whitespace-pre-wrap">{error}</div>}
      <button
        onClick={save}
        disabled={saved || saving}
        className="w-full bg-purple-700 hover:bg-purple-600 disabled:opacity-50 py-1 rounded text-sm"
      >
        {saved ? 'Saved' : saving ? 'Saving…' : 'Save preset'}
      </button>
    </div>
  )
}
