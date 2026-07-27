import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../db/index.ts";
import { EscrowWatcher } from "./escrow.ts";
import type { EscrowChain, BuybackRunner } from "./escrow.ts";
import type { Config } from "../config.ts";

const OPERATOR = "0xOperatorCustody";
const SELLER = "0xSeller";
const TOKEN = "7";
const MINT = "MintAbc123";
const INSURED = "100000000";

function testConfig(sellBackEnabled = true, maxSellBackValueUsd = 0): Config {
  // maxSellBackValueUsd defaults to 0 (no cap) so the existing escrow tests keep asserting
  // escrow behaviour rather than the value policy. The cap has its own tests.
  return {
    maxSellBackValueUsd,
    bridge: { costAlertUsd: 2, costAbortUsd: 5, rhChainId: 4663, solanaChainId: 7565164, apiUrl: "", provider: "mock", fillTimeoutMs: 1000 },
    economics: { spreadBps: 500, userWindowHours: 66, ccWindowHours: 72, unwrapFeeDuringWindowBps: 0, quoteTtlSec: 60, quoteDriftRevalidateBps: 25 },
    limits: { maxPackPriceUsdg: 55, orderTimeoutMin: 10 },
    rh: { usdgAddress: "0xusdg" },
    solana: { usdcMint: "usdc" },
    sellBackEnabled,
  } as unknown as Config;
}

class StubChain implements EscrowChain {
  readonly operatorAddress = OPERATOR;
  head = 100n;
  owner: Record<string, string> = { [TOKEN]: OPERATOR };
  inbound: { tokenId: bigint; from: string }[] = [];
  returned: { to: string; tokenId: string }[] = [];
  failReturn = false;
  ownerOfThrows = false;

  async headBlock() {
    return this.head;
  }
  async inboundMirrorTransfers(fromBlock: bigint) {
    // The stub ignores the range and hands back whatever was queued, then clears it, which
    // models "these arrived since the cursor".
    const transfers = fromBlock <= this.head ? this.inbound : [];
    this.inbound = [];
    return { transfers, latestBlock: this.head };
  }
  async mirrorOwnerOf(tokenId: bigint) {
    if (this.ownerOfThrows) throw new Error("rpc down");
    const o = this.owner[tokenId.toString()];
    if (!o) throw new Error(`token ${tokenId} does not exist`);
    return o;
  }
  async returnMirror(to: string, tokenId: bigint) {
    if (this.failReturn) throw new Error("return reverted");
    this.returned.push({ to, tokenId: tokenId.toString() });
    this.owner[tokenId.toString()] = to;
    return `0xreturn${this.returned.length}`;
  }
}

class StubRunner implements BuybackRunner {
  processed: number[] = [];
  throws = false;
  async process(id: number) {
    this.processed.push(id);
    if (this.throws) throw new Error("pipeline exploded");
  }
}

type Harness = {
  db: Db;
  chain: StubChain;
  runner: StubRunner;
  watcher: EscrowWatcher;
  alerts: string[];
};

function harness(
  sellBackEnabled = true,
  opts: { maxSellBackValueUsd?: number; insuredValueUsd?: string } = {},
): Harness {
  const db = new Db(":memory:");
  const chain = new StubChain();
  const runner = new StubRunner();
  const alerts: string[] = [];

  const now = Date.now();
  db.insertOrder({ id: 1, buyer: SELLER, machineId: "pokemon_50", priceUsdg: "53000000", rhPayTx: null, deadlineAt: now + 600_000 });
  db.insertCard({
    solanaMint: MINT, orderId: 1, certNumber: "1", grade: "PSA 10", name: "Card",
    // Key presence, not ??, so a test can deliberately insert a card with NO insured value.
    imageUrl: null,
    insuredValueUsd: "insuredValueUsd" in opts ? opts.insuredValueUsd! : INSURED,
    revealAt: now,
    ccWindowEndsAt: now + 72 * 3600_000, userWindowEndsAt: now + 66 * 3600_000,
    ownerMirrorTokenId: TOKEN,
  });

  // Cursor must be non-zero or the first tick only initialises it.
  db.setMeta("escrow_block_cursor", "1");

  const watcher = new EscrowWatcher({
    db, chain, buybacks: runner, cfg: testConfig(sellBackEnabled, opts.maxSellBackValueUsd ?? 0),
    alert: (m) => alerts.push(m),
  });

  return { db, chain, runner, watcher, alerts };
}

