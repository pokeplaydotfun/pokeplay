import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useBattle, type OwnMon } from '../lib/useBattle'
import { loadPokedex, titleCase, formatEth, type Pokedex } from '../lib/api'
import { Banner, Spinner } from '../components/ui'
import { CURRENCY } from '../config'
import '../styles/battle.css'
import { Address } from '../components/Address'

/* ------------------------------------------------------------------ */
/* palette + small helpers                                             */
/* ------------------------------------------------------------------ */

/** Move-type accent colours, matching the main game's battle screen. */
const TYPE_COLORS: Record<string, string> = {
  normal: '#9099a1', fire: '#ff6b3d', water: '#4d90d5', grass: '#63bb5b',
  electric: '#f3d23b', ice: '#74cec0', fighting: '#ce4069', poison: '#ab6ac8',
  ground: '#d97746', flying: '#8fa9de', psychic: '#f97176', bug: '#90c12c',
  rock: '#c7b78b', ghost: '#5269ac', dragon: '#0b6dc3', dark: '#5a5366',
  steel: '#5a8ea1', fairy: '#ec8fe6',
}

const STATUS_SHORT: Record<string, string> = {
  brn: 'BRN', psn: 'PSN', tox: 'TOX', par: 'PAR', slp: 'SLP', frz: 'FRZ',
}

/** Stat-stage labels, in the order the main game shows them. */
const STAT_ORDER: [string, string][] = [
  ['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'],
  ['spe', 'Spe'], ['acc', 'Acc'], ['eva', 'Eva'],
]

const hpClass = (hp: number, maxHp: number) => {
  const p = maxHp > 0 ? hp / maxHp : 0
  return p > 0.5 ? 'hi' : p > 0.2 ? 'mid' : 'lo'
}
/** The HP fill clamps to 87.6% of the box so it never overruns the frame art. */
const hpWidth = (hp: number, maxHp: number) =>
  `${(Math.max(0, Math.min(100, (hp / maxHp) * 100)) * 0.876).toFixed(1)}%`

/** Type-effectiveness multiplier as it reads on a move card: "2×", "½×", "0×". */
function formatEff(eff: number): string {
  const label = eff === 0.25 ? '¼' : eff === 0.5 ? '½' : String(eff)
  return `${label}×`
}
function effClass(eff: number): 'super' | 'resist' | 'neutral' | 'immune' {
  return eff === 0 ? 'immune' : eff > 1 ? 'super' : eff < 1 ? 'resist' : 'neutral'
}

export const WEATHER_LABEL = { sun: 'Harsh sun', rain: 'Rain', sand: 'Sandstorm', hail: 'Hail' } as const
export const WEATHER_ICON = { sun: '☀️', rain: '🌧️', sand: '🌪️', hail: '❄️' } as const

/* ------------------------------------------------------------------ */
/* pieces of the arena                                                 */
/* ------------------------------------------------------------------ */

/**
 * A mon as the HP box needs it. `boosts` is optional so the box can also render
 * a replay snapshot, which carries HP/status but not stat stages.
 */
type BoxMon = {
  name: string
  hp: number
  maxHp: number
  status: string | null
  boosts?: Record<string, number>
}

