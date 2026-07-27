import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../db/index.ts";
import { WithdrawRelayer } from "./withdraw.ts";
import type { Config } from "../config.ts";

/** A ceiling for tests. Deliberately not the production one, which lives only in env. */
const TEST_CEILING = 137;

/**
 * The relayer's contract with a user who has already burned their mirror.
 *
 * `burnForUnwrap` destroys the mirror BEFORE emitting, so every request here represents
 * someone holding nothing who is owed a physical card. There is no refund and no retry
 * available to them. What is tested below is therefore not "does it send" but "can a claim
 * ever be lost": by a switched-off relayer, a bad address, a dead RPC, a restart, or a replay.
 */

const TOKEN = "7";
const OWNER = "0xSeller";
const DEST = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const MINT = "MintAbc123";

function testConfig(over: Partial<Config> = {}): Config {
  return {
    withdrawEnabled: true,
    withdrawRequireFundedDestination: false,
    maxSellBackValueUsd: TEST_CEILING,
    ...over,
  } as unknown as Config;
}

type Harness = {
  db: Db;
  relayer: WithdrawRelayer;
  sent: { mint: string; dest: string }[];
  alerts: string[];
  setRequests: (rs: { tokenId: bigint; owner: string; solanaAddress: string }[]) => void;
  failSend: (msg: string | null) => void;
  setAssetOwner: (owner: string | null) => void;
};

function harness(cfg: Config = testConfig(), opts: { withCard?: boolean } = {}): Harness {
  const db = new Db(":memory:");
  const now = Date.now();

  if (opts.withCard !== false) {
    db.insertOrder({ id: 1, buyer: OWNER, machineId: "pokemon_50", priceUsdg: "53000000", rhPayTx: null, deadlineAt: now + 600_000 });
    db.insertCard({
      solanaMint: MINT, orderId: 1, certNumber: "1", grade: "PSA 10", name: "Card",
      imageUrl: null, insuredValueUsd: "50000000", revealAt: now,
      ccWindowEndsAt: now + 72 * 3600_000, userWindowEndsAt: now + 66 * 3600_000,
      ownerMirrorTokenId: TOKEN,
    });
  }

  // Not block 0: the relayer treats 0 as "first boot" and only records the head.
  db.setMeta("withdraw_block_cursor", "100");

  const sent: { mint: string; dest: string }[] = [];
  const alerts: string[] = [];
  let requests: { tokenId: bigint; owner: string; solanaAddress: string }[] = [];
  let sendError: string | null = null;
  let assetOwnerValue: string | null = null;

  const relayer = new WithdrawRelayer({
    db,
    cfg,
    chain: {
      headBlock: async () => 200n,
      unwrapRequests: async () => ({ requests, latestBlock: 200n }),
    },
    solana: {
      assetOwner: async () => assetOwnerValue,
      withdrawAssetTo: async (mint, dest) => {
        if (sendError) throw new Error(sendError);
        sent.push({ mint, dest });
        return { signature: `sig-${sent.length}`, dryRun: false, destination: dest };
      },
    },
    alert: (m) => alerts.push(m),
  });

  return {
    db, relayer, sent, alerts,
    setRequests: (rs) => { requests = rs; },
    failSend: (msg) => { sendError = msg; },
    setAssetOwner: (o: string | null) => { assetOwnerValue = o; },
  };
}

const oneRequest = [{ tokenId: BigInt(TOKEN), owner: OWNER, solanaAddress: DEST }];

describe("the happy path", () => {
  test("records the request, sends the asset, stores the signature", async () => {
    const h = harness();
    h.setRequests(oneRequest);

    await h.relayer.tick();

    assert.deepEqual(h.sent, [{ mint: MINT, dest: DEST }], "the card is sent to the requested address");
    const row = h.db.getWithdrawal(TOKEN)!;
    assert.equal(row.status, "SENT");
    assert.equal(row.transfer_sig, "sig-1");
    assert.equal(row.requester, OWNER, "the requester comes from the event, not a request body");
  });

  test("the mint comes from our records, never from the event", async () => {
    // The event carries a destination and nothing else. Which physical card a mirror stands
    // for is ours to know — trusting anything else here would let a caller name the asset.
    const h = harness();
    h.setRequests(oneRequest);
    await h.relayer.tick();
    assert.equal(h.sent[0]!.mint, MINT);
  });
});

