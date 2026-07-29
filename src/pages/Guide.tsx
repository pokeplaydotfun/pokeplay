import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { titleCase } from '../lib/api'
import { CHAIN_LABEL, CURRENCY, FAQ, SLABS_ENABLED } from '../config'
import { CONTRACTS } from '../slabs/chain'
import { Address } from '../components/Address'
import '../styles/guide.css'

/* ------------------------------------------------------------------ */
/* natures — canonical Gen-3+ chart, hardcoded so the table is instant  */
/* and never drifts. Mirrors server/src/battle/natures.ts.              */
/* ------------------------------------------------------------------ */

type StatKey = 'atk' | 'def' | 'spa' | 'spd' | 'spe'

const STAT_FULL: Record<StatKey, string> = {
  atk: 'Attack',
  def: 'Defense',
  spa: 'Sp. Atk',
  spd: 'Sp. Def',
  spe: 'Speed',
}

type NatureRow = { name: string; up: StatKey | null; down: StatKey | null }

const NATURES: NatureRow[] = [
  { name: 'hardy', up: null, down: null },
  { name: 'lonely', up: 'atk', down: 'def' },
  { name: 'brave', up: 'atk', down: 'spe' },
  { name: 'adamant', up: 'atk', down: 'spa' },
  { name: 'naughty', up: 'atk', down: 'spd' },
  { name: 'bold', up: 'def', down: 'atk' },
  { name: 'docile', up: null, down: null },
  { name: 'relaxed', up: 'def', down: 'spe' },
  { name: 'impish', up: 'def', down: 'spa' },
  { name: 'lax', up: 'def', down: 'spd' },
  { name: 'timid', up: 'spe', down: 'atk' },
  { name: 'hasty', up: 'spe', down: 'def' },
  { name: 'serious', up: null, down: null },
  { name: 'jolly', up: 'spe', down: 'spa' },
  { name: 'naive', up: 'spe', down: 'spd' },
  { name: 'modest', up: 'spa', down: 'atk' },
  { name: 'mild', up: 'spa', down: 'def' },
  { name: 'quiet', up: 'spa', down: 'spe' },
  { name: 'bashful', up: null, down: null },
  { name: 'rash', up: 'spa', down: 'spd' },
  { name: 'calm', up: 'spd', down: 'atk' },
  { name: 'gentle', up: 'spd', down: 'def' },
  { name: 'sassy', up: 'spd', down: 'spe' },
  { name: 'careful', up: 'spd', down: 'spa' },
  { name: 'quirky', up: null, down: null },
]

/* ------------------------------------------------------------------ */

type Section = { id: string; label: string }

const SECTIONS: Section[] = [
  { id: 'what', label: 'What is PokePlay' },
  { id: 'how', label: 'How it works' },
  { id: 'rules', label: 'Battle rules' },
  { id: 'team', label: 'Building a team' },
  { id: 'spectate', label: 'Spectating' },
  { id: 'natures', label: 'Natures' },
  { id: 'abilities', label: 'Abilities' },
  { id: 'wager', label: 'Staking & escrow' },
  { id: 'faq', label: 'FAQ' },
  // The Cards (gacha) section is appended only in the merged build.
  ...(SLABS_ENABLED
    ? ([
        { id: 'cards', label: 'Cards' },
        { id: 'cards-usdg', label: 'USDG' },
        { id: 'cards-backing', label: 'Backed 1:1' },
        { id: 'cards-collection', label: 'Robinhood Collection' },
        { id: 'cards-market', label: 'Marketplace' },
        { id: 'cards-faq', label: 'Cards FAQ' },
      ] as Section[])
    : []),
]

/**
 * Highlights the TOC entry for whichever section is currently on screen.
 *
 * A single IntersectionObserver callback only reports the sections whose
 * intersection *changed*, so a tall section already spanning the viewport is
 * never in the batch and would be missed. We therefore keep the full
 * intersecting-state in a ref and recompute the topmost visible section on
 * every callback.
 */
