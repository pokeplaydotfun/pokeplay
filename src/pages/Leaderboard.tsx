import { useEffect, useState } from 'react'
import { api, formatEth, formatSignedEth, type LeaderRow, type Champion } from '../lib/api'
import { CURRENCY, SLABS_ENABLED } from '../config'
import { getLeaderboard, type LeaderRow as CardLeaderRow } from '../slabs/client'
import { Address } from '../components/Address'
import { useSession } from '../lib/session'
import { Banner, Empty, Spinner, Stat } from '../components/ui'
import '../styles/leaderboard.css'

type Stats = {
  battles: number
  players: number
  openWagers: number
  liveBattles: number
  turnSeconds: number
  stakedWei: string
}

type Board = { players: LeaderRow[]; champions: Champion[] }

/** Only the podium gets a colour; everything below is plain ink. */
const MEDAL = ['gold', 'silver', 'bronze'] as const

export default function Leaderboard() {
  const { me } = useSession()

  const [rows, setRows] = useState<LeaderRow[] | null>(null)
  const [champions, setChampions] = useState<Champion[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Which board is showing. Only relevant in the merged (Slabs-on) build.
  const [board, setBoard] = useState<'battles' | 'cards'>('battles')
  const [cardRows, setCardRows] = useState<CardLeaderRow[] | null>(null)

  useEffect(() => {
    let cancelled = false

    Promise.all([api.get<Board>('/api/leaderboard'), api.get<Stats>('/api/stats')])
      .then(([b, s]) => {
        if (cancelled) return
        setRows(b.players)
        setChampions(b.champions ?? [])
        setStats(s)
      })
      .catch((e: Error) => {
        if (cancelled) return
        setError(e.message)
        setRows([])
      })

    return () => {
      cancelled = true
    }
  }, [])

  // Load the cards board lazily, the first time it's opened.
  useEffect(() => {
    if (!SLABS_ENABLED || board !== 'cards' || cardRows !== null) return
    let cancelled = false
    void getLeaderboard('value', 50)
      .then((res) => !cancelled && setCardRows(res.rows))
      .catch(() => !cancelled && setCardRows([]))
    return () => {
      cancelled = true
    }
  }, [board, cardRows])

  const mine = me?.address.toLowerCase()
  const usd = (micro: string) => {
    try {
      return `$${(Number(BigInt(micro)) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    } catch {
      return '$0'
    }
  }

  return (
    <section className="section">
      <div className="wrap">
        <div className="section-head section-head--center">
          <div>
            <h2>Leaderboard</h2>
          </div>
        </div>

        {/* Swap between the wager (Battles) board and the gacha (Cards) board.
            Only shown in the merged build; a wager-only launch has one board. */}
        {SLABS_ENABLED && (
          <div className="lb__toggle" role="tablist" aria-label="Leaderboard type">
            <button
              role="tab"
              aria-selected={board === 'battles'}
              className={`lb__toggle-btn${board === 'battles' ? ' lb__toggle-btn--on' : ''}`}
              onClick={() => setBoard('battles')}
            >
              Battles
            </button>
            <button
              role="tab"
              aria-selected={board === 'cards'}
              className={`lb__toggle-btn${board === 'cards' ? ' lb__toggle-btn--on' : ''}`}
              onClick={() => setBoard('cards')}
            >
              Cards
            </button>
          </div>
        )}

        {error && <Banner kind="error">Could not load the leaderboard: {error}</Banner>}

        {board === 'battles' && (
        <>
        {/* Real counts from the server, or an honest dash while they load. */}
        <div className="lb__stats card">
          <Stat value={stats?.battles ?? null} label="Battles played" />
          {/* Total ETH staked across contested wagers + tournament pools. */}
          <div>
            <div className={`stat__value${stats ? '' : ' placeholder'}`}>
              {stats ? `${formatEth(stats.stakedWei)} ${CURRENCY}` : '—'}
            </div>
            <div className="stat__label">Staked</div>
          </div>
          <Stat value={stats?.liveBattles ?? null} label="Live right now" />
        </div>

        {/* ---- Champions: most tournament titles won ---- */}
        {champions.length > 0 && (
          <div className="champions">
            <div className="champions__head">
              <span className="champions__trophy" aria-hidden="true">🏆</span>
              <h3>Champions</h3>
              <span className="champions__sub">most tournament titles</span>
            </div>
            <ol className="champions__list">
              {champions.map((c, i) => {
                const isMe =
                  (mine !== undefined && c.address !== '' && c.address.toLowerCase() === mine) ||
                  (Boolean(c.hidden) && me?.name != null && c.name === me.name)
                const medal = i < 3 ? MEDAL[i] : null
                return (
                  <li
                    key={c.address || `champ-${i}`}
                    className={`champions__item${medal ? ` champions__item--${medal}` : ''}${isMe ? ' champions__item--me' : ''}`}
                  >
                    <span className={`champions__rank${medal ? ` champions__rank--${medal}` : ''}`}>{i + 1}</span>
                    <span className="champions__name">
                      {c.hidden ? (
                        c.name ?? 'Hidden trainer'
                      ) : c.name ? (
                        c.name
                      ) : (
                        <Address value={c.address} />
                      )}
                      {isMe && <span className="lb__me-tag">you</span>}
                    </span>
                    <span className="champions__count">
                      {c.wins}
                      <span className="champions__count-label">{c.wins === 1 ? 'title' : 'titles'}</span>
                    </span>
                  </li>
                )
              })}
            </ol>
          </div>
        )}

        {rows === null ? (
          <Spinner label="Loading the leaderboard…" />
        ) : rows.length === 0 ? (
          <Empty
            title="No battles yet"
            body="Nobody has finished a match, so there is nothing to rank. The first result puts a name here."
          />
        ) : (
          <div className="lb__scroll">
            <table className="lb">
              <thead>
                <tr>
                  <th className="lb__rank-h">#</th>
                  <th>Player</th>
                  <th className="lb__num">W</th>
                  <th className="lb__num">L</th>
                  <th className="lb__num lb__mid">Played</th>
                  <th className="lb__num lb__mid">Win rate</th>
                  <th className="lb__num lb__mid" title="Realised profit or loss from settled wagers">
                    P/L ({CURRENCY})
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const medal = i < 3 ? MEDAL[i] : null
                  // A hidden player has no address to match on, so fall back to
                  // the (unique) name to still tag your own row as "you".
                  const isMe =
                    (mine !== undefined && r.address !== '' && r.address.toLowerCase() === mine) ||
                    (Boolean(r.hidden) && me?.name != null && r.name === me.name)

                  return (
                    <tr
                      key={r.address || `hidden-${i}`}
                      className={`${medal ? `lb__row--${medal}` : ''}${isMe ? ' lb__row--me' : ''}`}
                    >
                      <td className={`lb__rank${medal ? ` lb__rank--${medal}` : ''}`}>{i + 1}</td>
                      <td className="lb__player">
                        {r.hidden ? (
                          <span className="lb__name lb__name--hidden">
                            {r.name ?? 'Hidden trainer'}
                          </span>
                        ) : r.name ? (
                          <>
                            <span className="lb__name">{r.name}</span>
                            <Address value={r.address} className="lb__addr" />
                          </>
                        ) : (
                          <Address value={r.address} className="lb__name" />
                        )}
                        {isMe && <span className="lb__me-tag">you</span>}
                      </td>
                      <td className="lb__num lb__wins">{r.wins}</td>
                      <td className="lb__num">{r.losses}</td>
                      <td className="lb__num lb__mid">{r.played}</td>
                      <td className="lb__num lb__mid lb__rate">{Math.round(r.winrate * 100)}%</td>
                      <td
                        className={`lb__num lb__mid lb__pnl${
                          BigInt(r.netWei || '0') > 0n
                            ? ' lb__pnl--up'
                            : BigInt(r.netWei || '0') < 0n
                              ? ' lb__pnl--down'
                              : ''
                        }`}
                      >
                        {formatSignedEth(r.netWei)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        </>
        )}

        {board === 'cards' && (
          cardRows === null ? (
            <Spinner label="Loading the leaderboard…" />
          ) : cardRows.length === 0 ? (
            <Empty
              title="No packs opened yet"
              body="Nobody has opened a pack, so there is nothing to rank. The first pull puts a name here."
            />
          ) : (
            <div className="lb__scroll">
              <table className="lb">
                <thead>
                  <tr>
                    <th className="lb__rank-h">#</th>
                    <th>Player</th>
                    <th className="lb__num lb__mid">Packs</th>
                    <th className="lb__num" title="Total insured value pulled">Total value</th>
                  </tr>
                </thead>
                <tbody>
                  {cardRows.map((r, i) => {
                    const medal = i < 3 ? MEDAL[i] : null
                    const isMe = mine !== undefined && r.address.toLowerCase() === mine
                    return (
                      <tr
                        key={r.address || `card-${i}`}
                        className={`${medal ? `lb__row--${medal}` : ''}${isMe ? ' lb__row--me' : ''}`}
                      >
                        <td className={`lb__rank${medal ? ` lb__rank--${medal}` : ''}`}>{i + 1}</td>
                        <td className="lb__player">
                          <Address value={r.address} className="lb__name" />
                          {isMe && <span className="lb__me-tag">you</span>}
                        </td>
                        <td className="lb__num lb__mid">{r.packsOpened}</td>
                        <td className="lb__num lb__wins">{usd(r.totalValueUsd)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </section>
  )
}
