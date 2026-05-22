import { useEffect, useState } from 'react'

interface FeedbackNote {
  id: string
  created_at: string
  updated_at: string
  author: string
  rating: number
  tags: string[]
  text: string
}

interface FeedbackPanelProps {
  trackId: string
  beatmapId: string
  currentUsername: string
  isAdmin: boolean
  onCountChange?: (count: number) => void
}

let _cachedTags: Record<string, string[]> | null = null

async function fetchTags(): Promise<Record<string, string[]>> {
  if (_cachedTags) return _cachedTags
  const r = await fetch('/api/feedback/tags')
  if (!r.ok) throw new Error('tags fetch failed')
  _cachedTags = await r.json()
  return _cachedTags!
}

export default function FeedbackPanel({
  trackId, beatmapId, currentUsername, isAdmin, onCountChange,
}: FeedbackPanelProps) {
  const [notes, setNotes] = useState<FeedbackNote[]>([])
  const [tagsByCategory, setTagsByCategory] = useState<Record<string, string[]>>({})
  const [draftRating, setDraftRating] = useState(3)
  const [draftTags, setDraftTags] = useState<Set<string>>(new Set())
  const [draftText, setDraftText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState('')

  const url = `/api/feedback/tracks/${trackId}/beatmaps/${beatmapId}`

  const load = async () => {
    const r = await fetch(url)
    if (!r.ok) return
    const data: FeedbackNote[] = await r.json()
    setNotes(data)
    onCountChange?.(data.length)
  }

  useEffect(() => { void load() }, [trackId, beatmapId])
  useEffect(() => { void fetchTags().then(setTagsByCategory) }, [])

  const submit = async () => {
    setErr('')
    if (draftTags.size === 0 && !draftText.trim()) {
      setErr('Add at least one tag or some text.')
      return
    }
    setSubmitting(true)
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: draftRating, tags: [...draftTags], text: draftText }),
      })
      if (!r.ok) { setErr(await r.text()); return }
      setDraftRating(3); setDraftTags(new Set()); setDraftText('')
      await load()
    } finally { setSubmitting(false) }
  }

  const remove = async (id: string) => {
    if (!confirm('Delete this feedback note?')) return
    await fetch(`${url}/${id}`, { method: 'DELETE' })
    await load()
  }

  return (
    <div className="bg-gray-900/40 border border-gray-800 rounded p-3 text-sm">
      <h4 className="font-semibold mb-2">Feedback</h4>
      {notes.length === 0 && <div className="text-gray-500 italic">No feedback yet.</div>}
      <ul className="space-y-2 mb-3">
        {notes.map(n => (
          <li key={n.id} className="bg-gray-950/40 rounded p-2">
            <div className="flex items-center justify-between text-xs text-gray-400">
              <span>{n.author} · {new Date(n.created_at).toLocaleString()} · ★ {n.rating}</span>
              {(n.author === currentUsername || isAdmin) && (
                <button className="text-red-400 hover:text-red-300" onClick={() => remove(n.id)}>×</button>
              )}
            </div>
            {n.tags.length > 0 && (
              <div className="mt-1 flex gap-1 flex-wrap">
                {n.tags.map(t => <span key={t} className="bg-purple-800/30 border border-purple-700/40 px-2 py-0.5 rounded text-xs">{t}</span>)}
              </div>
            )}
            {n.text && <div className="mt-1 text-gray-200 whitespace-pre-wrap">{n.text}</div>}
          </li>
        ))}
      </ul>

      <div className="border-t border-gray-800 pt-2">
        <label className="block text-xs text-gray-400 mb-1">
          Rating: <span className="text-yellow-400">{'★'.repeat(draftRating)}{'☆'.repeat(5 - draftRating)}</span>
          <input type="range" min={1} max={5} value={draftRating}
                 onChange={e => setDraftRating(parseInt(e.target.value, 10))}
                 className="ml-2 align-middle" />
        </label>
        {Object.entries(tagsByCategory).map(([cat, ts]) => (
          <div key={cat} className="mb-1">
            <div className="text-xs text-gray-500">{cat}</div>
            <div className="flex flex-wrap gap-1">
              {ts.map(t => (
                <button key={t} type="button"
                        onClick={() => {
                          const next = new Set(draftTags)
                          if (next.has(t)) next.delete(t); else next.add(t)
                          setDraftTags(next)
                        }}
                        className={`px-2 py-0.5 rounded text-xs border ${draftTags.has(t)
                          ? 'bg-purple-800/40 border-purple-600 text-purple-100'
                          : 'bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200'}`}>
                  {t}
                </button>
              ))}
            </div>
          </div>
        ))}
        <textarea value={draftText} onChange={e => setDraftText(e.target.value)}
                  placeholder="Optional notes — what felt off, what to try next…"
                  className="w-full mt-1 bg-gray-950 border border-gray-800 rounded p-2 text-sm" rows={2} />
        {err && <div className="text-red-400 text-xs mt-1">{err}</div>}
        <button disabled={submitting} onClick={submit}
                className="mt-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white px-3 py-1 rounded text-sm">
          {submitting ? 'Submitting…' : 'Add feedback'}
        </button>
      </div>
    </div>
  )
}
