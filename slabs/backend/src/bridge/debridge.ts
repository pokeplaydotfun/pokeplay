/**
 * deBridge (DLN) client.
 *
 * Chosen over Across because Across has NO live Solana route in either direction — verified
 * empirically 2026-07-18, see docs/verification/verification-results.md T4/T4b. deBridge is
 * currently the only bridge serving both legs of USDG(4663) <-> USDC(Solana).
 *
 * Measured behaviour (quotes, $50):
 *   RH -> Solana : ~$0.77 (154bps), ~1s
 *   Solana -> RH : ~$0.91 (182bps), ~9s
 * The fee is near-FIXED per transfer, not proportional. That is why costUsd, not costBps,
 * is what the pipelines gate on.
 */
import type { Bridge, BridgeQuote, BridgeResult, Chain } from "./types.ts";
import { BridgeCostExceeded } from "./types.ts";
import type { Config } from "../config.ts";
import { NativePrice } from "./native-price.ts";

/** A deposit was made but the fill did not confirm in time. NOT the same as a failure. */
export class BridgeFillTimeout extends Error {
  // Explicit fields, not constructor parameter properties: Node's strip-only type mode
  // rejects those outright, and this file runs under it.
  readonly orderId: string;
  readonly depositTx: string;
  readonly lastStatus: string;
  readonly leg: Chain;

  constructor(orderId: string, depositTx: string, lastStatus: string, leg: Chain) {
    super(
      `deBridge order ${orderId} did not fill in time (last status: ${lastStatus}, ` +
        `deposit ${depositTx} on ${leg}). The deposit IS on chain and may still fill. ` +
        `Do NOT resubmit: check the order before taking any action.`,
    );
    this.name = "BridgeFillTimeout";
    this.orderId = orderId;
    this.depositTx = depositTx;
    this.lastStatus = lastStatus;
    this.leg = leg;
  }
}

/** Signers are injected so the client stays testable and holds no key material itself. */
export type EvmSigner = {
  /**
   * `onSent` fires the moment the transaction is broadcast, before any receipt wait. The
   * bridge uses it to persist the deposit hash immediately: the receipt wait is up to 180s,
   * and a timeout there on a deposit that already landed would otherwise look like "never
   * sent" and cause a SECOND full-price deposit on retry.
   */
  sendTransaction(
    tx: { to: `0x${string}`; data: `0x${string}`; value: bigint },
    onSent?: (txHash: string) => void,
  ): Promise<string>;
  /**
   * Make sure `spender` can pull `amount` of `token` from us before the bridge tx is sent.
   *
   * deBridge moves the source ERC-20 with transferFrom, so without an allowance the deposit
   * reverts. Nothing in this repo had ever approved it: the worker's USDG allowance to
   * deBridge was ZERO on mainnet, which meant EVERY pack open would have failed at the bridge
   * step. Discovered 19 Jul 2026 while proving the outbound leg.
   */
  ensureAllowance?(token: `0x${string}`, spender: `0x${string}`, amount: bigint): Promise<void>;
};
export type SolanaSigner = {
  /**
   * `onSent` fires the moment the transaction is broadcast, before confirmation is awaited.
   *
   * The RH leg got this and the Solana leg did not. A confirmation timeout after a deposit
   * has already landed leaves no durable record, the dedupe at the top of execute() keys on
   * exactly the field that was never written, and the retry sends a SECOND full-value
   * deposit — inside a must-complete loop, on the leg that carries a seller's proceeds.
   */
  signAndSend(encodedTx: string, onSent?: (signature: string) => void): Promise<string>;
};

/** Survives a restart in production. The in-memory default survives nothing. */
export type IdempotencyStore = {
  get(key: string): Promise<{ depositTx: string; orderId?: string } | null>;
  set(key: string, value: { depositTx: string; orderId?: string }): Promise<void>;
};

type CreateTx = {
  orderId: string;
  to: string;
  data: string;
  value: string;
  fixFee: string;
  amountOut: string;
};

type DlnCreateTxResponse = {
  errorCode?: string;
  errorMessage?: string;
  orderId?: string;
  fixFee?: string;
  estimation?: { dstChainTokenOut: { amount: string } };
  tx?: { to?: string; data: string; value?: string };
};

type DlnStatusResponse = {
  status?: string;
  errorCode?: string;
  fulfilledDstEventMetadata?: { transactionHash?: { stringValue?: string } };
};

const FILLED_STATES = new Set(["Fulfilled", "SentUnlock", "ClaimedUnlock"]);
const FAILED_STATES = new Set(["OrderCancelled", "SentOrderCancel", "ClaimedOrderCancel"]);

