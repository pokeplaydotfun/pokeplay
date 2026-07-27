import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Db } from "./index.ts";

function freshDb(): Db {
  return new Db(":memory:");
}

function seedOrder(db: Db, id = 1, deadlineAt = Date.now() + 600_000) {
  db.insertOrder({
    id,
    buyer: "0xbuyer",
    machineId: "cc-elite-50",
    priceUsdg: "50000000",
    rhPayTx: "0xpay",
    deadlineAt,
  });
}

describe("order state machine", () => {
  test("insertOrder is idempotent — duplicate events must not duplicate orders", () => {
    const db = freshDb();
    seedOrder(db);
    seedOrder(db);
    assert.equal(db.totalOrderCount(), 1);
    db.close();
  });

  test("walks the happy path", () => {
    const db = freshDb();
    seedOrder(db);

    db.setOrderStatus(1, "BRIDGING", { bridge_deposit_tx: "0xdep" });
    db.setOrderStatus(1, "OPENING", { cc_open_tx: "solsig" });
    db.setOrderStatus(1, "REVEALED", { solana_mint: "mint1" });
    db.setOrderStatus(1, "MINTED", { mirror_token_id: "7" });

    const order = db.getOrder(1)!;
    assert.equal(order.status, "MINTED");
    assert.equal(order.mirror_token_id, "7");
    db.close();
  });

  test("rejects illegal transitions", () => {
    const db = freshDb();
    seedOrder(db);
    assert.throws(() => db.setOrderStatus(1, "MINTED"), /Illegal order transition CREATED -> MINTED/);
    db.close();
  });

  test("terminal states are terminal", () => {
    const db = freshDb();
    seedOrder(db);
    db.setOrderStatus(1, "REFUNDED");
    assert.throws(() => db.setOrderStatus(1, "BRIDGING"), /Illegal order transition/);
    db.close();
  });

  /**
   * The invariant the whole forceRefund design exists to protect: once a real pack has been
   * opened, no automated path may refund it.
   */
  test("refuses to refund an order that opened a pack", () => {
    const db = freshDb();
    seedOrder(db);
    db.setOrderStatus(1, "BRIDGING");
    db.setOrderStatus(1, "OPENING", { cc_open_tx: "solsig" });
    db.setOrderStatus(1, "FAILED", { last_error: "mint reverted" });

    assert.throws(
      () => db.setOrderStatus(1, "REFUNDED"),
      /Refusing to refund order 1: cc_open_tx solsig exists/,
    );
    db.close();
  });

  test("allows refund when no pack was opened", () => {
    const db = freshDb();
    seedOrder(db);
    db.setOrderStatus(1, "BRIDGING");
    db.setOrderStatus(1, "REFUNDED");
    assert.equal(db.getOrder(1)!.status, "REFUNDED");
    db.close();
  });
});

describe("recovery queries", () => {
  test("refundableOrders excludes anything that opened a pack", () => {
    const db = freshDb();
    const past = Date.now() - 1000;

    seedOrder(db, 1, past);
    seedOrder(db, 2, past);
    db.setOrderStatus(2, "BRIDGING");
    db.setOrderStatus(2, "OPENING", { cc_open_tx: "solsig" });

    const refundable = db.refundableOrders();
    assert.deepEqual(refundable.map((o) => o.id), [1]);
    db.close();
  });

  test("strandedOrders finds opened-but-unminted orders for the runbook", () => {
    const db = freshDb();
    seedOrder(db);
    db.setOrderStatus(1, "BRIDGING");
    db.setOrderStatus(1, "OPENING", { cc_open_tx: "solsig" });

    assert.equal(db.strandedOrders(0).length, 1);
    // Not yet stranded if it is still fresh.
    assert.equal(db.strandedOrders(60_000).length, 0);
    db.close();
  });

  test("activeOrders is the crash-recovery resume set", () => {
    const db = freshDb();
    seedOrder(db, 1);
    seedOrder(db, 2);
    seedOrder(db, 3);
    db.setOrderStatus(2, "BRIDGING");
    db.setOrderStatus(3, "REFUNDED");

    assert.deepEqual(db.activeOrders().map((o) => o.id), [1, 2]);
    db.close();
  });
});

describe("idempotency intents", () => {
  test("second claim is not fresh and returns the recorded tx", () => {
    const db = freshDb();

    const first = db.claimIntent("bridge-out:order:1", "bridge", { amount: "50000000" });
    assert.equal(first.fresh, true);
    assert.equal(first.tx, null);

    db.recordIntentTx("bridge-out:order:1", "0xdeposit");

    const second = db.claimIntent("bridge-out:order:1", "bridge", { amount: "50000000" });
    assert.equal(second.fresh, false, "a restart must not re-send");
    assert.equal(second.tx, "0xdeposit");
    db.close();
  });
});

describe("treasury", () => {
  test("counts force refunds inside the rolling window", () => {
    const db = freshDb();
    db.recordTreasury({ kind: "FORCE_REFUND", amount: "50000000", token: "USDG", chain: "rh" });
    db.recordTreasury({ kind: "FORCE_REFUND", amount: "50000000", token: "USDG", chain: "rh" });
    db.recordTreasury({ kind: "REFUND", amount: "50000000", token: "USDG", chain: "rh" });

    const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
    assert.equal(db.forceRefundsSince(sevenDaysAgo), 2, "halt threshold reached");
    assert.equal(db.forceRefundsSince(Date.now() + 1000), 0);
    db.close();
  });
});

