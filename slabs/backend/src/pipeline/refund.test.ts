import { test, describe } from "node:test";
import { asSolanaAddress } from "../chains/address.ts";
import assert from "node:assert/strict";
import { Db } from "../db/index.ts";
import { MockCollectorCrypt } from "../cc/mock.ts";
import { MockBridge } from "../bridge/mock.ts";
import { JitSource } from "../bridge/jit-source.ts";
import { FulfillmentPipeline } from "./fulfill.ts";
import type { MirrorMinter, SolanaSigner } from "./fulfill.ts";
import type { Config } from "../config.ts";

/**
 * The refund sweep, and the on-chain deadline guard.
 *
 * Both exist because `PackSale.refund` is PERMISSIONLESS (PackSale.sol:169). Anyone can
 * reclaim a timed-out order, including the buyer, including while this pipeline is mid-flight
 * — and the on-chain timeout is 10 minutes, which one failed bridge attempt plus the 5-minute
 * retry cooldown already exceeds.
 *
 * Until 19 Jul 2026 nothing performed a refund at all: `refundableOrders()` had zero callers
 * while four places in the UI promised automatic refunds.
 */

function testConfig(): Config {
  return {
    bridge: { costAlertUsd: 2, costAbortUsd: 5, rhChainId: 4663, solanaChainId: 7565164, apiUrl: "", provider: "mock", fillTimeoutMs: 1000 },
    economics: { spreadBps: 500, userWindowHours: 66, ccWindowHours: 72, unwrapFeeDuringWindowBps: 500, quoteTtlSec: 60, quoteDriftRevalidateBps: 25 },
    limits: { maxPackPriceUsdg: 55, orderTimeoutMin: 10 },
    rh: { usdgAddress: "0xusdg" },
    solana: { usdcMint: "usdc" },
  } as unknown as Config;
}

class StubSigner implements SolanaSigner {
  readonly address = asSolanaAddress("CARD7cmGjygGCSkrbXdxBN8Zr9Zd1fN1mjZdvSLqHuaN");
  signed: string[] = [];
  signBase64(tx: string): string {
    this.signed.push(tx);
    return `signed:${tx}`;
  }
}

class StubMinter implements MirrorMinter {
  calls: unknown[] = [];
  async fulfill() {
    this.calls.push(1);
    return { tokenId: String(this.calls.length), txHash: `0xmint${this.calls.length}` };
  }
}

type ChainView = { status: string; deadline: number } | null;

/**
 * A viem-shaped custom-error object.
 *
 * The old tests threw `new Error("execution reverted: AlreadyDrawn(1)")` — a string viem
 * NEVER produces. That invented message made every drawn-order branch look tested while the
 * real code path was dead, because the ABI declared no errors and viem could not name them.
 * Same mock-richer-than-reality class this repo has hit before, on the money path.
 *
 * These carry `data.errorName`, which is what viem actually populates and what the code now
 * reads.
 */
function revertWith(errorName: string): Error {
  const e = new Error(`The contract function reverted.`) as Error & { data?: { errorName: string } };
  e.data = { errorName };
  return e;
}

function harness(opts: {
  chain?: (orderId: number) => Promise<ChainView>;
  refund?: (orderId: number) => Promise<string>;
  usdc?: bigint;
  arriving?: bigint;
  draw?: (orderId: number) => Promise<string>;
  directRefund?: (buyer: string, amount: string, onSent?: (h: string) => void) => Promise<string>;
  txSucceeded?: (txHash: string) => Promise<boolean>;
} = {}) {
  const db = new Db(":memory:");
  const cc = new MockCollectorCrypt("seed");
  const bridge = new MockBridge();
  const minter = new StubMinter();
  const signer = new StubSigner();
  const alerts: string[] = [];
  const cfg = testConfig();
  const refundCalls: number[] = [];

  const pipeline = new FulfillmentPipeline({
    db,
    cc,
    liquidity: new JitSource(bridge, db, cfg, () => {}),
    signer,
    minter,
    cfg,
    alert: (m) => alerts.push(m),
    revealPolling: { attempts: 10, intervalMs: 1 },
    retryCooldownMs: 0,
    onChainOrder: opts.chain,
    solanaUsdcBalance: opts.usdc === undefined ? undefined : async () => opts.usdc!,
    refundDrawnOrder: opts.directRefund,
    txSucceeded: opts.txSucceeded,
    revertErrorName: (err) => (err as { data?: { errorName?: string } })?.data?.errorName ?? null,
    drawForOpen: opts.draw,
    expectedBridgeArrival: opts.arriving === undefined ? undefined : async () => opts.arriving!,
    refundOrder: opts.refund
      ? async (id) => {
          refundCalls.push(id);
          return opts.refund!(id);
        }
      : undefined,
  });

  return { db, cc, bridge, minter, signer, pipeline, alerts, refundCalls };
}

