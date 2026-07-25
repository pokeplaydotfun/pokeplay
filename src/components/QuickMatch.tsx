import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import '../styles/quickmatch.css'

/**
 * Free-play matchmaking.
 *
 * The wager board only pairs two people who are both looking at it at the same
 * moment and who spot each other's post. This pairs the first two who ask.
 *
 * The poll is load-bearing, not just a UI refresh: the server treats it as the
 * heartbeat that holds your slot, so a closed tab is dropped instead of
 * blocking the next person in line.
 */

type Status =
  | { kind: 'idle' }
  | { kind: 'queued'; position: number; waitingSeconds: number; queued: number }
  | { kind: 'matched'; roomId: string }

const POLL_MS = 3000

export function QuickMatch({
  teamId,
  signedIn,
  onStart,
}: {
  teamId: number | null
  signedIn: boolean
  onStart: (roomId: string) => void
}) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const started = useRef<number | null>(null)

  const queued = status.kind === 'queued'

  const handle = useCallback(
    (s: Status) => {
      setStatus(s)
      if (s.kind === 'matched') {
        started.current = null
        onStart(s.roomId)
      }
    },
    [onStart],
  )

  // Poll only while queued. This is the heartbeat, so it must not stop early.
  useEffect(() => {
    if (!queued) return
    const t = setInterval(() => {
      api.get<Status>('/api/queue/status').then(handle).catch(() => {})
    }, POLL_MS)
    return () => clearInterval(t)
  }, [queued, handle])

  // A local ticker so the wait time moves every second, not every poll.
  useEffect(() => {
    if (!queued) {
      setElapsed(0)
      return
    }
    started.current ??= Date.now()
    const t = setInterval(() => {
      setElapsed(Math.floor((Date.now() - (started.current ?? Date.now())) / 1000))
    }, 1000)
    return () => clearInterval(t)
  }, [queued])

  // Leaving the page should free the slot rather than wait for the sweep.
  useEffect(() => {
    return () => {
      if (started.current !== null) void api.post('/api/queue/leave').catch(() => {})
    }
  }, [])

  const join = async () => {
    setError(null)
    setBusy(true)
    try {
      handle(await api.post<Status>('/api/queue/join', { teamId }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const leave = async () => {
    setBusy(true)
    try {
      await api.post('/api/queue/leave')
      started.current = null
      setStatus({ kind: 'idle' })
    } finally {
      setBusy(false)
    }
  }

  const blocked = !signedIn ? 'Sign in to play' : teamId === null ? 'Build a team first' : null

  return (
    <section className="qm">
      <div className="qm__head">
        <h3>Quick match</h3>
      </div>

      {error && <div className="qm__error">{error}</div>}

      {queued ? (
        <div className="qm__waiting">
          <span className="qm__pulse" aria-hidden="true" />
          <div className="qm__waiting-text">
            <strong>Looking for an opponent…</strong>
            <span>
              {elapsed}s
              {status.queued > 1 ? ` · ${status.queued} in the queue` : ' · you are first in line'}
            </span>
          </div>
          <button className="qm__cancel" onClick={() => void leave()} disabled={busy}>
            Cancel
          </button>
        </div>
      ) : (
        <>
          <p className="qm__body">
            Get paired with the next person looking for a game.
          </p>
          <button
            className="btn btn--dark qm__go"
            onClick={() => void join()}
            disabled={busy || blocked !== null}
            title={blocked ?? undefined}
          >
            {busy ? 'Joining…' : blocked ?? 'Find me a match'}
          </button>
        </>
      )}
    </section>
  )
}
