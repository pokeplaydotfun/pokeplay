/**
 * Dry run: exercise every real dependency of a pack open WITHOUT spending anything.
 *
 * Written because the first real open is effectively a one-shot — the money for a second
 * attempt may not be there. Everything here is a quote, a read, or a simulation. Nothing
 * signs, nothing submits, nothing moves.
 *
 *   node --experimental-strip-types scripts/dryrun.mjs
 */
import "dotenv/config";
import { createPublicClient, http, parseAbi, stringToHex } from "viem";
import { loadConfig } from "../src/config.ts";
import { DeBridgeClient } from "../src/bridge/debridge.ts";
import { CollectorCryptApi } from "../src/cc/client.ts";
import { NativePrice } from "../src/bridge/native-price.ts";

const cfg = loadConfig();

let failures = 0;
let warnings = 0;
const ok = (label, detail = "") => console.log(`  ok      ${label}${detail ? "  " + detail : ""}`);
const warn = (label, detail = "") => { warnings++; console.log(`  WARN    ${label}${detail ? "  " + detail : ""}`); };
const bad = (label, detail = "") => { failures++; console.log(`  BLOCKED ${label}${detail ? "  " + detail : ""}`); };

const usd = (base) => `$${(Number(base) / 1e6).toFixed(2)}`;

console.log("\nDry run — nothing here spends. Checking a real $50 open end to end.\n");

/* ---------------------------------------------------------------- the money in */

const PACK_SALE_ABI = parseAbi([
  "function machines(bytes32) view returns (uint96 priceUsdg, bool enabled)",
  "function dailyPackCap() view returns (uint32)",
  "function maxOpenOrders() view returns (uint32)",
  "function paused() view returns (bool)",
]);
const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const rh = createPublicClient({ transport: http(cfg.rh.rpcUrl) });
const operator = process.env.OPERATOR_ADDRESS ?? cfg.rh.workerAddress;
const buyer = process.env.DRYRUN_BUYER ?? operator;

console.log("Robinhood Chain");
const machineId = stringToHex("pokemon_50", { size: 32 });
const [priceUsdg, enabled] = await rh.readContract({
  address: cfg.rh.packSaleAddress, abi: PACK_SALE_ABI, functionName: "machines", args: [machineId],
});
enabled ? ok("machine enabled", `price ${usd(priceUsdg)}`) : bad("machine NOT enabled");

const paused = await rh.readContract({ address: cfg.rh.packSaleAddress, abi: PACK_SALE_ABI, functionName: "paused" });
paused ? bad("PackSale is PAUSED") : ok("PackSale not paused");

let buyerUsdg = 0n;
if (buyer) {
  buyerUsdg = await rh.readContract({ address: cfg.rh.usdgAddress, abi: ERC20, functionName: "balanceOf", args: [buyer] });
  if (buyerUsdg >= priceUsdg) ok("buyer USDG", `${usd(buyerUsdg)} — covers ${usd(priceUsdg)}`);
  else bad("buyer USDG", `${usd(buyerUsdg)} — needs ${usd(priceUsdg)} to open a pack`);

  const allowance = await rh.readContract({
    address: cfg.rh.usdgAddress, abi: ERC20, functionName: "allowance", args: [buyer, cfg.rh.packSaleAddress],
  });
  if (allowance >= priceUsdg) ok("USDG allowance already set", usd(allowance));
  else warn("USDG allowance not set", "the UI will ask for one approval first — expected, not a blocker");
}

/* ---------------------------------------------------------------- the bridge out */

console.log("\nBridge, RH -> Solana (the leg that decides whether the pack is affordable)");
const bridge = new DeBridgeClient(cfg, {});
const price = new NativePrice();
let arrives = 0n;
let nativeFeeUsd = 0;

/**
 * `quote()` returns the STABLECOIN delta only. deBridge also charges a fixed fee in the
 * source chain's native token, and reading the delta alone is precisely the mistake that
 * made the $50 tier look viable when it was not (doc: verification-results). So the fixed
 * fee is fetched from create-tx and priced separately.
 *
 * It matters differently to each side: the native fee is paid in ETH out of the worker's
 * gas wallet, so it does NOT reduce what arrives on Solana — but it does drain the wallet
 * that pays for every future open.
 */