/** An order that has already timed out, with no pack ever bought. */
function seedTimedOut(db: Db, id = 1) {
  db.insertOrder({
    id,
    buyer: "0xbuyer",
    machineId: "pokemon_50",
    priceUsdg: "50000000",
    rhPayTx: "0xpay",
    deadlineAt: Date.now() - 60_000,
  });
}

function seedLive(db: Db, id = 1) {
  db.insertOrder({
    id,
    buyer: "0xbuyer",
    machineId: "pokemon_50",
    priceUsdg: "50000000",
    rhPayTx: "0xpay",
    deadlineAt: Date.now() + 600_000,
  });
}

describe("the refund sweep", () => {
  test("refunds a timed-out order that never bought a pack", async () => {
    const h = harness({ refund: async () => "0xrefund" });
    seedTimedOut(h.db);

    await h.pipeline.refundTimedOut();

    assert.deepEqual(h.refundCalls, [1]);
    assert.equal(h.db.getOrder(1)!.status, "REFUNDED");
  });

  test("never refunds an order that bought a pack", async () => {
    const h = harness({ refund: async () => "0xrefund" });
    seedTimedOut(h.db);
    h.db.setOrderStatus(1, "BRIDGING");
    h.db.setOrderStatus(1, "OPENING", { cc_open_tx: "cc-memo-123" });

    await h.pipeline.refundTimedOut();

    // We hold a real card against this order. Refunding would give the money back AND keep
    // the card. That is the human forceRefund runbook, never automation.
    assert.deepEqual(h.refundCalls, [], "an opened pack must never be auto-refunded");
    assert.equal(h.db.getOrder(1)!.status, "OPENING");
  });

  test("refunds a FAILED order that never bought a pack", async () => {
    // The case that matters most, and the one an earlier version of refundableOrders missed:
    // FAILED is where an order lands after a bridge outage, a sold-out machine, or
    // insufficient Solana USDC. Listing only CREATED and BRIDGING meant the single most
    // common failure path was never auto-refunded at all.
    const h = harness({ refund: async () => "0xrefund" });
    seedTimedOut(h.db);
    h.db.setOrderStatus(1, "FAILED", { last_error: "bridge outage" });

    await h.pipeline.refundTimedOut();

    assert.deepEqual(h.refundCalls, [1]);
    assert.equal(h.db.getOrder(1)!.status, "REFUNDED");
  });

  test("a FAILED order that DID buy a pack is still never refunded", async () => {
    // cc_open_tx is the load-bearing condition, not the status. Widening the status list must
    // not widen this: we would be handing back the money while holding the card.
    const h = harness({ refund: async () => "0xrefund" });
    seedTimedOut(h.db);
    h.db.setOrderStatus(1, "BRIDGING");
    h.db.setOrderStatus(1, "OPENING", { cc_open_tx: "cc-memo-123" });
    h.db.setOrderStatus(1, "FAILED", { last_error: "mint reverted" });

    await h.pipeline.refundTimedOut();

    assert.deepEqual(h.refundCalls, [], "an opened pack is forceRefund territory, never automatic");
  });

  /**
   * A DRAWN order cannot be refunded by the contract — we already took the money out to fund
   * the pack. Without a direct payment the buyer would get nothing from either side.
   */
  test("a drawn order is refunded directly by us instead", async () => {
    const paid: { buyer: string; amount: string }[] = [];
    const h = harness({
      refund: async () => { throw revertWith("AlreadyDrawn"); },
      directRefund: async (buyer, amount) => { paid.push({ buyer, amount }); return "0xdirect"; },
    });
    seedTimedOut(h.db);

    await h.pipeline.refundTimedOut();

    assert.deepEqual(paid, [{ buyer: "0xbuyer", amount: "50000000" }], "the buyer is paid back");
    assert.equal(h.db.getOrder(1)!.status, "REFUNDED");
  });

  test("a drawn order with no direct refund wired shouts rather than silently dropping it", async () => {
    const h = harness({
      refund: async () => { throw revertWith("AlreadyDrawn"); },
    });
    seedTimedOut(h.db);

    await h.pipeline.refundTimedOut();

    assert.notEqual(h.db.getOrder(1)!.status, "REFUNDED", "must not claim a refund that never happened");
    assert.ok(
      h.alerts.some((a) => /MUST be paid by hand/i.test(a)),
      "a buyer owed money must never be lost quietly",
    );
  });

  /**
   * THE TREASURY DRAIN. `payUsdg` broadcasts, then waits up to 120s for a receipt. A timeout
   * throws AFTER the money has left. Without an intent claim the order stayed refundable, and
   * this sweep runs EVERY 4 SECONDS — so the buyer was paid again, and again, until the
   * worker's USDG was gone. That wallet is also the treasury.
   */
  test("a receipt timeout on a landed direct refund never pays twice", async () => {
    const paid: string[] = [];
    const landed = new Set<string>();
    const h = harness({
      refund: async () => { throw revertWith("AlreadyDrawn"); },
      directRefund: async (_buyer, _amount, onSent) => {
        const hash = `0xdirect${paid.length + 1}`;
        paid.push(hash);
        onSent?.(hash);
        landed.add(hash);
        throw new Error("waitForTransactionReceipt timed out");
      },
      txSucceeded: async (h2) => landed.has(h2),
    });
    seedTimedOut(h.db);

    await h.pipeline.refundTimedOut();
    assert.equal(paid.length, 1, "the money has left exactly once");

    // Three more sweeps, as the worker would run within 12 seconds.
    await h.pipeline.refundTimedOut();
    await h.pipeline.refundTimedOut();
    await h.pipeline.refundTimedOut();

    assert.equal(paid.length, 1, "MUST NOT pay the buyer again");
    assert.equal(h.db.getOrder(1)!.status, "REFUNDED", "reconciled to the landed transfer");
  });

  test("a refund refused before broadcast still retries cleanly", async () => {
    let attempts = 0;
    const h = harness({
      refund: async () => { throw revertWith("AlreadyDrawn"); },
      directRefund: async (_b, _a, onSent) => {
        attempts += 1;
        if (attempts === 1) throw new Error("insufficient funds"); // never broadcast
        onSent?.("0xok");
        return "0xok";
      },
      txSucceeded: async () => false,
    });
    seedTimedOut(h.db);

    await h.pipeline.refundTimedOut();
    assert.notEqual(h.db.getOrder(1)!.status, "REFUNDED");

    await h.pipeline.refundTimedOut();
    assert.equal(h.db.getOrder(1)!.status, "REFUNDED", "a refused send must stay a plain retry");
  });

  test("a failed direct refund does not mark the order refunded", async () => {
    const h = harness({
      refund: async () => { throw revertWith("AlreadyDrawn"); },
      directRefund: async () => { throw new Error("RPC down"); },
    });
    seedTimedOut(h.db);

    await h.pipeline.refundTimedOut();

    assert.notEqual(h.db.getOrder(1)!.status, "REFUNDED");
    assert.ok(h.alerts.some((a) => /is owed/i.test(a)));
  });

  test("leaves an order that has not timed out alone", async () => {
    const h = harness({ refund: async () => "0xrefund" });
    seedLive(h.db);

    await h.pipeline.refundTimedOut();

    assert.deepEqual(h.refundCalls, []);
    assert.equal(h.db.getOrder(1)!.status, "CREATED");
  });

  test("reconciles an order somebody else already refunded", async () => {
    // `refund` is permissionless precisely so a buyer never depends on us. Someone beating us
    // to it is the system working, not an error to retry forever.
    const h = harness({
      refund: async () => {
        throw revertWith("OrderNotPending");
      },
    });
    seedTimedOut(h.db);

    await h.pipeline.refundTimedOut();

    assert.equal(h.db.getOrder(1)!.status, "REFUNDED");
    assert.ok(
      h.alerts.some((a) => /already refunded/i.test(a)),
      "should say it reconciled rather than failed",
    );
  });

  test("a genuine refund failure leaves the order for the next sweep", async () => {
    const h = harness({
      refund: async () => {
        throw new Error("RPC timeout");
      },
    });
    seedTimedOut(h.db);

    await h.pipeline.refundTimedOut();

    assert.notEqual(h.db.getOrder(1)!.status, "REFUNDED", "an RPC blip must not fake a refund");
    assert.equal(h.db.getOrder(1)!.status, "CREATED", "still refundable next time round");
  });

  test("does nothing at all when no refunder is wired (demo has no chain)", async () => {
    const h = harness();
    seedTimedOut(h.db);

    await h.pipeline.refundTimedOut();

    assert.equal(h.db.getOrder(1)!.status, "CREATED");
  });
});

