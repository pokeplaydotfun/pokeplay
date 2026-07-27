import { useCallback, useEffect, useState } from "react";
import { useAccount, useConfig, type Config } from "wagmi";
import { readContract, writeContract, waitForTransactionReceipt } from "wagmi/actions";
import { CONTRACTS, robinhoodChain, explorerUrl } from "./chain.ts";
import { MIRROR_NFT_ABI, MARKETPLACE_ABI } from "./abis.ts";
import { ConnectPrompt } from "./Wallet.tsx";
import { getCollection, getSellCapability, type OwnedCard } from "./client.ts";
import { displayCardName } from "./cardName.ts";
import { checkRecipient } from "./transfer-guard.ts";

/**
 * Sending a card to someone else.
 *
 * The mirror is an ordinary ERC-721, so this is one `safeTransferFrom` signed by the owner —
 * no backend, no custody change, nothing of ours in the middle. What the card carries travels
 * with it: sell-back is keyed on the CARD and authenticated by whoever hands the mirror to
 * escrow, so a card with time left on its window arrives at the new owner still sellable, and
 * the value ceiling applies to them exactly as it did before.
 *
 * IRREVERSIBLE, and that shapes the whole page. There is no undo, no support ticket and no
 * clawback: a card sent to the wrong address is simply gone. So every check that can be made
 * before the signature is made before it, and the destination is shown back in full for the
 * user to read rather than a truncated form they cannot verify.
 */

type Step =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "done"; to: string; hash: string; card: string }
  | { kind: "error"; message: string };

