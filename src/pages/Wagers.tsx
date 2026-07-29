import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAccount, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from 'wagmi'
import { api, formatEth, parseEth, type Team, type Wager } from '../lib/api'
import { useSession } from '../lib/session'
import { Banner, Empty, Spinner } from '../components/ui'
import { ClaimPanel } from '../components/ClaimPanel'
import { CHAIN_ID, CHAIN_LABEL, CURRENCY, MIN_STAKE_WEI, MIN_STAKE_LABEL } from '../config'
import {
  describeTxError,
  escrowAbi,
  escrowAddress,
  escrowReady,
  expiryFromNow,
  requireEscrow,
  isUserRejection,
  wagerIdFromReceipt,
} from '../lib/escrow'
import '../styles/wagers.css'
import '../styles/claim.css'
import { Address } from '../components/Address'

const POLL_MS = 5000

/* ------------------------------------------------------------------ */
/* time formatting                                                     */
/* ------------------------------------------------------------------ */

function ago(seconds: number): string {
  if (seconds < 60) return 'just now'
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function countdown(seconds: number): string {
  if (seconds <= 0) return 'expired'
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }
  const h = Math.floor(seconds / 3600)
  return `${h}h ${Math.floor((seconds % 3600) / 60)}m`
}

/* ------------------------------------------------------------------ */
/* page                                                                */
/* ------------------------------------------------------------------ */

/** The step a multi-transaction flow is currently on, for honest status text. */
type Step = null | 'wallet' | 'confirming' | 'posting' | 'cancelling' | 'withdrawing'

const STEP_LABEL: Record<Exclude<Step, null>, string> = {
  wallet: 'Confirm in your wallet…',
  confirming: 'Waiting for confirmation…',
  posting: 'Posting to the board…',
  cancelling: 'Cancelling…',
  withdrawing: 'Withdrawing…',
}

/**
 * The wager board. `embedded` drops the page chrome so it can sit inside the
 * unified /play layout; `onEnterBattle` lets the parent swap to the arena
 * instead of navigating away.
 */