try {
  const q = await bridge.quote("rh", "solana", priceUsdg.toString());
  arrives = BigInt(q.amountOut);

  const url = new URL(`${cfg.bridge.apiUrl}/dln/order/create-tx`);
  url.searchParams.set("srcChainId", String(cfg.bridge.rhChainId));
  url.searchParams.set("srcChainTokenIn", cfg.rh.usdgAddress);
  url.searchParams.set("srcChainTokenInAmount", priceUsdg.toString());
  url.searchParams.set("dstChainId", String(cfg.bridge.solanaChainId));
  url.searchParams.set("dstChainTokenOut", cfg.solana.usdcMint);
  url.searchParams.set("dstChainTokenOutRecipient", cfg.solana.operatorAddress);
  url.searchParams.set("srcChainOrderAuthorityAddress", operator);
  url.searchParams.set("dstChainOrderAuthorityAddress", cfg.solana.operatorAddress);
  url.searchParams.set("prependOperatingExpenses", "false");
  const tx = await (await fetch(url)).json();

  if (tx.fixFee) {
    nativeFeeUsd = await price.nativeToUsd("ETH", BigInt(tx.fixFee));
    console.log(`          send ${usd(priceUsdg)}  ->  arrives ${usd(arrives)} on Solana`);
    console.log(`          stablecoin cost  ${usd(priceUsdg - arrives)}   (taken out of the transfer)`);
    console.log(`          native fixed fee $${nativeFeeUsd.toFixed(2)} in ETH   (taken out of the GAS wallet)`);
    console.log(`          true total cost  $${(nativeFeeUsd + Number(priceUsdg - arrives) / 1e6).toFixed(2)}, ~${q.estimatedSeconds}s`);
    if (nativeFeeUsd > cfg.bridge.costAbortUsd) {
      bad("native fee exceeds BRIDGE_COST_ABORT_USD", `$${nativeFeeUsd.toFixed(2)} > $${cfg.bridge.costAbortUsd} — execute() would abort`);
    }
  } else {
    warn("could not read the native fixed fee", "the true cost is higher than the stablecoin delta shown");
    console.log(`          send ${usd(priceUsdg)}  ->  arrives ${usd(arrives)}   stablecoin cost ${usd(priceUsdg - arrives)}`);
  }
} catch (err) {
  bad("bridge quote failed", err instanceof Error ? err.message : String(err));
}

/* ---------------------------------------------------------------- the pack itself */

console.log("\nCollector Crypt");
const cc = new CollectorCryptApi({ apiUrl: cfg.cc.apiUrl, apiKey: cfg.cc.apiKey, referralCode: cfg.cc.referralCode });
let ccPrice = 0n;
try {
  const m = await cc.machineStatus("pokemon_50");
  ccPrice = BigInt(m.priceUsdc);
  m.available ? ok("machine live", `${usd(ccPrice)}, ${m.packsRemaining} packs left`) : bad("machine unavailable");
  ok("buyback rate", `${m.instantBuybackPct}% of insured value`);
} catch (err) {
  bad("CC machine status failed", err instanceof Error ? err.message : String(err));
}

/* ---------------------------------------------------------------- THE margin */

console.log("\nThe number the whole open depends on");
if (arrives > 0n && ccPrice > 0n) {
  const margin = arrives - ccPrice;
  const line = `${usd(arrives)} arrives vs ${usd(ccPrice)} pack price  ->  margin ${usd(margin)}`;
  if (margin < 0n) {
    bad("BRIDGED AMOUNT DOES NOT COVER THE PACK", line);
    console.log("          The bridge would spend, then the purchase would fail for want of USDC.");
  } else if (margin < 500_000n) {
    warn("margin is under $0.50", line);
    console.log("          A small move in bridge fees between now and the open flips this negative.");
  } else {
    ok("bridged amount covers the pack", line);
  }
}

/* ------------------------------------------------- the purchase, built but not sent */

/**
 * `generatePack` asks CC to build and co-sign the purchase. It costs nothing — only
 * `submitTransaction` spends — so this proves the riskiest step short of the point of no
 * return: that CC will actually build us a transaction, co-sign it, and that our key is
 * accepted as the player.
 */
