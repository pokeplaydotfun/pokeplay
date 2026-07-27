/**
 * Tournaments: single-elimination, played through the normal battle rooms.
 *
 * The bracket maths lives in bracket.ts and is tested on its own. This module
 * is the bookkeeping around it — who is in, which match is playable, and what
 * happens when one ends.
 *
 * Paid entry is backed by PokePlayTournamentPool (see settle-tournament.ts). A
 * paid tournament is created against an on-chain pool tournament; a player joins
 * by paying the pool, and the server seats them only after the contract confirms
 * they paid. The bracket is thus built from the set of on-chain entrants, so the
 * winner-take-all pot can only ever be won by someone who actually paid in. When
 * no pool is configured, `paidEntryAvailable()` is false and only free
 * tournaments run.
 */
import { db, now } from './db.js'
import { advancesTo, autoWinner, fullBracket, roundsFor, type Seed } from './bracket.js'
import { validateTeam, type TeamSlot } from './battle/active.js'
import { tournamentSettlementEnabled } from './settle-tournament.js'

export type TournamentRow = {
  id: number
  name: string
  created_by: string
  entry_fee_wei: string
  max_players: number
  status: 'open' | 'running' | 'finished' | 'cancelled'
  winner: string | null
  created_at: number
  started_at: number | null
  ended_at: number | null
  onchain_id: string | null
  fee_bps: number | null
  settled_onchain: number | null
  start_at: number | null
  prize_usd_cents: number | null
}

export type MatchRow = {
  id: number
  tournament_id: number
  round: number
  slot: number
  p0: string | null
  p1: string | null
  battle_id: string | null
  winner: string | null
  status: 'pending' | 'ready' | 'playing' | 'done'
}

export const MIN_PLAYERS = 2
export const MAX_PLAYERS = 64

/** Admin wallets allowed to create tournaments. Comma-separated, lowercased. */
const ADMINS = new Set(
  (process.env.ADMIN_ADDRESSES ?? '')
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean),
)

export const isAdmin = (address: string) => ADMINS.has(address.toLowerCase())
export const adminCount = () => ADMINS.size

/**
 * Whether entry fees can be held on chain.
 *
 * True once the server is configured with a deployed PokePlayTournamentPool and
 * a valid arbiter key (see settle-tournament.ts). Until then, paid tournaments
 * are refused at creation and only free ones run.
 */
export const paidEntryAvailable = () => tournamentSettlementEnabled

export const get = (id: number) =>
  db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id) as TournamentRow | undefined

export const entriesOf = (id: number) =>
  db.prepare(
    `SELECT e.address, e.team_id, e.seed, u.name
     FROM tournament_entries e LEFT JOIN users u ON u.address = e.address
     WHERE e.tournament_id = ? ORDER BY e.seed`,
  ).all(id) as { address: string; team_id: number; seed: number; name: string | null }[]

export const matchesOf = (id: number) =>
  db.prepare(
    'SELECT * FROM tournament_matches WHERE tournament_id = ? ORDER BY round, slot',
  ).all(id) as MatchRow[]

/** Top tournament winners, for the "Champions" board. Hidden-wallet masking is
 *  applied by the caller (this returns the raw address + hide flag). */
export function champions(limit = 20) {
  return db.prepare(`
    SELECT address, name, COALESCE(hide_wallet, 0) AS hide_wallet, tournament_wins
    FROM users
    WHERE tournament_wins > 0
    ORDER BY tournament_wins DESC, name IS NULL, name
    LIMIT ?
  `).all(limit) as { address: string; name: string | null; hide_wallet: number; tournament_wins: number }[]
}

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

