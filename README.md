# PokePlay

A competitive Pokémon battling site with on-chain wagers and tournaments, live at
**[pokeplay.fun](https://pokeplay.fun)** on **Robinhood Chain** (EVM, chain id `4663`, native ETH).

Build a team of six from the original 151, then either post a 1v1 wager (free or staked in ETH) or
enter a single-elimination tournament (free or paid entry). Battles are 6v6 singles fought live on a
server-authoritative engine. Winners take the pot.

---

## What works right now

| Piece | State |
| --- | --- |
| Battle engine — full modern mechanics via Pokémon Showdown's sim | ✅ Live |
| Server-authoritative live 6v6 over WebSocket | ✅ Live |
| Team building + saving, nature & ability selection, server-side legality checks | ✅ Live |
| Wager board — free and **paid (ETH)** 1v1 matches | ✅ Live |
| **Tournaments** — single-elim, free or **paid entry**, winner-take-all | ✅ Live |
| Escrow contract (1v1 wagers) | ✅ Deployed & verified on mainnet |
| Tournament pool contract (pooled entry fees) | ✅ Deployed & verified on mainnet |
| Leaderboard, usernames, profiles, wallet-privacy toggle | ✅ Live |
| Provably-fair replays (re-derived from the revealed seed) | ✅ Live |
| Wallet login (nonce + signature, auto sign-in) | ✅ Live |
| `$PLAY` token + market-cap / fee tracking | ❌ Not launched — the `/token` page shows `TBA`, no made-up figures |

No invented numbers anywhere: anything not yet real renders as `—` or a "planned" badge in the UI.

### Deployed contracts (Robinhood Chain, chain id 4663)

| Contract | Address |
| --- | --- |
| PokePlayEscrow (1v1 wagers) | `0xdE1405268a4194853573b5cF4270CaAEDaeCdAA0` |
| PokePlayTournamentPool | `0x4d75665a2c461b3c115c353a845f0dd2fc11f6ad` |

Both are verified on Blockscout. Fee is 2.5% (250 bps) to the treasury; the rest is the payout.

---

## Running it

Three parts: the Vite frontend, the Node battle server, and the Solidity contracts (Foundry).

```bash
# 1. battle server  (http://127.0.0.1:8090)
cd server
npm install
npm start

# 2. frontend  (http://localhost:5173)
cd ..
npm install
npm run dev
```

The Pokédex data is committed at `data/pokedex.json` (151 species, 593 moves, baked from PokeAPI).
Regenerate with `node scripts/build-pokedex.mjs` — it caches, so re-runs are cheap.

### Playing against yourself (local only)

Two players normally need two wallets. For local testing there is a dev sign-in that skips the wallet:

```bash
cd server
DEV_LOGIN=1 npm start        # prints a loud warning while this is on
```

Then open two tabs at `http://localhost:5173/play?as=ash` and `?as=gary`, post a free wager in one,
accept it in the other, and you are in a live battle. Accounts: `ash`, `gary`, `brock`, `misty`.

Dev sessions live in **sessionStorage** (per-tab), which is what lets two tabs hold two players.
**This is an authentication bypass**, gated three ways: `DEV_LOGIN=1` must be set, `NODE_ENV` must not
be `production`, and only the four fixed test addresses are accepted — the endpoint 404s otherwise, so
the code is inert in production. Never set `DEV_LOGIN=1` on a public host.

### Environment

Frontend `.env.local`:
```
VITE_API_BASE=http://127.0.0.1:8090
VITE_ESCROW_ADDRESS=            # set after deploying; empty disables paid wagers
VITE_TOURNAMENT_POOL_ADDRESS=   # set after deploying; empty disables paid tournaments
VITE_TOKEN_ADDRESS=             # set after launching on Pons; empty renders "TBA"
VITE_WALLETCONNECT_PROJECT_ID=
```

Server `.env` (or real env vars):
```
PORT=8090
DB_PATH=./data/app.db
CHAIN_ID=4663
CORS_ORIGIN=http://localhost:5173
ESCROW_ADDRESS=0x…
TOURNAMENT_POOL_ADDRESS=0x…
ADMIN_ADDRESSES=0x…            # comma-separated; only these may create tournaments
ARBITER_PRIVATE_KEY=0x…       # ⚠ see the security note below — server only, never the frontend
```

---

## Tests

```bash
cd server
npm test              # battle engine, AI, traits, leaderboard, P/L, bracket, settlement
npm run test:e2e      # boots a server on a scratch DB and plays a real battle end to end

cd ../contracts
forge test            # escrow + tournament pool: unit + fuzzed-invariant suites

cd ..
npm run dry-run           # full escrow lifecycle on anvil
npm run dry-run:ui        # real Chromium + stubbed wallet through the wager & tournament UI
npm run dry-run:fork      # drives the REAL mainnet contract on a fork (no funds spent)
```

The e2e run signs in with real secp256k1 signatures, saves teams, posts and accepts a wager, plays a
full 6v6 over the websocket, and verifies the revealed seed hashes to the pre-match commitment. See
`contracts/DRY-RUN.md` for the full ladder of dry runs.

---

## How the battle is kept honest

**The client never computes anything.** It sends `{kind:'move', index:2}` and renders what comes back.
All state, all RNG and all legality checks live on the server. A tampered client can at most send an
illegal action, which is rejected.

**Seed commitment.** The whole match is driven by one seeded PRNG. The server publishes `sha256(seed)`
when the battle starts and reveals `seed` when it ends. Re-running the battle with that seed reproduces
every roll exactly, so a player can verify after the fact that nothing changed mid-match. (This proves
the server did not *change* the seed once play began. It does not prove the seed was chosen fairly in
the first place — for that you would want commit-reveal from both players, a worthwhile upgrade.)

**Team legality is checked server-side, twice** — when a team is saved, and again when it enters a
battle. `validateTeam()` rejects unknown species, anything above 151, moves the species cannot legally
learn (validated against Showdown's learnsets), duplicates and wrong team sizes.

**Replays re-derive, they don't replay a log.** A finished match is reproduced by re-running the engine
from the published seed, and the page shows the integrity checks passing — so a replay is a proof, not
a recording.

### Battle rules

Level 100, 6v6 singles, modern mechanics through Pokémon Showdown's engine (`@pkmn/sim`): the current
type chart, STAB, the physical/special split, crits, the damage spread, accuracy/evasion, the full
status set, multi-hit, drain/recoil, priority, **abilities and weather**. Restricted to the original
151. Every Pokémon has 31 IVs and 0 EVs, and **you choose each one's nature and ability** — so the
only differences between two players are team choice, spreads-by-nature, and play.

Team building offers the full movepool each species can legally learn (593 moves total), bar a short
exclusion list. Held items and doubles are not used.

> The engine is versioned: `server/src/battle/active.ts` is the single switch point. The current engine
> is the Showdown adapter (`engine2.ts`); the original hand-written engine (`engine.ts`) is kept frozen
> so historical matches still re-derive on the engine they were played on.

---

## The wager escrow, and what you are trusting

Two players stake the same amount; the contract holds it. A tournament pools every entrant's equal
entry fee. The battle happens **off-chain** on our server, and the server signs the result (EIP-712)
for the contract to verify and pay out.

**That makes the server a trusted arbiter, and there is no way around it** short of running the whole
battle on-chain. Stated plainly:

- Whoever holds `ARBITER_PRIVATE_KEY` can sign any result and direct the pot. That key lives only in
  the server environment and must never reach the frontend bundle.
- The **timeout / refund** paths protect users if the arbiter *disappears*: after the timeout, a wager's
  two players each reclaim their own stake, and a tournament's entrants each reclaim their own fee. They
  do **not** protect against a *stolen* key.
- The contracts are **unaudited**. They hold real money.

Mitigations in place: pull payments (a griefing participant cannot block settlement), replay protection
via EIP-712 with chain id + contract address + per-wager/per-tournament nonce, a capped fee, an owner
that structurally cannot touch user funds, a solvency invariant proven by fuzzing, and a pause that can
never block withdrawals or refunds.

See `contracts/README.md`, `contracts/TOURNAMENT-POOL.md` and `contracts/DEPLOY-CONFIG.md` for the
design and the deploy procedure. You deploy with your own key — the deploy scripts take `OWNER`,
`ARBITER`, `TREASURY` and `FEE_BPS` from the environment and never contain a key.

---

## Tournaments

Single-elimination brackets for 2–64 players, played through the normal battle rooms. A tournament can
be **free** or **paid**:

- **Paid entry** is pooled in `PokePlayTournamentPool`. Sign-ups run on a timer; when it closes the
  bracket auto-starts with whoever paid in (a partial fill still runs). **Winner takes the whole pot
  minus the house fee.**
- The **on-chain entrant set is the source of truth** — the server seats a paid player only after the
  pool confirms their payment, so nobody enters the pot for free.
- Every exit is covered: an entrant can **leave** an open tournament and get their fee back, an
  organiser can **extend** or **cancel**, and a pot that never fills can be unlocked for refunds by any
  entrant — no exit ever strands a fee in the pool.

Only admin wallets (`ADMIN_ADDRESSES`) can create tournaments; the bracket engine lives in
`server/src/bracket.ts`.

---

## Legal reality check

This is real-money wagering. Two things are worth a lawyer's time:

1. **Gambling regulation.** Paid entry for a prize decided partly by chance is regulated very
   differently by jurisdiction, and a footer saying "18+ where legal" is not a compliance strategy.
2. **IP.** The game is built on Pokémon species, stats, movesets and sprites, served from PokeAPI. Fan
   projects that take real money are the ones that attract letters.

Neither is a reason the code does not work. Both are reasons to get advice.

---

## Layout

```
data/pokedex.json          baked PokeAPI data (151 species, 593 moves)
scripts/build-pokedex.mjs  regenerates it
scripts/dry-run/           anvil + browser dry runs (wagers and tournaments)
server/src/battle/         the engine — active.ts (switch point), engine2.ts (Showdown),
                           engine.ts (frozen v1), dex2.ts, ai.ts, typechart.ts, tests
server/src/                rooms.ts, auth.ts, db.ts, bracket.ts, tournaments.ts,
                           settle.ts, settle-tournament.ts, index.ts (API + ws)
contracts/                 PokePlayEscrow + PokePlayTournamentPool, tests, deploy scripts
src/                       React frontend
  lib/                     api.ts, session.tsx, useBattle.ts, wagmi.ts, escrow.ts, tournamentPool.ts
  pages/                   Home, Play, Wagers, Battle, Tournaments, Tournament,
                           Leaderboard, Profile, Guide, Replay, Token
```
