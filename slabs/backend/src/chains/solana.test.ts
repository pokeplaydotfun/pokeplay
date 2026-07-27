import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decodeSolanaTx, assertTransactionIsSafeToSign, assertBuybackTransactionIsSafeToSign } from "./solana.ts";

/**
 * Transaction decoding, and the sell-back failure it caused.
 *
 * `signAndSend` did `Buffer.from(str, "base64")` unconditionally. deBridge's create-tx returns
 * the Solana-side transaction as 0x-prefixed HEX, and Buffer.from silently drops characters it
 * cannot decode instead of throwing, so the hex string became garbage of the wrong length and
 * deserialize died with "Reached end of buffer unexpectedly".
 *
 * That is the sell-back payout path, and it runs AFTER the card has been sold to CC. Every
 * sell-back would have ended with the card gone and the seller unpaid, deterministically.
 */
describe("decoding a serialised Solana transaction", () => {
  test("decodes the 0x-prefixed hex deBridge actually returns", () => {
    // Real shape: deBridge returned 1768 hex chars for an 883 byte transaction.
    const bytes = Buffer.from(Array.from({ length: 883 }, (_, i) => i % 256));
    const hex = `0x${bytes.toString("hex")}`;

    const decoded = decodeSolanaTx(hex);

    assert.equal(decoded.length, 883, "must recover the exact byte length");
    assert.ok(decoded.equals(bytes), "and the exact bytes");
  });

  test("the old base64 decode would have mangled it", () => {
    // Pins WHY this was silent: Buffer.from does not throw on invalid base64, it discards.
    const bytes = Buffer.from(Array.from({ length: 883 }, (_, i) => i % 256));
    const hex = `0x${bytes.toString("hex")}`;

    const wrong = Buffer.from(hex, "base64");

    assert.notEqual(wrong.length, 883, "wrong length is the whole bug");
    assert.ok(wrong.length > 0, "and it fails silently rather than throwing");
  });

  test("still decodes genuine base64, which is what CC sends", () => {
    // CC's pack transactions really are base64. Fixing the bridge must not break the buy.
    const bytes = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 7) % 256));
    const b64 = bytes.toString("base64");

    const decoded = decodeSolanaTx(b64);

    assert.equal(decoded.length, 512);
    assert.ok(decoded.equals(bytes));
  });

  test("round-trips both encodings of the same transaction to the same bytes", () => {
    const bytes = Buffer.from(Array.from({ length: 700 }, (_, i) => (i * 13) % 256));

    const viaHex = decodeSolanaTx(`0x${bytes.toString("hex")}`);
    const viaB64 = decodeSolanaTx(bytes.toString("base64"));

    assert.ok(viaHex.equals(viaB64), "encoding must not change the transaction");
    assert.ok(viaHex.equals(bytes));
  });

  test("tolerates surrounding whitespace", () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    assert.ok(decodeSolanaTx(`  0x${bytes.toString("hex")}\n`).equals(bytes));
  });

  test("a short base64 string is not mistaken for hex", () => {
    // "deadbeef" is valid hex AND valid base64. Short strings stay base64, because a real
    // transaction is never that small and CC's payloads are base64.
    const decoded = decodeSolanaTx("deadbeef");
    assert.ok(decoded.equals(Buffer.from("deadbeef", "base64")));
  });
});

/**
 * What the worker will and will not sign.
 *
 * It signs blobs handed to it over HTTPS by Collector Crypt and deBridge, unattended, with a
 * key that custodies every card we hold. Nothing inspected them: a compromised or impersonated
 * upstream could return a transaction sweeping the USDC account and every card, and the worker
 * would sign it. TLS was the only control.
 */