describe("column migrations", () => {
  /**
   * The production database was created before `cc_proceeds_usdc` existed, and
   * `CREATE TABLE IF NOT EXISTS` will not add it. This is the path that actually runs on the
   * next deploy, so it is worth exercising rather than assuming.
   */
  test("adds a missing column to a database that predates it", () => {
    const db = freshDb();

    // Recreate the pre-migration shape: drop the column back off.
    db.raw.exec(`ALTER TABLE buybacks DROP COLUMN cc_proceeds_usdc`);
    const before = db.raw.prepare(`PRAGMA table_info(buybacks)`).all() as { name: string }[];
    assert.ok(!before.some((c) => c.name === "cc_proceeds_usdc"), "column is gone");

    // A second Db over the same handle is not possible in-memory, so invoke the same path.
    (db as unknown as { migrate(): void }).migrate();

    const after = db.raw.prepare(`PRAGMA table_info(buybacks)`).all() as { name: string }[];
    assert.ok(after.some((c) => c.name === "cc_proceeds_usdc"), "column was added back");
  });

  test("is a no-op when the column already exists", () => {
    const db = freshDb();
    const before = db.raw.prepare(`PRAGMA table_info(buybacks)`).all() as { name: string }[];

    (db as unknown as { migrate(): void }).migrate();
    (db as unknown as { migrate(): void }).migrate();

    const after = db.raw.prepare(`PRAGMA table_info(buybacks)`).all() as { name: string }[];
    assert.equal(after.length, before.length, "running twice does not duplicate columns");
  });

  test("preserves existing rows", () => {
    const db = freshDb();
    // buybacks.solana_mint references cards, so the card has to exist first.
    seedOrder(db, 1);
    const now = Date.now();
    db.insertCard({
      solanaMint: "m", orderId: 1, certNumber: null, grade: null, name: null,
      imageUrl: null, insuredValueUsd: "100", revealAt: now,
      ccWindowEndsAt: now + 1000, userWindowEndsAt: now + 900, ownerMirrorTokenId: "1",
    });
    db.insertQuote({
      mirrorTokenId: "1", solanaMint: "m", requester: "0xr", ccQuoteBps: 8500,
      quotedUserRateBps: 8000, quotedUsdg: "80", insuredValueUsd: "100",
      expiresAt: now + 60_000,
    });
    db.raw.exec(`ALTER TABLE buybacks DROP COLUMN cc_proceeds_usdc`);

    (db as unknown as { migrate(): void }).migrate();

    const rows = db.raw.prepare(`SELECT * FROM buybacks`).all() as { quoted_usdg: string; cc_proceeds_usdc: string | null }[];
    assert.equal(rows.length, 1, "the row survived");
    assert.equal(rows[0]!.quoted_usdg, "80");
    assert.equal(rows[0]!.cc_proceeds_usdc, null, "new column defaults to null");
  });
});

describe("a mint that comes back", () => {
  /**
   * Selling a card back hands it to Collector Crypt, who put it straight back in the machine.
   * So the SAME solana_mint can be pulled again later. cards keys on the mint with
   * ON CONFLICT DO NOTHING, so the old row silently won: the new buyer's card carried the
   * previous order_id, the previous (burned) mirror token, a state of SOLD_TO_CC, and windows
   * that expired days earlier. Their sell-back would be refused and their withdraw would find
   * no card behind the mirror.
   */
  test("re-acquiring a sold card replaces the row instead of being swallowed", () => {
    const db = freshDb();
    const now = Date.now();
    seedOrder(db, 1);
    seedOrder(db, 2);

    db.insertCard({
      solanaMint: "mint-x", orderId: 1, certNumber: "old", grade: "PSA 9", name: "Card",
      imageUrl: null, insuredValueUsd: "100", revealAt: now - 100_000,
      ccWindowEndsAt: now - 1000, userWindowEndsAt: now - 2000, ownerMirrorTokenId: "1",
    });
    db.setCardState("mint-x", "SOLD_TO_CC");

    // Pulled again by a different buyer, on a new order, with a new mirror.
    db.insertCard({
      solanaMint: "mint-x", orderId: 2, certNumber: "new", grade: "PSA 10", name: "Card",
      imageUrl: null, insuredValueUsd: "250", revealAt: now,
      ccWindowEndsAt: now + 72 * 3600_000, userWindowEndsAt: now + 66 * 3600_000,
      ownerMirrorTokenId: "9",
    });

    const row = db.raw.prepare(`SELECT * FROM cards WHERE solana_mint = ?`).get("mint-x") as
      { order_id: number; state: string; owner_mirror_token_id: string; cert_number: string; user_window_ends_at: number };

    assert.equal(row.order_id, 2, "the card belongs to the order that just pulled it");
    assert.equal(row.owner_mirror_token_id, "9", "and to the mirror just minted for it");
    assert.equal(row.state, "CUSTODY", "it is ours again, not still sold");
    assert.equal(row.cert_number, "new", "the fresh metadata wins");
    assert.ok(row.user_window_ends_at > now, "and the sell window is the new one, not an expired one");
  });

  test("a card we still hold is never silently reassigned to another order", () => {
    const db = freshDb();
    const now = Date.now();
    seedOrder(db, 1);
    seedOrder(db, 2);

    db.insertCard({
      solanaMint: "mint-y", orderId: 1, certNumber: null, grade: null, name: null,
      imageUrl: null, insuredValueUsd: "100", revealAt: now,
      ccWindowEndsAt: now + 1000, userWindowEndsAt: now + 900, ownerMirrorTokenId: "1",
    });

    assert.throws(
      () => db.insertCard({
        solanaMint: "mint-y", orderId: 2, certNumber: null, grade: null, name: null,
        imageUrl: null, insuredValueUsd: "100", revealAt: now,
        ccWindowEndsAt: now + 1000, userWindowEndsAt: now + 900, ownerMirrorTokenId: "2",
      }),
      /Card collision on mint mint-y/,
      "two orders claiming one physical card must never pass quietly",
    );
  });
});