function quote(h: Harness, tokenId = TOKEN): number {
  return h.db.insertQuote({
    mirrorTokenId: tokenId,
    solanaMint: MINT,
    requester: SELLER,
    ccQuoteBps: 8500,
    quotedUserRateBps: 8000,
    quotedUsdg: "80000000",
    insuredValueUsd: INSURED,
    expiresAt: Date.now() + 60_000,
  });
}

describe("the transfer is the confirmation", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  test("a deposit matching a quote starts the sell-back", async () => {
    const id = quote(h);
    h.chain.inbound = [{ tokenId: BigInt(TOKEN), from: SELLER }];

    await h.watcher.tick();

    assert.deepEqual(h.runner.processed, [id], "pipeline was handed the buyback");
    const b = h.db.getBuyback(id)!;
    assert.equal(b.status, "USER_CONFIRMED");
    assert.equal(b.seller, SELLER);
    assert.equal(h.db.getEscrowDeposit(TOKEN)!.buyback_id, id);
    assert.equal(h.chain.returned.length, 0, "a genuine sell is not handed back");
  });

  test("the seller comes from the chain, never from the quote requester", async () => {
    // Mallory quotes against a token she does not own; Alice is the one who transfers it.
    const id = h.db.insertQuote({
      mirrorTokenId: TOKEN, solanaMint: MINT, requester: "0xMallory",
      ccQuoteBps: 8500, quotedUserRateBps: 8000, quotedUsdg: "80000000",
      insuredValueUsd: INSURED, expiresAt: Date.now() + 60_000,
    });
    h.chain.inbound = [{ tokenId: BigInt(TOKEN), from: "0xAlice" }];

    await h.watcher.tick();

    assert.equal(h.db.getBuyback(id)!.seller, "0xAlice", "we pay whoever gave up the token");
  });

  test("a replayed log does not start a second sell-back", async () => {
    const id = quote(h);
    h.chain.inbound = [{ tokenId: BigInt(TOKEN), from: SELLER }];
    await h.watcher.tick();

    quote(h); // a stale second quote lying around
    h.chain.inbound = [{ tokenId: BigInt(TOKEN), from: SELLER }];
    await h.watcher.tick();

    assert.deepEqual(h.runner.processed, [id], "processed exactly once");
  });

  test("a pipeline that throws is alerted, not swallowed", async () => {
    quote(h);
    h.runner.throws = true;
    h.chain.inbound = [{ tokenId: BigInt(TOKEN), from: SELLER }];

    await h.watcher.tick();

    assert.ok(h.alerts.some((a) => /threw out of the pipeline/.test(a)));
  });
});

describe("the sweeper never forgets a card", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  test("a deposit with no quote behind it is returned", async () => {
    h.chain.inbound = [{ tokenId: BigInt(TOKEN), from: SELLER }];

    await h.watcher.tick();

    assert.equal(h.runner.processed.length, 0, "nothing was sold");
    assert.deepEqual(h.chain.returned, [{ to: SELLER, tokenId: TOKEN }]);
    assert.equal(h.db.getEscrowDeposit(TOKEN)!.returned_tx, "0xreturn1");
  });

  test("a failed return is retried on the next tick", async () => {
    h.chain.inbound = [{ tokenId: BigInt(TOKEN), from: SELLER }];
    h.chain.failReturn = true;

    await h.watcher.tick();
    assert.equal(h.chain.returned.length, 0);
    assert.ok(h.db.getEscrowDeposit(TOKEN)!.last_error, "the failure is recorded");
    assert.equal(h.db.getEscrowDeposit(TOKEN)!.returned_tx, null, "still owed");

    h.chain.failReturn = false;
    await h.watcher.tick();

    assert.deepEqual(h.chain.returned, [{ to: SELLER, tokenId: TOKEN }]);
    assert.equal(h.db.getEscrowDeposit(TOKEN)!.last_error, null, "error cleared on success");
  });

  test("a token that already left custody is closed, not re-sent", async () => {
    h.chain.inbound = [{ tokenId: BigInt(TOKEN), from: SELLER }];
    h.chain.owner[TOKEN] = "0xSomewhereElse";

    await h.watcher.tick();

    assert.equal(h.chain.returned.length, 0, "must not transfer a token we do not hold");
    assert.equal(h.db.getEscrowDeposit(TOKEN)!.returned_tx, "already-not-held");
  });

  test("a card held too long with no way back raises an alert", async () => {
    h.chain.inbound = [{ tokenId: BigInt(TOKEN), from: SELLER }];
    h.chain.failReturn = true;
    await h.watcher.tick();

    // Backdate the deposit past the alert threshold.
    h.db.raw.prepare(`UPDATE escrow_deposits SET seen_at = ? WHERE token_id = ?`)
      .run(Date.now() - 20 * 60_000, TOKEN);

    await h.watcher.tick();

    assert.ok(
      h.alerts.some((a) => /Holding mirror .* and cannot return it/.test(a)),
      "an unreturnable card must be surfaced",
    );
  });

  test("a token owned by a live buyback is left alone", async () => {
    const id = quote(h);
    h.chain.inbound = [{ tokenId: BigInt(TOKEN), from: SELLER }];
    await h.watcher.tick();
    assert.equal(h.db.getBuyback(id)!.status, "USER_CONFIRMED");

    await h.watcher.tick(); // sweeper runs again

    assert.equal(h.chain.returned.length, 0, "the pipeline owns this token, not the sweeper");
  });

  test("an RPC failure during sweep does not lose the deposit", async () => {
    h.chain.inbound = [{ tokenId: BigInt(TOKEN), from: SELLER }];
    h.chain.ownerOfThrows = true;
    await h.watcher.tick();

    assert.equal(h.db.getEscrowDeposit(TOKEN)!.returned_tx, null, "still tracked as owed");

    h.chain.ownerOfThrows = false;
    await h.watcher.tick();
    assert.deepEqual(h.chain.returned, [{ to: SELLER, tokenId: TOKEN }]);
  });
});

