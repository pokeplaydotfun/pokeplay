import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { exceedsValueLimit, valueLimitMessage } from "./policy.ts";

/**
 * The value ceiling. One implementation, shared by the API, the escrow sweeper and the UI,
 * because the recurring failure in this codebase has been two layers answering the same
 * question slightly differently.
 */
describe("the card value limit", () => {
  const usd = (n: number) => String(Math.round(n * 1e6)); // 6dp base units

  test("blocks a card above the limit", () => {
    assert.equal(exceedsValueLimit(usd(100.01), 100), true);
    assert.equal(exceedsValueLimit(usd(250), 100), true);
    assert.equal(exceedsValueLimit(usd(5000), 100), true);
  });

  test("allows a card below the limit", () => {
    assert.equal(exceedsValueLimit(usd(99.99), 100), false);
    assert.equal(exceedsValueLimit(usd(12), 100), false);
    assert.equal(exceedsValueLimit(usd(0), 100), false);
  });

  test("exactly at the limit is allowed", () => {
    // "Over $100" read strictly. A card insured at exactly $100.00 is not over it.
    assert.equal(exceedsValueLimit(usd(100), 100), false);
  });

  test("a cent decides it", () => {
    // Guards against a rounding shortcut that compares whole dollars.
    assert.equal(exceedsValueLimit("100000000", 100), false); // $100.000000
    assert.equal(exceedsValueLimit("100000001", 100), true); // $100.000001
  });

  test("an unknown value is refused, not waved through", () => {
    // A card we cannot price is a card we cannot confirm is under the cap. Refusing is the
    // safe direction, and it matches the sell path already declining to quote without one.
    assert.equal(exceedsValueLimit(null, 100), true);
    assert.equal(exceedsValueLimit(undefined, 100), true);
    assert.equal(exceedsValueLimit("", 100), true);
    assert.equal(exceedsValueLimit("not-a-number", 100), true);
  });

  test("a limit of 0 disables the cap", () => {
    assert.equal(exceedsValueLimit(usd(999_999), 0), false);
    // Including for cards with no known value, since there is nothing to compare against.
    assert.equal(exceedsValueLimit(null, 0), false);
  });

  test("the limit is configurable, not hardcoded to 100", () => {
    assert.equal(exceedsValueLimit(usd(250), 500), false);
    assert.equal(exceedsValueLimit(usd(600), 500), true);
  });

  test("a malformed limit does not throw", () => {
    // This runs inside the escrow sweeper. Throwing there would strand the very cards it
    // exists to hand back.
    assert.doesNotThrow(() => exceedsValueLimit(usd(250), undefined as unknown as number));
    assert.doesNotThrow(() => exceedsValueLimit(usd(250), NaN));
  });

  test("the user-facing message is generic and names no threshold", () => {
    // Operator's call: users see a plain unavailable notice, not the dollar figure. The
    // specific reason still travels in `code` and `limitUsd` for support and debugging.
    const m = valueLimitMessage(100);
    assert.equal(m, "This feature is temporarily unavailable.");
    assert.doesNotMatch(m, /\$|\d/, "the threshold must not leak into user copy");
    assert.doesNotMatch(m, /—/, "no em dashes in user-facing copy");
  });

  test("the message does not change with the limit", () => {
    // Guards against someone reintroducing interpolation and leaking the number.
    assert.equal(valueLimitMessage(100), valueLimitMessage(5000));
  });
});
