/**
 * Deterministic CC mock (doc 04 §9). Drives the full pipeline end-to-end without touching
 * mainnet, and can be told to fail on any leg so the recovery paths get exercised.
 *
 * Shapes and numbers mirror the live API as measured 2026-07-18: memo-based order binding,
 * asynchronous reveal, 85% buyback at the $50 tier, insured value as a metadata field.
 *
 * Deterministic on purpose: given the same seed, the same memo produces the same card, so a
 * failing pipeline test reproduces exactly.
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  BuybackQuote,
  CardMetadata,
  CollectorCryptClient,
  MachineStatus,
  PackOpenResult,
  PackPurchase,
  Rarity,
} from "./types.ts";
import { CcApiError, CcMachineLowError } from "./types.ts";

export type MockFailures = {
  machineSoldOut?: boolean;
  generateThrows?: boolean;
  submitThrows?: boolean;
  /** Number of openPack polls that answer WAITING_FOR_WEBHOOK before the reveal lands. */
  revealDelayPolls?: number;
  metadataMissingInsuredValue?: boolean;
  buybackUnavailable?: boolean;
  buildBuybackThrows?: boolean;
  /** CC's rate moves down between quote and execute — drives the re-confirm path. */
  quoteDriftBps?: number;
  /** Simulates CC switching the documented API-key gate on. */
  requiresApiKey?: boolean;
  /** Machine is short of commons, so CC only allows turbo opens. */
  machineLowOnCommons?: boolean;
};

const MACHINES: Record<string, { price: number; instantBuyback: number; isPublic: boolean }> = {
  pokemon_50: { price: 50, instantBuyback: 85, isPublic: true },
  pokemon_250: { price: 250, instantBuyback: 90, isPublic: true },
  pokemon_1000: { price: 1000, instantBuyback: 93, isPublic: true },
};

export class MockCollectorCrypt implements CollectorCryptClient {
  readonly name = "mock";
  failures: MockFailures;
  private readonly seed: string;
  private readonly packs = new Map<string, { machineId: string; polls: number; mint: string }>();
  private readonly sold = new Set<string>();
  private opens = 0;

  constructor(seed = "mock", failures: MockFailures = {}) {
    this.seed = seed;
    this.failures = failures;
  }

  private hash(...parts: (string | number)[]): string {
    return createHash("sha256").update([this.seed, ...parts].join(":")).digest("hex");
  }

  private guardAuth(endpoint: string): void {
    if (this.failures.requiresApiKey) {
      throw new CcApiError(endpoint, 401, { error: "unauthorized" });
    }
  }

  // ---------------------------------------------------------------- machines

  async listMachines(): Promise<MachineStatus[]> {
    return Object.entries(MACHINES).map(([code, m]) => this.machine(code, m));
  }

  async machineStatus(machineId: string): Promise<MachineStatus> {
    const m = MACHINES[machineId];
    if (!m) throw new CcApiError("/machines", 404, { machineId }, `Unknown machine "${machineId}"`);
    return this.machine(machineId, m);
  }

  private machine(code: string, m: { price: number; instantBuyback: number; isPublic: boolean }): MachineStatus {
    return {
      machineId: code,
      priceUsdc: BigInt(m.price * 1e6).toString(),
      available: !this.failures.machineSoldOut,
      packsRemaining: this.failures.machineSoldOut ? 0 : 8044,
      instantBuybackPct: m.instantBuyback,
      odds: { common: 0.8, uncommon: 0.15, rare: 0.04, epic: 0.01 },
      // Real bands from the $50 machine, not invented, so a mocked render is still truthful.
      tierRanges: {
        common: { start: 30, end: 60 },
        uncommon: { start: 60, end: 110 },
        rare: { start: 110, end: 250 },
        epic: { start: 250, end: 5001 },
      },
      name: code,
      commonStock: this.failures.machineLowOnCommons ? 3 : 1500,
      lowThreshold: 50,
      isPublic: m.isPublic,
    };
  }

