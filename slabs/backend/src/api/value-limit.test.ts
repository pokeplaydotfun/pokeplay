import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Db } from "../db/index.ts";
import { createApi } from "./server.ts";
import type { ApiDeps } from "./server.ts";
import { VALUE_LIMIT_CODE } from "../policy.ts";

/**
 * The value ceiling as the API enforces it.
 *
 * Driven over real HTTP rather than by calling a handler, for the same reason card-shape.test
 * was rewritten: a test that re-implements the thing it checks cannot catch the bug it exists
 * for. These requests are the ones a browser would actually make.
 */

const TOKEN = "7";
const MINT = "MintAbc123";

function deps(db: Db, maxSellBackValueUsd: number): ApiDeps {
  return {
    db,
    cc: {
      // Reaching CC at all would be a failure: a card over the limit must be refused before
      // we spend an upstream call on it.
      async getBuybackQuote() {
        throw new Error("CC must not be called for a card over the value limit");
      },
      async listMachines() {
        return [];
      },
    } as unknown as ApiDeps["cc"],
    pipeline: {} as ApiDeps["pipeline"],
    cfg: {
      maxSellBackValueUsd,
      sellBackEnabled: true,
      economics: { spreadBps: 500, quoteTtlSec: 60, unwrapFeeDuringWindowBps: 0 },
    } as unknown as ApiDeps["cfg"],
    escrowAddress: "0xEscrow",
  };
}

function seed(db: Db, insuredValueUsd: string | null) {
  const now = Date.now();
  db.insertOrder({ id: 1, buyer: "0xbuyer", machineId: "pokemon_50", priceUsdg: "53000000", rhPayTx: null, deadlineAt: now + 600_000 });
  db.insertCard({
    solanaMint: MINT, orderId: 1, certNumber: "1", grade: "PSA 10", name: "Card",
    imageUrl: null, insuredValueUsd, revealAt: now,
    ccWindowEndsAt: now + 72 * 3600_000, userWindowEndsAt: now + 66 * 3600_000,
    ownerMirrorTokenId: TOKEN,
  });
  db.setCardState(MINT, "CUSTODY");
}

