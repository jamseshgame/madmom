import { useCallback, useEffect, useState } from 'react'

type PackageStatus = {
  name: string
  installed: string | null
  latest: string | null
  up_to_date: boolean | null
  used_for: string
  license: string
  optional: boolean
  pinned: boolean
  no_deps?: boolean
}

type Versions = {
  packages: PackageStatus[]
}

function useVersions() {
  const [data, setData] = useState<Versions | null>(null)
  const [error, setError] = useState(false)
  const reload = useCallback(() => {
    setData(null)
    setError(false)
    fetch('/api/versions', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then(setData)
      .catch(() => setError(true))
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  return { data, error, reload }
}

function outdatedList(data: Versions): PackageStatus[] {
  return data.packages.filter(
    (p) => p.up_to_date === false && p.installed && p.latest && !p.optional && !p.pinned,
  )
}

export function VersionBanner() {
  const { data, reload } = useVersions()
  const flow = useUpgradeFlow(reload)
  const [dismissed, setDismissed] = useState(false)
  if (!data || dismissed) return null
  const outdated = outdatedList(data)
  if (outdated.length === 0) return null
  return (
    <div className="bg-amber-900/30 border border-amber-800 rounded-lg p-4 flex items-start gap-3">
      <span className="text-amber-400 text-lg leading-none mt-0.5">⚠</span>
      <div className="flex-1 text-sm">
        <p className="font-medium text-amber-200">Updates available</p>
        <ul className="mt-2 space-y-1 text-amber-300/80">
          {outdated.map((p) => (
            <li key={p.name} className="flex items-center gap-2">
              <span className="flex-1">
                <span className="font-mono">{p.name}</span> {p.installed} → {p.latest}
              </span>
              <button
                onClick={() => flow.start(p)}
                className="px-2 py-0.5 bg-amber-800/60 hover:bg-amber-700 text-amber-100 rounded text-[11px] font-medium transition-colors"
                title={`pip install --upgrade ${p.name}`}
              >
                Upgrade
              </button>
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
      <UpgradePanel {...flow} />
    </div>
  )
}

// ── Upgrade interaction ────────────────────────────────────────────────────

type UpgradePhase = 'idle' | 'confirming' | 'running' | 'success' | 'error' | 'restarting'

function useUpgradeFlow(reloadVersions: () => void) {
  const [target, setTarget] = useState<PackageStatus | null>(null)
  const [phase, setPhase] = useState<UpgradePhase>('idle')
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [newVersion, setNewVersion] = useState<string | null>(null)

  const start = (pkg: PackageStatus) => {
    setTarget(pkg)
    setPhase('confirming')
    setProgress(0)
    setMessage('')
    setError('')
    setNewVersion(null)
  }

  const cancelConfirm = () => {
    if (phase === 'confirming') {
      setTarget(null)
      setPhase('idle')
    }
  }

  const closePanel = () => {
    setTarget(null)
    setPhase('idle')
    setProgress(0)
    setMessage('')
    setError('')
    setNewVersion(null)
  }

  const confirm = async () => {
    if (!target) return
    setPhase('running')
    setProgress(0)
    setMessage('Starting…')
    setError('')
    try {
      const res = await fetch(`/api/versions/${encodeURIComponent(target.name)}/upgrade`, {
        method: 'POST',
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }
      const { job_id } = await res.json()
      const es = new EventSource(`/api/jobs/${job_id}/events`)
      es.onmessage = (e) => {
        const d = JSON.parse(e.data)
        if (typeof d.progress === 'number' && d.progress >= 0) setProgress(d.progress)
        if (d.message) setMessage(d.message)
        if (d.step === 'done' && d.metadata) {
          es.close()
          setNewVersion(d.metadata.new_version || null)
          setPhase('success')
          reloadVersions()
        } else if (d.step === 'error') {
          es.close()
          setError(d.message || 'pip upgrade failed')
          setPhase('error')
        } else if (d.step === 'cancelled') {
          es.close()
          setError('Cancelled')
          setPhase('error')
        }
      }
      es.onerror = () => {
        es.close()
        setError('SSE connection lost')
        setPhase('error')
      }
    } catch (e) {
      setError((e as Error).message)
      setPhase('error')
    }
  }

  const restartBackend = async () => {
    setPhase('restarting')
    setError('')
    setMessage('Restarting backend service…')
    try {
      const res = await fetch('/api/versions/restart-backend', { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }
      // Give the service a moment to drop, then poll /api/health every second
      // until it answers 200, then refresh the table.
      await new Promise((r) => setTimeout(r, 2000))
      const start = Date.now()
      const deadline = start + 60_000
      while (Date.now() < deadline) {
        try {
          const h = await fetch('/api/health', { cache: 'no-store' })
          if (h.ok) {
            reloadVersions()
            closePanel()
            return
          }
        } catch {
          // keep polling
        }
        await new Promise((r) => setTimeout(r, 1500))
      }
      throw new Error('Backend did not come back within 60s')
    } catch (e) {
      setError((e as Error).message)
      setPhase('error')
    }
  }

  return {
    target, phase, progress, message, error, newVersion,
    start, cancelConfirm, closePanel, confirm, restartBackend,
  }
}

function UpgradePanel({
  target, phase, progress, message, error, newVersion,
  cancelConfirm, closePanel, confirm, restartBackend,
}: ReturnType<typeof useUpgradeFlow>) {
  if (!target || phase === 'idle') return null
  const isFreshInstall = target.installed == null
  const verb = isFreshInstall ? 'Install' : 'Upgrade'
  const noDepsFlag = target.no_deps ? ' --no-deps' : ''
  const pipCmd = isFreshInstall
    ? `pip install${noDepsFlag} ${target.name}`
    : `pip install --upgrade${noDepsFlag} ${target.name}`
  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && (phase === 'confirming' || phase === 'success' || phase === 'error')) {
          phase === 'confirming' ? cancelConfirm() : closePanel()
        }
      }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg p-5 space-y-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-100">
            {verb} <span className="font-mono text-jam-300">{target.name}</span>
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {isFreshInstall
              ? <>→ {target.latest}{newVersion ? ` · now ${newVersion}` : ''}</>
              : <>{target.installed} → {target.latest}{target.up_to_date && newVersion ? ` · now ${newVersion}` : ''}</>}
          </p>
        </div>

        {phase === 'confirming' && (
          <>
            <div className="bg-amber-900/20 border border-amber-800/40 rounded-lg p-3 text-xs text-amber-300/90 space-y-1">
              <p>
                Runs <span className="font-mono">{pipCmd}</span> in the backend venv.
              </p>
              <p className="text-amber-200/80">
                {target.no_deps
                  ? <>Installs <span className="font-mono">--no-deps</span> — pip won't pull dependencies because this package pins build-time versions that don't build on modern Python. The venv's existing numpy/torch satisfy what it actually needs at runtime. After install, restart the backend to register the new engine.</>
                  : isFreshInstall
                    ? <>This package is optional — pip will pull its full dependency tree, which can be large for ML packages (TensorFlow, PyTorch, model checkpoints). After install, the backend service needs a quick restart to pick up the new engine.</>
                    : <>Pip's resolver may pull other packages along with it. After install, the backend service needs a quick restart to pick up the new code.</>}
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={cancelConfirm}
                className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-md text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirm}
                className="px-4 py-1.5 bg-jam-600 hover:bg-jam-500 text-white rounded-md text-sm font-medium transition-colors"
              >
                Run {pipCmd}
              </button>
            </div>
          </>
        )}

        {(phase === 'running' || phase === 'restarting') && (
          <>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-gray-300">
                <div className="animate-spin h-4 w-4 border-2 border-jam-400 border-t-transparent rounded-full" />
                <span>{phase === 'restarting' ? 'Restarting backend…' : 'Installing…'}</span>
              </div>
              <div className="w-full bg-gray-800 rounded-full h-1.5 overflow-hidden">
                <div
                  className="bg-jam-500 h-full rounded-full transition-all duration-500"
                  style={{ width: `${Math.max(progress, 2)}%` }}
                />
              </div>
              <pre className="text-[11px] font-mono text-gray-500 max-h-32 overflow-auto whitespace-pre-wrap">
                {message}
              </pre>
            </div>
          </>
        )}

        {phase === 'success' && (
          <>
            <div className="bg-emerald-900/20 border border-emerald-800/40 rounded-lg p-3 text-sm text-emerald-300 space-y-1">
              <p>
                <span className="font-mono">{target.name}</span>{' '}
                {newVersion ? <>installed → <span className="font-mono">{newVersion}</span></> : 'installed'}.
              </p>
              <p className="text-emerald-200/80 text-xs">
                Restart the backend to make the new code active.
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={closePanel}
                className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-md text-sm transition-colors"
              >
                Skip — restart later
              </button>
              <button
                onClick={restartBackend}
                className="px-4 py-1.5 bg-emerald-700 hover:bg-emerald-600 text-white rounded-md text-sm font-medium transition-colors"
              >
                Restart backend now
              </button>
            </div>
          </>
        )}

        {phase === 'error' && (
          <>
            <div className="bg-red-900/30 border border-red-800 rounded-lg p-3 text-sm text-red-300 whitespace-pre-wrap break-words">
              {error || 'Upgrade failed'}
            </div>
            <div className="flex justify-end">
              <button
                onClick={closePanel}
                className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-md text-sm transition-colors"
              >
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export function VersionsTable() {
  const { data, error, reload } = useVersions()
  const flow = useUpgradeFlow(reload)

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
      <div className="px-5 py-3 border-b border-gray-800 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">Open-source dependencies</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Live version check against PyPI. Click <span className="font-mono">Install</span> to
            add a missing optional package, or <span className="font-mono">Upgrade</span> on an
            outdated row to run <span className="font-mono">pip install --upgrade</span> in the backend.
          </p>
        </div>
        <button
          onClick={reload}
          className="shrink-0 px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-xs transition-colors"
          title="Re-check versions"
        >
          ↻ Refresh
        </button>
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
              <th className="text-right px-4 py-2 font-medium">Action</th>
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
              const canUpgrade = p.up_to_date === false && p.installed && p.latest && !p.pinned
              const canInstall = p.installed == null && p.latest && !p.pinned
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
                    {p.pinned && (
                      <span className="ml-1 text-[10px] text-gray-600 lowercase" title="Pinned: local install, upgrade manually">
                        pinned
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-gray-400 font-sans">{p.license || '—'}</td>
                  <td className="px-4 py-2 text-gray-400 font-sans">{p.used_for}</td>
                  <td className="px-4 py-2 text-right">
                    {canUpgrade ? (
                      <button
                        onClick={() => flow.start(p)}
                        className="px-2.5 py-1 bg-jam-600 hover:bg-jam-500 text-white rounded text-[11px] font-medium transition-colors"
                        title={`pip install --upgrade ${p.name}`}
                      >
                        Upgrade
                      </button>
                    ) : canInstall ? (
                      <button
                        onClick={() => flow.start(p)}
                        className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-[11px] font-medium transition-colors"
                        title={`pip install ${p.name}`}
                      >
                        Install
                      </button>
                    ) : (
                      <span className="text-[11px] text-gray-700">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <UpgradePanel {...flow} />
    </div>
  )
}
