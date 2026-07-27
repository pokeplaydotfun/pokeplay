import { useCallback, useState } from "react";
import { useAccount, useConfig, type Config } from "wagmi";
import { readContract, writeContract, waitForTransactionReceipt } from "wagmi/actions";
import { parseEventLogs, stringToHex } from "viem";
import { CONTRACTS, robinhoodChain } from "./chain.ts";
import { ERC20_ABI, PACK_SALE_ABI } from "./abis.ts";
import { humanError, isUserRejection } from "./errors.ts";

/**
 * On-chain purchase: USDG approve, then PackSale.buy. Two transactions, and the UI names
 * both rather than showing one opaque spinner — an unexplained second wallet prompt is how
 * users assume they're being drained.
 */
export type BuyStep =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "approving"; hash?: `0x${string}` }
  | { kind: "buying"; hash?: `0x${string}` }
  | { kind: "done"; orderId: number; hash: `0x${string}` }
  | { kind: "error"; message: string };

/**
 * Machine ids are bytes32 on-chain. We use the right-padded ASCII of CC's machine code
 * ("pokemon_50") rather than a hash, so the value is legible in a block explorer.
 *
 * ⚠ This MUST match how `setMachine` was called at deploy time. If ops registers machines
 * by keccak256 instead, change this and the deploy script together or every buy reverts
 * with MachineDisabled.
 */
export const machineIdToBytes32 = (code: string) => stringToHex(code, { size: 32 });

