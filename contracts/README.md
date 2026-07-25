# PokePlayEscrow

Native-ETH escrow for 1v1 PvP wagers on **Robinhood Chain** (EVM, chain id `4663`,
Arbitrum-Orbit L2). Two players stake equal amounts, the battle happens off-chain on
our server, the server signs the result, and the contract pays the winner.

- Contract: [`src/PokePlayEscrow.sol`](src/PokePlayEscrow.sol)
- Tests: [`test/`](test/) — 84 tests, 100% line/branch/function coverage
- Deploy: [`script/Deploy.s.sol`](script/Deploy.s.sol)

---

## The trust model, in plain language

**This contract is not trustless. Read this before putting real money in it.**

### The arbiter decides who wins. Full stop.

The `arbiter` key — our game server — signs a message saying "player X won wager N",
and the contract pays player X. The contract has **no idea what happened in the
game**. It does not verify moves, scores, or anything about the match. It checks one
thing: that the signature came from the arbiter key.

That means:

- The arbiter can declare **either player** the winner of **any active wager**, for
  any reason or no reason.
- If the arbiter key is stolen, an attacker can settle every currently-active wager
  in whatever direction they like.
- If we are dishonest, we can rig every match. Nothing on-chain stops us.

Players are trusting *us*, not the blockchain. The contract's job is narrower: to
make sure that even a fully malicious arbiter **cannot steal the money outright**.

### What the arbiter still cannot do

1. **It cannot pay itself, or any third party.** A settlement can only credit the
   creator or the opponent of that specific wager. A signature naming anyone else
   reverts.
2. **It cannot touch unaccepted wagers.** Only `ACTIVE` wagers can be settled.
3. **It cannot touch money already won.** Once funds are credited to your withdrawable
   balance, no arbiter or owner action can claw them back.
4. **It cannot keep your money by doing nothing** — see the escape hatch below.
5. **It cannot replay a signature.** Every signature is bound to one wager id, one
   nonce, one chain, and one contract address.

### The timeout escape hatch (what saves you if we vanish)

If the server dies, gets censored, goes rogue, or simply never signs, **either
player can call `claimTimeout(id)`** once the wager has been `ACTIVE` for longer than
`settleTimeout` (default **1 hour**, hard-capped at 7 days).

Both sides get their **exact original stake back, with no fee**. No signature and no
admin action is required, and it works even while the contract is paused.

So the worst the arbiter can do by going silent is stall you for up to an hour. It
can never keep your stake.

> **Caveat, stated honestly:** the owner can raise `settleTimeout` (max 7 days),
> and that applies to already-active wagers. So the owner can *delay* the escape
> hatch to at most 7 days. It can never disable it.

### What the owner can and cannot do

The `owner` is a separate, weaker role.

Can: rotate the arbiter, rotate the treasury, change the fee (hard-capped at **5%**,
enforced in both the constructor and the setter), change the settle timeout (5 min–7
days), and pause new wagers.

**Cannot: touch a single wei of user stakes.** This is structural, not a promise:

- There is no admin withdraw, no sweep, no `selfdestruct`, no arbitrary `call`.
- The *only* function that sends ETH out is `withdraw()`, which pays
  `msg.sender` exactly `balances[msg.sender]`.
- Fees are credited to `balances[treasury]` at settlement and are withdrawn through
  that same public path.
- The owner's balance is only ever credited if the owner *is* the treasury, and then
  only by accrued fees.

Enforced by `test_ownerCannotDrainStakes_*` and by an invariant campaign in which the
owner meddles (including pointing the arbiter and treasury at itself) on every step
and still extracts zero.

### The one retroactivity tradeoff we chose

`setArbiter` takes effect **immediately, including for already-active wagers**. The
owner can therefore point the arbiter at a key it controls and settle every in-flight
wager however it likes.

We considered snapshotting the arbiter per-wager at creation time. We rejected it:
that would mean a **compromised arbiter key could never be rotated out** from under
wagers already in flight — those wagers would stay settleable by a known-stolen key
until they timed out. That is a worse failure mode.

So: immediate rotation, documented rather than hidden. The mitigation is
operational, not cryptographic:

- **Own this contract with a multisig and/or a timelock, never a hot EOA.**
- Keep `settleTimeout` short, so the value in flight at any moment is small.

### Other limitations worth knowing

- **Anyone can accept an open wager.** There is no designated-opponent field; the
  first caller to match the stake gets the match.
- **A creator can cancel to dodge an incoming accept.** `cancelWager` is available
  to the creator at any time while `OPEN`, so a creator watching the mempool can
  front-run an acceptance. Nobody loses funds; it is a matchmaking annoyance.
- **Fee rounding floors**, so it always favours the winner over the house, and
  `payout + fee == pot` exactly, with no wei stranded.
- **Zero-stake wagers are fully supported** and simply pay out nothing.
- The contract **rejects plain ETH transfers** — every wei must arrive attached to a
  stake.
- Timestamps are used at hour granularity, so sequencer timestamp drift is not a
  meaningful attack surface here.

---

## Security design summary

