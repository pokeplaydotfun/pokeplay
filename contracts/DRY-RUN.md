# Escrow dry runs

Three levels, cheapest first. Run all three before spending a single real ETH:

| Command | What it proves | Cost |
|---|---|---|
| `npm run dry-run` | The escrow **code** works: fresh deploy on anvil, server signs, full lifecycle + refund + owner powers (24 checks). | free |
| `npm run dry-run:ui` | The **browser** flow works: real Chromium + stubbed wallet, unclaimed banner, claim/withdraw, team builder, replays, and the whole **paid-tournament** UI against a real pool — post a pool from the create form, pay in, extend, leave for a refund **and withdraw it**, cancel, reclaim, the champion's prize, a pot that closes with one player being unlocked and refunded by its own entrant, and that the runner-up is offered nothing (36 checks). | free |
| `npm run dry-run:fork` | The **live deployment** works: forks Robinhood mainnet and drives the REAL contract `0xdE14…dAA0` — same bytecode, constructor args and chain id that hold real money. Checks the on-chain config against `DEPLOY-CONFIG.md`, then runs all 24 lifecycle checks. | free |
| `npm run dry-run:tournament` (and `FORK=1 …`) | The **tournament pool** works: deploys `PokePlayTournamentPool`, then create → joins → arbiter-signed settle → withdraw, plus timeout refund and organizer cancel (11 checks). No game server; the arbiter signs directly. See `contracts/TOURNAMENT-POOL.md`. | free |
| `--rpc-url robinhood_testnet` (below) | The same flow with **real transactions and real keys** on a public chain. | testnet ETH |

`dry-run:fork` is the closest thing to the mainnet smoke test that costs nothing
and touches no real funds. It cannot write to mainnet — anvil forks read-only and
every write lands on the throwaway local fork. Two fork-only quirks it handles:
the owner is impersonated (`--auto-impersonate`, no key needed), and Robinhood's
L2 fee is not modelled by anvil on a fork, so it runs zero-gas and tops accounts
up before each tx and asserts exact amounts against the escrow's own balance
rather than any wallet. See `scripts/dry-run/run-fork.sh`.

---

## Full run on the real testnet (real keys)

The point of this is to exercise the **whole** path once, with real transactions,
before a single real ETH stake exists: deploy → post a wager → accept → battle →
settle → withdraw, plus a forced timeout refund.

The 84 contract tests all pass, but they have never run against a live chain with
the real server doing the signing. Everything below is about finding the gap
between those two things while it is free to find.

| | |
|---|---|
| Chain | Robinhood **testnet** |
| Chain id | `46630` (`0xb626`) |
| RPC | `https://rpc.testnet.chain.robinhood.com` |
| Mainnet, for contrast | `4663`, `https://rpc.mainnet.chain.robinhood.com` |

---

## Keys: read this first

You need **two** keys. They must be different, and neither should ever be pasted
into a chat, a commit, or an env var that gets logged.

| Key | Holds | How it is stored |
|---|---|---|
| **Deployer / owner** | Can rotate the arbiter, pause, set fees | Foundry keystore or hardware wallet. Never an env var. |
| **Arbiter** | Signs match results — **can move any pot to either player** | Raw key in the server's environment. Unavoidable: the server signs on every match. |

The arbiter key is the dangerous one. From the contract's own header: *if the
arbiter key is stolen, every active wager can be drained to an attacker-chosen
participant.* On testnet this does not matter. Before mainnet, decide where that
key actually lives — the current plan is an env var on a VPS that also runs three
other projects, and that is worth revisiting.

Generate both yourself. Do not send them to me, and do not let me generate them.

```sh
# Deployer: interactive, password-protected, stored in ~/.foundry/keystores
cast wallet import pokeplay-testnet-deployer --interactive

# Arbiter: a throwaway for testnet only
cast wallet new
```

Fund the deployer with testnet ETH. Fund the arbiter with a little too — it only
signs, it never sends, but a small balance avoids surprises if that changes.