function useScrollSpy(ids: string[]) {
  const [active, setActive] = useState(ids[0])
  const state = useRef<Map<string, boolean>>(new Map())
  useEffect(() => {
    const els = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null)
    if (!els.length) return
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) state.current.set(e.target.id, e.isIntersecting)
        // Topmost section currently intersecting the band wins; keep the last
        // one if nothing is (e.g. mid-scroll between two short sections).
        const firstVisible = ids.find((id) => state.current.get(id))
        if (firstVisible) setActive(firstVisible)
      },
      { rootMargin: '-96px 0px -55% 0px', threshold: 0 },
    )
    els.forEach((el) => obs.observe(el))
    return () => obs.disconnect()
  }, [ids])
  return active
}

function NatureCell({ stat, kind }: { stat: StatKey | null; kind: 'up' | 'down' }) {
  if (!stat) return <span className="g-nat__neutral">—</span>
  return (
    <span className={`g-nat__delta g-nat__delta--${kind}`}>
      {kind === 'up' ? '▲' : '▼'} {STAT_FULL[stat]}
    </span>
  )
}

const HEADER_OFFSET = 88

/**
 * Smoothly scroll a section under the sticky header.
 *
 * Native smooth scrolling (`window.scrollTo({behavior:'smooth'})`,
 * `scrollIntoView`, `#hash` navigation) is unreliable in some Chromium builds —
 * it silently no-ops here — so we animate the jump ourselves with `instant`
 * steps, which always works. Reduced-motion users get an immediate jump.
 */
