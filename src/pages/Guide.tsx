import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { titleCase } from '../lib/api'
import { CHAIN_LABEL, CURRENCY, FAQ } from '../config'
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
  { id: 'natures', label: 'Natures' },
  { id: 'abilities', label: 'Abilities' },
  { id: 'wager', label: 'Staking & escrow' },
  { id: 'faq', label: 'FAQ' },
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

  // Honour a deep link (/guide#natures). The page is code-split, so the target
  // section doesn't exist when the browser first tries to jump to the fragment;
  // do it ourselves once the sections have rendered.
  useEffect(() => {
    const id = window.location.hash.slice(1)
    if (!id || !SECTIONS.some((s) => s.id === id)) return
    requestAnimationFrame(() => {
      const el = document.getElementById(id)
      if (el)
        window.scrollTo({
          top: window.scrollY + el.getBoundingClientRect().top - HEADER_OFFSET,
          behavior: 'instant' as ScrollBehavior,
        })
    })
  }, [])

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
              <div className="eyebrow">Money</div>
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
