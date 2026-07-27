# Contracts — Phase 1

Robinhood Chain (EVM, chainId 4663). Solidity 0.8.24, Foundry, OpenZeppelin v5.1.0.
Specs: [`docs/03-CONTRACTS.md`](../docs/03-CONTRACTS.md), architecture in `docs/02`.

## What's here

| Contract | Role |
|---|---|
| `PackSale.sol` | Takes USDG for a machine, escrows it, releases on fulfilment or refunds on timeout. Enforces the launch caps. Holds the `forceRefund` escape hatch. |
| `MirrorNFT.sol` | ERC-721 mirror of a custodied Collector Crypt card. Operator-gated mint (one per order, forever), burn on sell-back, owner-initiated burn on unwrap. |
| `Fulfiller.sol` | Holds the operator role on both, so mint + escrow release happen in one transaction or not at all. Holds no funds. |

## Roles

Four distinct keys. The separation is the security model, not a formality:

- **owner** — admin key. Machine config, caps, role rotation, `forceRefund`. Held by a human, never loaded into the worker process.
- **operator** — the `Fulfiller` contract. Its `caller` is the worker's hot key.
- **guardian** — automated health monitor. Can pause and nothing else; cannot unpause.
- **revenueRecipient** — cold treasury, separate from day one.

`owner != worker` is asserted in the deploy script. If they were the same key, a compromised
worker could drain escrow through `forceRefund`, which is exactly what the 2-hour age gate
and the owner-only modifier exist to prevent.

## Running

```bash
forge build
forge test              # 77 tests
forge test --profile ci # heavier fuzz/invariant runs
forge snapshot          # regenerate .gas-snapshot
```

## Test coverage against doc 03 §4

| Spec item | Where |
|---|---|
| §4.1 happy paths, timeout refund | `PackSale.t.sol` |
| §4.2 refund/fulfil exclusion + slow-fulfil case | `PackSale.t.sol` |
| §4.2b forceRefund exclusion matrix + preconditions | `PackSale.t.sol` |
| §4.3 caps (daily, price, open orders, day rollover) | `PackSale.t.sol` |
| §4.4 pause semantics (refunds always allowed) | `PackSale.t.sol` |
| §4.5 mirror mint/burn/unwrap-fee/EIP-712 | `MirrorNFT.t.sol` |
| §4.6 USDG edge cases incl. fee-on-transfer | `PackSale.t.sol` |
| §4.7 fuzz + invariants | `Invariants.t.sol`, `InvariantCoverage.t.sol` |
| §4.8 gas snapshot | `.gas-snapshot` |
| Fulfilment atomicity | `Fulfiller.t.sol` |

`InvariantCoverage.t.sol` exists because the invariant handler swallows reverts by design —
it drives each action by hand and asserts every terminal state is reachable, so a wiring
mistake can't leave the fuzzer spinning on no-ops while the invariants "pass".

## Known gaps before mainnet

1. **Slither not yet run** (doc 03 §4.8). Requires a Python toolchain; not installed here.
2. **USDG address unknown** — doc 01 T5. `MockUSDG` (6dp) stands in. Confirm decimals and
   read the real token for transfer quirks before deploying.
3. **Unwrap fee is built but disabled** (`unwrapFeeBps = 0`). It only switches on if doc 01
   T3 shows CC's buyback right travels with the NFT. If T3 says otherwise, delete the
   EIP-712 path rather than leaving dead code in an unaudited contract.
4. **Unaudited.** Caps bound worst-case loss to one day's volume; that is the whole defence
   at launch. Audit is milestone M4.

## Deploying

```bash
cp .env.example .env    # fill in; never commit
forge script script/Deploy.s.sol --rpc-url $RH_RPC_URL --broadcast --verify
```

Deploy order is load-bearing: MirrorNFT → PackSale → Fulfiller. Machines stay disabled
until the owner explicitly enables one at a confirmed price.