export function TransferPage() {
  const { address, isConnected } = useAccount();
  const config = useConfig();
  const [cards, setCards] = useState<OwnedCard[] | null>(null);
  const [escrow, setEscrow] = useState<string | null>(null);
  const [picked, setPicked] = useState<OwnedCard | null>(null);
  const [to, setTo] = useState("");
  const [step, setStep] = useState<Step>({ kind: "idle" });

  const load = useCallback(async () => {
    if (!address) return;
    try {
      const { cards: c } = await getCollection(address);
      setCards(c);
    } catch {
      setCards([]);
    }
  }, [address]);

  useEffect(() => {
    void load();
    void getSellCapability().then((s) => setEscrow(s.escrowAddress));
  }, [load]);

  const verdict = checkRecipient(to, address, escrow);

  const send = async () => {
    if (!picked || !address || !CONTRACTS.mirror || !verdict.ok) return;
    setStep({ kind: "sending" });
    try {
      /**
       * A LISTED card must be delisted first, for the same reason a sell-back refuses one:
       * listing does not escrow anything, so this transfer succeeds while the listing stands —
       * leaving an advertised card the seller no longer owns, which reverts for any buyer who
       * tries it. Checked here, immediately before signing, because a check at page load can
       * be minutes stale.
       */
      if (CONTRACTS.marketplace) {
        const listing = (await readContract(config as Config, {
          address: CONTRACTS.marketplace,
          abi: MARKETPLACE_ABI,
          functionName: "getListing",
          args: [BigInt(picked.tokenId)],
          chainId: robinhoodChain.id,
        })) as { seller: string };
        if (listing?.seller && listing.seller !== "0x0000000000000000000000000000000000000000") {
          setStep({
            kind: "error",
            message:
              "That card is listed on the marketplace. Delist it first, or the listing would " +
              "advertise a card you no longer own.",
          });
          return;
        }
      }

      // Ownership from the chain, not from the list, which can be seconds stale.
      const owner = (await readContract(config as Config, {
        address: CONTRACTS.mirror,
        abi: MIRROR_NFT_ABI,
        functionName: "ownerOf",
        args: [BigInt(picked.tokenId)],
        chainId: robinhoodChain.id,
      })) as string;
      if (owner.toLowerCase() !== address.toLowerCase()) {
        setStep({ kind: "error", message: "That card is no longer in your wallet." });
        return;
      }

      const hash = await writeContract(config as Config, {
        address: CONTRACTS.mirror,
        abi: MIRROR_NFT_ABI,
        functionName: "safeTransferFrom",
        args: [address, to.trim() as `0x${string}`, BigInt(picked.tokenId)],
        chainId: robinhoodChain.id,
      });

      // A revert resolves here rather than throwing. Unchecked, a failed transfer would report
      // success and the sender would believe a card had moved that never did.
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: robinhoodChain.id });
      if (receipt.status === "reverted") {
        setStep({
          kind: "error",
          message:
            "The transfer was rejected on chain, so the card is still yours. This usually means " +
            "the recipient is a contract that cannot receive NFTs.",
        });
        return;
      }

      // The card name is captured BEFORE clearing the selection: the confirmation should say
      // what was sent, and `picked` is about to be null.
      setStep({
        kind: "done",
        to: to.trim(),
        hash,
        card: displayCardName(picked.name) || `Card #${picked.tokenId}`,
      });
      setPicked(null);
      setTo("");
      void load();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/user rejected|denied transaction/i.test(message)) return setStep({ kind: "idle" });

      /**
       * SAY WHAT WENT WRONG. This used to report only "the transfer did not go through", which
       * is reassuring and useless — it hid a real bug where the collection listed a burned
       * mirror, so `ownerOf` reverted and the user had no way to know why.
       *
       * The reassurance is kept, because it is true and it is the first thing someone wants to
       * know, but the cause is no longer swallowed with it.
       */
      const cause =
        /nonexistent token|ERC721NonexistentToken|owner query for nonexistent/i.test(message)
          ? "that card no longer exists on chain — it was burned, so refresh and try again"
          : /insufficient funds/i.test(message)
            ? "your wallet does not have enough ETH for gas"
            : /chain|network/i.test(message)
              ? "your wallet is on the wrong network — switch to Robinhood Chain"
              : message.split("\n")[0]?.slice(0, 160);

      setStep({
        kind: "error",
        message: `The transfer did not go through and the card is still yours. ${cause ? `Reason: ${cause}` : ""}`,
      });
    }
  };

  if (!isConnected) {
    return (
      <div className="acct acct-centred">
        <ConnectPrompt title="Connect to transfer" body="Transfers are signed by the wallet holding the card." />
      </div>
    );
  }

  return (
    <div className="dep">
      <header className="dep-head">
        <h1>Transfer a card</h1>
        <p className="dep-lead">
          Send a card to another Robinhood Chain wallet.
        </p>
      </header>

      {cards === null && <p className="dep-note">Reading your collection…</p>}
      {cards?.length === 0 && <p className="dep-note">No cards to transfer.</p>}

      {cards && cards.length > 0 && (
        <div className="dep-grid">
          {cards.map((c) => (
            <article
              className="dep-card"
              key={c.tokenId}
              data-picked={picked?.tokenId === c.tokenId}
            >
              <div className="dep-card-art">
                {c.imageFront ? <img src={c.imageFront} alt={c.name ?? "card"} decoding="async" /> : null}
              </div>
              <div className="dep-card-name">{displayCardName(c.name) || `Card #${c.tokenId}`}</div>
              <button
                className={picked?.tokenId === c.tokenId ? "primary" : "ghost"}
                disabled={step.kind === "sending"}
                onClick={() => {
                  setPicked(picked?.tokenId === c.tokenId ? null : c);
                  setStep({ kind: "idle" });
                }}
              >
                {picked?.tokenId === c.tokenId ? "Selected" : "Select"}
              </button>
            </article>
          ))}
        </div>
      )}

      {picked && (
        <div className="tr-form">
          <label htmlFor="tr-to">
            Send <b>{displayCardName(picked.name) || `card #${picked.tokenId}`}</b> to
          </label>
          <input
            id="tr-to"
            value={to}
            spellCheck={false}
            autoComplete="off"
            placeholder="0x…"
            onChange={(e) => {
              setTo(e.target.value);
              if (step.kind === "error") setStep({ kind: "idle" });
            }}
          />

          {/* Shown in full, not truncated: an address the sender cannot read is an address they
              cannot check, and there is no undo on this. */}
          {to.trim() && !verdict.ok && <p className="tr-warn">{verdict.reason}</p>}

          <p className="tr-note">
            This cannot be undone. The card moves immediately and only the new owner can move it
            again.
          </p>

          <button
            className="primary"
            disabled={!verdict.ok || step.kind === "sending"}
            onClick={() => void send()}
          >
            {step.kind === "sending" ? "Sending…" : "Transfer card"}
          </button>
        </div>
      )}

      {/**
        * The receipt. Shown after the transaction has CONFIRMED, not after it was submitted —
        * `send` waits for the receipt and checks it did not revert before reaching here, so
        * "Confirmed" is a statement about the chain rather than about our optimism.
        *
        * The explorer link matters more than it looks: this is the one irreversible action a
        * user takes on their own card, and being able to go and see it for themselves is the
        * difference between trusting us and checking.
        */}
      {step.kind === "done" && (
        <div className="tr-done">
          <div className="tr-done-head">
            <span className="tr-done-tick" aria-hidden="true">✓</span>
            <strong>Transfer confirmed</strong>
          </div>
          <p className="tr-done-line">
            <b>{step.card}</b> is now owned by
          </p>
          <code className="tr-done-addr">{step.to}</code>
          <a
            className="tr-done-link"
            href={explorerUrl(`tx/${step.hash}`)}
            target="_blank"
            rel="noreferrer"
          >
            View transaction
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M8 16L16 8M9.5 8H16v6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        </div>
      )}
      {step.kind === "error" && <p className="dep-error">{step.message}</p>}
    </div>
  );
}