type DlnQuoteResponse = {
  errorCode?: string;
  errorMessage?: string;
  estimation?: {
    srcChainTokenIn: { amount: string; approximateUsdValue: number };
    dstChainTokenOut: { amount: string; recommendedAmount: string; approximateUsdValue: number };
  };
  order?: { approximateFulfillmentDelay?: number };
  tx?: { to: string; data: string; value: string };
};

export class DeBridgeClient implements Bridge {
  readonly name = "debridge";
  private readonly cfg: Config;
  private readonly fetchImpl: typeof fetch;

  private readonly price: NativePrice;
  private readonly evm: EvmSigner | undefined;
  private readonly solana: SolanaSigner | undefined;
  private readonly store: IdempotencyStore;

  constructor(
    cfg: Config,
    opts: {
      fetchImpl?: typeof fetch;
      evm?: EvmSigner;
      solana?: SolanaSigner;
      store?: IdempotencyStore;
      price?: NativePrice;
    } = {},
  ) {
    this.cfg = cfg;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.evm = opts.evm;
    this.solana = opts.solana;
    this.price = opts.price ?? new NativePrice(this.fetchImpl);
    this.store = opts.store ?? memoryStore();
  }

  /** Where funds land on the far side. Our own wallets on both chains. */
  private recipient(chain: Chain): string {
    return chain === "rh" ? this.cfg.rh.workerAddress : this.cfg.solana.operatorAddress;
  }

  private chainId(chain: Chain): number {
    return chain === "rh" ? this.cfg.bridge.rhChainId : this.cfg.bridge.solanaChainId;
  }

  private token(chain: Chain): string {
    return chain === "rh" ? this.cfg.rh.usdgAddress : this.cfg.solana.usdcMint;
  }

  async quote(from: Chain, to: Chain, amountBaseUnits: string): Promise<BridgeQuote> {
    if (from === to) throw new Error(`quote: from and to are both ${from}`);

    const url = new URL(`${this.cfg.bridge.apiUrl}/dln/order/quote`);
    url.searchParams.set("srcChainId", String(this.chainId(from)));
    url.searchParams.set("srcChainTokenIn", this.token(from));
    url.searchParams.set("srcChainTokenInAmount", amountBaseUnits);
    url.searchParams.set("dstChainId", String(this.chainId(to)));
    url.searchParams.set("dstChainTokenOut", this.token(to));
    url.searchParams.set("prependOperatingExpenses", "false");

    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    const body = (await res.json()) as DlnQuoteResponse;

    if (body.errorCode || !body.estimation) {
      throw new Error(
        `deBridge quote failed (${from} -> ${to}, ${amountBaseUnits}): ` +
          `${body.errorCode ?? res.status} ${body.errorMessage ?? ""}`,
      );
    }

    const amountIn = BigInt(body.estimation.srcChainTokenIn.amount);
    const amountOut = BigInt(body.estimation.dstChainTokenOut.recommendedAmount);
    const costBaseUnits = amountIn - amountOut;

    // Both legs are 6dp stablecoins, so base units map 1:1 to USD cents at 1e6.
    const costUsd = Number(costBaseUnits) / 1e6;
    const costBps = amountIn > 0n ? Number((costBaseUnits * 10_000n) / amountIn) : 0;

    return {
      amountIn: amountIn.toString(),
      amountOut: amountOut.toString(),
      costUsd,
      costBps,
      estimatedSeconds: body.order?.approximateFulfillmentDelay ?? 30,
      raw: body,
    };
  }

