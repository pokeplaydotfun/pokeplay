# PokePlayTournamentPool — design, and what the server still has to do

`PokePlayTournamentPool.sol` is the on-chain contract that makes **paid
tournaments** possible. The 1v1 escrow can't: it matches exactly two equal stakes
and pays one of the two. A tournament pools 3–64 equal fees and pays one of the
many. This contract is the sibling of `PokePlayEscrow` and shares its trust
model, its pull-payment discipline, and its solvency invariant.

**Status: LIVE.** v2 is deployed on Robinhood mainnet at
`0x4d75665a2c461b3c115c353a845f0dd2fc11f6ad` (verified on Blockscout), the server
is wired to it, and paid tournaments are on at pokeplay.fun. v1
(`0x5C721E6BC4f40de8a16d8FE663d315c4407007A4`) is abandoned and empty.
⚠️ No real-money tournament has run on it yet — the smoke test is still pending.

## What it does

- `createTournament(entryFee, maxPlayers, registrationDeadline)` — anyone opens a
  pool. `entryFee > 0`, `maxPlayers ∈ [2, 64]`, deadline in the future. The
  organizer does not auto-join (an admin can run one without playing).
- `joinTournament(id)` payable — pay exactly `entryFee` to enter, until the pool
  is full or the deadline passes. One entry per address.
- `settle(id, winner, sig)` — anyone relays an **arbiter-signed**
  `TournamentResult(tournamentId, winner, nonce)`; the named entrant is credited
  `pot − fee` and the treasury the fee. **Winner-take-all** (v1). The pot is over
  *actual* entrants, not the cap.
- `cancelTournament(id)` — the organizer, at/before the deadline, or anyone once
  the deadline has passed with < 2 entrants (unrunnable). Flips to REFUNDING.
- `claimRefund(id)` — the liveness hatch. If still OPEN, an entrant may unwind the
  pool once `registrationDeadline + settleTimeout` has passed (this first call
  flips it to REFUNDING for everyone); if already REFUNDING (cancel or timeout),
  entrants just claim. Each entrant reclaims their exact fee, once, fee-free.
- `withdraw()` — the only function that sends ETH out. Pull payments.

