/**
 * Collector Crypt client interface.
 *
 * VERIFIED 2026-07-18 against the live API and CC's published schemas — this is no longer a
 * hypothesis. See docs/verification/verification-results.md T1/T1b/T2/T3.
 *
 * What the verification established:
 *   - There is NO bespoke CC Solana program in the purchase path. A pack purchase is a memo
 *     plus an SPL `TransferChecked`, in a transaction PRE-SIGNED by CC's gacha authority
 *     (GachaNgyXTU3zFogQ8Z5jR2BLXs8215X2AtEH18VxJq3). That signature is structurally
 *     required, so `/api/generatePack` is the only way to obtain a valid purchase tx.
 *   - The reveal is ASYNCHRONOUS: `/api/openPack` may return `WAITING_FOR_WEBHOOK`.
 *   - Cards are **Metaplex Core** assets (`nft_standard: "core"`), NOT SPL/Token-Metadata.
 *     Custody and unwrap transfers must use Core instructions.
 *   - `insuredValue` is a first-class metadata field.
 *   - Buyback eligibility follows the CARD, not the wallet — any holder can sell it back.
 *   - Order binding comes free: CC issues a memo `<prefix>-<uuid>:open` and a verifiable
 *     cc-vrf proof. Map our orderId to that memo (doc 04 §3 supersedes its own scheme).
 *
 * ⚠ ACCESS: CC's docs say `x-api-key` restricts the machine to authorized partners. As
 * measured, the endpoints do not enforce it. Treat a partner key as a stability requirement
 * — CC can begin enforcing at any time, which would 401 every pack open with no notice.
 */

import type { SolanaAddress } from "../chains/address.ts";

export type Rarity = "Common" | "Uncommon" | "Rare" | "Epic";

export type MachineStatus = {
  machineId: string;
  priceUsdc: string;
  available: boolean;
  packsRemaining: number | null;
  /** Machine-level buyback rate as a percentage of insured value (85 / 90 / 93 observed). */
  instantBuybackPct: number;
  odds: Record<string, number>;
  /**
   * Insured-value band per tier, in whole USD. Differs per machine — $30-60 is common on the
   * $50 and $600-1000 on the $1000 — so it must travel with the machine rather than be
   * assumed. Without it the UI cannot show what a tier is actually worth.
   */
  tierRanges: Record<string, { start: number; end: number }>;
  /** Collector Crypt's own name for the machine, e.g. "Elite Pokemon Gacha Pack". */
  name: string | null;
  /**
   * Commons left in the vault, and the level at which CC starts refusing normal opens.
   *
   * Common is the tier that matters because it is the one turbo protects: an auto-sold common
   * goes straight back into the vault, so turbo pulls do not deplete the stock the machine is
   * short of. See docs/turbo-mode-analysis.md.
   */
  commonStock: number | null;
  lowThreshold: number | null;
  isPublic: boolean;
};

/** CC refuses normal opens once commons run down; turbo is what keeps the machine playable. */
export function isLowInventory(m: Pick<MachineStatus, "commonStock" | "lowThreshold">): boolean {
  if (m.commonStock == null || m.lowThreshold == null) return false;
  return m.commonStock <= m.lowThreshold;
}

export type CardMetadata = {
  solanaMint: string;
  certNumber: string | null;
  grade: string | null;
  name: string | null;
  imageUrl: string | null;
  /** Slab back. files[1] across the CC feed, consistently. */
  imageBackUrl?: string | null;
  /** Base units, 6dp. Drives ALL buyback math — doc 00 §2 forbids hardcoding it. */
  insuredValueUsd: string | null;
  fetchedAt: number;
};

export type PackPurchase = {
  /** CC's memo, e.g. "cc-<uuid>". THE order-binding key — persist it against our orderId. */
  memo: string;
  /** Base64 transaction, pre-signed by CC, awaiting our operator signature. */
  transactionBase64: string;
};

export type PackOpenResult = {
  memo: string;
  /** Solana signature of the award. Presence makes an order must-complete. */
  openTx: string;
  /** Null when CC is still processing — poll again (WAITING_FOR_WEBHOOK). */
  revealedMint: string | null;
  rarity: Rarity | null;
  roll: number | null;
  revealAt: number;
};

