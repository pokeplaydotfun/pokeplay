import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../db/index.ts";
import { MockCollectorCrypt } from "../cc/mock.ts";
import { BuybackPipeline } from "./buyback.ts";
import type { BuybackChain, SellSigner, ProceedsBridge } from "./buyback.ts";
import type { Config } from "../config.ts";

const OPERATOR = "0xOperatorCustody";
/** Mutable so a test can move the card out of custody mid-scenario. */
/**
 * The SOLANA custody wallet, matching cfg.solana.operatorAddress — NOT the EVM operator.
 *
 * This fixture used to hold OPERATOR, the Robinhood Chain address, which is what
 * `cardOwner` was mistakenly compared against in the pipeline. The fixture agreed with the
 * bug, so every test passed while production concluded "CC took the card" about a card
 * sitting in its own custody. A stub that mirrors the mistake proves nothing.
 */
const SOLANA_CUSTODY = "CARD7cmGjygGCSkrbXdxBN8Zr9Zd1fN1mjZdvSLqHuaN";
const cardOwnerRef: { value: string | null } = { value: SOLANA_CUSTODY };
const SELLER = "0xSeller";
const TOKEN = "7";
const MINT = "MintAbc123";
const INSURED = "100000000"; // $100, 6dp

/**
 * What the pipeline will actually pay at sale time, in USDG.
 *
 * Note this is NOT `INSURED` times the user rate. The mock's own card meta carries a different
 * insured value ($45.06) to the row we write here, so CC's proceeds are $38.297971 while the
 * rate is derived against our $100 — 3829bps, less the 500bps spread, times $100 = $33.29.
 * The mismatch is the point: it is the same shape as CC disagreeing with our stored value.
 */
const FRESH_PAYOUT = 33_290_000n;

function testConfig(): Config {
  return {
    bridge: { costAlertUsd: 2, costAbortUsd: 5, rhChainId: 4663, solanaChainId: 7565164, apiUrl: "", provider: "mock", fillTimeoutMs: 1000 },
    economics: { spreadBps: 500, userWindowHours: 66, ccWindowHours: 72, unwrapFeeDuringWindowBps: 0, quoteTtlSec: 60, quoteDriftRevalidateBps: 25 },
    limits: { maxPackPriceUsdg: 55, orderTimeoutMin: 10 },
    rh: { usdgAddress: "0xusdg" },
    // A real base58-shaped address, not the EVM OPERATOR above. The two are different on
    // purpose: the sell-back hands this one to Collector Crypt and the EVM one to the mirror
    // contract, and passing either where the other belongs is the bug this guards.
    solana: { usdcMint: "usdc", operatorAddress: "CARD7cmGjygGCSkrbXdxBN8Zr9Zd1fN1mjZdvSLqHuaN" },
  } as unknown as Config;
}

class StubChain implements BuybackChain {
  readonly operatorAddress = OPERATOR;
  owner = OPERATOR;
  balance = 1_000_000_000n;
  returned: { to: string; tokenId: string }[] = [];
  paid: { to: string; amount: bigint }[] = [];
  burned: string[] = [];
  failPay = 0;
  failBurn = false;
  failReturn = false;
  /**
   * Broadcast the transfer, then throw as a receipt-wait timeout does.
   *
   * This is the exact shape of the double-pay bug: the money HAS left, but the old code only
   * recorded the hash after the receipt resolved, so the failure looked like "nothing sent".
   */
  timeoutAfterBroadcast = false;
  succeeded = new Set<string>();

