import { NavLink, Route, Routes } from 'react-router-dom'
import CreatePage from './pages/CreatePage.tsx'
import AnalysePage from './pages/AnalysePage.tsx'
import RemixPage from './pages/RemixPage.tsx'

const navItems = [
  { to: '/', label: 'Create' },
  { to: '/analyse', label: 'Analyse' },
  { to: '/remix', label: 'Remix' },
]

export default function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-gray-800 bg-gray-900/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <a href="/" className="text-xl font-bold tracking-tight">
            <span className="text-jam-400">Jamsesh</span>{' '}
            <span className="text-gray-400">Beatmap</span>
          </a>
          <nav className="flex gap-1">
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
          </nav>
        </div>
      </header>
      <main className="flex-1 max-w-5xl mx-auto px-4 py-8 w-full">
        <Routes>
          <Route path="/" element={<CreatePage />} />
          <Route path="/analyse" element={<AnalysePage />} />
          <Route path="/remix" element={<RemixPage />} />
        </Routes>
      </main>
      <footer className="border-t border-gray-800 py-4 text-center text-xs text-gray-600">
        Jamsesh Beatmap &middot; Powered by madmom
      </footer>
    </div>
  )
}