describe("the Solana funds gate", () => {
  /**
   * The bridge takes its fee out of the transfer, so a machine priced at exactly the pack
   * price always arrives short. Measured on 19 Jul 2026 against the live deBridge API:
   * pokemon_250 bridges $250.00 and $249.07 arrives against a $250.00 pack.
   */
  const PACK_PRICE = 50_000_000n; // MockCollectorCrypt's pokemon_50

  test("refuses to buy when the arrived USDC does not cover the pack", async () => {
    const h = harness({ usdc: PACK_PRICE - 930_000n }); // the real pokemon_250 shortfall
    seedLive(h.db);

    await h.pipeline.processOrder(1);

    assert.equal(h.signer.signed.length, 0, "must not co-sign a purchase it cannot fund");
    assert.equal(h.db.getOrder(1)!.cc_open_tx, null, "no memo may exist for an unpaid pack");
  });

  test("the order stays REFUNDABLE rather than poisoned into OPENING", async () => {
    // This is the whole reason the gate sits before generatePack. A memo recorded against a
    // pack that was never paid for promotes the order to OPENING, and there is no
    // OPENING -> REFUNDED edge — the buyer's money would be stuck in escrow forever.
    const h = harness({ usdc: 0n });
    seedTimedOut(h.db); // already past its deadline, so the sweep should claim it

    await h.pipeline.processOrder(1);

    const order = h.db.getOrder(1)!;
    assert.notEqual(order.status, "OPENING", "must never reach the must-complete state unpaid");
    assert.equal(order.cc_open_tx, null);

    // And prove it: the refund sweep picks it up.
    const refundable = h.db.refundableOrders().map((o) => o.id);
    assert.deepEqual(refundable, [1], "a funds failure must leave the order refundable");
  });

  test("buys normally when the balance covers the pack", async () => {
    const h = harness({ usdc: PACK_PRICE * 2n });
    seedLive(h.db);

    await h.pipeline.processOrder(1);

    assert.equal(h.db.getOrder(1)!.status, "MINTED", "the gate must not block a funded open");
    assert.equal(h.signer.signed.length, 1);
  });

  test("exactly enough is enough", async () => {
    const h = harness({ usdc: PACK_PRICE });
    seedLive(h.db);

    await h.pipeline.processOrder(1);

    assert.equal(h.db.getOrder(1)!.status, "MINTED", "an exact balance must not be off-by-one");
  });

  test("no balance reader wired means no gate (demo, tests)", async () => {
    const h = harness();
    seedLive(h.db);

    await h.pipeline.processOrder(1);

    assert.equal(h.db.getOrder(1)!.status, "MINTED");
  });
});

