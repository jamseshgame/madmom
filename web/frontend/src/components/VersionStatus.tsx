import { useEffect, useState } from 'react'

type PackageStatus = {
  installed: string | null
  latest: string | null
  up_to_date: boolean | null
}

type Versions = {
  madmom: PackageStatus
  demucs: PackageStatus
}

function useVersions() {
  const [data, setData] = useState<Versions | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/versions')
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((json) => !cancelled && setData(json))
      .catch(() => !cancelled && setError(true))
    return () => {
      cancelled = true
    }
  }, [])

  return { data, error }
}

function outdatedList(data: Versions): Array<{ name: string; installed: string; latest: string }> {
  const out: Array<{ name: string; installed: string; latest: string }> = []
  for (const name of ['madmom', 'demucs'] as const) {
    const p = data[name]
    if (p.up_to_date === false && p.installed && p.latest) {
      out.push({ name, installed: p.installed, latest: p.latest })
    }
  }
  return out
}

export function VersionBanner() {
  const { data } = useVersions()
  const [dismissed, setDismissed] = useState(false)
  if (!data || dismissed) return null
  const outdated = outdatedList(data)
  if (outdated.length === 0) return null
  return (
    <div className="bg-amber-900/30 border border-amber-800 rounded-lg p-4 flex items-start gap-3">
      <span className="text-amber-400 text-lg leading-none mt-0.5">⚠</span>
      <div className="flex-1 text-sm">
        <p className="font-medium text-amber-200">Update available</p>
        <ul className="mt-1 space-y-0.5 text-amber-300/80">
          {outdated.map((p) => (
            <li key={p.name}>
              <span className="font-mono">{p.name}</span> {p.installed} → {p.latest}
            </li>
          ))}
        </ul>
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="text-amber-400/60 hover:text-amber-200 text-sm"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  )
}

export function VersionFooter() {
  const { data, error } = useVersions()
  if (error || !data) return null
  const outdated = outdatedList(data)
  const allOk = outdated.length === 0
  const parts: string[] = []
  if (data.madmom.installed) parts.push(`madmom ${data.madmom.installed}`)
  if (data.demucs.installed) parts.push(`demucs ${data.demucs.installed}`)
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`inline-block w-1.5 h-1.5 rounded-full ${allOk ? 'bg-emerald-500' : 'bg-amber-500'}`}
        aria-hidden
      />
      <span>{parts.join(' · ')}</span>
      <span className={allOk ? 'text-emerald-500' : 'text-amber-500'}>
        {allOk ? 'up to date' : 'update available'}
      </span>
    </span>
  )
}
