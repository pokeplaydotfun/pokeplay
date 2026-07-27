/**
 * Flow A — pack fulfilment (doc 02 §3, doc 04 §2).
 *
 *   CREATED -> BRIDGING -> OPENING -> REVEALED -> MINTED
 *
 * Every step is idempotent and resumable: external sends claim an intent row BEFORE going
 * out, so a crash between send and confirm never spends twice.
 *
 * THE INVARIANT THAT MATTERS. The moment `submitTransaction` succeeds, real USDC has left
 * our wallet and a real pack exists. From that point the order is **must-complete**: no code
 * path may auto-refund it. The DB enforces this (setOrderStatus throws once cc_open_tx is
 * set) and this file never attempts it. The only escape is a human calling
 * PackSale.forceRefund (doc 06 runbook 6).
 *
 * ⚠ That escape is meant to be out of the worker's reach, and AS DEPLOYED IT IS NOT. One key
 * is owner, worker, drawer, guardian and custodian (verified on chain 20 Jul), so a compromised
 * worker key can call forceRefund itself. The separation this file relies on is a property of
 * the deployment, not of the code, and right now the deployment does not have it. Fixed by
 * transferring ownership to a cold key — no redeploy needed.
 */
import type { Db, OrderRow } from "../db/index.ts";
import type { SolanaAddress } from "../chains/address.ts";
import type { CollectorCryptClient } from "../cc/types.ts";
import { CcApiError, CcAuthRequiredError } from "../cc/types.ts";
import type { LiquiditySource } from "../bridge/types.ts";
import type { Config } from "../config.ts";

/** Signs a CC-issued Solana transaction, preserving CC's co-signature. */
export interface SolanaSigner {
  /**
   * The SOLANA wallet that buys packs, branded so it cannot be handed an EVM address.
   *
   * This is passed to Collector Crypt as `playerAddress`. It is correct today, but its sibling
   * `buildBuyback` was given `chain.operatorAddress` — the Robinhood Chain address — and that
   * broke the first live sell-back. Both are plain strings to the compiler; the brand is what
   * stops the same substitution happening here.
   */
  readonly address: SolanaAddress;
  signBase64(transactionBase64: string): string;
}

/** Mints the mirror and releases escrow atomically, via the Fulfiller contract. */
export interface MirrorMinter {
  fulfill(params: {
    orderId: number;
    buyer: string;
    solanaMint: string;
    ccOpenTx: string;
    revealAt: number;
    tokenUri: string;
  }): Promise<{ tokenId: string; txHash: string }>;
}

export type PipelineDeps = {
  db: Db;
  cc: CollectorCryptClient & {
    awaitReveal?(memo: string, opts?: { attempts?: number; intervalMs?: number }): Promise<{
      memo: string;
      openTx: string;
      revealedMint: string | null;
      revealAt: number;
      /** CC's own rarity for the roll. Authoritative when present. */
      rarity?: string | null;
    }>;
    fetchCardMetaByMemo?(memo: string): Promise<import("../cc/types.ts").CardMetadata>;
  };
  liquidity: LiquiditySource;
  signer: SolanaSigner;
  minter: MirrorMinter;
  cfg: Config;
  alert?: (message: string) => void;
  tokenUriFor?: (orderId: number, solanaMint: string) => string;
  /** Reveal polling budget. Overridable so tests do not sleep for real. */
  revealPolling?: { attempts: number; intervalMs: number };
  /**
   * Once the fast-retry budget is spent, an order is retried at most once per this window.
   * Never zero-forever: a stranded order must self-heal when the underlying fault is fixed,
   * without a human remembering to poke it.
   */
  retryCooldownMs?: number;
  /**
   * The chain's own view of an order. Injected rather than taking an RhChain dependency so
   * tests can drive it, and so the demo server can omit it entirely.
   *
   * Why this exists: `PackSale.refund` is PERMISSIONLESS and needs only that the deadline has
   * passed (PackSale.sol:169). The on-chain timeout is 10 minutes, while one failed bridge
   * attempt plus the 5-minute retry cooldown already exceeds that. So a buyer — or anyone
   * watching — can refund an order while this pipeline is still working on it.
   *
   * Without this check the worker then bridges, buys a REAL pack, and `markFulfilled` reverts
   * OrderNotPending forever: we paid for a card, the buyer got their money back, and the
   * order retries for eternity. That is farmable on purpose, not just an accident.
   *
   * Returns null when the order is unknown to the chain.
   */
  onChainOrder?: (orderId: number) => Promise<{ status: string; deadline: number } | null>;
  /**
   * Refund a timed-out order on chain, returning the tx hash. Injected for the same reason as
   * `onChainOrder`. Omitted means no refund sweep runs — correct for the demo server, which
   * has no chain to refund on.
   */
  refundOrder?: (orderId: number) => Promise<string>;
  /**
   * The operator's actual Solana USDC balance, in base units.
   *
   * Needed because the bridge takes its cut OUT of the transfer: send 250 USDG and $249.07
   * arrives. `pokemon_50` and `water_100` survive that only because their on-chain price
   * carries a $3 service fee, so 53 is bridged for a $50 pack. `pokemon_250` and
   * `pokemon_1000` carry no fee and are priced at exactly the pack price, so they arrive
   * SHORT by $0.93 and $1.53 — measured against the live deBridge API on 19 Jul 2026, not
   * estimated.
   *
   * Omitted means no check, which is correct for tests and the demo server.
   */
  solanaUsdcBalance?: () => Promise<bigint>;
  /**
   * Whether a custodied card is frozen and therefore immovable. Null when unreadable.
   * Injected so tests and the demo server can omit it.
   */
  assetFrozen?: (mint: string) => Promise<boolean | null>;
  /**
   * Take the order's payment out of escrow so it can fund the pack.
   *
   * The operator holds no working capital, and a bridge sends from an EOA rather than from
   * PackSale, so the buyer's own money has to leave escrow before the pack is bought. Called
   * immediately before bridging and never earlier: every check that can refuse an order for
   * free happens first, so the permissionless on-chain refund stays available for as long as
   * it possibly can.
   *
   * Resolves to "already-drawn" rather than throwing when the contract has already paid out,
   * so a crash between the draw and the bridge resumes instead of stranding the order.
   */
  drawForOpen?: (orderId: number) => Promise<string>;
  /**
   * Pay a buyer back directly, for orders whose payment was already drawn out of escrow.
   *
   * The contract refuses to refund those (it no longer holds the money), so this is the only
   * route left. Same USDG transfer the sell-back payout uses.
   */
  refundDrawnOrder?: (buyer: string, amountUsdg: string, onSent?: (txHash: string) => void) => Promise<string>;
  /** Did a previously broadcast transaction land? Resolves a resumed direct refund. */
  /** true = succeeded, false = definitely reverted, null = unknown (pending or RPC down). */
  txSucceeded?: (txHash: string) => Promise<boolean | null>;
  /**
   * How much USDC will actually land on Solana for a given USDG send.
   *
   * The bridge takes its fee OUT of the transfer, so this is always less than the amount
   * sent. Used to decide whether an open can complete BEFORE the buyer's payment is drawn.
   */
  expectedBridgeArrival?: (amountUsdg: string) => Promise<bigint>;
  /**
   * Decode the NAME of a custom contract error. Injected so the pipeline stays chain-agnostic
   * and tests can drive real viem error objects rather than invented strings — matching on
   * message prose is exactly how these branches went dead.
   */
  revertErrorName?: (err: unknown) => string | null;
  /** Free a drawn order's on-chain slot after refunding its buyer directly. */
  closeDrawnOrder?: (orderId: number, reason: string) => Promise<string>;
  /**
   * Which mirror token was minted for an order, read from the chain. 0n when none.
   *
   * Needed to close a mint that was interrupted between broadcasting and recording. The chain
   * is the only place that answer survives a crash.
   */
  mintedTokenFor?: (orderId: number) => Promise<bigint>;
};

