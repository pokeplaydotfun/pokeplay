import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useSpectate } from '../lib/useSpectate'
import { HpBox, WEATHER_ICON, WEATHER_LABEL } from './Battle'
import { loadPokedex, shortAddr, titleCase, formatEth, type Pokedex } from '../lib/api'
import { Banner, Spinner } from '../components/ui'
import { Address } from '../components/Address'
import { CURRENCY } from '../config'
import '../styles/battle.css'
import '../styles/watch.css'

export default function WatchPage() {
  const { roomId } = useParams()
  const { status, error, view, ended, p0, p1, stakeWei, log, message, messageSide, spectators } =
    useSpectate(roomId)
  const [dex, setDex] = useState<Pokedex | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadPokedex().then(setDex).catch(() => setDex(null))
  }, [])

  // Keep the log pinned to the newest line as it fills in.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log.length])

  const sprite = (id: number, back: boolean) =>
    dex?.species.find((s) => s.id === id)?.sprites[back ? 'back' : 'front'] ?? ''

  // A plain-text name for each side. A hidden player shows their username (or a
  // generic label), never an address.
  const label = (side: 0 | 1): string => {
    const t = side === 0 ? p0 : p1
    if (t.hidden) return t.name ?? 'Hidden trainer'
    return t.name ?? (t.address ? shortAddr(t.address) : 'Trainer')
  }

  // The header element for each side: a clickable address when public, or the
  // username with a lock when the player hid their wallet.
  const tag = (side: 0 | 1) => {
    const t = side === 0 ? p0 : p1
    if (t.hidden || !t.address) return <span className="watch__hidden">🔒 {label(side)}</span>
    return <Address value={t.address} />
  }

  const staked = useMemo(() => {
    try {
      return BigInt(stakeWei || '0') > 0n ? formatEth(stakeWei) : null
    } catch {
      return null
    }
  }, [stakeWei])

  if (error && !view) {
    return (
      <div className="wrap section">
        <Banner kind="error">{error}</Banner>
        <p style={{ marginTop: 18 }}>
          <Link className="btn btn--ghost" to="/play">Back to Play</Link>
        </p>
      </div>
    )
  }

  if (!view) {
    return (
      <div className="wrap section">
        <Spinner label="Connecting to the battle…" />
      </div>
    )
  }

  // Bottom = p0 (back sprite), top = p1 (front sprite), the same face-off a
  // player sees, just with neither side "yours".
  const bottom = view.p0.team[view.p0.active]
  const top = view.p1.team[view.p1.active]

  const result =
    ended === null
      ? null
      : ended.winner === null
        ? 'Draw'
        : `${label(ended.winner)} won`

  const promptText = message ?? (ended ? (result ?? '') : status === 'live' ? 'Watching…' : '…')
  const promptClass =
    messageSide === null ? '' : messageSide === 0 ? ' p-me' : ' p-foe'

  const stakeLabel = staked ? `${staked} ${CURRENCY} on the line` : 'Free match'

  return (
    <div className="wrap bt-page watch">
      <div className="bt-console">
        {/* top bar: who's playing + live/spectator badges */}
        <div className="bt-topbar">
          <div>
            <div className="bt-topbar__eyebrow">
              {tag(0)} vs {tag(1)}
            </div>
            <div className="bt-topbar__title">{stakeLabel}</div>
          </div>
          <div className="watch__badges">
            {ended ? (
              <span className="watch__ended-badge">Ended</span>
            ) : (
              <span className="watch__live">● LIVE</span>
            )}
            <span className="watch__eyes" title="People watching">👁 {spectators}</span>
          </div>
        </div>

        {status === 'closed' && !ended && (
          <Banner kind="warn">The connection dropped. Refresh to reconnect to the battle.</Banner>
        )}

        <div className="bt-frame">
          {/* "<p0> VS <p1>" banner */}
          <div className="bt-vs">
            <span className="bt-vs-name me">{label(0)}</span>
            <span className="bt-vs-name foe">{label(1)}</span>
          </div>

          <div className="bt-main">
            {/* dark battle log, aligned by actor (p0 = left/teal, p1 = right/red) */}
            <div className="bt-log">
              <div className="bt-log-lines" ref={logRef}>
                {log.length === 0 && <div className="bt-log-faint">Battle starting…</div>}
                {log.map((line, i) => (
                  <div
                    key={i}
                    className={`bt-log-line${line.side === 0 ? ' me' : line.side === 1 ? ' foe' : ''}`}
                  >
                    {line.msg}
                  </div>
                ))}
              </div>
              <div className={`bt-log-prompt${promptClass}`}>{promptText}</div>
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
                  <span className="bt-turn-n">{view.turn}</span>
                </div>

                {/* p1 — top */}
                <div className="bt-foe">
                  <img
                    className={`bt-sprite${top.fainted ? ' fainted' : ''}`}
                    src={sprite(top.speciesId, false)}
                    alt={titleCase(top.name)}
                  />
                  <HpBox mon={top} team={view.p1.team} isPlayer={false} />
                </div>

                {/* p0 — bottom, sprite first so the HP box paints on top of it */}
                <div className="bt-me">
                  <img
                    className={`bt-sprite${bottom.fainted ? ' fainted' : ''}`}
                    src={sprite(bottom.speciesId, true) || sprite(bottom.speciesId, false)}
                    alt={titleCase(bottom.name)}
                  />
                  <HpBox mon={bottom} team={view.p0.team} isPlayer={false} />
                </div>

                {/* result overlay */}
                {ended && (
                  <div
                    className={`bt-result bt-result--${ended.winner === null ? 'draw' : 'win'}`}
                  >
                    <div className="bt-result__card">
                      <div className="bt-result__title">{result}</div>
                      <p className="bt-result__body">
                        {staked && ended.winner !== null
                          ? `${label(ended.winner)} takes the ${staked} ${CURRENCY} pot.`
                          : staked
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
                          <code>{ended.seedHash}</code>
                        </div>
                        <div className="bt-verify__row">
                          <span>Seed</span>
                          <code>{ended.seed}</code>
                        </div>
                      </details>
                      <div className="bt-result__actions">
                        {roomId && (
                          <Link className="btn btn--dark" to={`/replay/${roomId}`}>Watch the replay</Link>
                        )}
                        <Link className="btn btn--ghost" to="/play">Back to the lobby</Link>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
