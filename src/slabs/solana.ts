/**
 * Talking to a Solana wallet, for deposits.
 *
 * Uses the wallet's INJECTED provider directly rather than @solana/wallet-adapter. The adapter
 * pulls in a large dependency tree for a feature one page uses, and the thing it abstracts —
 * connect, signMessage, signAndSendTransaction — is three methods that Phantom, Solflare and
 * Backpack all expose identically.
 *
 * Deliberately parallel to the EVM side rather than merged with it: a user has two wallets
 * here, on two chains, and pretending otherwise is how a card ends up sent to an address
 * nobody controls.
 */
import { VersionedTransaction, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { SIGNING_NS } from "./brand.ts";

type SolanaProvider = {
  isPhantom?: boolean;
  publicKey?: { toBase58(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toBase58(): string } }>;
  disconnect?(): Promise<void>;
  signMessage(message: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array }>;
  signAndSendTransaction(tx: VersionedTransaction | Transaction): Promise<{ signature: string }>;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    solana?: SolanaProvider & { isPhantom?: boolean; isTrust?: boolean; isSolflare?: boolean };
    phantom?: { solana?: SolanaProvider };
    solflare?: SolanaProvider;
    backpack?: SolanaProvider;
    glow?: SolanaProvider;
    glowSolana?: SolanaProvider;
    coinbaseSolana?: SolanaProvider;
    okxwallet?: { solana?: SolanaProvider };
    exodus?: { solana?: SolanaProvider };
    trustwallet?: { solana?: SolanaProvider };
    braveSolana?: SolanaProvider;
  }
}

export type SolanaWalletKey =
  | "phantom" | "solflare" | "backpack" | "glow"
  | "coinbase" | "okx" | "exodus" | "trust" | "brave" | "injected";

/** color: the wallet's brand colour, for the picker badge. */
export type DetectedWallet = { key: SolanaWalletKey; name: string; color: string; provider: SolanaProvider };

/**
 * A provider is only usable if it actually exposes the three methods the deposit flow calls.
 * Guarding on this means a global that merely EXISTS (an EVM-only shim, a stub) is never
 * offered as a Solana wallet the user can pick and then watch fail mid-deposit.
 */
function usable(p: unknown): p is SolanaProvider {
  const q = p as any;
  return !!q && typeof q.connect === "function" && typeof q.signMessage === "function" && typeof q.signAndSendTransaction === "function";
}

/**
 * Every injected Solana wallet, not just the first one found.
 *
 * Detection is by each wallet's own global. window.solana is whichever wallet claimed it,
 * usually Phantom, so reading only that meant anyone running Solflare/Backpack/etc. alongside
 * was silently connected to Phantom — a wallet that may hold none of their cards.
 *
 * Note: this finds wallets that inject a Phantom-compatible provider. A Solana wallet that only
 * registers via the newer Wallet Standard (and injects no global) will not appear here — the
 * common ones all still inject. EVM-only wallets (MetaMask) have no Solana provider and are
 * correctly absent.
 *
 * Deduplicated by provider identity: several wallets write themselves to more than one global,
 * and the same object listed twice reads as two wallets that both do nothing.
 */
export function detectSolanaWallets(): DetectedWallet[] {
  if (typeof window === "undefined") return [];
  const w = window;
  const found: DetectedWallet[] = [];
  const push = (key: SolanaWalletKey, name: string, color: string, provider: unknown) => {
    if (!usable(provider)) return;
    if (found.some((f) => f.provider === provider)) return;
    found.push({ key, name, color, provider });
  };

  // Phantom identifies itself; window.solana is only Phantom if it says so.
  push("phantom", "Phantom", "#ab9ff2", w.phantom?.solana ?? (w.solana?.isPhantom ? w.solana : undefined));
  push("solflare", "Solflare", "#fc7227", w.solflare ?? (w.solana?.isSolflare ? w.solana : undefined));
  push("backpack", "Backpack", "#e33e3f", w.backpack);
  push("glow", "Glow", "#00d18c", w.glow ?? w.glowSolana);
  push("coinbase", "Coinbase Wallet", "#0052ff", w.coinbaseSolana);
  push("okx", "OKX Wallet", "#1f1f1f", w.okxwallet?.solana);
  push("exodus", "Exodus", "#1a1e2e", w.exodus?.solana);
  push("trust", "Trust", "#3375bb", w.trustwallet?.solana ?? (w.solana?.isTrust ? w.solana : undefined));
  push("brave", "Brave Wallet", "#fb542b", w.braveSolana);

  // A usable window.solana that matched none of the flags above — offer it, honestly labelled,
  // rather than dropping a wallet the user clearly has.
  if (w.solana && !found.some((f) => f.provider === w.solana)) {
    push("injected", "Browser wallet", "#6b7280", w.solana);
  }
  return found;
}

