import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { formatEther } from 'viem'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import {
  api,
  formatStart,
  formatUsd,
  usdCentsToEth,
  formatEthAmount,
  formatUsdg,
  usdCentsToUsdg,
  entryLabel,
  type Team,
} from '../lib/api'
import { useSession } from '../lib/session'
import { CURRENCY } from '../config'
import { describeTxError, isUserRejection } from '../lib/escrow'
import { poolAbi, poolAddress, poolReady, TournamentStatus } from '../lib/tournamentPool'
import { Address } from '../components/Address'
import { Banner, Spinner } from '../components/ui'
import '../styles/tournaments.css'
// The prize and refund panels use the shared claim/withdraw styling.
import '../styles/claim.css'

type MatchView = {
  id: number
  round: number
  slot: number
  p0: string | null
  p1: string | null
  p0Name: string | null
  p1Name: string | null
  p0Hidden: boolean
  p1Hidden: boolean
  p0Filled: boolean
  p1Filled: boolean
  p0Won: boolean
  p1Won: boolean
  decided: boolean
  winner: string | null
  status: 'pending' | 'ready' | 'playing' | 'done'
  battleId: string | null
}

type View = {
  id: number
  name: string
  entryFeeWei: string
  onchainId: string | null
  pool: string | null
  maxPlayers: number
  status: 'open' | 'running' | 'finished' | 'cancelled'
  startAt: number | null
  // Masked for a hidden champion (null to everyone but the champion themselves).
  winner: string | null
  winnerName: string | null
  winnerHidden: boolean
  // A champion exists at all — use this, not `winner`, for winner-exists logic.
  hasWinner: boolean
  // The real champion wallet, sent to the admin only, for the manual payout.
  winnerPayout: string | null
  prizeUsdCents: number | null
  ethUsd: number | null
  players: { address: string | null; name: string | null; hidden: boolean; seed: number }[]
  rounds: number
  matches: MatchView[]
  you: { entered: boolean; isAdmin: boolean; playableMatchId: number | null } | null
}

type TournamentSettlement = { kind: 'win'; tournamentId: string; winner: `0x${string}`; signature: `0x${string}` }

const roundName = (round: number, total: number) => {
  const fromEnd = total - round
  if (fromEnd === 0) return 'Final'
  if (fromEnd === 1) return 'Semi-finals'
  if (fromEnd === 2) return 'Quarter-finals'
  return `Round ${round}`
}

/** "in 3h 12m" / "in 8m" / "in <1m" for a unix start time. */
function untilLabel(unixSec: number): string {
  const s = unixSec - Math.floor(Date.now() / 1000)
  if (s <= 0) return 'now'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `in ${h}h ${m}m`
  if (m > 0) return `in ${m}m`
  return 'in <1m'
}

/**
 * The scheduled-start card: a live countdown to the moment the bracket is drawn,
 * plus the exact date and time. Ticks every second while it's still ahead.
 */
function StartClock({ startAt }: { startAt: number }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])
  const left = Math.max(0, startAt - now)
  const pad = (n: number) => String(n).padStart(2, '0')
  const d = Math.floor(left / 86400)
  const h = Math.floor((left % 86400) / 3600)
  const m = Math.floor((left % 3600) / 60)
  const s = left % 60
  const countdown = left <= 0 ? 'Starting…' : d > 0 ? `${d}d ${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}:${pad(s)}`
  return (
    <div className="tn__clock">
      <div className="tn__clock-label">Starts in</div>
      <div className="tn__clock-count">{countdown}</div>
      <div className="tn__clock-when">🗓 {formatStart(startAt)}</div>
    </div>
  )
}

/**
 * The prize-pool headline: the entry pot (exact ETH) plus any hand-paid prize
 * (set in dollars). Quoted in USDG, with the exact ETH underneath.
 *
 * The two lines used to be the other way round — ETH large, "~$" small. Players think in
 * dollars and the rest of the site prices in USDG, so USDG leads. The ETH line is NOT
 * decoration and must never be dropped: it is what the pool actually holds and what the
 * wallet will ask for. With no live rate there is no USDG line at all, and ETH takes the
 * headline back rather than a converted number being invented.
 *
 * Renders nothing for a free tournament with no added prize.
 */
