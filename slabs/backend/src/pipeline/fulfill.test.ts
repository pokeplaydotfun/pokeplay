import { test, describe, beforeEach } from "node:test";
import { asSolanaAddress } from "../chains/address.ts";
import assert from "node:assert/strict";
import { Db } from "../db/index.ts";
import { MockCollectorCrypt } from "../cc/mock.ts";
import { MockBridge } from "../bridge/mock.ts";
import { JitSource } from "../bridge/jit-source.ts";
import { FulfillmentPipeline } from "./fulfill.ts";
import type { MirrorMinter, SolanaSigner } from "./fulfill.ts";
import type { Config } from "../config.ts";

function testConfig(): Config {
  return {
    bridge: { costAlertUsd: 2, costAbortUsd: 5, rhChainId: 4663, solanaChainId: 7565164, apiUrl: "", provider: "mock", fillTimeoutMs: 1000 },
    economics: { spreadBps: 500, userWindowHours: 66, ccWindowHours: 72, unwrapFeeDuringWindowBps: 500, quoteTtlSec: 60, quoteDriftRevalidateBps: 25 },
    limits: { maxPackPriceUsdg: 55, orderTimeoutMin: 10 },
    // Present because production always has it (config.ts marks it required), and the
    // intent keys are scoped by it — a test config missing it exercises a shape that
    // cannot occur live.
    rh: { usdgAddress: "0xusdg", packSaleAddress: "0xPackSaleTest" },
    solana: { usdcMint: "usdc" },
  } as unknown as Config;
}

class StubSigner implements SolanaSigner {
  // A realistic base58 Solana address, not a 23-character placeholder. The mock now checks
  // this argument the way Collector Crypt does, and a fixture that could not pass a real
  // address check is a fixture that proves nothing about the caller.
  readonly address = asSolanaAddress("CARD7cmGjygGCSkrbXdxBN8Zr9Zd1fN1mjZdvSLqHuaN");
  signed: string[] = [];
  signBase64(tx: string): string {
    this.signed.push(tx);
    return `signed:${tx}`;
  }
}

class StubMinter implements MirrorMinter {
  calls: unknown[] = [];
  failTimes = 0;
  private n = 0;
  async fulfill(params: Parameters<MirrorMinter["fulfill"]>[0]) {
    this.calls.push(params);
    if (this.n++ < this.failTimes) throw new Error("RH RPC rejected the tx");
    return { tokenId: String(this.calls.length), txHash: `0xmint${this.calls.length}` };
  }
}

type Harness = {
  db: Db;
  cc: MockCollectorCrypt;
  bridge: MockBridge;
  minter: StubMinter;
  signer: StubSigner;
  pipeline: FulfillmentPipeline;
  alerts: string[];
};

function harness(): Harness {
  const db = new Db(":memory:");
  const cc = new MockCollectorCrypt("seed");
  const bridge = new MockBridge();
  const minter = new StubMinter();
  const signer = new StubSigner();
  const alerts: string[] = [];
  const cfg = testConfig();

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
  });

  return { db, cc, bridge, minter, signer, pipeline, alerts };
}

function seedOrder(db: Db, id = 1) {
  db.insertOrder({
    id,
    buyer: "0xbuyer",
    machineId: "pokemon_50",
    priceUsdg: "50000000",
    rhPayTx: "0xpay",
    deadlineAt: Date.now() + 600_000,
  });
}

describe("happy path", () => {
  test("CREATED -> MINTED in one pass", async () => {
    const h = harness();
    seedOrder(h.db);

    await h.pipeline.processOrder(1);

    const order = h.db.getOrder(1)!;
    assert.equal(order.status, "MINTED");
    assert.ok(order.cc_open_tx?.startsWith("cc-"), "CC memo stored as the order binding");
    assert.ok(order.solana_mint, "revealed mint recorded");
    assert.equal(order.mirror_token_id, "1");
    assert.equal(h.bridge.executeCount, 1);
    assert.equal(h.signer.signed.length, 1, "we co-sign CC's transaction exactly once");
  });

  test("records the card with both windows", async () => {
    const h = harness();
    seedOrder(h.db);
    await h.pipeline.processOrder(1);

    const card = h.db.raw.prepare(`SELECT * FROM cards`).get() as {
      reveal_at: number;
      cc_window_ends_at: number;
      user_window_ends_at: number;
      state: string;
      insured_value_usd: string;
      owner_mirror_token_id: string;
    };

    assert.equal(card.state, "CUSTODY");
    assert.equal(card.owner_mirror_token_id, "1");
    assert.ok(card.insured_value_usd);
    // 66h user window sits inside CC's 72h — the 6h execution buffer.
    assert.equal(card.cc_window_ends_at - card.reveal_at, 72 * 3600_000);
    assert.equal(card.user_window_ends_at - card.reveal_at, 66 * 3600_000);
    assert.ok(card.user_window_ends_at < card.cc_window_ends_at);
  });

  test("logs pack revenue once escrow is released", async () => {
    const h = harness();
    seedOrder(h.db);
    await h.pipeline.processOrder(1);

    const rows = h.db.raw.prepare(`SELECT kind, amount FROM treasury_events ORDER BY id`).all() as {
      kind: string;
      amount: string;
    }[];
    assert.deepEqual(
      rows.map((r) => r.kind),
      ["BRIDGE_FEE", "PACK_REVENUE"],
    );
    assert.equal(rows[1]!.amount, "50000000");
  });

  test("handles an asynchronous reveal", async () => {
    const h = harness();
    h.cc.failures.revealDelayPolls = 3;
    seedOrder(h.db);

    await h.pipeline.processOrder(1);
    assert.equal(h.db.getOrder(1)!.status, "MINTED");
  });
});

