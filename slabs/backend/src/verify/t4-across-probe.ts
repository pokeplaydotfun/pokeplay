/**
 * DOC 01 — T4: Across bridge loop, both directions.
 *
 * The measured numbers here set ORDER_TIMEOUT_MIN and the max pack price. Doc 00 quotes a
 * "median fill <5s" from Across' own marketing; that is not a number to build a 10-minute
 * refund deadline on. Measure it on the actual USDG(4663) <-> USDC(Solana) route.
 *
 * This script only QUOTES — it does not move money. Quoting is free and reveals fees, limits
 * and route health. The actual timed transfers are manual (doc 01 T4 steps 1-3): send them
 * from the Across app, then record fill times with `record`.
 *
 * Usage:
 *   node src/verify/t4-across-probe.ts quote 50      # quote $50 both directions
 *   node src/verify/t4-across-probe.ts limits        # max fill size on this route
 *   node src/verify/t4-across-probe.ts record <direction> <seconds> <feeBps>
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import "dotenv/config";

const OUT = resolve(import.meta.dirname, "../../../docs/verification/t4-across.json");
const ACROSS_API = process.env.ACROSS_API_URL ?? "https://app.across.to/api";

const RH_CHAIN_ID = 4663;
// Across uses a synthetic chain id for Solana in its EVM-shaped API surface.
const SOLANA_CHAIN_ID = 34268394551451;

type Measurement = { direction: string; seconds: number; feeBps: number; at: string };

/** Across' suggested-fees response, narrowed to the fields we actually read. */
type SuggestedFees = {
  totalRelayFee?: { total?: string };
  estimatedFillTimeSec?: number;
  limits?: { minDeposit?: string; maxDeposit?: string };
};

function load(): { measurements: Measurement[]; quotes: unknown[] } {
  if (!existsSync(OUT)) return { measurements: [], quotes: [] };
  return JSON.parse(readFileSync(OUT, "utf8"));
}

function save(data: unknown) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(data, null, 2));
}

async function quote(amountUsd: number) {
  const usdgAddress = process.env.USDG_ADDRESS;
  const usdcSolana = process.env.USDC_SOLANA_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  if (!usdgAddress) {
    throw new Error("USDG_ADDRESS is not set — get it from the RH Chain docs first (T5).");
  }

  // 6 decimals assumed for both legs; T5 confirms USDG's actual decimals.
  const amount = BigInt(Math.round(amountUsd * 1e6)).toString();

  const directions = [
    { label: "USDG(RH) -> USDC(Solana)", originChainId: RH_CHAIN_ID, destinationChainId: SOLANA_CHAIN_ID, inputToken: usdgAddress, outputToken: usdcSolana },
    { label: "USDC(Solana) -> USDG(RH)", originChainId: SOLANA_CHAIN_ID, destinationChainId: RH_CHAIN_ID, inputToken: usdcSolana, outputToken: usdgAddress },
  ];

  const results = [];
  for (const d of directions) {
    const url = new URL(`${ACROSS_API}/suggested-fees`);
    url.searchParams.set("inputToken", d.inputToken);
    url.searchParams.set("outputToken", d.outputToken);
    url.searchParams.set("originChainId", String(d.originChainId));
    url.searchParams.set("destinationChainId", String(d.destinationChainId));
    url.searchParams.set("amount", amount);

    console.log(`\n--- ${d.label} ($${amountUsd}) ---`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const body = (await res.json()) as SuggestedFees;

      if (!res.ok) {
        console.log(`  HTTP ${res.status}: ${JSON.stringify(body)}`);
        console.log(`  => route may not be live. If this direction never quotes, the zero-float`);
        console.log(`     JIT design does not work and doc 00 §4 needs revisiting BEFORE launch.`);
        results.push({ ...d, ok: false, error: body });
        continue;
      }

      const totalRelayFee = BigInt(body.totalRelayFee?.total ?? "0");
      const feeBps = Number((totalRelayFee * 10_000n) / BigInt(amount));
      const feeUsd = Number(totalRelayFee) / 1e6;

      console.log(`  total relay fee : $${feeUsd.toFixed(4)} (${feeBps} bps)`);
      console.log(`  est. fill time  : ${body.estimatedFillTimeSec ?? "?"}s`);
      console.log(`  limits          : min $${Number(body.limits?.minDeposit ?? 0) / 1e6}, max $${Number(body.limits?.maxDeposit ?? 0) / 1e6}`);

      // Sanity against doc 00 §3: variable cost per full cycle should be $0.10-0.35 across
      // BOTH legs. One leg alone eating that budget breaks the economics.
      if (feeUsd > 0.35) {
        console.log(`  ! fee exceeds the whole per-cycle cost budget from doc 00 §3 ($0.10-0.35`);
        console.log(`    for both legs plus gas). At ~$2.60 revenue per sold-back card this is`);
        console.log(`    survivable, but recompute break-even sell-through before launch.`);
      }

      results.push({ ...d, ok: true, feeBps, feeUsd, estimatedFillTimeSec: body.estimatedFillTimeSec, limits: body.limits });
    } catch (err) {
      console.log(`  request failed: ${err instanceof Error ? err.message : err}`);
      results.push({ ...d, ok: false, error: String(err) });
    }
  }

  const data = load();
  data.quotes.push({ at: new Date().toISOString(), amountUsd, results });
  save(data);
  console.log(`\nWritten to ${OUT}`);
  return results;
}

