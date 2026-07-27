/**
 * The escrow watcher: turns an arriving mirror into a sell-back, and hands back anything it
 * cannot account for.
 *
 * ## Why the transfer is the confirmation
 *
 * A sell-back could have been "quote, transfer, then confirm". That leaves a window where
 * someone has given up their card and then closes the tab, and their card sits in our custody
 * with nothing driving it. Making the transfer itself the commitment removes that window: by
 * the time we hold the token, the decision has already been made and recorded on chain.
 *
 * So the user's flow is one wallet prompt, and every outcome has an answer:
 *
 *   quoted, never transferred   the quote expires. Nothing moved, nothing owed.
 *   transferred with a quote    the sell-back starts.
 *   transferred with no quote   returned, by the sweeper below.
 *   quote went stale in between the pipeline re-quotes and aborts if it moved against them.
 *
 * ## Who we pay
 *
 * The seller is always the `from` of the on-chain Transfer, never anything in a request body.
 * A quote records a price; it cannot nominate a recipient. That is what stops someone quoting
 * against a token they do not own in the hope of being paid for somebody else's card.
 *
 * ## The sweeper
 *
 * Holding a card is never allowed to be a state we forget. Any deposit with no buyback and no
 * recorded return is a card we owe back, and the sweeper retries until that is resolved.
 * It re-reads ownership from the chain each pass, so it is self-healing: if the token has
 * already left our custody by any route, the row is closed rather than re-sent.
 */
import type { Db } from "../db/index.ts";
import type { Config } from "../config.ts";
import { exceedsValueLimit } from "../policy.ts";

/** Chain operations the watcher needs. Narrow so tests can supply a fake. */
export interface EscrowChain {
  readonly operatorAddress: string;
  headBlock(): Promise<bigint>;
  inboundMirrorTransfers(
    fromBlock: bigint,
    toBlock?: bigint,
  ): Promise<{ transfers: { tokenId: bigint; from: string }[]; latestBlock: bigint }>;
  mirrorOwnerOf(tokenId: bigint): Promise<string>;
  returnMirror(to: string, tokenId: bigint): Promise<string>;
}

/** Just enough of the buyback pipeline to hand work to it. */
export interface BuybackRunner {
  process(id: number): Promise<void>;
}

export type EscrowDeps = {
  db: Db;
  chain: EscrowChain;
  buybacks: BuybackRunner;
  cfg: Config;
  alert?: (message: string) => void;
};

const CURSOR_KEY = "escrow_block_cursor";

/**
 * How far back a quote may be and still be filled by an arriving deposit. Generous on
 * purpose: returning a real seller's card because they took four minutes would be a far worse
 * failure than filling a slightly old quote, and the pipeline re-quotes before it sells
 * anyway, so a stale price cannot cost anyone money.
 */
const QUOTE_MATCH_WINDOW_MS = 30 * 60_000;

export class EscrowWatcher {
  private readonly d: EscrowDeps;

  constructor(deps: EscrowDeps) {
    this.d = deps;
  }

  private alert(message: string): void {
    (this.d.alert ?? ((m: string) => console.error(`[ALERT] ${m}`)))(message);
  }

  /** One pass: take in new deposits, then resolve anything still unaccounted for. */
  async tick(): Promise<void> {
    await this.ingest();
    await this.sweep();
  }

