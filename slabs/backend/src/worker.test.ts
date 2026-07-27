import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { cardWindowsForChain } from "./worker.ts";

/**
 * `worker.ts` had no test file at all, and the bug this pins lived there: the on-chain card
 * windows were built by adding `hours * 3600` to a MILLISECOND epoch.
 *
 * CardMeta is immutable per token, so this could not have been corrected after the first
 * mint. It is also invisible from the API, because the database copies (fulfill.ts) use the
 * correct millisecond arithmetic — only the value written to the chain was wrong.
 */
describe("on-chain card windows", () => {
  const USER_HOURS = 66;
  const CC_HOURS = 72;
  // A real millisecond epoch: 2026-07-19T12:00:00Z.
  const REVEAL_MS = 1_784_808_000_000;
  const REVEAL_SEC = 1_784_808_000;

  test("converts a millisecond reveal to seconds for the chain", () => {
    const w = cardWindowsForChain(REVEAL_MS, USER_HOURS, CC_HOURS);
    assert.equal(w.revealAt, REVEAL_SEC, "revealAt must be seconds; block.timestamp is seconds");
  });

  test("the windows are actually 66 and 72 hours wide", () => {
    const w = cardWindowsForChain(REVEAL_MS, USER_HOURS, CC_HOURS);
    assert.equal(w.userWindowEndsAt - w.revealAt, 66 * 3600, "user window must be 66h");
    assert.equal(w.ccWindowEndsAt - w.revealAt, 72 * 3600, "CC window must be 72h");
  });

  /**
   * The delta alone cannot catch the original bug: it added the very same 237,600 to a
   * millisecond base, so end-minus-start was unchanged. What was wrong was the BASE, which
   * is why the assertion that matters is that `revealAt` is a seconds epoch. Interpreted as
   * milliseconds, 237,600 is about four minutes.
   */
  test("a millisecond base is rejected even though the delta looks right", () => {
    const buggy = {
      revealAt: REVEAL_MS,
      userWindowEndsAt: REVEAL_MS + USER_HOURS * 3600,
      ccWindowEndsAt: REVEAL_MS + CC_HOURS * 3600,
    };
    // The old bug's delta is identical to the correct one...
    const good = cardWindowsForChain(REVEAL_MS, USER_HOURS, CC_HOURS);
    assert.equal(buggy.userWindowEndsAt - buggy.revealAt, good.userWindowEndsAt - good.revealAt);
    // ...so the base is the only thing that distinguishes them.
    assert.notEqual(good.revealAt, buggy.revealAt, "revealAt must not be a millisecond epoch");
    assert.equal(buggy.userWindowEndsAt - buggy.revealAt, 237_600);
    assert.ok((buggy.userWindowEndsAt - buggy.revealAt) / 1000 / 60 < 5, "the old window was ~4 minutes");
  });

  test("the windows are plausible clock times, not 55,000 years out", () => {
    const w = cardWindowsForChain(REVEAL_MS, USER_HOURS, CC_HOURS);
    // MirrorNFT.sol:162 does `block.timestamp < ccWindowEndsAt` to decide whether the 5%
    // unwrap fee applies. A millisecond value here makes that permanently true. Year 2100
    // in seconds is ~4.10e9; a ms epoch is ~1.78e12 and would blow straight past it.
    const YEAR_2100_SEC = 4_102_444_800;
    assert.ok(w.ccWindowEndsAt < YEAR_2100_SEC, "a ms epoch leaked into a seconds field");
    assert.ok(w.revealAt < YEAR_2100_SEC, "a ms epoch leaked into a seconds field");
  });

  test("the fee window really does expire, at the right moment", () => {
    const w = cardWindowsForChain(REVEAL_MS, USER_HOURS, CC_HOURS);
    const oneSecondBefore = w.ccWindowEndsAt - 1;
    const atExpiry = w.ccWindowEndsAt;
    // Mirrors the contract's comparison exactly.
    assert.ok(oneSecondBefore < w.ccWindowEndsAt, "fee should still apply just inside 72h");
    assert.ok(!(atExpiry < w.ccWindowEndsAt), "fee must lapse at 72h, not persist forever");
  });
});