  // ---------------------------------------------------------------- purchase

  async generatePack(machineId: string, playerAddress: string, turbo = false): Promise<PackPurchase> {
    /**
     * The third CC call that takes a wallet, and the last one still ignoring it.
     *
     * The real client posts this as `playerAddress` and CC builds a Solana purchase
     * transaction for that wallet. `buildBuyback` got this guard only after a wrong-chain
     * address passed 292 tests and killed a live sell-back; leaving the sibling unguarded is
     * exactly how that bug survived the first fix. Production passes the Solana signer address
     * here and is correct today — this stops a regression, on the pack-purchase path.
     */
    if (playerAddress.startsWith("0x") || playerAddress.length < 32) {
      throw new CcApiError("/generatePack", 400, { error: "Invalid player address" });
    }

    this.guardAuth("/generatePack");
    // Low on commons: CC refuses a normal open but lets turbo through, because an auto-sold
    // common goes back into the vault instead of leaving it.
    if (this.failures.machineLowOnCommons && !turbo) {
      throw new CcMachineLowError(machineId, false);
    }
    if (this.failures.machineSoldOut) {
      throw new CcApiError("/generatePack", 500, { details: "machine empty" });
    }
    if (this.failures.generateThrows) {
      throw new CcApiError("/generatePack", 503, { error: "too many open packs" });
    }

    const memo = `cc-${randomUUID()}`;
    this.packs.set(memo, { machineId, polls: 0, mint: this.hash("mint", memo).slice(0, 44) });
    return { memo, transactionBase64: Buffer.from(this.hash("tx", memo)).toString("base64") };
  }

  async submitTransaction(signedTransactionBase64: string) {
    this.guardAuth("/submitTransaction");
    if (this.failures.submitThrows) {
      throw new CcApiError("/submitTransaction", 500, { error: "submission failed" });
    }
    return {
      signature: this.hash("sig", signedTransactionBase64).slice(0, 88),
      confirmationStatus: "confirmed",
    };
  }

  async openPack(memo: string): Promise<PackOpenResult> {
    this.guardAuth("/openPack");
    const pack = this.packs.get(memo);
    if (!pack) throw new CcApiError("/openPack", 404, { memo }, "No spin transaction for memo");

    // Asynchronous reveal, as the live API behaves.
    if (pack.polls < (this.failures.revealDelayPolls ?? 0)) {
      pack.polls += 1;
      return { memo, openTx: "", revealedMint: null, rarity: null, roll: null, revealAt: Date.now() };
    }

    this.opens += 1;
    const roll = parseInt(this.hash("roll", memo).slice(0, 8), 16);
    const rarities: Rarity[] = ["Common", "Uncommon", "Rare", "Epic"];
    return {
      memo,
      openTx: this.hash("open", memo).slice(0, 88),
      revealedMint: pack.mint,
      rarity: rarities[roll % 4]!,
      roll,
      revealAt: Date.now(),
    };
  }

  async awaitReveal(memo: string, opts: { attempts?: number; intervalMs?: number } = {}) {
    const attempts = opts.attempts ?? 20;
    for (let i = 0; i < attempts; i++) {
      const r = await this.openPack(memo);
      if (r.revealedMint) return r;
      await new Promise((res) => setTimeout(res, opts.intervalMs ?? 1));
    }
    throw new CcApiError("/openPack", 504, { memo }, "reveal never resolved (must-complete)");
  }

  // ---------------------------------------------------------------- metadata

  async fetchCardMeta(solanaMint: string): Promise<CardMetadata> {
    // Insured value varies per card so buyback maths is exercised over a range. Centred on
    // the $50 tier's observed ~$53-55.
    const spread = parseInt(this.hash("value", solanaMint).slice(0, 4), 16) % 20_000_000;
    return {
      solanaMint,
      certNumber: this.hash("cert", solanaMint).slice(0, 8).toUpperCase(),
      grade: `PSA ${(parseInt(this.hash("grade", solanaMint).slice(0, 2), 16) % 4) + 7}`,
      name: `Mock Graded Card ${solanaMint.slice(0, 6)} PSA 9`,
      imageUrl: `https://example.invalid/cards/${solanaMint}.jpg`,
      insuredValueUsd: this.failures.metadataMissingInsuredValue ? null : String(45_000_000 + spread),
      fetchedAt: Date.now(),
    };
  }