Owner powers (strictly weaker, can never move a pooled fee): `setArbiter`,
`setTreasury`, `setFeeBps` (≤ 5%), `setSettleTimeout` (5 min – 7 days, default
**24h** — longer than the escrow's 1h because a tournament takes longer to run),
`pause`/`unpause` (blocks create + join only).

## Trust model (identical shape to the escrow)

The arbiter key decides the winner. It can only ever name an **entrant** of that
tournament, can only pay `pot − fee` (the contract computes the amount), and
cannot touch a non-OPEN tournament or already-credited balances. `setArbiter` is
retroactive — own this with a multisig/timelock, not a hot EOA. The timeout
refund needs neither the arbiter nor the owner, so a dead/rogue server can stall a
payout but never keep the money.

⚠️ **Set `registrationDeadline` to when sign-ups CLOSE.** The refund window is
`deadline + settleTimeout`, and the organizer's cancel right ends at the deadline.
If the deadline is set to when sign-ups open-ended, a running tournament could be
cancelled or refunded out from under itself. Deadline = registration close is the
invariant the server must uphold.

## Tests

- `test/PokePlayTournamentPool.t.sol` — 57 unit tests (lifecycle, fee maths at
  several bps, cancel/timeout paths, signature & replay safety, pause, access
  control, "owner cannot drain", withdraw accumulation).
- `test/TournamentInvariant.t.sol` — a fuzzed handler over every action + admin
  meddling, asserting solvency, ghost-accounting consistency, and that the owner
  never extracts a wei. 8192 calls, 0 reverts.
- `npm run dry-run:tournament` (and `FORK=1 …`) — the full lifecycle with real
  transactions and a real arbiter signature, on plain anvil and on a fork of
  Robinhood mainnet. 11/11 both ways. (`scripts/dry-run/run-tournament.sh`.)

Run: `cd contracts && forge test` (now 146 total across both contracts).

## Deploy

`script/DeployTournamentPool.s.sol` — same tooling and env vars as the escrow.
Deploy with the **same owner/arbiter/treasury/fee** so one arbiter key signs for
both contracts. No key is read by the script; supply `--account`/`--ledger`.

## Server integration — MOSTLY DONE

The critical invariant the wiring upholds:

> **Everyone who paid on-chain must be in the bracket, and the winner must be one
> of them.** Because it is winner-take-all, a player who pays on-chain but is left
> out of the bracket would lose their fee if the tournament settles. The server
> therefore treats the **on-chain entrant set as the source of truth** and seats a
> paid player only after the contract confirms they paid.

Done (`server/src/settle-tournament.ts`, `tournaments.ts`, `index.ts`, `db.ts`):

- [x] **Signer + startup guard** — `settle-tournament.ts` mirrors `settle.ts`:
  signs `TournamentResult`, and `verifyTournamentConfig()` reads
  `eip712Domain()`/`arbiter()` off the pool at boot and refuses to start on a
  mismatch. Uses the SAME arbiter key as the escrow.
- [x] **Config gate** — `paidEntryAvailable()` now reads
  `tournamentSettlementEnabled` (true when `TOURNAMENT_POOL_ADDRESS` +
  `ARBITER_PRIVATE_KEY` are set). `GET /api/tournaments/settlement/status`.
- [x] **Creation** — a paid tournament requires an `onchainId`, stored on the
  `tournaments.onchain_id` column (additive migration in `db.ts`). Surfaced in
  the tournament view as `onchainId` + `pool`.
- [x] **Joins** — `POST /api/tournaments/:id/join` verifies `isEntrant(onchainId,
  player)` on chain before seating a paid entrant; a freeloader gets **402**.
- [x] **Settlement** — `GET /api/tournaments/:id/settlement` returns the arbiter
  signature for the champion once the bracket is done and the pool is still OPEN;
  the winner submits it (server needs no gas), same as the wager path.
- [x] **Proven end-to-end** — `npm run dry-run:tournament-server` boots the server
  against a freshly deployed pool and drives a 2-player paid tournament through
  create → on-chain join → server-gated seat → battle → server-signed winner →
  **the real pool honours the signature and pays out** → withdraw, and then a
  second pot that never fills, through health → the entrant's own cancel → claim
  → withdraw → reconcile. **21/21.**
  (`scripts/dry-run/{run-tournament-server.sh,tournament-server-flow.mjs}`.)

- [x] **Frontend** (`src/lib/tournamentPool.ts`, `Tournaments.tsx`,
  `Tournament.tsx`, `config.ts`) — the paid create flow (organizer calls
  `createTournament` on the pool, then posts `onchainId`), the join flow (pay
  `joinTournament`, then the server join that verifies the payment), and a
  champion prize panel (settle → withdraw, mirroring the wager `ClaimPanel`).
  Gated on `poolReady` (`VITE_TOURNAMENT_POOL_ADDRESS`). Typechecks, lints,
  builds.

- [x] **Reconcile + monitor** — `reconcileTournaments()` in `index.ts` (twin of
  `reconcileSettlements()`) marks a finished paid tournament `settled_onchain=1`
  + records `fee_bps` once the pool says SETTLED, or `=2` if it REFUNDED. Two new
  `/api/health` checks — `tournament-settlements` (a finished pot unsettled past
  `STUCK_SETTLEMENT_SECONDS`) and `tournament-reconciler` (liveness) — both absent
  when no pool is configured, so a free-only server is unaffected. The watchdog
  picks them up automatically (it alerts on any failing check by name). Proven by
  `dry-run:tournament-server` (now **21/21**: health flags the unsettled pot, then
  recovers once the reconciler sees the settlement). Uses a `tournaments.settled_onchain`
  column (additive migration).

- [x] **Browser e2e** — `npm run dry-run:ui` now deploys a pool alongside the
  escrow and drives the paid-tournament UI through the stubbed wallet against it
  (**36/36**): the organiser posts a pool from the create form, two players pay
  in, the organiser extends the deadline, one player leaves for a refund, the
  organiser cancels, the other reclaims and withdraws — then a second tournament
  runs to a champion who claims the prize and withdraws it. Every transaction is
  really signed and mined; every assertion is read back off the contract, not the
  page. Screenshots land in `scripts/dry-run/shots/tn-*.png`.

- [x] **Every way money gets out of the pool now has a button** (Jul 24). Three
  gaps closed, all of them "the contract is fine, the page offers no way to reach
  it":
  - **Withdraw after leaving** — `leaveTournament()` *credits* `balances[player]`
    rather than sending, and `RefundClaim` was gated on a *cancelled* tournament
    **and** `you.entered`, both false the instant you leave. `RefundClaim` now
    renders for any signed-in player on a paid tournament who is not the
    champion, and asks the POOL (not the server) which of claim / withdraw /
    nothing applies.
  - **A pot that never fills** — sign-ups closing with fewer than two entrants
    left it `open` forever: the page still said "it starts automatically", still
    offered a leave button that reverts past the deadline, and the money waited
    on the organiser or the 24h timeout. The page now says it did not fill and
    offers **Unlock refunds**, which is `cancelTournament` — the pool lets *any*
    caller cancel a tournament that can never run, so an entrant frees everyone.
    `reconcileTournaments()` picks the REFUNDING flip up and marks it cancelled,
    and a new `tournament-underfilled` health check pages until someone does.
    The scheduler's warning is now once per tournament, not every 15 seconds.
  - **Cancelled tournaments still offered "Leave & get refund"** — the position
    panel is no longer rendered for a cancelled tournament at all; the refund
    panel is the whole story there.
  - Also, a **claim past the settle timeout** is now offered when a pot never
    produced a winner — but deliberately **not** when it did. That first claim
    flips the pool to REFUNDING and permanently denies the champion their prize,
    so a beaten player must not have a one-click button to void a result. A slow
    champion is not a liveness problem: `settle` accepts the arbiter signature
    from any caller and the settlement endpoint is a public GET.
  - Covered by `dry-run:ui` (**36/36**) and `dry-run:tournament-server`
    (**21/21**, which drives the underfilled pot through health, the entrant's
    own cancel, claim, withdraw and the reconciler).
- [ ] **A match your opponent started is invisible** — `playableFor()` only
  returns matches with status `ready`, so once the opponent hits "Play my match"
  the fixture flips to `playing` and the other player's page falls back to
  "Waiting for the round to fill out", with no way in. They have to find `/play`,
  where the resume effect drops them into the battle. On a paid fixture with a
  disconnect timer running, that is a forfeit waiting to happen.

## ⚠ VERSIONS

The repo source is now **v2**, adding `leaveTournament()` (an entrant unjoins an
OPEN tournament, before its deadline, and gets their fee back) and
`extendDeadline()` (organizer pushes the registration deadline forward, forward-
only, capped at +30 days). The deployed `0x5C72…07A4` is **v1 and lacks both** —
it must be **redeployed** for the leave/extend/timer features to work. The v1
pool is empty (no real tournaments, 0 ETH), so abandoning it is clean. Redeploy
with the same command as before (`DeployTournamentPool`, now v2 bytecode), then
re-wire `config.ts` + server `.env` to the new address.

## DEPLOYED (mainnet, Robinhood Chain 4663) — Jul 23 — ⚠ v1, SUPERSEDED by v2 source

- **Pool: `0x5C721E6BC4f40de8a16d8FE663d315c4407007A4`** — verified on Blockscout.
- owner = treasury = `0x2fD76b95e1CdaF43264a1459C41410f22F942aB6` (same hot wallet
  as the escrow, per the operator's decision — do NOT nag about splitting).
- arbiter = `0xE18798dd9dabD03b0df4BdA61D3b5E7B805bEc85` (the server's key, same as
  the escrow — one key signs for both contracts).
- feeBps 250, settleTimeout 86400s (24h), unpaused, tournamentCount 0.
- Deploy note: `forge script --account` needs BOTH `--account` AND
  `--sender <addr>`, and the keystore password prompt needs a REAL terminal (it
  fails with "Device not configured" through a non-TTY shell).

## Go-live — what is DONE and what is LEFT

Done:
- [x] Pool deployed + verified on mainnet (above).
- [x] `src/config.ts` default `TOURNAMENT_POOL_ADDRESS` set to the deployed
  address (frontend picks it up on the next build).
- [x] `scripts/deploy.sh` reads back + preserves `TOURNAMENT_POOL_ADDRESS` and
  writes it into the server `.env`; pass it once on the deploy command to enable.

Left — the single command that flips paid tournaments ON at pokeplay.fun:

    TOURNAMENT_POOL_ADDRESS=0x5C721E6BC4f40de8a16d8FE663d315c4407007A4 \
    DOMAIN=pokeplay.fun ./scripts/deploy.sh

This ships the frontend (address baked in), writes the pool address into the
server `.env`, and the startup guard verifies the pool's domain + arbiter or
refuses to boot. Until this runs, the live server has no
`TOURNAMENT_POOL_ADDRESS`, so `paidEntryAvailable()` stays `false` and paid
tournaments remain refused — nothing is live-facing yet.

The reconciler + health/watchdog monitoring for a finished-but-unsettled paid
tournament is now BUILT and proven, so that deploy ships with alerting in place.
(Set an `ALERT_WEBHOOK` in `/etc/slabshowdown-watchdog.env` if you actually want
to be paged — otherwise the alerts only hit journald.)
