import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { scanLogsInChunks, machineIdToBytes32, bytes32ToMachineId, escrowDepositsOnly, ZERO_ADDRESS } from "./rh.ts";

/**
 * Log scanning, and the stall it used to cause.
 *
 * `getOrdersSince` requested fromBlock..latest in one getLogs call. RPCs cap log ranges, so
 * after a few hours of downtime the call threw, the worker swallowed it as "tick failed", the
 * cursor never advanced, and every later tick threw the same way. Buyers pay, OrderCreated
 * fires, and no order row is ever created. It looks exactly like "no orders", which is the
 * worst possible failure for a queue holding customer money.
 */
describe("scanning logs in chunks", () => {
  test("covers the whole range with no gaps or overlaps", async () => {
    const seen: [bigint, bigint][] = [];
    const { logs, scannedTo } = await scanLogsInChunks(
      1n,
      5_000n,
      async (from, to) => {
        seen.push([from, to]);
        return [`${from}-${to}`];
      },
      2_000n,
    );

    assert.deepEqual(seen, [
      [1n, 2_000n],
      [2_001n, 4_000n],
      [4_001n, 5_000n],
    ]);
    assert.equal(logs.length, 3);
    assert.equal(scannedTo, 5_000n, "a clean scan reports the full range");
  });

  test("a range too large for the RPC no longer stalls forever", async () => {
    // The real failure: one call for 100k blocks is rejected outright.
    let calls = 0;
    const { scannedTo } = await scanLogsInChunks(
      1n,
      100_000n,
      async (from, to) => {
        calls += 1;
        if (to - from > 10_000n) throw new Error("query returned more than 10000 results");
        return [];
      },
      2_000n,
    );

    assert.ok(calls > 1, "the range is split rather than sent whole");
    assert.equal(scannedTo, 100_000n, "and the whole backlog is covered");
  });

  test("a mid-scan failure keeps the progress already made", async () => {
    const { logs, scannedTo } = await scanLogsInChunks(
      1n,
      10_000n,
      async (from) => {
        if (from > 4_000n) throw new Error("rpc blipped");
        return [from];
      },
      2_000n,
    );

    // Two chunks succeeded (1..2000, 2001..4000), the third failed.
    assert.deepEqual(logs, [1n, 2_001n]);
    assert.equal(scannedTo, 4_000n, "the caller must persist real progress, not `latest`");
  });

  test("progress is never reported past blocks that were not read", async () => {
    // The dangerous mistake would be returning `latest` after a partial scan: the cursor would
    // jump over unread blocks and those orders would be lost permanently, with nothing to
    // refund them since nothing would know they existed.
    const { scannedTo } = await scanLogsInChunks(
      1n,
      10_000n,
      async (from) => {
        if (from > 2_000n) throw new Error("rpc blipped");
        return [];
      },
      2_000n,
    );
    assert.equal(scannedTo, 2_000n);
    assert.ok(scannedTo < 10_000n, "must not claim to have read what it could not");
  });

  test("a failure on the very first chunk rethrows", async () => {
    // Nothing was read, so there is no progress to keep. This is a genuine RPC fault and the
    // caller must not advance its cursor at all.
    await assert.rejects(
      () => scanLogsInChunks(1n, 10_000n, async () => { throw new Error("rpc down"); }, 2_000n),
      /rpc down/,
    );
  });

  test("an empty range does no work", async () => {
    let calls = 0;
    const { logs } = await scanLogsInChunks(5_000n, 4_999n, async () => { calls += 1; return []; });
    assert.equal(calls, 0);
    assert.equal(logs.length, 0);
  });
});

describe("machine id encoding", () => {
  test("round-trips as right-padded ASCII, not keccak", () => {
    // The documented trap: keccak here makes every buy revert with MachineDisabled, and no
    // on-chain check can detect it because PackSale only ever sees bytes32.
    for (const code of ["pokemon_50", "pokemon_250", "pokemon_1000", "water_100"]) {
      assert.equal(bytes32ToMachineId(machineIdToBytes32(code)), code);
    }
    assert.match(machineIdToBytes32("pokemon_50"), /^0x706f6b656d6f6e5f353000+$/);
  });
});

/**
 * Mints must never be read as escrow deposits.
 *
 * `inboundMirrorTransfers` filters on `to == workerAddress`, and the operator wallet is ALSO
 * the escrow address. So an operator-bought card mints "into" escrow, and without excluding
 * `from == 0x0` the watcher treats its own mint as a sell-back, then tries to return the
 * mirror to the zero address forever.
 */
