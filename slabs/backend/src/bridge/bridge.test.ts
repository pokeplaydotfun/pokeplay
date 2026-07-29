import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MockBridge } from "./mock.ts";
import { JitSource } from "./jit-source.ts";
import { BridgeCostExceeded } from "./types.ts";
import { DeBridgeClient } from "./debridge.ts";
import { Db } from "../db/index.ts";
import type { Config } from "../config.ts";

/** Minimal config stub — only the fields the bridge layer reads. */
function testConfig(overrides: Partial<Config["bridge"]> = {}): Config {
  return {
    bridge: {
      provider: "debridge",
      apiUrl: "https://dln.debridge.finance/v1.0",
      rhChainId: 4663,
      solanaChainId: 7565164,
      costAlertUsd: 2.0,
      costAbortUsd: 5.0,
      fillTimeoutMs: 180_000,
      ...overrides,
    },
    rh: { usdgAddress: "0xusdg" },
    solana: { usdcMint: "usdcmint" },
    limits: { maxPackPriceUsdg: 55 },
  } as unknown as Config;
}

describe("JitSource cost gating", () => {
  test("bridges and records the fee as a real ledger cost", async () => {
    const db = new Db(":memory:");
    const bridge = new MockBridge();
    const jit = new JitSource(bridge, db, testConfig(), () => {});

    const result = await jit.provide("solana", "50000000", "order:1");

    // $50 in, measured $0.7704 fee out.
    assert.equal(result.amountAvailable, "49229600");
    assert.equal(bridge.executeCount, 1);

    const fees = db.raw.prepare(`SELECT * FROM treasury_events WHERE kind='BRIDGE_FEE'`).all();
    assert.equal(fees.length, 1, "every leg must hit the ledger — cost/pack comes from here");
    db.close();
  });

  /**
   * The one per-transaction risk in the model: the spread on a $50 pack is ~$2.60, so a leg
   * above the abort limit can invert an individual trade. It must refuse, not warn.
   */
  test("aborts rather than bridging above the abort limit", async () => {
    const db = new Db(":memory:");
    const bridge = new MockBridge({ forceCostUsd: 6.0 });
    const jit = new JitSource(bridge, db, testConfig(), () => {});

    await assert.rejects(() => jit.provide("solana", "50000000", "order:1"), BridgeCostExceeded);
    assert.equal(bridge.executeCount, 0, "must not spend when the quote is out of range");
    db.close();
  });

  test("alerts but proceeds between the alert and abort thresholds", async () => {
    const db = new Db(":memory:");
    const bridge = new MockBridge({ forceCostUsd: 3.0 });
    const alerts: string[] = [];
    const jit = new JitSource(bridge, db, testConfig(), (m) => alerts.push(m));

    await jit.provide("solana", "50000000", "order:1");

    assert.equal(alerts.length, 1);
    assert.match(alerts[0]!, /exceeds alert threshold/);
    assert.equal(bridge.executeCount, 1, "an alert is not a refusal");
    db.close();
  });

  test("settle moves value the other way", async () => {
    const db = new Db(":memory:");
    const bridge = new MockBridge();
    const jit = new JitSource(bridge, db, testConfig(), () => {});

    const result = await jit.settle("rh", "50000000", "buyback:1");

    // Return leg is the pricier one: measured $0.9075.
    assert.equal(result.amountAvailable, "49092500");
    db.close();
  });

  test("unhealthy bridge fails the health gate", async () => {
    const db = new Db(":memory:");
    const jit = new JitSource(new MockBridge({ quoteThrows: true }), db, testConfig(), () => {});
    assert.equal(await jit.healthy(), false);
    db.close();
  });
});

describe("measured economics", () => {
  /**
   * Guards the operator's launch decision. If these numbers drift, the $50 tier's break-even
   * has moved and doc 00 §3 needs revisiting — this test is the tripwire.
   */
  test("round trip at the $50 tier matches the measured $1.68", async () => {
    const bridge = new MockBridge();
    const out = await bridge.quote("rh", "solana", "50000000");
    const back = await bridge.quote("solana", "rh", "50000000");

    const roundTrip = out.costUsd + back.costUsd;
    assert.ok(
      Math.abs(roundTrip - 1.6779) < 0.01,
      `round trip should be ~$1.68, got $${roundTrip.toFixed(4)}`,
    );

    // Break-even sell-through: s*2.60 = out + s*back
    const spreadRevenue = 2.6;
    const breakEven = out.costUsd / (spreadRevenue - back.costUsd);
    assert.ok(
      breakEven > 0.4 && breakEven < 0.5,
      `break-even sell-through should be ~46%, got ${(breakEven * 100).toFixed(1)}%`,
    );
  });

  test("the fee is fixed, not proportional — which is why cheap tiers hurt", async () => {
    const bridge = new MockBridge();
    const small = await bridge.quote("rh", "solana", "50000000");
    const large = await bridge.quote("rh", "solana", "250000000");

    assert.equal(small.costUsd, large.costUsd, "cost per transfer does not scale with size");
    assert.ok(large.costBps < small.costBps / 4, "so bps improves sharply with size");
  });
});

