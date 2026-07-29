import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi'
import { api, formatEth } from '../lib/api'
import { CHAIN_ID, CHAIN_LABEL, CURRENCY, EXPLORER } from '../config'
import {
  describeTxError, escrowAbi, escrowReady, isUserRejection, requireEscrow,
} from '../lib/escrow'
import '../styles/unclaimed.css'

/**
 * Pots you have won but not collected.
 *
 * This is not a nicety. The winner settles from their own wallet, so until they
 * do, the pot sits in escrow — and once the contract's timeout elapses, either
 * player can call `claimTimeout`, which refunds BOTH stakes. A winner who never
 * comes back therefore loses their winnings and hands the loser their stake
 * back. Nothing else in the app would tell them that is about to happen.
 */

type Unclaimed = {
  wagerId: number
  onchainId: string
  stakeWei: string
  kind: 'win' | 'draw'
  endedAt: number | null
}

type Settlement =
  | { kind: 'win'; wagerId: string; winner: `0x${string}`; signature: `0x${string}` }
  | { kind: 'draw'; wagerId: string; signature: `0x${string}` }

/**
 * What the escrow still owes you, read straight from the chain.
 *
 * Settling is per WAGER; withdrawing is per PLAYER. `settleDraw` credits BOTH players in one
 * transaction, so when one of them settles and withdraws, the wager leaves
 * /api/me/unclaimed for the other player too, even though their credit is untouched. Their
 * money then had no button anywhere on the site.
 *
 * The chain is the authority on what is owed, so this asks it rather than inferring from a
 * wager's status. Any credit shows a withdraw control until it is actually zero.
 */
function useCredit(address: `0x${string}` | undefined, refreshKey: number) {
  const publicClient = usePublicClient()
  const [wei, setWei] = useState<bigint>(0n)

  useEffect(() => {
    if (!publicClient || !escrowReady || !address) return
    let cancelled = false
    void (async () => {
      try {
        const v = await publicClient.readContract({
          address: requireEscrow(),
          abi: escrowAbi,
          functionName: 'balances',
          args: [address],
        })
        if (!cancelled) setWei(v as bigint)
      } catch {
        /* leave at zero */
      }
    })()
    return () => { cancelled = true }
  }, [publicClient, address, refreshKey])

  return wei
}

/**
 * The contract's fee, read from the chain rather than assumed.
 *
 * Needed because a winner does NOT receive the pot: they receive the pot minus this fee. The
 * panel used to print the raw pot for every row, which overstated a win and was simply wrong
 * for a draw. Falls back to null, and the row then shows the pot with no fee applied only when
 * the read fails, which is the honest degradation.
 */
function useFeeBps() {
  const publicClient = usePublicClient()
  const [bps, setBps] = useState<number | null>(null)

  useEffect(() => {
    if (!publicClient || !escrowReady) return
    let cancelled = false
    void (async () => {
      try {
        const v = await publicClient.readContract({
          address: requireEscrow(),
          abi: escrowAbi,
          functionName: 'feeBps',
        })
        if (!cancelled) setBps(Number(v))
      } catch {
        /* leave null */
      }
    })()
    return () => { cancelled = true }
  }, [publicClient])

  return bps
}

/**
 * What this row actually pays the person looking at it.
 *
 * A DRAW returns each player their OWN stake, with no fee. A WIN pays the pot less the fee.
 * Showing the pot for a draw told both players they were owed 0.002 when each was owed 0.001.
 */
function payoutWei(kind: 'win' | 'draw', stakeWei: string, feeBps: number | null): bigint {
  const stake = BigInt(stakeWei)
  if (kind === 'draw') return stake
  const pot = stake * 2n
  return feeBps === null ? pot : pot - (pot * BigInt(feeBps)) / 10000n
}

/** Remaining time before `claimTimeout` becomes available to either player. */
function useDeadlines(pots: Unclaimed[]) {
  const publicClient = usePublicClient()
  const [deadlines, setDeadlines] = useState<Record<string, number>>({})

  useEffect(() => {
    if (!publicClient || !escrowReady || pots.length === 0) return
    let cancelled = false

    void (async () => {
      const contract = requireEscrow()
      const entries = await Promise.all(
        pots.map(async (p) => {
          try {
            const at = await publicClient.readContract({
              address: contract,
              abi: escrowAbi,
              functionName: 'timeoutAt',
              args: [BigInt(p.onchainId)],
            })
            return [p.onchainId, Number(at)] as const
          } catch {
            return null
          }
        }),
      )
      if (!cancelled) {
        setDeadlines(Object.fromEntries(entries.filter((e): e is [string, number] => e !== null)))
      }
    })()

    return () => { cancelled = true }
  }, [publicClient, pots])

  return deadlines
}

