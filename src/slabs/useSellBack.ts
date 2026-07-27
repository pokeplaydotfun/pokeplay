import { useCallback, useState } from "react";
import { useAccount, useConfig, type Config } from "wagmi";
import { readContract, writeContract, waitForTransactionReceipt } from "wagmi/actions";
import { CONTRACTS, robinhoodChain } from "./chain.ts";
import { MIRROR_NFT_ABI, MARKETPLACE_ABI } from "./abis.ts";
import { requestSellQuote, type SellQuote } from "./client.ts";

/**
 * Sell a card back, in one wallet prompt.
 *
 * The transfer into operator custody IS the confirmation. There is deliberately no second
 * "confirm" step after it: that would leave a window where someone has given up their card
 * and then closed the tab, and their card would sit in custody with nothing driving it.
 *
 * The quote is recorded first so the price the seller saw is on file, but it commits nobody —
 * a quote that is never followed by a transfer simply expires, and the worker re-checks the
 * price before it sells anything.
 */
export type SellStep =
  | { kind: "idle" }
  | { kind: "quoting" }
  | { kind: "quoted"; quote: SellQuote }
  | { kind: "transferring"; hash?: `0x${string}` }
  | { kind: "submitted"; hash: `0x${string}` }
  | { kind: "error"; message: string }
  /** The card has a live listing. It must be delisted before it can be sold back. */
  | { kind: "listed"; tokenId: string };

export function useSellBack() {
  const config = useConfig();
  const { address } = useAccount();
  const [step, setStep] = useState<SellStep>({ kind: "idle" });

  const reset = useCallback(() => setStep({ kind: "idle" }), []);

  /**
   * Does this card have a live listing?
   *
   * Returns false when the marketplace cannot be read, deliberately. This gate exists to
   * protect a would-be buyer from an undeliverable listing, not to protect the protocol —
   * failing it closed would block every sell-back whenever an RPC hiccups, which is the
   * worse failure. The transfer path re-checks immediately before committing.
   */
  const isListed = useCallback(
    async (tokenId: string): Promise<boolean> => {
      if (!CONTRACTS.marketplace) return false;
      try {
        const listing = await readContract(config as Config, {
          address: CONTRACTS.marketplace,
          abi: MARKETPLACE_ABI,
          functionName: "getListing",
          args: [BigInt(tokenId)],
          chainId: robinhoodChain.id,
        });
        const seller = (listing as { seller: string }).seller;
        return Boolean(seller) && seller !== "0x0000000000000000000000000000000000000000";
      } catch {
        return false;
      }
    },
    [config],
  );

  /** Ask for a price. Free, no wallet interaction, commits nothing. */
  const quote = useCallback(
    async (tokenId: string): Promise<SellQuote | null> => {
      if (!address) {
        setStep({ kind: "error", message: "Connect your wallet to sell a card back." });
        return null;
      }
      // Checked before the quote so a listed card is explained up front, rather than after
      // the seller has been shown a payout they cannot take.
      if (await isListed(tokenId)) {
        setStep({ kind: "listed", tokenId });
        return null;
      }

      setStep({ kind: "quoting" });
      try {
        const q = await requestSellQuote(tokenId, address);
        setStep({ kind: "quoted", quote: q });
        return q;
      } catch (err) {
        setStep({
          kind: "error",
          message: err instanceof Error ? err.message : "Could not get a price for this card.",
        });
        return null;
      }
    },
    [address, isListed],
  );

  /**
   * Hand the card over. This is the irreversible step, so everything checkable is checked
   * before the wallet is ever opened.
   */
  const confirm = useCallback(
    async (q: SellQuote): Promise<boolean> => {
      if (!address) {
        setStep({ kind: "error", message: "Connect your wallet to sell a card back." });
        return false;
      }
      if (!CONTRACTS.mirror) {
        setStep({ kind: "error", message: "Sell-back is unavailable right now." });
        return false;
      }
      if (!q.escrowTo) {
        // Never transfer to an unset destination: that is a card sent to the zero address.
        setStep({ kind: "error", message: "Sell-back is unavailable right now." });
        return false;
      }
      if (Date.now() >= q.expiresAt) {
        setStep({ kind: "error", message: "That price expired. Ask for a new one." });
        return false;
      }

      try {
        // Ownership is re-read from the chain rather than trusted from the collection list,
        // which can be seconds stale — long enough for the card to have been sold or listed.
        const owner = await readContract(config as Config, {
          address: CONTRACTS.mirror,
          abi: MIRROR_NFT_ABI,
          functionName: "ownerOf",
          args: [BigInt(q.tokenId)],
          chainId: robinhoodChain.id,
        });
        if (owner.toLowerCase() !== address.toLowerCase()) {
          setStep({ kind: "error", message: "This card is no longer in your wallet." });
          return false;
        }

        /**
         * REFUSE TO SELL BACK A LISTED CARD.
         *
         * `list` does not escrow anything — it records a promise and the seller keeps custody.
         * So `ownerOf` above still returns the seller, and this transfer into operator custody
         * SUCCEEDS with a live listing standing. What it leaves behind is an undeliverable
         * listing: the card is gone to custody and on its way back to Collector Crypt, while
         * the marketplace still advertises it. Any buyer who tries reverts with
         * SellerNoLongerOwns, having paid gas for a card that was never available.
         *
         * Checked here, immediately before the irreversible transfer, because a check at
         * dialog-open time can be several seconds stale — long enough to list the card in
         * another tab. The dialog does its own check too, but only that one is race-proof.
         *
         * An unreadable marketplace does NOT block: the check is a courtesy to the buyer, and
         * failing it closed would strand every sell-back whenever an RPC hiccups.
         */
        if (await isListed(q.tokenId)) {
          setStep({ kind: "listed", tokenId: q.tokenId });
          return false;
        }

        setStep({ kind: "transferring" });
        const hash = await writeContract(config as Config, {
          address: CONTRACTS.mirror,
          abi: MIRROR_NFT_ABI,
          functionName: "safeTransferFrom",
          args: [address, q.escrowTo as `0x${string}`, BigInt(q.tokenId)],
          chainId: robinhoodChain.id,
        });
        setStep({ kind: "transferring", hash });

        /**
         * A revert resolves here rather than throwing, with `status: "reverted"`.
         *
         * This transfer IS the sell-back: handing the mirror to custody is what commits it.
         * Unchecked, a reverted transfer moved straight to "submitted" and told the seller
         * their sale was under way while the card had never left their wallet and no quote
         * had been accepted. They would then wait for a payout that was never coming.
         *
         * Reachable by an ordinary race — listing the card, or withdrawing it, between the
         * ownership read above and this transaction landing.
         */
        const receipt = await waitForTransactionReceipt(config, { hash, chainId: robinhoodChain.id });
        if (receipt.status === "reverted") {
          setStep({
            kind: "error",
            message:
              "The transfer was rejected on chain, so your card never left your wallet and " +
              "nothing was sold. This usually means the card moved while the transaction was " +
              "going through. Refresh and try again.",
          });
          return false;
        }

        setStep({ kind: "submitted", hash });
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A rejected prompt is not a failure worth alarming anyone about.
        if (/user rejected|denied transaction/i.test(message)) {
          setStep({ kind: "idle" });
          return false;
        }
        setStep({
          kind: "error",
          message:
            "The transfer did not go through, so your card is still yours and nothing was " +
            "sold. You can try again.",
        });
        return false;
      }
    },
    [address, config, isListed],
  );

  return { step, quote, confirm, reset };
}
