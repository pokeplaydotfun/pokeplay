# Backend — Phase 0 tooling + Phase 2 foundations

TypeScript, Node 20+ (developed on 26). No build step — Node strips types natively.
Specs: `docs/04-BACKEND.md`. Findings: `docs/verification/verification-results.md`.

```bash
npm install
npm run typecheck
node --test src/db/db.test.ts src/bridge/bridge.test.ts    # 22 tests
```

## Phase 0 verification tooling — run these first

These unblock everything else. You do the manual legs (buying a pack, selling one back);
the scripts turn what happened on-chain into a documented interface.

```bash
npm run verify:t1 -- <pack-open-tx-sig> [more...]   # decode CC's purchase interface
npm run verify:t2 -- <revealed-nft-mint>            # find insured value
npm run verify:t3 -- plan                           # the bypass-test procedure
npm run verify:t3 -- decode <sell-tx-sig>           # decode the buyback interface
npm run verify:t4 -- quote 50                       # bridge quotes both directions
npm run verify:t5                                   # verify USDG before deploying
```

Pass 2–3 signatures to T1 from separate buys — it diffs them, and the fields that stay
constant are the program's shape while the ones that change are the per-order arguments.

## What is real, and what is not

| Module | State |
|---|---|
| `verify/*` | **Real.** Runnable against mainnet today. |
| `db/` | **Real.** Schema, state machine, idempotency guards, recovery queries. Tested. |
| `bridge/debridge.ts` | Quote path + health probe **real and tested**. `execute()` throws — see below. |
| `bridge/jit-source.ts` | **Real.** Cost gating, ledger writes, the `LiquiditySource` seam for M2 float. |
| `bridge/mock.ts` | **Real**, calibrated to measured deBridge fees. |
| `cc/types.ts` | **A hypothesis, not a spec.** Nobody has seen CC's programs yet. |
| `cc/mock.ts` | **Real** and deterministic; drives the pipeline end-to-end. |
| `pipeline/`, `api/` | Not built — blocked on T1–T3. |

`DeBridgeClient.execute()` deliberately throws instead of returning a plausible fake.
Submitting a DLN order means building and signing a real transaction on the origin chain,
and the shape of the flow it sits inside depends on whether CC's reveal is synchronous.
Writing it now would mean inventing that. It lands with the fulfilment pipeline.

## Two findings that changed the design

**1. Across cannot do this route.** `USDG(4663) → USDC(Solana)` returns `ROUTE_NOT_ENABLED`,
and Across has no live Solana route from anywhere. deBridge is currently the only bridge
serving both legs. Doc 00 §5 has been corrected.

**2. Bridge fees are fixed, not proportional** (~$0.77 out, ~$0.91 back, regardless of size).
Doc 00 §3 assumed $0.10–0.35 per full cycle; the real number at the $50 tier is **$1.68**,
which moves break-even sell-through from ~7% to **~46%**. The inversion matters: fixed fees
make the *cheapest* tier the worst one economically, and the cheapest tier is what doc 00 §2
locks for launch.

Operator decision (2026-07-18): **launch anyway**, cheapest tier, no float, break-even
accepted — M0 exists to measure real sell-through. This is bounded, not open-ended: no
individual transaction is loss-making (−$0.77 if a card is kept, +$0.92 if it is sold back),
so the worst case is ~$7.70/day at M0 caps.

Encoded rather than trusted to memory:
- `BRIDGE_COST_ABORT_USD` refuses any leg that could invert an individual trade
- every leg writes a `BRIDGE_FEE` treasury event, so real cost/pack and real sell-through
  come out of the ledger — the estimates in doc 00 §3 were already wrong once
- `bridge.test.ts` asserts the round trip is ~$1.68 and break-even ~46%; if those drift, the
  test fails and the launch economics get re-examined

## Invariants worth knowing before editing

- **An order that opened a pack can never be auto-refunded.** `ORDER_TRANSITIONS` has no
  edge back to `REFUNDED` from `OPENING` onward, and `setOrderStatus` throws if `cc_open_tx`
  is set. The only way out is the human-triggered `PackSale.forceRefund` (doc 06 runbook 6).
- **The worker never holds the owner key.** It cannot reach `forceRefund` by construction.
- **Money is TEXT holding integer base units**, never REAL. Floats lose cents.
- **Every external send claims an intent row first** (`claimIntent`), so a crash between
  send and confirm does not spend twice on restart.
