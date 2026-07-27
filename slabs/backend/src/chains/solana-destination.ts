/**
 * Is this Solana address safe to send an irreversible, unrecoverable card to?
 *
 * WHY THIS FILE EXISTS. The previous guard was `PublicKey.isOnCurve(dest)`, used to mean "is
 * this a real wallet". It is not that check. On-curve means only "these bytes COULD be an
 * ed25519 public key", which is true of roughly half of all random byte strings, of the
 * all-zeros System Program address, and of plenty of program ids. A card was transferred to
 * `11111111111111111111111111111111` — which passes isOnCurve — and is gone permanently. That
 * mistake cost $35 and a physical card.
 *
 * Verified empirically, not assumed:
 *
 *   11111111111111111111111111111111              PASSES isOnCurve   (System Program)
 *   TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA   PASSES isOnCurve   (SPL Token Program)
 *   1nc1nerator11111111111111111111111111111111   rejected           (by luck; it is off-curve)
 *
 * So on-curve is kept as ONE necessary check and never as the decision.
 *
 * The checks split in two deliberately. `checkDestinationFormat` is pure and needs no network,
 * so it can be exercised exhaustively in tests and run in the API before anything is burned.
 * The on-chain half needs an RPC and answers the question format cannot: is there already an
 * account here, and is it a program rather than a wallet.
 */
import { PublicKey } from "@solana/web3.js";

/**
 * Addresses that are valid, on-curve, and permanently unspendable.
 *
 * Not an exhaustive list of bad destinations — no such list exists, which is why the on-chain
 * executable check matters too. These are the ones a user or a bug is most likely to produce.
 */
const NEVER_SEND_TO: Record<string, string> = {
  "11111111111111111111111111111111": "the System Program (all zeros) — this is where the lost card went",
  "1nc1nerator11111111111111111111111111111111": "a known burn address",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "the SPL Token Program",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "the Token-2022 Program",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "the Associated Token Account Program",
  CoreZNqcix5Cy6vJKY1Tk8ZPh9CsLqNjMbjnJPvUJcC: "the MPL Core Program",
  So11111111111111111111111111111111111111112: "the wrapped SOL mint",
};

export type DestinationVerdict =
  | { ok: true; address: string }
  | { ok: false; reason: string };

/**
 * Format and known-bad checks. Pure: no network, no clock, no state.
 *
 * Safe to call before a burn, from the API, to tell a user their address is wrong while they
 * can still do something about it.
 */
export function checkDestinationFormat(destination: string): DestinationVerdict {
  const raw = destination?.trim();
  if (!raw) return { ok: false, reason: "No destination address was given." };

  // Base58 alphabet excludes 0, O, I and l precisely because they are confusable. Rejecting
  // them by hand gives a better message than "Non-base58 character".
  if (/[0OIl]/.test(raw)) {
    return { ok: false, reason: `"${raw}" contains 0, O, I or l, which never appear in a Solana address.` };
  }

  let pk: PublicKey;
  try {
    pk = new PublicKey(raw);
  } catch {
    return { ok: false, reason: `"${raw}" is not a valid Solana address.` };
  }

  // new PublicKey accepts anything that decodes to 32 bytes; re-encoding catches inputs that
  // decoded to something other than their canonical form.
  if (pk.toBase58() !== raw) {
    return { ok: false, reason: `"${raw}" is not a canonical Solana address.` };
  }

  const known = NEVER_SEND_TO[raw];
  if (known) {
    return { ok: false, reason: `${raw} is ${known}. A card sent there is destroyed, not delivered.` };
  }

  /**
   * Off-curve means a program-derived address: no private key exists for it, anywhere, ever.
   * Necessary but nowhere near sufficient — see the file header.
   */
  if (!PublicKey.isOnCurve(pk.toBytes())) {
    return {
      ok: false,
      reason:
        `${raw} is off-curve, so it is a program-derived address rather than a wallet. ` +
        `Nobody holds a key for it and the card would be unrecoverable.`,
    };
  }

  return { ok: true, address: pk.toBase58() };
}

/** The shape of an account as the RPC reports it, narrowed to what this check needs. */
export type AccountSnapshot = { exists: boolean; executable: boolean; owner: string | null };

/** The System Program owns ordinary wallet accounts. Anything else owns a program's data. */
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/**
 * The half of the check that needs the chain.
 *
 * A destination that does not exist yet is FINE and must stay allowed: a fresh wallet that has
 * never held SOL has no account on chain, and refusing it would block legitimate withdraws to
 * new wallets. What we are looking for is an account that exists and is demonstrably not a
 * wallet.
 */
export function checkDestinationAccount(
  destination: string,
  account: AccountSnapshot,
  /**
   * Require the destination to already exist on chain.
   *
   * THE LIMIT THIS EXISTS FOR. No format check can catch a typo, because a mistyped address is
   * usually still a VALID address. Solana addresses run 32 to 44 characters depending on
   * leading zero bytes, so dropping a character from a real wallet can yield another perfectly
   * canonical, on-curve address — a different wallet, which nobody holds a key for. Every
   * check in this file passes it. The card is then gone, exactly as if it had been burned.
   *
   * Requiring the account to exist does not prove the user holds its key, but it does mean the
   * address has been used before, which a random typo essentially never is. The cost is that a
   * brand-new wallet must receive a little SOL before it can receive a card — the same "prove
   * it is real before it holds something irreplaceable" step we apply to owner keys.
   *
   * Off by default so it is a deliberate operator choice, and so this function stays honest
   * about what it can and cannot promise.
   */
  requireExists = false,
): DestinationVerdict {
  if (!account.exists) {
    if (requireExists) {
      return {
        ok: false,
        reason:
          `${destination} has never been used on Solana. A mistyped address is usually still a ` +
          `valid one, so we cannot tell a typo from a new wallet. Send a small amount of SOL to ` +
          `this address first, then withdraw.`,
      };
    }
    return { ok: true, address: destination };
  }

  if (account.executable) {
    return {
      ok: false,
      reason: `${destination} is an executable program, not a wallet. A card sent there cannot be moved again.`,
    };
  }

  if (account.owner && account.owner !== SYSTEM_PROGRAM) {
    return {
      ok: false,
      reason:
        `${destination} is owned by ${account.owner}, not the System Program, so it is a program's ` +
        `account rather than a wallet.`,
    };
  }

  return { ok: true, address: destination };
}
