/**
 * Can we actually do a real pack open right now?
 *
 * Checks the whole path end to end and names what is missing. Reports; never acts.
 */
import { createPublicClient, http, parseAbi } from "viem";
import { loadConfig } from "../src/config.ts";
import { RhChain, machineIdToBytes32 } from "../src/chains/rh.ts";
import { SolanaChain } from "../src/chains/solana.ts";
import { CollectorCryptApi } from "../src/cc/client.ts";
import { DeBridgeClient } from "../src/bridge/debridge.ts";

const MACHINE = process.argv[2] ?? "pokemon_50";
const cfg = loadConfig();
let blockers = 0;
let warnings = 0;
const ok = (m, d = "") => console.log(`  ok      ${m}${d ? "  " + d : ""}`);
const no = (m, d = "") => { blockers++; console.log(`  BLOCKED ${m}${d ? "  " + d : ""}`); };
const warn = (m, d = "") => { warnings++; console.log(`  WARN    ${m}${d ? "  " + d : ""}`); };

console.log(`\nReadiness for a real open of ${MACHINE}\n`);

const rh = new RhChain(cfg);
const bridge = new DeBridgeClient(cfg);
const sol = new SolanaChain(cfg);

// --- money and gas -------------------------------------------------------
const gas = await rh.workerGasBalance();
const gasEth = Number(gas) / 1e18;
// One open costs ~0.00108 ETH: deBridge's fixed fee plus gas on both transactions.
gasEth >= 0.005 ? ok("worker ETH", `${gasEth.toFixed(6)} (~${Math.floor(gasEth / 0.00108)} opens)`)
                : no("worker ETH too low", `${gasEth.toFixed(6)}`);

const r = await sol.readiness();
r.ok ? ok("operator SOL", `${(r.solLamports / 1e9).toFixed(4)}`)
     : no("operator SOL", r.reasons.join("; "));

// Operator USDC is FLOAT, not just pass-through. The bridge deducts its fee from the
// transfer, so a machine priced at exactly the pack price always arrives short and the
// difference comes from here. Judged per machine below, where both prices are known.
ok("operator USDC float", `$${(Number(r.usdc) / 1e6).toFixed(2)}`);

// --- contracts -----------------------------------------------------------
const m = await rh.machineIsLive(MACHINE);
m.enabled
  ? ok("machine enabled on chain", `price ${Number(m.priceUsdg) / 1e6} USDG`)
  : no("machine NOT enabled", `call setMachine(${machineIdToBytes32(MACHINE)}, <price>, true)`);