describe("the must-complete invariant", () => {
  /** The whole point: once a pack is bought, nothing may auto-refund the order. */
  test("a mint failure leaves the order FAILED, never REFUNDED", async () => {
    const h = harness();
    h.minter.failTimes = 99;
    seedOrder(h.db);

    await h.pipeline.processOrder(1);

    const order = h.db.getOrder(1)!;
    assert.equal(order.status, "FAILED");
    assert.ok(order.cc_open_tx, "the pack really was purchased");
    assert.throws(() => h.db.setOrderStatus(1, "REFUNDED"), /Refusing to refund/);
  });

  test("a stranded order is visible to the runbook and flagged in the alert", async () => {
    const h = harness();
    h.minter.failTimes = 99;
    seedOrder(h.db);
    await h.pipeline.processOrder(1);

    assert.equal(h.db.strandedOrders(0).length, 1);
    assert.ok(
      h.alerts.some((a) => a.includes("PACK WAS PURCHASED")),
      `expected a must-complete alert, got: ${JSON.stringify(h.alerts)}`,
    );
  });

  test("a pre-purchase failure stays refundable", async () => {
    const h = harness();
    h.cc.failures.machineSoldOut = true;
    seedOrder(h.db);

    await h.pipeline.processOrder(1);

    const order = h.db.getOrder(1)!;
    assert.equal(order.cc_open_tx, null, "no pack was bought");
    h.db.setOrderStatus(1, "REFUNDED"); // must not throw
    assert.equal(h.db.getOrder(1)!.status, "REFUNDED");
  });

  /**
   * A transient mint failure self-heals inside one pass: the step marks FAILED, then the
   * loop re-enters via retryFailed and completes. What matters is that recovery never
   * re-spends — no second bridge, no second pack.
   */
  test("recovers from a transient mint failure without re-spending", async () => {
    const h = harness();
    h.minter.failTimes = 1;
    seedOrder(h.db);

    await h.pipeline.processOrder(1);

    assert.equal(h.db.getOrder(1)!.status, "MINTED");
    assert.equal(h.minter.calls.length, 2, "mint was retried");
    assert.equal(h.bridge.executeCount, 1, "must not re-bridge on retry");
    assert.equal(h.cc.openCount, 1, "must not buy a second pack on retry");
  });

  /**
   * A stranded order must self-heal once the underlying fault clears — without a human
   * remembering to poke it. The fast-retry budget backs off; it does not give up.
   */
  test("resumes a stranded order after the fault is fixed", async () => {
    const h = harness();
    h.minter.failTimes = 99;
    seedOrder(h.db);

    await h.pipeline.processOrder(1);
    assert.equal(h.db.getOrder(1)!.status, "FAILED");

    h.minter.failTimes = 0; // whatever was broken is fixed
    await h.pipeline.resumeAll();

    assert.equal(h.db.getOrder(1)!.status, "MINTED");
    assert.equal(h.bridge.executeCount, 1);
    assert.equal(h.cc.openCount, 1);
  });
});

describe("idempotency and crash recovery", () => {
  /** A crash between purchase and reveal must not buy a second pack with one payment. */
  test("never purchases twice for one order", async () => {
    const h = harness();
    seedOrder(h.db);
    await h.pipeline.processOrder(1);

    const memo = h.db.getOrder(1)!.cc_open_tx;
    await h.pipeline.processOrder(1);
    await h.pipeline.processOrder(1);

    assert.equal(h.cc.openCount, 1);
    assert.equal(h.db.getOrder(1)!.cc_open_tx, memo);
  });

  test("never bridges twice for one order", async () => {
    const h = harness();
    h.minter.failTimes = 2;
    seedOrder(h.db);

    await h.pipeline.processOrder(1);
    await h.pipeline.processOrder(1);
    await h.pipeline.processOrder(1);

    assert.equal(h.bridge.executeCount, 1);
  });

  test("resumeAll drives every non-terminal order", async () => {
    const h = harness();
    seedOrder(h.db, 1);
    seedOrder(h.db, 2);
    seedOrder(h.db, 3);

    await h.pipeline.resumeAll();

    for (const id of [1, 2, 3]) {
      assert.equal(h.db.getOrder(id)!.status, "MINTED", `order ${id}`);
    }
    assert.equal(h.cc.openCount, 3);
  });

  test("terminal orders are left alone", async () => {
    const h = harness();
    seedOrder(h.db);
    await h.pipeline.processOrder(1);

    await h.pipeline.processOrder(1);
    assert.equal(h.minter.calls.length, 1, "no second mint");
  });
});