console.log("\nThe purchase transaction (built and co-signed, NOT submitted)");
try {
  const pack = await cc.generatePack("pokemon_50", cfg.solana.operatorAddress);
  if (pack?.transactionBase64) {
    const bytes = Buffer.from(pack.transactionBase64, "base64").length;
    ok("CC builds and co-signs a purchase", `${bytes} byte transaction, memo ${pack.memo ?? "n/a"}`);
    console.log("          Not submitted. Nothing was spent and no pack was opened.");
  } else {
    bad("generatePack returned no transaction");
  }
} catch (err) {
  bad("generatePack failed", err instanceof Error ? err.message : String(err));
  console.log("          This is the step that buys the pack. It must work before a real open.");
}

/* ---------------------------------------------------------------- Solana readiness */

console.log("\nSolana custody wallet");
try {
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const conn = new Connection(cfg.solana.rpcUrl, "confirmed");
  const owner = new PublicKey(cfg.solana.operatorAddress);

  const lamports = await conn.getBalance(owner);
  const sol = lamports / 1e9;
  // A pack open signs several transactions; well under this and it starts failing mid-flow.
  if (sol >= 0.05) ok("SOL for fees", `${sol.toFixed(4)} SOL`);
  else bad("SOL too low", `${sol.toFixed(4)} SOL`);

  // The bridge fill needs somewhere to land. Without an existing USDC account the fill has
  // to create one, which costs rent and is a known way for a first transfer to surprise you.
  const accounts = await conn.getParsedTokenAccountsByOwner(owner, {
    mint: new PublicKey(cfg.solana.usdcMint),
  });
  if (accounts.value.length > 0) {
    const bal = accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount ?? 0;
    ok("USDC token account exists", `balance ${bal}`);
  } else {
    warn("no USDC token account yet", "the first bridge fill has to create one — costs ~0.002 SOL of rent");
  }
} catch (err) {
  warn("Solana checks failed", err instanceof Error ? err.message : String(err));
}

/* ---------------------------------------------------------------- the mint path */

/**
 * If these roles are wrong the open fails AFTER the money is gone: the pack is bought, the
 * card is in custody, and the mint reverts with the buyer holding nothing. Cheap to read,
 * catastrophic to get wrong, so it is checked every time.
 */
console.log("\nThe mint path (wrong roles = pack bought, mirror never minted)");
try {
  const ROLES = parseAbi([
    "function caller() view returns (address)",
    "function operator() view returns (address)",
  ]);
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();

  const fulfillerCaller = await rh.readContract({ address: cfg.rh.fulfillerAddress, abi: ROLES, functionName: "caller" });
  same(fulfillerCaller, operator)
    ? ok("Fulfiller.caller is the worker", fulfillerCaller)
    : bad("Fulfiller.caller is NOT the worker", `${fulfillerCaller} — the worker cannot mint`);

  const mirrorOp = await rh.readContract({ address: cfg.rh.mirrorAddress, abi: ROLES, functionName: "operator" });
  same(mirrorOp, cfg.rh.fulfillerAddress)
    ? ok("MirrorNFT.operator is the Fulfiller", mirrorOp)
    : bad("MirrorNFT.operator is NOT the Fulfiller", `${mirrorOp} — minting will revert`);

  const saleOp = await rh.readContract({ address: cfg.rh.packSaleAddress, abi: ROLES, functionName: "operator" });
  same(saleOp, cfg.rh.fulfillerAddress)
    ? ok("PackSale.operator is the Fulfiller", saleOp)
    : bad("PackSale.operator is NOT the Fulfiller", `${saleOp} — escrow will never release`);
} catch (err) {
  bad("role checks failed", err instanceof Error ? err.message : String(err));
}

/* ---------------------------------------------------------------- caps */

console.log("\nCaps");
try {
  const cap = await rh.readContract({ address: cfg.rh.packSaleAddress, abi: PACK_SALE_ABI, functionName: "dailyPackCap" });
  const maxOpen = await rh.readContract({ address: cfg.rh.packSaleAddress, abi: PACK_SALE_ABI, functionName: "maxOpenOrders" });
  ok("daily pack cap", `${cap} per day`);
  ok("max open orders", `${maxOpen} at once`);
} catch (err) {
  warn("cap read failed", err instanceof Error ? err.message : String(err));
}

/* ---------------------------------------------------------------- gas headroom */

