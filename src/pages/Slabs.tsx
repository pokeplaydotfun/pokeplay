import SlabsApp from '../slabs/App'
import '../slabs/styles.css'

/**
 * The Slabs section — the ported GRAILS gacha — mounted under /slabs.
 *
 * Wrapped in `.slabs-root` because its stylesheet is scoped to that class, so
 * the ~6.5k lines of Slabs CSS (its own palette, fonts, resets) can never leak
 * out and repaint the rest of pokeplay. The inner app keeps its own
 * History-API routing, which now lives entirely under /slabs.
 */
export default function Slabs() {
  return (
    <div className="slabs-root">
      <SlabsApp />
    </div>
  )
}
