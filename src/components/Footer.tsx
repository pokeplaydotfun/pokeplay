import { BRAND } from '../config'
import { Mark } from './ui'

/**
 * Site footer — brand mark + socials. Rendered globally (App), so it appears
 * on every page rather than just the home page.
 */
export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap footer__inner">
        <div className="brand">
          <Mark size={30} />
          <span className="brand__word">
            {BRAND.name.slice(0, BRAND.name.length - BRAND.accentWord.length)}
            <span className="brand__accent">{BRAND.accentWord}</span>
          </span>
        </div>

        <div className="social">
          <a
            className="social__btn"
            href={BRAND.twitter || '#'}
            target={BRAND.twitter ? '_blank' : undefined}
            rel="noopener noreferrer"
            aria-label="X"
            title="X"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117Z"
              />
            </svg>
          </a>

          <a
            className="social__btn"
            href={BRAND.github || '#'}
            target={BRAND.github ? '_blank' : undefined}
            rel="noopener noreferrer"
            aria-label="GitHub"
            title="GitHub"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.11-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.65 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.63-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58A12 12 0 0 0 12 .5Z"
              />
            </svg>
          </a>
        </div>
      </div>

      <div className="wrap footer__legal">© 2026 {BRAND.name}. All rights reserved.</div>
    </footer>
  )
}
