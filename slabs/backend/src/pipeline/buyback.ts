/**
 * Flow B — instant sell-back, with the mirror held in escrow.
 *
 * ## Why escrow, when doc 02 §4 says EIP-712 is enough
 *
 * It is not enough. §4 orders the legs "sell on CC -> bridge -> pay user -> burn mirror" and
 * justifies skipping escrow with "we control the asset and pay after". That is true of the
 * Solana card in custody and false of the mirror, which the seller keeps the whole time.
 * `MirrorNFT` has no transfer restriction, so during the bridge — minutes — a seller could
 * accept a standing offer on the very token whose card we had already sold. They would be
 * paid twice and the buyer would be left holding a mirror backed by nothing, which
 * `burnForSell` would then destroy out of their wallet, since it takes the CURRENT holder
 * from `_requireOwned` and never checks it is still the seller.
 *
 * Holding the mirror closes that completely: a token in our custody cannot be listed,
 * transferred, or offered on. See `docs/flow-b-custody-gap.md`.
 *
 * ## The order of the legs, and why
 *
 *   USER_CONFIRMED  we hold the mirror; nothing has been spent or sold
 *   CC_SOLD         the physical card is gone. From here the buyback MUST complete.
 *   BRIDGED         proceeds are on RH Chain as USDG
 *   PAID            seller has their money, and only then is the mirror burned
 *
 * Before CC_SOLD, any failure is safe: return the mirror, mark FAILED, nobody is owed
 * anything. After CC_SOLD it is a must-complete — the card cannot be un-sold, so the pipeline
 * retries the payout forever and alerts rather than ever giving up on someone's money.
 *
 * The burn is last and is guarded by an ownership assertion even though escrow makes it
 * redundant. Defence in depth: if that assertion ever fires, something is deeply wrong and
 * burning would destroy the wrong person's token.
 */
import type { Db, BuybackRow } from "../db/index.ts";
import type { Config } from "../config.ts";
import type { CollectorCryptClient } from "../cc/types.ts";
import { userPayoutUsdg } from "../cc/client.ts";

/** The chain operations Flow B needs. Narrowed so tests can supply a fake. */
export interface BuybackChain {
  readonly operatorAddress: string;
  mirrorOwnerOf(tokenId: bigint): Promise<string>;
  returnMirror(to: string, tokenId: bigint): Promise<string>;
  /**
   * `onSent` fires the moment the transaction is broadcast, BEFORE the receipt is awaited.
   *
   * That callback is what makes the payout safe to retry. Without it the hash only existed
   * after a receipt wait that can time out, so a slow RPC lost the record of a transfer that
   * had already landed, and the next tick paid the seller a second time.
   */
  payUsdg(to: string, amount: bigint, onSent?: (txHash: string) => void): Promise<string>;
  usdgBalance(): Promise<bigint>;
  burnAfterSell(tokenId: bigint): Promise<string>;
  /** Did a previously broadcast transaction land successfully? Used to resolve a retry. */
  /** true = succeeded, false = definitely reverted, null = unknown (pending or RPC down). */
  txSucceeded(txHash: string): Promise<boolean | null>;
}

/** Signs and submits the CC sell transaction on Solana. */
export interface SellSigner {
  /**
   * `solanaMint` is not optional context — it is what the signing guard checks the transaction
   * against, so Collector Crypt cannot hand back a transaction that moves a DIFFERENT card of
   * ours. Passing the wrong mint here would defeat that check entirely.
   */
  signAndSubmit(transactionBase64: string, solanaMint: string): Promise<string>;
}

/** Moves Solana USDC proceeds to RH Chain USDG. The inbound direction of the same bridge. */
export interface ProceedsBridge {
  toRhChain(params: { amountUsdc: string; reference: string }): Promise<{ orderId: string; txs: string[] }>;
}

export type BuybackDeps = {
  db: Db;
  cc: CollectorCryptClient;
  chain: BuybackChain;
  signer: SellSigner;
  bridge: ProceedsBridge;
  cfg: Config;
  alert?: (message: string) => void;
  /**
   * Who owns a card on Solana. The authority on whether a sell-back actually executed when
   * the HTTP response was lost. Injected so the pipeline holds no chain dependency; when
   * absent the code falls back to local state, which is why production must wire it.
   */
  cardOwner?: (solanaMint: string) => Promise<string | null>;
};

