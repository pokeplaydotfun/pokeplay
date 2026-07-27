/**
 * Prove a bridge leg end to end, in either direction.
 *
 * This is the leg that gates BOTH sell-back (Flow B) and Turbo, and it has never run against
 * the real network. Everything else in the system has been exercised; this has not.
 *
 * WHY THIS DOES NOT NEED A PACK OPEN
 *
 * The plan had been to open a pack and bridge back the ~$2.22 of leftover USDC. But the leg
 * only needs USDC sitting on Solana, and the operator float already provides that. So we can
 * prove it with no card in custody, no buyer's money involved, and nothing to unwind if it
 * fails. A failed pack open costs a real pack; a failed bridge test costs the fee.
 *
 * WHAT IT ACTUALLY PROVES
 *
 * It drives `DeBridgeClient.execute("solana", "rh", ...)` — the exact call
 * `buybacks.bridge.toRhChain` makes in worker.ts, not a hand-rolled request. So a pass covers
 * our own code, not just deBridge's uptime:
 *
 *   - createTx builds a valid Solana-side order
 *   - SolanaChain.signAndSend deserialises, signs and submits a VersionedTransaction
 *   - the cost gate prices a SOL-denominated fixFee correctly (the outbound leg's ETH fee was
 *     already wrong once; this is the same code on a different chain)
 *   - awaitFill detects the fill and returns the destination tx
 *   - the USDG actually lands in the worker wallet on Robinhood Chain
 *
 * COST, measured not estimated: ~$0.87 stablecoin spread + 0.015 SOL fixed fee (~$1.14), so
 * about $2.01 in total. The fee is FLAT, so a $5 transfer costs the same as a $25 one.
 *
 * The principal is not burned: it arrives as USDG in the worker wallet, which is the same
 * address the buyer wallet uses, so it counts toward the $53 needed for the first pack.
 *
 *   node --experimental-strip-types scripts/prove-bridge.mjs            # dry, quotes only
 *   node --experimental-strip-types scripts/prove-bridge.mjs --send 5   # SPENDS ~$2
 */
import { loadConfig } from "../src/config.ts";
import { DeBridgeClient } from "../src/bridge/debridge.ts";
import { SolanaChain } from "../src/chains/solana.ts";
import { RhChain } from "../src/chains/rh.ts";
import { NativePrice } from "../src/bridge/native-price.ts";

const cfg = loadConfig();
const sendIdx = process.argv.indexOf("--send");
const SEND = sendIdx !== -1;
const AMOUNT_USD = SEND ? Number(process.argv[sendIdx + 1] ?? 5) : 5;
/**
 * Direction. `in` is Solana -> RH (the sell-back payout leg). `out` is RH -> Solana, which
 * EVERY PACK OPEN uses, and which runs through completely different code: sendEvm and an
 * ERC-20 allowance, rather than Solana transaction signing. Proving one says nothing about
 * the other, which is exactly why both are worth running.
 */
const OUT = process.argv.includes("--out");
const FROM = OUT ? "rh" : "solana";
const TO = OUT ? "solana" : "rh";
const amountBase = BigInt(Math.round(AMOUNT_USD * 1e6)).toString();

const usd = (v) => `$${(Number(v) / 1e6).toFixed(2)}`;
const ok = (m, d = "") => console.log(`  ok      ${m}${d ? "  " + d : ""}`);
const bad = (m, d = "") => console.log(`  FAILED  ${m}${d ? "  " + d : ""}`);

const solana = new SolanaChain(cfg);
const rh = new RhChain(cfg);
const price = new NativePrice();

console.log(`\nBridge proof — ${OUT ? "Robinhood Chain USDG -> Solana USDC" : "Solana USDC -> Robinhood Chain USDG"}\n`);

// ---------------------------------------------------------------- before
const usdcBefore = await solana.usdcBalance();
const usdgBefore = await rh.usdgBalance();
// solBalance() returns LAMPORTS, not SOL. Converting here so the guard below is real:
// comparing lamports against 0.02 would pass for any balance, including empty.
const solBefore = (await solana.solBalance()) / 1e9;
console.log("Balances before");
console.log(`  Solana USDC   ${usd(usdcBefore)}`);
console.log(`  Solana SOL    ${solBefore.toFixed(4)}`);
console.log(`  RH USDG       ${usd(usdgBefore)}   (worker ${rh.workerAddress})`);

// ---------------------------------------------------------------- feasibility
console.log("\nFeasibility");
const sourceBal = OUT ? usdgBefore : usdcBefore;
const sourceName = OUT ? "USDG on RH" : "USDC on Solana";
if (sourceBal < BigInt(amountBase)) {
  bad(`not enough ${sourceName}`, `have ${usd(sourceBal)}, want ${usd(amountBase)}`);
  process.exit(1);
}
ok(`${sourceName} covers the transfer`, `${usd(sourceBal)} available`);

