import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { ConnectPrompt } from "./Wallet.tsx";
import { Address } from "./Address.tsx";
import {
  getDepositCards,
  getDepositTransfer,
  claimDeposit,
  type DepositCard,
  getPendingDeposits,
} from "./client.ts";
import {
  connectSolana,
  detectSolanaWallets,
  hasSolanaWallet,
  sendDepositTransfer,
  signDepositClaim,
  type SolanaWalletKey,
} from "./solana.ts";

/**
 * Depositing a card: send a Collector Crypt card into the vault, receive its mirror.
 *
 * This is the sell-back run backwards, and the user is holding two wallets at once — a Solana
 * one that owns the card and a Robinhood one that will hold the mirror. The page never
 * conflates them: the destination for the mirror is always the connected EVM address, shown
 * before anything is signed, because a mirror minted to the wrong chain's address is gone.
 *
 * Two things are deliberately visible rather than hidden. The VAULT ADDRESS, so it can be
 * compared against what the wallet previews before approving — the transfer is built by our
 * API, and a user should be able to check it rather than trust it. And the fact that the card
 * moves FIRST: the mirror is minted only after the chain shows the card has arrived, because a
 * claim is a statement and ownership is a fact.
 */

type Step =
  | { kind: "idle" }
  | { kind: "transferring" }
  | { kind: "claiming" }
  | { kind: "done"; tokenId: string | null }
  | { kind: "error"; message: string };

