/**
 * Live Collector Crypt client. Built from verified schemas, not guesses
 * (docs/verification/verification-results.md T1/T1b/T2/T3).
 *
 * Purchase flow:
 *   generatePack  -> CC returns a transaction it has already co-signed
 *   [we sign]     -> our operator keypair adds the player signature
 *   submitTransaction
 *   openPack      -> poll; may answer WAITING_FOR_WEBHOOK while CC processes
 *
 * Turbo mode is deliberately never enabled: it auto-sells Common pulls back to CC, which
 * would destroy the card before we could mirror it to the user.
 */
import { Transaction, VersionedTransaction } from "@solana/web3.js";
import type { Keypair } from "@solana/web3.js";
import { assertBuybackTransactionIsSafeToSign, assertTransactionIsSafeToSign } from "../chains/solana.ts";
import {
  CcApiError,
  CcAuthRequiredError,
  CcMachineLowError,
  CcMachineRebalancingError,
  type BuybackQuote,
  type CardMetadata,
  type CollectorCryptClient,
  type MachineStatus,
  type PackOpenResult,
  type PackPurchase,
  type Rarity,
} from "./types.ts";

type MachineJson = {
  code: string;
  name?: string;
  price: number;
  public: boolean;
  lowThreshold?: number;
  instantBuyback: number;
  odds: Record<string, number>;
  tierRanges?: Record<string, { start: number; end: number }>;
  stock: Record<string, number>;
};

type VrfVerifyJson = {
  wallet?: string;
  nftAddress?: string;
  nftMetadata?: {
    nft_standard?: string;
    ownership?: { owner?: string };
    content?: {
      links?: { image?: string };
      /** files[0] is the slab front and files[1] the back, consistently across the feed. */
      files?: { uri?: string; cc_cdn?: string; mime?: string }[];
      metadata?: {
        name?: string;
        insuredValue?: number | string;
        attributes?: { trait_type?: string; value?: string }[];
      };
    };
  };
};