| Requirement | How |
| --- | --- |
| Reentrancy | OZ `ReentrancyGuard` on every fund-moving external function, plus strict checks-effects-interactions (status set to terminal *before* any credit). |
| Pull payments | Nothing is pushed. Settlement credits `balances[addr]`; `withdraw()` is the only ETH exit, using `call{value:}` with a success check. A participant with a reverting `receive()` cannot block anyone else's settlement. |
| Replay protection | EIP-712 with a domain of `("PokePlayEscrow", "1", chainId, verifyingContract)`, plus the wager id **and** a per-wager nonce inside the signed struct. Terminal status makes each signature single-use. |
| Chain-fork safety | OZ `EIP712` caches the domain separator and recomputes it whenever `block.chainid` or `address(this)` changes. |
| Signature malleability | OZ `ECDSA.tryRecover`, which rejects high-`s` values, bad `v`, wrong length, and never returns `address(0)`. |
| Double settlement | Explicit `Status` enum (`NONE/OPEN/ACTIVE/SETTLED/REFUNDED/CANCELLED`), not booleans. |
| Fee cap | `MAX_FEE_BPS = 500`, enforced in the constructor *and* the setter. |
| Ownership | `Ownable2Step` — a typo'd address cannot lose ownership. |
| Pause scope | Blocks `createWager`/`acceptWager` only. `settle`, `settleDraw`, `claimTimeout`, `cancelWager` and `withdraw` always work. |
| Stake integrity | `acceptWager` requires `msg.value == stake` exactly, never `>=`. |

---

## Signing a result (server side)

The arbiter signs EIP-712 typed data:

```
Domain: { name: "PokePlayEscrow", version: "1", chainId: 4663, verifyingContract: <address> }

BattleResult(uint256 wagerId,address winner,uint256 nonce)
DrawResult(uint256 wagerId,uint256 nonce)
```

`nonce` is the per-wager nonce assigned at creation — read it from
`getWager(id).nonce`. Cross-check what you are about to sign with the view helpers
`battleResultDigest(id, winner)` and `drawResultDigest(id)`, which return the exact
digest the contract will verify.

---

## Build and test

```bash
forge build
forge test
forge test -vvv                              # verbose
forge coverage --no-match-coverage "(script|test)"
```

Current status: **84 passing, 0 failing. 100% lines, statements, branches, functions.**

---

## Deploy to Robinhood Chain

**Never put a private key in an env var, a file, or this repo.** The script reads no
key — you supply the signer to `forge script` yourself.

```bash
cd contracts

export ARBITER=0xYourServerSigningAddress
export TREASURY=0xYourFeeRecipient
export FEE_BPS=250          # 2.5%; max 500. Optional, defaults to 250.
# export OWNER=0xYourMultisig   # optional; defaults to the broadcasting sender

forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --chain-id 4663 \
  --account deployer \
  --sender 0xYourDeployerAddress \
  --broadcast
```

Signer options — pick one, do not use `--private-key`:

- `--account deployer` — an encrypted keystore (`cast wallet import deployer --interactive`)
- `--ledger` / `--trezor` — hardware wallet
- `--interactive` — paste the key at the prompt, never stored

Dry-run first by omitting `--broadcast`.

### Post-deploy checklist

1. **Transfer ownership to a multisig or timelock.** Two-step: the current owner
   calls `transferOwnership(multisig)`, then the multisig calls `acceptOwnership()`.
   Ownership does not move until step two.
2. Point the game server's EIP-712 signer at the deployed address and chain id 4663.
3. Confirm `settleTimeout` suits your match length (default 1 hour).
4. Verify the source (below).

---

## Verify on Blockscout

```bash
forge verify-contract <DEPLOYED_ADDRESS> \
  src/PokePlayEscrow.sol:PokePlayEscrow \
  --chain-id 4663 \
  --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api \
  --compiler-version 0.8.24 \
  --num-of-optimizations 200 \
  --constructor-args $(cast abi-encode \
      "constructor(address,address,address,uint16)" \
      $OWNER $ARBITER $TREASURY $FEE_BPS)
```

The constructor args must match the deployment **exactly**, including the `OWNER`
actually used (the broadcasting sender if you did not set `OWNER`). If verification
fails, `cast code <address>` and compare against `out/PokePlayEscrow.sol/` to
confirm the optimizer settings in `foundry.toml` match what you deployed.

Browse the contract at `https://robinhoodchain.blockscout.com/address/<DEPLOYED_ADDRESS>`.

> These verification settings were written against the standard Foundry/Blockscout
> flow but have **not** been exercised against the live Robinhood Chain explorer —
> nothing in this repo has been deployed anywhere. Expect to adjust the
> `--verifier-url` if their API path differs.

---

## Test suite map

| File | Covers |
| --- | --- |
| `test/Base.t.sol` | Fixture, EIP-712 signing helpers, signature malleation helper, solvency assertion. |
| `test/PokePlayEscrow.t.sol` | Happy path, fee maths (0/1/100/250/500 bps + fuzz), zero-stake, create/accept guards, cancel, draw, timeout, state guards, replay & forgery, malleability, cross-contract and cross-chain signature binding, pause scope, access control, two-step ownership, owner-cannot-drain. |
| `test/Reentrancy.t.sol` | Reverting-receiver griefing (cannot block settlement, draw or timeout), reentrant `withdraw()`, reentrant `settle()`, cross-wager reentrancy. |
| `test/Invariant.t.sol` | Randomised campaign over all user *and* owner actions: solvency, ghost-accounting reconciliation, owner-extracts-nothing, live wagers fully backed. Includes a scripted non-vacuity test proving every terminal path is reachable. |
| `test/mocks/Malicious.sol` | `RevertingReceiver`, `ReentrantWithdrawer`, `ReentrantSettler`. |

The suite was validated by mutation testing — six deliberate bugs (unzeroed balance
in `withdraw`, `>=` in `acceptWager`, removed participant check, removed fee cap,
missing `SETTLED` status write, dropped nonce) were each introduced and each caused
test failures.