  async mirrorOwnerOf(tokenId: bigint) {
    if (this.owner === "") throw new Error(`token ${tokenId} does not exist`);
    return this.owner;
  }
  async returnMirror(to: string, tokenId: bigint) {
    if (this.failReturn) throw new Error("return reverted");
    this.returned.push({ to, tokenId: tokenId.toString() });
    this.owner = to;
    return `0xreturn${this.returned.length}`;
  }
  async payUsdg(to: string, amount: bigint, onSent?: (txHash: string) => void) {
    if (this.failPay-- > 0) throw new Error("payout reverted");
    this.paid.push({ to, amount });
    const hash = `0xpay${this.paid.length}`;
    onSent?.(hash);
    if (this.timeoutAfterBroadcast) {
      // The transfer landed; only our confirmation did not.
      this.succeeded.add(hash);
      throw new Error("waitForTransactionReceipt timed out");
    }
    this.succeeded.add(hash);
    return hash;
  }
  /** Hashes the chain cannot answer for: still pending, or the RPC is down. */
  unknown = new Set<string>();
  /** Hashes with a receipt showing a revert. */
  reverted = new Set<string>();
  async txSucceeded(txHash: string): Promise<boolean | null> {
    if (this.unknown.has(txHash)) return null;
    if (this.reverted.has(txHash)) return false;
    return this.succeeded.has(txHash);
  }
  async usdgBalance() {
    return this.balance;
  }
  async burnAfterSell(tokenId: bigint) {
    if (this.failBurn) throw new Error("burn reverted");
    this.burned.push(tokenId.toString());
    return `0xburn${this.burned.length}`;
  }
}

class StubSigner implements SellSigner {
  submitted: string[] = [];
  fail = false;
  /** The card LEFT, but the response never came back. The dangerous case. */
  throwAfterSubmit = false;
  async signAndSubmit(tx: string) {
    if (this.fail) throw new Error("solana submit failed");
    this.submitted.push(tx);
    if (this.throwAfterSubmit) throw new Error("network timeout after submit");
    return `ccsig${this.submitted.length}`;
  }
}

class StubBridge implements ProceedsBridge {
  calls: { amountUsdc: string; reference: string }[] = [];
  fail = false;
  async toRhChain(p: { amountUsdc: string; reference: string }) {
    if (this.fail) throw new Error("bridge unavailable");
    this.calls.push(p);
    return { orderId: `br${this.calls.length}`, txs: ["0xdep", "0xfill"] };
  }
}

type Harness = {
  db: Db;
  cc: MockCollectorCrypt;
  chain: StubChain;
  signer: StubSigner;
  bridge: StubBridge;
  pipeline: BuybackPipeline;
  alerts: string[];
};

function harness(): Harness {
  const db = new Db(":memory:");
  const cc = new MockCollectorCrypt();
  const chain = new StubChain();
  const signer = new StubSigner();
  const bridge = new StubBridge();
  const alerts: string[] = [];

  // The card must exist for setCardState to have something to move.
  const now = Date.now();
  db.insertOrder({
    id: 1, buyer: SELLER, machineId: "pokemon_50", priceUsdg: "53000000",
    rhPayTx: null, deadlineAt: now + 600_000,
  });
  db.insertCard({
    solanaMint: MINT, orderId: 1, certNumber: "1", grade: "PSA 10", name: "Card",
    imageUrl: null, insuredValueUsd: INSURED, revealAt: now,
    ccWindowEndsAt: now + 72 * 3600_000, userWindowEndsAt: now + 66 * 3600_000,
    ownerMirrorTokenId: TOKEN,
  });

  const pipeline = new BuybackPipeline({
    db, cc, chain, signer, bridge, cfg: testConfig(),
    /**
     * The card is still in our custody unless a test says otherwise. That is the truth in
     * every ordinary failure: the submit did not reach Collector Crypt, so nothing moved.
     * Tests that model a LOST RESPONSE override this to show the card has left.
     */
    cardOwner: async () => cardOwnerRef.value,
    alert: (m) => alerts.push(m),
  });

  return { db, cc, chain, signer, bridge, pipeline, alerts };
}