console.log("\nGas headroom for this open");
try {
  const wei = await rh.getBalance({ address: operator });
  const eth = Number(wei) / 1e18;
  const ethUsd = nativeFeeUsd > 0 ? nativeFeeUsd : 1.9;
  // The native bridge fee dwarfs the transaction gas on this chain, so it is the number
  // that decides how many opens the wallet can still fund.
  const opens = ethUsd > 0 ? Math.floor((eth * 1875) / ethUsd) : 0;
  if (opens >= 2) ok("worker ETH", `${eth.toFixed(5)} ETH — roughly ${opens} more opens at the current fixed fee`);
  else bad("worker ETH", `${eth.toFixed(5)} ETH — under two opens of headroom`);
} catch (err) {
  warn("gas check failed", err instanceof Error ? err.message : String(err));
}

/* ---------------------------------------------------------------- the way back */

/**
 * The return leg, priced the same way as the outbound one.
 *
 * This section used to print `back.costUsd` and call it "cost". That is the STABLECOIN delta
 * alone — the same half-measure the outbound section warns about above, and the one that made
 * the $50 tier look viable when it was not. On a transfer this small the native SOL fee is the
 * larger half, so the old line under-reported the true cost of every sell-back.
 *
 * The native fee matters differently here than outbound: it is paid in SOL from the custody
 * wallet, so it does not reduce what arrives on RH, but it is still real money spent per sale.
 */
console.log("\nBridge, Solana -> RH (the leg every sell-back pays)");
try {
  const SAMPLE = 40_000_000n;
  const back = await bridge.quote("solana", "rh", SAMPLE.toString());

  const url = new URL(`${cfg.bridge.apiUrl}/dln/order/create-tx`);
  url.searchParams.set("srcChainId", String(cfg.bridge.solanaChainId));
  url.searchParams.set("srcChainTokenIn", cfg.solana.usdcMint);
  url.searchParams.set("srcChainTokenInAmount", SAMPLE.toString());
  url.searchParams.set("dstChainId", String(cfg.bridge.rhChainId));
  url.searchParams.set("dstChainTokenOut", cfg.rh.usdgAddress);
  url.searchParams.set("dstChainTokenOutRecipient", operator);
  url.searchParams.set("srcChainOrderAuthorityAddress", cfg.solana.operatorAddress);
  url.searchParams.set("dstChainOrderAuthorityAddress", operator);
  url.searchParams.set("prependOperatingExpenses", "false");
  const tx = await (await fetch(url)).json();

  const stableCost = Number(SAMPLE - BigInt(back.amountOut)) / 1e6;
  console.log(`          send $40.00  ->  arrives ${usd(back.amountOut)} on RH`);
  console.log(`          stablecoin cost  $${stableCost.toFixed(2)}   (taken out of the transfer)`);

  if (tx.fixFee) {
    const solFeeUsd = await price.nativeToUsd("SOL", BigInt(tx.fixFee));
    const total = stableCost + solFeeUsd;
    console.log(`          native fixed fee $${solFeeUsd.toFixed(2)} in SOL   (taken out of CUSTODY's SOL)`);
    console.log(`          true total cost  $${total.toFixed(2)} per sell-back`);

    /**
     * Break-even, stated in insured value rather than payout, because the spread is charged
     * against insured value. Below this a sell-back costs us more than it earns.
     */
    const breakEven = total / (cfg.economics.spreadBps / 10_000);
    console.log(`          break-even       $${breakEven.toFixed(2)} insured at a ${cfg.economics.spreadBps / 100}% spread`);
    if (total > cfg.bridge.costAbortUsd) {
      bad("return leg native fee exceeds BRIDGE_COST_ABORT_USD",
        `$${total.toFixed(2)} > $${cfg.bridge.costAbortUsd} — a sell-back would abort AFTER the card is sold`);
    } else {
      ok("return leg quotes", `route live, true cost $${total.toFixed(2)}`);
    }
  } else {
    warn("could not read the return leg's native fixed fee",
      "the true cost is HIGHER than the stablecoin delta shown — do not quote this figure as the cost");
  }
} catch (err) {
  warn("return leg quote failed", err instanceof Error ? err.message : String(err));
}

/* ---------------------------------------------------------------- verdict */

console.log("");
if (failures) console.log(`${failures} blocker(s), ${warnings} warning(s) — do NOT open a pack yet\n`);
else if (warnings) console.log(`no blockers, ${warnings} warning(s) — read them before opening\n`);
else console.log("no blockers — a real open should succeed\n");
process.exit(failures ? 1 : 0);
