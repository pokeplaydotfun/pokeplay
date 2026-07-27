import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Db } from "../db/index.ts";
import { createApi } from "./server.ts";
import type { ApiDeps } from "./server.ts";

/**
 * Body size and rate limits.
 *
 * The API and the fulfilment worker share ONE process, one event loop and one Collector Crypt
 * client. So an anonymous flood is not a nuisance — it kills the process holding both hot
 * keys, mid-fulfilment, with customer money in flight. Verified exploitable against the live
 * API during the 19 Jul review: an 8 MB body was buffered and parsed in full.
 */
async function withApi<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const db = new Db(":memory:");
  const server = createApi({
    db,
    cc: { async listMachines() { return []; } } as unknown as ApiDeps["cc"],
    pipeline: {} as ApiDeps["pipeline"],
    cfg: {
      maxSellBackValueUsd: 137, sellBackEnabled: false,
      economics: { spreadBps: 500, quoteTtlSec: 60, unwrapFeeDuringWindowBps: 0 },
      limits: {},
    } as unknown as ApiDeps["cfg"],
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise<void>((r) => server.close(() => r())); }
}

describe("request limits", () => {
  test("an oversized body is refused with 413, not buffered", async () => {
    await withApi(async (base) => {
      const res = await fetch(`${base}/settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pad: "x".repeat(200_000) }),
      });
      assert.equal(res.status, 413);
    });
  });

  test("an ordinary body still reaches validation", async () => {
    // The limit must not break the real endpoint: a small body should get past readBody and
    // be rejected on its merits (400), never on its size.
    await withApi(async (base) => {
      const res = await fetch(`${base}/settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: "0x0", solanaAddress: "x", nonce: 1, signature: "0x" }),
      });
      assert.notEqual(res.status, 413, "a normal request must not be size-blocked");
    });
  });

  /**
   * The limit must sit well ABOVE what a real buyer generates. The reveal polls /order/:id at
   * 2Hz for the whole open — 120 requests a minute on its own — and an earlier limit of 120
   * cut a legitimate buyer off mid-reveal on the first real pack.
   */
  test("a real reveal poll rate is nowhere near the limit", async () => {
    await withApi(async (base) => {
      let limited = 0;
      // 150 requests: more than a 60s reveal poll plus the other pollers combined.
      for (let i = 0; i < 150; i++) {
        const res = await fetch(`${base}/health`);
        if (res.status === 429) limited += 1;
      }
      assert.equal(limited, 0, "a legitimate buyer must never be rate limited mid-open");
    });
  });

  test("a flood is rate limited rather than passed upstream", async () => {
    // Every /health hit makes an uncached Collector Crypt call. Unlimited traffic here sets
    // our outbound QPS to a third party who can ban the account and take fulfilment with it.
    await withApi(async (base) => {
      let limited = 0;
      for (let i = 0; i < 700; i++) {
        const res = await fetch(`${base}/health`);
        if (res.status === 429) limited += 1;
      }
      assert.ok(limited > 0, "a 700-request burst must eventually hit the limit");
      assert.ok(limited < 700, "and must not block everything");
    });
  });

  test("the limit response tells the caller when to retry", async () => {
    await withApi(async (base) => {
      let res = await fetch(`${base}/health`);
      for (let i = 0; i < 700 && res.status !== 429; i++) res = await fetch(`${base}/health`);
      assert.equal(res.status, 429);
      assert.equal(res.headers.get("retry-after"), "60");
    });
  });
});