  /**
   * Submit a DLN order and wait for it to fill.
   *
   * Idempotency is the hard part and it is not optional: this method spends money, and a
   * crash between "sent" and "confirmed" leaves us unable to answer "did I already pay?"
   * from local state alone. Two mechanisms, in order:
   *
   *   1. The store is consulted first. If we recorded a deposit tx for this key, we resume
   *      polling that order instead of sending a second one.
   *   2. deBridge's /dln/tx/{hash}/order-ids maps a source tx back to its order, so a
   *      recorded hash is always enough to recover the order id after a restart.
   *
   * The store MUST be durable in production. The in-memory default survives nothing.
   */
  async execute(
    from: Chain,
    to: Chain,
    amountBaseUnits: string,
    quote: BridgeQuote,
    idempotencyKey: string,
  ): Promise<BridgeResult> {
    if (from === to) throw new Error(`execute: from and to are both ${from}`);

    const prior = await this.store.get(idempotencyKey);
    if (prior?.depositTx) {
      const orderId = prior.orderId ?? (await this.orderIdForTx(prior.depositTx));
      if (orderId) return this.awaitFill(orderId, prior.depositTx, quote, from);
    }

    // Re-price rather than trusting the passed quote: it may be seconds or minutes old, and
    // the gate below is the last thing standing between us and an unprofitable transfer.
    const fresh = await this.createTx(from, to, amountBaseUnits);

    // THE COST GATE. quote.costUsd covers only the stablecoin delta; deBridge also charges a
    // fixed fee in the source chain's native token, which is the larger half on small
    // transfers. Gating on the stablecoin delta alone was the bug that made the $50 tier
    // look viable when it was not.
    const nativeSymbol = from === "rh" ? "ETH" : "SOL";
    const nativeFeeUsd = await this.price.nativeToUsd(nativeSymbol, BigInt(fresh.fixFee));
    const stableCostUsd = (Number(BigInt(amountBaseUnits) - BigInt(fresh.amountOut))) / 1e6;
    const totalCostUsd = nativeFeeUsd + stableCostUsd;

    if (totalCostUsd > this.cfg.bridge.costAbortUsd) {
      throw new BridgeCostExceeded(totalCostUsd, this.cfg.bridge.costAbortUsd, `${from}->${to}`);
    }

    /**
     * Persist the hash the INSTANT it is broadcast, not once the send resolves.
     *
     * The send does not resolve until its on-chain receipt lands, which is up to 180s away.
     * Recording only after that left a 180s window in which the money had irreversibly left
     * the worker wallet while our durable record still said nothing had been sent. Any
     * timeout, RPC error or restart in that window meant the retry read `!fresh && !tx` and
     * sent a SECOND full-price deposit, per order, with nothing behind it.
     *
     * The dedupe at the top of this method keys on `prior?.depositTx`, so it could never
     * catch that case: the field it checks was precisely the one that had not been written.
     */
    const recordDeposit = (depositTx: string) =>
      void this.store.set(idempotencyKey, { depositTx, orderId: fresh.orderId });

    const depositTx =
      from === "rh"
        ? await this.sendEvm(fresh, amountBaseUnits, recordDeposit)
        : await this.sendSolana(fresh, recordDeposit);

    // Idempotent with the callback above; the Solana path has no broadcast hook yet, so this
    // remains the only record for that direction.
    await this.store.set(idempotencyKey, { depositTx, orderId: fresh.orderId });

    return this.awaitFill(fresh.orderId, depositTx, { ...quote, costUsd: totalCostUsd }, from);
  }

  // ---------------------------------------------------------------- internals

  private async createTx(from: Chain, to: Chain, amountBaseUnits: string): Promise<CreateTx> {
    const url = new URL(`${this.cfg.bridge.apiUrl}/dln/order/create-tx`);
    url.searchParams.set("srcChainId", String(this.chainId(from)));
    url.searchParams.set("srcChainTokenIn", this.token(from));
    url.searchParams.set("srcChainTokenInAmount", amountBaseUnits);
    url.searchParams.set("dstChainId", String(this.chainId(to)));
    url.searchParams.set("dstChainTokenOut", this.token(to));
    url.searchParams.set("dstChainTokenOutRecipient", this.recipient(to));
    url.searchParams.set("srcChainOrderAuthorityAddress", this.recipient(from));
    url.searchParams.set("dstChainOrderAuthorityAddress", this.recipient(to));
    url.searchParams.set("prependOperatingExpenses", "false");

    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
    const body = (await res.json()) as DlnCreateTxResponse;
    if (body.errorCode || !body.tx || !body.orderId || !body.estimation) {
      throw new Error(
        `deBridge create-tx failed (${from} -> ${to}, ${amountBaseUnits}): ` +
          `${body.errorCode ?? res.status} ${body.errorMessage ?? ""}`,
      );
    }
    return {
      orderId: body.orderId,
      to: body.tx.to ?? "",
      data: body.tx.data,
      value: body.tx.value ?? "0",
      fixFee: body.fixFee ?? "0",
      amountOut: body.estimation.dstChainTokenOut.amount,
    };
  }