describe("mint transfers are not escrow deposits", () => {
  const ZERO = ZERO_ADDRESS;
  const OPERATOR = "0x00770E4B22527021a7e0e3B317602e57d7157daC";

  // The REAL function inboundMirrorTransfers uses, not a copy of its logic.
  const depositsOnly = escrowDepositsOnly;

  test("a mint into the operator wallet is ignored", () => {
    const logs = [{ tokenId: 1n, from: ZERO }];
    assert.deepEqual(depositsOnly(logs), [], "a mint is not somebody selling back");
  });

  test("a genuine transfer from a seller is still picked up", () => {
    const logs = [{ tokenId: 7n, from: "0xSeller" }];
    assert.deepEqual(depositsOnly(logs), [{ tokenId: 7n, from: "0xSeller" }]);
  });

  test("a mint and a real deposit in the same block are separated", () => {
    const logs = [{ tokenId: 1n, from: ZERO }, { tokenId: 7n, from: "0xSeller" }];
    assert.deepEqual(depositsOnly(logs), [{ tokenId: 7n, from: "0xSeller" }]);
  });

  test("the zero check is case-insensitive", () => {
    const logs = [{ tokenId: 1n, from: ZERO.toUpperCase().replace("0X", "0x") }];
    assert.deepEqual(depositsOnly(logs), [], "a checksummed zero address is still zero");
  });

  test("the operator selling back their OWN card still works", () => {
    // from == to == operator is a real transfer, not a mint, and must not be filtered.
    const logs = [{ tokenId: 3n, from: OPERATOR }];
    assert.deepEqual(depositsOnly(logs), [{ tokenId: 3n, from: OPERATOR }]);
  });
});

/**
 * The escrow watcher must make progress under a failing RPC.
 *
 * getOrdersSince was chunked to stop a widening-range spiral; inboundMirrorTransfers was
 * missed and kept a single unbounded getLogs. Every failure left the caller's cursor parked,
 * so the next tick asked for the same start against a newer head, growing the range until it
 * could never succeed. Seen in production on 20 Jul.
 *
 * It is the worse of the two to lose. An unseen ORDER is recoverable — the buyer refunds
 * permissionlessly. An unseen DEPOSIT is not: the mirror has left the user's wallet, no
 * escrow_deposits row exists, and the sweeper only walks rows it recorded. The card sits in
 * custody, unrecorded and unreturned.
 */
describe("escrow log scanning makes progress under a failing RPC", () => {
  test("a mid-scan failure still reports how far it got", async () => {
    // Succeeds on the first chunk, then the RPC starts refusing.
    let calls = 0;
    const { logs, scannedTo } = await scanLogsInChunks(
      1n, 10_000n,
      async (from, to) => {
        calls += 1;
        if (calls > 1) throw new Error("Too Many Requests");
        return [{ block: to }];
      },
      2_000n,
    );

    assert.equal(logs.length, 1, "the chunk that succeeded is kept");
    assert.equal(scannedTo, 2_000n, "progress is reported, so the cursor advances past it");
    assert.ok(scannedTo < 10_000n, "and it does not claim to have scanned the whole range");
  });

  test("the range cannot widen forever across ticks", async () => {
    /**
     * The spiral, simulated. An RPC that fails above a range width would, unchunked, be
     * re-asked for an ever-wider span every tick and never recover. Chunked, each tick
     * persists what it scanned, so the backlog drains instead of growing.
     */
    const LIMIT = 2_000n;
    const fetch = async (from: bigint, to: bigint) => {
      if (to - from + 1n > LIMIT) throw new Error("query returned more than 10000 results");
      return [];
    };

    let cursor = 1n;
    let head = 10_000n;
    for (let tick = 0; tick < 5; tick++) {
      const { scannedTo } = await scanLogsInChunks(cursor, head, fetch, LIMIT);
      assert.ok(scannedTo >= cursor - 1n, "a tick never moves the cursor backwards");
      cursor = scannedTo + 1n;
      head += 50n; // the chain keeps moving while we work
    }

    assert.ok(cursor > 10_000n, `backlog drained rather than widening (cursor ${cursor})`);
  });

  test("a first-chunk failure rethrows rather than skipping unread blocks", async () => {
    // Advancing past blocks we never read would lose the deposits inside them for good.
    await assert.rejects(
      () => scanLogsInChunks(1n, 10_000n, async () => { throw new Error("rpc down"); }, 2_000n),
      /rpc down/,
    );
  });
});
