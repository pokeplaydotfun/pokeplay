/**
 * Pons fee and market-cap reads for $PWA.
 *
 * From the Pons docs (docs.ponsfamily.com, read 2026-07-19):
 *
 *   "Every token trades against WETH in its own pool. There is no bonding curve and no
 *    migration later."
 *   "Trading generates liquidity fees in both the token and WETH. The protocol keeps a share
 *    and the creator keeps the rest. The creator can claim their share from the pons
 *    interface at any time. The split is snapshotted for each token when it launches and
 *    never changes afterward."
 *
 * Two consequences that answer the obvious questions:
 *
 *  - Fees are PER TOKEN, not a pooled balance across everything Pons has launched. They
 *    accrue to the locked liquidity position for our own pool, so reading them means reading
 *    that position, and no other launch can dilute or contaminate the figure.
 *  - The "fee wallet" is something the CREATOR sets at launch. It is not an address to go
 *    find; it is an address to choose. Whatever is set there is where the claimable share
 *    is directed.
 *
 * Everything below is on Robinhood Chain, the same chain as our own contracts, so this uses
 * the RPC already configured. There is no Pons API and none is needed.
 *
 * STILL UNKNOWN until launch: our token address and its pool address. Both are emitted by
 * the factory's TokenLaunched event, so `discover()` finds them from the token address
 * alone. Set PONS_TOKEN_ADDRESS and this module starts returning real numbers.
 */
import { createPublicClient, http, parseAbi, type Address, type PublicClient } from "viem";
import type { Config } from "./config.ts";

/** Published in the Pons docs. Shared infrastructure, identical for every launch. */
export const PONS = {
  factory: "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB" as Address,
  locker: "0x736D76699C26D0d966744cAe304C000d471f7F35" as Address,
  v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as Address,
  positionManager: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3" as Address,
  quoter: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7" as Address,
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address,
  /** TokenLaunched, per the docs. Truncated in their table, so matched by name at runtime. */
  factoryStartBlock: 8991118n,
} as const;

const ERC20 = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);

/** Uniswap V3 surface. Pons is a V3 fork, so the pool and position shapes are standard. */
const V3_POOL = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

const V3_FACTORY = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
]);

export type PonsStats = {
  tokenAddress: Address;
  poolAddress: Address;
  /** Cumulative creator fees received, in WETH base units. Never decreases. */
  feesWei: bigint;
  feesEth: number;
  feesUsd: number;
  priceUsd: number;
  marketCapUsd: number;
};

export class PonsReader {
  private readonly client: PublicClient;
  private readonly token: Address | undefined;
  private readonly feeWallet: Address | undefined;
  private pool: Address | undefined;
  /** Running total and how far it has been counted. See feesWei. */
  private feesAccrued = 0n;
  private feesScannedTo: bigint | null = null;

  constructor(cfg: Config, ethUsd: () => Promise<number>) {
    this.client = createPublicClient({ transport: http(cfg.rh.rpcUrl) }) as PublicClient;
    this.token = cfg.token?.address;
    this.feeWallet = cfg.token?.feeWallet;
    this.ethUsd = ethUsd;
  }

  private readonly ethUsd: () => Promise<number>;

  get configured(): boolean {
    return Boolean(this.token);
  }

  /**
   * Find our pool. Pons pairs every token against WETH, so this is a factory lookup across
   * the standard V3 fee tiers rather than something that needs to be configured by hand.
   */
  async discoverPool(): Promise<Address | null> {
    if (!this.token) return null;
    if (this.pool) return this.pool;

    for (const fee of [500, 3000, 10_000] as const) {
      try {
        const found = (await this.client.readContract({
          address: PONS.v3Factory,
          abi: V3_FACTORY,
          functionName: "getPool",
          args: [this.token, PONS.weth, fee],
        })) as Address;
        if (found && found !== "0x0000000000000000000000000000000000000000") {
          this.pool = found;
          return found;
        }
      } catch {
        // Try the next tier rather than failing: only one of them exists.
      }
    }
    return null;
  }

