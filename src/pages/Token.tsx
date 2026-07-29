import { EXPLORER, TOKEN, SLABS_ENABLED } from '../config'
import { Address } from '../components/Address'
import { TokenStats } from '../components/TokenStats'
import '../styles/token.css'

/**
 * The token page.
 *
 * The copy reads as live: the token funds the tournament prize pools. The
 * contract address slot is the one thing that still fills in at launch — set
 * VITE_TOKEN_ADDRESS and the "TBA" pill becomes a real, copyable address with
 * an explorer link. Never put a stand-in hex string in the address slot — a
 * placeholder that looks like an address is one somebody will copy and send
 * money to.
 */

const PLAN = [
  {
    n: '01',
    title: 'Fees',
    body: 'Our tokens trading fees gathers in a treasury wallet.',
  },
  {
    n: '02',
    title: 'Tournaments',
    body: 'That treasury funds the prize pools for daily tournaments.',
  },
  {
    n: '03',
    title: 'Prizes',
    body: 'Play the tournaments and compete for those prizes.',
  },
]

export default function Token() {
  const ca = TOKEN.address
  const live = Boolean(ca)

  return (
    <section className="section">
      <div className="wrap">
        <div className="section-head section-head--center">
          <div>
            <h2>{TOKEN.ticker}</h2>
            <p className="lede">
              Our token launched generates fees which are used to fund daily tournaments, giving
              players the chance to compete for prizes simply by playing the game.
            </p>
          </div>
        </div>

        {/* ---- contract address: a compact CA pill, copyable once it is set ---- */}

        <div className="tk__ca">
          <span className="tk__ca-label">CA:</span>
          {live ? (
            <>
              <Address value={ca} className="tk__ca-value" />
              <a
                className="tk__ca-explorer"
                href={`${EXPLORER}/token/${ca}`}
                target="_blank"
                rel="noreferrer"
              >
                Explorer
              </a>
            </>
          ) : (
            /* No hex-shaped stand-in — nothing here can be copied and sent to. */
            <span className="tk__ca-tba">TBA</span>
          )}
        </div>

        {/* ---- the plan ---- */}

        <div className="tk__block">
          <div className="tk__block-head">
            <div className="eyebrow">How it works</div>
            <h3>Trading fees fund the tournaments</h3>
          </div>

          <ol className="tk__plan">
            {PLAN.map((s) => (
              <li className="tk__plan-step" key={s.n}>
                <span className="tk__plan-n">{s.n}</span>
                <h4>{s.title}</h4>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </div>

        {/* ---- card rewards: merged build only ---- */}
        {SLABS_ENABLED && (
          <div className="tk__block">
            <div className="tk__block-head">
              <div className="eyebrow">Cards</div>
              <h3>The same fees fund tournaments and reward card players</h3>
            </div>
            <div className="tk__who">
              <div className="tk__who-item">
                <h4>Tournaments</h4>
                <p>
                  Daily tournaments are funded by the fees creating ongoing competitions with
                  rewards for players.
                </p>
              </div>
              <div className="tk__who-item">
                <h4>Leaderboard</h4>
                <p>
                  The top participants on the Cards leaderboard earn free packs each week for
                  contributing to the ecosystem.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Live fee + market-cap dashboard. Sits under the Cards block because it is the
            evidence for the claims made above it: those sections say the fees fund things,
            this shows what the fees actually are. */}
        {SLABS_ENABLED && <TokenStats />}

      </div>
    </section>
  )
}
