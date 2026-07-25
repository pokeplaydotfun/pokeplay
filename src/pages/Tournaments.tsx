import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { parseEther } from 'viem'
import { usePublicClient, useWriteContract } from 'wagmi'
import { api, formatEth, fromUnix } from '../lib/api'
import { useSession } from '../lib/session'
import { CURRENCY } from '../config'
import { describeTxError, isUserRejection } from '../lib/escrow'
import { deadlineFromNow, poolAbi, poolAddress, poolReady, tournamentIdFromReceipt } from '../lib/tournamentPool'
import { Banner, Empty, Spinner } from '../components/ui'
import '../styles/tournaments.css'

type Row = {
  id: number
  name: string
  entryFeeWei: string
  maxPlayers: number
  players: number
  status: 'open' | 'running' | 'finished' | 'cancelled'
  winner: string | null
  createdAt: number
}

type List = { canCreate: boolean; paidEntryAvailable: boolean; tournaments: Row[] }

const STATUS_LABEL: Record<Row['status'], string> = {
  open: 'Sign-ups open',
  running: 'In progress',
  finished: 'Finished',
  cancelled: 'Cancelled',
}

export default function Tournaments() {
  const { signedIn } = useSession()
  const [data, setData] = useState<List | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await api.get<List>('/api/tournaments'))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 15_000)
    return () => clearInterval(t)
  }, [load, signedIn])

  return (
    <section className="section">
      <div className="wrap">
        <div className="section-head section-head--center">
          <div>
            <div className="eyebrow">Tournaments</div>
            <h2>Single elimination</h2>
            <p className="lede">
              Register your team, play each match as the tournament progresses and keep winning to
              advance through the bracket until a champion is crowned.
            </p>
          </div>
        </div>

        {error && <Banner kind="error">Could not load tournaments: {error}</Banner>}

        {data?.canCreate && <CreateForm paid={data.paidEntryAvailable} onCreated={load} />}

        {data === null && !error ? (
          <Spinner label="Loading tournaments…" />
        ) : data && data.tournaments.length === 0 ? (
          <Empty
            title="No tournaments yet"
            body="When one is posted it will show up here, with sign-ups open."
          />
        ) : (
          <ul className="tn__list">
            {data?.tournaments.map((t) => (
              <li key={t.id}>
                <Link className={`tn__row tn__row--${t.status}`} to={`/tournaments/${t.id}`}>
                  <div className="tn__row-main">
                    <span className="tn__name">{t.name}</span>
                    <span className={`tn__status tn__status--${t.status}`}>
                      {STATUS_LABEL[t.status]}
                    </span>
                  </div>
                  <div className="tn__row-meta">
                    <span>
                      <strong>{t.players}</strong>/{t.maxPlayers} players
                    </span>
                    <span>
                      {BigInt(t.entryFeeWei) > 0n
                        ? `${formatEth(t.entryFeeWei)} ${CURRENCY} entry`
                        : 'Free entry'}
                    </span>
                    <span className="tn__when">
                      {fromUnix(t.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */

function CreateForm({ paid, onCreated }: { paid: boolean; onCreated: () => void }) {
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()

  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [size, setSize] = useState(8)
  const [feeEth, setFeeEth] = useState('') // blank/0 = free
  const [closeInS, setCloseInS] = useState(24 * 3600) // sign-ups close after this; 0 = manual
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Paid tournaments are only offered when the server has a pool AND the
  // frontend knows its address — both must be true to run the on-chain create.
  const canCharge = paid && poolReady

  let feeWei = 0n
  let feeError: string | null = null
  if (feeEth.trim()) {
    try {
      feeWei = parseEther(feeEth.trim() as `${number}`)
      if (feeWei < 0n) feeError = 'Entry fee cannot be negative.'
    } catch {
      feeError = 'Entry fee must be a number.'
    }
  }

  // A paid tournament always closes on a timer (the pool needs an on-chain
  // deadline); a free one may be left for the admin to start by hand.
  const timed = feeWei > 0n || closeInS > 0
  const startAtSec = timed ? Math.floor(Date.now() / 1000) + closeInS : null

  const create = async () => {
    setError(null)
    setBusy(true)
    try {
      // A paid tournament is opened on the pool first, then registered on the
      // server with the on-chain id, so the two can never disagree about which
      // pool holds the money. The pool's registration deadline == the server's
      // start time, so sign-ups close in both places at the same moment.
      let onchainId: string | null = null
      if (feeWei > 0n) {
        if (!canCharge || !poolAddress) {
          throw new Error('Paid tournaments are not available on this deployment.')
        }
        setStep('Confirm the pool creation in your wallet…')
        const hash = await writeContractAsync({
          address: poolAddress,
          abi: poolAbi,
          functionName: 'createTournament',
          args: [feeWei, size, deadlineFromNow(closeInS)],
        })
        setStep('Waiting for confirmation…')
        const receipt = await publicClient!.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') throw new Error('The pool transaction reverted on-chain.')
        const id = tournamentIdFromReceipt(receipt)
        if (id === null) throw new Error('Could not read the new tournament id from the receipt.')
        onchainId = id.toString()
      }

      setStep('Posting the tournament…')
      await api.post('/api/tournaments', {
        name,
        maxPlayers: size,
        entryFeeWei: feeWei.toString(),
        onchainId,
        startAt: startAtSec,
      })
      setName('')
      setFeeEth('')
      setOpen(false)
      onCreated()
    } catch (e) {
      setError(isUserRejection(e) ? 'You rejected the transaction in your wallet.' : describeTxError(e))
    } finally {
      setBusy(false)
      setStep(null)
    }
  }

  if (!open) {
    return (
      <div className="tn__admin">
        <button className="btn btn--dark" onClick={() => setOpen(true)}>
          Post a tournament
        </button>
      </div>
    )
  }

  return (
    <div className="tn__create card">
      <h3>Post a tournament</h3>

      <label className="tn__label" htmlFor="tn-name">Name</label>
      <input
        id="tn-name"
        className="tn__input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Launch Cup"
        maxLength={40}
      />

      <label className="tn__label" htmlFor="tn-size">Players</label>
      <select
        id="tn-size"
        className="tn__input"
        value={size}
        onChange={(e) => setSize(Number(e.target.value))}
      >
        {[4, 8, 16, 32, 64].map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>

      {canCharge ? (
        <>
          <label className="tn__label" htmlFor="tn-fee">Entry fee ({CURRENCY}) — leave blank for free</label>
          <input
            id="tn-fee"
            className="tn__input"
            value={feeEth}
            onChange={(e) => setFeeEth(e.target.value)}
            placeholder="0.01"
            inputMode="decimal"
          />
          {feeWei > 0n && (
            <p className="tn__note">
              You’ll open the prize pool on chain (one wallet transaction). Winner takes the whole
              pot minus the house fee; if it never runs, entrants reclaim their fee after the
              timeout.
            </p>
          )}
        </>
      ) : (
        <p className="tn__note">
          Entry is free. {paid && !poolReady
            ? 'Paid tournaments are enabled on the server but this build has no pool address configured.'
            : 'Paid tournaments need the on-chain pool, which is not available on this deployment.'}
        </p>
      )}

      <label className="tn__label" htmlFor="tn-close">Sign-ups close</label>
      <select
        id="tn-close"
        className="tn__input"
        value={closeInS}
        onChange={(e) => setCloseInS(Number(e.target.value))}
      >
        <option value={3600}>in 1 hour</option>
        <option value={3 * 3600}>in 3 hours</option>
        <option value={12 * 3600}>in 12 hours</option>
        <option value={24 * 3600}>in 24 hours</option>
        {feeWei === 0n && <option value={0}>no timer — I’ll start it</option>}
      </select>
      <p className="tn__note">
        {timed
          ? 'It starts automatically when sign-ups close, with whoever has joined (at least 2). You can extend or cancel it before then.'
          : 'You start it by hand once enough players have joined.'}
      </p>

      {feeError && <div className="tn__error">{feeError}</div>}
      {error && <div className="tn__error">{error}</div>}

      <div className="tn__create-actions">
        <button
          className="btn btn--dark"
          onClick={() => void create()}
          disabled={busy || !name.trim() || feeError !== null}
        >
          {busy ? (step ?? 'Posting…') : feeWei > 0n ? 'Open pool & post' : 'Post it'}
        </button>
        <button className="btn btn--ghost" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>

      {busy && step && <Spinner label={step} />}
    </div>
  )
}
