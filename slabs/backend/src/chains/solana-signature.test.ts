import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import bs58 from "bs58";
import { verifySolanaSignature, checkNonce, depositMessage, DEPOSIT_SIGNATURE_TTL_MS } from "./solana-signature.ts";

function wallet() {
  const kp = generateKeyPairSync("ed25519");
  const raw = kp.publicKey.export({ format: "der", type: "spki" }).subarray(12);
  return {
    address: bs58.encode(raw),
    sign: (m: string) => bs58.encode(cryptoSign(null, Buffer.from(m, "utf8"), kp.privateKey)),
  };
}

describe("proving a depositor owns the sending wallet", () => {
  const MINT = "9oiCY3XLDdfUzDGdorR5ibUUf6PdBiamF37XNJ9gttQG";
  // A fixture address. Deliberately not anyone's real wallet — a public test file is no
  // place to tie a person to this project.
  const EVM = "0x1111111111111111111111111111111111111111";

  test("accepts a genuine signature", () => {
    const w = wallet();
    const msg = depositMessage(MINT, EVM, Date.now());
    assert.deepEqual(verifySolanaSignature(msg, w.sign(msg), w.address), { ok: true });
  });

  /**
   * THE ATTACK. Anyone watching the vault could see a card arrive and claim it first with
   * their own EVM address. The depositor would have handed over a real card for nothing.
   */
  test("refuses a signature from a different wallet", () => {
    const alice = wallet();
    const mallory = wallet();
    const msg = depositMessage(MINT, EVM, Date.now());
    assert.equal(verifySolanaSignature(msg, mallory.sign(msg), alice.address).ok, false);
  });

  /** The message binds card AND destination, so a signature cannot be moved to another card. */
  test("a signature for one card does not authorise another", () => {
    const w = wallet();
    const signed = depositMessage(MINT, EVM, 1_700_000_000_000);
    const other = depositMessage("SomeOtherMint1111111111111111111111111111111", EVM, 1_700_000_000_000);
    assert.equal(verifySolanaSignature(other, w.sign(signed), w.address).ok, false);
  });

  /** Nor to redirect the mirror to a different Robinhood address. */
  test("a signature does not authorise a different destination", () => {
    const w = wallet();
    const signed = depositMessage(MINT, EVM, 1_700_000_000_000);
    const other = depositMessage(MINT, "0x000000000000000000000000000000000000dEaD", 1_700_000_000_000);
    assert.equal(verifySolanaSignature(other, w.sign(signed), w.address).ok, false);
  });

  test("garbage is refused rather than throwing", () => {
    assert.equal(verifySolanaSignature("m", "not-base58-!!", "also-bad").ok, false);
    assert.equal(verifySolanaSignature("m", bs58.encode(Buffer.alloc(10)), bs58.encode(Buffer.alloc(32))).ok, false);
  });

  test("a stale signature expires", () => {
    const now = Date.now();
    assert.equal(checkNonce(now, now).ok, true);
    assert.equal(checkNonce(now - DEPOSIT_SIGNATURE_TTL_MS - 1, now).ok, false);
  });

  test("a future-dated nonce is refused", () => {
    const now = Date.now();
    assert.equal(checkNonce(now + 600_000, now).ok, false);
  });
});
