/**
 * JitSource — the launch liquidity model (doc 00 §4, doc 04 §7).
 *
 * Every order bridges its own payment. No float, no capital at rest. The operator accepted
 * the measured economics of this at the $50 tier (verification-results T4b decision):
 * −$0.77 per kept pack, +$0.92 per sold-back one, ~$7.70/day worst case at M0 caps.
 *
 * FloatSource implements this same interface at M2 and amortises the fixed fee across a
 * batched rebalance. Nothing above this file needs to change when that happens.
 */
import type { Bridge, Chain, LiquiditySource } from "./types.ts";
import { BridgeCostExceeded } from "./types.ts";
import type { Db } from "../db/index.ts";
import type { Config } from "../config.ts";

export class JitSource implements LiquiditySource {
  readonly name = "jit";
  private readonly bridge: Bridge;
  private readonly db: Db;
  private readonly cfg: Config;
  private readonly onAlert: (message: string) => void;

  constructor(
    bridge: Bridge,
    db: Db,
    cfg: Config,
    onAlert: (message: string) => void = console.warn,
  ) {
    this.bridge = bridge;
    this.db = db;
    this.cfg = cfg;
    this.onAlert = onAlert;
  }

  provide(chain: Chain, amountBaseUnits: string, idempotencyKey: string) {
    return this.move(chain === "solana" ? "rh" : "solana", chain, amountBaseUnits, idempotencyKey, "provide");
  }

  settle(chain: Chain, amountBaseUnits: string, idempotencyKey: string) {
    return this.move(chain === "rh" ? "solana" : "rh", chain, amountBaseUnits, idempotencyKey, "settle");
  }

  private async move(
    from: Chain,
    to: Chain,
    amountBaseUnits: string,
    idempotencyKey: string,
    context: string,
  ) {
    const quote = await this.bridge.quote(from, to, amountBaseUnits);

    // Hard stop. A leg costing more than the abort limit can invert an individual trade —
    // the spread on a $50 pack is only ~$2.60.
    if (quote.costUsd > this.cfg.bridge.costAbortUsd) {
      throw new BridgeCostExceeded(quote.costUsd, this.cfg.bridge.costAbortUsd, `${context} ${from}->${to}`);
    }

    // Soft warning. Fees are near-fixed in normal conditions (~$0.77-1.07 measured); a
    // meaningful excursion above that means the economics have moved and the operator
    // should see it before the daily digest.
    if (quote.costUsd > this.cfg.bridge.costAlertUsd) {
      this.onAlert(
        `Bridge cost $${quote.costUsd.toFixed(4)} (${quote.costBps}bps) on ${from}->${to} ` +
          `exceeds alert threshold $${this.cfg.bridge.costAlertUsd.toFixed(2)}. ` +
          `Expected ~$0.77-1.07. Check route health before continuing to sell.`,
      );
    }

    const result = await this.bridge.execute(from, to, amountBaseUnits, quote, idempotencyKey);

    // Every leg is logged as a real cost. Cost-per-pack and true sell-through come out of
    // the ledger, not out of the estimates in doc 00 §3 — which measurement already
    // disproved once.
    this.db.recordTreasury({
      kind: "BRIDGE_FEE",
      amount: (BigInt(amountBaseUnits) - BigInt(result.amountOut)).toString(),
      token: from === "rh" ? "USDG" : "USDC",
      chain: from,
      tx: result.depositTx,
      note: `${context} ${from}->${to} via ${this.bridge.name} (${quote.costBps}bps)`,
    });

    return { amountAvailable: result.amountOut, costUsd: result.costUsd, bridgeResult: result };
  }

  healthy(): Promise<boolean> {
    // Probe at the configured ceiling: if the largest pack we would sell cannot be routed,
    // we are not healthy for the worst case we actually accept.
    const probe = BigInt(Math.round(this.cfg.limits.maxPackPriceUsdg * 1e6)).toString();
    return this.bridge.healthy(probe);
  }
}