export function create(opts: {
  name: string
  createdBy: string
  maxPlayers: number
  entryFeeWei: string
  /** The PokePlayTournamentPool tournament id, required for a paid tournament. */
  onchainId?: string | null
  /** Unix time sign-ups close and the bracket auto-starts. Null = manual start. */
  startAt?: number | null
  /** An optional prize (US cents) paid by hand on top of the pot. Null = none. */
  prizeUsdCents?: number | null
}): { id: number } | { error: string } {
  const name = opts.name.trim()
  if (name.length < 3 || name.length > 40) return { error: 'Name must be 3–40 characters.' }
  if (!Number.isInteger(opts.maxPlayers) || opts.maxPlayers < MIN_PLAYERS || opts.maxPlayers > MAX_PLAYERS) {
    return { error: `Size must be between ${MIN_PLAYERS} and ${MAX_PLAYERS}.` }
  }

  let prizeUsdCents: number | null = null
  if (opts.prizeUsdCents != null) {
    // Cap at $1,000,000 so a fat-fingered entry can't render as a nonsense pool.
    if (!Number.isInteger(opts.prizeUsdCents) || opts.prizeUsdCents < 0 || opts.prizeUsdCents > 100_000_000) {
      return { error: 'Prize must be a dollar amount between $0 and $1,000,000.' }
    }
    prizeUsdCents = opts.prizeUsdCents || null
  }

  let startAt: number | null = null
  if (opts.startAt != null) {
    if (!Number.isInteger(opts.startAt) || opts.startAt <= now()) {
      return { error: 'Start time must be in the future.' }
    }
    startAt = opts.startAt
  }

  let fee: bigint
  try {
    fee = BigInt(opts.entryFeeWei || '0')
  } catch {
    return { error: 'Invalid entry fee.' }
  }
  if (fee < 0n) return { error: 'Invalid entry fee.' }

  let onchainId: string | null = null
  if (fee > 0n) {
    if (!paidEntryAvailable()) {
      return {
        error:
          'Paid tournaments are not available — the on-chain tournament pool is not ' +
          'configured on this server. Create a free tournament for now.',
      }
    }
    // A paid tournament MUST be backed by an on-chain pool tournament, or there
    // would be nowhere to hold the entry fees and no winner could be paid.
    if (!opts.onchainId) {
      return { error: 'A paid tournament needs its on-chain pool id (onchainId).' }
    }
    try {
      if (BigInt(opts.onchainId) <= 0n) throw new Error('non-positive')
    } catch {
      return { error: 'Invalid on-chain pool id.' }
    }
    onchainId = opts.onchainId
  }

  const info = db.prepare(
    `INSERT INTO tournaments (name, created_by, entry_fee_wei, max_players, status, created_at, onchain_id, start_at, prize_usd_cents)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
  ).run(name, opts.createdBy, fee.toString(), opts.maxPlayers, now(), onchainId, startAt, prizeUsdCents)

  return { id: Number(info.lastInsertRowid) }
}

export function join(
  id: number,
  address: string,
  teamId: number,
  loadTeam: (teamId: number, address: string) => TeamSlot[] | null,
  /**
   * For a PAID tournament, the caller must have already confirmed on chain that
   * this address paid into the pool (see the endpoint's `isOnchainEntrant`
   * check). Seating a paid entrant without that proof would let someone into
   * the bracket — and into a winner-take-all pot — without paying.
   */
  onchainVerified = false,
): { ok: true } | { error: string; status?: number } {
  const t = get(id)
  if (!t) return { error: 'No such tournament.', status: 404 }
  if (t.status !== 'open') return { error: 'Sign-ups are closed.', status: 409 }

  const already = db.prepare(
    'SELECT 1 FROM tournament_entries WHERE tournament_id = ? AND address = ?',
  ).get(id, address)
  if (already) return { error: 'You are already entered.', status: 409 }

  const count = entryCount(id)
  if (count >= t.max_players) return { error: 'This tournament is full.', status: 409 }

  const team = loadTeam(teamId, address)
  if (!team) return { error: 'Team not found or no longer legal.', status: 400 }
  if (validateTeam(team).length) return { error: 'That team is not legal.', status: 400 }

  if (BigInt(t.entry_fee_wei) > 0n && !onchainVerified) {
    // The endpoint verifies the on-chain payment before calling us. Reaching
    // here without that flag means the proof was missing or failed.
    return { error: 'Pay the entry fee on chain before joining.', status: 402 }
  }

  db.prepare(
    `INSERT INTO tournament_entries (tournament_id, address, team_id, seed, joined_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, address, teamId, count, now())

  return { ok: true }
}

export function leave(id: number, address: string): { ok: true } | { error: string } {
  const t = get(id)
  if (!t) return { error: 'No such tournament.' }
  if (t.status !== 'open') return { error: 'The tournament has already started.' }
  dropEntry(id, address)
  return { ok: true }
}

/** Remove one entry and re-pack the seeds so they stay contiguous. */
export function dropEntry(id: number, address: string) {
  db.prepare('DELETE FROM tournament_entries WHERE tournament_id = ? AND address = ?')
    .run(id, address)
  const rest = entriesOf(id)
  rest.forEach((e, i) => {
    db.prepare('UPDATE tournament_entries SET seed = ? WHERE tournament_id = ? AND address = ?')
      .run(i, id, e.address)
  })
}

/**
 * Cancel an OPEN tournament. For a paid tournament the on-chain pool must ALSO
 * be cancelled (or timed out) for entrants to reclaim their fees — that is a
 * wallet action the organizer takes; this only moves the server-side state so
 * the scheduler stops trying to start it and the bracket is never drawn.
 */
export function cancel(id: number): { ok: true } | { error: string } {
  const t = get(id)
  if (!t) return { error: 'No such tournament.' }
  if (t.status !== 'open') return { error: 'Only a tournament that has not started can be cancelled.' }
  db.prepare("UPDATE tournaments SET status = 'cancelled', ended_at = ? WHERE id = ?").run(now(), id)
  return { ok: true }
}

/** Push an open tournament's start time out. Forward only. */
export function extendStart(id: number, startAt: number): { ok: true } | { error: string } {
  const t = get(id)
  if (!t) return { error: 'No such tournament.' }
  if (t.status !== 'open') return { error: 'Only an open tournament can be rescheduled.' }
  if (!Number.isInteger(startAt) || startAt <= now()) return { error: 'New start time must be in the future.' }
  if (t.start_at != null && startAt <= t.start_at) return { error: 'New start time must be later than the current one.' }
  db.prepare('UPDATE tournaments SET start_at = ? WHERE id = ?').run(startAt, id)
  return { ok: true }
}

/** Open tournaments whose scheduled start time has arrived. */
export function dueToStart(): TournamentRow[] {
  return db.prepare(
    "SELECT * FROM tournaments WHERE status = 'open' AND start_at IS NOT NULL AND start_at <= ?",
  ).all(now()) as TournamentRow[]
}

export const entryCount = (id: number) =>
  (db.prepare('SELECT COUNT(*) AS n FROM tournament_entries WHERE tournament_id = ?')
    .get(id) as { n: number }).n

/** Builds the bracket and opens round one. */
export function start(id: number): { ok: true } | { error: string } {
  const t = get(id)
  if (!t) return { error: 'No such tournament.' }
  if (t.status !== 'open') return { error: 'Already started.' }

  const entries = entriesOf(id)
  if (entries.length < MIN_PLAYERS) return { error: `Needs at least ${MIN_PLAYERS} players.` }

  const seeds: Seed[] = entries.map((e) => ({ address: e.address, teamId: e.team_id }))
  const matches = fullBracket(seeds)

  for (const m of matches) {
    db.prepare(
      `INSERT INTO tournament_matches (tournament_id, round, slot, p0, p1, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, m.round, m.slot, m.p0, m.p1, m.round === 1 ? 'ready' : 'pending')
  }

  db.prepare("UPDATE tournaments SET status = 'running', started_at = ? WHERE id = ?")
    .run(now(), id)

  // Byes resolve immediately, which can cascade several rounds deep.
  settleByes(id)
  return { ok: true }
}

/** Advances anyone who has no opponent, repeatedly, until nothing changes. */
function settleByes(id: number) {
  for (let guard = 0; guard < 64; guard++) {
    const open = matchesOf(id).filter((m) => m.status === 'ready' || m.status === 'pending')
    let changed = false
    for (const m of open) {
      // A pending match with both players present becomes playable.
      if (m.status === 'pending' && m.p0 && m.p1) {
        db.prepare("UPDATE tournament_matches SET status = 'ready' WHERE id = ?").run(m.id)
        changed = true
        continue
      }
      const solo = autoWinner(m)
      // Only a round-one bye, or a slot whose feeder finished, can be solo.
      if (solo && m.status === 'ready') {
        recordWinner(id, m, solo, null)
        changed = true
      }
    }
    if (!changed) return
  }
}

/** Records a match result and pushes the winner into the next round. */
export function recordWinner(
  id: number,
  match: MatchRow,
  winner: string,
  battleId: string | null,
) {
  db.prepare(
    "UPDATE tournament_matches SET winner = ?, battle_id = ?, status = 'done' WHERE id = ?",
  ).run(winner, battleId, match.id)

  const players = entryCount(id)
  const next = advancesTo(match.round, match.slot, players)

  if (!next) {
    db.prepare("UPDATE tournaments SET status = 'finished', winner = ?, ended_at = ? WHERE id = ?")
      .run(winner, now(), id)
    // The champion earns a tournament title — a separate tally from battle wins,
    // ranked on its own "Champions" board.
    db.prepare('UPDATE users SET tournament_wins = tournament_wins + 1 WHERE address = ?')
      .run(winner.toLowerCase())
    return
  }

  // The only interpolated identifier in the codebase. `side` comes from the
  // bracket maths and is always 'p0' or 'p1', but assert it rather than trust
  // it — a column name cannot be a bound parameter, so a bug here would be an
  // injection point rather than a wrong answer.
  if (next.side !== 'p0' && next.side !== 'p1') {
    throw new Error(`refusing to build SQL with side ${JSON.stringify(next.side)}`)
  }
  db.prepare(
    `UPDATE tournament_matches SET ${next.side} = ? WHERE tournament_id = ? AND round = ? AND slot = ?`,
  ).run(winner, id, next.round, next.slot)

  const target = db.prepare(
    'SELECT * FROM tournament_matches WHERE tournament_id = ? AND round = ? AND slot = ?',
  ).get(id, next.round, next.slot) as MatchRow | undefined

  if (target && target.p0 && target.p1 && target.status === 'pending') {
    db.prepare("UPDATE tournament_matches SET status = 'ready' WHERE id = ?").run(target.id)
  }
}

/** The match this player can play right now, if any. */
export function playableFor(id: number, address: string): MatchRow | null {
  return (db.prepare(
    `SELECT * FROM tournament_matches
     WHERE tournament_id = ? AND status = 'ready' AND (p0 = ? OR p1 = ?)
     ORDER BY round LIMIT 1`,
  ).get(id, address, address) as MatchRow | undefined) ?? null
}

export const teamOf = (id: number, address: string) =>
  (db.prepare('SELECT team_id FROM tournament_entries WHERE tournament_id = ? AND address = ?')
    .get(id, address) as { team_id: number } | undefined)?.team_id ?? null

/** Called when a tournament battle finishes. */
export function onBattleEnd(matchId: number, winnerAddress: string | null, battleId: string) {
  const m = db.prepare('SELECT * FROM tournament_matches WHERE id = ?').get(matchId) as
    | MatchRow | undefined
  if (!m || m.status === 'done') return

  if (!winnerAddress) {
    // A draw settles nothing, so the match goes back to being playable.
    db.prepare("UPDATE tournament_matches SET status = 'ready', battle_id = ? WHERE id = ?")
      .run(battleId, matchId)
    return
  }

  recordWinner(m.tournament_id, m, winnerAddress, battleId)
  settleByes(m.tournament_id)
}

export const roundCount = (id: number) => roundsFor(entryCount(id))