export function WagerBoard({
  embedded = false,
  onEnterBattle,
  teamId: controlledTeamId,
  onBuildTeam,
}: {
  embedded?: boolean
  onEnterBattle?: (roomId: string) => void
  /** When set, the parent owns team selection and the local picker is hidden. */
  teamId?: number | null
  onBuildTeam?: () => void
} = {}) {
  const navigate = useNavigate()
  const { me, signedIn, signIn, signingIn, isConnected, address } = useSession()
  const { chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()

  const [wagers, setWagers] = useState<Wager[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [teams, setTeams] = useState<Team[]>([])
  const [ownTeamId, setOwnTeamId] = useState<number | null>(null)
  const controlled = controlledTeamId !== undefined
  const teamId = controlled ? controlledTeamId : ownTeamId
  const setTeamId = setOwnTeamId

  const [paid, setPaid] = useState(false)
  const [amount, setAmount] = useState('0.01')

  const [step, setStep] = useState<Step>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  /**
   * Set when a board entry was cancelled but the on-chain refund did not go
   * through. The stake is still escrowed and the user needs a way back to it,
   * so we keep the id around and offer a retry.
   */
  const [strandedRefund, setStrandedRefund] = useState<bigint | null>(null)

  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))

  const wrongNetwork = isConnected && chainId !== undefined && chainId !== CHAIN_ID
  const busy = step !== null

  /* ---------------- board polling ---------------- */

  // A ref keeps the poll callback stable so the interval is created once.
  const loadingRef = useRef(false)

  const loadBoard = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    try {
      const rows = await api.get<Wager[]>('/api/wagers')
      setWagers(rows)
      setLoadError(null)
    } catch (e) {
      setLoadError((e as Error).message)
      // Keep whatever we already had on screen rather than blanking the board.
      setWagers((prev) => prev ?? [])
    } finally {
      loadingRef.current = false
    }
  }, [])

  useEffect(() => {
    void loadBoard()
    const id = setInterval(() => void loadBoard(), POLL_MS)
    return () => clearInterval(id)
  }, [loadBoard])

  // Countdowns need a second-resolution clock of their own.
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])

  /* ---------------- teams ---------------- */

  useEffect(() => {
    if (!signedIn) {
      setTeams([])
      setTeamId(null)
      return
    }
    let cancelled = false
    api
      .get<Team[]>('/api/teams')
      .then((rows) => {
        if (cancelled) return
        setTeams(rows)
        if (!controlled) {
          setOwnTeamId((prev) =>
            prev !== null && rows.some((t) => t.id === prev) ? prev : rows[0]?.id ?? null,
          )
        }
      })
      .catch(() => {
        if (!cancelled) setTeams([])
      })
    return () => {
      cancelled = true
    }
  }, [signedIn])

  /* ---------------- escrow balance (pull payments) ---------------- */

  const { data: escrowBalance, refetch: refetchBalance } = useReadContract({
    address: escrowAddress ?? undefined,
    abi: escrowAbi,
    functionName: 'balances',
    args: address ? [address] : undefined,
    query: {
      enabled: Boolean(escrowAddress && address && !wrongNetwork),
      refetchInterval: 15_000,
    },
  })

  const claimable = typeof escrowBalance === 'bigint' ? escrowBalance : 0n

  /* ---------------- helpers ---------------- */

  const stakeWei = useMemo(() => {
    if (!paid) return '0'
    try {
      return parseEth(amount)
    } catch {
      return null
    }
  }, [paid, amount])

  const reset = () => {
    setStep(null)
    setBusyId(null)
  }

  /**
   * Runs a write and waits for it to be mined, narrating each step.
   *
   * Takes a thunk rather than a config object so each call site's arguments are
   * type-checked directly by `writeContractAsync` — passing them through here
   * would collapse the payable/non-payable union and lose `value`.
   */
  const send = useCallback(
    async (run: () => Promise<`0x${string}`>) => {
      if (!publicClient) throw new Error('No RPC client for this network.')
      setStep('wallet')
      const hash = await run()
      setStep('confirming')
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('The transaction reverted on-chain.')
      return receipt
    },
    [publicClient],
  )

  /* ---------------- post a wager ---------------- */

  async function post() {
    setError(null)
    setNotice(null)

    if (teamId === null) return setError('Pick a team to bring first.')
    if (paid && !escrowReady) return setError('Paid wagering is not available yet.')
    if (stakeWei === null) return setError(`Enter a valid ${CURRENCY} amount.`)
    if (paid && BigInt(stakeWei) === 0n) return setError('A paid wager needs a stake above zero.')
    // Checked here so the wallet is never opened for a stake the server will refuse: the
    // escrow transaction comes FIRST, so a late rejection would strand real ETH on chain.
    if (paid && BigInt(stakeWei) < MIN_STAKE_WEI) {
      return setError(`The smallest paid stake is ${MIN_STAKE_LABEL} ${CURRENCY}.`)
    }

    try {
      let onchainId: string | undefined

      if (paid) {
        const contract = requireEscrow()
        const value = BigInt(stakeWei)
        const receipt = await send(() =>
          writeContractAsync({
            address: contract,
            abi: escrowAbi,
            functionName: 'createWager',
            args: [value, expiryFromNow()],
            value,
          }),
        )

        const id = wagerIdFromReceipt(receipt)
        if (id === null) {
          // The money is escrowed but we cannot name the wager, so we must not
          // claim it was posted. Say exactly that.
          throw new Error(
            'Your stake was escrowed but the wager id could not be read from the transaction. ' +
              'Nothing was posted to the board — check the explorer before trying again.',
          )
        }
        onchainId = id.toString()
      }

      setStep('posting')
      await api.post<{ id: number }>('/api/wagers', { teamId, stakeWei, onchainId })

      setNotice(paid ? 'Wager posted and stake escrowed.' : 'Free wager posted.')
      await loadBoard()
    } catch (e) {
      setError(isUserRejection(e) ? 'You rejected the transaction in your wallet.' : describeTxError(e))
    } finally {
      reset()
    }
  }

  /* ---------------- accept a wager ---------------- */

  async function accept(w: Wager) {
    setError(null)
    setNotice(null)

    if (teamId === null) return setError('Pick a team to bring first.')

    const stake = BigInt(w.stake_wei || '0')
    if (stake > 0n && (!escrowReady || !w.onchain_id)) {
      return setError('This paid wager cannot be accepted — no escrow contract is configured.')
    }

    setBusyId(w.id)
    try {
      if (stake > 0n && w.onchain_id) {
        const contract = requireEscrow()
        await send(() =>
          writeContractAsync({
            address: contract,
            abi: escrowAbi,
            functionName: 'acceptWager',
            args: [BigInt(w.onchain_id as string)],
            value: stake,
          }),
        )
      }

      setStep('posting')
      const { roomId } = await api.post<{ roomId: string }>(`/api/wagers/${w.id}/accept`, { teamId })
      if (onEnterBattle) onEnterBattle(roomId)
      else navigate(`/battle/${roomId}`)
    } catch (e) {
      setError(isUserRejection(e) ? 'You rejected the transaction in your wallet.' : describeTxError(e))
      await loadBoard()
    } finally {
      reset()
    }
  }

  /* ---------------- cancel your own wager ---------------- */

  async function cancel(w: Wager) {
    setError(null)
    setNotice(null)
    setBusyId(w.id)

    const stake = BigInt(w.stake_wei || '0')

    try {
      // Take it off the board first: nobody should be able to accept a wager we
      // are in the middle of unwinding.
      setStep('cancelling')
      await api.del(`/api/wagers/${w.id}`)
      await loadBoard()

      if (stake > 0n && w.onchain_id) {
        const contract = requireEscrow()
        const onchainId = BigInt(w.onchain_id)
        try {
          await send(() =>
            writeContractAsync({
              address: contract,
              abi: escrowAbi,
              functionName: 'cancelWager',
              args: [onchainId],
            }),
          )
          setNotice('Match cancelled. Your stake is now withdrawable below.')
          void refetchBalance()
        } catch (e) {
          // The board entry is gone but the stake is not back yet — surface a
          // retry rather than losing the id.
          setStrandedRefund(onchainId)
          throw e
        }
      } else {
        setNotice('Match cancelled.')
      }
    } catch (e) {
      setError(isUserRejection(e) ? 'You rejected the transaction in your wallet.' : describeTxError(e))
    } finally {
      reset()
    }
  }

  async function retryRefund() {
    if (strandedRefund === null) return
    setError(null)
    try {
      const contract = requireEscrow()
      await send(() =>
        writeContractAsync({
          address: contract,
          abi: escrowAbi,
          functionName: 'cancelWager',
          args: [strandedRefund],
        }),
      )
      setStrandedRefund(null)
      setNotice('Stake reclaimed. It is now withdrawable below.')
      void refetchBalance()
    } catch (e) {
      setError(describeTxError(e))
    } finally {
      reset()
    }
  }

  /* ---------------- render ---------------- */

  const mine = address?.toLowerCase()

  const Shell = embedded ? Fragment : PageShell

  return (
    <Shell>
      <>
        {!embedded && (
          <div className="section-head">
            <div>
              <div className="eyebrow">The board</div>
              <h2>Open wagers.</h2>
              <p className="lede">
                Every entry below is a trainer waiting for an opponent. Accept one and the battle
                starts immediately. Paid stakes are held by the escrow contract on {CHAIN_LABEL} —
                never by us.
              </p>
            </div>
          </div>
        )}

        {/* ---- status banners ---- */}

        {wrongNetwork && (
          <Banner kind="warn">
            <span>
              Your wallet is on the wrong network. Switch to {CHAIN_LABEL} to wager.
            </span>{' '}
            <button className="mini-btn" onClick={() => switchChain({ chainId: CHAIN_ID })}>
              Switch
            </button>
          </Banner>
        )}

        {!escrowReady && (
          <Banner kind="info">
            <strong>Paid wagering is off.</strong> The escrow contract has not been deployed yet, so
            there is nowhere to hold a stake. Free matches work normally and still count towards
            your record.
          </Banner>
        )}

        {loadError && <Banner kind="error">Could not refresh the board: {loadError}</Banner>}
        {error && <Banner kind="error">{error}</Banner>}
        {notice && <Banner kind="info">{notice}</Banner>}

        {strandedRefund !== null && (
          <Banner kind="warn">
            <span>
              Wager #{strandedRefund.toString()} is off the board, but your stake is still in
              escrow.
            </span>{' '}
            <button className="mini-btn" onClick={() => void retryRefund()} disabled={busy}>
              Reclaim stake
            </button>
          </Banner>
        )}

        {/* ---- settle + withdraw ---- */}

        <ClaimPanel
          signedIn={signedIn}
          balance={claimable}
          onBalanceChanged={() => void refetchBalance()}
          wrongNetwork={wrongNetwork}
        />

        {/* ---- your side ---- */}

        <div className="card wagers__you">
          {!signedIn ? (
            /* Sign-in is handled once, by whoever renders this board. */
            embedded ? null : (
              <div className="wagers__signin">
                <p className="wagers__hint">
                  Sign a message to prove the wallet is yours. It costs nothing and sends no
                  transaction.
                </p>
                <button className="btn btn--dark" onClick={() => void signIn()} disabled={signingIn}>
                  {signingIn ? 'Check your wallet…' : 'Sign in'}
                </button>
              </div>
            )
          ) : teams.length === 0 ? (
            <Empty
              title="No teams saved"
              body="You need a team of six before you can post or accept a wager."
              action={
                <button
                  className="btn btn--dark"
                  onClick={() => (onBuildTeam ? onBuildTeam() : navigate('/play'))}
                >
                  Build a team
                </button>
              }
            />
          ) : (
            <>
              {!controlled && (
              <div className="wagers__field">
                <label className="eyebrow" htmlFor="team">
                  Your team
                </label>
                <select
                  id="team"
                  className="wagers__select"
                  value={teamId ?? ''}
                  onChange={(e) => setTeamId(Number(e.target.value))}
                  disabled={busy}
                >
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <p className="wagers__hint">
                  Used for whatever you post or accept next.
                  {me && ` Your record: ${me.wins}W ${me.losses}L.`}
                </p>
              </div>
              )}

              <div className="wagers__post">
                <div className="wagers__field">
                  <span className="eyebrow">Stake</span>
                  <div className="wagers__toggle">
                    <button
                      className={`chip${!paid ? ' chip--on' : ''}`}
                      onClick={() => setPaid(false)}
                      disabled={busy}
                    >
                      Free
                    </button>
                    <button
                      className={`chip${paid ? ' chip--on' : ''}`}
                      onClick={() => setPaid(true)}
                      disabled={busy || !escrowReady}
                      title={escrowReady ? undefined : 'Escrow contract not deployed'}
                    >
                      {CURRENCY}
                    </button>
                  </div>
                </div>

                {paid && (
                  <div className="wagers__field">
                    <label className="eyebrow" htmlFor="amount">
                      Amount
                    </label>
                    <div className="wagers__amount">
                      <input
                        id="amount"
                        className="wagers__input"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        inputMode="decimal"
                        placeholder="0.01"
                        disabled={busy}
                      />
                      <span className="wagers__unit">{CURRENCY}</span>
                    </div>
                    {stakeWei === null ? (
                      <p className="wagers__hint wagers__hint--bad">Not a valid amount.</p>
                    ) : BigInt(stakeWei) > 0n && BigInt(stakeWei) < MIN_STAKE_WEI ? (
                      <p className="wagers__hint wagers__hint--bad">
                        Minimum stake is {MIN_STAKE_LABEL} {CURRENCY}.
                      </p>
                    ) : (
                      <p className="wagers__hint">
                        Minimum {MIN_STAKE_LABEL} {CURRENCY}.
                      </p>
                    )}
                  </div>
                )}

                <button
                  className="btn btn--dark wagers__post-btn"
                  onClick={() => void post()}
                  disabled={busy || wrongNetwork || teamId === null || (paid && stakeWei === null)}
                >
                  {busy && busyId === null && step !== 'withdrawing'
                    ? STEP_LABEL[step]
                    : paid
                      ? `Post for ${amount || '0'} ${CURRENCY}`
                      : 'Post a free wager'}
                </button>
              </div>

              {paid && (
                <p className="wagers__hint">
                  Posting escrows your stake first, then puts the wager on the board. If the board
                  step fails you can cancel on-chain and get it straight back.
                </p>
              )}
            </>
          )}
        </div>

        {/* ---- the board ---- */}

        {wagers === null ? (
          <Spinner label="Loading the board…" />
        ) : wagers.length === 0 ? (
          <Empty
            title="Matches"
            body="No open matches right now."
          />
        ) : (
          <ul className="wagers__list">
            {wagers.map((w) => {
              const isMine = mine !== undefined && w.creator.toLowerCase() === mine
              const stake = BigInt(w.stake_wei || '0')
              const left = w.expires_at - nowSec
              const rowBusy = busyId === w.id
              const paidUnavailable = stake > 0n && (!escrowReady || !w.onchain_id)

              return (
                <li className="card wager" key={w.id}>
                  <div className="wager__who">
                    <div className="wager__name">
                      {w.creator_name ||
                        (w.creator_hidden ? (
                          <span className="wager__hidden">Hidden trainer</span>
                        ) : (
                          <Address value={w.creator} />
                        ))}
                      {isMine && <span className="wager__you-tag">you</span>}
                    </div>
                    <div className="wager__record">
                      {w.wins}W · {w.losses}L
                    </div>
                  </div>

                  <div className="wager__stake">
                    {stake === 0n ? (
                      <span className="wager__free">Free</span>
                    ) : (
                      <span className="wager__amount">
                        {formatEth(w.stake_wei)} <span className="wager__unit">{CURRENCY}</span>
                      </span>
                    )}
                  </div>

                  <div className="wager__meta">
                    <span>{ago(Math.max(0, nowSec - w.created_at))}</span>
                    <span className={left <= 60 ? 'wager__expiry wager__expiry--soon' : 'wager__expiry'}>
                      {left > 0 ? `expires in ${countdown(left)}` : 'expired'}
                    </span>
                  </div>

                  <div className="wager__actions">
                    {isMine ? (
                      <button
                        className="btn btn--ghost"
                        onClick={() => void cancel(w)}
                        disabled={busy || !signedIn}
                      >
                        {rowBusy ? STEP_LABEL[step ?? 'cancelling'] : 'Cancel'}
                      </button>
                    ) : (
                      <button
                        className="btn btn--dark"
                        onClick={() => void accept(w)}
                        disabled={
                          busy ||
                          !signedIn ||
                          wrongNetwork ||
                          teamId === null ||
                          left <= 0 ||
                          paidUnavailable
                        }
                        title={
                          paidUnavailable
                            ? 'No escrow contract configured for paid wagers'
                            : !signedIn
                              ? 'Sign in to accept'
                              : undefined
                        }
                      >
                        {rowBusy ? STEP_LABEL[step ?? 'wallet'] : 'Accept'}
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </>
    </Shell>
  )
}

/** Page chrome used when the board is rendered on its own route. */
function PageShell({ children }: { children: ReactNode }) {
  return (
    <section className="section">
      <div className="wrap">{children}</div>
    </section>
  )
}

export default function Wagers() {
  return <WagerBoard />
}