describe("the master switch", () => {
  test("with sell-back disabled, a deposit is returned instead of sold", async () => {
    const h = harness(false);
    quote(h);
    h.chain.inbound = [{ tokenId: BigInt(TOKEN), from: SELLER }];

    await h.watcher.tick();

    assert.equal(h.runner.processed.length, 0, "no card may be sold while a leg is missing");
    assert.deepEqual(h.chain.returned, [{ to: SELLER, tokenId: TOKEN }]);
  });
});

describe("the cursor", () => {
  test("first boot starts from the head rather than replaying the chain", async () => {
    const db = new Db(":memory:");
    const chain = new StubChain();
    chain.head = 500n;
    const watcher = new EscrowWatcher({
      db, chain, buybacks: new StubRunner(), cfg: testConfig(), alert: () => {},
    });

    await watcher.tick();

    assert.equal(db.getMeta("escrow_block_cursor"), "500");
  });

  test("the cursor only advances after a range is recorded", async () => {
    const h = harness();
    h.chain.head = 250n;
    h.chain.inbound = [{ tokenId: BigInt(TOKEN), from: SELLER }];

    await h.watcher.tick();

    assert.equal(h.db.getMeta("escrow_block_cursor"), "250");
    assert.ok(h.db.getEscrowDeposit(TOKEN), "the deposit in that range was recorded");
  });
});

/**
 * The value ceiling, tested where it actually has to hold.
 *
 * A sell-back begins with an on-chain transfer to the custody address. No website is
 * involved, so the UI popup and the API refusal are both bypassable by anyone willing to use
 * a wallet directly. This is the layer that cannot be routed around, and these tests are the
 * ones that prove the cap is real rather than decorative.
 */
