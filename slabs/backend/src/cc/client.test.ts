import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CollectorCryptApi, deriveRateBps, userPayoutUsdg } from "./client.ts";
import { CcApiError, CcAuthRequiredError } from "./types.ts";

/** Builds a fetch stub returning canned responses keyed by URL substring. */
function stubFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, init });
    const key = Object.keys(routes).find((k) => href.includes(k));
    if (!key) return new Response(JSON.stringify({ error: "no stub" }), { status: 404 });
    const route = routes[key]!;
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Real machine shapes, as returned live on 2026-07-18. */
const MACHINES_BODY = {
  machines: [
    {
      code: "pokemon_50",
      price: 50,
      public: true,
      instantBuyback: 85,
      odds: { common: 0.8, uncommon: 0.15, rare: 0.04, epic: 0.01 },
      stock: { common: 1962, uncommon: 1242, rare: 2701, epic: 2139 },
    },
    {
      code: "pokemon_250",
      price: 250,
      public: true,
      instantBuyback: 90,
      odds: { common: 0.75, uncommon: 0.2, rare: 0.04, epic: 0.01 },
      stock: { common: 0, uncommon: 0, rare: 0, epic: 0 },
    },
  ],
};

describe("machines", () => {
  test("parses live machine shape into 6dp base units", async () => {
    const { impl } = stubFetch({ "/machines": { body: MACHINES_BODY } });
    const cc = new CollectorCryptApi({ fetchImpl: impl });

    const m = await cc.machineStatus("pokemon_50");
    assert.equal(m.priceUsdc, "50000000");
    assert.equal(m.instantBuybackPct, 85);
    assert.equal(m.available, true);
    assert.equal(m.packsRemaining, 8044);
  });

  /** Health gating depends on this: an out-of-stock machine must not accept orders. */
  test("zero stock reads as unavailable", async () => {
    const { impl } = stubFetch({ "/machines": { body: MACHINES_BODY } });
    const cc = new CollectorCryptApi({ fetchImpl: impl });

    assert.equal((await cc.machineStatus("pokemon_250")).available, false);
  });

  test("unknown machine throws rather than defaulting", async () => {
    const { impl } = stubFetch({ "/machines": { body: MACHINES_BODY } });
    const cc = new CollectorCryptApi({ fetchImpl: impl });
    await assert.rejects(() => cc.machineStatus("does_not_exist"), /Unknown machine/);
  });
});

