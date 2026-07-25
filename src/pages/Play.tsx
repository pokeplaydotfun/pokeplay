import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, fromUnix, loadPokedex, titleCase, type Pokedex, type Species, type Team } from '../lib/api'
import { useSession } from '../lib/session'
import { ApiDown, Banner, Empty, Spinner, Sprite, TypeBadge } from '../components/ui'
import { TeamBuilder, TEAM_SIZE } from '../components/TeamBuilder'
import { BattleView } from './Battle'
import { WagerBoard } from './Wagers'
import { UnclaimedPots } from '../components/UnclaimedPots'
import { QuickMatch } from '../components/QuickMatch'
import '../styles/play.css'

type Opponent = {
  id: string
  name: string
  blurb: string
  difficulty: 'easy' | 'normal'
  team: number[]
}

type Mode =
  | { kind: 'lobby' }
  | { kind: 'build'; team: Team | null }
  | { kind: 'battle'; roomId: string }

/* ------------------------------------------------------------------ */
/* team panel                                                          */
/* ------------------------------------------------------------------ */

function TeamCard({
  team, dex, selected, onSelect, onEdit,
}: {
  team: Team
  dex: Pokedex
  selected: boolean
  onSelect: () => void
  onEdit: () => void
}) {
  const byId = useMemo(() => new Map(dex.species.map((s) => [s.id, s] as const)), [dex])

  return (
    <div className={`ptm${selected ? ' ptm--on' : ''}`}>
      <button className="ptm__pick" onClick={onSelect} aria-pressed={selected}>
        <span className="ptm__head">
          <span className="ptm__name">{team.name}</span>
          {selected && <span className="ptm__badge">Active</span>}
        </span>
        <span className="ptm__party">
          {Array.from({ length: TEAM_SIZE }, (_, i) => {
            const sp = team.slots[i] ? byId.get(team.slots[i].speciesId) : undefined
            return (
              <span className="ptm__mon" key={i} title={sp ? titleCase(sp.name) : 'Empty'}>
                {sp ? <Sprite src={sp.sprites.front} alt={titleCase(sp.name)} size={40} /> : null}
              </span>
            )
          })}
        </span>
        <span className="ptm__meta">
          Updated {fromUnix(team.updated_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
        </span>
      </button>
      <button className="mini-btn ptm__edit" onClick={onEdit}>
        Edit
      </button>
    </div>
  )
}

/** The selected team's roster, so you can see what you are bringing. */
function Roster({ team, dex }: { team: Team; dex: Pokedex }) {
  const byId = useMemo(() => new Map(dex.species.map((s) => [s.id, s] as const)), [dex])

  return (
    <ul className="roster">
      {team.slots.map((slot, i) => {
        const sp = byId.get(slot.speciesId) as Species | undefined
        if (!sp) return null
        return (
          <li className="roster__row" key={i}>
            <Sprite src={sp.sprites.front} alt={titleCase(sp.name)} size={44} />
            <div className="roster__body">
              <div className="roster__name">
                {titleCase(sp.name)}
                <span className="roster__types">
                  {sp.types.map((t) => (
                    <TypeBadge key={t} type={t} small />
                  ))}
                </span>
              </div>
              <div className="roster__moves">
                {slot.moves.map((m) => titleCase(m)).join(' · ')}
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Practice against the AI. This is the only path a lone visitor has — without
 * it the first person to arrive posts a wager and waits for nobody.
 */
function PracticePanel({
  dex, teamId, signedIn, onStart,
}: {
  dex: Pokedex
  teamId: number | null
  signedIn: boolean
  onStart: (roomId: string) => void
}) {
  const [opponents, setOpponents] = useState<Opponent[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const byId = useMemo(() => new Map(dex.species.map((s) => [s.id, s] as const)), [dex])

  useEffect(() => {
    api.get<Opponent[]>('/api/practice/opponents').then(setOpponents).catch(() => setOpponents([]))
  }, [])

  const start = async (o: Opponent) => {
    setError(null)
    setBusy(o.id)
    try {
      const { roomId } = await api.post<{ roomId: string }>('/api/practice', {
        teamId,
        opponentId: o.id,
      })
      onStart(roomId)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (!opponents?.length) return null

  return (
    <div className="card play__panel">
      <div className="play__panel-head play__panel-head--center">
        <h3>Practice</h3>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      <ul className="opps">
        {opponents.map((o) => (
          <li className="opp" key={o.id}>
            <div className="opp__body">
              <div className="opp__head">
                <span className="opp__name">{o.name}</span>
                <span className={`opp__diff opp__diff--${o.difficulty}`}>{o.difficulty}</span>
              </div>
              <div className="opp__blurb">{o.blurb}</div>
              <div className="opp__party">
                {o.team.map((id, i) => {
                  const sp = byId.get(id)
                  return sp ? (
                    <Sprite key={i} src={sp.sprites.front} alt={titleCase(sp.name)} size={30} />
                  ) : null
                })}
              </div>
            </div>
            <button
              className="btn btn--dark opp__go"
              disabled={!signedIn || teamId === null || busy !== null}
              onClick={() => void start(o)}
              title={
                !signedIn ? 'Sign in first' : teamId === null ? 'Build a team first' : undefined
              }
            >
              {busy === o.id ? 'Starting…' : 'Battle'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* page                                                                */
/* ------------------------------------------------------------------ */

const ACTIVE_TEAM_KEY = 'slabshowdown.activeTeam'

export default function Play() {
  const { roomId: routeRoom } = useParams()
  const navigate = useNavigate()
  const { signedIn, signIn, signingIn, isConnected } = useSession()

  const [dex, setDex] = useState<Pokedex | null>(null)
  const [dexError, setDexError] = useState<string | null>(null)

  const [teams, setTeams] = useState<Team[]>([])
  const [teamsLoading, setTeamsLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<number | null>(() => {
    const v = localStorage.getItem(ACTIVE_TEAM_KEY)
    return v ? Number(v) : null
  })

  const [mode, setMode] = useState<Mode>(
    routeRoom ? { kind: 'battle', roomId: routeRoom } : { kind: 'lobby' },
  )

  /* ---------------- data ---------------- */

  useEffect(() => {
    let live = true
    loadPokedex()
      .then((d) => live && setDex(d))
      .catch((e: unknown) => live && setDexError((e as Error).message))
    return () => {
      live = false
    }
  }, [])

  const refreshTeams = useCallback(async () => {
    if (!signedIn) return setTeams([])
    setTeamsLoading(true)
    setListError(null)
    try {
      const rows = await api.get<Team[]>('/api/teams')
      setTeams(rows)
      setActiveId((prev) => (prev !== null && rows.some((t) => t.id === prev) ? prev : rows[0]?.id ?? null))
    } catch (e) {
      setListError((e as Error).message)
    } finally {
      setTeamsLoading(false)
    }
  }, [signedIn])

  useEffect(() => {
    void refreshTeams()
  }, [refreshTeams])

  useEffect(() => {
    if (activeId !== null) localStorage.setItem(ACTIVE_TEAM_KEY, String(activeId))
  }, [activeId])

  /* ---------------- battle resumption ---------------- */

  // A battle in progress always wins over the lobby — a wagered match should
  // never be lost to a refresh or a stray navigation.
  useEffect(() => {
    if (!signedIn || routeRoom) return
    let live = true
    api
      .get<{ roomId: string | null }>('/api/battle/current')
      .then((r) => {
        if (live && r.roomId) setMode({ kind: 'battle', roomId: r.roomId })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [signedIn, routeRoom])

  // Keep the URL in step so a battle can be linked to and survives a reload.
  useEffect(() => {
    if (mode.kind === 'battle' && routeRoom !== mode.roomId) {
      navigate(`/play/${mode.roomId}`, { replace: true })
    }
    if (mode.kind !== 'battle' && routeRoom) {
      navigate('/play', { replace: true })
    }
  }, [mode, routeRoom, navigate])

  const leaveBattle = useCallback(() => {
    setMode({ kind: 'lobby' })
    void refreshTeams()
  }, [refreshTeams])

  /* ---------------- render ---------------- */

  if (mode.kind === 'battle') {
    return <BattleView roomId={mode.roomId} onLeave={leaveBattle} />
  }

  if (dexError) {
    return (
      <section className="section">
        <div className="wrap">
          <ApiDown what="the Pokédex" error={dexError} />
        </div>
      </section>
    )
  }

  if (!dex) {
    return (
      <section className="section">
        <div className="wrap">
          <Spinner label="Loading the Pokédex…" />
        </div>
      </section>
    )
  }

  if (mode.kind === 'build') {
    return (
      <section className="section play">
        <div className="wrap">
          <div className="play__crumb">
            <button className="mini-btn" onClick={() => setMode({ kind: 'lobby' })}>
              ← Back to the lobby
            </button>
          </div>
          <TeamBuilder
            dex={dex}
            team={mode.team}
            signedIn={signedIn}
            isConnected={isConnected}
            signingIn={signingIn}
            onSignIn={() => void signIn()}
            onSaved={() => {
              setMode({ kind: 'lobby' })
              void refreshTeams()
            }}
            onCancel={() => setMode({ kind: 'lobby' })}
          />
        </div>
      </section>
    )
  }

  const active = teams.find((t) => t.id === activeId) ?? null

  return (
    <section className="section play">
      <div className="wrap">
        <div className="section-head section-head--center">
          <div>
            <h2>Build a team and play a match</h2>
            <p className="lede">
              Build six from the original 151, then post a match or accept one from the board.
              The battle starts the moment someone accepts it.
            </p>
          </div>
        </div>

        {/* Money you have won but not collected comes before anything else. */}
        <UnclaimedPots signedIn={signedIn} />

        {/* Connecting is handled by the header; only signing in is prompted here. */}
        {!signedIn && isConnected && (
          <div className="card play__gate">
            <div>
              <div className="play__gate-title">Sign in to play</div>
              <p className="play__gate-body">
                One signature proves the wallet is yours. It costs nothing, sends no
                transaction, and covers teams, wagers and battles for the next week.
              </p>
            </div>
            <button className="btn btn--dark" onClick={() => void signIn()} disabled={signingIn}>
              {signingIn ? 'Check your wallet…' : 'Sign in'}
            </button>
          </div>
        )}

        {/* 1. Your team — the prerequisite, full width across the top. */}
        <div className="card play__panel play__team">
          <div className="play__panel-head">
            <h3>Your team</h3>
            <button className="mini-btn" onClick={() => setMode({ kind: 'build', team: null })}>
              + New
            </button>
          </div>

          {listError && <Banner kind="error">{listError}</Banner>}

          {!signedIn ? (
            <Empty
              title="Your teams"
              body="Connect your wallet and your teams are saved automatically."
              action={
                <button
                  className="btn btn--ghost"
                  onClick={() => setMode({ kind: 'build', team: null })}
                >
                  Build a team
                </button>
              }
            />
          ) : teamsLoading ? (
            <Spinner label="Loading your teams…" />
          ) : teams.length === 0 ? (
            <Empty
              title="No teams yet"
              body="Build your first team of six."
              action={
                <button
                  className="btn btn--dark"
                  onClick={() => setMode({ kind: 'build', team: null })}
                >
                  Build a team
                </button>
              }
            />
          ) : (
            <div className="play__team-body">
              <div className="play__teams">
                {teams.map((t) => (
                  <TeamCard
                    key={t.id}
                    team={t}
                    dex={dex}
                    selected={t.id === activeId}
                    onSelect={() => setActiveId(t.id)}
                    onEdit={() => setMode({ kind: 'build', team: t })}
                  />
                ))}
              </div>

              {active && (
                <div className="play__roster">
                  <div className="play__roster-head">Bringing</div>
                  <Roster team={active} dex={dex} />
                </div>
              )}
            </div>
          )}
        </div>

        {/* 2. Ways to play — practice on the left; quick match + wagers on the right. */}
        <div className="play__modes">
          <div className="play__modes-side">
            <PracticePanel
              dex={dex}
              teamId={activeId}
              signedIn={signedIn}
              onStart={(id) => setMode({ kind: 'battle', roomId: id })}
            />
          </div>

          <div className="play__modes-main">
            <QuickMatch
              teamId={activeId}
              signedIn={signedIn}
              onStart={(id) => setMode({ kind: 'battle', roomId: id })}
            />

            <div className="card play__panel play__wagers">
              <div className="play__panel-head play__panel-head--center">
                <h3>Wagers</h3>
              </div>
              <WagerBoard
                embedded
                teamId={activeId}
                onBuildTeam={() => setMode({ kind: 'build', team: null })}
                onEnterBattle={(id) => setMode({ kind: 'battle', roomId: id })}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
