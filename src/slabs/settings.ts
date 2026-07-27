/**
 * Per-wallet local settings.
 *
 * Keyed by the connected Robinhood Chain address, so switching accounts never leaks one
 * user's payout address into another's session.
 *
 * Two layers. The SERVER is the real store, so a withdraw address survives a logout, a new
 * browser and a new device. localStorage is a cache in front of it, so the page renders
 * instantly and still works if the API is briefly unreachable.
 *
 * Writes are signed by the wallet before the server accepts them, so nobody can set somebody
 * else's withdraw address.
 *
 * IMPORTANT: what is stored here is a CONVENIENCE, not an authority. The withdraw flow binds
 * the Solana destination on chain, inside `burnForUnwrap`, signed by the token owner in the
 * same transaction as the burn. The worker reads the destination from the `UnwrapRequested`
 * event and never from this store or any database. That is deliberate: it means tampering
 * with stored settings cannot redirect somebody's card.
 */

const KEY = "pwa:settings:v1";

export type WalletSettings = {
  /** Base58 Solana address that withdrawals are pre-filled with. */
  solanaAddress?: string;
};

type AllSettings = Record<string, WalletSettings>;

function readAll(): AllSettings {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as AllSettings;
  } catch {
    return {};
  }
}

export function getSettings(address: string | undefined): WalletSettings {
  if (!address) return {};
  return readAll()[address.toLowerCase()] ?? {};
}

export function saveSettings(address: string, patch: WalletSettings): void {
  const all = readAll();
  const key = address.toLowerCase();
  all[key] = { ...all[key], ...patch };
  localStorage.setItem(KEY, JSON.stringify(all));
}

export function clearSolanaAddress(address: string): void {
  const all = readAll();
  const key = address.toLowerCase();
  if (all[key]) {
    delete all[key].solanaAddress;
    localStorage.setItem(KEY, JSON.stringify(all));
  }
}

/* ------------------------------------------------------------------ validation */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const body = hex === "0" ? new Uint8Array() : Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
  const pad = s.length - s.replace(/^1+/, "").length;
  return Uint8Array.from([...new Uint8Array(pad), ...body]);
}

/**
 * Is this point actually on the ed25519 curve?
 *
 * A valid-looking 32-byte address can still be a Program Derived Address, which is derived
 * specifically so that NO private key exists for it. Sending a card to one strands it
 * permanently with nobody able to sign a transfer back out. Rejecting off-curve addresses is
 * the single most valuable check here, because every other mistake is at least recoverable
 * by whoever holds the key.
 *
 * Implements the standard decompression check: recover x from y and verify x*x*(...)= ...
 * over the field, which is what ed25519 point validation reduces to.
 */
function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  const P = (1n << 255n) - 19n;
  const D = -4513249062541557337682894930092624173785641285191125241628941591882900924598840740n % P;
  const d = ((D % P) + P) % P;

  const mod = (a: bigint) => ((a % P) + P) % P;
  const pow = (b: bigint, e: bigint) => {
    let r = 1n;
    b = mod(b);
    while (e > 0n) {
      if (e & 1n) r = mod(r * b);
      b = mod(b * b);
      e >>= 1n;
    }
    return r;
  };

  // Little-endian, top bit is the sign of x and not part of y.
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]!);
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;

  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(d * y2 + 1n);

  // x = u * v^3 * (u * v^7)^((P-5)/8), then check x^2 * v == ±u.
  const v3 = mod(v * mod(v * v));
  const v7 = mod(v3 * mod(v3 * v));
  let x = mod(mod(u * v3) * pow(mod(u * v7), (P - 5n) / 8n));

  const check = mod(mod(x * x) * v);
  if (check === u) return true;
  if (check === mod(-u)) {
    x = mod(x * pow(2n, (P - 1n) / 4n));
    return mod(mod(x * x) * v) === u;
  }
  return false;
}

export type AddressCheck = { ok: true; bytes: Uint8Array } | { ok: false; reason: string };

/**
 * Addresses that are valid, on-curve, and permanently unspendable.
 *
 * MUST MIRROR `NEVER_SEND_TO` in backend/src/chains/solana-destination.ts. Kept in both places
 * on purpose, because they guard different moments and only one of them can save the user:
 * the backend check runs AFTER `burnForUnwrap` has already destroyed the mirror, so the most
 * it can do is hold the request for a human. This one runs BEFORE the signature, which is the
 * only point where the answer is still "nothing happened".
 *
 * Every entry here passes the on-curve test below — that test answers "could these bytes be an
 * ed25519 key", not "is anyone home". `11111111111111111111111111111111` passes it, and a card
 * sent there is gone; that already happened once and cost $35 and a physical card.
 */
const NEVER_SEND_TO: Record<string, string> = {
  "11111111111111111111111111111111": "the System Program",
  "1nc1nerator11111111111111111111111111111111": "a known burn address",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "the SPL Token Program",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "the Token-2022 Program",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "the Associated Token Account Program",
  CoreZNqcix5Cy6vJKY1Tk8ZPh9CsLqNjMbjnJPvUJcC: "the MPL Core Program",
  So11111111111111111111111111111111111111112: "the wrapped SOL mint",
};