/**
 * The one unrecoverable state in the draw design, and why it can no longer happen.
 *
 * Draw succeeds -> USDG bridges to Solana -> the funds gate fails -> the direct refund cannot
 * pay, because the money is no longer on this chain. The order is stuck drawn, its open-order
 * slot leaks, and five of those close the storefront permanently.
 *
 * The fix is ordering, not recovery: prove the open can complete BEFORE drawing.
 */
describe("the draw never happens for an open that cannot complete", () => {
  const PACK = 50_000_000n; // MockCollectorCrypt pokemon_50

  test("refuses to draw when the bridged funds would not cover the pack", async () => {
    const drawn: number[] = [];
    const h = harness({
      draw: async (id) => { drawn.push(id); return "0xdraw"; },
      usdc: 0n,                    // no float
      arriving: PACK - 930_000n,   // the real pokemon_250 shortfall shape
    });
    seedLive(h.db);

    await h.pipeline.processOrder(1);

    assert.deepEqual(drawn, [], "the buyer's money must stay in escrow");
    assert.equal(h.bridge.executeCount, 0, "and nothing bridges");
    assert.ok(h.alerts.some((a) => /NOT drawing/.test(a)));
  });

  test("the order stays refundable by the CONTRACT, not by us", async () => {
    const h = harness({
      draw: async () => "0xdraw",
      usdc: 0n,
      arriving: PACK - 1n,
      refund: async () => "0xrefund",
    });
    seedTimedOut(h.db);

    await h.pipeline.processOrder(1);
    await h.pipeline.refundTimedOut();

    // Undrawn, so the permissionless on-chain refund pays it. No direct payment needed.
    assert.deepEqual(h.refundCalls, [1]);
    assert.equal(h.db.getOrder(1)!.status, "REFUNDED");
  });

  test("existing float counts toward covering the pack", async () => {
    const drawn: number[] = [];
    const h = harness({
      draw: async (id) => { drawn.push(id); return "0xdraw"; },
      usdc: 5_000_000n,            // $5 already on Solana
      arriving: PACK - 1_000_000n, // arriving $1 short on its own
    });
    seedLive(h.db);

    await h.pipeline.processOrder(1);

    assert.deepEqual(drawn, [1], "float plus arrival covers it, so the draw proceeds");
  });

  test("draws normally when the funds clearly cover it", async () => {
    const drawn: number[] = [];
    const h = harness({
      draw: async (id) => { drawn.push(id); return "0xdraw"; },
      usdc: PACK * 2n,
      arriving: PACK,
    });
    seedLive(h.db);

    await h.pipeline.processOrder(1);

    assert.deepEqual(drawn, [1]);
    assert.equal(h.db.getOrder(1)!.status, "MINTED", "the guard must not block a fundable open");
  });
});

