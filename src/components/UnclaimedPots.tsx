import { useCallback, useEffect, useState } from 'react'
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi'
import { api, formatEth } from '../lib/api'
import { CHAIN_ID, CHAIN_LABEL, CURRENCY } from '../config'
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
  const [pots, setPots] = useState<Unclaimed[]>([])
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<'idle' | 'signing' | 'wallet' | 'confirming'>('idle')

  const { chainId } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const deadlines = useDeadlines(pots)

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

  if (!signedIn || pots.length === 0) return null

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
      <div className="uc__head">
        <h2>You have {pots.length === 1 ? 'a pot' : 'pots'} to collect</h2>
        <p>
          The winnings sit in escrow until you claim them. If nobody claims before the
          timer runs out, both stakes are refunded instead — you would get your stake
          back but lose the winnings.
        </p>
      </div>

      {error && <div className="uc__error">{error}</div>}

      <ul className="uc__list">
        {pots.map((p) => (
          <li className="uc__row" key={p.wagerId}>
            <div className="uc__what">
              <span className="uc__amount">
                {formatEth((BigInt(p.stakeWei) * 2n).toString())} {CURRENCY}
              </span>
              <span className="uc__kind">
                {p.kind === 'draw' ? 'draw — stake refunded' : 'won'}
              </span>
              <Countdown at={deadlines[p.onchainId]} />
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