export type CcClientOptions = {
  apiUrl?: string;
  /** Attribution key. Optional today; required the moment CC enforces it. */
  apiKey?: string | undefined;
  /** Referral code, sent as CC's `referrer` cookie on every call. */
  referralCode?: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class CollectorCryptApi implements CollectorCryptClient {
  readonly name = "collector-crypt";
  private readonly apiUrl: string;
  private readonly apiKey: string | undefined;
  private readonly referralCode: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: CcClientOptions = {}) {
    this.apiUrl = opts.apiUrl ?? "https://gacha.collectorcrypt.com/api";
    this.apiKey = opts.apiKey;
    this.referralCode = opts.referralCode;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /**
   * Referral attribution.
   *
   * Measured 2026-07-19: GET /referral/<code> answers 307 to / and sets an HttpOnly cookie
   * `referrer=<code>`, Path=/, 30 days, SameSite=strict. There is no documented body field
   * and no separate endpoint, so the cookie IS the mechanism, and replaying it on every call
   * is the only way a server-to-server integration can carry it.
   *
   * UNVERIFIED: /generatePack returns a random UUID memo with or without the cookie, so
   * attribution is not observable from our side. It cannot be confirmed without opening a
   * real paid pack and checking with Collector Crypt whether the referral landed. Sending it
   * costs nothing and is harmless if ignored, but do not treat the credit as working yet.
   */
  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["x-api-key"] = this.apiKey;
    if (this.referralCode) h["Cookie"] = `referrer=${this.referralCode}`;
    return h;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers as Record<string, string>) },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = { error: "non-JSON response" };
    }

    if (!res.ok) {
      // 401/403 on a previously-open endpoint means the documented gate went live.
      if ((res.status === 401 || res.status === 403) && !this.apiKey) {
        throw new CcAuthRequiredError(path, res.status, body);
      }

      /**
       * CC signals its two machine-level refusals through `details`, not the status code.
       * The exact strings come from their own client (docs/turbo-mode-analysis.md); they are
       * matched rather than guessed, and anything else still falls through as a plain error.
       *
       * These are not failures to retry — a low machine is a choice for the buyer, and a
       * rebalancing one just needs a moment — so they get their own types.
       */
      const details = (body as { details?: unknown } | null)?.details;
      const machineId = (() => {
        try { return String(JSON.parse(String(init?.body ?? "{}")).packType ?? "unknown"); }
        catch { return "unknown"; }
      })();
      const turboWasOn = (() => {
        try { return JSON.parse(String(init?.body ?? "{}")).turbo === true; }
        catch { return false; }
      })();

      if (details === "Machine is low") throw new CcMachineLowError(machineId, turboWasOn);
      if (details === "Machine is off balance") throw new CcMachineRebalancingError(machineId);

      throw new CcApiError(path, res.status, body);
    }
    return body as T;
  }

  // ---------------------------------------------------------------- machines

  async listMachines(): Promise<MachineStatus[]> {
    const body = await this.request<{ machines: MachineJson[] }>("/machines", { method: "GET" });
    return body.machines.map((m) => this.toMachineStatus(m));
  }

  async machineStatus(machineId: string): Promise<MachineStatus> {
    const machines = await this.listMachines();
    const found = machines.find((m) => m.machineId === machineId);
    if (!found) throw new CcApiError("/machines", 404, { machineId }, `Unknown machine "${machineId}"`);
    return found;
  }

  private toMachineStatus(m: MachineJson): MachineStatus {
    const totalStock = Object.values(m.stock ?? {}).reduce((a, b) => a + b, 0);
    return {
      machineId: m.code,
      // Prices are whole USDC in the API; our ledger is 6dp base units throughout.
      priceUsdc: BigInt(Math.round(m.price * 1e6)).toString(),
      available: totalStock > 0,
      packsRemaining: totalStock,
      instantBuybackPct: m.instantBuyback,
      odds: m.odds ?? {},
      tierRanges: m.tierRanges ?? {},
      name: m.name ?? null,
      commonStock: m.stock?.common ?? null,
      lowThreshold: m.lowThreshold ?? null,
      isPublic: m.public,
    };
  }

  // ---------------------------------------------------------------- purchase

  /**
   * @param turbo Ask CC to auto-sell a Common pull back instead of delivering the card.
   *
   * This is CC's own flag, handled entirely on their side — we do not sell anything. A turbo
   * pull that comes out common therefore yields USDC on Solana rather than an NFT, and the
   * caller owes the buyer that money on Robinhood Chain. See docs/turbo-mode-analysis.md.
   */
  async generatePack(machineId: string, playerAddress: string, turbo = false): Promise<PackPurchase> {
    const body = await this.request<{ memo: string; transaction: string }>("/generatePack", {
      method: "POST",
      body: JSON.stringify({ playerAddress, packType: machineId, turbo }),
    });

    if (!body.memo || !body.transaction) {
      throw new CcApiError("/generatePack", 200, body, "generatePack returned no memo/transaction");
    }
    return { memo: body.memo, transactionBase64: body.transaction };
  }

  async submitTransaction(signedTransactionBase64: string) {
    const body = await this.request<{ success: boolean; signature: string; confirmationStatus: string }>(
      "/submitTransaction",
      { method: "POST", body: JSON.stringify({ signedTransaction: signedTransactionBase64 }) },
    );

    /**
     * `success` was declared here and never read. That is the point of no return for a pack.
     *
     * A CC `200 {success: false}` returned `{ signature: undefined }`, and the caller then
     * wrote `cc_open_tx` and moved the order to OPENING. Setting `cc_open_tx` makes an order
     * MUST-COMPLETE: the refund paths refuse it from that moment on. So a pack that was never
     * bought locked the buyer's money in escrow permanently, on the strength of a field we
     * had already fetched and thrown away.
     */
    if (!body.success || !body.signature) {
      throw new CcApiError(
        "/submitTransaction",
        200,
        body,
        `submitTransaction reported success=${body.success} with signature=${body.signature}. ` +
          `Treating as NOT submitted: recording it would make the order unrefundable.`,
      );
    }

    return { signature: body.signature, confirmationStatus: body.confirmationStatus };
  }

  async openPack(memo: string): Promise<PackOpenResult> {
    const body = await this.request<{
      success: boolean;
      code?: string;
      transactionSignature?: string;
      nft_address?: string;
      roll?: number;
      rarity?: Rarity;
      buybackAmount?: number;
    }>("/openPack", { method: "POST", body: JSON.stringify({ memo }) });

    // Asynchronous reveal — CC is still processing. Caller polls.
    if (body.code === "WAITING_FOR_WEBHOOK" || !body.nft_address) {
      return { memo, openTx: body.transactionSignature ?? "", revealedMint: null, rarity: null, roll: null, revealAt: Date.now() };
    }

    if (body.code === "TURBO_MODE_BUYBACK") {
      // Should be unreachable — we never request turbo. If it happens, the card was sold
      // back to CC on our behalf and there is nothing to mirror; fail loudly rather than
      // mint a mirror against an asset we do not hold.
      throw new CcApiError(
        "/openPack",
        200,
        body,
        `Pack ${memo} was auto-sold by turbo mode. We never request turbo, so this indicates ` +
          `a machine-level default. No card is in custody — do NOT mint a mirror.`,
      );
    }

    return {
      memo,
      openTx: body.transactionSignature ?? "",
      revealedMint: body.nft_address,
      rarity: body.rarity ?? null,
      roll: body.roll ?? null,
      revealAt: Date.now(),
    };
  }

  /** Polls openPack until the reveal resolves or the budget runs out. */
  async awaitReveal(memo: string, opts: { attempts?: number; intervalMs?: number } = {}): Promise<PackOpenResult> {
    const attempts = opts.attempts ?? 20;
    const intervalMs = opts.intervalMs ?? 3_000;

    let last: PackOpenResult | null = null;
    for (let i = 0; i < attempts; i++) {
      last = await this.openPack(memo);
      if (last.revealedMint) return last;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new CcApiError(
      "/openPack",
      504,
      { memo },
      `Reveal for ${memo} did not resolve after ${attempts} polls. The pack WAS paid for — ` +
        `this order is must-complete and must never be auto-refunded (doc 04 §2).`,
    );
  }

  // ---------------------------------------------------------------- metadata

  /**
   * Reads card metadata via CC's public VRF verifier, which returns the full asset record
   * including `insuredValue` — a real metadata field, not a scraped page (T2).
   */
  async fetchCardMetaByMemo(memo: string): Promise<CardMetadata> {
    const body = await this.request<VrfVerifyJson>(`/vrf/verify?memo=${encodeURIComponent(memo)}`, {
      method: "GET",
    });
    return this.toCardMetadata(body);
  }

  async fetchCardMeta(solanaMint: string): Promise<CardMetadata> {
    // The verifier is memo-keyed, so a mint-only lookup needs the DAS asset API. Until the
    // pipeline threads the memo through everywhere, prefer fetchCardMetaByMemo.
    throw new CcApiError(
      "/vrf/verify",
      501,
      { solanaMint },
      `fetchCardMeta(mint) is not implemented — CC's verifier is keyed by memo. Use ` +
        `fetchCardMetaByMemo(memo), or add a DAS getAsset lookup for Metaplex Core assets.`,
    );
  }

  private toCardMetadata(body: VrfVerifyJson): CardMetadata {
    const meta = body.nftMetadata?.content?.metadata;
    const insured = meta?.insuredValue;

    // Cert number appears as a "Collector Crypt ..." trait rather than a named field.
    const certAttr = meta?.attributes?.find((a) => /collector\s*crypt/i.test(a.trait_type ?? ""));
    /**
     * Grade comes from the STRUCTURED attributes, not from scraping the name.
     *
     * The name was the only source, matched with a regex for "PSA 10" and friends. But the
     * on-chain metadata name is capped at 32 characters, so a real card arrives truncated
     * mid-word — the first live pull was `"2025 Pokemon Mega Evolution Phan"`, with the grade
     * suffix simply cut off. Every card graded by a company whose name did not survive that
     * truncation therefore had `grade: null`, which is exactly what happened on the very
     * first real pack.
     *
     * The attributes carry it cleanly and always have:
     *   Grading Company = "CGC"   GradeNum = "10"   The Grade = "GEM MINT 10"
     *
     * The name regex stays as a fallback for anything that lacks the attributes.
     */
    const attr = (name: RegExp) =>
      meta?.attributes?.find((a) => name.test(a.trait_type ?? ""))?.value ?? null;

    const company = attr(/^\s*grading\s*company\s*$/i);
    const gradeNum = attr(/^\s*gradenum\s*$/i);
    const gradeMatch = /\b(PSA|BGS|CGC|SGC)\s*([0-9.]+)\b/i.exec(meta?.name ?? "");

    const grade =
      company && gradeNum
        ? `${company.toUpperCase()} ${gradeNum}`
        : gradeMatch
          ? `${gradeMatch[1]!.toUpperCase()} ${gradeMatch[2]}`
          : null;

    /**
     * Prefer the real card name over the truncated on-chain one, for the same reason.
     * "Piplup" from `Card Name` reads far better than "2025 Pokemon Mega Evolution Phan".
     * Comma, not an em dash: no em dashes in user-facing copy.
     */
    const cardName = attr(/^\s*card\s*name\s*$/i);
    const setName = attr(/^\s*set\s*$/i);
    const displayName =
      cardName && setName ? `${cardName}, ${setName.split(" - ")[0]}` : (cardName ?? meta?.name ?? null);

    return {
      solanaMint: body.nftAddress ?? "",
      certNumber: certAttr?.value ?? null,
      grade,
      name: displayName,
      imageUrl: sizedImage(
        body.nftMetadata?.content?.files?.[0]?.uri ?? body.nftMetadata?.content?.links?.image,
        900,
      ),
      imageBackUrl: sizedImage(body.nftMetadata?.content?.files?.[1]?.uri, 900),
      insuredValueUsd:
        insured === undefined || insured === null
          ? null
          : BigInt(Math.round(Number(insured) * 1e6)).toString(),
      fetchedAt: Date.now(),
    };
  }

  // ---------------------------------------------------------------- buyback

  async getBuybackQuote(solanaMint: string, walletAddress: string): Promise<BuybackQuote> {
    const body = await this.request<{ available: boolean; amount?: number }>(
      `/buyback/available?wallet=${encodeURIComponent(walletAddress)}&nft=${encodeURIComponent(solanaMint)}`,
      { method: "GET" },
    );

    if (!body.available || body.amount === undefined) {
      return {
        solanaMint,
        available: false,
        proceedsUsdc: "0",
        ccRateBps: null,
        insuredValueUsd: null,
        fetchedAt: Date.now(),
      };
    }

    return {
      solanaMint,
      available: true,
      // `amount` is already base units (6dp) — observed 45050000 for a $45.05 quote.
      proceedsUsdc: String(body.amount),
      ccRateBps: null, // caller derives against insured value; see deriveRateBps
      insuredValueUsd: null,
      fetchedAt: Date.now(),
    };
  }

  async buildBuyback(solanaMint: string, playerAddress: string) {
    const body = await this.request<{
      success: boolean;
      serializedTransaction: string;
      refundAmount: number;
      memo: string;
    }>("/buyback", {
      method: "POST",
      body: JSON.stringify({ playerAddress, nftAddress: solanaMint }),
    });

    // Same reasoning as submitTransaction: an unchecked `success` here hands back an
    // undefined transaction that is then signed and submitted.
    if (!body.success || !body.serializedTransaction) {
      throw new CcApiError(
        "/buyback",
        200,
        body,
        `buyback build reported success=${body.success} with no transaction. Not proceeding.`,
      );
    }

    return {
      transactionBase64: body.serializedTransaction,
      refundAmountUsdc: String(body.refundAmount),
      memo: body.memo,
    };
  }
}