/** How long a payout may be stuck before it stops being a retry and becomes an incident. */
const PAYOUT_ALERT_AFTER_MS = 15 * 60_000;

export class BuybackPipeline {
  private readonly d: BuybackDeps;

  constructor(deps: BuybackDeps) {
    this.d = deps;
  }

  private alert(message: string): void {
    (this.d.alert ?? ((m: string) => console.error(`[ALERT] ${m}`)))(message);
  }

  /** Resume everything unfinished after a restart. */
  async resumeAll(): Promise<void> {
    for (const b of this.d.db.activeBuybacks()) {
      await this.process(b.id);
    }
  }

  /**
   * Drive one buyback as far as it will go. Safe to call repeatedly: every step is guarded by
   * the stored status, so a re-entry after a crash resumes rather than repeats.
   */
  async process(id: number): Promise<void> {
    const b = this.require(id);

    switch (b.status) {
      case "USER_CONFIRMED":
        await this.step(b, "sell", () => this.sellToCc(b));
        return this.continueFrom(id, b.status);
      case "CC_SOLD":
        await this.step(b, "bridge", () => this.bridgeProceeds(b));
        return this.continueFrom(id, b.status);
      case "BRIDGED":
        await this.step(b, "payout", () => this.payAndBurn(b));
        return;
      case "QUOTED":
        // Not confirmed yet: the API inserts rows already USER_CONFIRMED, so this only
        // happens if a row was written by hand. Do nothing rather than guess.
        return;
      case "PAID":
      case "FAILED":
        return;
    }
  }

  /**
   * Continue only if the last step actually ADVANCED the row.
   *
   * Comparing against the previous status is load-bearing, not defensive. A must-complete
   * failure deliberately leaves the status untouched so the next tick retries it, so
   * "not terminal" is not the same as "made progress" — recursing on that condition spins
   * forever against a failing leg and takes the process down with it.
   */
  private async continueFrom(id: number, previous: BuybackRow["status"]): Promise<void> {
    const fresh = this.d.db.getBuyback(id);
    if (!fresh || fresh.status === "FAILED" || fresh.status === "PAID") return;
    if (fresh.status === previous) return;
    await this.process(id);
  }

  private require(id: number): BuybackRow {
    const b = this.d.db.getBuyback(id);
    if (!b) throw new Error(`buyback ${id} not found`);
    return b;
  }

  // ---------------------------------------------------------------- the legs