describe("purchase flow", () => {
  test("generatePack returns the memo that becomes our order binding", async () => {
    const { impl, calls } = stubFetch({
      "/generatePack": { body: { memo: "cc-abc-123", transaction: "AQID" } },
    });
    const cc = new CollectorCryptApi({ fetchImpl: impl });

    const pack = await cc.generatePack("pokemon_50", "PlayerWallet111");
    assert.equal(pack.memo, "cc-abc-123");
    assert.equal(pack.transactionBase64, "AQID");

    const sent = JSON.parse(String(calls[0]!.init!.body));
    assert.equal(sent.packType, "pokemon_50");
    assert.equal(sent.playerAddress, "PlayerWallet111");
  });

  /** Turbo auto-sells Common pulls — it would destroy the card before we could mirror it. */
  /**
   * Turbo must be opt-in and explicit. A turbo pull that comes out common is auto-sold by CC,
   * so the buyer gets money instead of a card — never something to enable by accident.
   */
  test("turbo is off unless asked for", async () => {
    const { impl, calls } = stubFetch({
      "/generatePack": { body: { memo: "cc-abc", transaction: "AQID" } },
    });
    await new CollectorCryptApi({ fetchImpl: impl }).generatePack("pokemon_50", "W");

    const sent = JSON.parse(String(calls[0]!.init!.body));
    assert.equal(sent.turbo, false, "the default must be a plain open");
  });

  test("turbo is sent when explicitly requested", async () => {
    const { impl, calls } = stubFetch({
      "/generatePack": { body: { memo: "cc-abc", transaction: "AQID" } },
    });
    await new CollectorCryptApi({ fetchImpl: impl }).generatePack("pokemon_50", "W", true);

    const sent = JSON.parse(String(calls[0]!.init!.body));
    assert.equal(sent.turbo, true);
  });

  /**
   * CC signals both machine-level refusals through `details` rather than the status code, and
   * they are choices rather than failures: a low machine can still be opened in turbo, and a
   * rebalancing one just needs a moment. Matching the exact strings from their client.
   */
  test("a low machine raises its own error, carrying whether turbo was already on", async () => {
    const low = { status: 400, body: { details: "Machine is low" } };
    const { impl } = stubFetch({ "/generatePack": low });
    await assert.rejects(
      () => new CollectorCryptApi({ fetchImpl: impl }).generatePack("pokemon_50", "W"),
      (e: Error) => e.name === "CcMachineLowError" && /turbo may still open it/.test(e.message),
    );

    const { impl: impl2 } = stubFetch({ "/generatePack": low });
    await assert.rejects(
      () => new CollectorCryptApi({ fetchImpl: impl2 }).generatePack("pokemon_50", "W", true),
      (e: Error) => e.name === "CcMachineLowError" && /nothing to do but wait/.test(e.message),
    );
  });

  test("a rebalancing machine is distinguished from a low one", async () => {
    const { impl } = stubFetch({
      "/generatePack": { status: 400, body: { details: "Machine is off balance" } },
    });
    await assert.rejects(
      () => new CollectorCryptApi({ fetchImpl: impl }).generatePack("pokemon_50", "W"),
      (e: Error) => e.name === "CcMachineRebalancingError",
    );
  });

  test("openPack returns the revealed mint", async () => {
    const { impl } = stubFetch({
      "/openPack": {
        body: {
          success: true,
          transactionSignature: "sig123",
          nft_address: "MintAddr111",
          roll: 22809791,
          rarity: "Rare",
        },
      },
    });
    const result = await new CollectorCryptApi({ fetchImpl: impl }).openPack("cc-abc");

    assert.equal(result.revealedMint, "MintAddr111");
    assert.equal(result.rarity, "Rare");
    assert.equal(result.openTx, "sig123");
  });

  test("WAITING_FOR_WEBHOOK surfaces as an unresolved reveal, not an error", async () => {
    const { impl } = stubFetch({
      "/openPack": { body: { success: true, code: "WAITING_FOR_WEBHOOK", memo: "cc-abc" } },
    });
    const result = await new CollectorCryptApi({ fetchImpl: impl }).openPack("cc-abc");
    assert.equal(result.revealedMint, null);
  });

  test("awaitReveal polls until the mint appears", async () => {
    let n = 0;
    const impl = (async () => {
      n += 1;
      const body =
        n < 3
          ? { success: true, code: "WAITING_FOR_WEBHOOK" }
          : { success: true, nft_address: "MintAddr111", transactionSignature: "sig", rarity: "Common" };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    const cc = new CollectorCryptApi({ fetchImpl: impl });
    const result = await cc.awaitReveal("cc-abc", { attempts: 5, intervalMs: 1 });

    assert.equal(result.revealedMint, "MintAddr111");
    assert.equal(n, 3);
  });

  /**
   * The pack was paid for. Giving up must NOT look like a refundable failure — the order is
   * must-complete, and the error text has to say so to whoever reads the alert.
   */
  test("exhausted reveal polling flags the order as must-complete", async () => {
    const { impl } = stubFetch({
      "/openPack": { body: { success: true, code: "WAITING_FOR_WEBHOOK" } },
    });
    const cc = new CollectorCryptApi({ fetchImpl: impl });

    await assert.rejects(
      () => cc.awaitReveal("cc-abc", { attempts: 2, intervalMs: 1 }),
      /must-complete and must never be auto-refunded/,
    );
  });

  /** We never request turbo, so this means a machine default sold our card. Do not mint. */
  test("TURBO_MODE_BUYBACK refuses rather than minting against a sold card", async () => {
    const { impl } = stubFetch({
      "/openPack": {
        body: { success: true, code: "TURBO_MODE_BUYBACK", nft_address: "M", buybackAmount: 42, rarity: "Common" },
      },
    });
    await assert.rejects(
      () => new CollectorCryptApi({ fetchImpl: impl }).openPack("cc-abc"),
      /do NOT mint a mirror/,
    );
  });
});

describe("buyback", () => {
  test("parses a live quote in base units", async () => {
    const { impl } = stubFetch({ "/buyback/available": { body: { available: true, amount: 45050000 } } });
    const q = await new CollectorCryptApi({ fetchImpl: impl }).getBuybackQuote("MintX", "WalletY");

    assert.equal(q.available, true);
    assert.equal(q.proceedsUsdc, "45050000");
  });

  test("unavailable quote yields zero, not a throw", async () => {
    const { impl } = stubFetch({ "/buyback/available": { body: { available: false } } });
    const q = await new CollectorCryptApi({ fetchImpl: impl }).getBuybackQuote("MintX", "WalletY");

    assert.equal(q.available, false);
    assert.equal(q.proceedsUsdc, "0");
  });
});

describe("payout maths (doc 00 §6 rule 2)", () => {
  /** The real observed card: $53 insured, CC pays $45.05 = exactly 85%. */
  test("derives CC's rate from the live quote", () => {
    assert.equal(deriveRateBps("45050000", "53000000"), 8500);
  });

  test("user receives CC's live rate minus the 5pp spread", () => {
    const payout = userPayoutUsdg("45050000", "53000000", 500);
    // 85% - 5pp = 80% of $53 = $42.40
    assert.equal(payout, "42400000");
  });

  test("spread is taken off the LIVE rate, so a lower CC quote lowers the payout", () => {
    // CC drops to 80%: user must get 75%, not the 80% they'd have had before.
    const payout = userPayoutUsdg("42400000", "53000000", 500);
    assert.equal(payout, "39750000"); // 75% of $53
  });

  /**
   * Structural guarantee: we can never pay out more than CC pays us, whatever the inputs.
   * This is the invariant doc 00 §2 demands, enforced in code rather than by policy.
   */
  test("payout can never exceed CC's proceeds, across the whole input space", () => {
    // Pathological cases: insured value wildly out of step with actual proceeds, zero
    // spread, tiny amounts. The invariant must hold for all of them.
    const cases: [string, string, number][] = [
      ["1000000", "53000000", 0], // proceeds far below insured value
      ["45050000", "53000000", 0], // normal card, no spread
      ["53000000", "53000000", 0], // CC pays 100%
      ["99000000", "53000000", 0], // CC pays above insured value
      ["1", "1", 0], // dust
      ["0", "53000000", 500], // CC pays nothing
    ];

    for (const [proceeds, insured, spread] of cases) {
      const payout = BigInt(userPayoutUsdg(proceeds, insured, spread));
      assert.ok(
        payout <= BigInt(proceeds),
        `payout ${payout} exceeded CC proceeds ${proceeds} (insured=${insured}, spread=${spread})`,
      );
    }
  });

  test("a spread wider than CC's rate floors at zero rather than going negative", () => {
    assert.equal(userPayoutUsdg("45050000", "53000000", 9000), "0");
  });
});

describe("API-key enforcement", () => {
  /**
   * The known dependency risk: CC's docs describe a gate the endpoints do not enforce. If
   * that changes, every pack open dies at once — the error must say so unmistakably.
   */
  test("401 without a key raises the distinct auth error", async () => {
    const { impl } = stubFetch({ "/generatePack": { status: 401, body: { error: "unauthorized" } } });
    const cc = new CollectorCryptApi({ fetchImpl: impl });

    await assert.rejects(
      () => cc.generatePack("pokemon_50", "W"),
      (err: Error) => {
        assert.ok(err instanceof CcAuthRequiredError);
        assert.match(err.message, /Every pack open is down/);
        return true;
      },
    );
  });

  test("sends the key when configured", async () => {
    const { impl, calls } = stubFetch({ "/generatePack": { body: { memo: "m", transaction: "t" } } });
    await new CollectorCryptApi({ fetchImpl: impl, apiKey: "partner-key" }).generatePack("pokemon_50", "W");

    const headers = calls[0]!.init!.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "partner-key");
  });

  test("503 too-many-open-packs is retryable; 400 is not", async () => {
    const busy = stubFetch({ "/generatePack": { status: 503, body: { error: "too many open packs" } } });
    await assert.rejects(
      () => new CollectorCryptApi({ fetchImpl: busy.impl }).generatePack("pokemon_50", "W"),
      (err: Error) => (err as CcApiError).retryable === true,
    );

    const bad = stubFetch({ "/generatePack": { status: 400, body: { error: "invalid address" } } });
    await assert.rejects(
      () => new CollectorCryptApi({ fetchImpl: bad.impl }).generatePack("pokemon_50", "W"),
      (err: Error) => (err as CcApiError).retryable === false,
    );
  });
});

describe("metadata", () => {
  test("extracts insured value, grade and cert from the verifier record", async () => {
    const { impl } = stubFetch({
      "/vrf/verify": {
        body: {
          wallet: "W",
          nftAddress: "MintAddr111",
          nftMetadata: {
            nft_standard: "core",
            content: {
              links: { image: "https://arweave.net/img" },
              metadata: {
                name: "2023 #32 Cole Palmer PSA 9 Panini Select Premier League",
                insuredValue: 108,
                attributes: [{ trait_type: "Collector Crypt ID", value: "2026070730C179885" }],
              },
            },
          },
        },
      },
    });

    const meta = await new CollectorCryptApi({ fetchImpl: impl }).fetchCardMetaByMemo("cc-abc");
    assert.equal(meta.insuredValueUsd, "108000000");
    assert.equal(meta.grade, "PSA 9");
    assert.equal(meta.certNumber, "2026070730C179885");
    assert.equal(meta.solanaMint, "MintAddr111");
  });

  test("missing insured value yields null rather than a bogus zero", async () => {
    const { impl } = stubFetch({
      "/vrf/verify": { body: { nftAddress: "M", nftMetadata: { content: { metadata: { name: "x" } } } } },
    });
    const meta = await new CollectorCryptApi({ fetchImpl: impl }).fetchCardMetaByMemo("cc-abc");
    assert.equal(meta.insuredValueUsd, null);
  });
});
