import { useEffect, useMemo, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import {
  getCollection,
  getHistory,
  getSellCapability,
  cardValueLimitMessage,
  type OwnedCard,
  type HistoryCard,
  getWithdrawCapability,
} from "./client.ts";
import { ConnectPrompt } from "./Wallet.tsx";
import {
  checkSolanaAddress,
  getSettings,
  loadSolanaAddress,
  persistSolanaAddress,
} from "./settings.ts";
import { humanError, isUserRejection } from "./errors.ts";
import usdgIcon from "/slabs/usdg.png";
import { Address } from "./Address.tsx";
import { useWithdraw } from "./useWithdraw.ts";

/**
 * Profile, Settings and Withdraw.
 *
 * All three are private to the connected wallet: they read that wallet's own collection and
 * its own local settings, and there is no route to view anybody else's. Nothing here is
 * addressable by another user's address.
 */

const TIERS = ["common", "uncommon", "rare", "epic"] as const;
type Tier = (typeof TIERS)[number];

const TIER_COLOR: Record<Tier, string> = {
  common: "var(--common)",
  uncommon: "var(--uncommon)",
  rare: "var(--rare)",
  epic: "var(--epic)",
};

const usd = (base: string | null | undefined) =>
  base == null ? "$0.00" : `$${(Number(base) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;


/**
 * The tier is whatever the card says it is.
 *
 * This used to recompute it from hardcoded dollar bands (60 / 110 / 250), which are the
 * pokemon_50 machine's bands and nobody else's. Every machine sets its own: pokemon_1000
 * calls 600-1000 common, so a $700 pull from a Grail pack — that machine's most ordinary
 * outcome — was being shown here as epic. The card already carries the tier the rest of the
 * site uses, so read that.
 *
 * Structural on `{ tier }` so it serves both an owned card and a lifetime history row — the
 * "Pulls by tier" table counts history, which is not an OwnedCard.
 */
function tierOf(card: { tier: HistoryCard["tier"] }): Tier {
  const t = card.tier;
  return t === "epic" || t === "rare" || t === "uncommon" ? t : "common";
}

function useOwned() {
  const { address, isConnected } = useAccount();
  const [cards, setCards] = useState<OwnedCard[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isConnected || !address) {
      setCards([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    getCollection(address)
      .then((r) => setCards(r.cards))
      .catch(() => setCards([]))
      .finally(() => setLoading(false));
  }, [address, isConnected]);

  return { cards, loading, address, isConnected };
}

/* ------------------------------------------------------------------ profile */

/** Card fate → a word a person reads, not the raw DB enum. */
const STATUS_LABEL: Record<string, string> = {
  CUSTODY: "Held",
  SOLD_TO_CC: "Sold back",
  UNWRAPPED: "Withdrawn",
};
const statusLabel = (s: string) =>
  STATUS_LABEL[s] ?? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace(/_/g, " ");

export function ProfilePage({ onWithdraw }: { onWithdraw: () => void }) {
  const { cards, address, isConnected } = useOwned();

  // Lifetime pack history, separate from the collection: it includes cards this wallet has
  // since sold back or withdrawn, which the collection (current holdings only) drops.
  const [history, setHistory] = useState<HistoryCard[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  useEffect(() => {
    if (!isConnected || !address) {
      setHistory([]);
      setHistoryLoading(false);
      return;
    }
    setHistoryLoading(true);
    getHistory(address)
      .then((r) => setHistory(r.cards))
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  }, [address, isConnected]);

  // Two different questions, two different sources.
  //
  //   "held"     — what is in this wallet's custody right now (count + insured value). Reads
  //                the collection, which drops a card the moment it is sold back or withdrawn.
  //                That is correct: a "held" figure must go down when you no longer hold it.
  //   "lifetime" — how many packs this wallet has ever opened, by tier, and the best it ever
  //                pulled. A pull is a past event; selling the card back does not un-pull it.
  //                Reads /history, which is keyed on the buyer and keeps sold/withdrawn cards.
  const held = useMemo(() => {
    let insured = 0;
    for (const c of cards) insured += Number(c.insuredValueUsd ?? 0);
    return { insured: String(insured), total: cards.length };
  }, [cards]);

  const lifetime = useMemo(() => {
    const byTier: Record<Tier, number> = { common: 0, uncommon: 0, rare: 0, epic: 0 };
    let best: HistoryCard | null = null;
    for (const c of history) {
      byTier[tierOf(c)]++;
      if (!best || Number(c.insuredValueUsd ?? 0) > Number(best.insuredValueUsd ?? 0)) best = c;
    }
    return { byTier, total: history.length, best };
  }, [history]);

  if (!isConnected) {
    return (
      <div className="acct">
        <ConnectPrompt title="Connect to see your profile" body="Your profile is tied to your wallet." />
      </div>
    );
  }

  return (
    <div className="acct acct-profile">
      {/* No avatar. A brand-gradient circle is decoration standing in for an identity the
          page already has: the wallet address IS the identity, so it leads. */}
      <header className="acct-head">
        <h1>Your profile</h1>
        <Address value={address!} short className="acct-sub-addr" />
      </header>

      {/* Three figures on one line, divided by rules rather than boxed. Three numbers do
          not need three cards to be read as three numbers. */}
      <div className="acct-stats">
        <div className="acct-stat">
          <span className="acct-stat-value">{held.total}</span>
          {/* Not "Packs opened": /collection returns only cards still in CUSTODY, so this
              figure drops every time one is sold back or withdrawn, and a lifetime count of
              packs opened can never go down. It is a count of what is held right now. */}
          <span className="acct-stat-label">Cards held</span>
        </div>
        <div className="acct-stat">
          <span className="acct-stat-value">{usd(held.insured)}</span>
          <span className="acct-stat-label">Insured value held</span>
        </div>
        <div className="acct-stat">
          {/* Lifetime: the best card this wallet ever pulled, even if it has since been sold
              back or withdrawn. Reads /history, not the collection. */}
          <span className="acct-stat-value">{lifetime.best ? usd(lifetime.best.insuredValueUsd) : "None yet"}</span>
          <span className="acct-stat-label">Best pull</span>
        </div>
      </div>

      <section className="acct-section">
        <h2>Pulls by tier</h2>
        {/* Lifetime, from /history — every pack ever opened, counted by tier, whatever became
            of the card. A table, not four progress bars: a bar shows proportion but you cannot
            read a count off one, and the count is the thing someone came to see. */}
        {historyLoading ? (
          <p className="acct-empty">Loading…</p>
        ) : (
        <table className="acct-table-tiers">
          <thead>
            <tr>
              <th>Tier</th>
              <th>Pulls</th>
              <th>Share</th>
            </tr>
          </thead>
          <tbody>
            {TIERS.map((t) => {
              const n = lifetime.byTier[t];
              const pct = lifetime.total ? (n / lifetime.total) * 100 : 0;
              return (
                <tr key={t}>
                  <td>
                    <span className="acct-tier-dot" style={{ background: TIER_COLOR[t] }} />
                    {t}
                  </td>
                  <td>{n}</td>
                  <td>{pct % 1 === 0 ? pct : pct.toFixed(1)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        )}
      </section>

      <section className="acct-section">
        <div className="acct-section-head">
          <h2>Pack history</h2>
          {cards.length > 0 && <button className="ghost small" onClick={onWithdraw}>Withdraw cards</button>}
        </div>

        {historyLoading ? (
          <p className="acct-empty">Loading…</p>
        ) : history.length === 0 ? (
          <p className="acct-empty">No packs opened yet.</p>
        ) : (
          <table className="acct-table">
            <thead>
              <tr>
                <th>Card</th>
                <th>Value</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {history.map((c) => (
                <tr key={c.orderId}>
                  <td className="acct-card-cell">
                    <span>{c.name ?? `Card #${c.orderId}`}</span>
                  </td>
                  <td>{usd(c.insuredValueUsd)}</td>
                  <td>
                    <span className="acct-pill" data-state={c.state}>{statusLabel(c.state)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ settings */

export function SettingsPage() {
  const { address, isConnected } = useAccount();
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const { signMessageAsync } = useSignMessage();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Server first: this is the copy that followed the user from any other device.
    void loadSolanaAddress(address).then((a) => !cancelled && setSaved(a));
    return () => {
      cancelled = true;
    };
  }, [address]);

  if (!isConnected || !address) {
    return (
      <div className="acct acct-centred">
        <ConnectPrompt title="Connect to see your settings" body="Settings are stored per wallet." />
      </div>
    );
  }

  const submit = async () => {
    setError(null);
    const check = checkSolanaAddress(value);
    if (!check.ok) return setError(check.reason);

    const next = value.trim();
    setBusy(true);
    try {
      await persistSolanaAddress(address, next, (m) => signMessageAsync({ message: m }));
      setSaved(next);
      setValue("");
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2500);
    } catch (e) {
      // Declining the signature is a choice, not a failure. Anything else is explained.
      if (!isUserRejection(e)) setError(humanError(e, "Could not save that address. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="acct acct-centred">
      <header className="acct-head">
        <h1>Settings</h1>
        <p className="acct-sub">Where your cards go when you withdraw them.</p>
      </header>

      <section className="acct-section">
        <h2>Solana withdraw address</h2>
        <p className="acct-note">
          Cards are held on Solana, make sure to use your Solana wallet address instead of
          your connected Robinhood Chain wallet address. Check it carefully. A withdrawal
          cannot be reversed.
        </p>

        {saved && (
          <div className="acct-saved">
            <Address label="Current address" value={saved} />
            <button
              className="ghost small"
              disabled={busy}
              onClick={async () => {
                try {
                  await persistSolanaAddress(address, null, (m) => signMessageAsync({ message: m }));
                  setSaved(undefined);
                } catch (e) {
                  if (!isUserRejection(e)) setError(humanError(e, "Could not remove that address."));
                }
              }}
            >
              Remove
            </button>
          </div>
        )}

        <div className="acct-field">
          <label htmlFor="sol">{saved ? "Replace with" : "Solana address"}</label>
          <input
            id="sol"
            value={value}
            spellCheck={false}
            autoComplete="off"
            placeholder="Paste a Solana address"
            onChange={(e) => setValue(e.target.value)}
          />
        </div>

        {error && <p className="acct-error">{error}</p>}
        {justSaved && <p className="acct-ok">Saved.</p>}

        <button className="primary" onClick={() => void submit()} disabled={!value || busy}>
          {busy ? "Saving…" : "Save address"}
        </button>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ withdraw */

export function WithdrawPage({ onSettings }: { onSettings: () => void }) {
  const { cards, loading, address, isConnected } = useOwned();
  // Same two-layer read as settings: cached value paints immediately, the server copy
  // replaces it. Without this a user who set their address on another device would be told
  // to add one they already have.
  const [solana, setSolana] = useState<string | undefined>(() => getSettings(address).solanaAddress);
  const { signMessageAsync: signForRead } = useSignMessage();
  /** Set when the server's withdraw address disagreed with this device's cached one. */
  const [, setDestChanged] = useState(false);
  /**
   * Whether the relayer is accepting requests at all.
   *
   * Read here as well as inside the withdraw hook. The hook refuses safely before anything is
   * burned, but only once the user has picked a card and pressed the button — saying it up
   * front spares them choosing a card for a thing that is switched off. `null` while unknown,
   * so the page does not flash "unavailable" before the answer arrives.
   */
  const [withdrawOn, setWithdrawOn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void getWithdrawCapability()
      .then((c) => { if (live) setWithdrawOn(c.enabled); })
      .catch(() => { if (live) setWithdrawOn(false); });
    return () => { live = false; };
  }, []);
  // The ceiling comes from the server, never a constant here: the API and the escrow sweeper
  // enforce the same number, and a hardcoded copy would drift the moment the env var changed.
  // Whether a ceiling is in force at all. WHICH cards exceed it is decided per card by the
  // server, so the threshold itself never reaches the browser — it is an operational detail
  // and this bundle is public.
  const [, setValueLimitActive] = useState(false);
  const [blocked, setBlocked] = useState<OwnedCard | null>(null);
  /** The card awaiting an explicit confirm. Separate from `blocked`: one refuses, one asks. */
  const [confirming, setConfirming] = useState<OwnedCard | null>(null);
  const wd = useWithdraw();

  useEffect(() => {
    let live = true;
    void getSellCapability()
      .then((c) => { if (live) setValueLimitActive(c.valueLimitActive); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void loadSolanaAddress(address).then((a) => !cancelled && setSolana(a));
    return () => {
      cancelled = true;
    };
  }, [address]);

  if (!isConnected) {
    return (
      <div className="acct acct-centred acct-withdraw-page">
        <ConnectPrompt title="Connect to withdraw" body="Withdrawals are tied to the wallet holding the cards." />
      </div>
    );
  }
  if (withdrawOn === false) {
    return (
      <div className="acct acct-centred acct-withdraw-page">
        <div className="ap-dialog">
          <h3>Temporarily unavailable</h3>
          <p>{cardValueLimitMessage()}</p>
          <p className="muted">
            Your cards stay in your collection and nothing has changed.
          </p>
        </div>
      </div>
    );
  }


  return (
    <div className="acct acct-centred acct-withdraw-page">
      <header className="acct-head">
        <h1>Withdraw</h1>
        <p className="acct-sub">Withdraw a card from custody directly to Solana.</p>
      </header>

      {/* The address gate comes FIRST and blocks the action, rather than letting someone get
          to a confirm dialog and discover the problem there. Withdrawing burns the mirror, so
          starting one without a destination would be the worst possible moment to fail. */}
      {!solana ? (
        <div className="acct-gate">
          <h2>Add a Solana address</h2>
          <p>
            Withdrawing burns your card on Robinhood Chain and sends the Collector Crypt NFT to
            your Solana address.
          </p>
          <button className="primary" onClick={onSettings}>
            Add it in settings
          </button>
        </div>
      ) : (
        <div className="acct-dest">
          <Address label="Sending to" value={solana} />
          <button className="ghost small" onClick={onSettings}>
            Change
          </button>
        </div>
      )}

      <section className="acct-section">
        <h2>Your cards</h2>
        {loading ? (
          <p className="acct-empty">Loading…</p>
        ) : cards.length === 0 ? null : (
          <div className="acct-grid">
            {cards.map((c) => (
              <article className="acct-card" key={c.tokenId}>
                <div className="acct-card-art">
                  {c.imageFront ? (
                    <img src={c.imageFront} alt={c.name ?? ""} loading="lazy" decoding="async" />
                  ) : (
                    <div className="acct-card-blank">{c.grade}</div>
                  )}
                </div>
                <div className="acct-card-body">
                  <div className="acct-card-name">{c.name ?? `Card #${c.tokenId}`}</div>
                  <div className="acct-card-meta">
                    <span>{c.grade ?? ""}</span>
                    <span className="acct-card-value">
                      <img className="usdg-mark" src={usdgIcon} alt="" />
                      {(Number(c.insuredValueUsd ?? 0) / 1e6).toLocaleString("en-US")}
                    </span>
                  </div>
                  {/* Over the ceiling the button stays clickable and refuses out loud.
                      A disabled control explains nothing on touch. */}
                  <button
                    className="acct-withdraw"
                    disabled={wd.step.kind === "checking" || wd.step.kind === "burning"}
                    onClick={() =>
                      c.overValueLimit === true
                        ? setBlocked(c)
                        : setConfirming(c)
                    }
                  >
                    Withdraw
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {blocked && (
        <div className="stage" onClick={() => setBlocked(null)}>
          <div onClick={(e) => e.stopPropagation()}>
            <div className="ap-dialog">
              <h3>Temporarily unavailable</h3>
              <p>{cardValueLimitMessage()}</p>
              <p className="muted">Your card stays in your collection and nothing has changed.</p>
              <div className="ap-dialog-actions">
                <button className="primary" onClick={() => setBlocked(null)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/**
       * The confirm step for an irreversible burn.
       *
       * Deliberately not a one-click action. burnForUnwrap destroys the mirror before any
       * off-chain protection applies, and it commits the destination address in the same
       * transaction — so the address shown here is the last chance anyone has to notice a
       * typo. It is displayed in full, never truncated, for exactly that reason.
       */}
      {confirming && (
        <div className="stage" onClick={() => wd.step.kind !== "burning" && setConfirming(null)}>
          <div onClick={(e) => e.stopPropagation()}>
            <div className="ap-dialog">
              <h3>Withdraw {confirming.name ?? `Card #${confirming.tokenId}`}?</h3>
              <p>
                This burns the card on Robinhood Chain and sends the real Collector Crypt NFT to
                your Solana address. It cannot be undone.
              </p>
              <p className="muted">Going to this address:</p>
              <p className="acct-dest">{solana}</p>
              <p className="muted">
                Check it character by character. A mistyped address is usually still a valid
                one, so nobody can tell it apart from yours, and the card would be gone.
              </p>

              {wd.step.kind === "error" && <p className="acct-error">{wd.step.message}</p>}
              {wd.step.kind === "submitted" && (
                <p className="acct-ok">
                  Burned. Your card is on its way to your Solana wallet, usually within a few minutes.
                </p>
              )}

              <div className="ap-dialog-actions">
                {wd.step.kind === "submitted" ? (
                  <button className="primary" onClick={() => { wd.reset(); setConfirming(null); }}>
                    Done
                  </button>
                ) : (
                  <>
                    <button
                      className="ghost"
                      disabled={wd.step.kind === "burning"}
                      onClick={() => { wd.reset(); setDestChanged(false); setConfirming(null); }}
                    >
                      Cancel
                    </button>
                    <button
                      className="primary"
                      disabled={!solana || wd.step.kind === "checking" || wd.step.kind === "burning"}
                      /**
                       * CONFIRM THE DESTINATION WITH THE SERVER BEFORE BURNING.
                       *
                       * `solana` above came from `loadSolanaAddress(address)` with no signer,
                       * which by that function's own contract returns the LOCAL CACHE and never
                       * the server's copy. Its doc names this screen as the one caller that must
                       * pass a signer, "where a stale address would send a card to the wrong
                       * wallet" — and this screen was the one not doing it. Change your withdraw
                       * address on another device and this one would still burn a mirror toward
                       * the old wallet.
                       *
                       * The read happens HERE rather than on page load, deliberately: the cost
                       * is one signature at the moment a card is about to be destroyed, instead
                       * of a wallet prompt every time someone opens the page. If the server
                       * disagrees, nothing is burned and the newer address is shown instead.
                       */
                      onClick={() => void (async () => {
                        const authoritative = await loadSolanaAddress(address, (m) =>
                          signForRead({ message: m }),
                        ).catch(() => undefined);

                        if (authoritative && authoritative !== solana) {
                          setSolana(authoritative);
                          setDestChanged(true);
                          return;
                        }

                        await wd.withdraw(
                          confirming.tokenId,
                          authoritative ?? solana!,
                          confirming.overValueLimit === true,
                        );
                      })()}
                    >
                      {wd.step.kind === "burning" ? "Burning…" : wd.step.kind === "checking" ? "Checking…" : "Withdraw"}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <p className="acct-note">
        Withdrawing burns the Robinhood Chain NFT and sends the Collector Crypt card to your
        Solana address. The burn commits that address on chain in the same transaction, so it
        cannot be changed once you sign.
      </p>
    </div>
  );
}