  /**
   * Price of one token in USD, from the pool's spot price.
   *
   * sqrtPriceX96 is the square root of the token1/token0 ratio in Q64.96. Squaring it and
   * scaling by 2^192 gives the raw ratio; which side is WETH decides whether to invert.
   */
  async priceUsd(): Promise<number> {
    const pool = await this.discoverPool();
    if (!pool || !this.token) return 0;

    const [slot0, token0] = await Promise.all([
      this.client.readContract({ address: pool, abi: V3_POOL, functionName: "slot0" }),
      this.client.readContract({ address: pool, abi: V3_POOL, functionName: "token0" }),
    ]);

    const sqrtPriceX96 = (slot0 as readonly [bigint, ...unknown[]])[0];
    const ratio = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
    const wethIsToken1 = (token0 as Address).toLowerCase() === this.token.toLowerCase();
    const tokensPerWeth = wethIsToken1 ? ratio : 1 / ratio;

    return tokensPerWeth * (await this.ethUsd());
  }

  async marketCapUsd(): Promise<number> {
    if (!this.token) return 0;
    const [supply, decimals, price] = await Promise.all([
      this.client.readContract({ address: this.token, abi: ERC20, functionName: "totalSupply" }),
      this.client.readContract({ address: this.token, abi: ERC20, functionName: "decimals" }),
      this.priceUsd(),
    ]);
    return (Number(supply) / 10 ** Number(decimals)) * price;
  }

  /**
   * Creator fees, CUMULATIVE.
   *
   * Summed from WETH Transfer events INTO the fee wallet, not read from its balance.
   *
   * Balance was wrong for two reasons, and both bite here specifically because the operator
   * chose their main wallet as the fee wallet:
   *
   *  - Spending it would make "fees earned" go DOWN. A lifetime-earned figure that drops
   *    when you move money is simply not the number anyone means.
   *  - That wallet also pays gas and holds operating funds, so any WETH arriving from
   *    somewhere else would be counted as trading fees.
   *
   * Summing inbound transfers from the pool and the locker fixes both: it only counts WETH
   * that actually came from Pons, and it never decreases.
   */
  async feesWei(): Promise<bigint> {
    if (!this.feeWallet) return 0n;
    const pool = await this.discoverPool();
    const sources = [PONS.locker.toLowerCase(), pool?.toLowerCase()].filter(Boolean) as string[];
    if (sources.length === 0) return 0n;

    /**
     * SCANNED INCREMENTALLY, because the full range is 6.2 million blocks.
     *
     * Fees only ever increase and the start block is fixed, so the total is an accumulator:
     * scan once from the Pons factory's deployment, then only ever look at blocks that are
     * new since. The first call does the wide scan — verified to work, because the `to` filter
     * is indexed and narrow — and every call after it reads a handful of blocks.
     *
     * That matters: this RPC answers `log query timed out` on wide queries that match a lot,
     * and the token page polls. Without an accumulator, every refresh would re-scan the whole
     * chain and eventually start failing as the fee wallet accumulated transfers.
     *
     * Held in memory rather than the database on purpose. A restart simply re-scans from the
     * start, which is correct and costs one wide query — whereas a persisted total that drifted
     * from the chain would be wrong with no way to notice.
     */
    const head = await this.client.getBlockNumber();
    const from = this.feesScannedTo === null ? PONS.factoryStartBlock : this.feesScannedTo + 1n;
    if (from > head) return this.feesAccrued;

    const logs = await this.client.getLogs({
      address: PONS.weth,
      event: {
        type: "event",
        name: "Transfer",
        inputs: [
          { name: "from", type: "address", indexed: true },
          { name: "to", type: "address", indexed: true },
          { name: "value", type: "uint256", indexed: false },
        ],
      },
      args: { to: this.feeWallet },
      fromBlock: from,
      toBlock: head,
    });

    let added = 0n;
    for (const log of logs) {
      const fromAddr = String((log.args as { from?: string }).from ?? "").toLowerCase();
      if (!sources.includes(fromAddr)) continue;
      added += (log.args as { value?: bigint }).value ?? 0n;
    }

    // Advanced only after the scan succeeded, so a thrown query re-reads the same range rather
    // than skipping past fees it never counted.
    this.feesAccrued += added;
    this.feesScannedTo = head;
    return this.feesAccrued;
  }

  async stats(): Promise<PonsStats | null> {
    if (!this.token) return null;
    const pool = await this.discoverPool();
    if (!pool) return null;

    const [feesWei, priceUsd, marketCapUsd, eth] = await Promise.all([
      this.feesWei(),
      this.priceUsd(),
      this.marketCapUsd(),
      this.ethUsd(),
    ]);

    const feesEth = Number(feesWei) / 1e18;
    return {
      tokenAddress: this.token,
      poolAddress: pool,
      feesWei,
      feesEth,
      feesUsd: feesEth * eth,
      priceUsd,
      marketCapUsd,
    };
  }
}