/** Quote the mock offers, run through our own spread maths. */
async function openBuyback(h: Harness, overrides: Partial<{ quotedUsdg: string }> = {}): Promise<number> {
  const quote = await h.cc.getBuybackQuote(MINT, SOLANA_CUSTODY);
  const ccRateBps = Number((BigInt(quote.proceedsUsdc) * 10_000n) / BigInt(INSURED));
  return h.db.insertBuyback({
    mirrorTokenId: TOKEN,
    solanaMint: MINT,
    seller: SELLER,
    ccQuoteBps: ccRateBps,
    quotedUserRateBps: ccRateBps - 500,
    quotedUsdg: overrides.quotedUsdg ?? ((BigInt(INSURED) * BigInt(ccRateBps - 500)) / 10_000n).toString(),
    insuredValueUsd: INSURED,
    expiresAt: Date.now() + 60_000,
  });
}

describe("the happy path", () => {
  let h: Harness;
  beforeEach(() => { cardOwnerRef.value = SOLANA_CUSTODY; h = harness(); });

  test("sells, bridges, pays, then burns — in that order", async () => {
    const id = await openBuyback(h);
    await h.pipeline.process(id);

    const b = h.db.getBuyback(id)!;
    assert.equal(b.status, "PAID");
    assert.ok(b.cc_sell_tx, "card was sold to CC");
    assert.ok(b.bridge_order_id, "proceeds were bridged");
    assert.ok(b.payout_tx, "seller was paid");
    assert.ok(b.burn_tx, "mirror was burned");

    assert.equal(h.chain.paid.length, 1);
    assert.equal(h.chain.paid[0]!.to, SELLER);
    assert.equal(h.chain.burned.length, 1);
    const card = h.db.raw.prepare(`SELECT state FROM cards WHERE solana_mint = ?`).get(MINT) as { state: string };
    assert.equal(card.state, "SOLD_TO_CC");
  });

  test("bridges the full CC proceeds, not just the seller's share", async () => {
    const id = await openBuyback(h);
    await h.pipeline.process(id);

    const b = h.db.getBuyback(id)!;

    assert.equal(b.status, "PAID");
    assert.ok(b.cc_proceeds_usdc, "what CC actually paid is recorded at sale time");
    assert.equal(h.bridge.calls.length, 1);
    assert.equal(
      h.bridge.calls[0]!.amountUsdc, b.cc_proceeds_usdc,
      "the spread has to reach the payout chain too, and the bridge fee comes out of this",
    );
    assert.ok(
      BigInt(h.bridge.calls[0]!.amountUsdc) > BigInt(b.quoted_usdg),
      "bridging only the payout would arrive short",
    );
  });

  test("the bridge reference is stable so a retry rejoins rather than sending twice", async () => {
    const id = await openBuyback(h);
    h.chain.failPay = 1;
    await h.pipeline.process(id);
    await h.pipeline.process(id);

    assert.equal(h.bridge.calls.length, 1, "bridged once across the payout retry");
    assert.equal(h.bridge.calls[0]!.reference, `buyback-${id}`);
  });

  test("the seller is paid before the mirror is burned, never after", async () => {
    const id = await openBuyback(h);
    h.chain.failBurn = true;
    await h.pipeline.process(id);

    // Burn failed, but the money moved. The seller is whole; we carry the loss.
    assert.equal(h.chain.paid.length, 1, "payout still happened");
    assert.equal(h.chain.burned.length, 0);
    const b = h.db.getBuyback(id)!;
    assert.ok(b.payout_tx, "payout is recorded so a retry does not double-pay");
  });
});

