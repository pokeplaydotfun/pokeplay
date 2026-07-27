/**
 * DOC 01 — T5: Robinhood Chain basics. This is what blocks the mainnet contract deploy.
 *
 * PackSale and MirrorNFT take the USDG address as an IMMUTABLE constructor argument. Deploy
 * against the wrong address and the contracts are permanently bricked while holding real
 * money. So this script does not guess: you supply the address from the official docs
 * (docs.robinhood.com/chain) and it verifies the token actually behaves like USDG.
 *
 * Usage:
 *   USDG_ADDRESS=0x... RH_RPC_URL=... node src/verify/t5-rh-chain.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createPublicClient, http, getContract, formatUnits, isAddress } from "viem";
import type { Chain } from "viem";
import "dotenv/config";

const OUT = resolve(import.meta.dirname, "../../../docs/verification/t5-rh-chain.json");

export const robinhoodChain = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.RH_RPC_URL ?? ""] } },
} as const satisfies Chain;

const ERC20_ABI = [
  { type: "function", name: "name", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "totalSupply", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "paused", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" },
] as const;

async function main() {
  const rpcUrl = process.env.RH_RPC_URL;
  const usdgAddress = process.env.USDG_ADDRESS;

  if (!rpcUrl) throw new Error("RH_RPC_URL is not set (Alchemy endpoint for chain 4663).");
  if (!usdgAddress) {
    throw new Error(
      "USDG_ADDRESS is not set.\n\n" +
        "Look it up in the official Robinhood Chain docs (docs.robinhood.com/chain).\n" +
        "Do NOT take it from a block explorer search, a forum post, or from me — a wrong\n" +
        "address here permanently bricks the deployed contracts, because PackSale stores it\n" +
        "as an immutable.",
    );
  }
  if (!isAddress(usdgAddress)) throw new Error(`USDG_ADDRESS is not a valid address: ${usdgAddress}`);

  const client = createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl) });

  console.log("=== T5: ROBINHOOD CHAIN ===\n");

  const chainId = await client.getChainId();
  console.log(`chain id       : ${chainId}`);
  if (chainId !== 4663) {
    throw new Error(`Expected chain 4663, got ${chainId}. Wrong RPC endpoint — stop here.`);
  }

  const block = await client.getBlock();
  console.log(`latest block   : ${block.number}  (${new Date(Number(block.timestamp) * 1000).toISOString()})`);

  const gasPrice = await client.getGasPrice();
  console.log(`gas price      : ${formatUnits(gasPrice, 9)} gwei`);

  // Block cadence — doc 00 claims ~100ms. Worth confirming, since ORDER_TIMEOUT and the
  // reveal-time UX budget assume fast finality.
  const prev = await client.getBlock({ blockNumber: block.number - 100n });
  const spanSeconds = Number(block.timestamp - prev.timestamp);
  console.log(`block time     : ~${((spanSeconds / 100) * 1000).toFixed(0)}ms over last 100 blocks`);

  console.log(`\n--- USDG at ${usdgAddress} ---`);
  const token = getContract({ address: usdgAddress, abi: ERC20_ABI, client });

  const bytecode = await client.getCode({ address: usdgAddress });
  if (!bytecode || bytecode === "0x") {
    throw new Error(
      `No contract deployed at ${usdgAddress} on chain 4663. This address is wrong — do not deploy against it.`,
    );
  }

  const [name, symbol, decimals, totalSupply] = await Promise.all([
    token.read.name(),
    token.read.symbol(),
    token.read.decimals(),
    token.read.totalSupply(),
  ]);

  console.log(`name           : ${name}`);
  console.log(`symbol         : ${symbol}`);
  console.log(`decimals       : ${decimals}`);
  console.log(`total supply   : ${formatUnits(totalSupply, decimals)}`);

  const warnings: string[] = [];

  if (!/usdg/i.test(symbol) && !/usdg/i.test(name)) {
    warnings.push(`Token identifies as "${name}" (${symbol}), which does not look like USDG. VERIFY THE ADDRESS.`);
  }
  if (decimals !== 6) {
    warnings.push(
      `decimals=${decimals}, but the contracts, tests and MAX_PACK_PRICE_USDG all assume 6. ` +
        `Update MAX_PACK_PRICE_USDG and re-check every amount in config before deploying.`,
    );
  }

  // Pausable USDG is worth knowing about: if Paxos pauses transfers, refunds stop working
  // and orders strand until it resumes. That is a runbook entry, not a blocker.
  try {
    const paused = await client.readContract({ address: usdgAddress, abi: ERC20_ABI, functionName: "paused" });
    console.log(`pausable       : yes (currently ${paused ? "PAUSED" : "active"})`);
    warnings.push(
      "USDG is pausable. If Paxos pauses transfers, refunds and payouts halt mid-flight. " +
        "Add to the risk register (doc 06 §7) and the bridge-outage runbook.",
    );
  } catch {
    console.log(`pausable       : no paused() function found`);
  }

  console.log(`\n--- WebSocket event latency ---`);
  const wsUrl = process.env.RH_WS_URL;
  if (!wsUrl) {
    console.log(`RH_WS_URL not set — skipped. Doc 01 T5.3 wants this measured: the fulfilment`);
    console.log(`worker subscribes to OrderCreated, and subscription lag is dead time inside`);
    console.log(`the 8-20s reveal budget.`);
  } else {
    console.log(`configured: ${wsUrl} (measure under load during the mainnet dry-run)`);
  }

  if (warnings.length > 0) {
    console.log(`\n=== WARNINGS ===`);
    for (const w of warnings) console.log(`  ! ${w}`);
  }

  const result = {
    checkedAt: new Date().toISOString(),
    chainId,
    gasPriceWei: gasPrice.toString(),
    approxBlockMs: (spanSeconds / 100) * 1000,
    usdg: { address: usdgAddress, name, symbol, decimals, totalSupply: totalSupply.toString() },
    warnings,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`\nWritten to ${OUT}`);

  console.log(`\n=== DEPLOY READINESS ===`);
  const blocking = warnings.filter((w) => w.includes("VERIFY THE ADDRESS") || w.includes("decimals="));
  if (blocking.length === 0) {
    console.log(`  USDG address verified as a live token on chain 4663 with the expected shape.`);
    console.log(`  Contracts can be deployed against it.`);
    console.log(`  Still required before enabling a machine: T1/T2/T3 (the backend cannot`);
    console.log(`  open or sell a pack until CC's interface is known).`);
  } else {
    console.log(`  NOT READY — resolve the warnings above first.`);
    process.exitCode = 1;
  }
  console.log();
}

main().catch((err) => {
  console.error("\nT5 failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
