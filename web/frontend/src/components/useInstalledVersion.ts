import { useEffect, useState } from 'react'

// Fetch the installed version of a package from /api/versions. Returns null
// while loading or if the package isn't reported. Caches the response so
// multiple consumers on the same page only fire one request.
let cached: Promise<Record<string, string | null>> | null = null

function loadVersions(): Promise<Record<string, string | null>> {
  if (cached) return cached
  cached = fetch('/api/versions')
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      const out: Record<string, string | null> = {}
      if (data?.packages) {
        for (const p of data.packages as { name: string; installed: string | null }[]) {
          out[p.name] = p.installed
        }
      }
      return out
    })
    .catch(() => ({}))
  return cached
}

export default function useInstalledVersion(pkg: string): string | null {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    let mounted = true
    loadVersions().then((map) => {
      if (mounted) setVersion(map[pkg] ?? null)
    })
    return () => { mounted = false }
  }, [pkg])
  return version
}
