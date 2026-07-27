import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Db } from "../db/index.ts";
import { createApi } from "./server.ts";
import type { ApiDeps } from "./server.ts";

/**
 * GET /cards — card metadata by mirror token id, for the marketplace.
 *
 * The marketplace enumerates listings from chain logs, which carry only a tokenId, a seller
 * and a price. Everything a buyer actually decides on — name, grade, tier, artwork, insured
 * value — comes from here. Before this route existed the UI substituted placeholders: every
 * listing read "Card #7", tier grey, insured value 0, and the "% of insured" badge divided by
 * that zero.
 *
 * Driven over real HTTP against the real createApi, not against a re-implementation of the
 * mapping. See card-shape.test.ts: a test that rebuilds the thing it checks cannot catch a
 * rename, which is the bug class this route is most likely to suffer.
 */

function seed(db: Db) {
  const now = Date.now();
  for (const [orderId, tokenId, mint, name] of [
    [1, "1", "MintA", "Charizard"],
    [2, "2", "MintB", "Blastoise"],
  ] as const) {
    db.insertOrder({ id: orderId, buyer: `0xbuyer${orderId}`, machineId: "pokemon_250", priceUsdg: "250000000", rhPayTx: null, deadlineAt: now + 600_000 });
    db.insertCard({
      solanaMint: mint, orderId, certNumber: `cert${orderId}`, grade: "PSA 10", name,
      imageUrl: `https://example.com/${mint}-front.png`,
      imageBackUrl: `https://example.com/${mint}-back.png`,
      tier: "rare", insuredValueUsd: "1800000000", revealAt: now,
      ccWindowEndsAt: now + 72 * 3600_000, userWindowEndsAt: now + 66 * 3600_000,
      ownerMirrorTokenId: tokenId,
    });
    db.setOrderStatus(orderId, "BRIDGING");
    db.setOrderStatus(orderId, "OPENING", { cc_open_tx: "memo" });
    db.setOrderStatus(orderId, "REVEALED", { solana_mint: mint });
    db.setOrderStatus(orderId, "MINTED", { mirror_token_id: tokenId });
  }
}

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

const get = async (base: string, path: string) =>
  (await (await fetch(`${base}${path}`)).json()) as { cards: Record<string, unknown>[] };

describe("GET /cards", () => {
  test("returns the fields the marketplace tile actually renders", async () => {
    await withApi(async (base) => {
      const { cards } = await get(base, "/cards?ids=1");
      assert.equal(cards.length, 1);
      const c = cards[0]!;

      // Exactly the names the frontend's MarketCard type reads. A rename here renders
      // placeholder art and a zero insured value, which is what this route exists to stop.
      for (const field of ["tokenId", "name", "grade", "imageFront", "imageFrontFallback", "tier", "insuredValueUsd", "state"]) {
        assert.ok(field in c, `missing ${field}`);
      }
      assert.equal(c.name, "Charizard");
      assert.equal(c.tier, "rare");
      assert.equal(c.insuredValueUsd, "1800000000", "a zero here divides by zero in the UI");
      assert.equal(c.imageFront, "https://example.com/MintA-front.png");
      assert.equal(c.tokenId, "1", "tokenId must be a string — it is a map key on the client");
    });
  });

  test("batches: one request covers every listing on the page", async () => {
    await withApi(async (base) => {
      const { cards } = await get(base, "/cards?ids=1,2");
      assert.deepEqual(cards.map((c) => c.tokenId).sort(), ["1", "2"]);
    });
  });

  test("an unknown id is simply absent, not an error", async () => {
    // A listing whose card we cannot resolve must still render from its chain data.
    await withApi(async (base) => {
      const { cards } = await get(base, "/cards?ids=1,999");
      assert.deepEqual(cards.map((c) => c.tokenId), ["1"]);
    });
  });

  test("no ids returns an empty list rather than the whole table", async () => {
    await withApi(async (base) => {
      assert.deepEqual((await get(base, "/cards")).cards, []);
      assert.deepEqual((await get(base, "/cards?ids=")).cards, []);
    });
  });

  test("non-numeric ids are dropped rather than reaching the query", async () => {
    await withApi(async (base) => {
      const { cards } = await get(base, "/cards?ids=1,'%20OR%201=1--,abc");
      assert.deepEqual(cards.map((c) => c.tokenId), ["1"], "only the real id survives");
    });
  });

  test("the batch is bounded", async () => {
    // Without a cap a caller could ask for the entire cards table in one request.
    await withApi(async (base) => {
      const ids = Array.from({ length: 500 }, (_, i) => i + 1).join(",");
      const { cards } = await get(base, `/cards?ids=${ids}`);
      assert.ok(cards.length <= 100, `expected the cap to apply, got ${cards.length}`);
    });
  });
});