describe("the custody guard — the reason this pipeline holds the mirror", () => {
  let h: Harness;
  beforeEach(() => { cardOwnerRef.value = SOLANA_CUSTODY; h = harness(); });

  test("refuses to sell a card whose mirror we do not hold", async () => {
    const id = await openBuyback(h);
    h.chain.owner = "0xSomeoneElse"; // never escrowed, or escrowed then moved

    await h.pipeline.process(id);

    assert.equal(h.signer.submitted.length, 0, "CC sale must not happen");
    const b = h.db.getBuyback(id)!;
    assert.equal(b.status, "FAILED");
    assert.match(b.last_error!, /not the operator/);
  });

  test("will not burn a token that is no longer ours, even after paying", async () => {
    const id = await openBuyback(h);
    // Sell and bridge normally, then have the token leave our custody before the burn.
    await h.pipeline.process(id);
    assert.equal(h.chain.burned.length, 1);

    // Re-run the same scenario with custody lost between payout and burn.
    const h2 = harness();
    const id2 = await openBuyback(h2);
    const chain = h2.chain;
    const realPay = chain.payUsdg.bind(chain);
    chain.payUsdg = async (to: string, amount: bigint) => {
      const tx = await realPay(to, amount);
      chain.owner = "0xThirdParty"; // token slips away right after payment
      return tx;
    };

    await h2.pipeline.process(id2);

    assert.equal(h2.chain.burned.length, 0, "must not burn a third party's token");
    assert.equal(h2.db.getBuyback(id2)!.status, "PAID");
    assert.ok(
      h2.alerts.some((a) => /NOT burning/.test(a)),
      "an unexpected holder must raise an alert, not be burned through",
    );
  });

  test("one token cannot have two buybacks in flight", async () => {
    await openBuyback(h);
    await assert.rejects(() => openBuyback(h), /already in flight/);
  });
});

describe("failures before the card is sold are fully reversible", () => {
  let h: Harness;
  beforeEach(() => { cardOwnerRef.value = SOLANA_CUSTODY; h = harness(); });

  test("a failed CC sale returns the mirror and owes nothing", async () => {
    const id = await openBuyback(h);
    h.signer.fail = true;

    await h.pipeline.process(id);

    const b = h.db.getBuyback(id)!;
    assert.equal(b.status, "FAILED");
    assert.equal(h.chain.paid.length, 0, "nothing paid");
    assert.equal(h.chain.returned.length, 1, "mirror handed back");
    assert.equal(h.chain.returned[0]!.to, SELLER);
    assert.match(b.last_error!, /mirror returned/);
  });

  test("a quote that moved against the seller aborts rather than executing", async () => {
    // Promise far more than CC will now pay: a stale quote the seller accepted earlier.
    const id = await openBuyback(h, { quotedUsdg: "99000000" });

    await h.pipeline.process(id);

    assert.equal(h.signer.submitted.length, 0, "card must not be sold at the worse rate");
    const b = h.db.getBuyback(id)!;
    assert.equal(b.status, "FAILED");
    assert.match(b.last_error!, /re-quote required/);
    assert.equal(h.chain.returned.length, 1, "mirror handed back");
  });

  test("drift in the seller's favour goes to the seller, not to us", async () => {
    // Promise far less than CC pays. The old behaviour paid the promise and kept the rest;
    // that is exactly what made quote pinning profitable, so it now reprices upward.
    const id = await openBuyback(h, { quotedUsdg: "1000000" });

    await h.pipeline.process(id);

    const b = h.db.getBuyback(id)!;
    assert.equal(b.status, "PAID");
    assert.equal(h.chain.paid[0]!.amount, FRESH_PAYOUT, "paid the real price, not the stale one");
    assert.equal(b.quoted_usdg, FRESH_PAYOUT.toString(), "the row records what was actually paid");
  });

  test("a stranger cannot pin a seller to a worse price", async () => {
    // The griefing shape: matchableQuoteFor takes the most recent quote on a token no matter
    // who asked for it, and `requester` is unverified, so an attacker can bind a seller's
    // deposit to a quote taken at a bad moment. Here that quote pays $1 for an $80 card.
    const pinned = await openBuyback(h, { quotedUsdg: "1000000" });

    await h.pipeline.process(pinned);

    assert.equal(
      h.chain.paid[0]!.amount, FRESH_PAYOUT,
      "the pinned quote must not decide what the seller is paid",
    );
  });

  test("a quote better than the market is still honoured at the promised price", async () => {
    // Repricing is one-way. Drift against the seller inside tolerance is absorbed by us, so a
    // seller never receives less than they agreed to — this is the other half of that promise.
    const generous = (FRESH_PAYOUT + (FRESH_PAYOUT * 20n) / 10_000n).toString(); // +20bps, under 25
    const id = await openBuyback(h, { quotedUsdg: generous });

    await h.pipeline.process(id);

    const b = h.db.getBuyback(id)!;
    assert.equal(b.status, "PAID");
    assert.equal(h.chain.paid[0]!.amount, BigInt(generous), "never repriced downward");
  });

  test("a failed return hands the deposit back to the sweeper rather than orphaning it", async () => {
    // The deposit must exist for the coupling to be observable.
    h.db.recordEscrowDeposit(TOKEN, SELLER);
    const id = await openBuyback(h);
    h.db.linkEscrowToBuyback(TOKEN, id);

    h.signer.fail = true;
    h.chain.failReturn = true;
    await h.pipeline.process(id);

    assert.equal(h.db.getBuyback(id)!.status, "FAILED");
    const deposit = h.db.getEscrowDeposit(TOKEN)!;
    assert.equal(deposit.returned_tx, null, "still owed");
    assert.equal(
      deposit.buyback_id, null,
      "unlinked, so unresolvedEscrowDeposits picks it up — otherwise the card is forgotten",
    );
    assert.equal(h.db.unresolvedEscrowDeposits().length, 1);
  });

  test("a successful return closes the deposit", async () => {
    h.db.recordEscrowDeposit(TOKEN, SELLER);
    const id = await openBuyback(h);
    h.db.linkEscrowToBuyback(TOKEN, id);

    h.signer.fail = true;
    await h.pipeline.process(id);

    assert.ok(h.db.getEscrowDeposit(TOKEN)!.returned_tx, "deposit resolved");
    assert.equal(h.db.unresolvedEscrowDeposits().length, 0);
  });

  test("a completed buyback closes the deposit so the sweeper never asks about a burned token", async () => {
    h.db.recordEscrowDeposit(TOKEN, SELLER);
    const id = await openBuyback(h);
    h.db.linkEscrowToBuyback(TOKEN, id);

    await h.pipeline.process(id);

    assert.equal(h.db.getBuyback(id)!.status, "PAID");
    assert.ok(h.db.getEscrowDeposit(TOKEN)!.returned_tx, "resolved by the burn");
    assert.equal(h.db.unresolvedEscrowDeposits().length, 0);
  });

  test("if the mirror cannot be returned, that is alerted rather than swallowed", async () => {
    const id = await openBuyback(h);
    h.signer.fail = true;
    h.chain.failReturn = true;

    await h.pipeline.process(id);

    assert.equal(h.db.getBuyback(id)!.status, "FAILED");
    assert.ok(
      h.alerts.some((a) => /could NOT be returned/.test(a)),
      "a seller left holding nothing must be surfaced",
    );
  });
});