export type BuybackQuote = {
  solanaMint: string;
  available: boolean;
  /** What CC will pay us, base units (6dp). */
  proceedsUsdc: string;
  /** Derived: proceeds / insuredValue. Cross-check against machine `instantBuyback`. */
  ccRateBps: number | null;
  insuredValueUsd: string | null;
  fetchedAt: number;
};

export interface CollectorCryptClient {
  readonly name: string;

  listMachines(): Promise<MachineStatus[]>;
  machineStatus(machineId: string): Promise<MachineStatus>;

  /** Step 1: ask CC to build and co-sign a purchase. Costs nothing until submitted. */
  generatePack(machineId: string, playerAddress: SolanaAddress): Promise<PackPurchase>;

  /** Step 2: submit the fully-signed transaction. */
  submitTransaction(signedTransactionBase64: string): Promise<{ signature: string; confirmationStatus: string }>;

  /** Step 3: reveal. May return `revealedMint: null` — poll until it resolves. */
  openPack(memo: string): Promise<PackOpenResult>;

  fetchCardMeta(solanaMint: string): Promise<CardMetadata>;

  /** Live quote. Free, unauthenticated, and answers for any wallet (T3). */
  getBuybackQuote(solanaMint: string, walletAddress: SolanaAddress): Promise<BuybackQuote>;

  /** Builds the sell transaction; caller signs and submits. Settle-then-pay (doc 02 §4). */
  buildBuyback(solanaMint: string, playerAddress: SolanaAddress): Promise<{
    transactionBase64: string;
    refundAmountUsdc: string;
    memo: string;
  }>;
}

/** Distinguishes "retry this" from "this order is dead" so the pipeline can react correctly. */
/**
 * CC has refused the open because the machine is short of commons. Turbo may still get
 * through, because an auto-sold common returns to the vault instead of leaving it.
 *
 * Distinguished from a generic failure because the answer is a real choice for the buyer —
 * wait for a restock, or continue in turbo — rather than an error to retry.
 */
export class CcMachineLowError extends Error {
  readonly turboWasOn: boolean;
  constructor(machineId: string, turboWasOn: boolean) {
    super(
      turboWasOn
        ? `Machine ${machineId} is low on commons even for turbo — nothing to do but wait or switch machine`
        : `Machine ${machineId} is low on commons; turbo may still open it`,
    );
    this.name = "CcMachineLowError";
    this.turboWasOn = turboWasOn;
  }
}

/** CC is rebalancing the machine. Transient, unlike a low machine. */
export class CcMachineRebalancingError extends Error {
  constructor(machineId: string) {
    super(`Machine ${machineId} is rebalancing; try again shortly`);
    this.name = "CcMachineRebalancingError";
  }
}

export class CcApiError extends Error {
  readonly status: number;
  readonly endpoint: string;
  readonly retryable: boolean;
  readonly body: unknown;

  constructor(endpoint: string, status: number, body: unknown, message?: string) {
    super(message ?? `CC ${endpoint} failed: HTTP ${status} ${JSON.stringify(body).slice(0, 300)}`);
    this.name = "CcApiError";
    this.endpoint = endpoint;
    this.status = status;
    this.body = body;
    // 503 = "too many open packs" and 5xx are transient. 400/403/404 are terminal:
    // a blocked address or an expired window will not fix itself by retrying.
    this.retryable = status === 503 || status === 429 || (status >= 500 && status < 600);
  }
}

/** Thrown when CC starts enforcing the API key. Distinct because it kills ALL traffic. */
export class CcAuthRequiredError extends CcApiError {
  constructor(endpoint: string, status: number, body: unknown) {
    super(
      endpoint,
      status,
      body,
      `CC now requires an API key on ${endpoint} (HTTP ${status}). Every pack open is down ` +
        `until a partner key is configured — see docs/cc-partnership-enquiry.md. This was a ` +
        `known dependency risk (verification-results T1).`,
    );
    this.name = "CcAuthRequiredError";
  }
}