  /**
   * USER_CONFIRMED -> CC_SOLD. The point of no return.
   *
   * Everything that could still be checked cheaply is checked here, because after this call
   * the physical card belongs to Collector Crypt and no amount of failure downstream can
   * bring it back.
   */
  private async sellToCc(b: BuybackRow): Promise<void> {
    // We must actually hold the mirror. Without this an attacker could confirm a sell for a
    // token they never escrowed and have us sell someone else's card.
    const holder = await this.d.chain.mirrorOwnerOf(BigInt(b.mirror_token_id));
    if (holder.toLowerCase() !== this.d.chain.operatorAddress.toLowerCase()) {
      throw new Error(
        `mirror ${b.mirror_token_id} is held by ${holder}, not the operator — refusing to sell`,
      );
    }

    // Re-quote. The stored figure was true when the user saw it; CC's rate can move, and we
    // must not sell a card for materially less than the seller agreed to receive.
    // The SOLANA custody wallet, not the string "custody". This argument is sent to CC as
    // `?wallet=`, the same parameter family that returned `400 Invalid altRecipient address`
    // and killed a live sell-back when it was handed an EVM address.
    const quote = await this.d.cc.getBuybackQuote(b.solana_mint, this.d.cfg.solana.operatorAddress);
    if (!quote.available) throw new Error(`CC will no longer buy back ${b.solana_mint}`);

    const freshPayout = BigInt(
      userPayoutUsdg(quote.proceedsUsdc, b.insured_value_usd, this.d.cfg.economics.spreadBps),
    );
    const promised = BigInt(b.quoted_usdg);

    // Drift against them beyond the tolerance means the quote they accepted is stale, so the
    // sale is abandoned and the mirror goes back rather than executing at a worse price.
    if (freshPayout < promised) {
      const shortfallBps = Number(((promised - freshPayout) * 10_000n) / promised);
      if (shortfallBps > this.d.cfg.economics.quoteDriftRevalidateBps) {
        throw new Error(
          `quote moved ${shortfallBps}bps against the seller ` +
            `(promised ${promised}, now ${freshPayout}) — re-quote required`,
        );
      }
    }

    /**
     * Drift in the seller's favour is paid to the seller, not kept.
     *
     * This is what makes quote pinning worthless. `matchableQuoteFor` takes the most recent
     * quote on a token no matter who asked for it, and `requester` arrives in a request body
     * with nothing to authenticate it — so scoping the match to its creator would stop
     * nobody, an attacker would simply claim the victim's address. A stranger CAN therefore
     * bind a seller's deposit to a quote taken at a worse moment.
     *
     * Repricing upward here removes the reward instead of the access: the seller is paid what
     * the card is worth when it actually sells, so a pinned low quote costs them nothing. Our
     * margin is the spread either way, so paying the better price costs us nothing either.
     */
    if (freshPayout > promised) {
      const ccRateBps = Number((BigInt(quote.proceedsUsdc) * 10_000n) / BigInt(b.insured_value_usd));
      this.d.db.repriceQuoteUp(b.id, {
        quotedUsdg: freshPayout.toString(),
        ccQuoteBps: ccRateBps,
        quotedUserRateBps: ccRateBps - this.d.cfg.economics.spreadBps,
      });
    }

    /**
     * Claim an intent BEFORE handing the card to Collector Crypt.
     *
     * This was the only spend on the sell-back path with no durable record, and it is the one
     * that gives away a physical card. If `signAndSubmit` succeeded but its response was lost,
     * `cc_sell_tx` stayed null, `step()` read that as "never sold" and called `abandon()` —
     * which hands the mirror BACK to the seller while CC owns the card. They keep a token
     * backed by nothing and we are down a card, which is the exact state escrow exists to
     * prevent. A crash in the same window instead re-sold the same mint twice.
     *
     * Same discipline as the pack purchase and the payout: claim first, record the signature
     * the moment it exists, and refuse to guess when the claim is ambiguous.
     */
    // Built first: this costs nothing and commits nothing, so a failure here must still be
    // able to hand the mirror back.
    //
    // THE SOLANA ADDRESS, NOT `chain.operatorAddress`.
    //
    // `chain.operatorAddress` is the Robinhood Chain EVM address (0x00770E4B…) and every
    // OTHER use of it in this file is an EVM mirror-ownership check, which is correct. This
    // one call crosses to Collector Crypt, whose API is Solana-side: it wants the base58
    // wallet that actually holds the card. Passing the hex address made CC reject the sale
    // with `400 {"error":"Invalid altRecipient address"}` — an error naming a field we never
    // send, which is why it read as a missing parameter rather than a wrong one.
    //
    // Verified on chain: mint 9oiCY3XL… is owned by SOLANA_OPERATOR_ADDRESS (CARD7cm…HuaN).
    const built = await this.d.cc.buildBuyback(b.solana_mint, this.d.cfg.solana.operatorAddress);

    const key = `cc-sell:buyback:${b.id}`;
    const claim = this.d.db.claimIntent(key, "cc-sell", {
      buybackId: b.id,
      mint: b.solana_mint,
    });

    if (!claim.fresh && claim.tx) {
      // A previous attempt already sold it. Reconcile rather than selling again.
      this.alert(`Buyback ${b.id}: card was already sold to CC (${claim.tx}). Not re-selling.`);
      this.d.db.setBuybackStatus(b.id, "CC_SOLD", { cc_sell_tx: claim.tx });
      this.d.db.setCardState(b.solana_mint, "SOLD_TO_CC");
      return;
    }
    if (!claim.fresh && !claim.tx) {
      throw new Error(
        `Buyback ${b.id}: a sale was claimed with no signature recorded. We cannot tell whether ` +
          `CC took the card. Check the operator wallet's history for ${b.solana_mint} before ` +
          `retrying — abandoning here could return a mirror for a card we no longer own.`,
      );
    }

    const sig = await this.d.signer.signAndSubmit(built.transactionBase64, b.solana_mint);
    this.d.db.recordIntentTx(key, sig, "CONFIRMED");

    // Record what CC actually paid, not what we expected. This is the amount that gets
    // bridged, and it is the last chance to capture it — the figure is not recoverable from
    // our own tables afterwards.
    this.d.db.setBuybackStatus(b.id, "CC_SOLD", {
      cc_sell_tx: sig,
      cc_proceeds_usdc: built.refundAmountUsdc,
    });
    this.d.db.setCardState(b.solana_mint, "SOLD_TO_CC");
  }

