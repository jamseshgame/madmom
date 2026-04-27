import { FormEvent, useEffect, useState } from 'react'

type State = 'checking' | 'unauth' | 'auth'

function LoginForm({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const fd = new FormData()
      fd.append('username', username)
      fd.append('password', password)
      const res = await fetch('/api/auth/login', { method: 'POST', body: fd })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail || 'Login failed')
      }
      onLoggedIn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 px-4">
      <form
        onSubmit={submit}
        className="bg-gray-900 border border-gray-800 rounded-2xl p-8 w-full max-w-sm space-y-5"
      >
        <div className="flex items-center gap-2">
          <img src="/jamsesh-logo.png" alt="Jamsesh" className="h-7 w-auto" />
          <span className="text-gray-400 text-xl font-bold tracking-tight">Studio</span>
        </div>

        <label className="block">
          <span className="text-xs text-gray-500 uppercase tracking-wider">Username</span>
          <input
            type="text"
            autoFocus
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-jam-500"
          />
        </label>

        <label className="block">
          <span className="text-xs text-gray-500 uppercase tracking-wider">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-jam-500"
          />
        </label>

        {error && (
          <div className="bg-red-900/30 border border-red-800 rounded-lg p-3 text-sm text-red-400">{error}</div>
        )}

        <button
          type="submit"
          disabled={busy || !username || !password}
          className="w-full px-4 py-2.5 bg-jam-600 hover:bg-jam-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors"
        >
          {busy ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>('checking')

  const check = async () => {
    try {
      const res = await fetch('/api/auth/me')
      const data = await res.json()
      setState(data.authenticated ? 'auth' : 'unauth')
    } catch {
      setState('unauth')
    }
  }

  useEffect(() => {
    check()
  }, [])

  if (state === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <div className="animate-spin h-6 w-6 border-2 border-jam-400 border-t-transparent rounded-full" />
      </div>
    )
  }

  if (state === 'unauth') {
    return <LoginForm onLoggedIn={() => setState('auth')} />
  }

  return <>{children}</>
}

export async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' })
  } finally {
    window.location.reload()
  }
}
