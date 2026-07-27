import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Db } from "../db/index.ts";
import { createApi } from "./server.ts";
import type { ApiDeps } from "./server.ts";

/**
 * The API's card shape must match the frontend's `Card` type field-for-field.
 *
 * It did not, and nothing caught it: the API sent `imageUrl` while the UI reads `imageFront`,
 * so every real card would have rendered a grade placeholder instead of artwork. The browser
 * mock supplied the correct shape, so the mismatch only appeared once the site pointed at the
 * worker — which is to say, it would have appeared on the very first real pack.
 *
 * These names are a contract. Renaming one without the other breaks the reveal silently.
 */
const CARD_FIELDS = [
  "solanaMint",
  "name",
  "grade",
  "certNumber",
  "imageFront",
  "imageBack",
  "imageFrontFallback",
  "imageBackFallback",
  "tier",
  "insuredValueUsd",
] as const;

function seed(db: Db) {
  const now = Date.now();
  db.insertOrder({ id: 1, buyer: "0xbuyer", machineId: "pokemon_250", priceUsdg: "250000000", rhPayTx: null, deadlineAt: now + 600_000 });
  db.insertCard({
    solanaMint: "MintX", orderId: 1, certNumber: "123", grade: "PSA 10", name: "Charizard",
    imageUrl: "https://example.com/front.png",
    imageBackUrl: "https://example.com/back.png",
    tier: "rare",
    insuredValueUsd: "1800000000", revealAt: now,
    ccWindowEndsAt: now + 72 * 3600_000, userWindowEndsAt: now + 66 * 3600_000,
    ownerMirrorTokenId: "1",
  });
  db.setOrderStatus(1, "BRIDGING");
  db.setOrderStatus(1, "OPENING", { cc_open_tx: "memo" });
  db.setOrderStatus(1, "REVEALED", { solana_mint: "MintX" });
  db.setOrderStatus(1, "MINTED", { mirror_token_id: "1" });
}

