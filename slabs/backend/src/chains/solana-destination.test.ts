import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { checkDestinationFormat, checkDestinationAccount } from "./solana-destination.ts";

/**
 * The guard that replaces `isOnCurve`.
 *
 * A withdraw is irreversible and has no recovery path: once an MPL Core asset leaves custody
 * to an address nobody holds a key for, the physical card behind it is gone. The previous
 * guard treated on-curve as "is a real wallet", which let the all-zeros System Program
 * through, and a real card was destroyed that way.
 *
 * The first test below is that exact address. It is the regression that matters most.
 */

const REAL_WALLET = "CARD7cmGjygGCSkrbXdxBN8Zr9Zd1fN1mjZdvSLqHuaN"; // our custody wallet
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

describe("the address that destroyed a card", () => {
  test("the all-zeros System Program is refused", () => {
    const v = checkDestinationFormat(SYSTEM_PROGRAM);
    assert.equal(v.ok, false, "this exact address cost a real card; it must never pass again");
    assert.match((v as { reason: string }).reason, /System Program/);
  });

  test("it is refused DESPITE being on curve", () => {
    // Pinning the reason the old guard failed: this address satisfies isOnCurve. If a future
    // rewrite reaches for isOnCurve alone again, this documents why that is not enough.
    assert.equal(
      PublicKey.isOnCurve(new PublicKey(SYSTEM_PROGRAM).toBytes()),
      true,
      "if this ever becomes false, the original bug would have been caught by isOnCurve",
    );
    assert.equal(checkDestinationFormat(SYSTEM_PROGRAM).ok, false);
  });
});

describe("known unspendable destinations", () => {
  for (const [addr, what] of [
    ["1nc1nerator11111111111111111111111111111111", "incinerator"],
    ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "SPL Token Program"],
    ["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "Token-2022"],
    ["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "ATA Program"],
    ["CoreZNqcix5Cy6vJKY1Tk8ZPh9CsLqNjMbjnJPvUJcC", "MPL Core Program"],
    ["So11111111111111111111111111111111111111112", "wrapped SOL mint"],
  ] as const) {
    test(`refuses ${what}`, () => {
      assert.equal(checkDestinationFormat(addr).ok, false, `${addr} must never receive a card`);
    });
  }
});

describe("malformed input", () => {
  const bad: [string, string][] = [
    ["", "empty"],
    ["   ", "whitespace"],
    ["not an address", "prose"],
    ["0xAbC1230000000000000000000000000000000000", "an Ethereum address"],
    ["IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII", "confusable characters"],
  ];
  for (const [input, what] of bad) {
    test(`refuses ${what}`, () => {
      assert.equal(checkDestinationFormat(input).ok, false, `"${input}" must not pass`);
    });
  }

  test("an off-curve address is refused as a PDA", () => {
    // Derived, so it is off-curve by construction and no key exists for it.
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pwa-test")],
      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    );
    const v = checkDestinationFormat(pda.toBase58());
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /off-curve|program-derived/);
  });
});

describe("a real wallet is allowed", () => {
  test("accepts an ordinary address", () => {
    const v = checkDestinationFormat(REAL_WALLET);
    assert.equal(v.ok, true, "a legitimate wallet must not be blocked");
  });

  test("surrounding whitespace is tolerated, not rejected", () => {
    // Users paste from Discord. Trimming is kinder than refusing, and changes nothing about safety.
    const v = checkDestinationFormat(`  ${REAL_WALLET}  `);
    assert.equal(v.ok, true);
    assert.equal((v as { address: string }).address, REAL_WALLET);
  });
});

describe("the on-chain half", () => {
  test("a wallet that does not exist yet is allowed", () => {
    // A brand new wallet has no account on chain. Refusing it would block real withdraws.
    const v = checkDestinationAccount(REAL_WALLET, { exists: false, executable: false, owner: null });
    assert.equal(v.ok, true, "a fresh wallet is the normal case, not a suspicious one");
  });

  test("an existing ordinary wallet is allowed", () => {
    const v = checkDestinationAccount(REAL_WALLET, { exists: true, executable: false, owner: SYSTEM_PROGRAM });
    assert.equal(v.ok, true);
  });

  test("an executable account is refused even if it looks like a wallet", () => {
    // This is the check that catches a program whose id happens to be on curve and is not in
    // the hardcoded list — the case the denylist cannot cover.
    const v = checkDestinationAccount(REAL_WALLET, { exists: true, executable: true, owner: SYSTEM_PROGRAM });
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /executable program/);
  });

  test("an account owned by something other than the System Program is refused", () => {
    const v = checkDestinationAccount(REAL_WALLET, {
      exists: true, executable: false, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    });
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /not the System Program/);
  });
});

/**
 * What this guard CANNOT do.
 *
 * Documented as a passing test rather than a comment, because the failure it describes is
 * silent and permanent, and because a future reader is entitled to know the limit rather than
 * infer safety from the length of the list above.
 */
describe("the limit: a typo is usually still a valid address", () => {
  test("dropping a character yields a different, entirely valid wallet", () => {
    const typo = "CARD7cmGjygGCSkrbXdxBN8Zr9Zd1fN1mjZdvSLqHua"; // REAL_WALLET minus one char
    const pk = new PublicKey(typo);

    assert.equal(pk.toBytes().length, 32, "still decodes to a full 32-byte key");
    assert.equal(pk.toBase58(), typo, "still canonical");
    assert.equal(PublicKey.isOnCurve(pk.toBytes()), true, "still on curve");
    assert.notEqual(typo, REAL_WALLET, "but it is a DIFFERENT wallet");

    // So the format guard passes it, and it must — there is nothing wrong with the address
    // itself. Solana addresses are 32 to 44 characters depending on leading zero bytes, so
    // length proves nothing either.
    assert.equal(checkDestinationFormat(typo).ok, true, "no format check can catch this");
  });

  test("requiring the destination to exist is what actually mitigates it", () => {
    const typo = "CARD7cmGjygGCSkrbXdxBN8Zr9Zd1fN1mjZdvSLqHua";
    const unused = { exists: false, executable: false, owner: null };

    // Permissive: a typo to an unused address sails through and the card is lost.
    assert.equal(checkDestinationAccount(typo, unused, false).ok, true);

    // Strict: it is stopped, because a random typo lands on an unused address essentially
    // always, while a wallet a user actually controls has almost certainly been used.
    const strict = checkDestinationAccount(typo, unused, true);
    assert.equal(strict.ok, false);
    assert.match((strict as { reason: string }).reason, /never been used|small amount of SOL/);
  });

  test("strict mode still allows a wallet that has been used", () => {
    const v = checkDestinationAccount(
      REAL_WALLET,
      { exists: true, executable: false, owner: SYSTEM_PROGRAM },
      true,
    );
    assert.equal(v.ok, true, "strictness must not block legitimate withdraws");
  });
});