// --- Collector Crypt -----------------------------------------------------
const cc = new CollectorCryptApi({ apiUrl: cfg.cc.apiUrl, referralCode: cfg.cc.referralCode });
try {
  const found = await cc.machineStatus(MACHINE);
  const priceUsd = Number(found.priceUsdc) / 1e6;
  found.available
    ? ok("CC machine live", `$${priceUsd}, ${found.packsRemaining} in stock, buyback ${found.instantBuybackPct}%`)
    : no("CC machine out of stock", MACHINE);

  // Our on-chain price must cover CC's price AFTER the bridge takes its cut. Comparing the
  // two prices directly is not enough and used to pass this check wrongly: deBridge deducts
  // its fee from the transfer itself, so bridging exactly $250 delivers $249.07 against a
  // $250 pack. pokemon_50 and water_100 only clear it because their $3 service fee is
  // bridged along with the price — that fee is load-bearing.
  //
  // Whatever the bridge eats beyond the machine's own surplus has to come from float sitting
  // on the operator wallet, so the two questions are answered together.
  if (m.enabled) {
    const onChain = Number(m.priceUsdg) / 1e6;
    const floatUsd = Number(r.usdc) / 1e6;

    let arrives = null;
    try {
      const q = await bridge.quote("rh", "solana", m.priceUsdg.toString());
      arrives = Number(q.amountOut) / 1e6;
    } catch (e) {
      warn("could not quote the bridge", `${e.message} — falling back to a naive price compare`);
    }

    if (arrives === null) {
      onChain >= priceUsd
        ? ok("on-chain price covers CC", `${onChain} >= ${priceUsd} (bridge cut UNKNOWN)`)
        : no("on-chain price BELOW CC price", `${onChain} < ${priceUsd}`);
    } else if (arrives >= priceUsd) {
      const surplus = arrives - priceUsd;
      ok(
        "bridged amount covers the pack",
        `$${arrives.toFixed(2)} arrives vs $${priceUsd.toFixed(2)} pack  ->  +$${surplus.toFixed(2)} added to float`,
      );
    } else {
      // The machine cannot fund its own pack. Float has to make up the difference on EVERY
      // open, so this is a question about runway, not a one-off top-up.
      const short = priceUsd - arrives;
      const opens = short > 0 ? Math.floor(floatUsd / short) : 0;
      if (floatUsd >= short) {
        warn(
          `${MACHINE} needs float`,
          `$${arrives.toFixed(2)} arrives vs $${priceUsd.toFixed(2)} pack, short $${short.toFixed(2)} per open. ` +
            `Float $${floatUsd.toFixed(2)} covers ~${opens} more.`,
        );
      } else {
        no(
          `${MACHINE} cannot fund its pack`,
          `$${arrives.toFixed(2)} arrives vs $${priceUsd.toFixed(2)} pack, short $${short.toFixed(2)}, ` +
            `float is only $${floatUsd.toFixed(2)}. Add USDC to ${cfg.solana.operatorAddress}, ` +
            `or give this machine a service fee.`,
        );
      }
    }
  }
} catch (e) {
  no("CC machine lookup failed", e.message);
}

/* --- sell-back (Flow B) --------------------------------------------------
 *
 * Checked separately because it is LIVE and has never executed end to end. Everything below
 * is a precondition that fails SILENTLY or fails LATE:
 *
 *  - a wrong custodian means every arriving mirror is unmatched and swept back, so sell-back
 *    just quietly never works;
 *  - a missing role or empty SOL fails AFTER the card has already gone to Collector Crypt,
 *    which is the one state escrow exists to prevent.
 *
 * It cannot prove the sale itself: CC quotes via /buyback/available?wallet=..&nft=.., which
 * checks that the wallet owns the NFT, and we hold no cards. That gap closes on the next open.
 */
console.log("\nSell-back (Flow B) — live, never yet executed end to end");