function Countdown({ at }: { at: number | undefined }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(t)
  }, [])

  if (!at) return null
  const left = at - now
  if (left <= 0) {
    return <span className="uc__timer uc__timer--gone">claimable by either player now</span>
  }

  const h = Math.floor(left / 3600)
  const m = Math.floor((left % 3600) / 60)
  const s = left % 60
  const text = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`
  return (
    <span className={`uc__timer${left < 900 ? ' uc__timer--urgent' : ''}`}>
      {text} left to claim
    </span>
  )
}

export function UnclaimedPots({ signedIn }: { signedIn: boolean }) {
  const [rawPots, setPots] = useState<Unclaimed[]>([])
  /**
   * Wagers claimed in this session, hidden immediately.
   *
   * `/api/me/unclaimed` is driven by the wager's DATABASE status, which only flips when the
   * reconciler next runs. Until then a settled, withdrawn pot keeps coming back from the
   * server, so the row sat there offering to claim money already in the wallet. The chain is
   * the truth and it has been acted on, so hide it locally rather than wait for the server.
   */
  const [done, setDone] = useState<Set<string>>(new Set())
  const pots = useMemo(
    () => rawPots.filter((p) => !done.has(String(p.wagerId))),
    [rawPots, done],
  )
  const [busy, setBusy] = useState<number | 'credit' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<'idle' | 'signing' | 'wallet' | 'confirming'>('idle')

  const { chainId, address } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const deadlines = useDeadlines(pots)
  const feeBps = useFeeBps()
  const [creditKey, setCreditKey] = useState(0)
  const credit = useCredit(address, creditKey)
  /**
   * What was just claimed, kept AFTER the pot leaves the list.
   *
   * Without this a successful claim was indistinguishable from nothing happening: `refresh()`
   * empties `pots`, the guard below returns null, and the whole panel silently vanishes. The
   * money had moved, but the only way to find out was to reload and go looking.
   */
  const [claimed, setClaimed] = useState<{ amountWei: string; kind: 'win' | 'draw'; hash: string } | null>(null)

  const refresh = useCallback(async () => {
    if (!signedIn) return setPots([])
    try {
      setPots(await api.get<Unclaimed[]>('/api/me/unclaimed'))
    } catch {
      // A failure here must never break the page it is embedded in.
      setPots([])
    }
  }, [signedIn])

  useEffect(() => {
    void refresh()
    // The winner may settle from another tab, and the server reconciles on a
    // timer, so re-check periodically rather than trusting one snapshot.
    const t = setInterval(() => void refresh(), 30_000)
    return () => clearInterval(t)
  }, [refresh])

  /** Withdraw a credit that has no pot row behind it, which is the stranded case. */
  const withdrawCredit = async () => {
    setError(null)
    setBusy('credit')
    try {
      if (!escrowReady) throw new Error('The escrow contract is not deployed yet.')
      if (!publicClient) throw new Error('No RPC client for this network.')
      if (chainId !== CHAIN_ID) await switchChainAsync({ chainId: CHAIN_ID })
      setStep('wallet')
      const hash = await writeContractAsync({
        address: requireEscrow(),
        abi: escrowAbi,
        functionName: 'withdraw',
      })
      setStep('confirming')
      await publicClient.waitForTransactionReceipt({ hash })
      setClaimed({ amountWei: credit.toString(), kind: 'draw', hash })
      setCreditKey((k) => k + 1)
      await refresh()
    } catch (e) {
      if (!isUserRejection(e)) setError(describeTxError(e))
    } finally {
      setBusy(null)
      setStep('idle')
    }
  }

  if (!signedIn || (pots.length === 0 && credit === 0n && !claimed)) return null

  async function claim(pot: Unclaimed) {
    setError(null)
    setBusy(pot.wagerId)
    try {
      if (!escrowReady) throw new Error('The escrow contract is not deployed yet.')
      if (!publicClient) throw new Error('No RPC client for this network.')
      if (chainId !== CHAIN_ID) await switchChainAsync({ chainId: CHAIN_ID })

      setStep('signing')
      const s = await api.get<Settlement>(`/api/wagers/${pot.wagerId}/settlement`)
      const contract = requireEscrow()

      setStep('wallet')
      const hash = s.kind === 'draw'
        ? await writeContractAsync({
            address: contract,
            abi: escrowAbi,
            functionName: 'settleDraw',
            args: [BigInt(s.wagerId), s.signature],
          })
        : await writeContractAsync({
            address: contract,
            abi: escrowAbi,
            functionName: 'settle',
            args: [BigInt(s.wagerId), s.winner, s.signature],
          })

      setStep('confirming')
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('The transaction reverted on-chain.')

      // Settling credits an internal balance; withdrawing moves the ETH.
      setStep('wallet')
      const wHash = await writeContractAsync({
        address: contract,
        abi: escrowAbi,
        functionName: 'withdraw',
      })
      setStep('confirming')
      await publicClient.waitForTransactionReceipt({ hash: wHash })

      // Captured BEFORE refresh(), which is what removes the row we are describing.
      setClaimed({
        amountWei: payoutWei(pot.kind, pot.stakeWei, feeBps).toString(),
        kind: pot.kind,
        hash: wHash,
      })
      setDone((d) => new Set(d).add(String(pot.wagerId)))
      setCreditKey((k) => k + 1)
      await refresh()
    } catch (e) {
      if (!isUserRejection(e)) setError(describeTxError(e))
    } finally {
      setBusy(null)
      setStep('idle')
    }
  }

  const label = step === 'signing' ? 'Getting signature…'
    : step === 'wallet' ? 'Check your wallet…'
    : step === 'confirming' ? 'Confirming…'
    : null

  return (
    <section className="uc">
      {claimed && (
        <div className="uc__done">
          <strong>
            {claimed.kind === 'draw' ? 'Refund received.' : 'Winnings received.'}{' '}
            {formatEth(claimed.amountWei)} {CURRENCY} is in your wallet.
          </strong>
          <a
            className="uc__done-link"
            href={`${EXPLORER}/tx/${claimed.hash}`}
            target="_blank"
            rel="noreferrer"
          >
            View the transaction
          </a>
          <button className="uc__done-x" onClick={() => setClaimed(null)} aria-label="Dismiss">
            Dismiss
          </button>
        </div>
      )}

      {pots.length === 0 && credit > 0n && !claimed && (
        <div className="uc__head">
          <h2>You have {CURRENCY} to withdraw</h2>
          <p>
            This was already settled on chain, by you or by your opponent, and the contract is
            holding your share until you withdraw it. Nothing expires and nothing is at risk.
          </p>
        </div>
      )}

      {pots.length > 0 && (
      <div className="uc__head">
        {/* The copy was written for a win and then shown on every row, so a draw read as
            "claim your winnings before you lose them" when a draw cannot be lost and pays
            back the player's own stake. Each case now says what is actually true of it. */}
        <h2>You have {pots.length === 1 ? 'a payout' : 'payouts'} to collect</h2>
        <p>
          {pots.every((p) => p.kind === 'draw') ? (
            <>
              This one was a draw, so your own stake comes back to you in full and no fee is
              taken. Claiming settles it on chain and moves the ETH to your wallet. There is no
              rush: a draw refunds either way.
            </>
          ) : pots.every((p) => p.kind === 'win') ? (
            <>
              Your winnings are the pot less the house fee, and they sit in escrow until you
              claim them. Claiming takes two steps, settling the
              result and then withdrawing. If nobody settles before the timer runs out, the
              wager refunds both stakes instead, so you would get your stake back and lose the
              winnings.
            </>
          ) : (
            <>
              Claiming settles each result on chain and moves the ETH to your wallet. A win pays
              the pot less the fee, and expires to a refund if nobody settles before its timer
              runs out. A draw returns your own stake with no fee and no deadline.
            </>
          )}
        </p>
      </div>
      )}

      {error && <div className="uc__error">{error}</div>}

      {credit > 0n && pots.length === 0 && (
        <div className="uc__credit">
          <div className="uc__what">
            <span className="uc__amount">
              {formatEth(credit.toString())} {CURRENCY}
            </span>
            <span className="uc__kind">settled and waiting in the contract</span>
          </div>
          <button className="uc__claim" onClick={() => void withdrawCredit()} disabled={busy !== null}>
            {busy === 'credit' && label ? label : 'Withdraw'}
          </button>
        </div>
      )}

      <ul className="uc__list">
        {pots.map((p) => (
          <li className="uc__row" key={p.wagerId}>
            <div className="uc__what">
              <span className="uc__amount">
                {formatEth(payoutWei(p.kind, p.stakeWei, feeBps).toString())} {CURRENCY}
              </span>
              <span className="uc__kind">
                {p.kind === 'draw' ? 'draw, your stake back' : 'won, after the fee'}
              </span>
              {/* A draw refunds either way, so its timer carries no risk and showing a
                  countdown there only invents urgency. Wins are the case that can expire. */}
              {p.kind === 'win' ? (
                <Countdown at={deadlines[p.onchainId]} />
              ) : (
                <span className="uc__safe">no deadline, a draw refunds either way</span>
              )}
            </div>
            <button
              className="uc__claim"
              onClick={() => void claim(p)}
              disabled={busy !== null || !escrowReady}
              title={escrowReady ? undefined : 'Escrow contract not deployed'}
            >
              {busy === p.wagerId && label ? label : 'Claim'}
            </button>
          </li>
        ))}
      </ul>

      {chainId !== CHAIN_ID && (
        <p className="uc__note">Claiming will switch your wallet to {CHAIN_LABEL}.</p>
      )}
    </section>
  )
}
