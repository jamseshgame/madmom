import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import TracksPage from './pages/TracksPage.tsx'
import GameSongsPage from './pages/GameSongsPage.tsx'
import ChangelogPage from './pages/ChangelogPage.tsx'
import LogsPage from './pages/LogsPage.tsx'
import BeatmapEditor from './components/BeatmapEditor.tsx'
import VocalEditor from './components/VocalEditor.tsx'
import { VersionBanner } from './components/VersionStatus.tsx'
import { logout } from './components/AuthGate.tsx'
import { STUDIO_VERSION } from './version.ts'

const navItems = [
  { to: '/', label: 'Studio Library' },
  { to: '/game-songs', label: 'Game Library' },
  { to: '/logs', label: 'Logs' },
]

export default function App() {
  const navigate = useNavigate()
  const location = useLocation()
  if (location.pathname.startsWith('/edit/')) {
    return (
      <Routes>
        <Route path="/edit/:trackId/:beatmapId" element={<BeatmapEditor />} />
      </Routes>
    )
  }
  if (location.pathname.startsWith('/edit-vocals/')) {
    return (
      <Routes>
        <Route path="/edit-vocals/:trackId" element={<VocalEditor />} />
      </Routes>
    )
  }
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-gray-800 bg-gray-900/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xl font-bold tracking-tight">
            <a href="/" className="flex items-center gap-2">
              <img src="/jamsesh-logo.png" alt="Jamsesh" className="h-7 w-auto" />
              <span className="text-gray-400">Studio</span>
            </a>
            <Link
              to="/changelog"
              title="View changelog"
              className="text-[11px] font-medium text-gray-600 hover:text-jam-300 px-1.5 py-0.5 rounded bg-gray-800/60 hover:bg-gray-800 ml-1 tracking-normal transition-colors"
            >
              v{STUDIO_VERSION}
            </Link>
          </div>
          <nav className="flex gap-1 items-center">
            {navItems.map(({ to, label }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                onClick={(e) => {
                  // For Studio Library specifically: always reset back to the
                  // top-level list, even if we're already at /. NavLink would
                  // otherwise no-op in that case and leave the create-flow
                  // result screen up.
                  if (to === '/' && location.pathname === '/') {
                    e.preventDefault()
                    navigate('/', { state: { resetAt: Date.now() } })
                  }
                }}
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-jam-600/20 text-jam-300'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
                  }`
                }
              >
                {label}
              </NavLink>
            ))}
            <button
              onClick={logout}
              className="ml-2 px-3 py-1.5 rounded-md text-sm font-medium text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors"
            >
              Sign out
            </button>
          </nav>
        </div>
      </header>
      <main className="flex-1 max-w-5xl mx-auto px-4 py-8 w-full space-y-6">
        <VersionBanner />
        <Routes>
          <Route path="/" element={<TracksPage />} />
          <Route path="/tracks" element={<TracksPage />} />
          <Route path="/game-songs" element={<GameSongsPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/changelog" element={<ChangelogPage />} />
        </Routes>
      </main>
      <footer className="border-t border-gray-800 py-4 text-center text-xs text-gray-600 space-x-2">
        <span>
          Jamsesh Studio{' '}
          <Link to="/changelog" className="text-gray-500 hover:text-jam-300 transition-colors">
            v{STUDIO_VERSION}
          </Link>
          {' '}&middot; Powered by madmom
        </span>
        <span className="text-gray-700">·</span>
        <Link to="/changelog" className="text-gray-500 hover:text-jam-300 transition-colors">
          Changelog &amp; dependencies
        </Link>
      </footer>
    </div>
  )
}