describe("a claim can never be lost", () => {
  test("the request is recorded even when the relayer is switched off", async () => {
    const h = harness(testConfig({ withdrawEnabled: false } as Partial<Config>));
    h.setRequests(oneRequest);

    await h.relayer.tick();

    assert.deepEqual(h.sent, [], "nothing is sent while switched off");
    const row = h.db.getWithdrawal(TOKEN)!;
    assert.equal(row.status, "HELD", "but the debt is on the books");
    assert.equal(row.solana_dest, DEST, "with the address it is owed to");
    assert.ok(h.alerts.some((a) => /QUEUED, not sent/.test(a)), "and a human is told");
  });

  test("switching the relayer on later relays what was queued", async () => {
    // The reason "off" means "do not send" rather than "do not watch".
    const off = testConfig({ withdrawEnabled: false } as Partial<Config>);
    const h = harness(off);
    h.setRequests(oneRequest);
    await h.relayer.tick();
    assert.equal(h.db.getWithdrawal(TOKEN)!.status, "HELD");

    // Same database, relayer now enabled, and NO new event arrives.
    const relayer = new WithdrawRelayer({
      db: h.db,
      cfg: testConfig(),
      chain: { headBlock: async () => 300n, unwrapRequests: async () => ({ requests: [], latestBlock: 300n }) },
      solana: {
        assetOwner: async () => null,
        withdrawAssetTo: async (mint, dest) => {
          h.sent.push({ mint, dest });
          return { signature: "sig-later", dryRun: false, destination: dest };
        },
      },
      alert: (m) => h.alerts.push(m),
    });
    await relayer.tick();

    assert.deepEqual(h.sent, [{ mint: MINT, dest: DEST }], "the queued claim is honoured");
    assert.equal(h.db.getWithdrawal(TOKEN)!.status, "SENT");
  });

  test("a failed send stays owed and is retried, not closed", async () => {
    const h = harness();
    h.setRequests(oneRequest);
    h.failSend("solana rpc down");

    await h.relayer.tick();

    const row = h.db.getWithdrawal(TOKEN)!;
    assert.equal(row.status, "FAILED");
    assert.equal(row.transfer_sig, null, "nothing was sent");
    assert.match(row.last_error!, /solana rpc down/);
    assert.ok(h.db.openWithdrawals().some((w) => w.token_id === TOKEN), "still outstanding");

    // Next tick, the RPC is back.
    h.failSend(null);
    await h.relayer.tick();
    assert.equal(h.db.getWithdrawal(TOKEN)!.status, "SENT", "a failure is a retry, not an ending");
  });

  test("a burned mirror with no matching card is held loudly, not dropped", async () => {
    // The worst case: we cannot tell which asset this user is owed. Silence here would be a
    // user who burned their card for nothing and has no record of it.
    const h = harness(testConfig(), { withCard: false });
    h.setRequests(oneRequest);

    await h.relayer.tick();

    const row = h.db.getWithdrawal(TOKEN)!;
    assert.equal(row.status, "HELD");
    assert.deepEqual(h.sent, []);
    assert.ok(h.alerts.some((a) => /NO MATCHING CARD/.test(a)), "this must page a human");
  });

  test("a card over the value ceiling is held for review, not sent", async () => {
    const h = harness(testConfig({ maxSellBackValueUsd: 10 } as Partial<Config>));
    h.setRequests(oneRequest);

    await h.relayer.tick();

    assert.deepEqual(h.sent, [], "a $50 card must not go while the ceiling is $10");
    assert.equal(h.db.getWithdrawal(TOKEN)!.status, "HELD");
  });
});