/**
 * Thrown when the chain says an order is no longer ours to spend against. Distinct from a
 * generic failure because it must NOT be retried — the order is settled, not stuck.
 */
export class OrderSettledOnChain extends Error {
  // Plain fields, not parameter properties: Node's strip-only mode rejects those and tsc
  // does not, so the failure only shows up at runtime.
  readonly orderId: number;
  readonly onChainStatus: string;

  constructor(orderId: number, onChainStatus: string) {
    super(`Order ${orderId} is ${onChainStatus} on chain — refusing to spend against it`);
    this.name = "OrderSettledOnChain";
    this.orderId = orderId;
    this.onChainStatus = onChainStatus;
  }
}

const FAST_RETRY_BUDGET = 20;
const DEFAULT_RETRY_COOLDOWN_MS = 5 * 60_000;

export class FulfillmentPipeline {
  private readonly d: PipelineDeps;

  constructor(deps: PipelineDeps) {
    this.d = deps;
  }

  private alert(message: string): void {
    (this.d.alert ?? console.warn)(message);
  }

  /** Resume set after a restart (doc 04 §8). */
  async resumeAll(): Promise<void> {
    for (const order of this.d.db.activeOrders()) {
      try {
        await this.processOrder(order.id);
      } catch (err) {
        this.alert(`Resume of order ${order.id} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /**
   * Refund every order that timed out without a pack ever being bought.
   *
   * The product promises this in four places — App.tsx:447, useBuyPack.ts:131 and two FAQ
   * answers in HowItWorks — and until 19 Jul 2026 nothing performed it. `refundableOrders()`
   * existed with zero callers, so a failed order sat in escrow forever and the buyer's only
   * recourse was to call a contract function no UI exposes.
   *
   * Two reasons this is not merely a courtesy. `openOrderCount` decrements only on fulfil or
   * refund, and `maxOpenOrders` is 5 (PackSale.sol:58) — so five stuck orders close the store
   * for everyone, permanently, with no automated recovery. And the 66h sell window ticks down
   * on chain regardless of whether anyone is working the order.
   *
   * Safety comes from the contract, not from this query. `refund` reverts unless the order is
   * still PENDING with the deadline passed, so the worst case for a wrong row here is a
   * reverted simulation, not a double payment. `refundableOrders` additionally requires
   * `cc_open_tx IS NULL`: an order that bought a pack is never auto-refunded, only escalated
   * to the human forceRefund runbook.
   */
  async refundTimedOut(): Promise<void> {
    if (!this.d.refundOrder) return;

    for (const order of this.d.db.refundableOrders()) {
      try {
        const tx = await this.d.refundOrder(order.id);
        this.d.db.setOrderStatus(order.id, "REFUNDED", { last_error: `refunded on chain: ${tx}` });
        this.alert(`Order ${order.id} timed out without a pack. Refunded on chain (${tx}).`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        /**
         * The contract cannot refund a DRAWN order, and that is by design: we already took
         * the money out to fund the pack. So we owe it directly.
         *
         * This is the other half of the draw. Without it a bridge failure after the draw
         * would leave the buyer with no refund from either side — the contract reverts with
         * AlreadyDrawn and nothing else would pay them. The money is in the worker wallet, so
         * paying from there is both possible and correct.
         */
        if (this.d.revertErrorName?.(err) === "AlreadyDrawn") {
          if (!this.d.refundDrawnOrder) {
            this.alert(
              `Order ${order.id}: payment was drawn and cannot be refunded on chain, and no ` +
                `direct refund is wired. The buyer is owed ${order.price_usdg} and MUST be paid by hand.`,
            );
            continue;
          }

          /**
           * Claim an intent BEFORE paying, exactly as every other spend in this file does.
           *
           * Without it this was the only unguarded spend in the codebase, and the blast radius
           * was the whole treasury. `payUsdg` broadcasts and then waits up to 120s for a
           * receipt; a timeout throws AFTER the money has left. The order was then never
           * marked REFUNDED, so it still matched refundableOrders(), and this sweep runs on
           * EVERY TICK — every 4 seconds. The buyer would have been paid a second full pack
           * price, and a third, until the worker's USDG ran out.
           *
           * The pattern is the same one payAndBurn uses: claim first, record the hash the
           * instant it is broadcast, ask the chain on resume, and release the claim only when
           * the broadcast callback provably never fired.
           */
          const key = this.intentKey("direct-refund", order.id);
          const claim = this.d.db.claimIntent(key, "direct-refund", {
            orderId: order.id,
            buyer: order.buyer,
            amount: order.price_usdg,
          });

          if (!claim.fresh && claim.tx) {
            // null when we have no way to ask, which is an UNKNOWN and not a failure.
            const landed = this.d.txSucceeded ? await this.d.txSucceeded(claim.tx) : null;

            if (landed === true) {
              this.d.db.setOrderStatus(order.id, "REFUNDED", { last_error: `refunded directly: ${claim.tx}` });
              await this.closeOnChain(order.id);
              this.alert(`Order ${order.id}: direct refund ${claim.tx} had already landed. Not paying again.`);
            } else if (landed === false) {
              /**
               * Definitely reverted, so the buyer is still owed. RELEASE the intent rather than
               * marking it FAILED: a FAILED row keeps its hash, and `clearIntent` only removes
               * rows without one, so the old code re-checked the same dead hash every sweep and
               * never re-sent the refund. Same dead end as the buyback payout.
               */
              this.d.db.releaseRevertedIntent(key);
              this.alert(`Order ${order.id}: direct refund ${claim.tx} reverted. Released for a fresh attempt.`);
            } else {
              // Pending or unreadable. Holding is the only safe move — releasing a claim whose
              // refund actually landed would pay the buyer twice.
              this.alert(
                `Order ${order.id}: cannot determine whether refund ${claim.tx} landed. Holding.`,
              );
            }
            continue;
          }
          if (!claim.fresh && !claim.tx) {
            this.alert(
              `Order ${order.id}: a direct refund was claimed with no tx recorded. Refusing to ` +
                `pay again blindly — check USDG transfers to ${order.buyer} before retrying.`,
            );
            continue;
          }

          let broadcast = false;
          try {
            const tx = await this.d.refundDrawnOrder(order.buyer, order.price_usdg, (hash) => {
              broadcast = true;
              this.d.db.recordIntentTx(key, hash, "SENT");
            });
            this.d.db.recordIntentTx(key, tx, "CONFIRMED");
            this.d.db.setOrderStatus(order.id, "REFUNDED", { last_error: `refunded directly: ${tx}` });
            await this.closeOnChain(order.id);
            this.alert(`Order ${order.id}: payment had been drawn, so refunded the buyer directly (${tx}).`);
          } catch (payErr) {
            if (!broadcast) this.d.db.clearIntent(key);
            this.alert(
              `Order ${order.id}: DRAWN and the direct refund ${broadcast ? "may have been sent" : "was refused"} ` +
                `— the buyer is owed ${order.price_usdg} USDG. ${payErr instanceof Error ? payErr.message : payErr}`,
            );
          }
          continue;
        }
        // Someone else refunding first is the system working as intended: `refund` is
        // permissionless precisely so a buyer never depends on us. Reconcile and move on.
        if (this.d.revertErrorName?.(err) === "OrderNotPending") {
          this.d.db.setOrderStatus(order.id, "REFUNDED", { last_error: "already refunded on chain" });
          this.alert(`Order ${order.id} was already refunded by someone else. Reconciled.`);
          continue;
        }
        this.alert(`Refund of order ${order.id} failed: ${message}`);
      }
    }
  }

  /**
   * Drives one order as far as it can go. Safe to call repeatedly — each step is a no-op if
   * already done, so this doubles as the retry entry point.
   */
  async processOrder(orderId: number): Promise<void> {
    let order = this.requireOrder(orderId);

    // A single call advances an order at most this far. Without it, a step that fails and
    // immediately re-arms (FAILED -> REVEALED -> FAILED …) spins forever: the status keeps
    // changing, so a change-detecting loop never terminates. Bounding the work per call
    // also keeps one sick order from starving every other order in the queue.
    const MAX_TRANSITIONS_PER_CALL = 12;

    for (let i = 0; i < MAX_TRANSITIONS_PER_CALL; i++) {
      const before = order.status;

      switch (order.status) {
        case "CREATED":
          await this.bridge(order);
          break;
        case "BRIDGING":
          await this.openPack(order);
          break;
        case "OPENING":
          await this.reveal(order);
          break;
        case "REVEALED":
          await this.mint(order);
          break;
        case "FAILED":
          await this.retryFailed(order);
          break;
        default:
          return; // MINTED / REFUNDED / FORCE_REFUNDED — terminal
      }

      order = this.requireOrder(orderId);
      if (order.status === before) return; // no progress; avoid spinning
    }
  }

  /**
   * Release a drawn order's on-chain slot after its buyer has been made whole.
   *
   * openOrderCount only decrements on fulfil or refund, and a drawn order cannot be refunded
   * by the contract, so without this every drawn-then-failed order holds a slot forever and
   * five of them close the storefront permanently.
   */
  private async closeOnChain(orderId: number): Promise<void> {
    if (!this.d.closeDrawnOrder) return;
    try {
      await this.d.closeDrawnOrder(orderId, "refunded directly after draw");
    } catch (err) {
      this.alert(
        `Order ${orderId}: buyer refunded but closing it on chain failed, so its open-order ` +
          `slot is still held. ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private requireOrder(orderId: number): OrderRow {
    const order = this.d.db.getOrder(orderId);
    if (!order) throw new Error(`Order ${orderId} not found`);
    return order;
  }

  /**
   * Refuse to spend against an order the chain has already settled, or is about to let go.
   *
   * Called before the two steps that move money — bridging and buying — and deliberately NOT
   * before minting: once a pack is bought the order must complete, and `markFulfilled` is
   * explicitly allowed after the deadline (PackSale.sol:183) so a slow-but-successful
   * fulfilment finishes rather than refunding.
   *
   * A REFUNDED order is reconciled into our database rather than left to retry forever. The
   * money is already back with the buyer; the only thing left is to stop working on it.
   *
   * No `onChainOrder` (tests, demo) means no check — the caller is not on a real chain.
   */

  /**
   * An intent key, scoped to the DEPLOYMENT it belongs to.
   *
   * Intent keys used to be `mint:order:1` and friends — the bare on-chain order id. That id
   * comes from PackSale's `nextOrderId`, which restarts at 1 on every redeploy, so after one
   * the FIRST new order inherits the previous deployment's intents. `claimIntent` reports a
   * claimed key as "already done", so the pipeline would conclude the pack was already
   * bought, write the OLD memo onto the new order — which makes it must-complete, closing the
   * automatic refund — and never buy anything for the buyer who paid.
   *
   * Verified against production on 20 Jul: bridge-out, cc-open and mint intents for order 1
   * were all sitting there CONFIRMED, from a contract nothing points at any more.
   *
   * Including the PackSale address makes an id from one deployment unable to name an intent
   * from another. Old keys are simply never consulted again, which is the correct outcome:
   * they describe spends against a contract that no longer holds anything.
   */
  private intentKey(kind: string, orderId: number): string {
    /**
     * Falls back to a literal rather than throwing on a missing address.
     *
     * A throw here would fail the order rather than the deployment scoping, which is the
     * wrong failure: the scoping exists to prevent a rare cross-deployment collision, and it
     * must never be the reason an ordinary order dies. The fallback is a fixed string, NOT
     * something derived — two deployments both missing the address would collide, but that
     * cannot happen in production, where PACK_SALE_ADDRESS is `required()` and the worker
     * refuses to boot without it.
     */
    const scope = this.d.cfg.rh?.packSaleAddress?.toLowerCase() ?? "unscoped";
    return `${kind}:order:${orderId}@${scope}`;
  }

  private async assertSpendable(order: OrderRow, step: "bridge" | "draw" | "open"): Promise<void> {
    if (!this.d.onChainOrder) return;

    const chainOrder = await this.d.onChainOrder(order.id);
    if (!chainOrder) return; // unknown to the chain; the step's own guards still apply

    if (chainOrder.status === "REFUNDED" || chainOrder.status === "FORCE_REFUNDED") {
      this.alert(
        `Order ${order.id} was ${chainOrder.status} on chain before we could ${step}. ` +
          `The buyer already has their money back. Closing the order instead of spending.`,
      );
      this.d.db.setOrderStatus(order.id, "REFUNDED");
      throw new OrderSettledOnChain(order.id, chainOrder.status);
    }

    if (chainOrder.status !== "PENDING") {
      // FULFILLED, or anything else we do not recognise. Either way it is not ours to spend.
      throw new OrderSettledOnChain(order.id, chainOrder.status);
    }

    // Still PENDING, but past the deadline: anyone can refund it out from under us at any
    // moment. Starting a spend now is a coin flip on whether we keep the card we buy.
    const deadlineMs = chainOrder.deadline * 1000;
    if (Date.now() >= deadlineMs) {
      this.alert(
        `Order ${order.id} is past its on-chain deadline and can be refunded by anyone. ` +
          `Not starting the ${step} step — the refund sweep will close it out.`,
      );
      throw new OrderSettledOnChain(order.id, "PAST_DEADLINE");
    }
  }

  // ------------------------------------------------------------------ steps

  /** CREATED -> BRIDGING. Moves the user's payment to Solana USDC. */
  private async bridge(order: OrderRow): Promise<void> {
    await this.step(order, "bridge", async () => {
      await this.assertSpendable(order, "bridge");

      /**
       * Draw the buyer's payment, LAST of the free checks and first of the committing ones.
       *
       * Everything above this line can still refuse the order at no cost, and the buyer keeps
       * a permissionless on-chain refund the whole time. Past it the contract holds nothing
       * for them and we owe the refund ourselves, so the draw sits as late as it possibly can
       * while still being before the money moves.
       */
      /**
       * Prove the open can COMPLETE before taking the buyer's money out of escrow.
       *
       * The funds gate lives in openPack, which runs AFTER the bridge. That ordering created
       * the one unrecoverable state in the draw design: draw succeeds, the USDG bridges to
       * Solana, the gate then fails, and the direct refund cannot pay because the money is no
       * longer on this chain. The order sits drawn and stuck, its open-order slot leaks, and
       * five of those close the storefront permanently.
       *
       * Checking here removes the state rather than trying to recover from it. If what will
       * arrive plus what we already hold cannot cover the pack, the order fails while still
       * UNDRAWN — so the contract refund stays available, permissionless and fully funded.
       *
       * Deliberately conservative: an unreadable balance or quote blocks the draw rather than
       * proceeding hopefully, because the failure it prevents has no clean exit.
       */
      if (this.d.drawForOpen && this.d.solanaUsdcBalance) {
        const machine = await this.d.cc.machineStatus(order.machine_id);

        /**
         * Everything that can refuse this order must refuse it BEFORE the draw.
         *
         * Both of these were checked only inside the open step, which runs after the draw and
         * after the bridge has moved the whole payment to Solana. By then the worker holds
         * essentially no USDG — the draw takes the buyer's payment in and JitSource sends all
         * of it out — so `refundDrawnOrder` tries to pay a $50 to $1000 debt from a wallet
         * with cents in it. It reverts, alerts "the buyer is owed", and retries every 4
         * seconds indefinitely while the buyer has no automatic way to get their money back.
         * The open-order slot leaks too, and five of those close the storefront.
         *
         * Undrawn, both failures are harmless: the order times out and the buyer takes the
         * permissionless on-chain refund without needing us at all. That is the whole
         * principle stated at the top of this gate, and these two checks were simply on the
         * wrong side of it.
         *
         * They are STILL re-checked in the open step. The bridge fill alone can take 180s
         * against a 10 minute deadline, so a re-check there is not redundant — but by then it
         * is protecting the pack purchase rather than the refund.
         */
        await this.assertSpendable(order, "draw");

        if (!machine.available) {
          this.alert(
            `Order ${order.id}: NOT drawing, ${order.machine_id} is out of stock. Failing it ` +
              `while still undrawn, so the buyer keeps a permissionless on-chain refund.`,
          );
          throw new CcApiError(
            "/machines",
            503,
            { machine: order.machine_id },
            `Machine ${order.machine_id} is out of stock`,
          );
        }

        const need = BigInt(machine.priceUsdc);
        const held = await this.d.solanaUsdcBalance();
        const arriving = this.d.expectedBridgeArrival
          ? await this.d.expectedBridgeArrival(order.price_usdg)
          : BigInt(order.price_usdg);

        if (held + arriving < need) {
          const short = need - (held + arriving);
          this.alert(
            `Order ${order.id}: NOT drawing. ${fmtUsdc(held)} on Solana plus ${fmtUsdc(arriving)} ` +
              `arriving is ${fmtUsdc(short)} short of the ${fmtUsdc(need)} pack. Failing it while ` +
              `still undrawn, so the buyer keeps a permissionless on-chain refund.`,
          );
          throw new Error(
            `Order ${order.id}: bridged funds would not cover the pack (short ${fmtUsdc(short)})`,
          );
        }
      }

      if (this.d.drawForOpen) {
        const drawTx = await this.d.drawForOpen(order.id);
        if (drawTx === "already-drawn") {
          this.alert(`Order ${order.id}: payment was already drawn; resuming the open.`);
        }
      }

      const key = this.intentKey("bridge-out", order.id);
      const claim = this.d.db.claimIntent(key, "bridge", { orderId: order.id, amount: order.price_usdg });

      if (!claim.fresh && claim.tx) {
        // A previous attempt completed this transfer. Do not send again.
        this.d.db.setOrderStatus(order.id, "BRIDGING", { bridge_deposit_tx: claim.tx });
        return;
      }

      // Either the first attempt, or a retry after one that failed before recording a tx.
      // Calling provide() again is safe: the Bridge contract requires execute() to be
      // idempotent per idempotencyKey, so a resumed transfer is rejoined, not duplicated.
      //
      // Crucially we do NOT advance to BRIDGING unless this returns. Marking an order as
      // bridged when the transfer did not happen would let the next step buy a pack with no
      // funds behind it (doc 00 §6 invariant 1).
      const result = await this.d.liquidity.provide("solana", order.price_usdg, key);
      const depositTx = result.bridgeResult?.depositTx ?? null;
      if (depositTx) this.d.db.recordIntentTx(key, depositTx, "CONFIRMED");

      this.d.db.setOrderStatus(order.id, "BRIDGING", { bridge_deposit_tx: depositTx });
    });
  }

  /**
   * BRIDGING -> OPENING. Buys the pack.
   *
   * `generatePack` costs nothing; `submitTransaction` is the point of no return. The order
   * is marked OPENING with cc_open_tx set the instant submission succeeds, so a crash one
   * line later still leaves the order correctly flagged as must-complete.
   */
  private async openPack(order: OrderRow): Promise<void> {
    await this.step(order, "open", async () => {
      // Checked again here, not just at bridge: the bridge fill alone can take 180s, which is
      // a third of the on-chain timeout. The order can be refunded during it.
      await this.assertSpendable(order, "open");

      const key = this.intentKey("cc-open", order.id);
      const claim = this.d.db.claimIntent(key, "cc-open", { orderId: order.id, machine: order.machine_id });

      if (!claim.fresh) {
        this.alert(
          `Order ${order.id}: pack purchase already attempted (memo=${claim.tx ?? "unknown"}). ` +
            `NOT re-purchasing — that would buy a second pack with one payment.`,
        );
        if (claim.tx) {
          this.d.db.setOrderStatus(order.id, "OPENING", { cc_open_tx: claim.tx });
          return;
        }
        // Claimed but no memo recorded: we cannot know whether CC took payment. Refuse to
        // guess in either direction.
        throw new Error(
          `Order ${order.id}: purchase intent claimed with no memo recorded. Manual check ` +
            `required — inspect the operator wallet's USDC history before retrying.`,
        );
      }

      // Availability gate (invariant 3): never buy from a machine that cannot serve us.
      const machine = await this.d.cc.machineStatus(order.machine_id);
      if (!machine.available) {
        throw new CcApiError("/machines", 503, { machine: order.machine_id }, `Machine ${order.machine_id} is out of stock`);
      }

      // Funds gate. This MUST come before generatePack, and the ordering is the whole point.
      //
      // generatePack creates a memo that we record as `SENT` before submitting. If the submit
      // then fails for insufficient USDC, the retry path sees a claimed intent WITH a memo and
      // promotes the order to OPENING — for a pack that was never paid for. There is no
      // OPENING -> REFUNDED edge in the schema, so from that moment the buyer's money is stuck
      // in escrow permanently, the refund sweep will not touch it (cc_open_tx is set), and it
      // burns one of the five open-order slots.
      //
      // Failing HERE instead leaves the order in BRIDGING with cc_open_tx NULL, which is
      // exactly what refundableOrders() picks up. The bridged USDC stays in our own custody
      // wallet as float for the next open, so nothing is lost — it is a delay, not a write-off.
      if (this.d.solanaUsdcBalance) {
        const need = BigInt(machine.priceUsdc);
        const have = await this.d.solanaUsdcBalance();
        if (have < need) {
          const short = need - have;
          this.alert(
            `Order ${order.id}: NOT buying — Solana USDC is ${fmtUsdc(have)} but ${order.machine_id} ` +
              `costs ${fmtUsdc(need)}, short ${fmtUsdc(short)}. The bridge takes its fee out of the ` +
              `transfer, so a machine priced at exactly the pack price always arrives short. Add ` +
              `float to the operator wallet, or give the machine a service fee. Order left ` +
              `refundable rather than poisoned into OPENING.`,
          );
          throw new Error(
            `Order ${order.id}: insufficient Solana USDC (have ${fmtUsdc(have)}, need ${fmtUsdc(need)})`,
          );
        }
      }

      const pack = await this.d.cc.generatePack(order.machine_id, this.d.signer.address);
      // Record the memo before submitting: if submission succeeds but we crash before the
      // response lands, this memo is the only way to find the pack again.
      this.d.db.recordIntentTx(key, pack.memo, "SENT");

      const signed = this.d.signer.signBase64(pack.transactionBase64);
      const submitted = await this.d.cc.submitTransaction(signed);

      this.d.db.recordIntentTx(key, pack.memo, "CONFIRMED");
      this.d.db.setOrderStatus(order.id, "OPENING", {
        // CC's memo IS our order binding (verification-results T1b) — it is what the proof
        // page and CC's own /verify-selection/{memo} verifier key off.
        cc_open_tx: pack.memo,
        bridge_fill_tx: submitted.signature,
      });
    });
  }

  /** OPENING -> REVEALED. Polls CC until the card is known. */
  private async reveal(order: OrderRow): Promise<void> {
    await this.step(order, "reveal", async () => {
      const memo = order.cc_open_tx;
      if (!memo) throw new Error(`Order ${order.id} is OPENING with no memo — cannot resolve reveal`);

      const polling = this.d.revealPolling ?? { attempts: 20, intervalMs: 3_000 };
      const awaitReveal = this.d.cc.awaitReveal?.bind(this.d.cc);
      const result = awaitReveal ? await awaitReveal(memo, polling) : await this.d.cc.openPack(memo);

      if (!result.revealedMint) {
        throw new Error(`Order ${order.id}: reveal for ${memo} still unresolved`);
      }

      const meta = this.d.cc.fetchCardMetaByMemo
        ? await this.d.cc.fetchCardMetaByMemo(memo)
        : await this.d.cc.fetchCardMeta(result.revealedMint);

      const revealAt = result.revealAt;

      /**
       * Assign the tier HERE, against this machine's own value bands.
       *
       * It cannot be recovered later: $500 is epic in the $50 machine and merely uncommon in
       * the $250, whose epic band starts at $2000. Storing it at reveal time is the only
       * point where the machine is still known for certain.
       *
       * CC's own rarity wins when present — it is authoritative for what was actually rolled.
       */
      let tier: string | null = result.rarity ?? null;
      if (!tier && meta.insuredValueUsd) {
        try {
          const machine = await this.d.cc.machineStatus(order.machine_id);
          tier = tierFromBands(Number(meta.insuredValueUsd) / 1e6, machine.tierRanges);
        } catch {
          // A tier we cannot determine is left null rather than guessed. The UI can fall
          // back; a wrong tier shown as fact is worse than an absent one.
          tier = null;
        }
      }

      this.d.db.insertCard({
        solanaMint: result.revealedMint,
        orderId: order.id,
        certNumber: meta.certNumber,
        grade: meta.grade,
        name: meta.name,
        imageUrl: meta.imageUrl,
        // The reveal opens on the slab back before turning to the front. Dropping it left
        // that first beat rendering nothing at all.
        imageBackUrl: meta.imageBackUrl ?? null,
        tier,
        insuredValueUsd: meta.insuredValueUsd,
        revealAt,
        ccWindowEndsAt: revealAt + this.d.cfg.economics.ccWindowHours * 3600_000,
        userWindowEndsAt: revealAt + this.d.cfg.economics.userWindowHours * 3600_000,
        ownerMirrorTokenId: null,
      });

      if (!meta.insuredValueUsd) {
        // Not fatal for minting, but the card cannot be quoted for sell-back until we have
        // it, so surface it rather than discovering it at quote time.
        this.alert(
          `Order ${order.id}: card ${result.revealedMint} has no insuredValue. Sell-backs ` +
            `for this card will fail until it is populated.`,
        );
      }

      this.d.db.setOrderStatus(order.id, "REVEALED", { solana_mint: result.revealedMint });
    });
  }

  /** REVEALED -> MINTED. Mirror mint + escrow release, atomically on RH Chain. */
  private async mint(order: OrderRow): Promise<void> {
    await this.step(order, "mint", async () => {
      if (!order.solana_mint || !order.cc_open_tx) {
        throw new Error(`Order ${order.id} is REVEALED but missing mint/memo`);
      }

      /**
       * Report whether the card we are about to mirror can actually be moved.
       *
       * CC's cards are Metaplex Core assets and many carry a permanent freeze delegate held
       * by a third party. A frozen card cannot be transferred by anyone, so a mirror against
       * one is a claim we could not honour on withdraw or sell-back.
       *
       * Deliberately an ALERT, not a block. It is not yet known whether the freezing observed
       * in CC's pool (8 of 12 sampled cards) clears on purchase or persists into custody, and
       * a guard built on the wrong guess would refuse every mint — the same shape as the
       * missing bridge allowance, but self-inflicted. Both affected paths are switched off
       * today (sell-back disabled, withdraw unbuilt), so minting a frozen card harms nobody
       * right now; shipping a mint that always refuses would.
       *
       * The first real open settles it. Read the alert before enabling either path.
       */
      if (this.d.assetFrozen) {
        const frozen = await this.d.assetFrozen(order.solana_mint);
        if (frozen === true) {
          this.alert(
            `Order ${order.id}: card ${order.solana_mint} is FROZEN on Solana. The mirror will ` +
              `still be minted, but this card cannot be transferred, so withdraw and sell-back ` +
              `could not be honoured for it. Do NOT enable either path until this is understood.`,
          );
        } else if (frozen === null) {
          this.alert(`Order ${order.id}: could not read frozen state for ${order.solana_mint}.`);
        }
      }

      const key = this.intentKey("mint", order.id);
      const claim = this.d.db.claimIntent(key, "mint", { orderId: order.id });
      if (!claim.fresh && claim.tx) {
        /**
         * The mint was broadcast but we crashed before recording its result.
         *
         * This used to close the order MINTED with `mirror_token_id` NULL, and never ran the
         * `cards.owner_mirror_token_id` update either. The card then existed on chain, owned by
         * the buyer, while our records could not name its token — which is not cosmetic:
         * `/collection` renders "Card #null", the withdraw path throws on `BigInt(null)` and
         * shows a generic failure, and both sell-back routes key on that column so they 404.
         * The card became permanently un-exitable through the UI, with no diagnosis.
         *
         * The chain still knows. `mintedForOrder` is exactly this lookup, so recover from it
         * rather than closing on a guess.
         */
        const tokenId = this.d.mintedTokenFor ? await this.d.mintedTokenFor(order.id) : 0n;

        if (tokenId > 0n) {
          this.d.db.tx(() => {
            this.d.db.setOrderStatus(order.id, "MINTED", {
              mirror_token_id: tokenId.toString(),
              fulfil_tx: claim.tx!,
            });
            this.d.db.raw
              .prepare(`UPDATE cards SET owner_mirror_token_id = ?, updated_at = ? WHERE solana_mint = ?`)
              .run(tokenId.toString(), Date.now(), order.solana_mint!);
          });
          this.alert(`Order ${order.id}: recovered mirror #${tokenId} from chain after an interrupted mint.`);
          return;
        }

        /**
         * Broadcast, but the chain has no token for this order. Either the transaction
         * reverted, or it has not landed yet. Do NOT close the order — a MINTED order is
         * terminal, and closing it here is what strands the card. Throwing leaves it FAILED
         * so the retry can either find the token next pass or mint properly.
         */
        this.alert(
          `Order ${order.id}: mint tx ${claim.tx} was broadcast but no token is minted on chain. ` +
            `NOT closing the order — leaving it to retry rather than recording a card we cannot name.`,
        );
        throw new Error(`Order ${order.id}: mint claimed (${claim.tx}) but mintedForOrder is 0`);
      }

      const card = this.d.db.raw
        .prepare(`SELECT reveal_at FROM cards WHERE solana_mint = ?`)
        .get(order.solana_mint) as { reveal_at: number } | undefined;

      const result = await this.d.minter.fulfill({
        orderId: order.id,
        buyer: order.buyer,
        solanaMint: order.solana_mint,
        ccOpenTx: order.cc_open_tx,
        revealAt: card?.reveal_at ?? Date.now(),
        tokenUri: this.d.tokenUriFor?.(order.id, order.solana_mint) ?? `/api/metadata/${order.id}`,
      });

      this.d.db.recordIntentTx(key, result.txHash, "CONFIRMED");
      this.d.db.tx(() => {
        this.d.db.setOrderStatus(order.id, "MINTED", {
          mirror_token_id: result.tokenId,
          fulfil_tx: result.txHash,
        });
        this.d.db.raw
          .prepare(`UPDATE cards SET owner_mirror_token_id = ?, updated_at = ? WHERE solana_mint = ?`)
          .run(result.tokenId, Date.now(), order.solana_mint!);
        // Escrow is released to the treasury by the same on-chain call.
        this.d.db.recordTreasury({
          kind: "PACK_REVENUE",
          amount: order.price_usdg,
          token: "USDG",
          chain: "rh",
          tx: result.txHash,
          orderId: order.id,
        });
      });
    });
  }

  /** FAILED -> re-enter at whatever step the stored state implies. */
  private async retryFailed(order: OrderRow): Promise<void> {
    if (order.attempts >= FAST_RETRY_BUDGET) {
      const cooldown = this.d.retryCooldownMs ?? DEFAULT_RETRY_COOLDOWN_MS;
      const waited = Date.now() - order.updated_at;

      if (waited < cooldown) {
        // Back off, but never give up permanently — the fault may be external and
        // transient (RH RPC, CC outage), and it must self-heal once resolved.
        return;
      }

      this.alert(
        `Order ${order.id} past its fast-retry budget (${order.attempts} attempts); retrying ` +
          `on cooldown. ` +
          (order.cc_open_tx
            ? `A pack WAS purchased — this is must-complete. Follow doc 06 runbook 6; if the ` +
              `mint is unrecoverable after 2h a human calls PackSale.forceRefund.`
            : `No pack was purchased — it will auto-refund at the deadline.`),
      );
    }

    // Re-enter at the step implied by what actually landed. The final fallback MUST be
    // CREATED, not OPENING: an order with no bridge receipt has no funds on Solana, and
    // sending it to the purchase step would spend our own USDC on a pack the user has not
    // effectively paid for — violating doc 00 §6 invariant 1 ("never spend on Solana what
    // wasn't prepaid on RH Chain").
    const next = order.mirror_token_id
      ? "MINTED"
      : order.solana_mint
        ? "REVEALED"
        : order.cc_open_tx
          ? "OPENING"
          : order.bridge_deposit_tx
            ? "BRIDGING"
            : "CREATED";

    this.d.db.setOrderStatus(order.id, next as OrderRow["status"]);
  }

  // ------------------------------------------------------------------ plumbing

  /** Runs a step, converting failures into FAILED + a bounded retry, never into a refund. */
  private async step(order: OrderRow, name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      // A settled order is not a failure to retry. Marking it FAILED would re-arm the spend
      // path (FAILED -> CREATED is a legal transition) and spin forever on an order the
      // chain has already closed — the precise loop this check exists to prevent. The status
      // was already reconciled in assertSpendable where that was possible.
      if (err instanceof OrderSettledOnChain) {
        this.alert(`Order ${order.id} stopped at ${name}: ${err.message}`);
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      this.d.db.bumpAttempts(order.id, `${name}: ${message}`);

      if (err instanceof CcAuthRequiredError) {
        // This kills every order, not just this one.
        this.alert(
          `CRITICAL: Collector Crypt is now enforcing the API key. ALL pack opens are down. ` +
            `Pause the contract and configure a partner key. (${message})`,
        );
      }

      const fresh = this.requireOrder(order.id);
      if (fresh.status !== "FAILED") {
        this.d.db.setOrderStatus(order.id, "FAILED", { last_error: `${name}: ${message}` });
      }

      const opened = fresh.cc_open_tx != null;
      this.alert(
        `Order ${order.id} failed at ${name} (attempt ${fresh.attempts}): ${message}` +
          (opened ? ` — PACK WAS PURCHASED, must-complete, never auto-refund` : ""),
      );
    }
  }
}

/** USDC/USDG base units (6dp) as dollars, for operator-facing messages. */
function fmtUsdc(v: bigint): string {
  return `$${(Number(v) / 1e6).toFixed(2)}`;
}

/**
 * Tier for an insured value against a machine's published bands.
 *
 * Mirrors the frontend's `tierFromRanges` deliberately: the two must never disagree about
 * what a card is, and the bands are per-machine so a shared constant would be wrong.
 * Returns null rather than guessing when the machine publishes no bands.
 */
export function tierFromBands(
  valueUsd: number,
  ranges: Record<string, { start: number; end: number }> | undefined,
): string | null {
  if (!ranges) return null;
  for (const tier of ["epic", "rare", "uncommon"] as const) {
    const band = ranges[tier];
    if (band && valueUsd >= band.start) return tier;
  }
  return ranges.common ? "common" : null;
}