function PrizePool({ view }: { view: View }) {
  const fee = BigInt(view.entryFeeWei)
  const players = view.players.length
  const entryPotEth = Number(formatEther(fee * BigInt(players)))
  const prizeUsd = (view.prizeUsdCents ?? 0) / 100
  const rate = view.ethUsd
  const prizeEth = view.prizeUsdCents ? usdCentsToEth(view.prizeUsdCents, rate) : 0
  const hasEntry = fee > 0n && players > 0
  const hasPrize = (view.prizeUsdCents ?? 0) > 0
  if (!hasEntry && !hasPrize) return null

  // A prize is a dollar figure, so folding it into ETH needs the live rate;
  // without one we can't add it to the ETH total, so show it separately.
  const rateMissing = hasPrize && rate == null
  const approx = hasPrize && !rateMissing
  const totalEth = entryPotEth + (prizeEth ?? 0)
  const totalUsd = (rate ? entryPotEth * rate : 0) + prizeUsd
  const ethLine = rateMissing
    ? `${formatEthAmount(entryPotEth)} ${CURRENCY} + ${formatUsd(view.prizeUsdCents ?? 0)}`
    : `${approx ? '≈ ' : ''}${formatEthAmount(totalEth)} ${CURRENCY}`

  return (
    <div className="tn__pool">
      <div className="tn__pool-label">Prize pool</div>
      {rate != null ? (
        <>
          <div className="tn__pool-usdg">{formatUsdg(totalUsd)}</div>
          <div className="tn__pool-eth-sub">{ethLine}</div>
        </>
      ) : (
        /* No rate, no conversion. The pool holds ETH; that is what gets shown. */
        <div className="tn__pool-usdg">{ethLine}</div>
      )}
      {hasEntry && hasPrize && (
        <div className="tn__pool-break">
          {formatEthAmount(entryPotEth)} {CURRENCY} entry pot + {usdCentsToUsdg(view.prizeUsdCents ?? 0)} added prize
        </div>
      )}
    </div>
  )
}

/**
 * Admin-only: the champion's wallet + the dollar prize to send by hand. Only
 * for a finished tournament that actually carries an added prize.
 */
function PrizePayout({ view }: { view: View }) {
  if (view.status !== 'finished' || !view.winnerPayout || !(view.prizeUsdCents ?? 0)) return null
  const prizeEth = usdCentsToEth(view.prizeUsdCents!, view.ethUsd)
  return (
    <div className="tn__payout">
      <div className="tn__payout-head">💸 Pay the prize by hand</div>
      <p className="tn__payout-body">
        Send <strong>{formatUsd(view.prizeUsdCents!)}</strong>
        {prizeEth != null ? ` (≈ ${formatEthAmount(prizeEth)} ${CURRENCY} now)` : ''} to the champion.
        {BigInt(view.entryFeeWei) > 0n
          ? ' The entry pot is settled on chain automatically — this added prize is the only part you pay yourself.'
          : ' This is a free tournament, so this prize is the whole reward.'}
      </p>
      <div className="tn__payout-row">
        <span>Winner{view.winnerName ? ` · ${view.winnerName}` : ''}</span>
        <Address value={view.winnerPayout} />
      </div>
    </div>
  )
}