/**
 * The wallet the user picked, for the life of the page.
 *
 * Module-level rather than component state on purpose: signDepositClaim and
 * sendDepositTransfer both resolve their own provider, so without this a deposit could be
 * transferred from the chosen wallet and then signed by a different one. The signature would
 * not match the sender and the claim would be rejected after the card had already moved.
 */
let selected: SolanaProvider | null = null;

export function selectSolanaWallet(key: SolanaWalletKey): void {
  selected = detectSolanaWallets().find((w) => w.key === key)?.provider ?? null;
}

export function solanaProvider(): SolanaProvider | null {
  if (typeof window === "undefined") return null;
  return selected ?? detectSolanaWallets()[0]?.provider ?? null;
}

export const hasSolanaWallet = () => solanaProvider() !== null;

export async function connectSolana(key?: SolanaWalletKey): Promise<string> {
  if (key) selectSolanaWallet(key);
  const p = solanaProvider();
  if (!p) throw new Error("No Solana wallet found. Install Phantom, Solflare or Backpack.");
  const res = await p.connect();
  return res.publicKey.toBase58();
}

/**
 * The exact text the API verifies. MUST match `depositMessage` in the backend byte for byte,
 * newline included — a mismatch here reads as "that signature does not match the wallet",
 * which is the least helpful possible way to discover a typo.
 */
export const depositMessage = (solanaMint: string, evmAddress: string, nonce: number) =>
  `${SIGNING_NS}: deposit ${solanaMint}\nMint the mirror to ${evmAddress}\nTimestamp: ${nonce}`;

/** Sign the claim, proving control of the wallet the card was sent from. */
export async function signDepositClaim(
  solanaMint: string,
  evmAddress: string,
  nonce: number,
): Promise<{ signature: string; signer: string }> {
  const p = solanaProvider();
  if (!p) throw new Error("No Solana wallet found.");

  const signer = p.publicKey?.toBase58() ?? (await connectSolana());
  const encoded = new TextEncoder().encode(depositMessage(solanaMint, evmAddress, nonce));
  const { signature } = await p.signMessage(encoded, "utf8");
  return { signature: bs58.encode(signature), signer };
}

/**
 * Sign and send the transfer that moves the card into the vault.
 *
 * The transaction is built by our API and is a SINGLE transferV1 instruction — their card, our
 * vault, nothing else. The wallet previews it before the user approves, and the deposit page
 * displays the vault address alongside so the two can be compared. We are not a signer on it,
 * so it cannot contain anything that spends from us.
 */
export async function sendDepositTransfer(transactionBase64: string): Promise<string> {
  const p = solanaProvider();
  if (!p) throw new Error("No Solana wallet found.");

  const raw = Uint8Array.from(atob(transactionBase64), (c) => c.charCodeAt(0));
  // Core transfers are built as versioned transactions; the legacy path is a fallback for a
  // builder that changes its mind, not an expected case.
  let tx: VersionedTransaction | Transaction;
  try {
    tx = VersionedTransaction.deserialize(raw);
  } catch {
    tx = Transaction.from(raw);
  }

  const { signature } = await p.signAndSendTransaction(tx);
  return signature;
}
