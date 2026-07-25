/**
 * Single-elimination brackets.
 *
 * Kept as pure functions over plain data so the awkward parts — byes, odd
 * player counts, who advances where — can be tested without a database or a
 * running battle. Every real bug in a tournament shows up here first.
 */

export type Seed = { address: string; teamId: number }

export type Match = {
  round: number
  /** Position within the round, 0-based. Winner of slot n feeds slot n>>1. */
  slot: number
  p0: string | null
  p1: string | null
  /** Set when one side has no opponent and advances for free. */
  bye: boolean
}

/** Rounds needed for `n` players: the next power of two above them. */
export function roundsFor(n: number): number {
  if (n < 2) return 0
  return Math.ceil(Math.log2(n))
}

export const bracketSize = (n: number) => (n < 2 ? 0 : 2 ** roundsFor(n))

/**
 * Seeds players into the first round.
 *
 * Byes go to the players seeded first, which is the standard convention: the
 * bracket is padded to a power of two and the empty slots sit against the top
 * seeds so the strongest do not meet in round one.
 *
 * `order` is taken as the seeding order, so the caller decides whether that is
 * signup order, a shuffle, or a ranking.
 */
export function firstRound(order: Seed[]): Match[] {
  const n = order.length
  if (n < 2) return []

  const size = bracketSize(n)
  const byes = size - n

  // Standard bracket pairing: 1 vs last, 2 vs second-last, and so on.
  const slots: (Seed | null)[] = []
  for (let i = 0; i < size / 2; i++) {
    slots.push(order[i] ?? null)
    const opponentIndex = size - 1 - i
    slots.push(opponentIndex < n ? order[opponentIndex] : null)
  }

  const matches: Match[] = []
  for (let i = 0; i < size / 2; i++) {
    const a = slots[i * 2] ?? null
    const b = slots[i * 2 + 1] ?? null
    matches.push({
      round: 1,
      slot: i,
      p0: a?.address ?? null,
      p1: b?.address ?? null,
      bye: Boolean(a) !== Boolean(b),
    })
  }

  // Sanity: every player must appear exactly once, and byes must match.
  const seen = matches.flatMap((m) => [m.p0, m.p1]).filter(Boolean)
  if (seen.length !== n) {
    throw new Error(`bracket lost players: seeded ${n}, placed ${seen.length}`)
  }
  if (matches.filter((m) => m.bye).length !== byes) {
    throw new Error('bye count does not match the bracket padding')
  }
  return matches
}

/** The empty shell of every later round, so the whole bracket is visible up front. */
export function laterRounds(playerCount: number): Match[] {
  const size = bracketSize(playerCount)
  const out: Match[] = []
  for (let round = 2; round <= roundsFor(playerCount); round++) {
    const inRound = size / 2 ** round
    for (let slot = 0; slot < inRound; slot++) {
      out.push({ round, slot, p0: null, p1: null, bye: false })
    }
  }
  return out
}

export const fullBracket = (order: Seed[]): Match[] => [
  ...firstRound(order),
  ...laterRounds(order.length),
]

/** Where the winner of (round, slot) goes next. Null means they won it all. */
export function advancesTo(
  round: number,
  slot: number,
  playerCount: number,
): { round: number; slot: number; side: 'p0' | 'p1' } | null {
  if (round >= roundsFor(playerCount)) return null
  return {
    round: round + 1,
    slot: slot >> 1,
    // Even slots feed the top half of the next match, odd the bottom.
    side: slot % 2 === 0 ? 'p0' : 'p1',
  }
}

/**
 * The winner of a match that needs no battle: a bye, or a walkover.
 *
 * Takes only the two sides so it works on a database row as well as a Match.
 */
export function autoWinner(m: { p0: string | null; p1: string | null }): string | null {
  if (m.p0 && m.p1) return null
  return m.p0 ?? m.p1 ?? null
}