async function withApi<T>(
  maxUsd: number,
  insuredValueUsd: string | null,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const db = new Db(":memory:");
  seed(db, insuredValueUsd);
  const server = createApi(deps(db, maxUsd));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("the API refuses cards over the value limit", () => {
  const OVER = "250000000"; // $250
  const AT = "137000000"; // exactly at the test ceiling
  const UNDER = "40000000"; // $40

  test("GET /quote/sell refuses, with a machine-readable code", async () => {
    await withApi(137, OVER, async (base) => {
      const res = await fetch(`${base}/quote/sell/${TOKEN}`);
      assert.equal(res.status, 403);
      const body = (await res.json()) as { error: string; code: string; limitUsd?: number };
      assert.equal(body.code, VALUE_LIMIT_CODE, "the UI branches on this, not on the text");
      /**
       * The code is machine-readable so support can tell a value block from any other 403 —
       * but the THRESHOLD is not returned. A refusal that names the number tells whoever
       * triggered it exactly where the manual-review line sits, which is the thing this
       * repository and this API are both meant to keep to the operator.
       */
      assert.equal(body.limitUsd, undefined, "the refusal must not name the threshold");
      assert.ok(!JSON.stringify(body).includes("137"), "nor leak it anywhere else in the body");
      assert.equal(body.error, "This feature is temporarily unavailable.");
      assert.doesNotMatch(body.error, /\$|\d/, "the threshold must not leak into user copy");
    });
  });

  test("POST /sell refuses too, so the quote is not the only gate", async () => {
    await withApi(137, OVER, async (base) => {
      const res = await fetch(`${base}/sell/${TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requester: "0xbuyer" }),
      });
      assert.equal(res.status, 403);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, VALUE_LIMIT_CODE);
    });
  });

  test("a card exactly at the limit is allowed through the gate", async () => {
    await withApi(137, AT, async (base) => {
      const res = await fetch(`${base}/quote/sell/${TOKEN}`);
      // It gets past the ceiling and dies at the CC stub, which is the proof: the value check
      // let it through. A 403 here would mean the boundary is off by one.
      assert.notEqual(res.status, 403, "exactly at the ceiling is not over it");
    });
  });

  test("an ordinary card is not blocked", async () => {
    await withApi(137, UNDER, async (base) => {
      const res = await fetch(`${base}/quote/sell/${TOKEN}`);
      assert.notEqual(res.status, 403);
    });
  });

  test("a card with no insured value is refused rather than quoted", async () => {
    await withApi(137, null, async (base) => {
      const res = await fetch(`${base}/quote/sell/${TOKEN}`);
      assert.equal(res.status, 403, "a card we cannot price is a card we cannot clear");
    });
  });

  test("a limit of 0 disables the ceiling entirely", async () => {
    await withApi(0, OVER, async (base) => {
      const res = await fetch(`${base}/quote/sell/${TOKEN}`);
      assert.notEqual(res.status, 403, "0 means no cap, so a $250 card passes the gate");
    });
  });

  /**
   * The opposite of what this test used to assert.
   *
   * /health published the threshold in full so the UI would not hardcode it. That was the
   * right instinct about duplication and the wrong answer: it told anyone reading a public
   * endpoint exactly where a sale stops being automatic and starts needing a person. The UI
   * still does not hardcode anything — it is told per card whether THAT card is over.
   */
  test("/health says a limit exists but never what it is", async () => {
    await withApi(137, UNDER, async (base) => {
      const res = await fetch(`${base}/health`);
      const body = (await res.json()) as Record<string, unknown>;

      assert.equal(body.valueLimitActive, true, "the UI needs to know a ceiling is in force");
      assert.equal(body.maxCardValueUsd, undefined, "but never the number itself");
      assert.ok(
        !JSON.stringify(body).includes("137"),
        "the threshold must not appear anywhere in the payload",
      );
    });
  });
});

/**
 * Demo pulls must be untouched by the value ceiling.
 *
 * A demo card is simulated in the browser against Collector Crypt's real published odds, so
 * demo pulls routinely produce cards "worth" thousands. If the ceiling reached them, the demo
 * would start refusing its own fake cards and look broken.
 *
 * It cannot, for three independent reasons, and this pins the one that lives on the server.
 */
describe("the value limit never touches demo pulls", () => {
  const OVER = "250000000"; // a demo card can easily "roll" this

  function seedDemo(db: Db, insuredValueUsd: string) {
    const now = Date.now();
    db.insertOrder({
      id: 2, buyer: "0xbuyer", machineId: "pokemon_250", priceUsdg: "250000000",
      rhPayTx: null, deadlineAt: now + 600_000, demo: true,
    });
    db.insertCard({
      solanaMint: "DemoMint", orderId: 2, certNumber: "2", grade: "PSA 10", name: "Demo Card",
      imageUrl: null, insuredValueUsd, revealAt: now,
      ccWindowEndsAt: now + 72 * 3600_000, userWindowEndsAt: now + 66 * 3600_000,
      ownerMirrorTokenId: "99",
    });
    db.setCardState("DemoMint", "CUSTODY");
    db.setOrderStatus(2, "BRIDGING");
    db.setOrderStatus(2, "OPENING", { cc_open_tx: "demo" });
    db.setOrderStatus(2, "REVEALED", { solana_mint: "DemoMint" });
    db.setOrderStatus(2, "MINTED", { mirror_token_id: "99" });
  }

  test("a high-value demo card never reaches the collection, so it can never be blocked", async () => {
    const db = new Db(":memory:");
    seedDemo(db, OVER);
    const server = createApi(deps(db, 100));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/collection/0xbuyer`);
      const body = (await res.json()) as { cards: unknown[] };
      // The Sell back and Withdraw buttons the ceiling guards are rendered from this list.
      // A demo card is not in it, so those controls never exist for one.
      assert.equal(body.cards.length, 0, "demo orders must not appear in a real collection");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("a real card of the same value IS blocked, proving the demo flag is what spared it", async () => {
    // Without this pair, the test above would also pass if the ceiling were simply broken.
    await withApi(137, OVER, async (base) => {
      const res = await fetch(`${base}/quote/sell/${TOKEN}`);
      assert.equal(res.status, 403);
    });
  });
});