// -------------------------------------------------------------------- helpers

/**
 * Signs a CC-issued transaction with our operator keypair, preserving CC's co-signature.
 * Handles both legacy and versioned encodings, since CC's format is theirs to change.
 */
/**
 * Render a Collector Crypt image through a resizing CDN.
 *
 * The arweave `uri` is the ORIGINAL scan and runs to ~4.3 MB per card. Storing that raw and
 * serving it to a browser is the difference between a 70 KB card and a page that takes
 * seconds to paint. Helius fronts the same arweave source with Cloudflare image resizing, so
 * this keeps the canonical source while sending a sane payload.
 *
 * Anything not on arweave is passed through untouched: it is already a CDN URL.
 */
export function sizedImage(uri: string | null | undefined, width: number): string | null {
  if (!uri) return null;
  if (!uri.includes("arweave.net")) return uri;
  return `https://cdn.helius-rpc.com/cdn-cgi/image/width=${width},quality=80,format=auto/${uri}`;
}

export function signCcTransaction(
  transactionBase64: string,
  signer: Keypair,
  /**
   * Set for a SELL-BACK, where the transaction legitimately moves one of our cards and is paid
   * for by Collector Crypt. Both of those are refused by the general guard, correctly — see
   * `assertBuybackTransactionIsSafeToSign`, which replaces it with a stricter rule tied to the
   * specific mint being sold. Omit it and the general guard applies, which is what every other
   * caller wants.
   */
  buybackMint?: string,
): string {
  const raw = Buffer.from(transactionBase64, "base64");

  try {
    const vtx = VersionedTransaction.deserialize(raw);
    /**
     * Validate BEFORE signing. This is the live pack-purchase path.
     *
     * The allowlist was written for exactly this case — "the worker signs blobs handed to it
     * over HTTPS by Collector Crypt" — but was only wired into `SolanaChain.signAndSend`,
     * which serves the deBridge leg and is currently switched off. So the guard protected the
     * disabled path and not the one that runs on every open, while its own docstring claimed
     * otherwise. Found by the final review, before any real pack was bought.
     */
    if (buybackMint) {
      assertBuybackTransactionIsSafeToSign(vtx, signer.publicKey.toBase58(), buybackMint);
    } else {
      assertTransactionIsSafeToSign(vtx, signer.publicKey.toBase58());
    }
    vtx.sign([signer]);
    return Buffer.from(vtx.serialize()).toString("base64");
  } catch (err) {
    // A refusal to sign must NEVER be swallowed into the legacy fallback below — that would
    // sign the very transaction we just declined.
    if (err instanceof Error && /Refusing to sign/.test(err.message)) throw err;
    const tx = Transaction.from(raw);
    // partialSign, never sign: CC's signature is already in the array and must survive.
    tx.partialSign(signer);
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  }
}

/** Derives CC's effective rate so it can be cross-checked against the published machine %. */
export function deriveRateBps(proceedsUsdc: string, insuredValueUsd: string): number {
  const insured = BigInt(insuredValueUsd);
  if (insured === 0n) return 0;
  return Number((BigInt(proceedsUsdc) * 10_000n) / insured);
}

/**
 * Our payout: CC's live rate MINUS the spread, applied to insured value.
 *
 * Doc 00 §6 rule 2 — we must be structurally incapable of paying more than the pass-through
 * returns. Computed from the LIVE quote every time; never from a stored or assumed rate.
 */
export function userPayoutUsdg(
  proceedsUsdc: string,
  insuredValueUsd: string,
  spreadBps: number,
): string {
  const ccRateBps = deriveRateBps(proceedsUsdc, insuredValueUsd);
  const userRateBps = ccRateBps - spreadBps;
  if (userRateBps <= 0) return "0";

  const payout = (BigInt(insuredValueUsd) * BigInt(userRateBps)) / 10_000n;

  // Hard invariant: never pay out more than CC pays us, whatever the inputs.
  const proceeds = BigInt(proceedsUsdc);
  return (payout > proceeds ? proceeds : payout).toString();
}
