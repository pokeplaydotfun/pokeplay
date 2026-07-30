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
  github: 'https://github.com/pokeplaydotfun/pokeplay',
}

/**
 * Chain settings. Overridable so the whole stack can be pointed at the
 * Robinhood testnet (46630) for a dry run without a code change.
 */
export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 4663)
export const IS_TESTNET = CHAIN_ID !== 4663
export const CHAIN_LABEL = IS_TESTNET ? 'Robinhood Testnet' : 'Robinhood Chain'
export const CURRENCY = 'ETH'

/**
 * Smallest real-money stake, in wei. 0.001 ETH.
 *
 * ⚠ The server enforces the SAME figure in `/api/wagers` (`MIN_STAKE_WEI` in
 * server/src/index.ts) and that copy is the one that counts — this form can be bypassed by
 * calling the API directly, or by escrowing on chain and posting the id. Changing one without
 * the other gives a board that either rejects wagers it offered to take, or accepts ones it
 * said it would not. If you move this number, move both.
 *
 * Free wagers are unaffected: a stake of exactly 0 stays legal.
 */
export const MIN_STAKE_WEI = 1_000_000_000_000_000n
export const MIN_STAKE_LABEL = '0.001'
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

/**
 * The $PLAY contract address, written here at launch by `scripts/launch-token.sh`.
 *
 * It is a DEFAULT in the source, not a build-time env var, for the same reason the escrow
 * and pool addresses above are: `scripts/deploy.sh` ships the working tree with a fixed
 * build line, so an address that lived only in the environment would silently disappear on
 * the next routine deploy and put "TBA" back on the homepage of a launched token. A CA is
 * public and permanent, so there is nothing to hide by keeping it out of the repo.
 *
 * Empty until launch — and it must stay a real address or empty, never a hex-shaped
 * placeholder, because a placeholder in this slot is something a visitor can copy and send
 * money to. `VITE_TOKEN_ADDRESS` still overrides it for a local or testnet build.
 */
const TOKEN_ADDRESS_DEFAULT = '0x1dd4495325fea70a48966b1fff189d30a44a7840'

/** The token, launched on Pons. Empty renders as "TBA". */
export const TOKEN = {
  ticker: '$PLAY',
  // `||`, not `??`: an env var that is DEFINED BUT EMPTY (which is what a build script that
  // forwards an unset variable produces) must fall back to the launched default rather than
  // blank the CA on a live token.
  address: ((import.meta.env.VITE_TOKEN_ADDRESS || TOKEN_ADDRESS_DEFAULT) ?? '') as string,
  launchpad: 'Pons',
  /** Live figures are read on-chain; null until the token exists. */
  marketCapUsd: null as number | null,
  feesCollectedUsd: null as number | null,
  holders: null as number | null,
}

/**
 * The Slabs gacha section is a self-contained ported product that only works once
 * its contracts + backend are deployed and configured (see slabs/DEPLOY.md). Until
 * then it is HIDDEN — the nav item and the /slabs route are both gated on this flag —
 * so an ordinary pokeplay deploy (which ships the working tree) can never expose an
 * unconfigured gacha on the live site. Flip `VITE_SLABS_ENABLED=true` in the build
 * env once Phase 5 is done.
 */
export const SLABS_ENABLED = import.meta.env.VITE_SLABS_ENABLED === 'true'

/** A plain link, or a labelled dropdown of links. */
export type NavItem =
  | { label: string; to: string }
  | { label: string; items: { label: string; to: string }[] }

export const NAV: NavItem[] = [
  { label: 'Play', to: '/play' },
  { label: 'Tournaments', to: '/tournaments' },
  // The ported gacha, presented as native pokeplay: a "Cards" dropdown for the
  // marketplace side and a separate "Gacha" button for opening packs. Both are
  // gated on SLABS_ENABLED so an ordinary deploy never shows them.
  ...(SLABS_ENABLED
    ? ([
        {
          label: 'Cards',
          items: [
            { label: 'Collection', to: '/cards/collection' },
            { label: 'Marketplace', to: '/cards/marketplace' },
            { label: 'Guide', to: '/guide#cards' },
          ],
        },
        { label: 'Gacha', to: '/cards/gacha' },
      ] satisfies NavItem[])
    : []),
  { label: 'Leaderboard', to: '/leaderboard' },
  { label: 'Token', to: '/token' },
  { label: 'Guide', to: '/guide' },
]

export const HERO = {
  eyebrows: [`LIVE ON ${CHAIN_LABEL.toUpperCase()}`],
  headline: ['PokePlay'],
  sub: `Build your team from the original 151 and challenge other players in free matches, ${CURRENCY}-staked battles and tournaments.`,
}

export const STEPS = [
  {
    n: '01',
    title: 'Team',
    body: 'Six Pokémon from the original 151, four moves each.',
  },
  {
    n: '02',
    title: 'Match',
    body: `Create a match for free, stake your ${CURRENCY} and participate in tournaments.`,
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