describe("after the card is sold, the buyback must complete", () => {
  let h: Harness;
  beforeEach(() => { cardOwnerRef.value = SOLANA_CUSTODY; h = harness(); });

  test("a bridge outage keeps the buyback alive and alerts", async () => {
    const id = await openBuyback(h);
    h.bridge.fail = true;

    await h.pipeline.process(id);

    const b = h.db.getBuyback(id)!;
    assert.equal(b.status, "CC_SOLD", "stays put so the next tick retries");
    assert.notEqual(b.status, "FAILED", "never abandons a seller whose card is gone");
    assert.equal(h.chain.returned.length, 0, "the card is sold; there is no mirror to return");
    assert.ok(h.alerts.some((a) => /CARD ALREADY SOLD/.test(a)));
  });

  test("a failed payout retries and eventually pays", async () => {
    const id = await openBuyback(h);
    h.chain.failPay = 1;

    await h.pipeline.process(id); // sells, bridges, payout throws
    assert.equal(h.db.getBuyback(id)!.status, "BRIDGED");
    assert.ok(h.alerts.some((a) => /must-complete/.test(a)));

    await h.pipeline.process(id); // retry
    const b = h.db.getBuyback(id)!;
    assert.equal(b.status, "PAID");
    assert.equal(h.chain.paid.length, 1, "paid exactly once across the retry");
  });

  test("a resumed payout does not pay twice", async () => {
    const id = await openBuyback(h);
    h.chain.failBurn = true;
    await h.pipeline.process(id); // pays, then burn fails

    h.chain.failBurn = false;
    await h.pipeline.process(id); // resume

    assert.equal(h.chain.paid.length, 1, "payout is not repeated on resume");
    assert.equal(h.db.getBuyback(id)!.status, "PAID");
  });

  /**
   * The double-pay window, closed 19 Jul 2026.
   *
   * `payUsdg` broadcasts and then waits up to 120s for a receipt. The old code wrote
   * `payout_tx` only after that wait returned, so a receipt TIMEOUT on a transfer that had
   * already landed left no record at all, and the next tick paid the seller a second time.
   * The existing "resumed payout" test above could not catch it: it fails the BURN, after the
   * payout row was written successfully.
   */
  test("a receipt timeout on a landed transfer never pays twice", async () => {
    const id = await openBuyback(h);
    h.chain.timeoutAfterBroadcast = true;

    await h.pipeline.process(id); // broadcasts, then the receipt wait times out
    assert.equal(h.chain.paid.length, 1, "the money has left exactly once");
    assert.equal(h.db.getBuyback(id)!.payout_tx, null, "and we never confirmed it");

    // The retry must recognise the landed transfer rather than re-sending it.
    h.chain.timeoutAfterBroadcast = false;
    await h.pipeline.process(id);

    assert.equal(h.chain.paid.length, 1, "MUST NOT pay the seller a second time");
    assert.equal(h.db.getBuyback(id)!.payout_tx, "0xpay1", "reconciled to the landed tx");
  });

  test("a send refused before broadcast stays a plain retry, not an incident", async () => {
    // The opposite case, and it needs the opposite response. Nothing left the wallet, so the
    // claim must be released rather than demanding a human inspect the treasury.
    const id = await openBuyback(h);
    h.chain.failPay = 1; // throws BEFORE the broadcast callback fires

    await h.pipeline.process(id);
    assert.equal(h.chain.paid.length, 0, "nothing was sent");

    await h.pipeline.process(id);
    assert.equal(h.chain.paid.length, 1, "the retry pays cleanly, with no manual step");
    assert.equal(h.db.getBuyback(id)!.status, "PAID");
  });

  /**
   * THE CARD-LOSS WINDOW, closed 20 Jul.
   *
   * `signAndSubmit` reaches Collector Crypt and then loses its response. `cc_sell_tx` stays
   * null, so local state reads "never sold" — and abandoning returns the mirror to a seller
   * whose physical card CC now owns. They keep a token backed by nothing.
   *
   * Local columns cannot resolve this; the chain can, because a completed sale moves the card
   * out of our custody wallet.
   */
  test("a lost response after the card is sold never returns the mirror", async () => {
    const id = await openBuyback(h);
    h.signer.throwAfterSubmit = true;
    cardOwnerRef.value = "CollectorCryptVault111"; // CC took it

    await h.pipeline.process(id);

    assert.equal(h.signer.submitted.length, 1, "the card left exactly once");
    assert.equal(h.chain.returned.length, 0, "the mirror MUST NOT go back");
    assert.ok(h.alerts.some((a) => /LEFT our custody/.test(a)));
  });

  test("a submit that never reached CC still returns the mirror", async () => {
    // The opposite case, and it needs the opposite answer. The card is still ours, so the
    // sale genuinely did not happen and the seller should get their mirror back.
    const id = await openBuyback(h);
    h.signer.throwAfterSubmit = true;
    cardOwnerRef.value = SOLANA_CUSTODY; // never moved

    await h.pipeline.process(id);

    assert.deepEqual(h.chain.returned.map((r) => r.to), [SELLER], "mirror returned");
  });

  test("an unreadable owner refuses to guess in either direction", async () => {
    // A DAS outage must not be read as "the card is still ours". Keeping the mirror is the
    // safe side: it can always be returned later, but it cannot be un-returned.
    const id = await openBuyback(h);
    h.signer.throwAfterSubmit = true;
    cardOwnerRef.value = null;

    await h.pipeline.process(id);

    assert.equal(h.chain.returned.length, 0, "must not hand back on a guess");
    assert.ok(h.alerts.some((a) => /cannot read who owns/.test(a)));
  });

  test("an underfunded treasury refuses to pay rather than half-paying", async () => {
    const id = await openBuyback(h);
    h.chain.balance = 1n;

    await h.pipeline.process(id);

    assert.equal(h.chain.paid.length, 0);
    assert.equal(h.db.getBuyback(id)!.status, "BRIDGED", "stays owed, to be retried");
    assert.ok(h.alerts.some((a) => /must-complete/.test(a)));
  });
});

