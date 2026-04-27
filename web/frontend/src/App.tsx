import { NavLink, Route, Routes } from 'react-router-dom'
import CreatePage from './pages/CreatePage.tsx'
import TracksPage from './pages/TracksPage.tsx'
import GameSongsPage from './pages/GameSongsPage.tsx'
import { VersionBanner, VersionFooter } from './components/VersionStatus.tsx'
import { logout } from './components/AuthGate.tsx'

const navItems = [
  { to: '/', label: 'Create' },
  { to: '/tracks', label: 'Tracks' },
  { to: '/game-songs', label: 'Game Songs' },
]

export default function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-gray-800 bg-gray-900/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2 text-xl font-bold tracking-tight">
            <img src="/jamsesh-logo.png" alt="Jamsesh" className="h-7 w-auto" />
            <span className="text-gray-400">Studio</span>
          </a>
          <nav className="flex gap-1 items-center">
            {navItems.map(({ to, label }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
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
          <Route path="/" element={<CreatePage />} />
          <Route path="/tracks" element={<TracksPage />} />
          <Route path="/game-songs" element={<GameSongsPage />} />
        </Routes>
      </main>
      <footer className="border-t border-gray-800 py-4 text-center text-xs text-gray-600 space-x-2">
        <span>Jamsesh Studio &middot; Powered by madmom</span>
        <span className="text-gray-700">·</span>
        <VersionFooter />
      </footer>
    </div>
  )
}