describe("what the worker refuses to sign", () => {
  const ME = "CARD7cmGjygGCSkrbXdxBN8Zr9Zd1fN1mjZdvSLqHuaN";
  const MPL_CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";

  // A minimal stand-in for a deserialized VersionedTransaction.
  const txWith = (programs: string[], feePayer = ME) => ({
    message: {
      staticAccountKeys: [feePayer, ...programs].map((k) => ({ toBase58: () => k })),
      compiledInstructions: programs.map((_, i) => ({ programIdIndex: i + 1 })),
    },
  }) as never;

  test("refuses a transaction touching MPL Core, the standard our cards use", () => {
    // This is the one that matters. Nothing we sign should ever move a custodied card, so a
    // transaction invoking MPL Core is precisely the transaction to refuse.
    assert.throws(
      () => assertTransactionIsSafeToSign(txWith([MPL_CORE]), ME),
      /not on the allowlist/,
    );
  });

  test("refuses to be a silent co-signer on somebody else's transaction", () => {
    assert.throws(
      () => assertTransactionIsSafeToSign(txWith(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], "SomeoneElse111"), ME),
      /fee payer/,
    );
  });

  test("accepts the programs a real CC pack purchase uses", () => {
    // Verified against a live generatePack response. The Memo program is load-bearing: CC
    // writes the order memo with it, and that memo IS our binding to the opened pack.
    assert.doesNotThrow(() =>
      assertTransactionIsSafeToSign(
        txWith([
          "ComputeBudget111111111111111111111111111111",
          "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        ]),
        ME,
      ),
    );
  });

  test("an unknown program is refused rather than waved through", () => {
    assert.throws(
      () => assertTransactionIsSafeToSign(txWith(["Fake11111111111111111111111111111111111111"]), ME),
      /not on the allowlist/,
    );
  });
});

describe("the sell-back signing guard", () => {
  const US = "CARD7cmGjygGCSkrbXdxBN8Zr9Zd1fN1mjZdvSLqHuaN";
  const MINT = "9oiCY3XLDdfUzDGdorR5ibUUf6PdBiamF37XNJ9gttQG";
  const OTHER_MINT = "So11111111111111111111111111111111111111112";
  const MPL_CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
  const CC = "GachaNgyXTU3zFogQ8Z5jR2BLXs8215X2AtEH18VxJq3";
  const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

  /**
   * Shaped from a REAL Collector Crypt /buyback build, decoded on 21 Jul 2026: compute budget,
   * one MPL Core transfer, an ATA create, an SPL Token transfer of our proceeds, and a memo —
   * with CC's gacha authority as fee payer and our wallet as the second signer.
   */
  const buybackTx = (opts: { feePayer?: string; coreAccounts?: string[]; coreCount?: number } = {}) => {
    const { feePayer = CC, coreAccounts = [US, MINT], coreCount = 1 } = opts;
    const keys = [feePayer, MPL_CORE, MEMO, US, MINT, OTHER_MINT];
    const idx = (k: string) => keys.indexOf(k);
    const core = Array.from({ length: coreCount }, () => ({
      programIdIndex: idx(MPL_CORE),
      accountKeyIndexes: coreAccounts.map(idx),
    }));
    return {
      message: {
        staticAccountKeys: keys.map((k) => ({ toBase58: () => k })),
        compiledInstructions: [...core, { programIdIndex: idx(MEMO), accountKeyIndexes: [] }],
      },
    } as never;
  };

  test("accepts a real buyback: CC pays, one card moves, and it is OUR card", () => {
    assert.doesNotThrow(() => assertBuybackTransactionIsSafeToSign(buybackTx(), US, MINT));
  });

  /**
   * The attack the MPL Core ban was written to stop, and the reason this exception is safe:
   * CC builds the transaction, so without this check they could return one that moves a
   * DIFFERENT card of ours and we would sign it.
   */
  test("refuses a transaction that moves a different card of ours", () => {
    assert.throws(
      () => assertBuybackTransactionIsSafeToSign(buybackTx({ coreAccounts: [US, OTHER_MINT] }), US, MINT),
      /does not reference/,
    );
  });

  test("refuses more than one card instruction", () => {
    assert.throws(
      () => assertBuybackTransactionIsSafeToSign(buybackTx({ coreCount: 2 }), US, MINT),
      /exactly one MPL Core instruction/,
    );
  });

  test("refuses a fee payer that is neither us nor Collector Crypt", () => {
    assert.throws(
      () => assertBuybackTransactionIsSafeToSign(buybackTx({ feePayer: "Attacker111" }), US, MINT),
      /neither this wallet nor/,
    );
  });

  test("the GENERAL guard still refuses all of this, so the exception stays narrow", () => {
    // The pack-purchase path must keep refusing MPL Core and foreign fee payers outright.
    assert.throws(() => assertTransactionIsSafeToSign(buybackTx(), US), /fee payer/);
  });
});
