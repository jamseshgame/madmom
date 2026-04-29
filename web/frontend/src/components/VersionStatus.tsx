import { useEffect, useState } from 'react'

type PackageStatus = {
  name: string
  installed: string | null
  latest: string | null
  up_to_date: boolean | null
  used_for: string
  license: string
  optional: boolean
}

type Versions = {
  packages: PackageStatus[]
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
  return data.packages
    .filter((p) => p.up_to_date === false && p.installed && p.latest && !p.optional)
    .map((p) => ({ name: p.name, installed: p.installed!, latest: p.latest! }))
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
        <p className="font-medium text-amber-200">Updates available</p>
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

export function VersionsTable() {
  const { data, error } = useVersions()
  if (error) {
    return (
      <div className="bg-red-900/20 border border-red-800/60 rounded-lg p-3 text-sm text-red-300">
        Couldn't reach <span className="font-mono">/api/versions</span>.
      </div>
    )
  }
  if (!data) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <div className="animate-spin h-4 w-4 border-2 border-jam-400 border-t-transparent rounded-full" />
        Reading installed versions…
      </div>
    )
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-800">
        <h2 className="text-lg font-semibold text-gray-100">Open-source dependencies</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Live version check against PyPI. Anything red is behind the latest
          release.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 uppercase tracking-wider">
            <tr className="border-b border-gray-800">
              <th className="text-left px-4 py-2 font-medium">Package</th>
              <th className="text-left px-4 py-2 font-medium">Installed</th>
              <th className="text-left px-4 py-2 font-medium">Latest (PyPI)</th>
              <th className="text-left px-4 py-2 font-medium">Status</th>
              <th className="text-left px-4 py-2 font-medium">License</th>
              <th className="text-left px-4 py-2 font-medium">Used for</th>
            </tr>
          </thead>
          <tbody className="font-mono text-gray-300">
            {data.packages.map((p) => {
              const status: { label: string; cls: string } =
                p.installed == null
                  ? { label: 'not installed', cls: 'bg-gray-800 text-gray-500 border-gray-700' }
                  : p.latest == null
                    ? { label: 'pypi unreachable', cls: 'bg-gray-800 text-gray-500 border-gray-700' }
                    : p.up_to_date
                      ? { label: 'up to date', cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-800/60' }
                      : { label: 'update available', cls: 'bg-amber-900/40 text-amber-300 border-amber-800/60' }
              return (
                <tr key={p.name} className="border-b border-gray-800/60 last:border-b-0">
                  <td className="px-4 py-2">
                    <a
                      href={`https://pypi.org/project/${p.name}/`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-gray-100 hover:text-jam-300 underline-offset-2 hover:underline"
                    >
                      {p.name}
                    </a>
                  </td>
                  <td className="px-4 py-2">{p.installed ?? <span className="text-gray-600">—</span>}</td>
                  <td className="px-4 py-2">{p.latest ?? <span className="text-gray-600">—</span>}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-medium uppercase tracking-wider ${status.cls}`}
                    >
                      {status.label}
                    </span>
                    {p.optional && (
                      <span className="ml-1 text-[10px] text-gray-600 lowercase">optional</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-gray-400 font-sans">{p.license || '—'}</td>
                  <td className="px-4 py-2 text-gray-400 font-sans">{p.used_for}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
