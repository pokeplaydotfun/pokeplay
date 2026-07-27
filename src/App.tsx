import { Suspense, lazy, useEffect, useState } from 'react'
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { AccountMenu } from './components/AccountMenu'
import { Mark, Spinner } from './components/ui'
import { Footer } from './components/Footer'
import { DevLogin } from './components/DevLogin'
import { DEV_LOGIN_POSSIBLE } from './config'
import { UsernameGate } from './components/UsernameGate'
import { BRAND, NAV, SLABS_ENABLED } from './config'

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
const Watch = lazy(() => import('./pages/Watch'))
const Slabs = lazy(() => import('./pages/Slabs'))

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

/** The page name shown in the tab, e.g. "PokePlay - Leaderboard". Home is the
 *  brand alone. Order matters: the dynamic routes (a battle, one tournament, a
 *  replay) are matched by prefix before their plain list page. */
function pageName(pathname: string): string | null {
  if (pathname === '/') return null
  if (pathname.startsWith('/play/')) return 'Battle'
  if (pathname === '/play') return 'Play'
  if (pathname.startsWith('/tournaments/')) return 'Tournament'
  if (pathname === '/tournaments') return 'Tournaments'
  if (pathname.startsWith('/replay/')) return 'Replay'
  if (pathname.startsWith('/watch/')) return 'Watch'
  if (pathname === '/guide') return 'Guide'
  if (pathname === '/leaderboard') return 'Leaderboard'
  if (pathname === '/token') return 'Token'
  if (pathname === '/profile') return 'Profile'
  return null
}

/** Keeps the browser-tab title in step with the route. */
function TitleSync() {
  const { pathname } = useLocation()
  useEffect(() => {
    const page = pageName(pathname)
    document.title = page ? `${BRAND.name} - ${page}` : BRAND.name
  }, [pathname])
  return null
}

/**
 * The app shell. The Slabs section (/slabs) is a self-contained ported app with
 * its own full-page chrome, so pokeplay's header/footer/username-gate are hidden
 * there to avoid doubling up; everywhere else they wrap the page as usual.
 */
function Shell() {
  const slabs = useLocation().pathname.startsWith('/slabs')
  return (
    <>
      <TitleSync />
      {/* The dev-login probe 404s on any real deployment, which logged an
          error in every visitor's console. Only mount it where it can work. */}
      {DEV_LOGIN_POSSIBLE && <DevLogin />}
      {!slabs && <Header />}
      {/* Blocks the app until a first-time wallet has claimed a name. */}
      {!slabs && <UsernameGate />}
      <main className={slabs ? 'main--bleed' : undefined}>
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
          <Route path="/watch/:roomId" element={<Watch />} />
          {/* Gated: only mounts once the Slabs gacha is configured (VITE_SLABS_ENABLED).
              Off by default so a working-tree deploy never exposes it half-wired. */}
          {SLABS_ENABLED && <Route path="/slabs/*" element={<Slabs />} />}

          {/* Old split routes now all land on the unified page. */}
          <Route path="/teams" element={<Navigate to="/play" replace />} />
          <Route path="/wagers" element={<Navigate to="/play" replace />} />
          <Route path="/battle" element={<Navigate to="/play" replace />} />
          <Route path="/battle/:roomId" element={<LegacyBattleRedirect />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </main>
      {!slabs && <Footer />}
    </>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  )
}