async function limits() {
  console.log("Probing max reliable size by quoting increasing amounts...\n");
  for (const amount of [50, 100, 250, 500, 1000]) {
    const results = await quote(amount);
    if (results.some((r) => !r.ok)) {
      console.log(`\n=> route stops quoting at $${amount}. Set MAX_PACK_PRICE below this with margin.`);
      return;
    }
  }
}

function record(direction: string, seconds: number, feeBps: number) {
  const data = load();
  data.measurements.push({ direction, seconds, feeBps, at: new Date().toISOString() });
  save(data);

  const same = data.measurements.filter((m) => m.direction === direction).map((m) => m.seconds).sort((a, b) => a - b);
  const p50 = same[Math.floor(same.length * 0.5)] ?? seconds;
  const p95 = same[Math.floor(same.length * 0.95)] ?? same[same.length - 1] ?? seconds;

  console.log(`recorded: ${direction} filled in ${seconds}s at ${feeBps}bps`);
  console.log(`${direction}: n=${same.length}  p50=${p50}s  p95=${p95}s`);

  if (same.length < 3) {
    console.log(`\nDoc 01 T4 wants at least 3 samples per direction, at different hours.`);
  } else {
    // ORDER_TIMEOUT must cover: bridge out + CC open + reveal + bridge-independent mint.
    // Doubling p95 for the bridge leg alone is the conservative starting point.
    const suggested = Math.ceil(((p95 * 2) / 60) * 2);
    console.log(`\nSuggested ORDER_TIMEOUT_MIN >= ${Math.max(suggested, 5)} min (2x p95 for the`);
    console.log(`bridge leg, doubled again for the CC open + reveal legs). Default is 10.`);
  }
}

const [command, ...args] = process.argv.slice(2);

try {
  if (command === "quote") {
    await quote(Number(args[0] ?? 50));
  } else if (command === "limits") {
    await limits();
  } else if (command === "record") {
    const [direction, seconds, feeBps] = args;
    if (!direction || !seconds || !feeBps) throw new Error("Usage: record <direction> <seconds> <feeBps>");
    record(direction, Number(seconds), Number(feeBps));
  } else {
    console.error("Usage: node src/verify/t4-across-probe.ts quote <usd> | limits | record <direction> <seconds> <feeBps>");
    process.exit(1);
  }
} catch (err) {
  console.error("\nT4 failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}