describe("the on-chain deadline guard", () => {
  test("refuses to bridge an order already refunded on chain", async () => {
    const h = harness({ chain: async () => ({ status: "REFUNDED", deadline: 0 }) });
    seedLive(h.db);

    await h.pipeline.processOrder(1);

    assert.equal(h.bridge.executeCount, 0, "must not move money for a refunded order");
    assert.equal(h.signer.signed.length, 0, "must not buy a pack for a refunded order");
    assert.equal(h.db.getOrder(1)!.status, "REFUNDED", "our record reconciles to the chain");
  });

  test("a settled order is not marked FAILED, so it cannot retry forever", async () => {
    // FAILED -> CREATED is a legal transition, so marking a settled order FAILED would
    // re-arm the spend path on every tick. This is the exact loop the guard prevents.
    const h = harness({ chain: async () => ({ status: "REFUNDED", deadline: 0 }) });
    seedLive(h.db);

    await h.pipeline.processOrder(1);
    await h.pipeline.processOrder(1);
    await h.pipeline.processOrder(1);

    assert.equal(h.db.getOrder(1)!.status, "REFUNDED");
    assert.equal(h.bridge.executeCount, 0);
  });

  test("refuses to start a spend once the on-chain deadline has passed", async () => {
    // Still PENDING, but anyone can refund it out from under us at any moment. Buying a pack
    // now is a coin flip on whether we keep the card.
    const past = Math.floor((Date.now() - 30_000) / 1000);
    const h = harness({ chain: async () => ({ status: "PENDING", deadline: past }) });
    seedLive(h.db);

    await h.pipeline.processOrder(1);

    assert.equal(h.bridge.executeCount, 0);
    assert.equal(h.signer.signed.length, 0);
    assert.ok(h.alerts.some((a) => /past its on-chain deadline/i.test(a)));
  });

  test("a healthy PENDING order still completes normally", async () => {
    const future = Math.floor((Date.now() + 600_000) / 1000);
    const h = harness({ chain: async () => ({ status: "PENDING", deadline: future }) });
    seedLive(h.db);

    await h.pipeline.processOrder(1);

    assert.equal(h.db.getOrder(1)!.status, "MINTED", "the guard must not block the happy path");
    assert.equal(h.bridge.executeCount, 1);
  });

  test("an order the chain has never heard of is left to the step's own guards", async () => {
    const h = harness({ chain: async () => null });
    seedLive(h.db);

    await h.pipeline.processOrder(1);

    assert.equal(h.db.getOrder(1)!.status, "MINTED");
  });

  test("the guard is re-checked before buying, not only before bridging", async () => {
    // The bridge fill alone can take 180s, a third of the on-chain timeout. An order can be
    // refunded during it, so checking once at the start is not enough.
    let calls = 0;
    const future = Math.floor((Date.now() + 600_000) / 1000);
    const h = harness({
      chain: async () => {
        calls += 1;
        // Healthy at the bridge step, refunded by the time we would buy.
        return calls === 1 ? { status: "PENDING", deadline: future } : { status: "REFUNDED", deadline: future };
      },
    });
    seedLive(h.db);

    await h.pipeline.processOrder(1);

    assert.ok(calls >= 2, "the chain must be consulted again before the purchase");
    assert.equal(h.signer.signed.length, 0, "no pack bought once the order went away");
    assert.equal(h.db.getOrder(1)!.status, "REFUNDED");
  });
});
