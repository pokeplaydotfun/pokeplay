/**
 * The withdraw relayer (Flow C).
 *
 * `MirrorNFT.burnForUnwrap` BURNS THE MIRROR FIRST and then emits `UnwrapRequested`. By the
 * time this file sees anything, the user already holds nothing and is owed a physical card.
 * There is no refund, no reversal, and no second attempt available to them. That single fact
 * decides every design choice here:
 *
 *   - RECORD BEFORE ANYTHING ELSE. A request we failed to write down is indistinguishable
 *     from a user who was robbed. Validation, ceilings and the kill switch all happen AFTER
 *     the row exists.
 *   - NEVER AUTO-CLOSE A FAILURE. FAILED is not terminal. The debt survives a restart, a bad
 *     address, a dead RPC and a switched-off relayer, because the debt is real either way.
 *   - THE SEND IS THE LAST THING. Every check that can be made is made first, and the
 *     signature is recorded the instant it exists rather than after confirmation.
 *
 * The transfer it ends in is the one that destroyed a card. See `withdrawAssetTo` and
 * `solana-destination.ts` for the guards, and note that a rejection path is tested with
 * `dryRun`, never against production.
 */
import type { Db, WithdrawalRow } from "../db/index.ts";
import type { Config } from "../config.ts";

export type WithdrawChain = {
  /** Raw 32-byte Solana pubkeys from UnwrapRequested, base58-encoded by the caller. */
  unwrapRequests(fromBlock: bigint): Promise<{
    requests: { tokenId: bigint; owner: string; solanaAddress: string }[];
    latestBlock: bigint;
  }>;
  headBlock(): Promise<bigint>;
};

export type WithdrawSolana = {
  /** The chain is the authority on whether an irreversible transfer already happened. */
  assetOwner(mint: string): Promise<string | null>;
  withdrawAssetTo(
    mint: string,
    destination: string,
    opts?: { dryRun?: boolean; requireDestinationExists?: boolean },
  ): Promise<{ signature: string | null; dryRun: boolean; destination: string }>;
};

export type WithdrawDeps = {
  db: Db;
  chain: WithdrawChain;
  solana: WithdrawSolana;
  cfg: Config;
  alert: (message: string) => void;
};

const CURSOR_KEY = "withdraw_block_cursor";

export class WithdrawRelayer {
  // Declared explicitly rather than as a constructor parameter property. Node runs this file
  // in strip-only mode, which rejects `constructor(private readonly d: ...)` at load time, and
  // `tsc --noEmit` does not catch it — so the failure appears only when the worker boots.
  private readonly d: WithdrawDeps;

  constructor(deps: WithdrawDeps) {
    this.d = deps;
  }

  async tick(): Promise<void> {
    await this.ingest();
    await this.relay();
  }

  /**
   * Turn UnwrapRequested events into durable rows.
   *
   * The cursor advances only after the whole batch is recorded. Re-seeing an event is
   * harmless — `recordWithdrawal` is keyed on token_id and ignores a duplicate — whereas
   * skipping one loses a user's claim entirely, so this errs at replay every time.
   */
  private async ingest(): Promise<void> {
    let cursor = BigInt(this.d.db.getMeta(CURSOR_KEY) ?? "0");
    if (cursor === 0n) {
      // First boot: start at the head. Anything earlier predates the relayer and needs a human,
      // not a silent replay of burns we never promised to honour.
      cursor = await this.d.chain.headBlock();
      this.d.db.setMeta(CURSOR_KEY, cursor.toString());
      return;
    }

    const { requests, latestBlock } = await this.d.chain.unwrapRequests(cursor + 1n);

    for (const r of requests) {
      const tokenId = r.tokenId.toString();

      // The mint comes from OUR records, not from the event. The event carries only a
      // destination; which physical card a mirror stands for is ours to know.
      const card = this.d.db.cardByMirrorTokenId(tokenId);

      this.d.db.recordWithdrawal({
        tokenId,
        requester: r.owner,
        solanaDest: r.solanaAddress,
        solanaMint: card?.solana_mint ?? null,
      });

      /**
       * Token ids restart at 1 on a MirrorNFT redeploy and this table keys on the bare number,
       * so a row from a previous deployment would silently swallow this claim — and the
       * mirror is ALREADY BURNED by the time we get here. Loud, not quiet.
       */
      const recorded = this.d.db.getWithdrawal(tokenId);
      if (recorded && recorded.requester.toLowerCase() !== r.owner.toLowerCase()) {
        /**
         * HELD, not merely alerted.
         *
         * `recordWithdrawal` is ON CONFLICT(token_id) DO NOTHING and token ids restart at 1 on
         * a MirrorNFT redeploy — the same shape as the order-id collision that cost a real
         * pack. So the row still standing here belongs to a DIFFERENT user, with a different
         * destination and a different mint, and this user's claim was silently not written.
         *
         * Alerting alone left the relayer free to act on that stale row: it would send the OLD
         * card to the OLD destination, on the strength of a burn by someone else. Holding stops
         * the send. It does not fix the missing claim — only a human can — but it converts
         * "wrong card irreversibly transferred" into "nothing moved, someone is paged".
         */
        this.d.db.setWithdrawalStatus(tokenId, "COLLISION", {
          last_error:
            `collision: this row belongs to ${recorded.requester} but the chain says ${r.owner}. ` +
            `Refusing to relay until a human resolves which claim is real.`,
        });
        this.alert(
          `Withdraw collision on token ${tokenId}: recorded ${recorded.requester}, chain says ` +
            `${r.owner}. A row from a previous deployment is in the way and this user's ` +
            `mirror is already burned. HELD — nothing will be sent. Needs a human NOW.`,
        );
      }

      if (!card?.solana_mint) {
        // A burned mirror we cannot match to a card. The user is still owed something; this
        // needs a person, immediately.
        this.d.db.setWithdrawalStatus(tokenId, "HELD", {
          last_error: "no card row matches this mirror — cannot determine which asset to send",
        });
        this.alert(
          `Withdraw for mirror ${tokenId} by ${r.owner} has NO MATCHING CARD. The mirror is ` +
            `already burned, so this user is owed a card we cannot identify. Needs a human.`,
        );
      }
    }

    this.d.db.setMeta(CURSOR_KEY, latestBlock.toString());
  }