  /**
   * CC_SOLD -> BRIDGED.
   *
   * The whole proceeds are moved, not just the seller's share. The spread is the difference
   * and it has to reach the same chain the payout happens on. Bridging only `quoted_usdg`
   * would also arrive short, because the bridge takes its fee out of the transfer.
   */
  private async bridgeProceeds(b: BuybackRow): Promise<void> {
    const amount = b.cc_proceeds_usdc ?? b.quoted_usdg;
    const { orderId, txs } = await this.d.bridge.toRhChain({
      amountUsdc: amount,
      reference: `buyback-${b.id}`,
    });
    this.d.db.setBuybackStatus(b.id, "BRIDGED", {
      bridge_order_id: orderId,
      bridge_txs: JSON.stringify(txs),
    });
  }

  /**
   * BRIDGED -> PAID. Pay first, burn second.
   *
   * If the burn fails after a successful payout the seller keeps both their money and a
   * mirror, which is a loss to us but not to them. The reverse — burning before paying —
   * would take someone's card and then fail to pay for it, so the order is not negotiable.
   */
  private async payAndBurn(b: BuybackRow): Promise<void> {
    const owed = BigInt(b.quoted_usdg);

    if (!b.payout_tx) {
      /**
       * The payout is the one place this pipeline hands over real money, and it used to be
       * the only spending step with no durable intent behind it.
       *
       * The old shape was: call payUsdg, which broadcasts and then waits up to 120s for a
       * receipt, and only write payout_tx once it returns. A receipt timeout threw AFTER the
       * transfer had already landed, leaving payout_tx null, so the next tick re-entered here
       * and PAID THE SELLER TWICE. Every other spending step in this codebase claims an
       * intent first; this one did not.
       *
       * Now the intent is claimed before anything is broadcast, and the hash is recorded the
       * instant it exists rather than after the receipt wait. The dangerous window shrinks
       * from 120 seconds to the microseconds between broadcast and one local DB write.
       */
      const key = `buyback-payout:${b.id}`;
      const claim = this.d.db.claimIntent(key, "buyback-payout", {
        buybackId: b.id,
        seller: b.seller,
        owed: owed.toString(),
      });

      if (!claim.fresh && claim.tx) {
        // A previous attempt broadcast this. Ask the chain how it ended rather than assuming.
        const landed = await this.d.chain.txSucceeded(claim.tx);

        if (landed === true) {
          this.d.db.setBuybackStatus(b.id, "BRIDGED", { payout_tx: claim.tx });
          b = this.require(b.id);
          this.alert(`Buyback ${b.id}: payout ${claim.tx} had already landed. Not paying again.`);
        } else if (landed === false) {
          /**
           * DEFINITELY reverted: a receipt exists and it failed, so no money moved.
           *
           * The intent is RELEASED, not marked FAILED. `recordIntentTx(…, "FAILED")` leaves the
           * hash on the row, and `clearIntent` only deletes rows with no hash — so the old code
           * re-entered this branch every tick, re-checked the same dead hash, re-alerted, and
           * never re-broadcast. A seller whose card was already sold to Collector Crypt was
           * owed money that could never arrive, under a comment reading "Will retry".
           */
          this.d.db.releaseRevertedIntent(key);
          throw new Error(`Buyback ${b.id}: payout ${claim.tx} reverted. Released for a fresh attempt.`);
        } else {
          /**
           * UNKNOWN — still pending, or the RPC is down. Never guess here.
           *
           * Releasing on an unknown is how a payout that actually landed gets sent a second
           * time. The claim stays exactly as it is and the next tick asks again.
           */
          throw new Error(
            `Buyback ${b.id}: cannot determine whether payout ${claim.tx} landed. Holding — ` +
              `will re-check. No second payment will be sent until the chain answers.`,
          );
        }
      } else if (!claim.fresh && !claim.tx) {
        // Claimed, but no hash was ever written: we cannot tell whether a transfer went out.
        // Refusing to guess is the only safe move, because guessing wrong pays twice.
        throw new Error(
          `Buyback ${b.id}: payout intent claimed with no tx recorded. Manual check required — ` +
            `inspect USDG transfers from the treasury to ${b.seller} before retrying.`,
        );
      } else {
        const balance = await this.d.chain.usdgBalance();
        if (balance < owed) {
          // Nothing was broadcast, so the claim must not linger: releasing it keeps an
          // underfunded treasury a plain retry rather than an incident needing a human.
          this.d.db.clearIntent(key);
          throw new Error(`treasury holds ${balance} USDG, owes ${owed} — cannot pay buyback ${b.id}`);
        }

        // The callback firing IS the signal that money left. It is the only thing that can
        // distinguish "the send was refused" from "the send landed but we lost the receipt",
        // and those two need opposite responses: retry freely, versus never retry blind.
        let broadcast = false;
        try {
          const payoutTx = await this.d.chain.payUsdg(b.seller, owed, (hash) => {
            broadcast = true;
            this.d.db.recordIntentTx(key, hash, "SENT");
          });
          this.d.db.recordIntentTx(key, payoutTx, "CONFIRMED");
          this.d.db.setBuybackStatus(b.id, "BRIDGED", { payout_tx: payoutTx });
          b = this.require(b.id);
        } catch (err) {
          if (!broadcast) this.d.db.clearIntent(key);
          throw err;
        }
      }
    }

    // Escrow makes this assertion redundant, which is exactly why it is worth keeping: if it
    // ever fires, an assumption has broken and burning would destroy the wrong token.
    const holder = await this.d.chain.mirrorOwnerOf(BigInt(b.mirror_token_id));
    if (holder.toLowerCase() !== this.d.chain.operatorAddress.toLowerCase()) {
      this.alert(
        `Buyback ${b.id} PAID but mirror ${b.mirror_token_id} is held by ${holder}, not us. ` +
          `NOT burning. Investigate before touching this token.`,
      );
      this.d.db.setBuybackStatus(b.id, "PAID", {
        last_error: `not burned: mirror held by ${holder}`,
      });
      // Not our token, so nothing to sweep. Close the deposit or the sweeper will keep
      // trying to return a token we do not hold.
      this.d.db.markEscrowReturned(b.mirror_token_id, "not-held-at-burn");
      return;
    }

    const burnTx = await this.d.chain.burnAfterSell(BigInt(b.mirror_token_id));
    this.d.db.setBuybackStatus(b.id, "PAID", { burn_tx: burnTx });
    // The token is gone. Resolve the deposit so the sweeper does not later ask the chain
    // about a burned token and mistake the revert for an unreturnable card.
    this.d.db.markEscrowReturned(b.mirror_token_id, burnTx);
  }