describe("replays and restarts", () => {
  test("seeing the same event twice does not send twice", async () => {
    // The single most expensive mistake available here: the card is irreversible, so a second
    // send would either move somebody else's asset or fail after we no longer hold it.
    const h = harness();
    h.setRequests(oneRequest);

    await h.relayer.tick();
    await h.relayer.tick();
    await h.relayer.tick();

    assert.equal(h.sent.length, 1, "exactly one transfer, however many times the log is replayed");
  });

  test("an already-sent withdraw is never revisited", async () => {
    const h = harness();
    h.setRequests(oneRequest);
    await h.relayer.tick();

    assert.deepEqual(h.db.openWithdrawals(), [], "a sent withdraw leaves the open queue");
  });

  test("first boot records the head rather than replaying history", async () => {
    // Burns that predate the relayer are not promises we made; replaying them would send cards
    // against requests nobody is waiting on.
    const db = new Db(":memory:");
    const sent: unknown[] = [];
    const relayer = new WithdrawRelayer({
      db,
      cfg: testConfig(),
      chain: {
        headBlock: async () => 500n,
        unwrapRequests: async () => {
          throw new Error("must not scan history on first boot");
        },
      },
      solana: {
        assetOwner: async () => null,
        withdrawAssetTo: async () => { sent.push(1); return { signature: "x", dryRun: false, destination: DEST }; },
      },
      alert: () => {},
    });

    await relayer.tick();

    assert.equal(db.getMeta("withdraw_block_cursor"), "500");
    assert.deepEqual(sent, []);
  });
});

/**
 * Three faults found by auditing rather than by a failing test. Each is pinned here.
 */
describe("the card must stop counting as held", () => {
  test("a sent withdraw moves the card out of CUSTODY", async () => {
    // Not cosmetic. /reserves counts state IN ('CUSTODY','SALVAGE'), so leaving it CUSTODY
    // overstates what backs the outstanding mirrors — a public solvency claim turned false.
    const h = harness();
    h.setRequests(oneRequest);

    await h.relayer.tick();

    const card = h.db.cardByMirrorTokenId(TOKEN)!;
    assert.equal(card.state, "UNWRAPPED", "a withdrawn card is no longer in custody");
  });

  test("a card still in custody is untouched when the send fails", async () => {
    const h = harness();
    h.setRequests(oneRequest);
    h.failSend("rpc down");

    await h.relayer.tick();

    assert.equal(h.db.cardByMirrorTokenId(TOKEN)!.state, "CUSTODY", "we still hold it, so it still counts");
  });
});

describe("a crash between sending and recording", () => {
  test("an asset already at the destination is reconciled as SENT, not retried as FAILED", async () => {
    /**
     * The transfer landed; the process died before transfer_sig was written. Without
     * reconciliation the retry finds the asset gone from custody, reports "not our custody
     * wallet", and marks a SUCCESSFUL withdraw permanently FAILED — while the user has in fact
     * been paid. The chain is the authority, so it is asked first.
     */
    const h = harness();
    h.setRequests(oneRequest);
    h.failSend("crashed before recording");
    await h.relayer.tick();
    assert.equal(h.db.getWithdrawal(TOKEN)!.status, "FAILED");

    // The truth on chain: the card is sitting at the destination already.
    h.setAssetOwner(DEST);
    h.failSend(null);
    await h.relayer.tick();

    const row = h.db.getWithdrawal(TOKEN)!;
    assert.equal(row.status, "SENT", "the chain says it arrived, so our books must agree");
    assert.deepEqual(h.sent, [], "and it must NOT be sent a second time");
    assert.equal(h.db.cardByMirrorTokenId(TOKEN)!.state, "UNWRAPPED");
  });

  test("an asset sitting somewhere else is not mistaken for delivered", async () => {
    const h = harness();
    h.setRequests(oneRequest);
    h.setAssetOwner("SomeOtherWallet11111111111111111111111111111");
    h.failSend("not our custody wallet");

    await h.relayer.tick();

    assert.equal(h.db.getWithdrawal(TOKEN)!.status, "FAILED", "only the real destination counts");
  });
});

