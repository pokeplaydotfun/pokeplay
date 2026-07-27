/**
 * Liquidity abstraction (doc 04 §7). Build the interface now, implement FloatSource later.
 *
 * At launch only JitSource exists: every order bridges its own payment. The measured cost
 * of that is a near-fixed ~$0.77 per leg (verification-results T4b), which is precisely the
 * cost a float amortises away — so this seam is where the M1/M2 economics fix lands, with
 * no changes to the pipelines above it.
 */

export type Chain = "rh" | "solana";

export type BridgeQuote = {
  /** Base units in (6dp). */
  amountIn: string;
  /** Base units expected out, after all fees. */
  amountOut: string;
  /** amountIn - amountOut, in USD. The number that decides whether a trade is worth doing. */
  costUsd: number;
  costBps: number;
  estimatedSeconds: number;
  /** Opaque provider payload the executor needs to actually submit. */
  raw: unknown;
};

export type BridgeResult = {
  providerOrderId: string;
  depositTx: string;
  fillTx: string | null;
  amountOut: string;
  costUsd: number;
};

export interface Bridge {
  readonly name: string;
  quote(from: Chain, to: Chain, amountBaseUnits: string): Promise<BridgeQuote>;
  /**
   * Submits the transfer and waits for the fill. MUST be idempotent per idempotencyKey:
   * a crash between send and confirm must not spend twice on restart (doc 04 §8).
   */
  execute(
    from: Chain,
    to: Chain,
    amountBaseUnits: string,
    quote: BridgeQuote,
    idempotencyKey: string,
  ): Promise<BridgeResult>;
  /** Cheap liveness probe for the health gate (doc 02 §8). */
  healthy(probeAmountBaseUnits: string): Promise<boolean>;
}

/**
 * Where a pipeline gets funds on the far chain. JitSource bridges per order; FloatSource
 * (M2) draws from a pre-funded balance and rebalances in batches.
 */
export interface LiquiditySource {
  readonly name: string;
  /** Make `amount` available on `chain`. Returns what it cost us to do so. */
  provide(chain: Chain, amountBaseUnits: string, idempotencyKey: string): Promise<{
    amountAvailable: string;
    costUsd: number;
    bridgeResult: BridgeResult | null;
  }>;
  /** Move value back after a sell. Same contract in reverse. */
  settle(chain: Chain, amountBaseUnits: string, idempotencyKey: string): Promise<{
    amountAvailable: string;
    costUsd: number;
    bridgeResult: BridgeResult | null;
  }>;
  healthy(): Promise<boolean>;
}

export class BridgeCostExceeded extends Error {
  readonly costUsd: number;
  readonly limitUsd: number;
  readonly context: string;

  constructor(costUsd: number, limitUsd: number, context: string) {
    super(
      `Bridge cost $${costUsd.toFixed(4)} exceeds abort limit $${limitUsd.toFixed(2)} (${context}). ` +
        `Refusing to bridge — at a ~$2.60 spread, a leg this expensive can invert the trade.`,
    );
    this.name = "BridgeCostExceeded";
    this.costUsd = costUsd;
    this.limitUsd = limitUsd;
    this.context = context;
  }
}