describe("cards above the value limit are handed back", () => {
  const OVER = "250000000"; // over the test ceiling
  const UNDER = "40000000"; // $40

  test("a too-valuable mirror sent straight to escrow is returned, not sold", async () => {
    const h = harness(true, { maxSellBackValueUsd: 137, insuredValueUsd: OVER });
    quote(h); // even with a quote on file, the cap wins
    h.chain.inbound = [{ tokenId: BigInt(TOKEN), from: SELLER }];

    await h.watcher.tick();

    assert.equal(h.runner.processed.length, 0, "no buyback may be created");
    assert.deepEqual(h.chain.returned, [{ to: SELLER, tokenId: TOKEN }], "handed back to the sender");
    assert.ok(
      h.alerts.some((a) => /insured above \$137/.test(a)),
      "the operator should be told why a card came back",
    );
  });

  test("a stale quote written before the cap existed cannot slip through", async () => {
    // The reason this is checked in the deposit loop rather than inferred from quote absence.
    const h = harness(true, { maxSellBackValueUsd: 137, insuredValueUsd: OVER });
    quote(h);
    h.chain.inbound = [{ tokenId: BigInt(TOKEN), from: SELLER }];

    await h.watcher.tick();

    assert.equal(h.db.getEscrowDeposit(TOKEN)!.buyback_id, null, "never linked to a buyback");
  });

  test("a card under the limit still sells normally", async () => {
    const h = harness(true, { maxSellBackValueUsd: 137, insuredValueUsd: UNDER });
    const id = quote(h);
    h.chain.inbound = [{ tokenId: BigInt(TOKEN), from: SELLER }];

    await h.watcher.tick();

    assert.deepEqual(h.runner.processed, [id], "the cap must not block ordinary cards");
    assert.equal(h.chain.returned.length, 0);
  });

  test("a card of unknown value is returned rather than guessed at", async () => {
    const h = harness(true, { maxSellBackValueUsd: 137, insuredValueUsd: null as unknown as string });
    quote(h);
    h.chain.inbound = [{ tokenId: BigInt(TOKEN), from: SELLER }];

    await h.watcher.tick();

    assert.equal(h.runner.processed.length, 0);
    assert.deepEqual(h.chain.returned, [{ to: SELLER, tokenId: TOKEN }]);
  });
});

describe("depositing the same token twice", () => {
  /**
   * The second live sell-back stalled here.
   *
   * The first attempt failed at Collector Crypt and the mirror was returned, leaving a row
   * with buyback_id and returned_tx both set. escrow_deposits keys on token_id and the insert
   * was ON CONFLICT DO NOTHING, so the SECOND deposit of the same token wrote nothing. The
   * watcher then read the stale row, saw it resolved, and skipped the deposit as already
   * handled — while the sweeper, which only looks at rows with both fields null, ignored it
   * too. The user's mirror sat in custody with nothing driving it and nothing giving it back.
   */
  test("a returned deposit does not swallow the next one", async () => {
    const h = harness();

    // First deposit, returned without a sale.
    h.db.recordEscrowDeposit(TOKEN, SELLER);
    h.db.linkEscrowToBuyback(TOKEN, 99);
    h.db.markEscrowReturned(TOKEN, "0xreturned");

    const closed = h.db.getEscrowDeposit(TOKEN)!;
    assert.equal(closed.returned_tx, "0xreturned", "precondition: the first deposit is closed");

    // The same token arrives again.
    h.db.recordEscrowDeposit(TOKEN, SELLER);

    const fresh = h.db.getEscrowDeposit(TOKEN)!;
    assert.equal(fresh.returned_tx, null, "the new deposit must not inherit the old return");
    assert.equal(fresh.buyback_id, null, "nor the old buyback");
    assert.ok(
      h.db.unresolvedEscrowDeposits().some((d) => d.token_id === TOKEN),
      "and the sweeper must be able to see it, so the card is never stranded",
    );
  });
});

describe("a deposited card is never sold back", () => {
  /**
   * The rule exists because we never bought a deposited card. Paying USDG for one would hand
   * someone money for a card they gave us and could simply withdraw again.
   *
   * It is enforced HERE rather than in the API because a sell-back begins with an on-chain
   * transfer to the escrow address — no website involved. Hiding the button or refusing the
   * request would both be bypassable by anyone with a wallet, exactly as the value ceiling
   * beside it already accounts for.
   */
  test("its mirror is returned to the sender, not turned into a sale", async () => {
    const h = harness();
    h.db.raw.prepare(`UPDATE cards SET origin = 'DEPOSIT' WHERE owner_mirror_token_id = ?`).run(TOKEN);

    // A quote exists and is fresh, so nothing but the origin check can stop this.
    quote(h);
    h.chain.inbound = [{ tokenId: BigInt(TOKEN), from: SELLER }];
    await h.watcher.tick();

    assert.equal(h.db.activeBuybacks().length, 0, "no sell-back may start for a deposited card");
    assert.ok(
      h.chain.returned.some((r) => r.tokenId === TOKEN),
      "the mirror goes straight back to whoever sent it",
    );
    assert.ok(
      h.alerts.some((a) => /DEPOSITED/i.test(a)),
      "and it is stated plainly rather than failing silently",
    );
  });

  test("a pack-pulled card is unaffected", async () => {
    const h = harness();
    quote(h);
    h.chain.inbound = [{ tokenId: BigInt(TOKEN), from: SELLER }];
    await h.watcher.tick();

    assert.equal(h.db.activeBuybacks().length, 1, "a normal sell-back still starts");
  });
});
