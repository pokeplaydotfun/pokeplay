import { API_BASE } from '../config'

const TOKEN_KEY = 'slabshowdown.session'

const DEV_KEY = 'slabshowdown.devsession'

/**
 * Sessions normally live in localStorage so they survive across tabs.
 *
 * Dev sessions go in sessionStorage instead, which is scoped to a single tab —
 * that is what lets one person open two windows and play themselves. With
 * localStorage, signing in as the second player would silently replace the
 * first in every tab.
 *
 * sessionStorage is checked first so a dev tab always wins over any
 * wallet session sitting in localStorage.
 */
export const getToken = () => sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY)

export function setToken(t: string | null, dev = false) {
  if (!t) {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(DEV_KEY)
    sessionStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(DEV_KEY)
    return
  }
  if (dev) {
    sessionStorage.setItem(TOKEN_KEY, t)
    sessionStorage.setItem(DEV_KEY, '1')
    return
  }
  localStorage.setItem(TOKEN_KEY, t)
  localStorage.removeItem(DEV_KEY)
}

export const isDevSession = () => sessionStorage.getItem(DEV_KEY) === '1'

export class ApiError extends Error {
  status: number
  details?: string[]

  constructor(message: string, status: number, details?: string[]) {
    super(message)
    this.status = status
    this.details = details
  }
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken()
  const res = await fetch(API_BASE + path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  })

  const body = await res.json().catch(() => null)
  if (!res.ok) {
    // A dead session should not leave the UI in a half-signed-in state.
    if (res.status === 401) setToken(null)
    throw new ApiError(body?.error ?? res.statusText, res.status, body?.details)
  }
  return body as T
}

export const api = {
  get: <T,>(p: string) => request<T>(p),
  post: <T,>(p: string, body?: unknown) =>
    request<T>(p, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  put: <T,>(p: string, body?: unknown) =>
    request<T>(p, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  del: <T,>(p: string) => request<T>(p, { method: 'DELETE' }),
}

/* ------------------------------------------------------------------ */
/* shared types                                                        */
/* ------------------------------------------------------------------ */

export type PokeType = string

export type Species = {
  id: number
  name: string
  types: PokeType[]
  stats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number }
  sprites: { front: string; back: string; frontShiny: string; art: string | null }
  moves: string[]
  abilities: { name: string; hidden: boolean }[]
}

export type Nature = { name: string; up: string | null; down: string | null }
/** `inert` is set when the ability has no effect in this format, and says why. */
export type AbilityInfo = { name: string; text: string; inert: string | null }

export type MoveInfo = {
  name: string
  type: PokeType
  category: 'physical' | 'special' | 'status'
  power: number | null
  accuracy: number | null
  pp: number
  priority: number
  /**
   * Plain-English description of what the move does.
   *
   * Optional because a cached response from an older server will not carry it.
   */
  text?: string
  ailment: string | null
  ailmentChance: number
  statChanges: { stat: string; change: number }[]
  healing: number
  drain: number
}

export type Pokedex = {
  species: Species[]
  moves: Record<string, MoveInfo>
  natures: Nature[]
  abilities: Record<string, AbilityInfo>
}

export type TeamSlot = { speciesId: number; moves: string[]; nature?: string; ability?: string }
export type Team = { id: number; name: string; slots: TeamSlot[]; updated_at: number }

export type Wager = {
  id: number
  creator: string
  creator_name: string | null
  /** True when the creator has hidden their wallet; `creator` is then blank. */
  creator_hidden?: boolean
  stake_wei: string
  status: string
  created_at: number
  expires_at: number
  onchain_id: string | null
  wins: number
  losses: number
}

export type LeaderRow = {
  /** Blank when the player has hidden their wallet — use `name` instead. */
  address: string
  name: string | null
  /** True when the wallet is hidden; `address` is then blank. */
  hidden?: boolean
  /** Ranked wins: capped per opponent, so a two-account farm is worth little. */
  wins: number
  losses: number
  draws: number
  /** Distinct people played. Ranking requires a minimum. */
  opponents: number
  /** Realised profit or loss in wei, from settled paid wagers only. */
  netWei: string
  played: number
  winrate: number
}

export type LeaderRules = { rivalCap: number; minOpponents: number }

export type Me = {
  address: string
  name: string | null
  wins: number
  losses: number
  draws: number
  /** Whether the wallet is hidden from other players. */
  hideWallet: boolean
  /** True until a username has been claimed. Drives the one-time prompt. */
  needsUsername: boolean
}

/** The full profile stat block, from `/api/me/stats`. */
export type MeStats = {
  played: number
  wins: number
  losses: number
  draws: number
  winrate: number
  /** Realised profit or loss in wei, from settled paid wagers. */
  netWei: string
  /** Total value staked across settled paid wagers, in wei. */
  stakedWei: string
  /** Number of settled paid wagers. */
  paidGames: number
}

/** One finished match in the profile's battle history. */
export type MatchRow = {
  id: string
  endedAt: number
  /** Opponent address, or null for practice / a hidden opponent. */
  opponent: string | null
  opponentName: string | null
  opponentHidden: boolean
  practice: boolean
  result: 'win' | 'loss' | 'draw'
  /** This player's stake for the match, in wei. '0' for free play. */
  stakeWei: string
  /** This player's realised P/L for the match, in wei. Signed. */
  net: string
}

/* ------------------------------------------------------------------ */
/* pokedex cache                                                       */
/* ------------------------------------------------------------------ */

let dexPromise: Promise<Pokedex> | null = null

/** The dex is static, so fetch it once per page load and share it. */
export function loadPokedex(): Promise<Pokedex> {
  dexPromise ??= api.get<Pokedex>('/api/pokedex')
  return dexPromise
}

/* ------------------------------------------------------------------ */
/* formatting                                                          */
/* ------------------------------------------------------------------ */

export const titleCase = (s: string) =>
  s.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/**
 * The API returns unix timestamps in SECONDS. Passing one straight to
 * `new Date()` — which expects milliseconds — silently yields January 1970.
 */
export const fromUnix = (seconds: number) => new Date(seconds * 1000)

/** Wei string -> a short ETH string, without pulling in a bignum library. */
export function formatEth(wei: string): string {
  const v = BigInt(wei || '0')
  if (v === 0n) return '0'
  const whole = v / 10n ** 18n
  const frac = (v % 10n ** 18n).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

/**
 * Signed ETH, for profit and loss.
 *
 * `formatEth` takes an unsigned amount, so the sign is handled here and the
 * magnitude formatted as usual. Exact zero renders as a dash: "+0" would imply
 * a settled match that broke even, which is not the same as never having
 * staked anything.
 */
export function formatSignedEth(wei: string): string {
  let v: bigint
  try {
    v = BigInt(wei || '0')
  } catch {
    return '—'
  }
  if (v === 0n) return '—'
  return `${v > 0n ? '+' : '−'}${formatEth((v < 0n ? -v : v).toString())}`
}

export function parseEth(input: string): string {
  const [w, f = ''] = input.trim().split('.')
  if (!/^\d*$/.test(w) || !/^\d*$/.test(f)) throw new Error('invalid amount')
  const frac = (f + '0'.repeat(18)).slice(0, 18)
  return (BigInt(w || '0') * 10n ** 18n + BigInt(frac || '0')).toString()
}
