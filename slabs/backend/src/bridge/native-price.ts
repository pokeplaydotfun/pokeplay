/**
 * Spot price of the native tokens the bridge charges its fixed fee in.
 *
 * This exists because deBridge's fee is NOT taken out of the transferred stablecoin. It is a
 * separate charge in ETH (on Robinhood Chain) or SOL, paid as tx.value or lamports. The
 * quote endpoint's amountIn/amountOut delta therefore understates the true cost of a
 * transfer by roughly $1 to $2, which is the difference between the $50 pack tier being
 * marginally profitable and losing money on every sale.
 *
 * Measured 2026-07-19: 0.001 ETH out, 0.015 SOL back. Fixed per transfer, not proportional.
 */

type Cached = { usd: number; at: number };

const TTL_MS = 5 * 60_000;

export class NativePrice {
  private readonly cache = new Map<string, Cached>();
  private readonly fetchImpl: typeof fetch;
  /** Used only when the feed is unreachable. Deliberately HIGH so a failure over-estimates
   *  cost and trips the abort gate, rather than under-estimating and spending blindly. */
  private readonly fallback: Record<string, number>;

  constructor(fetchImpl: typeof fetch = fetch, fallback: Record<string, number> = { ETH: 5000, SOL: 300 }) {
    this.fetchImpl = fetchImpl;
    this.fallback = fallback;
  }

  async usd(symbol: "ETH" | "SOL", now = Date.now()): Promise<number> {
    const hit = this.cache.get(symbol);
    if (hit && now - hit.at < TTL_MS) return hit.usd;

    try {
      const res = await this.fetchImpl(`https://api.coinbase.com/v2/prices/${symbol}-USD/spot`, {
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json()) as { data?: { amount?: string } };
      const usd = Number(body.data?.amount);
      if (!Number.isFinite(usd) || usd <= 0) throw new Error(`bad price for ${symbol}`);
      this.cache.set(symbol, { usd, at: now });
      return usd;
    } catch {
      // No throw: a price feed outage must not stop fulfilment of an order whose money we
      // already took. Over-estimating is the safe direction.
      return this.fallback[symbol]!;
    }
  }

  /** USD value of a native-token amount given in its smallest unit. */
  async nativeToUsd(symbol: "ETH" | "SOL", smallestUnits: bigint): Promise<number> {
    const decimals = symbol === "ETH" ? 1e18 : 1e9;
    return (Number(smallestUnits) / decimals) * (await this.usd(symbol));
  }
}