describe("DeBridgeClient", () => {
  test("parses a real-shaped quote response", async () => {
    const stubFetch = (async () =>
      new Response(
        JSON.stringify({
          estimation: {
            srcChainTokenIn: { amount: "50000000", approximateUsdValue: 50 },
            dstChainTokenOut: {
              amount: "49229247",
              recommendedAmount: "49229247",
              approximateUsdValue: 49.229247,
            },
          },
          order: { approximateFulfillmentDelay: 1 },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const client = new DeBridgeClient(testConfig(), { fetchImpl: stubFetch });
    const quote = await client.quote("rh", "solana", "50000000");

    assert.equal(quote.amountOut, "49229247");
    assert.ok(Math.abs(quote.costUsd - 0.770753) < 0.0001);
    assert.equal(quote.costBps, 154);
    assert.equal(quote.estimatedSeconds, 1);
  });

  test("surfaces ROUTE_NOT_ENABLED rather than returning a bogus quote", async () => {
    const stubFetch = (async () =>
      new Response(
        JSON.stringify({ errorCode: "ROUTE_NOT_ENABLED", errorMessage: "Route is not enabled." }),
        { status: 400 },
      )) as unknown as typeof fetch;

    const client = new DeBridgeClient(testConfig(), { fetchImpl: stubFetch });
    await assert.rejects(() => client.quote("rh", "solana", "50000000"), /ROUTE_NOT_ENABLED/);
  });

  /** Both legs must quote: bridging out with no way back would strand the sell-back promise. */
  test("health requires both directions", async () => {
    let call = 0;
    const stubFetch = (async () => {
      call += 1;
      if (call === 2) {
        return new Response(JSON.stringify({ errorCode: "ROUTE_NOT_ENABLED" }), { status: 400 });
      }
      return new Response(
        JSON.stringify({
          estimation: {
            srcChainTokenIn: { amount: "50000000", approximateUsdValue: 50 },
            dstChainTokenOut: { amount: "49229247", recommendedAmount: "49229247", approximateUsdValue: 49 },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new DeBridgeClient(testConfig(), { fetchImpl: stubFetch });
    assert.equal(await client.healthy("50000000"), false);
  });

  // ------------------------------------------------------------ execute

  const CREATE_TX = {
    orderId: "0xorder1",
    fixFee: "1000000000000000", // 0.001 ETH
    estimation: { dstChainTokenOut: { amount: "49222670" } },
    tx: { to: "0xdln", data: "0xcafe", value: "1000000000000000" },
  };

  /** Answers create-tx, order-ids and status in one stub. */
  const bridgeStub = (opts: { status?: string; createTx?: unknown } = {}) => {
    const calls: string[] = [];
    const impl = (async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      const body = u.includes("create-tx")
        ? (opts.createTx ?? CREATE_TX)
        : u.includes("order-ids")
          ? { orderIds: ["0xorder1"] }
          : {
              status: opts.status ?? "ClaimedUnlock",
              fulfilledDstEventMetadata: { transactionHash: { stringValue: "solfill" } },
            };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    return { impl, calls };
  };

  const evmSigner = () => {
    const sent: unknown[] = [];
    return { sent, signer: { sendTransaction: async (tx: unknown) => (sent.push(tx), "0xdeposit") } };
  };

  /** Price feed pinned so the cost assertions do not depend on the live market. */
  const pinnedPrice = { nativeToUsd: async () => 1.87, usd: async () => 1874 } as never;

  test("execute sends the EVM tx and reports the fill", async () => {
    const { impl } = bridgeStub();
    const { sent, signer } = evmSigner();
    const client = new DeBridgeClient(testConfig(), { fetchImpl: impl, evm: signer, price: pinnedPrice });

    const res = await client.execute("rh", "solana", "50000000", { amountOut: "49222670" } as never, "order:1");

    assert.equal(res.depositTx, "0xdeposit");
    assert.equal(res.providerOrderId, "0xorder1");
    assert.equal(res.fillTx, "solfill");
    // The fixed fee rides as tx.value, not out of the stablecoin.
    assert.equal((sent[0] as { value: bigint }).value, 1000000000000000n);
  });

  /**
   * The whole point of the cost gate. The stablecoin delta here is only $0.78, well under
   * the abort threshold, but the native fee pushes the true cost over it. Gating on the
   * delta alone was the bug that made the $50 tier look viable when it was not.
   */
  test("execute aborts when the NATIVE fee pushes cost over the limit", async () => {
    const { impl } = bridgeStub();
    const { signer } = evmSigner();
    const cfg = testConfig();
    cfg.bridge.costAbortUsd = 2.0;
    const expensive = { nativeToUsd: async () => 1.87, usd: async () => 1874 } as never;
    const client = new DeBridgeClient(cfg, { fetchImpl: impl, evm: signer, price: expensive });

    await assert.rejects(
      () => client.execute("rh", "solana", "50000000", { amountOut: "49222670" } as never, "order:2"),
      /BridgeCostExceeded|exceed/i,
    );
  });

  /** A crash between send and confirm must never pay twice. */
  test("execute resumes a recorded deposit instead of sending again", async () => {
    const { impl } = bridgeStub();
    const { sent, signer } = evmSigner();
    const store = new Map<string, { depositTx: string; orderId?: string }>([
      ["order:3", { depositTx: "0xalready", orderId: "0xorder1" }],
    ]);
    const client = new DeBridgeClient(testConfig(), {
      fetchImpl: impl,
      evm: signer,
      price: pinnedPrice,
      store: {
        get: async (k: string) => store.get(k) ?? null,
        set: async (k: string, v: { depositTx: string; orderId?: string }) => void store.set(k, v),
      },
    });

    const res = await client.execute("rh", "solana", "50000000", { amountOut: "49222670" } as never, "order:3");

    assert.equal(res.depositTx, "0xalready");
    assert.equal(sent.length, 0, "must not send a second transaction");
  });

  /**
   * The same protection, on the recovery path that has to ASK deBridge which order a recorded
   * tx belongs to. `orderIdForTx` used to swallow every failure and return null, and a null
   * here does not stop execute() — it falls straight through to sending a fresh deposit. So a
   * timeout or a 500 from deBridge, arriving while a deposit was already on chain, would pay
   * twice for one transfer. The lookup must fail loudly instead.
   */
  test("a failed order-id lookup during recovery must not send a second deposit", async () => {
    const { sent, signer } = evmSigner();
    /**
     * Every endpoint except order-ids answers normally, so that IF the guard regresses the
     * fallthrough runs to completion and this test fails on the assertions below. An
     * incomplete stub would leave the poller spinning and the test would hang instead.
     */
    const impl = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("order-ids")) return new Response("upstream is down", { status: 500 });
      const body = u.includes("create-tx")
        ? CREATE_TX
        : {
            status: "ClaimedUnlock",
            fulfilledDstEventMetadata: { transactionHash: { stringValue: "solfill" } },
          };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    // depositTx recorded, orderId absent — what a malformed stored payload leaves behind.
    const store = new Map<string, { depositTx: string; orderId?: string }>([
      ["order:dbl", { depositTx: "0xalready" }],
    ]);
    const client = new DeBridgeClient(testConfig(), {
      fetchImpl: impl,
      evm: signer,
      price: pinnedPrice,
      store: {
        get: async (k: string) => store.get(k) ?? null,
        set: async (k: string, v: { depositTx: string; orderId?: string }) => void store.set(k, v),
      },
    });

    await assert.rejects(
      () => client.execute("rh", "solana", "50000000", { amountOut: "49222670" } as never, "order:dbl"),
      /order-id lookup/,
      "a failed lookup must abort the resume",
    );
    assert.equal(sent.length, 0, "and above all must not have spent again");
  });

  /** The other side of it: a genuine "no order for this tx" still permits a fresh send. */
  test("an affirmative empty order list still allows a new deposit", async () => {
    const { sent, signer } = evmSigner();
    const impl = (async (url: string | URL) => {
      const u = String(url);
      const body = u.includes("create-tx")
        ? CREATE_TX
        : u.includes("order-ids")
          ? { orderIds: [] } // deBridge answering: that tx produced no order
          : {
              status: "ClaimedUnlock",
              fulfilledDstEventMetadata: { transactionHash: { stringValue: "solfill" } },
            };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    const store = new Map<string, { depositTx: string; orderId?: string }>([
      ["order:none", { depositTx: "0xfailed" }],
    ]);
    const client = new DeBridgeClient(testConfig(), {
      fetchImpl: impl,
      evm: signer,
      price: pinnedPrice,
      store: {
        get: async (k: string) => store.get(k) ?? null,
        set: async (k: string, v: { depositTx: string; orderId?: string }) => void store.set(k, v),
      },
    });

    const res = await client.execute("rh", "solana", "50000000", { amountOut: "49222670" } as never, "order:none");

    assert.equal(res.depositTx, "0xdeposit", "a tx that never became an order may be re-sent");
    assert.equal(sent.length, 1);
  });

  test("execute surfaces a cancelled order as a failure", async () => {
    const { impl } = bridgeStub({ status: "OrderCancelled" });
    const { signer } = evmSigner();
    const client = new DeBridgeClient(testConfig(), { fetchImpl: impl, evm: signer, price: pinnedPrice });

    await assert.rejects(
      () => client.execute("rh", "solana", "50000000", { amountOut: "49222670" } as never, "order:4"),
      /OrderCancelled/,
    );
  });

  test("execute refuses to bridge from a chain it has no signer for", async () => {
    const { impl } = bridgeStub();
    const client = new DeBridgeClient(testConfig(), { fetchImpl: impl, price: pinnedPrice });

    await assert.rejects(
      () => client.execute("solana", "rh", "50000000", { amountOut: "49087401" } as never, "order:5"),
      /Solana signer not configured/,
    );
  });
});
