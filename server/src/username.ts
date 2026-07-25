/**
 * Username rules.
 *
 * A username is claimed once, signed by the wallet, and never changes. That
 * makes validation load-bearing: there is no editing your way out of a name
 * you regret, and no admin rename endpoint to lean on.
 */

export const MIN_LENGTH = 3
export const MAX_LENGTH = 16

/**
 * Letters, digits and underscores. Deliberately narrow: spaces and dots invite
 * lookalike names, and a name that renders differently from how it is stored
 * makes impersonation easy.
 */
const SHAPE = /^[A-Za-z0-9_]+$/

/**
 * Names nobody may claim.
 *
 * Impersonating the site or its staff is the obvious abuse, and it costs
 * nothing to close off. Matching is case-insensitive.
 */
const RESERVED = new Set([
  'admin', 'administrator', 'mod', 'moderator', 'staff', 'support', 'help',
  'official', 'system', 'root', 'owner', 'team', 'pokeplay', 'poke_play',
  'pokeplayfun', 'escrow', 'treasury', 'arbiter', 'bot', 'ai', 'practice',
  'null', 'undefined', 'anon', 'anonymous', 'deleted', 'me', 'you',
])

export type Check = { ok: true } | { ok: false; error: string }

/** Validates the shape of a name. Says nothing about whether it is taken. */
export function checkUsername(name: unknown): Check {
  if (typeof name !== 'string') return { ok: false, error: 'Pick a username.' }

  const trimmed = name.trim()
  if (trimmed !== name) return { ok: false, error: 'No spaces at the start or end.' }
  if (trimmed.length < MIN_LENGTH) {
    return { ok: false, error: `At least ${MIN_LENGTH} characters.` }
  }
  if (trimmed.length > MAX_LENGTH) {
    return { ok: false, error: `At most ${MAX_LENGTH} characters.` }
  }
  if (!SHAPE.test(trimmed)) {
    return { ok: false, error: 'Letters, numbers and underscores only.' }
  }
  if (/^_|_$/.test(trimmed)) {
    return { ok: false, error: 'Cannot start or end with an underscore.' }
  }
  if (/^0x/i.test(trimmed)) {
    return { ok: false, error: 'Cannot look like a wallet address.' }
  }
  if (RESERVED.has(trimmed.toLowerCase())) {
    return { ok: false, error: 'That name is reserved.' }
  }
  return { ok: true }
}