describe("a permanent failure does not become an alert flood", () => {
  test("the same error alerts once, not every tick", async () => {
    // The tick is 4s and failures retry forever by design. Alerting each time turns one bad
    // destination into fifteen alerts a minute, indefinitely, burying real signal.
    const h = harness();
    h.setRequests(oneRequest);
    h.failSend("destination is an executable program");

    await h.relayer.tick();
    await h.relayer.tick();
    await h.relayer.tick();

    const failures = h.alerts.filter((a) => /executable program/.test(a));
    assert.equal(failures.length, 1, `expected one alert, got ${failures.length}`);
  });

  test("but a DIFFERENT error still alerts", async () => {
    const h = harness();
    h.setRequests(oneRequest);
    h.failSend("first problem");
    await h.relayer.tick();
    h.failSend("second, different problem");
    await h.relayer.tick();

    assert.ok(h.alerts.some((a) => /first problem/.test(a)));
    assert.ok(h.alerts.some((a) => /second, different problem/.test(a)), "a new fault must not be swallowed");
  });

  test("the retry keeps happening even while quiet", async () => {
    const h = harness();
    h.setRequests(oneRequest);
    h.failSend("temporary");
    await h.relayer.tick();
    await h.relayer.tick();

    h.failSend(null);
    await h.relayer.tick();
    assert.equal(h.db.getWithdrawal(TOKEN)!.status, "SENT", "silence must not mean giving up");
  });
});

describe("a card that already left custody", () => {
  for (const state of ["SOLD_TO_CC", "UNWRAPPED", "BURNED"] as const) {
    test(`state ${state} is held for a human, not retried forever`, async () => {
      // Directly relevant: the destroyed card #1 sits in BURNED. Without this the relayer
      // would reach the transfer, fail the ownership check, and retry behind "not our custody
      // wallet" — a permanent problem wearing a transient message.
      const h = harness();
      h.db.setCardState(MINT, state);
      h.setRequests(oneRequest);

      await h.relayer.tick();

      assert.deepEqual(h.sent, [], "nothing to send — the card is not ours");
      const row = h.db.getWithdrawal(TOKEN)!;
      assert.equal(row.status, "HELD");
      assert.match(row.last_error!, new RegExp(state));
      assert.ok(h.alerts.some((a) => /Needs a human/.test(a)));
    });
  }

  test("a card still in CUSTODY is unaffected", async () => {
    const h = harness();
    h.setRequests(oneRequest);
    await h.relayer.tick();
    assert.equal(h.db.getWithdrawal(TOKEN)!.status, "SENT", "the normal path must not regress");
  });
});

describe("a row from a previous deployment", () => {
  /**
   * Token ids restart at 1 whenever MirrorNFT is redeployed, and `recordWithdrawal` is
   * ON CONFLICT(token_id) DO NOTHING — the same pair that produced the order-id collision.
   *
   * So a stale row can be sitting on the id a new burn uses. That row names a DIFFERENT user,
   * a DIFFERENT destination and a DIFFERENT card, and the new claim is silently not written.
   * The relayer used to alert and then carry on, which meant acting on the stale row: sending
   * someone else's card to someone else's address, on the strength of this user's burn.
   */
  test("is HELD, never relayed, when the chain disagrees about who burned", async () => {
    const h = harness();

    // A withdrawal recorded under a previous deployment, for a different person and card.
    h.db.recordWithdrawal({
      tokenId: TOKEN,
      requester: "0xSomebodyElse",
      solanaDest: "8xTheirOldDestinationAddress111111111111111",
      solanaMint: "TheirOldMint111111111111111111111111111111",
    });

    h.setRequests(oneRequest); // the chain says OWNER burned this token
    await h.relayer.tick();

    assert.deepEqual(h.sent, [], "nothing may be transferred while the claim is ambiguous");

    const row = h.db.getWithdrawal(TOKEN)!;
    assert.equal(
      row.status,
      "COLLISION",
      "distinct from HELD: HELD resumes when the kill switch flips, a collision must not",
    );
    assert.ok(
      h.alerts.some((a) => a.includes("collision")),
      "a human must be paged: a mirror is burned and its claim was not recorded",
    );
  });
});
