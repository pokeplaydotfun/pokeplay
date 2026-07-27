/**
 * Bridge mock. Defaults reproduce the MEASURED deBridge numbers (verification-results T4b)
 * rather than convenient round ones, so pipeline tests see the real cost shape — a
 * near-fixed fee per transfer, which is what makes the $50 tier marginal.
 */
import { createHash } from "node:crypto";
import type { Bridge, BridgeQuote, BridgeResult, Chain } from "./types.ts";

export type MockBridgeFailures = {
  quoteThrows?: boolean;
  executeThrows?: boolean;
  neverFills?: boolean;
  /** Override the fee in USD to test the alert and abort gates. */
  forceCostUsd?: number;
};

export class MockBridge implements Bridge {
  readonly name = "mock";
  failures: MockBridgeFailures;
  private calls = 0;
  /** Honours the Bridge contract: execute() is idempotent per idempotencyKey. */
  private readonly byKey = new Map<string, BridgeResult>();

  constructor(failures: MockBridgeFailures = {}) {
    this.failures = failures;
  }

  private feeUsd(from: Chain): number {
    if (this.failures.forceCostUsd !== undefined) return this.failures.forceCostUsd;
    // Measured 2026-07-18 at $50: RH->SOL $0.7704, SOL->RH $0.9075.
    return from === "rh" ? 0.7704 : 0.9075;
  }

  async quote(from: Chain, to: Chain, amountBaseUnits: string): Promise<BridgeQuote> {
    if (this.failures.quoteThrows) throw new Error("MOCK: bridge route unavailable");

    const amountIn = BigInt(amountBaseUnits);
    const costUsd = this.feeUsd(from);
    const costBaseUnits = BigInt(Math.round(costUsd * 1e6));
    const amountOut = amountIn > costBaseUnits ? amountIn - costBaseUnits : 0n;

    return {
      amountIn: amountIn.toString(),
      amountOut: amountOut.toString(),
      costUsd,
      costBps: amountIn > 0n ? Number((costBaseUnits * 10_000n) / amountIn) : 0,
      estimatedSeconds: from === "rh" ? 1 : 9,
      raw: { mock: true, from, to },
    };
  }

  async execute(
    from: Chain,
    to: Chain,
    amountBaseUnits: string,
    quote: BridgeQuote,
    idempotencyKey: string,
  ): Promise<BridgeResult> {
    // Idempotency is checked FIRST: a resumed transfer must be rejoined even if the
    // failure flags are still set, exactly as a real bridge would return the existing fill.
    const existing = this.byKey.get(idempotencyKey);
    if (existing) return existing;

    if (this.failures.executeThrows) throw new Error("MOCK: bridge deposit failed");
    if (this.failures.neverFills) throw new Error("MOCK: bridge deposited but never filled");

    this.calls += 1;
    const tag = createHash("sha256").update(idempotencyKey).digest("hex");
    const result: BridgeResult = {
      providerOrderId: tag.slice(0, 32),
      depositTx: `0x${tag.slice(0, 64)}`,
      fillTx: tag.slice(32, 96),
      amountOut: quote.amountOut,
      costUsd: quote.costUsd,
    };
    this.byKey.set(idempotencyKey, result);
    return result;
  }

  async healthy(): Promise<boolean> {
    return !this.failures.quoteThrows;
  }

  get executeCount() {
    return this.calls;
  }
}