/**
 * Validate a Solana address hard enough that a typo cannot cost somebody a graded card.
 * Every failure mode here is permanent once a withdrawal is signed.
 */
export function checkSolanaAddress(input: string): AddressCheck {
  const s = input.trim();
  if (!s) return { ok: false, reason: "Enter a Solana address." };
  if (s.length < 32 || s.length > 44) {
    return { ok: false, reason: `That looks too ${s.length < 32 ? "short" : "long"} for a Solana address. They are 32 to 44 characters.` };
  }
  const bytes = base58Decode(s);
  if (!bytes) return { ok: false, reason: "That contains characters a Solana address cannot have. Check for a typo, or paste it again." };
  if (bytes.length !== 32) {
    return { ok: false, reason: "That is not quite a complete Solana address. A character looks to be missing or extra." };
  }

  /**
   * Checked BEFORE the curve test, because every one of these passes that test.
   *
   * Without this the flow was: user pastes a program address, this function approves it, the
   * mirror is burned, and only then does the relayer's denylist catch it — leaving a user with
   * no mirror, no card, and a request that needs a human. The card survives; their token does
   * not. Stopping here costs them nothing.
   */
  const known = NEVER_SEND_TO[s];
  if (known) {
    return {
      ok: false,
      reason: `That is ${known}, not a wallet. A card sent there would be destroyed rather than delivered.`,
    };
  }

  if (!isOnCurve(bytes)) {
    return {
      ok: false,
      reason: "Nobody can control that address, so a card sent there would be lost for good. It looks like a program address rather than a wallet.",
    };
  }
  return { ok: true, bytes };
}

/** 0x-prefixed 32 byte hex, the form `burnForUnwrap` takes for the destination. */
export function solanaAddressToHex(bytes: Uint8Array): `0x${string}` {
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
}

/* ------------------------------------------------------------------ server sync */

import { API_BASE } from "./client.ts";
import { SIGNING_NS } from "./brand.ts";

/** The exact text the API verifies. Must match settingsMessage() in the backend. */
export const settingsMessage = (solanaAddress: string, nonce: number) =>
  `${SIGNING_NS}: set my withdraw address to ${solanaAddress}\nTimestamp: ${nonce}`;

/**
 * Load from the server, falling back to the local cache.
 *
 * The server wins when it answers: it is the copy that followed the user here from whatever
 * device they last used. The cache only covers the case where the API is unreachable, where
 * showing the last known address beats showing nothing.
 */
/** The exact text the API verifies for a settings READ. Must match readSettingsMessage(). */
export const readSettingsMessage = (address: string, nonce: number) =>
  `${SIGNING_NS}: read my withdraw address for ${address}\nTimestamp: ${nonce}`;

/**
 * Read this wallet's withdraw address from the server.
 *
 * `sign` is OPTIONAL, and that is the whole design. The server now requires a signature —
 * an open read let anyone walk the leaderboard's EVM addresses and harvest every user's
 * Solana wallet alongside it — but demanding a wallet prompt on every page load to show
 * someone their own saved address would be a miserable trade.
 *
 * So: without a signer this returns the LOCAL cache, which is correct for the common case of
 * the same device. Callers that genuinely need the server's copy — the withdraw screen, where
 * a stale address would send a card to the wrong wallet — pass one and get an authenticated
 * read that also refreshes the cache.
 */
export async function loadSolanaAddress(
  address: string | undefined,
  sign?: (message: string) => Promise<string>,
): Promise<string | undefined> {
  const cached = getSettings(address).solanaAddress;
  if (!address || !API_BASE) return cached;
  if (!sign) return cached;

  try {
    const nonce = Date.now();
    const signature = await sign(readSettingsMessage(address, nonce));
    const res = await fetch(
      `${API_BASE}/settings/${address}?nonce=${nonce}&signature=${encodeURIComponent(signature)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return cached;
    const body = (await res.json()) as { solanaAddress: string | null };
    const remote = body.solanaAddress ?? undefined;
    // Keep the cache in step so the next load paints immediately.
    if (remote) saveSettings(address, { solanaAddress: remote });
    else if (cached) clearSolanaAddress(address);
    return remote;
  } catch {
    return cached;
  }
}

/**
 * Persist, signing first so the server can prove the request came from this wallet.
 *
 * Writes the cache regardless, so the setting is never lost just because the API was down;
 * the next successful load reconciles.
 */
export async function persistSolanaAddress(
  address: string,
  solanaAddress: string | null,
  signMessage: (message: string) => Promise<`0x${string}`>,
): Promise<{ synced: boolean }> {
  if (solanaAddress) saveSettings(address, { solanaAddress });
  else clearSolanaAddress(address);

  if (!API_BASE) return { synced: false };

  const nonce = Date.now();
  const signature = await signMessage(settingsMessage(solanaAddress ?? "", nonce));
  const res = await fetch(`${API_BASE}/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, solanaAddress, nonce, signature }),
    signal: AbortSignal.timeout(12_000),
  });
  return { synced: res.ok };
}