describe("restart behaviour", () => {
  test("resumeAll drives every unfinished buyback and leaves terminal ones alone", async () => {
    const h = harness();
    const id = await openBuyback(h);
    h.bridge.fail = true;
    await h.pipeline.process(id);
    assert.equal(h.db.getBuyback(id)!.status, "CC_SOLD");

    h.bridge.fail = false;
    await h.pipeline.resumeAll();
    assert.equal(h.db.getBuyback(id)!.status, "PAID");

    const before = h.chain.paid.length;
    await h.pipeline.resumeAll();
    assert.equal(h.chain.paid.length, before, "a PAID buyback is not touched again");
  });
});

describe("cross-chain addressing", () => {
  /**
   * The first live sell-back failed here.
   *
   * `buildBuyback` is the only Collector Crypt call whose wallet argument comes from the EVM
   * side of the app, and it was handed `chain.operatorAddress` — the Robinhood Chain address
   * that every other line in the pipeline correctly uses for mirror ownership. CC answered
   * `400 {"error":"Invalid altRecipient address"}`, naming a field we do not send, so it read
   * as a missing parameter rather than a wrong one.
   *
   * Nothing caught it: the mock ignored the argument entirely, so 289 passing tests said
   * nothing about which chain's address was travelling. The mock now rejects an EVM address
   * the way the real API does, and this test states the requirement directly.
   */
  test("sells to CC with the SOLANA wallet, never the EVM operator address", async () => {
    const h = harness();
    const id = await openBuyback(h);
    await h.pipeline.process(id);

    assert.equal(h.db.getBuyback(id)!.status, "PAID", "the sale must complete");
    assert.ok(
      h.cc.lastBuybackPlayer,
      "the pipeline must have called buildBuyback",
    );
    assert.equal(
      h.cc.lastBuybackPlayer,
      "CARD7cmGjygGCSkrbXdxBN8Zr9Zd1fN1mjZdvSLqHuaN",
      "CC must receive the Solana custody wallet that actually holds the card",
    );
    assert.ok(
      !h.cc.lastBuybackPlayer!.startsWith("0x"),
      "an EVM address here is the bug that broke the first live sell-back",
    );
  });
});