describe("failure modes", () => {
  test("sold-out machine blocks the purchase before any spend", async () => {
    const h = harness();
    h.cc.failures.machineSoldOut = true;
    seedOrder(h.db);

    await h.pipeline.processOrder(1);

    assert.equal(h.db.getOrder(1)!.status, "FAILED");
    assert.equal(h.cc.openCount, 0);
  });

  /**
   * Doc 00 §6 invariant 1: never spend on Solana what wasn't prepaid on RH Chain. An order
   * that cannot bridge must never advance to the purchase step, however many times it
   * retries. (It oscillates CREATED <-> FAILED while retrying, so the meaningful assertion
   * is that it never got past bridging — not its exact resting status.)
   */
  test("bridge outage never lets an order reach the purchase step", async () => {
    const h = harness();
    h.bridge.failures.quoteThrows = true;
    seedOrder(h.db);

    await h.pipeline.processOrder(1);
    await h.pipeline.processOrder(1);

    const order = h.db.getOrder(1)!;
    assert.ok(["CREATED", "FAILED"].includes(order.status), `unexpected status ${order.status}`);
    assert.equal(order.cc_open_tx, null, "no pack was purchased");
    assert.equal(order.bridge_deposit_tx, null, "no bridge receipt was recorded");
    assert.equal(h.cc.openCount, 0, "no pack bought without funds on Solana");
    assert.equal(h.bridge.executeCount, 0, "nothing was ever sent");

    // And it stays refundable, because nothing was spent.
    h.db.setOrderStatus(1, "REFUNDED");
    assert.equal(h.db.getOrder(1)!.status, "REFUNDED");
  });

  /** A bridge that fails AFTER sending must not be re-sent — the resumed transfer rejoins. */
  test("a retried bridge rejoins rather than sending twice", async () => {
    const h = harness();
    h.minter.failTimes = 3;
    seedOrder(h.db);

    await h.pipeline.processOrder(1);
    await h.pipeline.processOrder(1);

    assert.equal(h.bridge.executeCount, 1, "exactly one transfer for one order");
  });

  /** The known dependency risk: if CC turns the key gate on, every order dies at once. */
  test("API-key enforcement raises a CRITICAL alert naming the cause", async () => {
    const h = harness();
    h.cc.failures.requiresApiKey = true;
    seedOrder(h.db);

    await h.pipeline.processOrder(1);

    assert.equal(h.db.getOrder(1)!.status, "FAILED");
    assert.ok(
      h.alerts.some((a) => a.includes("401") || a.includes("unauthorized")),
      `expected an auth-related alert, got: ${JSON.stringify(h.alerts)}`,
    );
  });

  test("a card with no insured value still mints, but warns", async () => {
    const h = harness();
    h.cc.failures.metadataMissingInsuredValue = true;
    seedOrder(h.db);

    await h.pipeline.processOrder(1);

    assert.equal(h.db.getOrder(1)!.status, "MINTED");
    assert.ok(h.alerts.some((a) => a.includes("no insuredValue")));
  });
});

/**
 * The mint was broadcast, then the process died before its result was recorded.
 *
 * This path used to close the order MINTED with `mirror_token_id` NULL and skip the
 * `cards.owner_mirror_token_id` update entirely. The card then existed on chain, owned by the
 * buyer, while our records could not name its token — so `/collection` rendered "Card #null",
 * the withdraw path threw on `BigInt(null)` behind a generic failure message, and both
 * sell-back routes key on that column so they 404. The card was permanently un-exitable
 * through the UI, with nothing to diagnose it from.
 *
 * It only happens after a crash in a one-line window, which is exactly why it needs a test.
 */
