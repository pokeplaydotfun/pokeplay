/**
 * Site-wide configuration. Brand, chain and token settings live here.
 *
 * Anything that is not live yet is `null`/empty on purpose — the UI renders an
 * honest placeholder rather than a made-up number.
 */

export const BRAND = {
  name: 'PokePlay',
  /** Rendered in the accent colour; must be a suffix of `name`. */
  accentWord: 'Play',
  tagline: 'Build a team. Post a wager. Battle for it.',
  url: 'https://pokeplay.fun',
  /** Fill these in to activate the footer buttons. Empty renders them inert. */
  twitter: 'https://x.com/pokeplayrh',
  github: '',
}

/**
 * Chain settings. Overridable so the whole stack can be pointed at the
 * Robinhood testnet (46630) for a dry run without a code change.
 */
export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 4663)
export const IS_TESTNET = CHAIN_ID !== 4663
export const CHAIN_LABEL = IS_TESTNET ? 'Robinhood Testnet' : 'Robinhood Chain'
export const CURRENCY = 'ETH'
export const EXPLORER = (import.meta.env.VITE_EXPLORER ??
  'https://robinhoodchain.blockscout.com') as string

export const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:8090'

/**
 * Whether to even look for the dev-login endpoints.
 *
 * The server returns 404 for them unless DEV_LOGIN=1, so probing in production
 * put a failed request in every visitor's console for no reason. Dev builds
 * still probe; a production build can opt in with VITE_DEV_LOGIN=1.
 */
export const DEV_LOGIN_POSSIBLE =
  import.meta.env.DEV || import.meta.env.VITE_DEV_LOGIN === '1'

/**
 * Escrow contract address, set after deployment.
 * Empty means wagering is display-only and the UI says so.
 */
// The deployed PokePlayEscrow on Robinhood Chain (mainnet, 4663). A public,
// permanent address, so it is the default; a testnet/local build overrides it
// with VITE_ESCROW_ADDRESS.
export const ESCROW_ADDRESS = (import.meta.env.VITE_ESCROW_ADDRESS ??
  '0xdE1405268a4194853573b5cF4270CaAEDaeCdAA0') as string

// The deployed PokePlayTournamentPool on Robinhood Chain (mainnet, 4663). Public
// and permanent, so it is the default; a testnet/local build overrides it with
// VITE_TOURNAMENT_POOL_ADDRESS. The paid-tournament UI still only appears when
// the SERVER also reports paid entry available, so this default alone turns
// nothing on.
export const TOURNAMENT_POOL_ADDRESS = (import.meta.env.VITE_TOURNAMENT_POOL_ADDRESS ??
  '0x4d75665a2c461b3c115c353a845f0dd2fc11f6ad') as string

/** The token, to be launched on Pons. Empty renders as "TBA". */
export const TOKEN = {
  ticker: '$PLAY',
  address: (import.meta.env.VITE_TOKEN_ADDRESS ?? '') as string,
  launchpad: 'Pons',
  /** Live figures are read on-chain; null until the token exists. */
  marketCapUsd: null as number | null,
  feesCollectedUsd: null as number | null,
  holders: null as number | null,
}

export const NAV = [
  { label: 'Play', to: '/play' },
  { label: 'Tournaments', to: '/tournaments' },
  { label: 'Leaderboard', to: '/leaderboard' },
  { label: 'Token', to: '/token' },
  { label: 'Guide', to: '/guide' },
]

export const HERO = {
  eyebrows: [`LIVE ON ${CHAIN_LABEL.toUpperCase()}`],
  headline: ['Build a team of six'],
  sub: `Build a team of six from the original 151, play for free or stake ${CURRENCY}, and battle other players. The winner takes the whole pot, settled on ${CHAIN_LABEL}.`,
}

export const STEPS = [
  {
    n: '01',
    title: 'Build your team',
    body: 'Six Pokémon from the original 151, four moves each.',
  },
  {
    n: '02',
    title: 'Post or accept a match',
    body: `Create a match for free or stake your ${CURRENCY}.`,
  },
  {
    n: '03',
    title: 'Battle',
    body: 'A turn based 6v6 fought on our server. Winner takes the pot.',
  },
]

export const FAQ = [
  {
    q: 'How do I know the battle is fair?',
    a: "Before a match begins, a commitment is created to lock in the battle randomness. Once the match ends, that randomness is revealed, allowing anyone to verify that every attack, critical hit, damage roll, and status effect was determined fairly and wasn't changed during the game.",
  },
  {
    q: 'Where is my stake held?',
    a: `In an escrow contract on ${CHAIN_LABEL}. Both sides deposit the same amount, and the contract releases the pot to the winner. If a match never starts, either player can reclaim their own stake after a timeout.`,
  },
  {
    q: 'Who decides who won?',
    a: 'The battle is securely processed on our server, which confirms the result to the escrow contract so the winner can be paid automatically. Our server acts as the trusted referee for each match. If a match cannot begin due to a technical issue before the battle starts, a timeout refund mechanism automatically returns both players funds so they are never left locked in escrow.',
  },
  {
    q: 'What happens if I disconnect?',
    a: "If you disconnect during a battle, you have 30 seconds to reconnect. Simply reopen the game and you'll continue right where you left off. If you don't return within 30 seconds, you forfeit the match and your opponent receives the win along with the staked funds. The only exception is if the battle hasn't started yet. In that case, the match is cancelled and both players automatically receive a full refund.",
  },
  {
    q: 'What are the battle rules?',
    a: 'Battle in a 6v6 format with all Pokémons set to level 100. Chose your Pokémons moveset, nature and ability or pick random. Victory comes down to team building and how you play.',
  },
  {
    q: 'Can I play without wagering?',
    a: 'Yes. Post a wager with a stake of zero and it is a normal match. It still counts for your win/loss record on the leaderboard.',
  },
  {
    q: 'Will more Pokémon generations be added?',
    a: 'Yes. We’re starting with the original 151 Pokémon, with new generations and features being added as the game evolves.',
  },
]