function scrollToId(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  history.replaceState(null, '', `#${id}`)
  const target = window.scrollY + el.getBoundingClientRect().top - HEADER_OFFSET
  const reduced =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduced) {
    window.scrollTo({ top: target, behavior: 'instant' as ScrollBehavior })
    return
  }
  const start = window.scrollY
  const dist = target - start
  const duration = Math.min(650, Math.max(280, Math.abs(dist) * 0.5))
  const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
  let startTs: number | null = null
  const step = (ts: number) => {
    if (startTs === null) startTs = ts
    const p = Math.min(1, (ts - startTs) / duration)
    window.scrollTo({ top: start + dist * ease(p), behavior: 'instant' as ScrollBehavior })
    if (p < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

export default function Guide() {
  const active = useScrollSpy(useMemo(() => SECTIONS.map((s) => s.id), []))

  /**
   * Honour a deep link such as /guide#cards.
   *
   * This used to do ONE requestAnimationFrame and give up if the element was not there yet,
   * which meant it usually did nothing: the page is code split, so on a cold load the sections
   * frequently have not rendered by that first frame. /guide#cards silently landed at the top
   * of the page, and the nav item pointing at it looked broken. It now retries until the
   * target exists.
   *
   * It also re-asserts once after the async content settles. The Abilities section fills from
   * /api/pokedex and sits ABOVE the cards sections, so when it arrives everything below it
   * moves and a correct jump becomes a wrong one. The re-assert is skipped if the reader has
   * scrolled in the meantime, so it can never yank the page out from under them.
   *
   * Keyed on the hash rather than mount, so choosing Cards from the header while already on
   * the guide jumps too, instead of changing the address bar and nothing else.
   */
  const location = useLocation()
  useEffect(() => {
    const id = location.hash.slice(1)
    if (!id || !SECTIONS.some((s) => s.id === id)) return

    let cancelled = false
    let frames = 0
    let landedAt: number | null = null

    const jump = () => {
      if (cancelled) return
      const el = document.getElementById(id)
      if (!el) {
        // ~1s of frames. Longer than any render, short enough to give up quietly.
        if (frames++ < 60) requestAnimationFrame(jump)
        return
      }
      const top = window.scrollY + el.getBoundingClientRect().top - HEADER_OFFSET
      window.scrollTo({ top, behavior: 'instant' as ScrollBehavior })
      landedAt = Math.round(window.scrollY)
    }

    jump()
    const correct = setTimeout(() => {
      if (landedAt !== null && Math.abs(window.scrollY - landedAt) < 4) jump()
    }, 500)

    return () => {
      cancelled = true
      clearTimeout(correct)
    }
    /*
     * `key` as well as `hash`, because the hash alone does not change when you are already on
     * /guide#cards and choose Cards > Guide again. React Router mints a fresh key for every
     * navigation, so this re-jumps instead of updating the address bar and sitting still.
     */
  }, [location.hash, location.key])

  const neutralNatures = NATURES.filter((n) => !n.up).map((n) => titleCase(n.name))
  const activeNatures = NATURES.filter((n) => n.up)

  return (
    <div className="guide-page">
      {/* ---------- intro ---------- */}
      <section className="guide-hero">
        <div className="wrap">
          <div className="eyebrow">Player guide</div>
          <h1>Everything you need to know</h1>
          <p className="guide-hero__sub">
            PokePlay is a competitive Pokémon battle game on Robinhood where you build a team of
            six from the original 151 and challenge other players. Play for free or stake{' '}
            {CURRENCY}. This guide covers everything you need to know about the game.
          </p>
          <div className="guide-hero__cta">
            <Link className="btn btn--dark" to="/play">
              Start playing <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      </section>

      <div className="wrap">
        <div className="guide">
          {/* ---------- sticky table of contents ---------- */}
          <aside className="guide__toc" aria-label="On this page">
            <nav className="guide__toc-inner">
              <div className="guide__toc-title">On this page</div>
              {SECTIONS.map((s) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  className={`guide__toc-link${active === s.id ? ' guide__toc-link--on' : ''}`}
                  onClick={(e) => {
                    e.preventDefault()
                    scrollToId(s.id)
                  }}
                >
                  {s.label}
                </a>
              ))}
            </nav>
          </aside>

          {/* ---------- content ---------- */}
          <div className="guide__body">
            {/* What is PokePlay */}
            <section id="what" className="g-sec">
              <div className="eyebrow">The basics</div>
              <h2>What is PokePlay?</h2>
              <p className="g-lede">
                A head-to-head Pokémon battle game. You build a team, choose each Pokémon's moves,
                nature and ability, and face another player in a turn-based 6v6 fought on our
                server. Play for free or put your {CURRENCY} on the line. The winner takes the whole
                pot.
              </p>
              <div className="g-facts">
                <div className="g-fact">
                  <div className="g-fact__k">Staking {CURRENCY}</div>
                  <p>Funds are held by a non-custodial escrow contract on {CHAIN_LABEL}.</p>
                </div>
                <div className="g-fact">
                  <div className="g-fact__k">Skill based</div>
                  <p>Team building and turn-by-turn decisions decide the match.</p>
                </div>
                <div className="g-fact">
                  <div className="g-fact__k">Tournaments</div>
                  <p>Compete in daily tournaments funded by the fees generated by our token.</p>
                </div>
              </div>
            </section>

            {/* How it works */}
            <section id="how" className="g-sec">
              <div className="eyebrow">Step by step</div>
              <h2>How it works</h2>
              <ol className="g-steps">
                <li>
                  <span className="g-steps__n">1</span>
                  <div>
                    <h3>Connect &amp; claim a name</h3>
                    <p>
                      Connect your wallet — one signature signs you in. First-timers pick a
                      permanent username other players will see.
                    </p>
                  </div>
                </li>
                <li>
                  <span className="g-steps__n">2</span>
                  <div>
                    <h3>Build a team</h3>
                    <p>Choose six Pokémon, up to four moves each, plus a nature and ability.</p>
                  </div>
                </li>
                <li>
                  <span className="g-steps__n">3</span>
                  <div>
                    <h3>Post or accept a match</h3>
                    <p>
                      Jump into Quick Match for free or post a wager and stake your {CURRENCY}.
                      Another player matches your stake to accept.
                    </p>
                  </div>
                </li>
                <li>
                  <span className="g-steps__n">4</span>
                  <div>
                    <h3>Battle</h3>
                    <p>
                      Fight a turn-based 6v6 with type match-ups, speed and prediction deciding the
                      outcome.
                    </p>
                  </div>
                </li>
                <li>
                  <span className="g-steps__n">5</span>
                  <div>
                    <h3>Winner takes the pot</h3>
                    <p>
                      The server confirms the result to the escrow contract and the winner claims
                      the pot.
                    </p>
                  </div>
                </li>
              </ol>
            </section>

            {/* Battle rules */}
            <section id="rules" className="g-sec">
              <div className="eyebrow">The format</div>
              <h2>Battle rules</h2>
              <div className="g-rules">
                <div className="g-rule">
                  <div className="g-rule__h">6v6 singles</div>
                  <p>Six Pokémon per side, one on the field at a time.</p>
                </div>
                <div className="g-rule">
                  <div className="g-rule__h">Set level 100</div>
                  <p>Every Pokemon is level 100 by default.</p>
                </div>
                <div className="g-rule">
                  <div className="g-rule__h">The first 151</div>
                  <p>Only first generation Pokemon are available right now.</p>
                </div>
                <div className="g-rule">
                  <div className="g-rule__h">Species Clause</div>
                  <p>One of each species per team.</p>
                </div>
                <div className="g-rule">
                  <div className="g-rule__h">Damage categories</div>
                  <p>Physical/special split, abilities, natures and weather all apply.</p>
                </div>
                <div className="g-rule">
                  <div className="g-rule__h">You pick the build</div>
                  <p>Choose each Pokémon's four moves, its nature and its ability or randomise it.</p>
                </div>
              </div>
            </section>

            {/* Building a team */}
            <section id="team" className="g-sec">
              <div className="eyebrow">In the builder</div>
              <h2>Building a team</h2>
              <p className="g-lede">
                Fill six slots and give the team a name to save it. Each slot has four things to
                set:
              </p>
              <ul className="g-list">
                <li>
                  <b>Pokémon</b> — pick from the 151. Its base stats, types and legal moves load
                  automatically.
                </li>
                <li>
                  <b>Moves</b> — up to four, from that Pokémon's real learnset. Each move shows its
                  type, category, power and accuracy.
                </li>
                <li>
                  <b>Nature</b> — See the{' '}
                  <a
                    href="#natures"
                    onClick={(e) => {
                      e.preventDefault()
                      scrollToId('natures')
                    }}
                  >
                    natures table
                  </a>{' '}
                  below.
                </li>
                <li>
                  <b>Ability</b> — a passive effect that's always on. Hover any ability in the
                  builder to read exactly what it does.
                </li>
              </ul>
              <div className="g-tip">
                <span className="g-tip__k">Tip</span>
                In the builder, <b>hovering a nature or ability</b> in its dropdown explains what it
                does before you commit.
              </div>
            </section>

            {/* Spectating */}
            <section id="spectate" className="g-sec">
              <div className="eyebrow">Watching</div>
              <h2>Spectating</h2>
              <p className="g-lede">
                Any match in progress can be watched live, turn by turn, without joining it. A
                spectator sees the same board both players see but takes no part in the battle.
              </p>
              <ul className="g-list">
                <li>
                  <b>Find a match</b> — the <b>Watch live</b> panel on the Play page lists every
                  battle currently underway, with the two trainers, the stake and how many people
                  are already watching.
                </li>
                <li>
                  <b>Open it</b> — press <b>Watch</b> on any row to follow that battle. Tournament
                  matches also carry a <b>Watch live</b> link straight from the bracket.
                </li>
                <li>
                  <b>Follow along</b> — moves, damage, switches and status all play out in real time,
                  alongside the running battle log and a live count of everyone watching.
                </li>
              </ul>
              <div className="g-tip">
                <span className="g-tip__k">Note</span>
                Spectating is read only. You never see hidden information, and nothing you do can
                change the outcome of a match you are watching.
              </div>
            </section>

            {/* Natures */}
            <section id="natures" className="g-sec">
              <div className="eyebrow">Reference</div>
              <h2>Natures</h2>
              <p className="g-lede">
                A nature raises one stat by 10% and lowers another by 10%. HP is never affected.
                Five natures raise and lower the same stat so they cancel out and are neutral, pick
                one of those when you don't want any trade off.
              </p>
              <div className="g-table-wrap">
                <table className="g-nat">
                  <thead>
                    <tr>
                      <th>Nature</th>
                      <th>Raises</th>
                      <th>Lowers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeNatures.map((n) => (
                      <tr key={n.name}>
                        <td className="g-nat__name">{titleCase(n.name)}</td>
                        <td>
                          <NatureCell stat={n.up} kind="up" />
                        </td>
                        <td>
                          <NatureCell stat={n.down} kind="down" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="g-nat__note">
                <b>Neutral:</b> {neutralNatures.join(', ')} — no stat changes.
              </p>
            </section>

            {/* Abilities */}
            <section id="abilities" className="g-sec">
              <div className="eyebrow">Reference</div>
              <h2>Abilities</h2>
              <p className="g-lede">
                An ability is a passive effect that's always active. Every ability shows a one-line
                description when you hover it in the dropdown, so you always know what you're
                picking.
              </p>
            </section>

            {/* Wagering & escrow */}
            <section id="wager" className="g-sec">
              <div className="eyebrow">Staking</div>
              <h2>Staking &amp; escrow</h2>
              <p className="g-lede">
                Staking {CURRENCY} is optional. When both players stake, the {CURRENCY} is held by
                an escrow contract on {CHAIN_LABEL} and released to the winner automatically.
              </p>
              <ul className="g-list">
                <li>
                  <b>Both sides deposit the same stake.</b> The pot is locked in the contract for
                  the duration of the match.
                </li>
                <li>
                  <b>Winner takes the pot.</b> The server confirms the result on-chain and the
                  winner withdraws, minus a small platform fee.
                </li>
                <li>
                  <b>Non-custodial.</b> The contract holds the funds; the server only signs the
                  result. It never touches your money.
                </li>
                <li>
                  <b>Timeout refund.</b> If a match never starts because of a technical issue,
                  either player can reclaim their own stake after a timeout. Funds are never stuck.
                </li>
                <li>
                  <b>Disconnects.</b> You have 30 seconds to reconnect. Beyond that you forfeit; if
                  the battle hadn't started, both players are refunded in full.
                </li>
              </ul>
            </section>

            {/* FAQ */}
            <section id="faq" className="g-sec">
              <div className="eyebrow">Questions</div>
              <h2>FAQ</h2>
              <div className="g-faq">
                {FAQ.map((item) => (
                  <details className="g-faq__item" key={item.q}>
                    <summary>{item.q}</summary>
                    <p>{item.a}</p>
                  </details>
                ))}
              </div>
            </section>

            {/* -------- Cards (the gacha), merged build only -------- */}
            {SLABS_ENABLED && (
              <>
                <section id="cards" className="g-sec">
                  <div className="eyebrow">Cards</div>
                  <h2>Opening packs</h2>
                  <p className="g-lede">
                    PokePlay also opens real Collector Crypt packs and mints you a card backed
                    one-to-one by the graded card inside. You pay in USDG on {CHAIN_LABEL}; the
                    card stays graded, insured and vaulted until you decide what to do with it.
                  </p>
                  <ul className="g-list">
                    <li>
                      <b>Pay in USDG</b> — pick a machine and pay in USDG. Your payment is held
                      in escrow by the contract until a pack has actually been opened for you.
                    </li>
                    <li>
                      <b>We open a real pack</b> — your USDG buys a genuine Collector Crypt pack,
                      verifiable on-chain.
                    </li>
                    <li>
                      <b>You receive the card</b> — an NFT is minted to you on {CHAIN_LABEL},
                      backed one-to-one by the graded card held in the Collector Crypt vault.
                    </li>
                    <li>
                      <b>Keep it, sell it, or take it</b> — hold it as long as you like, sell it
                      back to the vault, list it on the marketplace, or withdraw and claim the
                      physical card.
                    </li>
                  </ul>
                  <div className="g-tip">
                    <span className="g-tip__k">Odds</span>
                    Each machine has its own odds, value bands and price, set by Collector Crypt.
                    They're shown live on every machine over in the{' '}
                    <Link to="/cards/gacha">Gacha</Link>.
                  </div>
                </section>

                <section id="cards-usdg" className="g-sec">
                  <div className="eyebrow">Cards</div>
                  <h2>USDG</h2>
                  <p className="g-lede">
                    USDG is {CHAIN_LABEL}'s stablecoin, issued by Paxos. One USDG is one dollar,
                    and it's what packs are priced in.
                  </p>
                  <p className="g-lede">
                    Some wallets don't recognise USDG by default, so a funded balance can show as
                    nothing until you import the token. You also need a small amount of ETH for
                    gas.
                  </p>
                  <ul className="g-list">
                    <li>
                      <b>USDG contract</b> — <Address value={CONTRACTS.usdg} />
                    </li>
                  </ul>
                </section>

                <section id="cards-backing" className="g-sec">
                  <div className="eyebrow">Cards</div>
                  <h2>Backed 1:1</h2>
                  <p className="g-lede">
                    In the vault sits a professionally graded card, insured at a stated value and
                    held in custody. It does not move while your token exists.
                  </p>
                  <p className="g-lede">
                    In your wallet sits an ERC-721 on {CHAIN_LABEL} carrying the grade, certificate
                    number and insured value of that exact card. There is never more than one token
                    per card. The Collector Crypt NFT backing it stays in Solana custody for exactly
                    as long as your {CHAIN_LABEL} token exists.
                  </p>
                </section>

                <section id="cards-collection" className="g-sec">
                  <div className="eyebrow">Cards</div>
                  <h2>Robinhood Collection</h2>
                  <p className="g-lede">
                    Every card opened here is minted into one collection: one token per card,
                    minted only once the physical card is already in custody, and burned when it
                    leaves.
                  </p>
                  <ul className="g-list">
                    <li><b>Name</b> — POKEPLAY</li>
                    <li><b>Symbol</b> — PLAY</li>
                    <li><b>Standard</b> — ERC-721</li>
                    <li><b>Network</b> — {CHAIN_LABEL}</li>
                    {CONTRACTS.mirror && (
                      <li><b>Contract</b> — <Address value={CONTRACTS.mirror} /></li>
                    )}
                  </ul>
                  <div className="g-tip">
                    <span className="g-tip__k">Tip</span>
                    Most wallets don't show a card automatically. On {CHAIN_LABEL}, open your
                    wallet's NFT section, choose Import NFT, and paste the contract address above
                    with the token ID shown on your card.
                  </div>
                </section>

                <section id="cards-market" className="g-sec">
                  <div className="eyebrow">Cards</div>
                  <h2>Marketplace</h2>
                  <p className="g-lede">
                    Cards can be traded between users, and selling to another user often beats
                    selling back to the vault.
                  </p>
                  <ul className="g-list">
                    <li>
                      <b>List</b> — set your price; the card stays in your wallet and moves only
                      when someone buys it. Change the price or delist at any time.
                    </li>
                    <li>
                      <b>Offer</b> — bid on any listed card, and withdraw the offer whenever you
                      like.
                    </li>
                    <li>
                      <b>Buy</b> — pay the asking price and the card is yours in the same
                      transaction.
                    </li>
                    <li>
                      <b>Deposit</b> — cards you already own on Collector Crypt can be brought
                      across; once the card reaches the vault, the NFT is minted to your wallet.
                    </li>
                  </ul>
                  <p className="g-muted">
                    Neither your card nor your USDG is ever held by the marketplace — listing only
                    grants permission to move a card, an offer only grants permission to spend, so
                    both sides keep what's theirs until a trade happens. A 2.5% fee applies to a
                    completed sale.
                  </p>
                </section>

                <section id="cards-faq" className="g-sec">
                  <div className="eyebrow">Cards</div>
                  <h2>Cards FAQ</h2>
                  <div className="g-faq">
                    {[
                      {
                        q: 'What is USDG and where do I get it?',
                        a: 'USDG is a dollar-backed stablecoin issued by Paxos, and it is the currency of Robinhood Chain. One USDG is one dollar. You will need a small amount of ETH for gas as well.',
                      },
                      {
                        q: 'Do I need a Solana wallet?',
                        a: 'Not to open packs, sell cards back or trade them here. You only need one if you want to withdraw the underlying Solana asset out of custody.',
                      },
                      {
                        q: 'What exactly is insured value?',
                        a: "It is the vault's own reference valuation for a graded card, and it is what every sell-back quote is calculated from. It is not a market price, and a card may be worth more or less in a live auction.",
                      },
                      {
                        q: 'What if something goes wrong while my pack is opening?',
                        a: 'A pack that never opens is refunded in full. Your payment sits in escrow until the moment we buy your pack, and if anything fails before that the contract refunds you automatically.',
                      },
                      {
                        q: 'Can I get the physical card shipped?',
                        a: 'Yes. Withdraw the Solana asset, then redeem it with Collector Crypt directly. Redemption is theirs, so it needs your own verified account with them and is subject to their fees and shipping.',
                      },
                    ].map((item) => (
                      <details className="g-faq__item" key={item.q}>
                        <summary>{item.q}</summary>
                        <p>{item.a}</p>
                      </details>
                    ))}
                  </div>
                </section>
              </>
            )}

            <div className="guide__foot">
              <h2>Ready to battle?</h2>
              <p className="g-muted">Build a team, post a match, and play for the pot.</p>
              <Link className="btn btn--dark" to="/play">
                Go to Play <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