  /** Attempt every outstanding withdraw. Safe to call repeatedly. */
  private async relay(): Promise<void> {
    for (const w of this.d.db.openWithdrawals()) {
      try {
        await this.send(w);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // FAILED, never closed. The next tick tries again, and the row is the user's receipt.
        const isNew = w.status !== "FAILED" || w.last_error !== message;
        this.d.db.setWithdrawalStatus(w.token_id, "FAILED", { last_error: message });

        /**
         * Alert on a CHANGE, not on every attempt.
         *
         * The tick is 4 seconds and a failure is retried forever by design, so alerting each
         * time turns one permanently bad destination — say a user who called burnForUnwrap
         * directly with a program address — into fifteen alerts a minute, indefinitely. This
         * project has already had one incident where a repeating alert buried the signal it
         * mattered most to see. The retry still happens every tick; only the noise stops.
         */
        if (isNew) this.alert(`Withdraw ${w.token_id} to ${w.solana_dest} failed: ${message}`);
      }
    }
  }

  private async send(w: WithdrawalRow): Promise<void> {
    if (w.transfer_sig) return; // already done

    /**
     * A null mint is not permanent. RE-LOOK before giving up on it.
     *
     * `solana_mint` is written once at ingest from `cardByMirrorTokenId`, and that lookup is by
     * `owner_mirror_token_id` — which is NULL during the interrupted-mint window that
     * fulfill.ts exists to recover from. An unwrap seen in that window was HELD with a null
     * mint forever, because this early return fired before the card was ever re-read, even
     * after the recovery backfilled the link. The mirror is already burned by then.
     */
    let recoveredMint: string | null = w.solana_mint;
    if (!recoveredMint) {
      const recovered = this.d.db.cardByMirrorTokenId(w.token_id);
      if (!recovered?.solana_mint) return; // still unknown; the ingest alert stands
      recoveredMint = recovered.solana_mint;
      this.d.db.setWithdrawalStatus(w.token_id, "SEEN", {
        solana_mint: recoveredMint,
        last_error: null,
      });
      this.alert(
        `Withdraw ${w.token_id}: the card behind this mirror is now known ` +
          `(${recoveredMint}). Resuming a request that was held with no mint.`,
      );
    }

    /** Narrowed once, here, so the rest of this function cannot re-widen it to null. */
    const mint = recoveredMint;

    /**
     * A collision is never relayed, by anything, ever — only a human clearing the status can
     * release it.
     *
     * Marking it was not enough on its own: `openWithdrawals` returns every row without a
     * signature, so a merely-HELD collision came straight back here on the next tick and was
     * sent. A test caught that. The row names a different requester than the burn we just saw,
     * which means its destination and its mint are somebody else's too.
     */
    if (w.status === "COLLISION") return;

    /**
     * The kill switch, checked here rather than at ingest.
     *
     * Switched off, we still WATCH and RECORD — we simply do not send. That ordering is what
     * makes the switch safe to leave off: turning it on later relays everything already
     * queued, in the order it was requested, rather than starting from a blank slate.
     */
    if (!this.d.cfg.withdrawEnabled) {
      if (w.status !== "HELD") {
        this.d.db.setWithdrawalStatus(w.token_id, "HELD", {
          last_error: "WITHDRAW_ENABLED=false — recorded and queued, not sent",
        });
        this.alert(
          `Withdraw ${w.token_id} to ${w.solana_dest} is QUEUED, not sent: the relayer is off. ` +
            `The mirror is already burned, so this is a real debt. Set WITHDRAW_ENABLED=true to relay.`,
        );
      }
      return;
    }

    const card = this.d.db.cardByMirrorTokenId(w.token_id);

    /**
     * The card must still be one we hold.
     *
     * Without this, a mirror whose card has already left — sold to Collector Crypt, previously
     * unwrapped, or burned like the destroyed card #1 — reaches `withdrawAssetTo`, fails the
     * on-chain ownership check, and retries forever behind the message "not our custody
     * wallet". That is technically safe but reads as a transient fault when it is permanent,
     * and it buries a case that genuinely needs a person: the user's mirror is gone and the
     * card behind it is not ours to send.
     */
    if (card && card.state !== "CUSTODY") {
      if (w.status !== "HELD") {
        this.d.db.setWithdrawalStatus(w.token_id, "HELD", {
          last_error: `card state is ${card.state}, not CUSTODY — it already left, so there is nothing to send`,
        });
        this.alert(
          `Withdraw ${w.token_id} is for a card in state ${card.state}. The mirror was burned but ` +
            `the card is not ours to send. Needs a human.`,
        );
      }
      return;
    }

    // The same ceiling the sell-back path uses, for the same reason: prove the irreversible
    // paths on cheap cards first. Over the limit is HELD for a human, never silently dropped.
    const limit = this.d.cfg.maxSellBackValueUsd;
    if (limit > 0 && card?.insured_value_usd && Number(card.insured_value_usd) / 1e6 > limit) {
      if (w.status !== "HELD") {
        this.d.db.setWithdrawalStatus(w.token_id, "HELD", {
          last_error: `insured above the $${limit} ceiling — needs a human`,
        });
        this.alert(
          `Withdraw ${w.token_id} is for a card insured above $${limit}. Held for manual review.`,
        );
      }
      return;
    }

    /**
     * RECONCILE BEFORE RETRYING.
     *
     * If the transfer landed but we crashed before writing `transfer_sig`, the next tick would
     * retry, find the asset no longer in custody, and mark a SUCCESSFUL withdraw as FAILED —
     * permanently, and alerting about it forever. The chain is the authority on whether the
     * card moved, so ask it first: if the destination already holds the asset, this withdraw
     * is done and the only thing missing is our own bookkeeping.
     *
     * Same discipline as the buyback payout and the pack purchase: never guess from local
     * state whether an irreversible action happened.
     */
    const currentOwner = await this.d.solana.assetOwner(mint);
    if (currentOwner && currentOwner === w.solana_dest) {
      this.d.db.setWithdrawalStatus(w.token_id, "SENT", { last_error: null });
      this.d.db.setCardState(mint, "UNWRAPPED");
      this.alert(`Withdraw ${w.token_id} was already at ${w.solana_dest} — recorded as sent.`);
      return;
    }

    const res = await this.d.solana.withdrawAssetTo(mint, w.solana_dest, {
      requireDestinationExists: this.d.cfg.withdrawRequireFundedDestination,
    });

    /**
     * Record the signature the INSTANT it exists.
     *
     * Same discipline as the pack purchase and the buyback payout. The transfer is irreversible
     * the moment it lands; if we only wrote the signature after some later step, a crash in
     * between would leave a sent card looking unsent, and the next tick would send it again —
     * except it cannot, because we no longer hold it, so it would instead look like a
     * permanent failure on a withdraw that actually succeeded.
     */
    this.d.db.setWithdrawalStatus(w.token_id, "SENT", { transfer_sig: res.signature, last_error: null });

    /**
     * The card has left custody, so it must stop counting as held.
     *
     * Without this it stays CUSTODY forever, which is not cosmetic: `/reserves` counts
     * `state IN ('CUSTODY','SALVAGE')` and would overstate what backs the outstanding mirrors,
     * turning a public solvency claim into a false one. `/collection` would also keep showing
     * the user a card they no longer hold. The codebase already learned this from sell-backs;
     * UNWRAPPED exists for exactly this transition.
     */
    this.d.db.setCardState(mint, "UNWRAPPED");

    this.alert(`Withdraw ${w.token_id} sent to ${res.destination}: ${res.signature}`);
  }

  private alert(message: string): void {
    this.d.alert(message);
  }
}
