import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  api,
  formatEth,
  formatSignedEth,
  fromUnix,
  type MatchRow,
  type MeStats,
  type Team,
} from '../lib/api'
import { useSession } from '../lib/session'
import { Banner, Empty, Spinner } from '../components/ui'
import { CURRENCY, EXPLORER } from '../config'
import '../styles/profile.css'
import { Address } from '../components/Address'

export default function Profile() {
  const { me, signedIn, address, isConnected, refresh } = useSession()

  const [teams, setTeams] = useState<Team[]>([])
  const [matches, setMatches] = useState<MatchRow[] | null>(null)
  const [stats, setStats] = useState<MeStats | null>(null)
  const [privacyBusy, setPrivacyBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    if (!signedIn) return
    const [t, m, s] = await Promise.allSettled([
      api.get<Team[]>('/api/teams'),
      api.get<MatchRow[]>('/api/me/battles'),
      api.get<MeStats>('/api/me/stats'),
    ])
    if (t.status === 'fulfilled') setTeams(t.value)
    setMatches(m.status === 'fulfilled' ? m.value : [])
    if (s.status === 'fulfilled') setStats(s.value)
  }, [signedIn])

  useEffect(() => {
    void load()
  }, [load])

  const togglePrivacy = async () => {
    if (!me) return
    setError(null)
    setNotice(null)
    setPrivacyBusy(true)
    try {
      await api.post('/api/me/privacy', { hideWallet: !me.hideWallet })
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPrivacyBusy(false)
    }
  }

  // The wallet address for a connected user; the session address otherwise
  // (e.g. a dev session, which has no wagmi connection). Both are the same
  // account — this is just whichever source is populated.
  const acct = address ?? me?.address ?? ''

  const copy = async () => {
    if (!acct) return
    await navigator.clipboard.writeText(acct)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (!isConnected && !signedIn) {
    return (
      <section className="section">
        <div className="wrap">
          <Empty
            title="Connect a wallet"
            body="Your profile, record and teams are tied to your address."
          />
        </div>
      </section>
    )
  }

  if (!signedIn || !me) {
    return (
      <section className="section">
        <div className="wrap">
          <Empty
            title="Sign in to see your profile"
            body="One signature proves the wallet is yours."
            action={
              <Link className="btn btn--dark" to="/play">
                Go to Play
              </Link>
            }
          />
        </div>
      </section>
    )
  }

  const played = stats?.played ?? me.wins + me.losses + me.draws
  const decided = me.wins + me.losses
  const winrate =
    stats?.winrate != null
      ? Math.round(stats.winrate * 100)
      : decided > 0
        ? Math.round((me.wins / decided) * 100)
        : null

  const netWei = stats?.netWei ?? '0'
  const stakedWei = stats?.stakedWei ?? '0'
  const pnlSign = (() => {
    try {
      const v = BigInt(netWei)
      return v > 0n ? 'up' : v < 0n ? 'down' : 'flat'
    } catch {
      return 'flat'
    }
  })()

  return (
    <section className="section profile">
      <div className="wrap">
        <div className="section-head section-head--center">
          <div>
            <div className="eyebrow">Profile</div>
            <h2>{me.name ?? 'Trainer'}</h2>
            <p className="lede">Your record, your teams, and every match you have finished.</p>
          </div>
        </div>

        {error && <Banner kind="error">{error}</Banner>}
        {notice && <Banner kind="info">{notice}</Banner>}

        {/* -------- headline stats -------- */}
        <div className="profile__hero">
          <StatTile label="Games played" value={String(played)} />
          <StatTile
            label="Tournaments won"
            value={String(stats?.tournamentWins ?? 0)}
            champion
            title="Tournament titles won"
          />
          <StatTile label="Won" value={String(me.wins)} tone="up" />
          <StatTile label="Lost" value={String(me.losses)} tone="down" />
          <StatTile label="Win rate" value={winrate === null ? '—' : `${winrate}%`} />
          <StatTile
            label={`P/L (${CURRENCY})`}
            value={formatSignedEth(netWei)}
            tone={pnlSign === 'up' ? 'up' : pnlSign === 'down' ? 'down' : undefined}
            title="Realised profit or loss from settled wagers"
          />
          <StatTile
            label={`Staked (${CURRENCY})`}
            value={stakedWei === '0' ? '0' : formatEth(stakedWei)}
            title="Total value staked across settled wagers"
          />
        </div>

        <div className="profile__grid">
          <div className="profile__col">
            {/* -------- identity -------- */}
            <div className="card profile__panel">
              <h3 className="profile__h3">Trainer name</h3>
              <div className="profile__nameval">{me.name ?? 'Trainer'}</div>
              <p className="profile__hint">
                Your username is permanent. It is shown on the leaderboard and to your opponents.
              </p>

              <div className="profile__addr">
                <span className="eyebrow">Address</span>
                <code>{acct}</code>
                <div className="profile__addr-actions">
                  <button className="mini-btn" onClick={() => void copy()}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <a
                    className="mini-btn"
                    href={`${EXPLORER}/address/${acct}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Explorer ↗
                  </a>
                </div>
              </div>

              {/* -------- privacy -------- */}
              <div className="profile__privacy">
                <button
                  type="button"
                  role="switch"
                  aria-checked={me.hideWallet}
                  className={`switch${me.hideWallet ? ' switch--on' : ''}`}
                  onClick={() => void togglePrivacy()}
                  disabled={privacyBusy}
                >
                  <span className="switch__track">
                    <span className="switch__thumb" />
                  </span>
                  <span className="switch__text">
                    <span className="switch__label">Hide my wallet</span>
                    <span className="switch__desc">
                      {me.hideWallet
                        ? 'Other players see only your name — your address is hidden on the leaderboard, wager board and in match history.'
                        : 'Your address is visible to other players on the leaderboard and wager board.'}
                    </span>
                  </span>
                </button>
              </div>
            </div>

            {/* -------- teams -------- */}
            <div className="card profile__panel">
              <div className="profile__panelhead">
                <h3 className="profile__h3">Teams</h3>
                <Link className="mini-btn" to="/play">
                  Manage
                </Link>
              </div>
              {teams.length === 0 ? (
                <p className="profile__hint">No teams yet.</p>
              ) : (
                <ul className="profile__teams">
                  {teams.map((t) => (
                    <li key={t.id}>
                      <span>{t.name}</span>
                      <span className="profile__muted">
                        {fromUnix(t.updated_at).toLocaleDateString(undefined, {
                          day: 'numeric',
                          month: 'short',
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* -------- battle history -------- */}
          <div className="profile__col">
            <div className="card profile__panel">
              <div className="profile__panelhead">
                <h3 className="profile__h3">Battle history</h3>
                {stats && stats.paidGames > 0 && (
                  <span className="profile__muted">
                    {stats.paidGames} paid {stats.paidGames === 1 ? 'match' : 'matches'}
                  </span>
                )}
              </div>

              {matches === null ? (
                <Spinner label="Loading…" />
              ) : matches.length === 0 ? (
                <p className="profile__hint">Nothing finished yet. Play a match and it shows here.</p>
              ) : (
                <ul className="profile__matches">
                  {matches.map((m) => {
                    const paid = m.stakeWei !== '0'
                    let netTone = 'flat'
                    try {
                      const v = BigInt(m.net)
                      netTone = v > 0n ? 'up' : v < 0n ? 'down' : 'flat'
                    } catch {
                      /* keep flat */
                    }
                    return (
                      <li key={m.id} className="match">
                        <span className={`pill pill--${m.result}`}>{m.result}</span>
                        <span className="match__opp">
                          {m.practice ? (
                            <span className="match__practice">Practice</span>
                          ) : m.opponentHidden ? (
                            <span className="match__hidden">
                              {m.opponentName ?? 'Hidden trainer'}
                            </span>
                          ) : m.opponentName ? (
                            <span className="match__name">{m.opponentName}</span>
                          ) : m.opponent ? (
                            <Address value={m.opponent} />
                          ) : (
                            <span className="match__hidden">Unknown</span>
                          )}
                        </span>
                        <span className="match__stake">
                          {paid ? (
                            <span className={`match__net match__net--${netTone}`}>
                              {formatSignedEth(m.net)} {CURRENCY}
                            </span>
                          ) : (
                            <span className="match__free">Free</span>
                          )}
                        </span>
                        <Link className="mini-btn match__replay" to={`/replay/${m.id}`}>
                          Replay
                        </Link>
                        <span className="profile__muted match__date">
                          {fromUnix(m.endedAt).toLocaleDateString(undefined, {
                            day: 'numeric',
                            month: 'short',
                          })}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/** One headline number in the profile stat band. */
function StatTile({
  label,
  value,
  tone,
  title,
  champion,
}: {
  label: string
  value: string
  tone?: 'up' | 'down'
  title?: string
  /** A special gold trophy tile, for the tournament-titles count. */
  champion?: boolean
}) {
  return (
    <div className={`profile__tile${champion ? ' profile__tile--champion' : ''}`} title={title}>
      <div className={`profile__tile-value${tone ? ` profile__tile-value--${tone}` : ''}`}>
        {champion && <span className="profile__tile-trophy" aria-hidden="true">🏆</span>}
        {value}
      </div>
      <div className="profile__tile-label">{label}</div>
    </div>
  )
}