  // ---------------------------------------------------------------- plumbing

  /**
   * Runs a leg. Before the card is sold a failure is recoverable, so the mirror goes back and
   * the buyback is closed. After it, nothing is refundable and the only correct behaviour is
   * to keep trying and make noise.
   */
  private async step(b: BuybackRow, name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      /**
       * "Sold" means the card MIGHT be gone, not that we recorded it going.
       *
       * `cc_sell_tx` alone was the test, and it is written only AFTER submitTransaction
       * returns. A submit that reached Collector Crypt and then lost its response left that
       * column null, so this read it as "never sold" and abandoned — handing the mirror back
       * to a seller whose physical card CC now owns. They keep a token backed by nothing.
       *
       * A CLAIMED cc-sell intent means a sale was attempted, and an attempted sale can never
       * be safely undone from here. So the claim counts as sold, and the order stays put for
       * a human or a retry rather than being unwound optimistically.
       */
      /**
       * Did Collector Crypt actually take the card? ASK THE CHAIN, do not guess.
       *
       * `cc_sell_tx` is written only AFTER submitTransaction returns. A submit that reached
       * CC and then lost its response leaves that column null, and reading it as "never sold"
       * abandons the buyback — handing the mirror back to a seller whose physical card CC now
       * owns. They keep a token backed by nothing and we are down a card. That is the exact
       * state escrow exists to prevent.
       *
       * Local state cannot resolve it: an HTTP submit has no broadcast callback, so
       * "attempted" and "arrived" look identical from here. The Solana asset can resolve it,
       * because a completed sale moves the card OUT of our custody wallet.
       *
       * The order of the checks matters:
       *   recorded sale            -> sold, obviously
       *   no sale attempted at all -> not sold, safe to abandon (the common failure)
       *   attempted, card gone     -> SOLD, never abandon
       *   attempted, card still ours -> genuinely not sold, safe to abandon
       *   attempted, unreadable    -> refuse to guess; keep the mirror and alert
       */
      let sold = b.cc_sell_tx != null;

      if (!sold && this.d.db.intentExists(`cc-sell:buyback:${b.id}`)) {
        const owner = this.d.cardOwner ? await this.d.cardOwner(b.solana_mint) : null;
        if (owner === null) {
          this.alert(
            `Buyback ${b.id}: a sale was attempted and we cannot read who owns ` +
              `${b.solana_mint}. NOT returning the mirror — that would hand it back for a card ` +
              `Collector Crypt may already hold. Check the card and resolve by hand.`,
          );
          this.d.db.setBuybackStatus(b.id, b.status, { last_error: `${name}: ${message} (ownership unreadable)` });
          return;
        }
        /**
         * COMPARE AGAINST THE SOLANA WALLET. `owner` came from Solana.
         *
         * This read `chain.operatorAddress`, which is the Robinhood Chain address 0x00770E4B…,
         * against a base58 Solana owner. Those can never be equal, so the branch ALWAYS fired:
         * every sell error after the intent was claimed concluded "CC took the card" while the
         * card was sitting safely in our own custody. It then refused to return the seller's
         * mirror and marked the buyback must-complete — owing a payout for a sale that never
         * happened, and holding a card we still own.
         *
         * Seen live on buyback 4, which alerted "the card has LEFT our custody (now
         * CARD7cm…HuaN)" — naming our own custody wallet as proof it had left.
         *
         * This is the SECOND instance of this exact mistake in this file; `buildBuyback` had it
         * too. The first fix changed one line and did not sweep for siblings, which is why this
         * one survived to production.
         */
        if (owner !== this.d.cfg.solana.operatorAddress) {
          this.alert(
            `Buyback ${b.id}: the submit lost its response but the card has LEFT our custody ` +
              `(now ${owner}). CC took it. Treating as sold and continuing rather than ` +
              `returning the mirror.`,
          );
          sold = true;
        }
        // owner is still us: the sale genuinely did not happen, so abandoning is safe.
      }

      if (!sold) {
        await this.abandon(b, `${name}: ${message}`);
        return;
      }

      // Past the point of no return: stay in the current state so the next tick retries.
      this.d.db.setBuybackStatus(b.id, b.status, { last_error: `${name}: ${message}` });

      const stuckFor = Date.now() - b.updated_at;
      const overdue = stuckFor > PAYOUT_ALERT_AFTER_MS;
      this.alert(
        `Buyback ${b.id} failed at ${name}: ${message} — CARD ALREADY SOLD, must-complete, ` +
          `seller ${b.seller} is owed ${b.quoted_usdg} USDG` +
          (overdue ? ` — STUCK FOR ${Math.round(stuckFor / 60_000)} MINUTES` : ""),
      );
    }
  }

  /**
   * Close a buyback that failed before the card was sold: hand the mirror back and owe
   * nothing. The seller ends up exactly where they started.
   */
  private async abandon(b: BuybackRow, reason: string): Promise<void> {
    let returned: string | null = null;
    try {
      const holder = await this.d.chain.mirrorOwnerOf(BigInt(b.mirror_token_id));
      if (holder.toLowerCase() === this.d.chain.operatorAddress.toLowerCase()) {
        returned = await this.d.chain.returnMirror(b.seller, BigInt(b.mirror_token_id));
      } else {
        returned = "already-not-held";
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.alert(
        `Buyback ${b.id} abandoned (${reason}) but the mirror could NOT be returned to ` +
          `${b.seller}: ${message}. Their card is in our custody and they hold nothing.`,
      );
    }

    this.d.db.setBuybackStatus(b.id, "FAILED", {
      last_error: returned ? `${reason} (mirror returned, tx ${returned})` : reason,
    });

    // Resolve the deposit either way. Returned means done; NOT returned must go back to the
    // sweeper, because a failed buyback still holding a card is exactly the state that must
    // never be forgotten — and a deposit still linked to this dead buyback would be skipped.
    if (returned) {
      this.d.db.markEscrowReturned(b.mirror_token_id, returned);
    } else {
      this.d.db.unlinkEscrow(b.mirror_token_id);
    }
  }
}