describe("deciding whether CC actually took the card", () => {
  /**
   * Buyback 4 alerted, in production: "the card has LEFT our custody (now CARD7cm…HuaN).
   * CC took it." CARD7cm…HuaN IS our custody wallet.
   *
   * `cardOwner` returns a SOLANA owner and it was compared against `chain.operatorAddress`,
   * the Robinhood Chain address. Those can never be equal, so the branch always fired: any
   * sell failure after the intent was claimed was read as a completed sale. The pipeline then
   * kept the seller's mirror and marked the buyback must-complete — owing a payout for a sale
   * that never happened, on a card we still held.
   */
  test("a card still in our Solana custody means NOT sold, so the mirror goes back", async () => {
    const h = harness();
    const id = await openBuyback(h);

    // The sale throws after claiming its intent, and the card never left.
    h.cc.failures.buildBuybackThrows = true;
    cardOwnerRef.value = SOLANA_CUSTODY;
    h.db.claimIntent(`cc-sell:buyback:${id}`, "cc-sell", { buybackId: id });

    await h.pipeline.process(id);

    assert.equal(h.db.getBuyback(id)!.status, "FAILED", "not sold, so the buyback closes");
    assert.ok(
      h.chain.returned.some((r) => r.tokenId === TOKEN),
      "the seller's mirror must be handed back when the card is demonstrably still ours",
    );
    assert.ok(
      !h.alerts.some((a) => a.includes("CC took it")),
      "and nothing may claim CC took a card sitting in our own wallet",
    );
  });

  test("a card that really did leave custody is treated as sold", async () => {
    const h = harness();
    const id = await openBuyback(h);

    h.cc.failures.buildBuybackThrows = true;
    cardOwnerRef.value = "SomeOtherSolanaWalletThatIsNotOurs11111111";
    h.db.claimIntent(`cc-sell:buyback:${id}`, "cc-sell", { buybackId: id });

    await h.pipeline.process(id);

    assert.ok(
      !h.chain.returned.some((r) => r.tokenId === TOKEN),
      "the mirror must NOT go back for a card Collector Crypt already holds",
    );
  });
});