const quoteOnly = new DeBridgeClient(cfg);
const q = await quoteOnly.quote(FROM, TO, amountBase);
const arrives = BigInt(q.amountOut);
const spread = BigInt(amountBase) - arrives;
// The fixed fee is denominated in the SOURCE chain's native token, and the two differ by
// three orders of magnitude in units. Getting this wrong is how the outbound cost was
// under-reported once already.
const fixFeeUsd = OUT
  ? await price.nativeToUsd("ETH", 1_000_000_000_000_000n) // 0.001 ETH
  : await price.nativeToUsd("SOL", 15_000_000n); // 0.015 SOL
console.log(`  send ${usd(amountBase)} -> arrives ${usd(arrives)}`);
console.log(`  stablecoin spread $${(Number(spread) / 1e6).toFixed(2)} + fixed fee $${fixFeeUsd.toFixed(2)} = $${(Number(spread) / 1e6 + fixFeeUsd).toFixed(2)} total cost`);

if (OUT) {
  const ethWei = await rh.workerGasBalance();
  if (ethWei < 2_000_000_000_000_000n) {
    bad("not enough ETH for the 0.001 fixed fee plus gas", `${(Number(ethWei) / 1e18).toFixed(5)} ETH`);
    process.exit(1);
  }
  ok("ETH covers the 0.001 fixed fee plus gas", `${(Number(ethWei) / 1e18).toFixed(5)} ETH`);
} else {
  if (solBefore < 0.02) {
    bad("not enough SOL for the 0.015 fixed fee", `${solBefore.toFixed(4)} SOL`);
    process.exit(1);
  }
  ok("SOL covers the 0.015 fixed fee", `${solBefore.toFixed(4)} SOL`);
}

if (!SEND) {
  console.log("\nDry run. Nothing was sent.");
  console.log(`Re-run with  --send ${AMOUNT_USD}${OUT ? " --out" : ""}  to execute for real (~$${(Number(spread) / 1e6 + fixFeeUsd).toFixed(2)}).\n`);
  process.exit(0);
}

// ---------------------------------------------------------------- execute
console.log("\nExecuting — this spends real money");

/**
 * An in-memory store, so a proof run leaves no row in the production database. The store
 * interface is still exercised; only its persistence is swapped.
 */
const mem = new Map();
const store = {
  async get(key) {
    return mem.get(key) ?? null;
  },
  async set(key, value) {
    mem.set(key, value);
  },
};

const bridge = new DeBridgeClient(cfg, {
  store,
  solana: { signAndSend: (b64) => solana.signAndSend(b64) },
  evm: {
    sendTransaction: (tx, onSent) => rh.sendRaw(tx, onSent),
    // Without this the outbound deposit reverts: deBridge pulls the USDG with transferFrom
    // and the worker's allowance to it was zero.
    ensureAllowance: (token, spender, amount) => rh.ensureAllowance(token, spender, amount),
  },
});

const reference = `bridge-proof:${Date.now()}`;
const started = Date.now();
let result;
try {
  // The exact call worker.ts makes for a sell-back payout.
  result = await bridge.execute(FROM, TO, amountBase, q, reference);
} catch (err) {
  bad("execute threw", err instanceof Error ? err.message : String(err));
  console.log("\nCheck the Solana wallet before retrying: a deposit may have gone out.\n");
  process.exit(1);
}
const elapsed = ((Date.now() - started) / 1000).toFixed(0);

ok("deposit submitted", result.depositTx ?? "(none)");
ok("deBridge order", result.providerOrderId ?? "(none)");
// A null fillTx is expected on this route: deBridge's status endpoint returns only
// {status, orderId} for Solana -> RH. The balance delta below is the real proof.
result.fillTx
  ? ok("fill tx", result.fillTx)
  : ok("fill tx not reported by deBridge", "expected on this route; balance is the proof");
ok("elapsed", `${elapsed}s`);

// ---------------------------------------------------------------- after
const usdcAfter = await solana.usdcBalance();
const usdgAfter = await rh.usdgBalance();
console.log("\nBalances after");
console.log(`  Solana USDC   ${usd(usdcAfter)}   (${usd(usdcAfter - usdcBefore)})`);
console.log(`  RH USDG       ${usd(usdgAfter)}   (+${usd(usdgAfter - usdgBefore)})`);

const gained = OUT ? usdcAfter - usdcBefore : usdgAfter - usdgBefore;
console.log("");
if (gained > 0n) {
  ok(`THE ${OUT ? "OUTBOUND" : "INBOUND"} LEG WORKS`, `${usd(gained)} arrived as ${OUT ? "USDC on Solana" : "USDG on RH"}`);
  console.log("\n  Sell-back and Turbo are no longer blocked on an unproven bridge.");
  console.log("  Remaining sell-back prerequisites are in docs/audit-2026-07-19-preflight.md.\n");
} else {
  bad("no USDG arrived yet", "the fill may still be in flight; re-check the balance shortly");
  console.log(`\n  deposit ${result.depositTx}\n  order   ${result.providerOrderId}\n`);
}