  /**
   * Scan for mirrors that arrived since the cursor.
   *
   * The cursor only advances once the whole range has been recorded, so a crash mid-scan
   * replays rather than skips. Re-recording a deposit is harmless; missing one would mean
   * silently holding someone's card.
   */
  private async ingest(): Promise<void> {
    let cursor = BigInt(this.d.db.getMeta(CURSOR_KEY) ?? "0");
    if (cursor === 0n) {
      // First boot: start from now. Anything already in custody predates the feature and is
      // picked up by the sweeper on ownership, not by log replay.
      cursor = await this.d.chain.headBlock();
      this.d.db.setMeta(CURSOR_KEY, cursor.toString());
      return;
    }

    const { transfers, latestBlock } = await this.d.chain.inboundMirrorTransfers(cursor + 1n);

    for (const t of transfers) {
      const tokenId = t.tokenId.toString();
      this.d.db.recordEscrowDeposit(tokenId, t.from);

      // Already being worked on: a replayed log, or a deposit picked up on an earlier pass.
      const deposit = this.d.db.getEscrowDeposit(tokenId);
      if (deposit?.buyback_id != null || deposit?.returned_tx != null) continue;
      if (this.d.db.openBuybackFor(tokenId)) continue;

      // With sell-back disabled, an arriving mirror is never confirmed into a sale. It falls
      // through to the sweeper and goes straight back, because selling the card and then
      // discovering a leg is missing is far worse than declining the sale.
      if (!this.d.cfg.sellBackEnabled) continue;

      // The value ceiling, enforced where it actually holds.
      //
      // A sell-back starts with an on-chain transfer to this address. No website is involved,
      // so the UI popup and the API refusal are both bypassable by anyone with a wallet: they
      // can simply send the mirror here. This check is the one that cannot be routed around.
      //
      // `continue` is the whole mechanism: an unmatched deposit falls through to sweep(),
      // which reads ownership from the chain and returns the mirror to whoever sent it. So a
      // too-valuable card is handed straight back rather than sold.
      //
      // Checked here rather than relying on no quote existing, because a quote written before
      // the limit was set or lowered would otherwise still match.
      const card = this.d.db.cardByMirrorTokenId(tokenId);

      /**
       * A DEPOSITED card is never sold back, and this is the check that actually holds.
       *
       * A sell-back starts with an on-chain transfer to the escrow address. No website is
       * involved, so refusing it in the API or hiding the button would both be bypassable by
       * anyone with a wallet — the same reasoning the value ceiling below is placed here for.
       *
       * The rule exists because we never bought a deposited card. Paying USDG for it would be
       * handing someone money for a card they gave us and could simply withdraw again.
       *
       * `continue` is the whole mechanism: an unmatched deposit falls through to sweep(),
       * which reads ownership from the chain and returns the mirror to whoever sent it. So the
       * user gets their mirror straight back rather than losing it to a sale that must not
       * happen.
       */
      if (card?.origin === "DEPOSIT") {
        this.alert(
          `Mirror ${tokenId} from ${t.from} is a DEPOSITED card and cannot be sold back. ` +
            `Returning it to the sender.`,
        );
        continue;
      }

      if (exceedsValueLimit(card?.insured_value_usd, this.d.cfg.maxSellBackValueUsd)) {
        this.alert(
          `Mirror ${tokenId} from ${t.from} is insured above $${this.d.cfg.maxSellBackValueUsd} ` +
            `and cannot be sold back. Returning it to the sender.`,
        );
        continue;
      }

      const quote = this.d.db.matchableQuoteFor(tokenId, QUOTE_MATCH_WINDOW_MS);
      if (!quote) continue; // no intent behind it — the sweeper hands it back

      // Bind the sell to the address that actually gave up the token, not to whoever
      // requested the quote.
      this.d.db.confirmQuote(quote.id, t.from);
      this.d.db.linkEscrowToBuyback(tokenId, quote.id);

      try {
        await this.d.buybacks.process(quote.id);
      } catch (err) {
        // The pipeline handles its own failures; this only catches a throw escaping it.
        const message = err instanceof Error ? err.message : String(err);
        this.alert(`Buyback ${quote.id} threw out of the pipeline: ${message}`);
      }
    }

    this.d.db.setMeta(CURSOR_KEY, latestBlock.toString());
  }

  /**
   * Return every card we are holding for no reason.
   *
   * Ownership is re-read from the chain rather than trusted from our own bookkeeping, so a
   * token that already left by any route closes cleanly instead of being sent twice.
   */
  private async sweep(): Promise<void> {
    for (const deposit of this.d.db.unresolvedEscrowDeposits()) {
      const tokenId = deposit.token_id;

      // A buyback may have claimed it since the row was written.
      if (this.d.db.openBuybackFor(tokenId)) continue;

      try {
        const holder = await this.d.chain.mirrorOwnerOf(BigInt(tokenId));
        if (holder.toLowerCase() !== this.d.chain.operatorAddress.toLowerCase()) {
          // Not ours any more — already returned, burned, or never really arrived.
          this.d.db.markEscrowReturned(tokenId, "already-not-held");
          continue;
        }

        const tx = await this.d.chain.returnMirror(deposit.depositor, BigInt(tokenId));
        this.d.db.markEscrowReturned(tokenId, tx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.d.db.recordEscrowError(tokenId, message);

        // Only shout once it has been stuck long enough to be a real problem: a single failed
        // RPC call is not worth waking anyone, an unreturnable card is.
        const heldFor = Date.now() - deposit.seen_at;
        if (heldFor > 10 * 60_000) {
          this.alert(
            `Holding mirror ${tokenId} for ${deposit.depositor} with no sell-back and cannot ` +
              `return it (${Math.round(heldFor / 60_000)} min): ${message}`,
          );
        }
      }
    }
  }
}
