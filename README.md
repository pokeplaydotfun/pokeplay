# PokePlay

A competitive Pokemon battling site with on-chain wagers and tournaments, plus a card gacha backed by
real graded cards held in custody. Live at [pokeplay.fun](https://pokeplay.fun) on Robinhood Chain
(EVM, chain id `4663`, native ETH).

Two products share one site:

* **Battles.** Build a team of six from the original 151, then post a 1v1 wager (free or staked in
  ETH) or enter a single elimination tournament (free or paid entry). Battles are 6v6 singles fought
  live on a server authoritative engine. Winners take the pot.
* **Cards.** Open a gacha pack priced in USDG. The pack is bought for real from Collector Crypt, the
  graded card is held in custody, and a mirror NFT is minted to the buyer on Robinhood Chain. That
  mirror can be sold back, withdrawn to take delivery of the real card, or traded on the marketplace.

## What works right now

Battles and wagers:

* Battle engine with full modern mechanics through Pokemon Showdown's simulator
* Server authoritative live 6v6 over WebSocket
* Team building and saving, nature and ability selection, server side legality checks
* Wager board, free and paid (ETH) 1v1 matches, minimum paid stake 0.001 ETH
* Tournaments, single elimination, free or paid entry, winner take all
* Spectator mode, watch any live match, plus provably fair replays re-derived from the revealed seed
* Leaderboard, usernames, profiles, wallet privacy toggle

Cards:

* Pack buying, priced in USDG, fulfilled end to end with no manual step
* Cross chain fulfilment, USDG on Robinhood Chain to USDC on Solana and back, through deBridge
* Mirror NFT minted to the buyer, one per card held in custody
* Sell back at the live Collector Crypt rate less a fixed spread
* Withdraw, burn the mirror and take delivery of the real card
* Deposit, send a Collector Crypt card in and receive a mirror for it
* Marketplace for mirrors, and a cards leaderboard by packs opened and total value

Not live yet:

* The `$PLAY` token. The `/token` page shows `TBA` for the contract address, and the live fee and
  market cap dashboard reports dashes rather than zeroes until the token launches.

Nothing invents a number. Anything not yet real renders as a dash or a "planned" state.

## Deployed contracts, Robinhood Chain, chain id 4663

Battles:

* `PokePlayEscrow` (1v1 wagers) `0xdE1405268a4194853573b5cF4270CaAEDaeCdAA0`
* `PokePlayTournamentPool` `0x4d75665a2c461b3c115c353a845f0dd2fc11f6ad`

Cards:

* `PackSale` `0x93BDe960A2211F923429BD4ea6303BC24C1D29Da`
* `MirrorNFT` (collection `POKEPLAY` / `PLAY`) `0xED4037BC60ff1FBA0c74461B3Cc9aa6DE7eE59e5`
* `Fulfiller` `0x4D2Ba8cf91e2eD6740FC6c9Cd5a64060f97c886d`
* `USDG` (Paxos, payment token) `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`

The wager contracts are verified on Blockscout. Fee on both is 2.5 percent (250 bps) to the treasury,
the rest is the payout. Ownership sits on a cold wallet, separate from the hot wallet that signs at
runtime, so the key that can pause or reconfigure is never the key the server holds.

## Running it

Three parts: the Vite frontend, the Node battle server, and the Solidity contracts under Foundry. The
cards backend is a fourth, separate service under `slabs/backend`.

```bash
# battle server, http://127.0.0.1:8090
cd server
npm install
npm start

# frontend, http://localhost:5173
cd ..
npm install
npm run dev
```

The Pokedex data is committed at `data/pokedex.json` (151 species, 593 moves, baked from PokeAPI).
Regenerate with `node scripts/build-pokedex.mjs`, which caches, so re-runs are cheap.

### Playing against yourself, local only

Two players normally need two wallets. For local testing there is a dev sign in that skips the wallet:

```bash
cd server
DEV_LOGIN=1 npm start
```

Then open two tabs at `http://localhost:5173/play?as=ash` and `?as=gary`, post a free wager in one,
accept it in the other, and you are in a live battle. Accounts: `ash`, `gary`, `brock`, `misty`.

Dev sessions live in sessionStorage, per tab, which is what lets two tabs hold two players. This is an
authentication bypass, gated three ways: `DEV_LOGIN=1` must be set, `NODE_ENV` must not be
`production`, and only the four fixed test addresses are accepted. The endpoint returns 404 otherwise,
so the code is inert in production. Never set `DEV_LOGIN=1` on a public host.

### Environment

Frontend `.env.local`:

```
VITE_API_BASE=http://127.0.0.1:8090
VITE_ESCROW_ADDRESS=            # set after deploying, empty disables paid wagers
VITE_TOURNAMENT_POOL_ADDRESS=   # set after deploying, empty disables paid tournaments
VITE_TOKEN_ADDRESS=             # set after launching on Pons, empty renders TBA
VITE_SLABS_ENABLED=             # true to mount the cards section
VITE_API_URL=                   # the cards backend, empty runs a browser mock
VITE_WALLETCONNECT_PROJECT_ID=
```

Battle server `.env`:

```
PORT=8090
DB_PATH=./data/app.db
CHAIN_ID=4663
CORS_ORIGIN=http://localhost:5173
ESCROW_ADDRESS=0x...
TOURNAMENT_POOL_ADDRESS=0x...
ADMIN_ADDRESSES=0x...           # comma separated, only these may create tournaments
ARBITER_PRIVATE_KEY=0x...       # server only, never the frontend bundle
```

The cards backend takes its own environment, documented in `slabs/DEPLOY.md`. It needs a worker key
for the runtime roles, a Solana operator key for custody, and Collector Crypt credentials. It runs
against mocks with no keys at all when `USE_MOCKS=true`.

## Tests

```bash
cd server
npm test              # battle engine, AI, traits, leaderboard, P/L, bracket, settlement, usernames
npm run test:e2e      # boots a server on a scratch DB and plays a real battle end to end

cd ../slabs/backend
npm test              # cards pipeline, escrow watcher, buyback, deposits, bridge, chain adapters

cd ../../contracts
forge test            # escrow and tournament pool, unit plus fuzzed invariant suites

cd ..
npm run dry-run                    # full escrow lifecycle on anvil
npm run dry-run:ui                 # real Chromium and a stubbed wallet through the wager and tournament UI
npm run dry-run:fork               # drives the REAL mainnet contract on a fork, no funds spent
npm run dry-run:tournament-server  # the paid tournament flow through server and pool
```

The e2e run signs in with real secp256k1 signatures, saves teams, posts and accepts a wager, plays a
full 6v6 over the websocket, and verifies the revealed seed hashes to the pre-match commitment.

The fork run is the one worth knowing about. It forks Robinhood mainnet and drives the actually
deployed escrow, same bytecode, same constructor arguments, same accrued state, same chain id. It is
read only with respect to mainnet, every write lands on a local fork that is destroyed on exit, and no
key with real funds is used. See `contracts/DRY-RUN.md` for the full ladder.

## How the battle is kept honest

**The client never computes anything.** It sends `{kind:'move', index:2}` and renders what comes back.
All state, all RNG and all legality checks live on the server. A tampered client can at most send an
illegal action, which is rejected.

**Seed commitment.** The whole match is driven by one seeded PRNG. The server publishes `sha256(seed)`
when the battle starts and reveals `seed` when it ends. Re-running the battle with that seed reproduces
every roll exactly, so a player can verify after the fact that nothing changed mid match. This proves
the server did not change the seed once play began. It does not prove the seed was chosen fairly in the
first place, which would need commit reveal from both players, a worthwhile upgrade.

**Team legality is checked server side, twice**, when a team is saved and again when it enters a
battle. `validateTeam()` rejects unknown species, anything above 151, moves the species cannot legally
learn (validated against Showdown's learnsets), duplicates and wrong team sizes.

**Replays re-derive, they do not replay a log.** A finished match is reproduced by re-running the
engine from the published seed, and the page shows the integrity checks passing, so a replay is a proof
rather than a recording.

**Spectators see less than a player already sees.** The watch feed carries both sides as public teams,
species, HP, status, boosts and ability, but never moves or PP for either side, so watching a match you
have money on gives you nothing you could not already infer.

### Battle rules

Level 100, 6v6 singles, modern mechanics through Pokemon Showdown's engine (`@pkmn/sim`): the current
type chart, STAB, the physical and special split, crits, the damage spread, accuracy and evasion, the
full status set, multi hit, drain and recoil, priority, abilities and weather. Restricted to the
original 151. Every Pokemon has 31 IVs and 0 EVs, and you choose each one's nature and ability, so the
only differences between two players are team choice, spreads by nature, and play.

Team building offers the full movepool each species can legally learn, 593 moves in total, bar a short
exclusion list. Held items and doubles are not used.

The engine is versioned. `server/src/battle/active.ts` is the single switch point. The current engine
is the Showdown adapter (`engine2.ts`), and the original hand written engine (`engine.ts`) is kept
frozen so historical matches still re-derive on the engine they were played on.

## The wager escrow, and what you are trusting

Two players stake the same amount and the contract holds it. A tournament pools every entrant's equal
entry fee. The battle happens off chain on our server, and the server signs the result with EIP-712 for
the contract to verify and pay out.

That makes the server a trusted arbiter, and there is no way around it short of running the whole
battle on chain. Stated plainly:

* Whoever holds `ARBITER_PRIVATE_KEY` can sign any result and direct the pot. That key lives only in
  the server environment and must never reach the frontend bundle.
* The timeout and refund paths protect users if the arbiter disappears. After the timeout, a wager's
  two players each reclaim their own stake, and a tournament's entrants each reclaim their own fee.
  They do not protect against a stolen key.
* The contracts are unaudited. They hold real money.

Mitigations in place: pull payments, so a griefing participant cannot block settlement; replay
protection through EIP-712 with chain id, contract address and a per wager or per tournament nonce; a
capped fee; an owner that structurally cannot touch user funds; a solvency invariant proven by fuzzing;
and a pause that can never block withdrawals or refunds.

See `contracts/README.md`, `contracts/TOURNAMENT-POOL.md` and `contracts/DEPLOY-CONFIG.md` for the
design and the deploy procedure. You deploy with your own key. The deploy scripts take `OWNER`,
`ARBITER`, `TREASURY` and `FEE_BPS` from the environment and never contain a key.

## Tournaments

Single elimination brackets for 2 to 64 players, played through the normal battle rooms. A tournament
can be free or paid:

* Paid entry is pooled in `PokePlayTournamentPool`. Sign ups run to a scheduled time, and when that
  passes the bracket starts with whoever paid in. A partial fill still runs.
* The on chain entrant set is the source of truth. The server seats a paid player only after the pool
  confirms their payment, so nobody enters the pot for free.
* Every exit is covered. An entrant can leave an open tournament and get their fee back, an organiser
  can extend or cancel, and a pot that never fills can be unlocked for refunds by any entrant, so no
  exit ever strands a fee in the pool.

Only admin wallets (`ADMIN_ADDRESSES`) can create tournaments. The bracket engine lives in
`server/src/bracket.ts`.

## Cards

A pack purchase is one on chain payment and then a fully automated pipeline:

1. The buyer pays USDG to `PackSale` on Robinhood Chain.
2. The backend bridges that USDG to USDC on Solana through deBridge.
3. It buys the pack from Collector Crypt, which reveals a real graded card.
4. The card stays in a custody wallet, and a mirror NFT for it is minted to the buyer.

From there the mirror is the buyer's claim on that specific card:

* **Sell back** returns it at the live Collector Crypt rate less a fixed spread, paid in USDG. The card
  is sold to Collector Crypt and the proceeds bridged back.
* **Withdraw** burns the mirror and sends the real card to the holder's Solana wallet.
* **Deposit** works the other way. Send a Collector Crypt card to the vault and claim a mirror for it.
  A deposited card can never be sold back, because we never bought it.
* **Marketplace** trades mirrors between users on chain.

Custody is the whole product, so the invariants matter more than the features. A card is never sold
before the payout path is known to work, the value ceiling that decides what may be sold back is
enforced at the escrow watcher rather than in the UI, since anyone can send a mirror to the vault
directly, and the record of who owns what is backed up nightly.

## The token

`$PLAY` is not launched. The `/token` page carries a live dashboard of fees generated and market cap,
read from the Pons pool by the cards backend at `/token/stats`. Until `PONS_TOKEN_ADDRESS` is set the
endpoint reports `live: false` and the page shows dashes with a plain statement that the token has not
launched, rather than zeroes that would read as a live market with no trading.

Launching is a matter of setting the token address in the backend environment and
`VITE_TOKEN_ADDRESS` for the frontend. No code change.

## Legal reality check

This is real money wagering and real money card trading. Two things are worth a lawyer's time:

1. **Gambling regulation.** Paid entry for a prize decided partly by chance is regulated very
   differently by jurisdiction, and a footer saying "18+ where legal" is not a compliance strategy.
2. **IP.** The battling side is built on Pokemon species, stats, movesets and sprites served from
   PokeAPI. Fan projects that take real money are the ones that attract letters.

Neither is a reason the code does not work. Both are reasons to get advice.

## Layout

```
data/pokedex.json          baked PokeAPI data (151 species, 593 moves)
scripts/build-pokedex.mjs  regenerates it
scripts/dry-run/           anvil and browser dry runs (wagers and tournaments)

server/src/battle/         the engine, active.ts (switch point), engine2.ts (Showdown),
                           engine.ts (frozen v1), dex2.ts, ai.ts, typechart.ts, tests
server/src/                rooms.ts, auth.ts, db.ts, bracket.ts, tournaments.ts,
                           settle.ts, settle-tournament.ts, index.ts (API and ws)

contracts/                 PokePlayEscrow and PokePlayTournamentPool, tests, deploy scripts

slabs/backend/src/         the cards service, pipeline/ (buy, escrow, buyback, withdraw,
                           deposit), chains/ (rh.ts, solana.ts), bridge/ (deBridge), cc/
slabs/contracts/           PackSale, MirrorNFT, Fulfiller, Marketplace

src/                       React frontend
  lib/                     api.ts, session.tsx, useBattle.ts, wagmi.ts, escrow.ts,
                           tournamentPool.ts, names.ts
  pages/                   Home, Play, Wagers, Battle, Tournaments, Tournament,
                           Leaderboard, Profile, Guide, Replay, Watch, Token, Slabs
  slabs/                   the cards section, mounted under /cards
```