  /** Robinhood Chain side: a plain EVM transaction carrying the fixed fee as value. */
  private async sendEvm(
    tx: CreateTx,
    amountBaseUnits: string,
    onSent?: (txHash: string) => void,
  ): Promise<string> {
    if (!this.evm) throw new Error("EVM signer not configured; cannot bridge from Robinhood Chain");

    /**
     * Bound the native value by the fee we actually priced.
     *
     * The cost gate above prices `fresh.fixFee` and aborts if it is too expensive — but the
     * transaction attaches `tx.value`, and nothing compared the two. A deBridge response (or
     * anything able to answer as deBridge) returning `fixFee: "0"` with a large `value` sails
     * through the gate and drains native ETH from the worker wallet, which is also the
     * treasury. The gate was measuring one number while the send used another.
     *
     * A small tolerance because the two are quoted moments apart and the fee is not perfectly
     * stable; anything beyond that is not a rounding difference, it is a different number.
     */
    const priced = BigInt(tx.fixFee);
    const attached = BigInt(tx.value);
    const ceiling = priced + priced / 10n + 1n; // +10%
    if (attached > ceiling) {
      throw new Error(
        `deBridge asked for ${attached} wei but the cost gate priced ${priced}. Refusing to ` +
          `send: the value attached to the transaction must match the fee we approved.`,
      );
    }
    // Before the deposit, not after: an unapproved transferFrom simply reverts.
    await this.evm.ensureAllowance?.(
      this.token("rh") as `0x${string}`,
      tx.to as `0x${string}`,
      BigInt(amountBaseUnits),
    );
    return this.evm.sendTransaction(
      {
        to: tx.to as `0x${string}`,
        data: tx.data as `0x${string}`,
        value: BigInt(tx.value),
      },
      onSent,
    );
  }

  /** Solana side: create-tx returns a base64 VersionedTransaction needing our signature. */
  private async sendSolana(tx: CreateTx, onSent?: (signature: string) => void): Promise<string> {
    if (!this.solana) throw new Error("Solana signer not configured; cannot bridge from Solana");
    return this.solana.signAndSend(tx.data, onSent);
  }

  private async orderIdForTx(txHash: string): Promise<string | null> {
    try {
      const res = await this.fetchImpl(`${this.cfg.bridge.apiUrl}/dln/tx/${txHash}/order-ids`, {
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json()) as { orderIds?: string[] };
      return body.orderIds?.[0] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Poll until the order fills.
   *
   * Timing out here does NOT mean the transfer failed: the deposit is on chain and deBridge
   * may still fill it. The error says so explicitly, because the wrong reaction to this is
   * to retry the transfer and pay twice.
   */
  private async awaitFill(
    orderId: string,
    depositTx: string,
    quote: BridgeQuote,
    from: Chain,
  ): Promise<BridgeResult> {
    const deadline = Date.now() + this.cfg.bridge.fillTimeoutMs;
    let last = "unknown";

    while (Date.now() < deadline) {
      const res = await this.fetchImpl(`${this.cfg.bridge.apiUrl}/dln/order/${orderId}/status`, {
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json()) as DlnStatusResponse;
      last = body.status ?? body.errorCode ?? "unknown";

      if (FILLED_STATES.has(last)) {
        return {
          providerOrderId: orderId,
          depositTx,
          /**
           * Frequently null, and that is NOT a failure.
           *
           * Measured against the live API on 19 Jul 2026 for a real Solana -> RH fill: the
           * status endpoint returned exactly `{status: "Fulfilled", orderId}` with no
           * `fulfilledDstEventMetadata` key at all, while the USDG had demonstrably arrived.
           * So this stays null on that route and callers must treat it as optional.
           *
           * Nothing depends on it. `toRhChain` filters nulls out of its tx list, and a
           * seller's proof of payment is `payout_tx` from the separate payUsdg transfer, not
           * this. Recorded here only so the next person does not treat a null fillTx as
           * evidence the bridge failed.
           */
          fillTx: body.fulfilledDstEventMetadata?.transactionHash?.stringValue ?? null,
          amountOut: quote.amountOut,
          costUsd: quote.costUsd,
        };
      }
      if (FAILED_STATES.has(last)) {
        throw new Error(`deBridge order ${orderId} ended in ${last} (deposit ${depositTx})`);
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }

    throw new BridgeFillTimeout(orderId, depositTx, last, from);
  }

  /**
   * Liveness probe for the health gate. A quote failure means we cannot fulfil, so buys
   * must stop (doc 02 §8, invariant 3) — better to show "restocking" than to take money
   * we cannot convert.
   */
  async healthy(probeAmountBaseUnits: string): Promise<boolean> {
    try {
      const [out, back] = await Promise.all([
        this.quote("rh", "solana", probeAmountBaseUnits),
        this.quote("solana", "rh", probeAmountBaseUnits),
      ]);
      // Both directions must be live: taking a payment we can bridge out but not back
      // would strand the sell-back promise.
      return out.costUsd <= this.cfg.bridge.costAbortUsd && back.costUsd <= this.cfg.bridge.costAbortUsd;
    } catch {
      return false;
    }
  }
}

/** Non-durable. Fine for tests, never for a worker that can restart mid-transfer. */
function memoryStore(): IdempotencyStore {
  const m = new Map<string, { depositTx: string; orderId?: string }>();
  return {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => void m.set(k, v),
  };
}
