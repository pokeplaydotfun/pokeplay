import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import SlabsApp from '../slabs/App'
import '../slabs/styles.css'

/**
 * The Slabs section — the ported GRAILS gacha — mounted under /cards.
 *
 * Wrapped in `.slabs-root` because its stylesheet is scoped to that class, so
 * the ~6.5k lines of Slabs CSS (its own palette, fonts, resets) can never leak
 * out and repaint the rest of pokeplay. The inner app keeps its own
 * History-API routing, which now lives entirely under /cards.
 */
export default function Slabs() {
  /**
   * Re-announce every route change to the inner app.
   *
   * Two routers share one history here: pokeplay runs React Router, while the gacha is
   * hand-rolled on the History API and resyncs itself from `window.location` whenever it sees
   * a `popstate`. React Router navigates with `history.pushState`, which fires no `popstate` —
   * and because `/cards/*` is a SINGLE route, this component stays mounted across every cards
   * page, so the inner app's mount-time read of the pathname never runs a second time either.
   *
   * The result: clicking from /cards/gacha to /cards/collection changed the address bar and
   * left the previous page on screen until a manual refresh. Dispatching the event hands the
   * inner router the one signal it already knows how to act on, reusing its existing resync
   * (tab + assetId + intent) rather than introducing a second way to do the same thing.
   *
   * Keyed on `location.key`, not `pathname`: the key is fresh for every navigation, so this
   * still fires when a nav link targets the path React Router believes it is already on —
   * which happens whenever the inner app has pushed a URL of its own, leaving React Router's
   * idea of the location behind.
   */
  const location = useLocation()
  useEffect(() => {
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, [location.key])

  return (
    <div className="slabs-root">
      <SlabsApp />
    </div>
  )
}
