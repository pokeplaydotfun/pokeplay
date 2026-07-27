/**
 * Local demo server. Runs the REAL fulfilment pipeline against mock CC / mock bridge and a
 * stub minter, so the whole rip flow is clickable with no money, no keys and no deployed
 * contracts.
 *
 * Everything the UI talks to is the real API module. Only the outside world is faked.
 *
 *   node src/demo.ts        -> http://localhost:8787
 */
import { Db } from "./db/index.ts";
import { asSolanaAddress } from "./chains/address.ts";
import { MockCollectorCrypt } from "./cc/mock.ts";
import { MockBridge } from "./bridge/mock.ts";
import { JitSource } from "./bridge/jit-source.ts";
import { FulfillmentPipeline } from "./pipeline/fulfill.ts";
import type { MirrorMinter, SolanaSigner } from "./pipeline/fulfill.ts";
import { createApi } from "./api/server.ts";
import type { Config } from "./config.ts";

const PORT = Number(process.env.API_PORT ?? 8787);
/** Pacing so the staged copy is legible. Real reveals are ~8-20s (doc 00 §4). */
const STAGE_MS = Number(process.env.DEMO_STAGE_MS ?? 900);

const cfg = {
  bridge: {
    provider: "mock",
    apiUrl: "",
    rhChainId: 4663,
    solanaChainId: 7565164,
    costAlertUsd: 2,
    costAbortUsd: 5,
    fillTimeoutMs: 180_000,
  },
  economics: {
    spreadBps: 500,
    userWindowHours: 66,
    ccWindowHours: 72,
    unwrapFeeDuringWindowBps: 500, // T3: bypass is open
    quoteTtlSec: 60,
    quoteDriftRevalidateBps: 25,
  },
  limits: { maxPackPriceUsdg: 55, orderTimeoutMin: 10 },
  rh: { usdgAddress: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" },
  solana: { usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
} as unknown as Config;

const db = new Db(":memory:");
const cc = new MockCollectorCrypt("demo");
const bridge = new MockBridge();

const signer: SolanaSigner = {
  address: asSolanaAddress("DemoCustodyWa11et1111111111111111111111111"),
  signBase64: (tx) => `signed:${tx}`,
};

let nextTokenId = 1;
const minter: MirrorMinter = {
  async fulfill() {
    const tokenId = String(nextTokenId++);
    return { tokenId, txHash: `0xdemo${tokenId.padStart(4, "0")}` };
  },
};

const pipeline = new FulfillmentPipeline({
  db,
  cc,
  liquidity: new JitSource(bridge, db, cfg, () => {}),
  signer,
  minter,
  cfg,
  alert: (m) => console.warn("[alert]", m),
  // Stretch the reveal so the staged UI copy is visible rather than flashing past.
  revealPolling: { attempts: 30, intervalMs: STAGE_MS },
});

// Make the mock reveal asynchronously, as the live API does.
cc.failures.revealDelayPolls = 2;

const server = createApi({ db, cc, pipeline, cfg, demo: true, demoStageDelayMs: STAGE_MS });

server.listen(PORT, () => {
  console.log(`\n  Demo API   http://localhost:${PORT}`);
  console.log(`  Frontend   cd frontend && npm run dev\n`);
  console.log(`  Mocked: Collector Crypt, deBridge, and the RH-Chain minter.`);
  console.log(`  Real:   the fulfilment pipeline, the state machine, and every API route.\n`);
});
