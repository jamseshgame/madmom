import { useEffect, useState } from 'react'

// Detects that a new frontend build has been deployed while this tab was
// open and nudges the user to reload. Without this, long-lived SPA tabs
// keep running stale code until the user happens to do a full refresh —
// deployed fixes silently never reach them.
//
// Mechanism: Vite emits a content-hashed bundle name (/assets/index-XXXX.js)
// referenced from index.html. We re-fetch index.html (no-store) on an
// interval + on tab focus and compare the bundle name it references against
// the one this tab is actually running. Mismatch → new build is live.
// In `npm run dev` index.html references /src/main.tsx, no hashed bundle on
// either side matches, and the nudge stays silent.

const BUNDLE_RE = /\/assets\/index-[\w-]+\.js/
const POLL_MS = 90_000

function currentBundle(): string | null {
  const script = document.querySelector('script[src*="/assets/index-"]')
  const src = script?.getAttribute('src') || ''
  return src.match(BUNDLE_RE)?.[0] ?? null
}

export default function UpdateNudge() {
  const [newBundle, setNewBundle] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)

  useEffect(() => {
    const running = currentBundle()
    if (!running) return // dev server or unexpected markup — stay silent

    let stopped = false
    const check = async () => {
      try {
        const res = await fetch('/', { cache: 'no-store' })
        if (!res.ok) return
        const html = await res.text()
        const served = html.match(BUNDLE_RE)?.[0]
        if (!stopped && served && served !== running) setNewBundle(served)
      } catch {
        // offline / mid-deploy — try again next tick
      }
    }

    const interval = setInterval(check, POLL_MS)
    const onFocus = () => {
      if (document.visibilityState === 'visible') check()
    }
    document.addEventListener('visibilitychange', onFocus)
    window.addEventListener('focus', onFocus)
    return () => {
      stopped = true
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onFocus)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  if (!newBundle || newBundle === dismissed) return null

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex items-center gap-3 bg-gray-900 border border-jam-600/60 rounded-xl shadow-2xl shadow-black/50 px-4 py-3">
      <span className="text-sm text-gray-200">
        Studio was updated — reload to get the latest version.
      </span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="px-3 py-1.5 bg-jam-600 hover:bg-jam-500 text-white rounded-lg text-sm font-medium transition-colors"
      >
        Reload
      </button>
      <button
        type="button"
        onClick={() => setDismissed(newBundle)}
        title="Dismiss"
        className="px-2 py-1.5 text-gray-500 hover:text-gray-300 text-sm transition-colors"
      >
        ✕
      </button>
    </div>
  )
}
