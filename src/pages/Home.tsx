import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, loadPokedex, type Species } from '../lib/api'
import { Mark, TypeBadge } from '../components/ui'
import { Address } from '../components/Address'
import { FAQ, HERO, STEPS, TOKEN } from '../config'

type Stats = { battles: number; players: number; openWagers: number; liveBattles: number }

export default function Home() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [showcase, setShowcase] = useState<Species[]>([])
  const [openFaq, setOpenFaq] = useState<number | null>(0)

  useEffect(() => {
    api.get<Stats>('/api/stats').then(setStats).catch(() => setStats(null))
    loadPokedex()
      .then((d) => {
        // A recognisable spread of starters and fan favourites.
        const ids = [6, 25, 9, 3, 150, 143, 94, 65]
        setShowcase(ids.map((i) => d.species.find((s) => s.id === i)!).filter(Boolean))
      })
      .catch(() => setShowcase([]))
  }, [])

  /**
   * Before anyone has played, live counters are all zero — three big noughts
   * that make the site look dead. Until there is real activity, show the
   * game's actual scale instead. Both sets are true numbers; neither is
   * invented.
   */
  const hasActivity = Boolean(
    stats && (stats.battles > 0 || stats.players > 0 || stats.openWagers > 0),
  )

  const headline = hasActivity
    ? [
        { value: stats!.battles.toLocaleString(), label: 'Battles fought' },
        { value: stats!.players.toLocaleString(), label: 'Trainers' },
        { value: stats!.openWagers.toLocaleString(), label: 'Open wagers' },
      ]
    : []

  return (
    <>
      <section className="hero">
        <div className="wrap">
          <div className="hero__mark">
            <Mark size={84} />
          </div>

          <div className="hero__eyebrows">
            {HERO.eyebrows.map((e) => (
              <span key={e}>{e}</span>
            ))}
          </div>

          <h1>
            {HERO.headline.map((line) => (
              <span key={line} style={{ display: 'block' }}>
                {line}
              </span>
            ))}
          </h1>

          <p className="hero__sub">{HERO.sub}</p>

          {headline.length > 0 && (
            <div
              className="hero__stats"
              style={{ gridTemplateColumns: `repeat(${headline.length}, 1fr)` }}
            >
              {headline.map((item) => (
                <div className="hero__stat" key={item.label}>
                  <div className="hero__stat-value">{item.value}</div>
                  <div className="hero__stat-label">{item.label}</div>
                </div>
              ))}
            </div>
          )}

          {/* Token contract address — click to copy; shows TBA until launch. */}
          <div className="hero__ca">
            <span className="hero__ca-tag">CA:</span>
            {TOKEN.address
              ? <Address value={TOKEN.address as `0x${string}`} />
              : <span className="hero__ca-tba">TBA</span>}
          </div>

          <div className="hero__cta">
            <Link className="btn btn--dark" to="/play">
              Start playing <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      </section>

      {showcase.length > 0 && (
        <section className="section section--tight">
          <div className="wrap">
            <div className="roster-strip">
              {showcase.map((s) => (
                <div className="roster-strip__mon" key={s.id}>
                  <img src={s.sprites.front} alt={s.name} width={72} height={72} />
                  <span className="roster-strip__name">{s.name}</span>
                  <span className="roster-strip__types">
                    {s.types.map((t) => (
                      <TypeBadge key={t} type={t} small />
                    ))}
                  </span>
                </div>
              ))}
            </div>
            <p className="roster-strip__note">
              All 151 original Pokémon with their real base stats, types and learnsets.
            </p>
          </div>
        </section>
      )}

      <section className="section">
        <div className="wrap">
          <div className="section-head section-head--center">
            <div>
              <div className="eyebrow">How it works</div>
              <h2>Team, Match, Battle.</h2>
            </div>
          </div>
          <div className="steps">
            {STEPS.map((s) => (
              <div className="step" key={s.n}>
                <div className="step__n">{s.n}</div>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section section--tight">
        <div className="wrap">
          <div className="card fair">
            <h2>Every battle is fully verifiable.</h2>
            <p className="lede">
              Before a match begins, a commitment is created to lock in the battle randomness.
              Once the match ends, that randomness is revealed, allowing anyone to verify that
              every attack, critical hit, damage roll, and status effect was determined fairly
              and wasn't changed during the game.
            </p>
            <p className="lede">
              The battle logic runs securely on the server, so players can't manipulate the
              outcome.
            </p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="section-head section-head--center">
            <div>
              <div className="eyebrow">FAQ</div>
              <h2>Questions, answered.</h2>
            </div>
          </div>
          <div className="faq faq--center">
            {FAQ.map((item, i) => {
              const isOpen = openFaq === i
              return (
                <div className="faq__item" key={item.q}>
                  <button
                    className="faq__q"
                    onClick={() => setOpenFaq(isOpen ? null : i)}
                    aria-expanded={isOpen}
                  >
                    {item.q}
                    <span className="faq__sign" aria-hidden="true">
                      {isOpen ? '−' : '+'}
                    </span>
                  </button>
                  {isOpen && <p className="faq__a">{item.a}</p>}
                </div>
              )
            })}
          </div>
        </div>
      </section>

    </>
  )
}