/** USDG is 6dp. Used only to name the two amounts when an approval came back short. */
function fmtUsdg(v: bigint): string {
  return (Number(v) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function useBuyPack() {
  const config = useConfig();
  const { address } = useAccount();
  const [step, setStep] = useState<BuyStep>({ kind: "idle" });

  const reset = useCallback(() => setStep({ kind: "idle" }), []);

  const buy = useCallback(
    async (machineCode: string): Promise<number | null> => {
      if (!address) {
        setStep({ kind: "error", message: "Connect your wallet first." });
        return null;
      }
      if (!CONTRACTS.usdg || !CONTRACTS.packSale) {
        setStep({ kind: "error", message: "Contracts are not configured for this build." });
        return null;
      }

      const machineId = machineIdToBytes32(machineCode);

      try {
        setStep({ kind: "checking" });

        // Price comes from the contract, never from the UI — the contract is the authority
        // on what a pack costs (doc 03 §1).
        const [priceUsdg, enabled] = await readContract(config as Config, {
          address: CONTRACTS.packSale,
          abi: PACK_SALE_ABI,
          functionName: "machines",
          args: [machineId],
          chainId: robinhoodChain.id,
        });

        if (!enabled) {
          setStep({ kind: "error", message: "This machine is currently disabled." });
          return null;
        }

        /**
         * Is the storefront full right now?
         *
         * `maxOpenOrders` is a global cap on how many orders can be in flight at once, not a
         * per-buyer one. Checked here so a buyer who arrives while it is full is told to wait
         * rather than paying gas to be reverted — and so the message can say the truth: the
         * store is busy, not that they did anything wrong.
         *
         * Deliberately not a hard gate. It is a read of a value that can change between this
         * check and the transaction, so buy() still reverts with TooManyOpenOrders if the last
         * slot goes in between; that path is handled and now carries a correct message. This
         * only spares the common case.
         *
         * BEST EFFORT, and that is load-bearing. This is a courtesy check on a path that
         * otherwise works, so it must never be the reason a buy fails. Left inside the outer
         * try it would do exactly that: an RPC hiccup on these two reads would surface as a
         * failed purchase to someone who could have bought a pack perfectly well. On any read
         * failure we say nothing and let the transaction decide.
         */
        try {
          const read = (functionName: "openOrderCount" | "maxOpenOrders" | "maxOpenOrdersPerBuyer") =>
            readContract(config as Config, {
              address: CONTRACTS.packSale!, abi: PACK_SALE_ABI, functionName,
              chainId: robinhoodChain.id,
            });
          const [openOrders, maxOpen, mine, maxMine] = await Promise.all([
            read("openOrderCount"),
            read("maxOpenOrders"),
            readContract(config as Config, {
              address: CONTRACTS.packSale, abi: PACK_SALE_ABI,
              functionName: "openOrdersOf", args: [address], chainId: robinhoodChain.id,
            }),
            read("maxOpenOrdersPerBuyer"),
          ]);

          // The buyer's OWN limit first: it is the likelier of the two to bite a real user,
          // and its message is actionable in a way the global one is not.
          if (Number(maxMine) > 0 && Number(mine) >= Number(maxMine)) {
            setStep({
              kind: "error",
              message:
                "You already have packs opening. Wait for one to finish, then try again. " +
                "Nothing has been charged.",
            });
            return null;
          }

          if (Number(openOrders) >= Number(maxOpen)) {
            setStep({
              kind: "error",
              message:
                "Too many packs are opening right now. Try again in a minute. " +
                "Nothing has been charged.",
            });
            return null;
          }
        } catch {
          // Unreadable cap: proceed. buy() enforces it on chain regardless.
        }

        const balance = await readContract(config as Config, {
          address: CONTRACTS.usdg,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [address],
          chainId: robinhoodChain.id,
        });

        if (balance < priceUsdg) {
          const need = (Number(priceUsdg) / 1e6).toFixed(2);
          const have = (Number(balance) / 1e6).toFixed(2);
          setStep({ kind: "error", message: `You need ${need} USDG. Your balance is ${have}.` });
          return null;
        }

        const allowance = await readContract(config as Config, {
          address: CONTRACTS.usdg,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [address, CONTRACTS.packSale],
          chainId: robinhoodChain.id,
        });

        // Approve only when needed, so repeat buyers get one prompt instead of two.
        if (allowance < priceUsdg) {
          /**
           * Approve EXACTLY the price, never an unlimited allowance.
           *
           * `PackSale.buy(machineId)` takes no expected-price argument — it charges whatever
           * the machine is configured at when the transaction executes. With a maxUint256
           * approval standing, a `setMachine` landing between this signature and its execution
           * silently charges the new price, bounded only by `maxPackPrice`, which is 1000 USDG
           * on chain against a 53 USDG pack.
           *
           * That is not only a malicious-owner scenario: the operator changes prices by hand
           * as part of normal ops, and Collector Crypt's own prices move. `Marketplace.buy`
           * already takes an `expectedPriceUsdg` for exactly this reason; PackSale is the
           * inconsistent one, and until it gains the same parameter the allowance is the only
           * thing standing between a buyer and an unbounded charge.
           *
           * Costs one approval per purchase instead of one ever. On a chain with 0.1s blocks
           * and negligible gas that is the right trade for a hard ceiling on what can be taken.
           */
          setStep({ kind: "approving" });
          const approveHash = await writeContract(config as Config, {
            address: CONTRACTS.usdg,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [CONTRACTS.packSale, priceUsdg],
            chainId: robinhoodChain.id,
          });
          setStep({ kind: "approving", hash: approveHash });
          // Same trap as the buy receipt: a reverted approval resolves rather than throwing,
          // and buy() would then fail on allowance with a far more confusing message.
          const approveReceipt = await waitForTransactionReceipt(config, {
            hash: approveHash, chainId: robinhoodChain.id,
          });
          if (approveReceipt.status === "reverted") {
            setStep({
              kind: "error",
              message: "The approval was rejected on chain. Nothing was charged. Try again.",
            });
            return null;
          }

          /**
           * RE-READ the allowance. Some wallets let the amount be edited.
           *
           * We request approval for exactly the pack price, but an approval screen is an
           * editable field in several wallets — OKX among them — and a user can lower it
           * without realising the number means anything. `buy` then reverts on allowance,
           * which is a confusing way to find out, and it costs them a second signature to
           * learn nothing.
           *
           * The payment itself is not editable: `buy` takes no amount and the contract charges
           * the machine's price, so nothing here can cause an under- or overpayment. This is
           * only about failing early and saying why.
           */
          const granted = (await readContract(config as Config, {
            address: CONTRACTS.usdg,
            abi: ERC20_ABI,
            functionName: "allowance",
            args: [address, CONTRACTS.packSale],
            chainId: robinhoodChain.id,
          })) as bigint;

          if (granted < priceUsdg) {
            setStep({
              kind: "error",
              message:
                `Your wallet approved ${fmtUsdg(granted)} USDG but this pack costs ` +
                `${fmtUsdg(priceUsdg)}. Nothing was charged. Approve the full amount and try again.`,
            });
            return null;
          }
        }

        setStep({ kind: "buying" });
        const buyHash = await writeContract(config as Config, {
          address: CONTRACTS.packSale,
          abi: PACK_SALE_ABI,
          functionName: "buy",
          args: [machineId],
          chainId: robinhoodChain.id,
        });
        setStep({ kind: "buying", hash: buyHash });

        const receipt = await waitForTransactionReceipt(config, {
          hash: buyHash,
          chainId: robinhoodChain.id,
        });

        /**
         * A revert resolves here rather than throwing, with `status: "reverted"`.
         *
         * Unchecked, a reverted buy produced a receipt with no OrderCreated log, which fell
         * into the "couldn't read the order id" branch below and told the buyer their
         * "payment is safe and will be fulfilled or auto-refunded". Every clause of that was
         * false: nothing was charged and no order exists to fulfil or refund. Someone would
         * then sit waiting for a pack that was never bought.
         *
         * The likeliest cause is a cap: two buyers racing the last global slot, the daily cap
         * tipping over mid-flight, or this buyer's own per-buyer limit. wagmi does not
         * simulate before sending, so the transaction goes out and reverts on inclusion.
         */
        if (receipt.status === "reverted") {
          setStep({
            kind: "error",
            message: `${humanError(
              new Error("reverted"),
              "The purchase was rejected on chain.",
            )} Nothing was charged. Try again in a moment.`,
          });
          return null;
        }

        // buy() returns orderId, but a return value isn't readable from a receipt — the
        // event is the only observable source.
        const logs = parseEventLogs({ abi: PACK_SALE_ABI, eventName: "OrderCreated", logs: receipt.logs });
        const orderId = logs[0]?.args?.orderId;

        if (orderId === undefined) {
          // The transaction SUCCEEDED but carried no OrderCreated. That should be impossible,
          // so the message stays honest about the money rather than guessing.
          setStep({
            kind: "error",
            message:
              "Your purchase went through, but we couldn't read the order id from the " +
              "transaction. It will be fulfilled or auto-refunded. Check your collection shortly.",
          });
          return null;
        }

        const id = Number(orderId);
        setStep({ kind: "done", orderId: id, hash: buyHash });
        return id;
      } catch (err) {
        // Wallet rejection is a user choice, not a failure worth a scary message.
        if (isUserRejection(err)) {
          setStep({ kind: "error", message: "Cancelled in your wallet." });
          return null;
        }
        /**
         * Route through humanError rather than showing viem's first line.
         *
         * This catch used to print `raw.split("\n")[0]`, which meant every named contract
         * error was unreachable from the buy flow — the one flow where a revert is most
         * likely and the user has the least idea why. A capped-out buyer read
         * `The contract function "buy" reverted.` while a sentence written for exactly their
         * case sat unused in errors.ts.
         */
        setStep({ kind: "error", message: humanError(err, "The purchase did not go through.") });
        return null;
      }
    },
    [address, config],
  );

  return { buy, step, reset };
}
