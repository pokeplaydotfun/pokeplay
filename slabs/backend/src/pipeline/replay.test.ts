import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Db } from "../db/index.ts";
import { tierFromBands } from "./fulfill.ts";
import { userPayoutUsdg } from "../cc/client.ts";

/**
 * A real Collector Crypt pack, replayed offline.
 *
 * Captured from memo cc-0f14c173-c10b-4ae9-89d2-cd3645015968 — a $250 pack that really
 * happened, whose buyback CC actually paid at $135.90. Everything downstream of the reveal
 * can be checked against it without spending anything, and the fixture pins the real shape
 * of CC's metadata so a change in our parsing shows up here rather than on someone's card.
 *
 * Deliberately a fixture rather than a live call: a test that needs the network is a test
 * that fails for reasons unrelated to the code.
 */
const META = JSON.parse(
  readFileSync(new URL("../fixtures/real-pack-replay.json", import.meta.url), "utf8"),
) as {
  solanaMint: string;
  certNumber: string;
  grade: string;
  name: string;
  imageUrl: string;
  imageBackUrl: string;
  insuredValueUsd: string;
};

/** pokemon_250's published bands, as CC serves them. */
const BANDS_250 = {
  common: { start: 150, end: 250 },
  uncommon: { start: 250, end: 400 },
  rare: { start: 400, end: 2000 },
  epic: { start: 2000, end: 50000 },
};

/** The $50 machine's bands, for the cross-machine comparison below. */
const BANDS_50 = {
  common: { start: 30, end: 60 },
  uncommon: { start: 60, end: 110 },
  rare: { start: 110, end: 250 },
  epic: { start: 250, end: 5001 },
};

describe("a real pack, replayed", () => {
  test("CC's metadata still parses into every field we store", () => {
    assert.equal(META.solanaMint, "98Q7sJx4Qk8ntcaMbph74Uj4PpC8DuhN1E8XMiGCMetG");
    assert.equal(META.grade, "PSA 10");
    assert.equal(META.certNumber, "2025100957C59229");
    assert.equal(META.insuredValueUsd, "151000000");
    assert.ok(META.imageUrl.startsWith("https://"), "front image");
    assert.ok(META.imageBackUrl.startsWith("https://"), "slab back — dropped before 19 Jul");
    assert.notEqual(META.imageUrl, META.imageBackUrl, "front and back are different images");
  });

  test("the tier is the machine's, not the value's", () => {
    const usd = Number(META.insuredValueUsd) / 1e6;
    // $151 is the bottom of the 250's common band, and well into the 50's rare band. Same
    // card, same money, different tier — which is why tier is stored at reveal time.
    assert.equal(tierFromBands(usd, BANDS_250), "common");
    assert.equal(tierFromBands(usd, BANDS_50), "rare");
  });

  test("our payout maths reproduces the buyback CC actually paid", () => {
    // CC paid $135.90 on this card. That is 90% of $151, the 250's instantBuyback rate, so a
    // matching figure confirms our understanding of how CC prices a sell-back.
    const ccProceeds = "135900000";
    const derivedRateBps = Number((BigInt(ccProceeds) * 10_000n) / BigInt(META.insuredValueUsd));
    assert.equal(derivedRateBps, 9000, "CC paid exactly 90% of insured value");

    // Ours is that rate less the 5pp spread.
    const payout = userPayoutUsdg(ccProceeds, META.insuredValueUsd, 500);
    assert.equal(payout, "128350000", "a seller receives $128.35");
    assert.ok(
      BigInt(payout) < BigInt(ccProceeds),
      "we can never pay out more than CC pays us",
    );
  });

  test("it round-trips through the database with nothing lost", () => {
    const db = new Db(":memory:");
    const now = Date.now();
    db.insertOrder({ id: 9001, buyer: "0xBuyer", machineId: "pokemon_250", priceUsdg: "250000000", rhPayTx: null, deadlineAt: now + 600_000 });
    db.insertCard({
      solanaMint: META.solanaMint, orderId: 9001, certNumber: META.certNumber, grade: META.grade,
      name: META.name, imageUrl: META.imageUrl, imageBackUrl: META.imageBackUrl,
      tier: tierFromBands(Number(META.insuredValueUsd) / 1e6, BANDS_250),
      insuredValueUsd: META.insuredValueUsd, revealAt: now,
      ccWindowEndsAt: now + 72 * 3600_000, userWindowEndsAt: now + 66 * 3600_000,
      ownerMirrorTokenId: "9001",
    });

    const row = db.raw.prepare(`SELECT * FROM cards WHERE solana_mint = ?`).get(META.solanaMint) as Record<string, unknown>;
    assert.equal(row.image_url, META.imageUrl);
    assert.equal(row.image_back_url, META.imageBackUrl);
    assert.equal(row.tier, "common");
    assert.equal(row.insured_value_usd, "151000000");
    assert.equal(row.grade, "PSA 10");
  });
});