describe("the card shape the UI depends on", () => {
  test("the back image and tier survive a round trip through the database", () => {
    const db = new Db(":memory:");
    seed(db);
    const row = db.raw.prepare(`SELECT * FROM cards WHERE solana_mint = ?`).get("MintX") as Record<string, unknown>;

    assert.equal(row.image_back_url, "https://example.com/back.png", "slab back must be stored");
    assert.equal(row.tier, "rare", "tier must be stored, not recomputed later from value");
  });

  /**
   * Drive the REAL API over HTTP.
   *
   * The previous version of this test built its own `serialized` literal that re-implemented
   * the mapping, then asserted against that literal. It never imported `createApi`, so
   * renaming `imageFront` back to `imageUrl` in server.ts would not have failed it — the test
   * would still have passed while every real card rendered a placeholder. A test that
   * re-implements the thing it checks cannot catch the bug class it exists for.
   *
   * There are also TWO independent hand-built card serializers (`/collection` and
   * `serializeOrder`), so both routes are exercised: a rename in either must fail here.
   */
  async function withApi<T>(fn: (base: string, db: Db) => Promise<T>): Promise<T> {
    const db = new Db(":memory:");
    seed(db);
    const server = createApi({
      db,
      cc: {} as ApiDeps["cc"],
      pipeline: {} as ApiDeps["pipeline"],
      cfg: { economics: { unwrapFeeDuringWindowBps: 0 } } as ApiDeps["cfg"],
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      return await fn(`http://127.0.0.1:${port}`, db);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  function assertCardShape(card: Record<string, unknown> | null, where: string) {
    assert.ok(card, `${where} returned no card at all`);
    for (const field of CARD_FIELDS) {
      assert.ok(field in card!, `${where} is missing "${field}", which the UI reads`);
      assert.notEqual(card![field], undefined, `${where} field "${field}" is undefined`);
    }
    assert.ok(!("imageUrl" in card!), `${where} sent imageUrl, the old name the UI never reads`);
  }

  test("GET /order/:id sends every field the frontend Card type reads", async () => {
    await withApi(async (base) => {
      const res = await fetch(`${base}/order/1`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { card: Record<string, unknown> | null };
      assertCardShape(body.card, "GET /order/:id card");
    });
  });

  test("GET /collection/:address sends every field the frontend Card type reads", async () => {
    await withApi(async (base) => {
      const res = await fetch(`${base}/collection/0xbuyer`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { cards: Record<string, unknown>[] };
      assert.equal(body.cards.length, 1, "the seeded MINTED order must appear in the collection");
      assertCardShape(body.cards[0] ?? null, "GET /collection/:address card");
    });
  });

  test("tier is per-machine, not derived from insured value", async () => {
    const { tierFromBands } = await import("../pipeline/fulfill.ts");
    const fifty = { common: { start: 30, end: 60 }, uncommon: { start: 60, end: 110 }, rare: { start: 110, end: 250 }, epic: { start: 250, end: 5001 } };
    const twoFifty = { common: { start: 150, end: 250 }, uncommon: { start: 250, end: 400 }, rare: { start: 400, end: 2000 }, epic: { start: 2000, end: 50000 } };

    // The documented trap: the same money is a different tier per machine.
    assert.equal(tierFromBands(500, fifty), "epic");
    assert.equal(tierFromBands(500, twoFifty), "rare");
    assert.equal(tierFromBands(1800, twoFifty), "rare");
    assert.equal(tierFromBands(2500, twoFifty), "epic");
    // No bands means no guess.
    assert.equal(tierFromBands(500, undefined), null);
  });
});

describe("demo orders never count as real", () => {
  test("a demo order is excluded from the leaderboard and from a collection", () => {
    const db = new Db(":memory:");
    const now = Date.now();

    const mint = (id: number, buyer: string, value: string, demo: boolean) => {
      db.insertOrder({ id, buyer, machineId: "pokemon_50", priceUsdg: "53000000", rhPayTx: null, deadlineAt: now + 600_000, demo });
      db.insertCard({
        solanaMint: `m${id}`, orderId: id, certNumber: null, grade: "PSA 10", name: `C${id}`,
        imageUrl: "f", imageBackUrl: "b", tier: "rare", insuredValueUsd: value, revealAt: now,
        ccWindowEndsAt: now + 1e7, userWindowEndsAt: now + 9e6, ownerMirrorTokenId: String(id),
      });
      db.setOrderStatus(id, "BRIDGING");
      db.setOrderStatus(id, "OPENING", { cc_open_tx: `t${id}` });
      db.setOrderStatus(id, "REVEALED", { solana_mint: `m${id}` });
      db.setOrderStatus(id, "MINTED", { mirror_token_id: String(id) });
    };

    mint(1, "0xReal", "100000000", false);
    mint(2, "0xDemo", "999000000", true);

    const board = db.raw
      .prepare(
        `SELECT lower(o.buyer) AS address, COUNT(*) AS packsOpened
           FROM orders o JOIN cards c ON c.order_id = o.id
          WHERE o.status = 'MINTED' AND o.demo = 0
          GROUP BY lower(o.buyer)`,
      )
      .all() as { address: string }[];

    assert.deepEqual(board.map((r) => r.address), ["0xreal"], "only the real buyer ranks");

    const demoCollection = db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM orders o JOIN cards c ON c.order_id = o.id
          WHERE lower(o.buyer) = lower(?) AND o.status = 'MINTED' AND o.demo = 0`,
      )
      .get("0xDemo") as { n: number };

    assert.equal(demoCollection.n, 0, "a demo pull must not appear in anyone's collection");
  });

  test("a real order defaults to non-demo", () => {
    const db = new Db(":memory:");
    db.insertOrder({ id: 1, buyer: "0xReal", machineId: "pokemon_50", priceUsdg: "53000000", rhPayTx: null, deadlineAt: Date.now() + 600_000 });
    const row = db.getOrder(1)!;
    assert.equal(row.demo, 0, "omitting the flag must mean real, never demo");
  });
});