/** The floating HP box (name, Lv, hpbar.png bar, ball row, stat chips). */
export function HpBox({
  mon, team, isPlayer,
}: {
  mon: BoxMon
  team: { fainted: boolean }[]
  isPlayer: boolean
}) {
  const boosts = STAT_ORDER.filter(([k]) => mon.boosts?.[k])
  return (
    <div className="bt-box-wrap">
      <div className="bt-box">
        <div className="bt-boxtop">
          <span className="bt-bname">
            {titleCase(mon.name)}
            {mon.status && (
              <span className={`bt-status ${mon.status}`}>
                {STATUS_SHORT[mon.status] ?? mon.status.toUpperCase()}
              </span>
            )}
          </span>
          <span className="bt-blv">Lv100</span>
        </div>
        <div className="bt-hpbar">
          <div
            className={`bt-hpfill ${hpClass(mon.hp, mon.maxHp)}`}
            style={{ width: hpWidth(mon.hp, mon.maxHp) }}
          />
        </div>
        {isPlayer && (
          <div className="bt-hpnum">
            {Math.max(0, mon.hp)}/{mon.maxHp}
          </div>
        )}
        <div className="bt-balls">
          {team.map((m, i) => (
            <img key={i} src={m.fainted ? '/ui/Pokeball_empty.png' : '/ui/Pokeball.png'} alt="" />
          ))}
        </div>
      </div>
      {boosts.length > 0 && (
        <div className="bt-stats">
          {boosts.map(([k, label]) => {
            const v = mon.boosts?.[k] ?? 0
            return (
              <span key={k} className={`bt-stat ${v > 0 ? 'up' : 'down'}`}>
                {label} {v > 0 ? '+' : ''}{v}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* the prompt line                                                     */
/* ------------------------------------------------------------------ */

function battleMessage(b: ReturnType<typeof useBattle>, meName?: string): string {
  const who = titleCase(meName ?? 'your Pokémon')
  if (b.animating) return b.message ?? '…'
  if (b.oppGone) return 'Your opponent disconnected…'
  if (b.state?.mustReplace) return `${who} fainted! Choose who is up next.`
  if (b.waiting) return 'Waiting for your opponent…'
  if (b.state && !b.state.finished) return `What will ${who} do?`
  return '…'
}

/* ------------------------------------------------------------------ */
/* the battle screen                                                   */
/* ------------------------------------------------------------------ */

export function BattleView({ roomId, onLeave }: { roomId: string | undefined; onLeave?: () => void }) {
  const b = useBattle(roomId)
  const [dex, setDex] = useState<Pokedex | null>(null)
  // The command menu the player is in: the FIGHT/SWITCH root, the move grid, or
  // the party list — the same drill-down the main game's battle menu uses.
  const [menu, setMenu] = useState<'main' | 'moves' | 'switch'>('main')
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadPokedex().then(setDex).catch(() => setDex(null))
  }, [])

  // Keep the log pinned to the newest line.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [b.log])

  // A new turn returns the menu to its FIGHT/SWITCH root…
  useEffect(() => {
    setMenu('main')
  }, [b.state?.turn])
  // …but a forced replacement drops straight into the party list.
  useEffect(() => {
    if (b.state?.mustReplace) setMenu('switch')
  }, [b.state?.mustReplace])

  const sprite = (id: number, back: boolean) =>
    dex?.species.find((s) => s.id === id)?.sprites[back ? 'back' : 'front'] ?? ''

  // The arena renders the *paced* view (trails the server while a turn plays
  // out); the controls read the authoritative state so the move list is real.
  const view = b.view ?? b.state
  const me = view?.you.team[view.you.active]
  const foe = view?.foe.team[view.foe.active]
  const meState = b.state?.you.team[b.state.you.active]

  const canAct = useMemo(
    () => Boolean(b.state && !b.state.finished && !b.waiting && !b.ended && !b.animating),
    [b.state, b.waiting, b.ended, b.animating],
  )

  if (b.status === 'error' || (b.error && !b.state)) {
    return (
      <div className="wrap section">
        <Banner kind="error">{b.error ?? 'Could not join the battle.'}</Banner>
        <p style={{ marginTop: 18 }}>
          <button className="btn btn--ghost" onClick={onLeave}>Back to the lobby</button>
        </p>
      </div>
    )
  }

  if (!b.state || !me || !foe || !view) {
    return (
      <div className="wrap section">
        <Spinner label="Joining the battle…" />
      </div>
    )
  }

  const timerPct = Math.min(100, (b.secondsLeft / 30) * 100)
  const foeName = b.opponentName ?? 'Opponent'
  const stakeLabel =
    b.stakeWei !== '0'
      ? `${formatEth(b.stakeWei)} ${CURRENCY} on the line`
      : b.practice ? 'Practice match' : 'Free match'

  /* ---- the menu that overlays the arena ---- */
  function renderMenu() {
    if (b.ended) return null
    if (b.animating) {
      return (
        <div className="bt-idle" aria-hidden="true">
          <i /> <i /> <i />
        </div>
      )
    }
    if (b.waiting) {
      return (
        <div className="bt-idle">
          <i /> <i /> <i />
        </div>
      )
    }
    // Forced replacement, or the player opened the party list.
    if (b.state!.mustReplace || menu === 'switch') {
      return (
        <div className="bt-menu list">
          <div className="bt-list">
            {b.state!.you.team.map((m, i) => {
              const isActive = i === b.state!.you.active
              return (
                <button
                  key={i}
                  className={`bt-listitem${m.fainted ? ' dead' : ''}`}
                  disabled={!canAct || m.fainted || isActive}
                  onClick={() => { b.send({ kind: 'switch', index: i }); setMenu('main') }}
                >
                  <img src={sprite(m.speciesId, false)} alt="" />
                  <span className="bt-listitem__body">
                    <span className="bt-listitem__name">
                      {titleCase(m.name)}
                      {m.status && <span className={`bt-status ${m.status}`}>{STATUS_SHORT[m.status] ?? ''}</span>}
                    </span>
                    <span className="bt-listitem__hp">
                      {m.fainted ? 'Fainted' : `${m.hp}/${m.maxHp}`}{isActive ? ' ●' : ''}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
          {!b.state!.mustReplace && (
            <button className="bt-cmd back wide" onClick={() => setMenu('main')}>Back</button>
          )}
        </div>
      )
    }
    // The move grid.
    if (menu === 'moves') {
      const moves = (meState as OwnMon).moves
      const allOut = moves.every((m) => m.pp <= 0)
      return (
        <div className="bt-menu moves">
          <div className="bt-moverow">
            <div className="bt-movegrid">
              {allOut && <div className="bt-ppwarn">Out of PP — Struggle will be used.</div>}
              {moves.map((mv, i) => {
                const info = dex?.moves[mv.name]
                const out = mv.pp <= 0
                const color = info ? TYPE_COLORS[info.type] ?? '#777' : '#777'
                return (
                  <button
                    key={mv.name}
                    className="bt-move"
                    disabled={!canAct || out}
                    onClick={() => { b.send({ kind: 'move', index: i }); setMenu('main') }}
                    style={{ borderBottomColor: color }}
                  >
                    <span>{titleCase(mv.name)}</span>
                    <small>{info ? titleCase(info.type) : ''}<b>{mv.pp}/{mv.maxPp}</b></small>
                    {mv.eff != null && mv.eff !== 1 && (
                      <span className={`bt-eff ${effClass(mv.eff)}`}>{formatEff(mv.eff)}</span>
                    )}
                  </button>
                )
              })}
            </div>
            <button className="bt-cmd back" onClick={() => setMenu('main')}>Back</button>
          </div>
        </div>
      )
    }
    // The FIGHT / SWITCH root.
    return (
      <div className="bt-menu">
        <button className="bt-cmd" disabled={!canAct} onClick={() => setMenu('moves')}>FIGHT</button>
        <button className="bt-cmd" disabled={!canAct} onClick={() => setMenu('switch')}>SWITCH</button>
      </div>
    )
  }

  return (
    <div className="wrap bt-page">
      <div className="bt-console">
        {/* top bar: stake + turn clock */}
        <div className="bt-topbar">
          <div>
            <div className="bt-topbar__eyebrow">
              {b.opponentName ? (
                <>vs {b.opponentName}</>
              ) : b.opponent ? (
                <>vs <Address value={b.opponent} /></>
              ) : (
                'live battle'
              )}
            </div>
            <div className="bt-topbar__title">{stakeLabel}</div>
          </div>
          {!b.ended && (
            <div className={`bt-timer${b.secondsLeft <= 5 ? ' bt-timer--urgent' : ''}`}>
              <svg viewBox="0 0 36 36" className="bt-timer__ring">
                <circle cx="18" cy="18" r="16" className="bt-timer__track" />
                <circle
                  cx="18" cy="18" r="16"
                  className="bt-timer__value"
                  strokeDasharray={`${timerPct} 100`}
                  pathLength={100}
                />
              </svg>
              <span className="bt-timer__num">{b.secondsLeft}</span>
            </div>
          )}
        </div>

        <div className="bt-frame">
          {/* "<you> VS <foe>" banner */}
          <div className="bt-vs">
            <span className="bt-vs-name me">You</span>
            <span className="bt-vs-name foe">{foeName}</span>
          </div>

          <div className="bt-main">
            {/* dark battle log, aligned by actor */}
            <div className="bt-log">
              <div className="bt-log-lines" ref={logRef}>
                {b.log.length === 0 && <div className="bt-log-faint">Battle starting…</div>}
                {b.log.map((line, i) => (
                  <div key={i} className={`bt-log-line${line.who === 'you' ? ' me' : line.who === 'foe' ? ' foe' : ''}`}>
                    {line.msg}
                  </div>
                ))}
              </div>
              <div
                className={`bt-log-prompt${
                  b.animating && b.messageSide ? ` p-${b.messageSide === 'you' ? 'me' : 'foe'}` : ''
                }`}
              >
                {battleMessage(b, me.name)}
              </div>
              {b.seedHash && (
                <div className="bt-log-foot" title="Published before the first turn">
                  seed commitment {b.seedHash.slice(0, 18)}…
                </div>
              )}
            </div>

            {/* the arena */}
            <div className="bt-window">
              <div className={`bt-stage${view.weather ? ` bt-stage--${view.weather}` : ''}`}>
                {view.weather && (
                  <div className="bt-weather">
                    <span aria-hidden="true">{WEATHER_ICON[view.weather]}</span>
                    {WEATHER_LABEL[view.weather]}
                  </div>
                )}
                <div className="bt-turn">
                  <span className="bt-turn-label" />
                  <span className="bt-turn-n">{b.state.turn}</span>
                </div>

                {/* opponent */}
                <div className="bt-foe">
                  <img
                    className={`bt-sprite${foe.fainted ? ' fainted' : ''}`}
                    src={sprite(foe.speciesId, false)}
                    alt={titleCase(foe.name)}
                  />
                  <HpBox mon={foe} team={view.foe.team} isPlayer={false} />
                </div>

                {/* you — sprite first so the HP box paints on top of it (readable) */}
                <div className="bt-me">
                  <img
                    className={`bt-sprite${me.fainted ? ' fainted' : ''}`}
                    src={sprite(me.speciesId, true) || sprite(me.speciesId, false)}
                    alt={titleCase(me.name)}
                  />
                  <HpBox mon={me} team={view.you.team} isPlayer />
                </div>

                {/* opponent-gone / error banners over the arena */}
                {b.oppGone && (
                  <div className="bt-overlay bt-overlay--warn">
                    {b.oppGoneSeconds > 0
                      ? `Opponent disconnected — ${b.oppGoneSeconds}s to reconnect, or they forfeit.`
                      : 'Opponent gone — awarding you the match…'}
                  </div>
                )}
                {b.error && !b.oppGone && <div className="bt-overlay bt-overlay--error">{b.error}</div>}

                {/* result overlay */}
                {b.ended && (
                  <div
                    className={`bt-result bt-result--${
                      b.ended.youWon ? 'win' : b.ended.winner === null ? 'draw' : 'loss'
                    }`}
                  >
                    <div className="bt-result__card">
                      <div className="bt-result__title">
                        {b.ended.winner === null ? 'Draw' : b.ended.youWon ? 'You win' : 'You lose'}
                      </div>
                      <p className="bt-result__body">
                        {b.stakeWei !== '0' && b.ended.youWon
                          ? `Claim your ${formatEth(b.stakeWei)} ${CURRENCY} payout from the lobby.`
                          : b.stakeWei !== '0' && b.ended.winner === null
                            ? 'A draw refunds both stakes.'
                            : 'Good game.'}
                      </p>
                      <details className="bt-verify">
                        <summary>Verify this battle</summary>
                        <p>
                          Every roll came from one seed, committed before the first turn and revealed
                          now. Hash the seed and it must equal the commitment.
                        </p>
                        <div className="bt-verify__row">
                          <span>Commitment</span>
                          <code>{b.ended.seedHash}</code>
                        </div>
                        <div className="bt-verify__row">
                          <span>Seed</span>
                          <code>{b.ended.seed}</code>
                        </div>
                      </details>
                      <div className="bt-result__actions">
                        {roomId && (
                          <Link className="btn btn--dark" to={`/replay/${roomId}`}>Watch the replay</Link>
                        )}
                        <button className="btn btn--ghost" onClick={onLeave}>Back to the lobby</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/*
                The action menu is a SIBLING of the arena, not a child of it.
                On a wide screen it is absolutely positioned over the arena's bottom-left corner
                exactly as before (`.bt-window` is the containing block, and the arena fills it).
                On a phone it becomes an ordinary block underneath the arena — which is the only
                way the buttons can be full-width and finger-sized, and it also removes an
                overlay that used to swallow taps aimed at FIGHT.
              */}
              <div className="bt-menu-wrap">{renderMenu()}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
