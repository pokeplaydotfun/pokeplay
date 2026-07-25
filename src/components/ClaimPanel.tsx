import { useCallback, useEffect, useState } from 'react'
import { usePublicClient, useWriteContract } from 'wagmi'
import { api, formatEth } from '../lib/api'
import { describeTxError, escrowAbi, escrowAddress, isUserRejection, WagerStatus } from '../lib/escrow'
import { Banner, Spinner } from './ui'
import { CURRENCY } from '../config'
import { Address } from './Address'

type Finished = {
  id: number
  onchainId: string
  stakeWei: string
  battleId: string
  endedAt: number
  isDraw: boolean
  winner: string | null
  youWon: boolean
  opponent: string
}

type Settlement =
  | { kind: 'win'; wagerId: string; winner: `0x${string}`; signature: `0x${string}` }
  | { kind: 'draw'; wagerId: string; signature: `0x${string}` }

/** On-chain status per wager, so we only offer to settle what is still ACTIVE. */
type ChainState = Record<string, number | 'unknown'>

/**
 * Settling is a two-step flow and the distinction matters to the user:
 *
 *   settle()   — proves the result to the contract and credits the pot to the
 *                winner's internal balance. Anyone may submit it; the arbiter
 *                signature is the authorisation, not the sender.
 *   withdraw() — moves that credited balance to the wallet.
 *
 * Keeping them separate is what stops a participant with a reverting
 * `receive()` from blocking the other player's settlement.
 */
export function ClaimPanel({
  signedIn,
  balance,
  onBalanceChanged,
  wrongNetwork,
}: {
  signedIn: boolean
  balance: bigint | undefined
  onBalanceChanged: () => void
  wrongNetwork: boolean
}) {
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()

  const [rows, setRows] = useState<Finished[] | null>(null)
  const [chain, setChain] = useState<ChainState>({})
  const [busy, setBusy] = useState<number | null>(null)
  const [step, setStep] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!signedIn) return setRows(null)
    try {
      setRows(await api.get<Finished[]>('/api/wagers/mine/finished'))
    } catch {
      setRows([])
    }
  }, [signedIn])

  useEffect(() => {
    void load()
  }, [load])

  // Read each wager's on-chain status so settled ones drop out of the list.
  useEffect(() => {
    if (!rows?.length || !publicClient || !escrowAddress) return
    let cancelled = false

    void (async () => {
      const next: ChainState = {}
      for (const r of rows) {
        try {
          next[r.onchainId] = Number(
            await publicClient.readContract({
              address: escrowAddress,
              abi: escrowAbi,
              functionName: 'statusOf',
              args: [BigInt(r.onchainId)],
            }),
          )
        } catch {
          // An unreadable status must not hide the row — show it and let the
          // transaction itself be the source of truth.
          next[r.onchainId] = 'unknown'
        }
      }
      if (!cancelled) setChain(next)
    })()

    return () => {
      cancelled = true
    }
  }, [rows, publicClient])

  async function claim(row: Finished) {
    setError(null)
    setNotice(null)
    setBusy(row.id)

    try {
      if (!escrowAddress) throw new Error('No escrow contract is configured.')

      setStep('Fetching the signed result…')
      const s = await api.get<Settlement>(`/api/wagers/${row.id}/settlement`)

      setStep('Confirm in your wallet…')
      const hash = await (s.kind === 'draw'
        ? writeContractAsync({
            address: escrowAddress,
            abi: escrowAbi,
            functionName: 'settleDraw',
            args: [BigInt(s.wagerId), s.signature],
          })
        : writeContractAsync({
            address: escrowAddress,
            abi: escrowAbi,
            functionName: 'settle',
            args: [BigInt(s.wagerId), s.winner, s.signature],
          }))

      setStep('Waiting for confirmation…')
      const receipt = await publicClient!.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('The transaction reverted on-chain.')

      setNotice(
        s.kind === 'draw'
          ? 'Draw settled — both stakes refunded. Withdraw below.'
          : 'Result settled on-chain. The pot is now withdrawable below.',
      )
      onBalanceChanged()
      await load()
    } catch (e) {
      setError(
        isUserRejection(e) ? 'You rejected the transaction in your wallet.' : describeTxError(e),
      )
    } finally {
      setBusy(null)
      setStep(null)
    }
  }

  async function withdraw() {
    setError(null)
    setNotice(null)
    setBusy(-1)
    try {
      if (!escrowAddress) throw new Error('No escrow contract is configured.')
      setStep('Confirm in your wallet…')
      const hash = await writeContractAsync({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'withdraw',
      })
      setStep('Waiting for confirmation…')
      await publicClient!.waitForTransactionReceipt({ hash })
      setNotice('Withdrawn to your wallet.')
      onBalanceChanged()
    } catch (e) {
      setError(
        isUserRejection(e) ? 'You rejected the transaction in your wallet.' : describeTxError(e),
      )
    } finally {
      setBusy(null)
      setStep(null)
    }
  }

  if (!signedIn || !escrowAddress) return null
  if (rows === null) return null

  // Still ACTIVE on-chain means the result has not been proved to the contract.
  const claimable = rows.filter((r) => {
    const st = chain[r.onchainId]
    return st === WagerStatus.ACTIVE || st === 'unknown'
  })

  const hasBalance = (balance ?? 0n) > 0n
  if (!claimable.length && !hasBalance) return null

  return (
    <div className="card claim">
      <div className="eyebrow">Payouts</div>
      <h3 className="claim__title">You have winnings to collect.</h3>

      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="info">{notice}</Banner>}
      {wrongNetwork && <Banner kind="warn">Switch to the right network to claim.</Banner>}

      {claimable.length > 0 && (
        <>
          <p className="claim__note">
            These matches have finished but the result has not been proved to the escrow contract
            yet. Settling credits the pot to you; withdrawing moves it to your wallet.
          </p>
          <ul className="claim__list">
            {claimable.map((r) => (
              <li className="claim__row" key={r.id}>
                <div>
                  <div className="claim__match">
                    {r.isDraw ? 'Draw' : r.youWon ? 'You won' : 'You lost'} · vs{' '}
                    <Address value={r.opponent} />
                  </div>
                  <div className="claim__meta">
                    Wager #{r.onchainId} · {formatEth(r.stakeWei)} {CURRENCY} staked each side
                  </div>
                </div>
                {r.youWon || r.isDraw ? (
                  <button
                    className="btn btn--dark"
                    disabled={busy !== null || wrongNetwork}
                    onClick={() => void claim(r)}
                  >
                    {busy === r.id ? (step ?? 'Working…') : r.isDraw ? 'Settle draw' : 'Claim pot'}
                  </button>
                ) : (
                  // The loser gains nothing by settling, but allowing it means a
                  // match can always be closed out by either side.
                  <button
                    className="btn btn--ghost"
                    disabled={busy !== null || wrongNetwork}
                    onClick={() => void claim(r)}
                    title="Closes the wager out and pays the winner"
                  >
                    {busy === r.id ? (step ?? 'Working…') : 'Settle'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {hasBalance && (
        <div className="claim__withdraw">
          <div>
            <div className="claim__match">
              {formatEth((balance ?? 0n).toString())} {CURRENCY} ready to withdraw
            </div>
            <div className="claim__meta">Held in the escrow contract under your address.</div>
          </div>
          <button
            className="btn btn--dark"
            disabled={busy !== null || wrongNetwork}
            onClick={() => void withdraw()}
          >
            {busy === -1 ? (step ?? 'Working…') : 'Withdraw'}
          </button>
        </div>
      )}

      {busy !== null && step && <Spinner label={step} />}
    </div>
  )
}