  async fetchCardMetaByMemo(memo: string): Promise<CardMetadata> {
    const pack = this.packs.get(memo);
    if (!pack) throw new CcApiError("/vrf/verify", 404, { memo });
    return this.fetchCardMeta(pack.mint);
  }

  // ---------------------------------------------------------------- buyback

  async getBuybackQuote(solanaMint: string, walletAddress: string): Promise<BuybackQuote> {
    /**
     * The wallet must be a SOLANA address, for the same reason buildBuyback checks it: this
     * argument is sent straight to CC as `?wallet=`. Every caller was passing the literal
     * string "custody", which the mock ignored, so all three sites passed every test. The
     * sibling call already proved CC validates this family of parameter — a wrong-chain value
     * there returned `400 Invalid altRecipient address` and killed a live sell-back.
     */
    if (walletAddress.startsWith("0x") || walletAddress.length < 32) {
      throw new CcApiError("/buyback/available", 400, { error: "Invalid wallet address" });
    }

    const unavailable = this.failures.buybackUnavailable || this.sold.has(solanaMint);
    if (unavailable) {
      return {
        solanaMint,
        available: false,
        proceedsUsdc: "0",
        ccRateBps: null,
        insuredValueUsd: null,
        fetchedAt: Date.now(),
      };
    }

    const meta = await this.fetchCardMeta(solanaMint);
    const insured = BigInt(meta.insuredValueUsd ?? "0");
    const rateBps = BigInt(8500 - (this.failures.quoteDriftBps ?? 0));

    return {
      solanaMint,
      available: true,
      proceedsUsdc: ((insured * rateBps) / 10_000n).toString(),
      ccRateBps: Number(rateBps),
      insuredValueUsd: meta.insuredValueUsd,
      fetchedAt: Date.now(),
    };
  }

  /** The wallet the last buyback was built for, so tests can assert which chain it came from. */
  lastBuybackPlayer: string | null = null;

  async buildBuyback(solanaMint: string, playerAddress: string) {
    this.guardAuth("/buyback");
    this.lastBuybackPlayer = playerAddress;

    /**
     * The address must be a SOLANA one. This mock used to ignore it entirely.
     *
     * That silence let a real bug through every test: the pipeline passed
     * `chain.operatorAddress` — the Robinhood Chain EVM address — to this Solana endpoint,
     * and the real API answered `400 {"error":"Invalid altRecipient address"}` on the first
     * live sell-back. A mock that accepts anything cannot catch a caller that sends the wrong
     * thing, and this is the one CC call whose argument comes from the EVM side of the app.
     *
     * The check is deliberately crude — base58 has no 0x prefix and no 'x' at all — because
     * the failure it guards against is not a subtle malformation but an address from the
     * wrong chain entirely.
     */
    if (playerAddress.startsWith("0x") || playerAddress.length < 32) {
      throw new CcApiError("/buyback", 400, { error: "Invalid altRecipient address" });
    }

    if (this.failures.buildBuybackThrows) {
      throw new CcApiError("/buyback", 500, { error: "transaction building failed" });
    }
    const quote = await this.getBuybackQuote(solanaMint, playerAddress);
    if (!quote.available) {
      throw new CcApiError("/buyback", 400, { error: "outside 72-hour window" });
    }

    this.sold.add(solanaMint);
    return {
      transactionBase64: Buffer.from(this.hash("buyback", solanaMint)).toString("base64"),
      refundAmountUsdc: quote.proceedsUsdc,
      memo: `cc-${this.hash("bbmemo", solanaMint).slice(0, 8)}`,
    };
  }

  get openCount() {
    return this.opens;
  }
}
