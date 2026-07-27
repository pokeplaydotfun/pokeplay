import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, formatEth, shortAddr } from '../lib/api'
import { CURRENCY } from '../config'
import '../styles/watch.css'

type LiveBattle = {
  roomId: string
  p0: string | null
  p0Name: string | null
  p0Hidden: boolean
  p1: string | null
  p1Name: string | null
  p1Hidden: boolean
  turn: number
  stakeWei: string
  wagerId: number | null
  tournament: { id: number; name: string } | null
  spectators: number
  startedAt: number
}

const label = (
  name: string | null,
  addr: string | null,
  hidden: boolean,
): { text: string; hidden: boolean } => {
  if (hidden) return { text: name ?? 'Hidden trainer', hidden: true }
  return { text: name ?? (addr ? shortAddr(addr) : 'Trainer'), hidden: false }
}

/**
 * Live matches anyone can drop in and watch. Polls `/api/live`; renders nothing
 * until at least one match is in progress, so the lobby stays clean when it's
 * quiet.
 */
export function LiveBattles() {
  const [battles, setBattles] = useState<LiveBattle[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let live = true
    const poll = () =>
      api
        .get<{ battles: LiveBattle[] }>('/api/live')
        .then((r) => {
          if (live) {
            setBattles(r.battles)
            setLoaded(true)
          }
        })
        .catch(() => live && setLoaded(true))
    poll()
    const id = setInterval(poll, 6000)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [])

  // Nothing to show until something is actually being played.
  if (!loaded || battles.length === 0) return null

  return (
    <div className="card play__panel">
      <div className="play__panel-head play__panel-head--center">
        <h3>Watch live {battles.length > 1 && <span className="watch__eyes">· {battles.length} matches</span>}</h3>
      </div>

      <div className="live">
        {battles.map((b) => {
          const a = label(b.p0Name, b.p0, b.p0Hidden)
          const z = label(b.p1Name, b.p1, b.p1Hidden)
          let stake: string | null = null
          try {
            stake = BigInt(b.stakeWei || '0') > 0n ? formatEth(b.stakeWei) : null
          } catch {
            stake = null
          }
          return (
            <div className="live__row" key={b.roomId}>
              <div className="live__vs">
                <div className="live__players">
                  <span className={a.hidden ? 'live__hidden' : undefined}>{a.text}</span>
                  <span className="live__x">vs</span>
                  <span className={z.hidden ? 'live__hidden' : undefined}>{z.text}</span>
                </div>
                <div className="live__sub">
                  {stake && <span className="live__tag live__tag--stake">{stake} {CURRENCY}</span>}
                  {b.tournament && (
                    <span className="live__tag live__tag--tour">🏆 {b.tournament.name}</span>
                  )}
                  <span>Turn {b.turn}</span>
                  {b.spectators > 0 && <span>· 👁 {b.spectators}</span>}
                </div>
              </div>
              <Link className="btn btn--dark live__watch" to={`/watch/${b.roomId}`}>
                Watch
              </Link>
            </div>
          )
        })}
      </div>
    </div>
  )
}