---

## 1. Deploy

`ARBITER` is the *address* of the arbiter key, not the key itself.

```sh
cd contracts

ARBITER=0x<arbiter-address> \
TREASURY=0x<your-treasury-address> \
FEE_BPS=250 \
forge script script/Deploy.s.sol:Deploy \
  --rpc-url robinhood_testnet \
  --account pokeplay-testnet-deployer \
  --broadcast
```

Write down the deployed address and the printed `domainSeparator`.

Deliberately **do not** transfer ownership to a multisig on testnet — you want to
be able to test `setArbiter` and `pause`.

## 2. Point the stack at it

Server (`/etc/slabshowdown.env` or your local shell):

```sh
CHAIN_ID=46630
RPC_URL=https://rpc.testnet.chain.robinhood.com
ESCROW_ADDRESS=0x<deployed>
ARBITER_PRIVATE_KEY=0x<arbiter key>
```

Frontend build:

```sh
VITE_CHAIN_ID=46630 \
VITE_RPC_URL=https://rpc.testnet.chain.robinhood.com \
VITE_ESCROW_ADDRESS=0x<deployed> \
npx vite build
```

**On startup the server now verifies this for you.** It reads `eip712Domain()`
and `arbiter()` off the contract and refuses to boot if either disagrees with
what it is configured to sign. You should see:

```
settlement: escrow domain + arbiter verified on chain
```

If instead it exits with `escrow settlement is misconfigured`, read the diff it
prints — that is exactly the failure that would otherwise have looked like a
working server whose payouts all silently reverted.

## 3. The runs

Two accounts, two browsers. Track gas and wall-clock for each step.

### A. Happy path
1. Both sign in, save a legal team.
2. A posts a paid wager (start at `0.001`). Confirm the stake actually leaves A's balance.
3. B accepts. Confirm B's stake leaves too, and the contract holds both.
4. Play the battle to a real finish.
5. Server signs the result; winner calls settle.
6. **Check the arithmetic on chain**: winner gets pot − fee, treasury accrues the fee, and `feeBps` is what you set.
7. Winner withdraws. Confirm the balance lands.

### B. Draw
Force a draw (both sides wiped on the same turn — easiest via a mutual KO).
Confirm both stakes are returned and **no fee is taken**.

### C. Timeout refund — the important one
This is the users' only protection if the arbiter key is lost, so it has to work
without the server's cooperation.

1. Post and accept a wager.
2. Stop the server, or just never settle.
3. Wait out `settleTimeout()`.
4. Either participant calls `claimTimeout`. Both stakes come back, no fee.

### D. Things that should fail
- Settling the same wager twice → second reverts.
- A signature from a *different* key → `InvalidArbiterSignature`.
- Accepting a wager that is already taken.
- Sending value with a zero-stake wager.
- `claimTimeout` before the timeout has elapsed.

### E. Owner powers
- `setArbiter` to a new key, confirm old signatures stop working.
- `pause`, confirm no new wagers can be created, `unpause`.

## 4. Before mainnet

- [ ] Every run above passed, including C and D
- [ ] Decided where the arbiter key lives — this is the open question
- [ ] Owner is a multisig/timelock, not the deploy key (`transferOwnership` is two-step: the new owner must `acceptOwnership`)
- [ ] Monitoring: an alert when a battle finishes but settlement does not follow
- [ ] `FEE_BPS` and `TREASURY` are the real ones
- [ ] Contract verified on Blockscout
- [ ] Frontend rebuilt against mainnet (`VITE_CHAIN_ID` unset or `4663`)

Note the contract's own honest disclosure: `setArbiter` is **retroactive** — it
applies to wagers that are already active, so an owner can in one transaction
point the arbiter at a key it controls and settle live wagers to itself. That is
an accepted trade (the alternative makes a lost arbiter key unrotatable), which
is exactly why the owner should end up as a multisig.