describe("a mint interrupted between broadcast and recording", () => {
  /** Drive an order to the point where the mint intent is claimed but unrecorded. */
  function interruptedMint(h: ReturnType<typeof harness>, tokenId: bigint | null) {
    seedOrder(h.db);
    h.db.setOrderStatus(1, "BRIDGING");
    h.db.setOrderStatus(1, "OPENING", { cc_open_tx: "memo-1" });
    h.db.setOrderStatus(1, "REVEALED", { solana_mint: "MintAbc" });
    h.db.insertCard({
      solanaMint: "MintAbc", orderId: 1, certNumber: "1", grade: "PSA 10", name: "Card",
      imageUrl: null, insuredValueUsd: "40000000", revealAt: Date.now(),
      ccWindowEndsAt: Date.now() + 72 * 3600_000, userWindowEndsAt: Date.now() + 66 * 3600_000,
      // Unlinked, which is the state the crash leaves behind and the thing being recovered.
      ownerMirrorTokenId: null,
    });
    // The claim exists with a tx, but nothing was written back: the crash window.
    // Deployment-scoped, matching intentKey(). A bare "mint:order:1" would no longer be
    // found — which is the entire point of the scoping, and worth asserting by construction.
    const key = `mint:order:1@${"0xPackSaleTest".toLowerCase()}`;
    h.db.claimIntent(key, "mint", { orderId: 1 });
    h.db.recordIntentTx(key, "0xmintbroadcast", "CONFIRMED");
    return tokenId;
  }

  test("recovers the token id from chain instead of closing with a null", async () => {
    const h = harness();
    interruptedMint(h, 7n);
    (h.pipeline as unknown as { d: { mintedTokenFor: () => Promise<bigint> } }).d.mintedTokenFor =
      async () => 7n;

    await h.pipeline.processOrder(1);

    const order = h.db.getOrder(1)!;
    assert.equal(order.status, "MINTED");
    assert.equal(order.mirror_token_id, "7", "the token id must be recovered, not left null");

    const card = h.db.raw.prepare(`SELECT owner_mirror_token_id FROM cards WHERE solana_mint = ?`)
      .get("MintAbc") as { owner_mirror_token_id: string | null };
    assert.equal(card.owner_mirror_token_id, "7", "the card must be linked, or sell-back 404s");
  });

  test("refuses to close the order when the chain has no token for it", async () => {
    // Broadcast but nothing minted: the tx reverted, or has not landed. Closing here is what
    // stranded the card, and MINTED is terminal — so it must stay open and retry.
    const h = harness();
    interruptedMint(h, null);
    (h.pipeline as unknown as { d: { mintedTokenFor: () => Promise<bigint> } }).d.mintedTokenFor =
      async () => 0n;

    await h.pipeline.processOrder(1);

    const order = h.db.getOrder(1)!;
    assert.notEqual(order.status, "MINTED", "must NOT record a card it cannot name");
    assert.ok(
      h.alerts.some((a) => /no token is minted on chain/.test(a)),
      "and it must say so rather than failing quietly",
    );
  });
});

/**
 * An intent from a PREVIOUS deployment must be unreachable.
 *
 * Intent keys were the bare on-chain order id. PackSale restarts nextOrderId at 1 on every
 * redeploy, so the first order on a fresh contract inherited the old deployment's intents —
 * and claimIntent reports an existing key as "already done". The pipeline would conclude the
 * pack was already bought, write the OLD memo onto the new order (which makes it
 * must-complete, closing the automatic refund), and never buy anything for the buyer who paid.
 *
 * Verified live on 20 Jul: bridge-out, cc-open and mint intents for order 1 were sitting in
 * production CONFIRMED, from a contract nothing pointed at any more.
 */
describe("intents from a previous deployment", () => {
  test("a stale bare-key intent does not hijack a new order", async () => {
    const h = harness();
    seedOrder(h.db);

    // Exactly what production held: the old deployment's claim, under the OLD key shape.
    h.db.claimIntent("cc-open:order:1", "cc-open", { orderId: 1 });
    h.db.recordIntentTx("cc-open:order:1", "cc-OLD-MEMO-from-a-dead-contract", "CONFIRMED");

    await h.pipeline.processOrder(1);

    const order = h.db.getOrder(1)!;
    assert.notEqual(
      order.cc_open_tx,
      "cc-OLD-MEMO-from-a-dead-contract",
      "the new order must NOT inherit a dead deployment's pack memo",
    );
    // A real purchase happened for THIS order, rather than being skipped as already done.
    assert.ok(order.cc_open_tx, "the pack must actually be bought for this buyer");
  });

  test("the same order still resumes from its OWN intent", async () => {
    // The scoping must not break genuine crash recovery, which is what intents are for.
    const h = harness();
    seedOrder(h.db);
    const key = `cc-open:order:1@${"0xPackSaleTest".toLowerCase()}`;
    h.db.claimIntent(key, "cc-open", { orderId: 1 });
    h.db.recordIntentTx(key, "cc-THIS-orders-memo", "CONFIRMED");

    await h.pipeline.processOrder(1);

    assert.equal(
      h.db.getOrder(1)!.cc_open_tx,
      "cc-THIS-orders-memo",
      "its own claim must still be honoured, or a crash re-buys the pack",
    );
  });
});