export function DepositPage() {
  const { address, isConnected } = useAccount();
  const [solana, setSolana] = useState<string | null>(null);
  const [cards, setCards] = useState<DepositCard[] | null>(null);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [busyMint, setBusyMint] = useState<string | null>(null);
  /** Cards already sitting in the vault with no mirror: a deposit that stopped half way. */
  const [pending, setPending] = useState<DepositCard[]>([]);
  const [picking, setPicking] = useState(false);

  const loadCards = useCallback(async (owner: string) => {
    try {
      const { cards: c } = await getDepositCards(owner);
      setCards(c);
      // Deposits this wallet started but never finished. Shown separately so an interrupted
      // one is visible and finishable rather than a card silently sitting in our vault.
      if (address) {
        const unfinished = await getPendingDeposits(address);
        setPending(unfinished.map((u) => ({ mint: u.solanaMint, name: null, imageUrl: null })));
      }
    } catch (err) {
      setStep({ kind: "error", message: err instanceof Error ? err.message : "Could not read your cards." });
      setCards([]);
    }
  }, [address]);

  useEffect(() => {
    if (solana) void loadCards(solana);
  }, [solana, loadCards]);

  const connect = async (key?: SolanaWalletKey) => {
    setPicking(false);
    try {
      setSolana(await connectSolana(key));
    } catch (err) {
      setStep({ kind: "error", message: err instanceof Error ? err.message : "Could not connect." });
    }
  };

  /**
   * One wallet installed goes straight through; more than one asks first.
   *
   * A picker listing a single choice is a dialog that exists to be dismissed.
   */
  // Always open the picker so the user chooses which wallet, rather than the code silently
  // connecting whichever one grabbed window.solana (usually Phantom). The button only shows
  // when at least one wallet is present, so the picker always has something to list.
  const startConnect = () => setPicking(true);

  /**
   * Transfer, then claim. In that order, always.
   *
   * The claim is signed AFTER the transfer lands so the signature covers a deposit that has
   * actually happened. Signing first would produce a valid claim for a card still sitting in
   * the user's wallet, which the API would reject anyway — but only after they had signed
   * something that reads like a promise we would honour.
   */
  const deposit = async (card: DepositCard, alreadySent = false) => {
    if (!address || !solana) return;
    setBusyMint(card.mint);
    try {
      /**
       * A deposit interrupted AFTER the transfer must be resumable.
       *
       * The card is already in the vault at that point, so re-running the transfer would fail
       * — the user no longer owns it — and without a way to resume, their card sits with us
       * and they hold nothing. That happened on the very first real deposit, where the claim
       * was refused by a bug and the transfer had already landed.
       *
       * So the transfer is skipped when the card is already ours, and only the claim runs.
       */
      let solanaTx: string | null = null;
      if (!alreadySent) {
        setStep({ kind: "transferring" });
        const { transaction } = await getDepositTransfer(card.mint, solana);
        solanaTx = await sendDepositTransfer(transaction);
      }

      setStep({ kind: "claiming" });
      const nonce = Date.now();
      const { signature, signer } = await signDepositClaim(card.mint, address, nonce);
      const res = await claimDeposit({
        solanaMint: card.mint,
        evmAddress: address,
        signer,
        signature,
        nonce,
        solanaTx,
      });

      if (res.status === "REJECTED") {
        setStep({ kind: "error", message: res.error ?? "That deposit was refused." });
      } else {
        setStep({ kind: "done", tokenId: res.mirrorTokenId });
        void loadCards(solana);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A rejected wallet prompt is a normal outcome, not a failure worth alarming anyone about.
      setStep(
        /user rejected|denied|cancelled/i.test(message)
          ? { kind: "idle" }
          : { kind: "error", message },
      );
    } finally {
      setBusyMint(null);
    }
  };

  if (!isConnected) {
    return (
      <div className="acct acct-centred">
        <ConnectPrompt
          title="Connect to deposit"
          body="Your mirror is minted to your Robinhood Chain wallet, so you'll need one connected first."
        />
      </div>
    );
  }

  return (
    <div className="dep">
      {picking && (
        /*
         * Escape and the backdrop both close it, and the panel stops click propagation, so
         * dismissing never depends on hitting one small button.
         */
        <div
          className="dep-picker-back"
          role="dialog"
          aria-modal="true"
          aria-label="Choose a Solana wallet"
          onClick={() => setPicking(false)}
          onKeyDown={(e) => e.key === "Escape" && setPicking(false)}
        >
          <div className="dep-picker" onClick={(e) => e.stopPropagation()}>
            <h2>Choose a wallet</h2>
            <p>Pick the Solana wallet holding the cards you want to deposit.</p>
            <ul>
              {detectSolanaWallets().map((w) => (
                <li key={w.key}>
                  <button type="button" onClick={() => void connect(w.key)}>
                    <span className="dep-picker-wallet">
                      {/* The letter is the wallet's brand colour on a light tint of it, not
                          white-on-solid. White-on-solid goes invisible the instant the
                          background does not paint (a stale chunk, an override) — which is the
                          "Trust has a blank badge" report. This can't: a dark-ish letter on a
                          light fill stays legible on the cream picker no matter what. */}
                      <span
                        className="dep-picker-icon"
                        style={{
                          background: `color-mix(in srgb, ${w.color} 16%, #fff)`,
                          color: w.color,
                          borderColor: `color-mix(in srgb, ${w.color} 32%, #fff)`,
                        }}
                        aria-hidden="true"
                      >
                        {w.name.charAt(0)}
                      </span>
                      {w.name}
                    </span>
                    <span aria-hidden="true">→</span>
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="dep-picker-cancel" onClick={() => setPicking(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <header className="dep-head">
        <h1>Deposit a card</h1>
        <p className="dep-lead">
          Send a Collector Crypt card into the vault and receive it on Robinhood Chain. The NFT
          on Robinhood is minted only once the card has arrived.
        </p>
      </header>

      {!solana ? (
        <div className="dep-connect">
          {hasSolanaWallet() ? (
            <>
              <p>Connect the Solana wallet that holds your cards</p>
              <button className="dep-connect-btn" onClick={startConnect}>
                Connect wallet
              </button>
            </>
          ) : (
            <>
              <p>
                No Solana wallet found in this browser. Phantom, Solflare and Backpack all work.
              </p>
              <a className="primary" href="https://phantom.app/download" target="_blank" rel="noreferrer">
                Get Phantom
              </a>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="dep-wallets">
            {/* Only the user's OWN wallet is named. The vault address is no longer displayed;
                the destination is still visible where it matters, in the wallet's own
                confirmation prompt, which is the copy a user should be checking anyway. */}
            <Address label="From" value={solana} />
          </div>

          {pending.length > 0 && (
            <div className="dep-pending">
              <p>
                {pending.length === 1 ? "A card of yours is" : "Cards of yours are"} already in the
                vault without a mirror — a deposit that stopped part way. Finish it:
              </p>
              {pending.map((c) => (
                <div className="dep-pending-row" key={c.mint}>
                  <span>{c.name ?? c.mint.slice(0, 12) + "…"}</span>
                  <button
                    className="primary"
                    disabled={busyMint !== null}
                    onClick={() => void deposit(c, true)}
                  >
                    {busyMint === c.mint ? "Minting…" : "Finish deposit"}
                  </button>
                </div>
              ))}
            </div>
          )}

          {cards === null && <p className="dep-note">Reading your cards…</p>}
          {cards?.length === 0 && (
            <p className="dep-note">
              No Collector Crypt cards in that wallet. Only cards from Collector Crypt's vault can
              be deposited.
            </p>
          )}

          {cards && cards.length > 0 && (
            <div className="dep-grid">
              {cards.map((c) => (
                <article className="dep-card" key={c.mint}>
                  <div className="dep-card-art">
                    {c.imageUrl ? <img src={c.imageUrl} alt={c.name ?? "card"} decoding="async" /> : null}
                  </div>
                  <div className="dep-card-name">{c.name ?? "Card"}</div>
                  <button
                    className="primary"
                    disabled={busyMint !== null}
                    onClick={() => void deposit(c)}
                  >
                    {busyMint === c.mint
                      ? step.kind === "transferring"
                        ? "Sending…"
                        : "Minting…"
                      : "Deposit"}
                  </button>
                </article>
              ))}
            </div>
          )}
        </>
      )}

      {step.kind === "done" && (
        <p className="dep-ok">
          Deposited. {step.tokenId ? `Mirror #${step.tokenId} is in your wallet.` : "Your mirror is on its way."}
        </p>
      )}
      {step.kind === "error" && <p className="dep-error">{step.message}</p>}
    </div>
  );
}
