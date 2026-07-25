/**
 * Free-play matchmaking.
 *
 * The wager board only pairs people who happen to be looking at it at the same
 * moment and who notice each other's post. A queue pairs the first two people
 * who want a game, which is the difference between "there is nobody to play"
 * and "wait a few seconds".
 *
 * Deliberately free matches only. Pairing stakes means two people have to agree
 * an amount and both get an on-chain transaction in before either can back out,
 * which is a different problem with real money attached — the wager board
 * already handles that case explicitly.
 *
 * State is in memory: a restart empties the queue, which is correct. A queued
 * player who is no longer connected has nothing to resume.
 */
import { createRoom, roomForPlayer } from './rooms.js'
import type { TeamSlot } from './battle/active.js'

type Waiting = {
  address: string
  teamId: number
  team: TeamSlot[]
  since: number
  /** Bumped by /api/queue/status; a caller who stops polling is dropped. */
  seen: number
}

/** How long without a poll before a queued player is assumed gone. */
const STALE_SECONDS = 20

const waiting = new Map<string, Waiting>()

const now = () => Math.floor(Date.now() / 1000)

/** Drops anyone who stopped polling — a closed tab must not hold a slot. */
function sweep() {
  const cutoff = now() - STALE_SECONDS
  for (const [address, w] of waiting) {
    if (w.seen < cutoff) waiting.delete(address)
  }
}

export type JoinResult =
  | { kind: 'queued'; position: number }
  | { kind: 'matched'; roomId: string; opponent: string }
  | { kind: 'error'; error: string }

/**
 * Joins the queue, or pairs immediately with whoever has waited longest.
 *
 * Pairing happens inside this call rather than on a timer so there is no window
 * where two people are both "queued" and neither is matched.
 */
export function join(address: string, teamId: number, team: TeamSlot[]): JoinResult {
  sweep()

  if (roomForPlayer(address)) return { kind: 'error', error: 'you are already in a battle' }

  // Re-joining just refreshes the existing entry.
  const mine = waiting.get(address)
  if (mine) {
    mine.seen = now()
    mine.teamId = teamId
    mine.team = team
    return { kind: 'queued', position: position(address) }
  }

  // Longest wait first, so the queue is fair rather than a scramble.
  const candidates = [...waiting.values()].sort((a, b) => a.since - b.since)
  const opponent = candidates.find((w) => w.address !== address && !roomForPlayer(w.address))

  if (!opponent) {
    waiting.set(address, { address, teamId, team, since: now(), seen: now() })
    return { kind: 'queued', position: position(address) }
  }

  waiting.delete(opponent.address)
  const room = createRoom(
    { address: opponent.address, team: opponent.team },
    { address, team },
    null,
    '0',
  )
  matched.set(opponent.address, room.id)
  return { kind: 'matched', roomId: room.id, opponent: opponent.address }
}

/**
 * Rooms created for a player who was waiting, so their next poll can be told
 * where to go. Cleared as soon as it is read.
 */
const matched = new Map<string, string>()

export function leave(address: string) {
  waiting.delete(address)
  matched.delete(address)
}

function position(address: string): number {
  const order = [...waiting.values()].sort((a, b) => a.since - b.since)
  return order.findIndex((w) => w.address === address) + 1
}

export type Status =
  | { kind: 'idle' }
  | { kind: 'queued'; position: number; waitingSeconds: number; queued: number }
  | { kind: 'matched'; roomId: string }

/** Polled by a waiting client; also the heartbeat that keeps their slot. */
export function status(address: string): Status {
  const room = matched.get(address)
  if (room) {
    matched.delete(address)
    return { kind: 'matched', roomId: room }
  }

  // Someone paired while we were away, or a battle started another way.
  const active = roomForPlayer(address)
  if (active) {
    waiting.delete(address)
    return { kind: 'matched', roomId: active.id }
  }

  sweep()
  const mine = waiting.get(address)
  if (!mine) return { kind: 'idle' }

  mine.seen = now()
  return {
    kind: 'queued',
    position: position(address),
    waitingSeconds: now() - mine.since,
    queued: waiting.size,
  }
}

/** For /api/stats, so the lobby can say whether anyone is looking for a game. */
export function queueSize(): number {
  sweep()
  return waiting.size
}