export default function Tournament() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { signedIn } = useSession()
  const { address } = useAccount()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()

  const [view, setView] = useState<View | null>(null)
  const [teams, setTeams] = useState<Team[]>([])
  const [teamId, setTeamId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Bumped after a transaction that changes what the pool owes us, so the refund
  // panel re-reads the chain instead of waiting for something else to change.
  const [poolEpoch, setPoolEpoch] = useState(0)

  const load = useCallback(async () => {
    try {
      setView(await api.get<View>(`/api/tournaments/${id}`))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [id])

  useEffect(() => {
    void load()
    // The bracket changes as other people finish their matches.
    const t = setInterval(() => void load(), 8000)
    return () => clearInterval(t)
  }, [load, signedIn])

  useEffect(() => {
    if (!signedIn) return setTeams([])
    api.get<Team[]>('/api/teams').then((t) => {
      setTeams(t)
      setTeamId((cur) => cur ?? t[0]?.id ?? null)
    }).catch(() => setTeams([]))
  }, [signedIn])

  const act = async (path: string, body?: unknown) => {
    setError(null)
    setBusy(true)
    try {
      const r = await api.post<{ roomId?: string }>(`/api/tournaments/${id}/${path}`, body)
      if (r?.roomId) navigate(`/play/${r.roomId}`)
      else await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Joining a PAID tournament: pay the entry fee to the pool first, then tell
   * the server — which verifies the on-chain payment before seating you. A free
   * tournament skips straight to the server join.
   */
  const join = async () => {
    if (!view || teamId === null) return
    const fee = BigInt(view.entryFeeWei)
    if (fee === 0n) return act('join', { teamId })

    setError(null)
    setBusy(true)
    try {
      if (!view.onchainId || !poolAddress) throw new Error('This paid tournament has no on-chain pool.')
      setStep('Confirm the entry fee in your wallet…')
      const hash = await writeContractAsync({
        address: poolAddress,
        abi: poolAbi,
        functionName: 'joinTournament',
        args: [BigInt(view.onchainId)],
        value: fee,
      })
      setStep('Waiting for confirmation…')
      const receipt = await publicClient!.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('The entry-fee transaction reverted on-chain.')

      setStep('Registering your team…')
      await api.post(`/api/tournaments/${id}/join`, { teamId })
      await load()
    } catch (e) {
      setError(isUserRejection(e) ? 'You rejected the transaction in your wallet.' : describeTxError(e))
    } finally {
      setBusy(false)
      setStep(null)
    }
  }

  /**
   * Leaving: for a PAID tournament, pull your fee back out of the pool on chain
   * (leaveTournament), then the server drops your seat once the chain confirms
   * you're out. A free tournament just drops the seat.
   */
  const leave = async () => {
    if (!view) return
    const fee = BigInt(view.entryFeeWei)
    if (fee === 0n) return act('leave')

    setError(null)
    setBusy(true)
    try {
      if (!view.onchainId || !poolAddress) throw new Error('This paid tournament has no on-chain pool.')
      setStep('Confirm leaving in your wallet…')
      const hash = await writeContractAsync({
        address: poolAddress,
        abi: poolAbi,
        functionName: 'leaveTournament',
        args: [BigInt(view.onchainId)],
      })
      setStep('Waiting for confirmation…')
      const receipt = await publicClient!.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('The leave transaction reverted on-chain.')

      setStep('Dropping your seat…')
      await api.post(`/api/tournaments/${id}/leave`)
      await load()
    } catch (e) {
      setError(isUserRejection(e) ? 'You rejected the transaction in your wallet.' : describeTxError(e))
    } finally {
      setBusy(false)
      setStep(null)
    }
  }

  /**
   * Organizer cancels: for a PAID tournament, flip the pool to REFUNDING on chain
   * (cancelTournament) so entrants can reclaim their fees, then mark it cancelled
   * on the server. A free tournament just cancels server-side.
   */
  const cancel = async () => {
    if (!view) return
    const fee = BigInt(view.entryFeeWei)

    setError(null)
    setBusy(true)
    try {
      if (fee > 0n) {
        if (!view.onchainId || !poolAddress) throw new Error('This paid tournament has no on-chain pool.')
        setStep('Confirm cancelling the pool in your wallet…')
        const hash = await writeContractAsync({
          address: poolAddress,
          abi: poolAbi,
          functionName: 'cancelTournament',
          args: [BigInt(view.onchainId)],
        })
        setStep('Waiting for confirmation…')
        const receipt = await publicClient!.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') throw new Error('The cancel transaction reverted on-chain.')
      }
      setStep('Cancelling…')
      await api.post(`/api/tournaments/${id}/cancel`)
      await load()
    } catch (e) {
      setError(isUserRejection(e) ? 'You rejected the transaction in your wallet.' : describeTxError(e))
    } finally {
      setBusy(false)
      setStep(null)
    }
  }

  /**
   * Unlock refunds on a paid tournament that closed sign-ups without enough
   * players to run.
   *
   * The pool lets ANYONE cancel such a tournament once its deadline has passed
   * (it can never produce a winner), so an entrant does not have to wait for the
   * organiser to notice, nor sit out the 24h settle timeout. No server call:
   * the reconciler sees the pool flip to REFUNDING and marks it cancelled, and
   * the refund panel reads the chain directly, so claiming works immediately.
   */
  const unlockRefunds = async () => {
    if (!view) return
    setError(null)
    setBusy(true)
    try {
      if (!view.onchainId || !poolAddress) throw new Error('This paid tournament has no on-chain pool.')
      setStep('Confirm in your wallet…')
      const hash = await writeContractAsync({
        address: poolAddress,
        abi: poolAbi,
        functionName: 'cancelTournament',
        args: [BigInt(view.onchainId)],
      })
      setStep('Waiting for confirmation…')
      const receipt = await publicClient!.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('The transaction reverted on-chain.')
      setPoolEpoch((n) => n + 1)
      await load()
    } catch (e) {
      setError(isUserRejection(e) ? 'You rejected the transaction in your wallet.' : describeTxError(e))
    } finally {
      setBusy(false)
      setStep(null)
    }
  }

  /**
   * Organizer extends the sign-up window. For a PAID tournament this pushes the
   * pool's on-chain deadline out too (extendDeadline), keeping the two in step.
   */
  const extend = async (addSeconds: number) => {
    if (!view) return
    const fee = BigInt(view.entryFeeWei)
    // Push the SCHEDULED start out — not "now + 24h", which would be earlier than
    // a start that's days away and rejected by both the server and the pool.
    const base = Math.max(Math.floor(Date.now() / 1000), view.startAt ?? 0)
    const newStart = base + addSeconds

    setError(null)
    setBusy(true)
    try {
      if (fee > 0n) {
        if (!view.onchainId || !poolAddress) throw new Error('This paid tournament has no on-chain pool.')
        setStep('Confirm the new deadline in your wallet…')
        const hash = await writeContractAsync({
          address: poolAddress,
          abi: poolAbi,
          functionName: 'extendDeadline',
          args: [BigInt(view.onchainId), BigInt(newStart)],
        })
        setStep('Waiting for confirmation…')
        const receipt = await publicClient!.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') throw new Error('The extend transaction reverted on-chain.')
      }
      setStep('Rescheduling…')
      await api.post(`/api/tournaments/${id}/extend`, { startAt: newStart })
      await load()
    } catch (e) {
      setError(isUserRejection(e) ? 'You rejected the transaction in your wallet.' : describeTxError(e))
    } finally {
      setBusy(false)
      setStep(null)
    }
  }

  if (!view) {
    return (
      <section className="section">
        <div className="wrap">{error ? <Banner kind="error">{error}</Banner> : <Spinner label="Loading…" />}</div>
      </section>
    )
  }

  const fee = BigInt(view.entryFeeWei)
  const you = view.you
  const nowSec = Math.floor(Date.now() / 1000)
  const startPassed = view.startAt == null || nowSec >= view.startAt
  const canJoin = view.status === 'open' && signedIn && you && !you.entered && teamId !== null
  // A paid, timed tournament starts itself when sign-ups close; a manual start is
  // only offered for a free/untimed one, or once the timer has already elapsed.
  const canStart =
    view.status === 'open' && you?.isAdmin && view.players.length >= 2 && (fee === 0n || startPassed)
  // Sign-ups are only ever *closed* on a timed tournament; an untimed one waits
  // for the organiser, which is not the same thing.
  const signUpsClosed = view.startAt != null && nowSec >= view.startAt
  // Closed with too few to run: the money is in the pool and nothing will ever
  // start. Anyone in it can cancel the pool on chain from here.
  const didNotFill = fee > 0n && view.status === 'open' && signUpsClosed && view.players.length < 2
  // `leaveTournament` reverts once the registration deadline passes, so offering
  // it after that is offering a button that cannot work.
  const canLeave = fee === 0n || !signUpsClosed
  // The champion collects through the prize panel, so the refund panel stays out
  // of their way rather than offering a second withdraw button for the same money.
  const youAreChampion = Boolean(
    address && view.winner && address.toLowerCase() === view.winner.toLowerCase(),
  )

  return (
    <section className="section">
      <div className="wrap">
        <div className="section-head section-head--center">
          <div>
            <div className="eyebrow">
              <Link to="/tournaments">Tournaments</Link> · {view.players.length}/{view.maxPlayers}{' '}
              players · {fee > 0n ? entryLabel(view.entryFeeWei, view.ethUsd) : 'Free entry'}
              {view.status === 'open' && view.startAt != null && (
                <> · {startPassed ? 'sign-ups closed' : `starts ${untilLabel(view.startAt)}`}</>
              )}
            </div>
            <h2>{view.name}</h2>
            {view.status === 'cancelled' && (
              <p className="lede">This tournament was cancelled.{fee > 0n ? ' Entrants can reclaim their entry fee below.' : ''}</p>
            )}
            {view.status === 'finished' && view.hasWinner && (
              <p className="lede tn__champion">
                🏆{' '}
                {view.winnerName ? (
                  <>
                    {view.winnerName}
                    {view.winnerHidden && ' 🔒'}
                  </>
                ) : view.winner ? (
                  <Address value={view.winner} />
                ) : (
                  'A hidden trainer 🔒'
                )}{' '}
                won it.
              </p>
            )}
          </div>
        </div>

        {error && <Banner kind="error">{error}</Banner>}

        {/* ---- the scheduled-start countdown ---- */}
        {view.status === 'open' && view.startAt != null && !startPassed && (
          <StartClock startAt={view.startAt} />
        )}

        {/* ---- prize pool + (admin) the manual-payout details ---- */}
        <PrizePool view={view} />
        {you?.isAdmin && <PrizePayout view={view} />}

        {/* ---- prize, for the champion of a paid tournament ---- */}
        {view.status === 'finished' && view.onchainId && poolReady && (
          <PrizeClaim
            serverId={view.id}
            onchainId={view.onchainId}
            winner={view.winner}
            pot={BigInt(view.entryFeeWei) * BigInt(view.players.length)}
          />
        )}

        {/* ---- your position ---- */}
        {/* Not for a cancelled one: "You are signed up… it starts automatically"
            is a lie there, and the leave button under it calls leaveTournament,
            which reverts because cancelling already flipped the pool to
            REFUNDING. The refund panel below is the whole story instead. */}
        {signedIn && you && view.status !== 'finished' && view.status !== 'cancelled' && (
          <div className="tn__you card">
            {you.playableMatchId !== null ? (
              <>
                <div>
                  <strong>Your match is ready.</strong>
                  <p>Play it when you are — your opponent can start it too.</p>
                </div>
                <button className="btn btn--dark" onClick={() => void act('play')} disabled={busy}>
                  {busy ? 'Starting…' : 'Play my match'}
                </button>
              </>
            ) : you.entered && view.status === 'running' ? (
              <div>
                <strong>You are in.</strong>
                <p>Waiting for the round to fill out. This page updates on its own.</p>
              </div>
            ) : you.entered && didNotFill ? (
              <>
                <div>
                  <strong>This one didn’t fill.</strong>
                  <p>
                    Sign-ups closed with {view.players.length === 1 ? 'only you' : `${view.players.length} players`} in
                    it, and it takes two to run. Unlock refunds and everyone can take their entry
                    fee back — you don’t have to wait for the organiser.
                  </p>
                </div>
                <button className="btn btn--dark" onClick={() => void unlockRefunds()} disabled={busy}>
                  {busy ? (step ?? 'Working…') : 'Unlock refunds'}
                </button>
              </>
            ) : you.entered ? (
              <>
                <div>
                  <strong>You are signed up.</strong>
                  <p>
                    {signUpsClosed
                      ? 'It starts any moment now.'
                      : view.startAt != null
                        ? `It starts at its scheduled time — ${formatStart(view.startAt)}. The organiser can push it back, but it won’t start early.`
                        : 'The bracket is drawn when the organiser starts it.'}
                  </p>
                </div>
                {canLeave && (
                  <button className="btn btn--ghost" onClick={() => void leave()} disabled={busy}>
                    {busy ? (step ?? 'Leaving…') : fee > 0n ? 'Leave & get refund' : 'Withdraw'}
                  </button>
                )}
              </>
            ) : view.status === 'open' && !(fee > 0n && signUpsClosed) ? (
              <>
                <div>
                  <strong>Sign-ups are open.</strong>
                  <p>
                    {teams.length === 0
                      ? 'Build a team first — you enter with a saved team.'
                      : 'Pick the team you want to enter with.'}
                  </p>
                </div>
                <div className="tn__join">
                  {teams.length > 0 && (
                    <select
                      className="tn__input"
                      value={teamId ?? ''}
                      onChange={(e) => setTeamId(Number(e.target.value))}
                    >
                      {teams.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                  )}
                  {teams.length === 0 ? (
                    <Link className="btn btn--dark" to="/play">Build a team</Link>
                  ) : (
                    <button
                      className="btn btn--dark"
                      onClick={() => void join()}
                      disabled={busy || !canJoin}
                    >
                      {/* The button names BOTH: the USDG figure the tournament is priced in,
                          and the exact ETH the wallet is about to ask this player to sign. */}
                      {busy
                        ? (step ?? 'Entering…')
                        : fee > 0n
                          ? `Pay ${entryLabel(view.entryFeeWei, view.ethUsd)} & enter`
                          : 'Enter'}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div>
                <strong>
                  {view.status === 'open' ? 'Sign-ups have closed.' : 'This tournament is under way.'}
                </strong>
                <p>
                  {view.status === 'open'
                    ? didNotFill
                      ? 'It did not get enough players to run, so its entrants are taking their fees back.'
                      : 'The entry fee can no longer be paid — this one is about to start.'
                    : 'Sign-ups have closed.'}
                </p>
              </div>
            )}
          </div>
        )}

        {/* ---- organiser controls ---- */}
        {view.status === 'open' && you?.isAdmin && (
          <div className="tn__admin">
            {canStart && (
              <button className="btn btn--dark" onClick={() => void act('start')} disabled={busy}>
                {busy ? 'Drawing…' : `Start now with ${view.players.length}`}
              </button>
            )}
            {view.startAt != null && !startPassed && (
              <button className="btn btn--ghost" onClick={() => void extend(24 * 3600)} disabled={busy}>
                {busy ? (step ?? '…') : 'Extend 24h'}
              </button>
            )}
            <button className="btn btn--ghost" onClick={() => void cancel()} disabled={busy}>
              {busy ? (step ?? '…') : fee > 0n ? 'Cancel & refund all' : 'Cancel'}
            </button>
          </div>
        )}

        {/* ---- your money in the pool: a refund to claim, or a balance to withdraw ----
            Not only for a cancelled tournament: leaving an open one credits the fee
            to the pool rather than sending it, so the withdraw has to be reachable
            from here too or that money is stranded. Skipped for the champion, whose
            prize panel above already offers the withdraw. */}
        {fee > 0n && view.onchainId && poolReady && signedIn && !youAreChampion && (
          <RefundClaim
            onchainId={view.onchainId}
            championed={view.status === 'finished' && view.hasWinner}
            refreshKey={`${view.status}:${you?.entered ?? false}:${poolEpoch}`}
          />
        )}

        {/* ---- bracket, or the sign-up list ---- */}
        {view.status === 'open' ? (
          <div className="tn__entrants card">
            <h3>Entrants</h3>
            {view.players.length === 0 ? (
              <p className="tn__note">Nobody yet. Be first.</p>
            ) : (
              <ol className="tn__entrant-list">
                {view.players.map((p, i) => (
                  <li key={p.address || `hidden-${i}`}>
                    {p.hidden ? (
                      <span className="tn__player tn__player--hidden">{p.name ?? 'Hidden trainer'} 🔒</span>
                    ) : p.name ? (
                      <span className="tn__player">{p.name}</span>
                    ) : p.address ? (
                      <Address value={p.address} />
                    ) : (
                      <span className="tn__player">Unknown</span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        ) : (
          <div className="tn__bracket">
            {Array.from({ length: view.rounds }, (_, i) => i + 1).map((round) => (
              <div className="tn__round" key={round}>
                <div className="tn__round-title">{roundName(round, view.rounds)}</div>
                {/* The matches carry the vertical distribution, not the round —
                    otherwise the round title is spaced out along with them and a
                    one-match round floats it half way down the column. */}
                <div className="tn__round-matches">
                  {view.matches
                    .filter((m) => m.round === round)
                    .map((m) => (
                      <div className={`tn__match tn__match--${m.status}`} key={m.id}>
                        <Side
                          name={m.p0Name}
                          address={m.p0}
                          hidden={m.p0Hidden}
                          filled={m.p0Filled}
                          won={m.p0Won}
                          decided={m.decided}
                        />
                        <Side
                          name={m.p1Name}
                          address={m.p1}
                          hidden={m.p1Hidden}
                          filled={m.p1Filled}
                          won={m.p1Won}
                          decided={m.decided}
                        />
                        {m.status === 'playing' && m.battleId && (
                          <Link className="tn__replay tn__watch" to={`/watch/${m.battleId}`}>
                            ● Watch live
                          </Link>
                        )}
                        {m.status === 'done' && m.battleId && (
                          <Link className="tn__replay" to={`/replay/${m.battleId}`}>
                            Replay
                          </Link>
                        )}
                      </div>
                    ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * Get your money back out of the pool. Three ways in, and the pool itself is
 * asked which one applies — not the server, whose view of a cancellation can
 * lag a reconcile behind the chain:
 *
 *  - the tournament is REFUNDING (cancelled, or unlocked by an entrant), so each
 *    entrant claims their own fee back and then withdraws it — two steps for the
 *    same reason the prize is, that a reverting receiver can only ever brick its
 *    own withdraw;
 *  - it is still OPEN but past `timeoutAt`, the trustless escape hatch: nobody
 *    ever settled it, so the first claim flips it to REFUNDING for everyone;
 *  - you simply have a balance with nothing to claim, which is what leaving an
 *    open tournament leaves you with — `leaveTournament` credits the fee rather
 *    than sending it.
 *
 * `refreshKey` is not read: it exists so the page can force a re-read after a
 * transaction that changes what the pool owes us, instead of leaving a stale
 * zero on screen.
 */
function RefundClaim({
  onchainId,
  championed,
  refreshKey,
}: {
  onchainId: string
  championed: boolean
  refreshKey: string
}) {
  const { address } = useAccount()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()

  const [entrant, setEntrant] = useState(false)
  const [balance, setBalance] = useState<bigint>(0n)
  const [status, setStatus] = useState<number | 'unknown'>('unknown')
  const [timedOut, setTimedOut] = useState(false)
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!publicClient || !poolAddress || !address) return
    const at = { address: poolAddress, abi: poolAbi } as const
    try {
      const [isE, bal, st, timeout] = await Promise.all([
        publicClient.readContract({ ...at, functionName: 'isEntrant', args: [BigInt(onchainId), address] }),
        publicClient.readContract({ ...at, functionName: 'balances', args: [address] }),
        publicClient.readContract({ ...at, functionName: 'statusOf', args: [BigInt(onchainId)] }),
        publicClient.readContract({ ...at, functionName: 'timeoutAt', args: [BigInt(onchainId)] }),
      ])
      setEntrant(Boolean(isE))
      setBalance(bal as bigint)
      setStatus(Number(st))
      setTimedOut(BigInt(Math.floor(Date.now() / 1000)) >= (timeout as bigint))
    } catch { /* leave as-is; the tx will be the source of truth */ }
  }, [publicClient, address, onchainId])

  useEffect(() => {
    void refresh()
  }, [refresh, refreshKey])

  const refunding = status === TournamentStatus.REFUNDING
  // A tournament still OPEN past its timeout has no winner coming: the contract
  // lets any entrant claim, and the first claim opens refunds for everyone.
  //
  // Deliberately NOT offered once a champion has been crowned, even though the
  // contract would allow it. That first claim flips the pool to REFUNDING and
  // permanently denies the champion their prize — so a beaten player would have
  // a one-click button to void a result they lost. A slow champion is not a
  // liveness problem: `settle` takes the arbiter's signature from ANY caller and
  // /api/tournaments/:id/settlement is a public GET, so anyone can pay them out.
  const canClaim =
    entrant && (refunding || (status === TournamentStatus.OPEN && timedOut && !championed))
  if (!canClaim && balance === 0n) return null

  const run = async (fn: 'claimRefund' | 'withdraw', done: string) => {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      if (!poolAddress) throw new Error('No tournament pool is configured.')
      setStep('Confirm in your wallet…')
      const hash = await writeContractAsync({
        address: poolAddress,
        abi: poolAbi,
        functionName: fn,
        args: fn === 'claimRefund' ? [BigInt(onchainId)] : [],
      })
      setStep('Waiting for confirmation…')
      const receipt = await publicClient!.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('The transaction reverted on-chain.')
      setNotice(done)
      await refresh()
    } catch (e) {
      setError(isUserRejection(e) ? 'You rejected the transaction in your wallet.' : describeTxError(e))
    } finally {
      setBusy(false)
      setStep(null)
    }
  }

  return (
    <div className="card claim tn__claim">
      <div className="eyebrow">Refund</div>
      <h3 className="claim__title">
        {canClaim ? 'Reclaim your entry fee.' : 'Your entry fee is waiting in the pool.'}
      </h3>
      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="info">{notice}</Banner>}

      {canClaim ? (
        <>
          <p className="claim__note">
            {refunding
              ? 'This tournament was called off. Claim your entry fee back from the pool, then withdraw it.'
              : 'This tournament never produced a winner and its timeout has passed. Claim your entry fee back from the pool, then withdraw it.'}
          </p>
          <button className="btn btn--dark" onClick={() => void run('claimRefund', 'Refund claimed — withdraw it below.')} disabled={busy}>
            {busy ? (step ?? 'Working…') : 'Claim refund'}
          </button>
        </>
      ) : balance > 0n ? (
        <div className="claim__withdraw">
          <div>
            <div className="claim__match">{formatEther(balance)} {CURRENCY} ready to withdraw</div>
            <div className="claim__meta">Held in the tournament pool under your address.</div>
          </div>
          <button className="btn btn--dark" onClick={() => void run('withdraw', 'Withdrawn to your wallet.')} disabled={busy}>
            {busy ? (step ?? 'Working…') : 'Withdraw'}
          </button>
        </div>
      ) : null}

      {busy && step && <Spinner label={step} />}
    </div>
  )
}

/**
 * The champion's prize, for a paid tournament. Two steps, mirroring the wager
 * ClaimPanel: settle() proves the result to the pool and credits the pot to the
 * winner's internal balance (anyone may submit the arbiter signature), then
 * withdraw() moves it to the wallet. Only rendered to the connected winner.
 */
function PrizeClaim({
  serverId,
  onchainId,
  winner,
  pot,
}: {
  serverId: number
  onchainId: string
  winner: string | null
  pot: bigint
}) {
  const { address } = useAccount()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()

  const [status, setStatus] = useState<number | 'unknown'>('unknown')
  const [balance, setBalance] = useState<bigint>(0n)
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const isWinner = Boolean(address && winner && address.toLowerCase() === winner.toLowerCase())

  const refresh = useCallback(async () => {
    if (!publicClient || !poolAddress || !address) return
    try {
      const [st, bal] = await Promise.all([
        publicClient.readContract({ address: poolAddress, abi: poolAbi, functionName: 'statusOf', args: [BigInt(onchainId)] }),
        publicClient.readContract({ address: poolAddress, abi: poolAbi, functionName: 'balances', args: [address] }),
      ])
      setStatus(Number(st))
      setBalance(bal as bigint)
    } catch {
      setStatus('unknown')
    }
  }, [publicClient, address, onchainId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!isWinner) return null
  // Nothing to do once it is settled and the balance is collected.
  if (status === TournamentStatus.SETTLED && balance === 0n) return null

  const needsSettle = status === TournamentStatus.OPEN || status === 'unknown'

  const claim = async () => {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      if (!poolAddress) throw new Error('No tournament pool is configured.')
      setStep('Fetching the signed result…')
      const s = await api.get<TournamentSettlement>(`/api/tournaments/${serverId}/settlement`)

      setStep('Confirm in your wallet…')
      const hash = await writeContractAsync({
        address: poolAddress,
        abi: poolAbi,
        functionName: 'settle',
        args: [BigInt(s.tournamentId), s.winner, s.signature],
      })
      setStep('Waiting for confirmation…')
      const receipt = await publicClient!.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('The transaction reverted on-chain.')
      setNotice('Prize settled on-chain. Withdraw it below.')
      await refresh()
    } catch (e) {
      setError(isUserRejection(e) ? 'You rejected the transaction in your wallet.' : describeTxError(e))
    } finally {
      setBusy(false)
      setStep(null)
    }
  }

  const withdraw = async () => {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      if (!poolAddress) throw new Error('No tournament pool is configured.')
      setStep('Confirm in your wallet…')
      const hash = await writeContractAsync({ address: poolAddress, abi: poolAbi, functionName: 'withdraw' })
      setStep('Waiting for confirmation…')
      await publicClient!.waitForTransactionReceipt({ hash })
      setNotice('Prize withdrawn to your wallet.')
      await refresh()
    } catch (e) {
      setError(isUserRejection(e) ? 'You rejected the transaction in your wallet.' : describeTxError(e))
    } finally {
      setBusy(false)
      setStep(null)
    }
  }

  return (
    <div className="card claim tn__claim">
      <div className="eyebrow">Your prize</div>
      <h3 className="claim__title">🏆 You won this tournament.</h3>
      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="info">{notice}</Banner>}

      {needsSettle ? (
        <>
          <p className="claim__note">
            The pot is {formatEther(pot)} {CURRENCY} (minus the house fee). Settling proves the
            result to the pool and credits the prize to you; then you withdraw it.
          </p>
          <button className="btn btn--dark" onClick={() => void claim()} disabled={busy}>
            {busy ? (step ?? 'Working…') : 'Claim prize'}
          </button>
        </>
      ) : balance > 0n ? (
        <div className="claim__withdraw">
          <div>
            <div className="claim__match">{formatEther(balance)} {CURRENCY} ready to withdraw</div>
            <div className="claim__meta">Held in the tournament pool under your address.</div>
          </div>
          <button className="btn btn--dark" onClick={() => void withdraw()} disabled={busy}>
            {busy ? (step ?? 'Working…') : 'Withdraw'}
          </button>
        </div>
      ) : null}

      {busy && step && <Spinner label={step} />}
    </div>
  )
}

function Side({
  name,
  address,
  hidden,
  filled,
  won,
  decided,
}: {
  name: string | null
  address: string | null
  hidden: boolean
  filled: boolean
  won: boolean
  decided: boolean
}) {
  if (!filled) return <div className="tn__side tn__side--empty">—</div>
  const lost = decided && !won
  return (
    <div className={`tn__side${won ? ' tn__side--won' : ''}${lost ? ' tn__side--lost' : ''}`}>
      {hidden ? (
        <span className="tn__side-hidden">{name ?? 'Hidden trainer'} 🔒</span>
      ) : name ? (
        name
      ) : address ? (
        <Address value={address} />
      ) : (
        '—'
      )}
    </div>
  )
}