describe("a payout that reverted", () => {
  /**
   * The card is already at Collector Crypt by this point, so the seller is owed money that
   * only we can send. `recordIntentTx(key, tx, "FAILED")` left the dead hash on the intent row
   * and `clearIntent` only deletes rows WITHOUT a hash, so every later tick re-entered the same
   * branch, re-checked the same reverted hash and re-alerted — never re-broadcasting. The
   * comment beside it read "Will retry". It could not.
   */
  test("is released and genuinely retried, so the seller actually gets paid", async () => {
    const h = harness();
    const id = await openBuyback(h);

    /**
     * The shape that dead-ends: the payout is BROADCAST (so its hash is recorded on the
     * intent) and only then turns out to have reverted. A payout that throws before
     * broadcasting clears its own intent and retries fine — that path was never the bug.
     */
    h.chain.timeoutAfterBroadcast = true;
    await h.pipeline.process(id).catch(() => {});
    h.chain.timeoutAfterBroadcast = false;

    const deadHash = `0xpay${h.chain.paid.length}`;
    h.chain.succeeded.delete(deadHash);
    h.chain.reverted.add(deadHash); // a receipt exists and it failed

    const paidBefore = h.chain.paid.length;

    // First tick after the revert: notices, releases the claim, does not pay yet.
    await h.pipeline.process(id).catch(() => {});
    // Second tick: makes a genuinely new attempt.
    await h.pipeline.process(id).catch(() => {});

    assert.ok(
      h.chain.paid.length > paidBefore,
      "a NEW payout must actually be broadcast — the old code re-checked the dead hash forever",
    );
    assert.equal(h.db.getBuyback(id)!.status, "PAID", "and the seller ends up paid");
  });

  test("an UNKNOWN result never releases the claim, so nobody is paid twice", async () => {
    const h = harness();
    const id = await openBuyback(h);

    // Broadcast, then lose the receipt — the money may or may not have moved.
    h.chain.timeoutAfterBroadcast = true;
    await h.pipeline.process(id).catch(() => {});
    const hash = h.chain.paid.at(-1) ? `0xpay${h.chain.paid.length}` : null;
    assert.ok(hash, "something was broadcast");

    // The chain cannot tell us how it ended.
    h.chain.succeeded.delete(hash!);
    h.chain.unknown.add(hash!);
    h.chain.timeoutAfterBroadcast = false;

    const paidBefore = h.chain.paid.length;
    await h.pipeline.process(id).catch(() => {});

    assert.equal(
      h.chain.paid.length,
      paidBefore,
      "an unknown outcome must never trigger a second transfer",
    );
    assert.notEqual(h.db.getBuyback(id)!.status, "PAID", "and must not be recorded as settled");
  });
});