if (!cfg.sellBackEnabled) {
  ok("SELL_BACK_ENABLED=false", "arriving mirrors are swept back to the sender, nothing is sold");
} else {
  const MIRROR = parseAbi([
    "function custodian() view returns (address)",
    "function operator() view returns (address)",
  ]);
  const FULFILLER = parseAbi(["function caller() view returns (address)"]);
  const pub = createPublicClient({ transport: http(cfg.rh.rpcUrl) });
  const worker = cfg.rh.workerAddress.toLowerCase();

  try {
    const custodian = await pub.readContract({
      address: cfg.rh.mirrorAddress, abi: MIRROR, functionName: "custodian",
    });
    custodian.toLowerCase() === worker
      ? ok("Mirror.custodian is the worker", custodian)
      : no("Mirror.custodian is NOT the worker",
          `${custodian} — every sell-back deposit would be unmatched and swept back, silently`);

    const mOperator = await pub.readContract({
      address: cfg.rh.mirrorAddress, abi: MIRROR, functionName: "operator",
    });
    mOperator.toLowerCase() === cfg.rh.fulfillerAddress.toLowerCase()
      ? ok("Mirror.operator is the Fulfiller", mOperator)
      : no("Mirror.operator is NOT the Fulfiller", `${mOperator} — burnForSell would revert AFTER the card is sold`);

    const caller = await pub.readContract({
      address: cfg.rh.fulfillerAddress, abi: FULFILLER, functionName: "caller",
    });
    caller.toLowerCase() === worker
      ? ok("Fulfiller.caller is the worker", caller)
      : no("Fulfiller.caller is NOT the worker", `${caller} — burnAfterSell would revert AFTER the card is sold`);
  } catch (e) {
    warn("could not read the sell-back roles", e.message);
  }

  /**
   * The return leg's true cost, and what it implies about which cards are worth buying back.
   *
   * The native half is paid in SOL from CUSTODY, not from the worker's ETH, so custody running
   * dry strands a seller mid-flow. Priced here for that reason as much as for the economics.
   */
  try {
    const SAMPLE = 40_000_000n;
    const back = await bridge.quote("solana", "rh", SAMPLE.toString());
    const stableCost = Number(SAMPLE - BigInt(back.amountOut)) / 1e6;

    const url = new URL(`${cfg.bridge.apiUrl}/dln/order/create-tx`);
    url.searchParams.set("srcChainId", String(cfg.bridge.solanaChainId));
    url.searchParams.set("srcChainTokenIn", cfg.solana.usdcMint);
    url.searchParams.set("srcChainTokenInAmount", SAMPLE.toString());
    url.searchParams.set("dstChainId", String(cfg.bridge.rhChainId));
    url.searchParams.set("dstChainTokenOut", cfg.rh.usdgAddress);
    url.searchParams.set("dstChainTokenOutRecipient", cfg.rh.workerAddress);
    url.searchParams.set("srcChainOrderAuthorityAddress", cfg.solana.operatorAddress);
    url.searchParams.set("dstChainOrderAuthorityAddress", cfg.rh.workerAddress);
    url.searchParams.set("prependOperatingExpenses", "false");
    const tx = await (await fetch(url)).json();

    if (tx.fixFee) {
      // NativePrice takes (fetchImpl, fallback) — NOT cfg. Passing cfg makes every price
      // lookup throw and silently fall back to the deliberately-high $300/SOL, which reads as
      // a $5.41 sell-back instead of the real $2.07. The fallback is meant to over-estimate,
      // so the bug shows up as pessimism rather than as free money. It still lies.
      const { NativePrice } = await import("../src/bridge/native-price.ts");
      const solFeeUsd = await new NativePrice().nativeToUsd("SOL", BigInt(tx.fixFee));
      const total = stableCost + solFeeUsd;
      const breakEven = total / (cfg.economics.spreadBps / 10_000);
      ok("return leg live",
        `$${total.toFixed(2)} per sell-back ($${stableCost.toFixed(2)} stable + $${solFeeUsd.toFixed(2)} SOL)`);
      // Settled: the operator absorbs sub-break-even sell-backs. Reported, never a blocker.
      console.log(`          below $${breakEven.toFixed(2)} insured a sell-back loses money — absorbed by choice`);

      // fixFee is denominated in the source chain's native unit, so on this leg it is
      // lamports — comparable directly against custody's SOL balance.
      const feeLamports = Number(BigInt(tx.fixFee));
      const sales = feeLamports > 0 ? Math.floor(r.solLamports / feeLamports) : Infinity;
      sales >= 5
        ? ok("custody SOL covers the return leg", `~${sales} sell-backs of headroom`)
        : no("custody SOL too low for the return leg",
            `~${sales} sell-backs — running dry strands a seller AFTER their card is sold`);
    } else {
      warn("could not read the return leg's native fee", "true cost is HIGHER than the stablecoin delta");
    }
  } catch (e) {
    no("return leg does not quote", `${e.message} — a sell-back would strand after the card is sold`);
  }

  const ceiling = cfg.maxSellBackValueUsd;
  if (ceiling) ok("sell-back value ceiling", `$${ceiling} insured, enforced on the escrow deposit`);
}

// --- safety switch -------------------------------------------------------
cfg.useMocks
  ? no("USE_MOCKS=true", "set false to let the worker touch real money")
  : ok("USE_MOCKS=false", "LIVE");

console.log(
  `\n${blockers ? `${blockers} blocker(s)` : "ready for a real open"}` +
    `${warnings ? `, ${warnings} warning(s)` : ""}\n`,
);
process.exit(blockers ? 1 : 0);
