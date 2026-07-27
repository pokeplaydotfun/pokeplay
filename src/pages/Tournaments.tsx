import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { parseEther } from 'viem'
import { usePublicClient, useWriteContract } from 'wagmi'
import { api, formatEth, fromUnix, formatStart, toLocalInput, usdCentsToEth, formatEthAmount } from '../lib/api'
import { useSession } from '../lib/session'
import { CURRENCY } from '../config'
import { describeTxError, isUserRejection } from '../lib/escrow'
import { poolAbi, poolAddress, poolReady, tournamentIdFromReceipt } from '../lib/tournamentPool'
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
  startAt: number | null
  prizeUsdCents: number | null
}

type List = {
  canCreate: boolean
  paidEntryAvailable: boolean
  ethUsd: number | null
  tournaments: Row[]
}

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

        {data?.canCreate && (
          <CreateForm paid={data.paidEntryAvailable} ethUsd={data.ethUsd} onCreated={load} />
        )}

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
                    {t.prizeUsdCents ? (
                      <span className="tn__prize-tag">
                        🏆 ${(t.prizeUsdCents / 100).toLocaleString()} prize
                      </span>
                    ) : null}
                    <span className="tn__when">
                      {t.status === 'open' && t.startAt
                        ? `Starts ${formatStart(t.startAt)}`
                        : fromUnix(t.createdAt).toLocaleDateString()}
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

function CreateForm({
  paid, ethUsd, onCreated,
}: {
  paid: boolean
  ethUsd: number | null
  onCreated: () => void
}) {
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()

  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [size, setSize] = useState(8)
  const [feeEth, setFeeEth] = useState('') // blank/0 = free
  // An optional prize set in DOLLARS, paid by hand on top of the pot.
  const [prizeUsd, setPrizeUsd] = useState('')
  // The exact local date+time the bracket is drawn. Defaults to 24h out.
  const [startLocal, setStartLocal] = useState(() => toLocalInput(new Date(Date.now() + 24 * 3600 * 1000)))
  // Free tournaments may skip a scheduled time and be started by hand instead.
  const [manual, setManual] = useState(false)
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

  // "Start it myself" is only offered for free tournaments — a paid one needs an
  // on-chain deadline, so it always runs on a schedule.
  const canManual = feeWei === 0n
  const isManual = canManual && manual
  const timed = !isManual
  const startMs = new Date(startLocal).getTime()
  const startAtSec = timed && Number.isFinite(startMs) ? Math.floor(startMs / 1000) : null
  // A scheduled start must be in the future — with a small cushion so a paid
  // tournament's create tx has time to mine before its own registration deadline.
  const startError =
    timed && (startAtSec === null || startAtSec <= Math.floor(Date.now() / 1000) + 60)
      ? 'Pick a start time at least a minute from now.'
      : null

  // Optional prize, entered in dollars, stored as cents. Paid out by hand.
  let prizeUsdCents: number | null = null
  let prizeError: string | null = null
  if (prizeUsd.trim()) {
    const dollars = Number(prizeUsd.trim())
    if (!Number.isFinite(dollars) || dollars < 0) prizeError = 'Prize must be a dollar amount.'
    else if (dollars > 1_000_000) prizeError = 'Prize is capped at $1,000,000.'
    else prizeUsdCents = Math.round(dollars * 100) || null
  }
  const prizeEth = prizeUsdCents ? usdCentsToEth(prizeUsdCents, ethUsd) : null

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
          // The pool's registration deadline IS the scheduled start, so sign-ups
          // close on chain at the exact moment the bracket is drawn server-side.
          args: [feeWei, size, BigInt(startAtSec!)],
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
        prizeUsdCents,
      })
      setName('')
      setFeeEth('')
      setPrizeUsd('')
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

      <label className="tn__label" htmlFor="tn-prize">Prize (USD) — optional, paid by you manually</label>
      <input
        id="tn-prize"
        className="tn__input"
        value={prizeUsd}
        onChange={(e) => setPrizeUsd(e.target.value)}
        placeholder="e.g. 500"
        inputMode="decimal"
      />
      {prizeUsdCents ? (
        <p className="tn__note">
          Prize pool shows as{' '}
          <strong>
            {prizeEth != null ? `≈ ${formatEthAmount(prizeEth)} ${CURRENCY}` : `${CURRENCY} —`}
          </strong>{' '}
          (${(prizeUsdCents / 100).toLocaleString()}).{' '}
          {feeWei > 0n
            ? 'Added on top of the entry pot. Entries still pay out on chain automatically; you pay this prize by hand to the winner.'
            : 'You pay this to the winner by hand — their wallet address is shown on the tournament once it finishes.'}
        </p>
      ) : (
        <p className="tn__note">Leave blank for no added prize.</p>
      )}

      <label className="tn__label" htmlFor="tn-start">Start date &amp; time</label>
      <input
        id="tn-start"
        className="tn__input"
        type="datetime-local"
        value={startLocal}
        min={toLocalInput(new Date())}
        disabled={isManual}
        onChange={(e) => setStartLocal(e.target.value)}
      />
      {canManual && (
        <label className="tn__check">
          <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} />
          Start it myself instead (no scheduled time)
        </label>
      )}
      <p className="tn__note">
        {timed
          ? `The bracket is drawn at ${startAtSec ? formatStart(startAtSec) : 'the chosen time'}, with whoever has joined (at least two). You can push it back or cancel it beforehand — it never starts early.`
          : 'You start it by hand once enough players have joined.'}
      </p>

      {startError && <div className="tn__error">{startError}</div>}
      {feeError && <div className="tn__error">{feeError}</div>}
      {prizeError && <div className="tn__error">{prizeError}</div>}
      {error && <div className="tn__error">{error}</div>}

      <div className="tn__create-actions">
        <button
          className="btn btn--dark"
          onClick={() => void create()}
          disabled={busy || !name.trim() || feeError !== null || startError !== null || prizeError !== null}
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
