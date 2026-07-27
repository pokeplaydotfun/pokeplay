/**
 * Verify that a Solana wallet signed a message.
 *
 * WHY THIS EXISTS. A deposit claim says "this card is mine, mint the mirror to this Robinhood
 * address". Without proving the claimer controls the wallet that SENT the card, the claim is
 * front-runnable: anyone watching the vault for an incoming card could claim it first with
 * their own EVM address and take the mirror. The depositor would have handed over a real card
 * and received nothing.
 *
 * Uses Node's own ed25519 rather than a library. A Solana public key is a raw 32-byte ed25519
 * key, and Node's verifier wants SPKI DER — so the key is wrapped in the fixed 12-byte prefix
 * that turns one into the other. That prefix is a constant of the format, not a guess.
 */
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import bs58 from "bs58";

/** SPKI DER header for an ed25519 public key. Fixed by RFC 8410. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * The exact text a depositor signs. Binds the CARD and the DESTINATION together, so a
 * signature captured for one deposit cannot be replayed to redirect another.
 *
 * Must match `depositMessage` in the frontend exactly, including the newline.
 */
export const depositMessage = (solanaMint: string, evmAddress: string, nonce: number) =>
  `${process.env.SIGNING_NS ?? "Slabs"}: deposit ${solanaMint}\nMint the mirror to ${evmAddress}\nTimestamp: ${nonce}`;

/** How long a signed claim stays valid. Long enough to be usable, short enough to not linger. */
export const DEPOSIT_SIGNATURE_TTL_MS = 10 * 60_000;

export type SignatureVerdict = { ok: true } | { ok: false; reason: string };

export function verifySolanaSignature(
  message: string,
  signatureBase58: string,
  signerBase58: string,
): SignatureVerdict {
  let signature: Uint8Array;
  let signer: Uint8Array;
  try {
    signature = bs58.decode(signatureBase58);
    signer = bs58.decode(signerBase58);
  } catch {
    return { ok: false, reason: "The signature or signer is not valid base58." };
  }

  if (signature.length !== 64) return { ok: false, reason: "That is not an ed25519 signature." };
  if (signer.length !== 32) return { ok: false, reason: "That is not a Solana public key." };

  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(signer)]),
      format: "der",
      type: "spki",
    });
    const ok = cryptoVerify(null, Buffer.from(message, "utf8"), key, Buffer.from(signature));
    return ok ? { ok: true } : { ok: false, reason: "That signature does not match the wallet." };
  } catch {
    // A malformed key reaches here rather than throwing out of the request.
    return { ok: false, reason: "That signature could not be checked." };
  }
}

/** Rejects a stale or future-dated nonce, so a captured signature cannot be replayed later. */
export function checkNonce(nonce: number, now = Date.now()): SignatureVerdict {
  if (!Number.isFinite(nonce)) return { ok: false, reason: "Missing timestamp." };
  const age = now - nonce;
  if (age > DEPOSIT_SIGNATURE_TTL_MS) return { ok: false, reason: "That request expired. Try again." };
  // A little future tolerance for clock skew, but not an open door.
  if (age < -60_000) return { ok: false, reason: "That request is dated in the future." };
  return { ok: true };
}
