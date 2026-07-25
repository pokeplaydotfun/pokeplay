import { Suspense, lazy, useState } from 'react'
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useParams } from 'react-router-dom'
import { AccountMenu } from './components/AccountMenu'
import { Mark, Spinner } from './components/ui'
import { Footer } from './components/Footer'
import { DevLogin } from './components/DevLogin'
import { DEV_LOGIN_POSSIBLE } from './config'
import { UsernameGate } from './components/UsernameGate'
import { BRAND, NAV } from './config'

import Home from './pages/Home'

/**
 * Everything except the landing page is loaded on demand. The battle arena,
 * team builder and escrow code are a large share of the bundle and most
 * first-time visitors never reach them.
 */
const Play = lazy(() => import('./pages/Play'))
const Guide = lazy(() => import('./pages/Guide'))
const Leaderboard = lazy(() => import('./pages/Leaderboard'))
const Tournaments = lazy(() => import('./pages/Tournaments'))
const Tournament = lazy(() => import('./pages/Tournament'))
const Token = lazy(() => import('./pages/Token'))
const Profile = lazy(() => import('./pages/Profile'))
const Replay = lazy(() => import('./pages/Replay'))

function Header() {
  const [menu, setMenu] = useState(false)
  // "PokePlay" is one word — no space between the two halves of the wordmark.
  const base = BRAND.name.slice(0, BRAND.name.length - BRAND.accentWord.length)

  return (
    <header className="header">
      <div className="wrap header__inner">
        <Link className="brand" to="/">
          <Mark size={34} />
          <span className="brand__word">
            {base}
            <span className="brand__accent">{BRAND.accentWord}</span>
          </span>
        </Link>

        <nav className={`nav${menu ? ' nav--open' : ''}`}>
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              onClick={() => setMenu(false)}
              className={({ isActive }) => (isActive ? 'nav--active' : undefined)}
            >
              {n.label}
            </NavLink>
          ))}
        </nav>

        <div className="header__right">
          {/* Sign-out and disconnect live inside the account menu rather than
              cluttering the bar with two more buttons. */}
          <AccountMenu />
          <button
            className="nav-toggle"
            onClick={() => setMenu((v) => !v)}
            aria-label="Toggle menu"
            aria-expanded={menu}
          >
            {menu ? '✕' : '☰'}
          </button>
        </div>
      </div>
    </header>
  )
}

/** Keeps old /battle/:id links working. */
function LegacyBattleRedirect() {
  const { roomId } = useParams()
  return <Navigate to={roomId ? `/play/${roomId}` : '/play'} replace />
}

export default function App() {
  return (
    <BrowserRouter>
      {/* The dev-login probe 404s on any real deployment, which logged an
          error in every visitor's console. Only mount it where it can work. */}
      {DEV_LOGIN_POSSIBLE && <DevLogin />}
      <Header />
      {/* Blocks the app until a first-time wallet has claimed a name. */}
      <UsernameGate />
      <main>
        <Suspense fallback={<div className="route-loading"><Spinner label="Loading…" /></div>}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/play" element={<Play />} />
          <Route path="/play/:roomId" element={<Play />} />
          <Route path="/guide" element={<Guide />} />
          <Route path="/tournaments" element={<Tournaments />} />
          <Route path="/tournaments/:id" element={<Tournament />} />
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/token" element={<Token />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/replay/:id" element={<Replay />} />

          {/* Old split routes now all land on the unified page. */}
          <Route path="/teams" element={<Navigate to="/play" replace />} />
          <Route path="/wagers" element={<Navigate to="/play" replace />} />
          <Route path="/battle" element={<Navigate to="/play" replace />} />
          <Route path="/battle/:roomId" element={<LegacyBattleRedirect />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </main>
      <Footer />
    </BrowserRouter>
  )
}
