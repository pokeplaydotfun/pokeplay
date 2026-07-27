/**
 * Withdrawing a card: burn the mirror, receive the real Collector Crypt NFT.
 *
 * THE THING TO UNDERSTAND BEFORE CHANGING ANYTHING HERE. `burnForUnwrap` destroys the mirror
 * and THEN emits the request for our relayer. There is no escrow, no refund and no reversal.
 * The moment this transaction confirms, the user holds nothing and is owed a physical card,
 * and every protection that remains is off chain.
 *
 * So this hook does its checking BEFORE it asks for a signature, never after:
 *
 *   - the destination is validated locally, and the same rules run again server-side
 *   - ownership is re-read from the chain rather than trusted from a stale list
 *   - the relayer is confirmed to be accepting withdraws at all
 *
 * A user who signs and finds out afterwards that any of these was wrong has lost their card.
 */
import { useCallback, useState } from "react";
import { useAccount, useConfig, type Config } from "wagmi";
import { readContract, writeContract, waitForTransactionReceipt } from "wagmi/actions";
import { CONTRACTS, robinhoodChain } from "./chain.ts";
import { MIRROR_NFT_ABI } from "./abis.ts";
import { checkSolanaAddress, solanaAddressToHex } from "./settings.ts";
import { humanError } from "./errors.ts";
import { getWithdrawCapability } from "./client.ts";

export type WithdrawStep =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "burning"; hash?: `0x${string}` }
  | { kind: "submitted"; hash: `0x${string}` }
  | { kind: "error"; message: string };

/**
 * `burnForUnwrap(tokenId, solanaAddress, quote, signature)`.
 *
 * The quote arguments are ignored on chain whenever `unwrapFeeBps` is 0 or the CC window has
 * closed, which is the live configuration — the fee is 0. Zeroes and empty bytes are what the
 * contract's own comment prescribes for that case, not a shortcut.
 */
const EMPTY_QUOTE = { tokenId: 0n, insuredValueUsdg: 0n, expiry: 0n } as const;

export function useWithdraw() {
  const config = useConfig();
  const { address } = useAccount();
  const [step, setStep] = useState<WithdrawStep>({ kind: "idle" });

  const reset = useCallback(() => setStep({ kind: "idle" }), []);

  const withdraw = useCallback(
    async (tokenId: string, solanaAddress: string, overValueLimit = false): Promise<boolean> => {
      if (!address) {
        setStep({ kind: "error", message: "Connect your wallet first." });
        return false;
      }
      if (!CONTRACTS.mirror) {
        setStep({ kind: "error", message: "Contracts are not configured for this build." });
        return false;
      }

      setStep({ kind: "checking" });

      // 1. The destination, before anything is signed. The same address is checked again by
      //    the relayer with rules a browser cannot run, but catching it here is the difference
      //    between an error message and a destroyed card.
      const dest = checkSolanaAddress(solanaAddress);
      if (!dest.ok) {
        setStep({ kind: "error", message: dest.reason });
        return false;
      }

      try {
        /**
         * 2. Is the relayer actually accepting withdraws?
         *
         * Burning while the relayer is switched off produces a recorded, honoured claim rather
         * than a loss — that is what the queue is for — but the user would wait with nothing
         * in hand and no idea why. Asking first turns that into a sentence they can act on.
         */
        const cap = await getWithdrawCapability();
        if (!cap.enabled) {
          setStep({
            kind: "error",
            message:
              "Withdrawals are paused right now, so nothing has been burned. " +
              "Your card is untouched and still yours.",
          });
          return false;
        }
        /**
         * Whether THIS card is over the ceiling is decided by the server and arrives with the
         * card. The threshold itself is never sent to the browser: it is an operational detail,
         * and this bundle is public. The message is generic for the same reason.
         */
        if (overValueLimit) {
          setStep({
            kind: "error",
            message:
              "This card needs to be withdrawn by hand for now. Nothing has been burned.",
          });
          return false;
        }

        // 3. Ownership, from the chain. The collection list can be seconds stale, which is
        //    long enough for the card to have been listed, sold or already withdrawn.
        const owner = await readContract(config as Config, {
          address: CONTRACTS.mirror,
          abi: MIRROR_NFT_ABI,
          functionName: "ownerOf",
          args: [BigInt(tokenId)],
          chainId: robinhoodChain.id,
        });
        if (owner.toLowerCase() !== address.toLowerCase()) {
          setStep({ kind: "error", message: "This card is no longer in your wallet." });
          return false;
        }

        setStep({ kind: "burning" });
        const hash = await writeContract(config as Config, {
          address: CONTRACTS.mirror,
          abi: MIRROR_NFT_ABI,
          functionName: "burnForUnwrap",
          args: [BigInt(tokenId), solanaAddressToHex(dest.bytes), EMPTY_QUOTE, "0x"],
          chainId: robinhoodChain.id,
        });
        setStep({ kind: "burning", hash });

        /**
         * A reverted transaction does NOT throw here.
         *
         * `waitForTransactionReceipt` resolves with `status: "reverted"`, so awaiting it and
         * moving on treats a failed burn as a successful one — and this screen then tells
         * someone their irreplaceable card has been burned and is on its way to their wallet.
         * It has not been, and nothing is coming. They wait, then raise a ticket about a card
         * that is still sitting in their wallet.
         *
         * Reachable without anything exotic: list the card in another tab between the ownerOf
         * read above and this transaction landing, on a chain with 0.1s blocks, and
         * burnForUnwrap reverts NotTokenOwner.
         */
        const receipt = await waitForTransactionReceipt(config, { hash, chainId: robinhoodChain.id });
        if (receipt.status === "reverted") {
          setStep({
            kind: "error",
            message:
              "The withdrawal was rejected on chain, so your card was NOT burned and is still " +
              "yours. This usually means the card moved out of your wallet while the " +
              "transaction was in flight. Refresh and try again.",
          });
          return false;
        }

        setStep({ kind: "submitted", hash });
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A rejected prompt is not a failure. Nothing was burned.
        if (/user rejected|denied transaction/i.test(message)) {
          setStep({ kind: "idle" });
          return false;
        }
        /**
         * Everything that can throw above happens BEFORE the burn, or is the burn itself
         * reverting. Either way the mirror still exists, so this message can promise that
         * safely — and should, because "something went wrong" while withdrawing an
         * irreplaceable card is a uniquely frightening thing to read.
         */
        setStep({
          kind: "error",
          message: `${humanError(err, "The withdrawal did not go through.")} Your card was not burned and is still yours.`,
        });
        return false;
      }
    },
    [address, config],
  );

  return { step, withdraw, reset };
}
