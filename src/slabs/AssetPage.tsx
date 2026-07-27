import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useAccount, useConfig, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { getAsset, invalidateBook, type AssetOffer, type CardDetail, type Listing } from "./client.ts";
import { CONTRACTS, CAN_TRADE, explorerUrl } from "./chain.ts";
import { MARKETPLACE_ABI, MIRROR_NFT_ABI, ERC20_ABI } from "./abis.ts";
import { ConnectPrompt } from "./Wallet.tsx";
import { humanError, isUserRejection } from "./errors.ts";
import usdgIcon from "/slabs/usdg.png";
import { Address } from "./Address.tsx";

/**
 * One card's page, following Collector Crypt's asset layout: faces on the left with a
 * thumbnail rail, identity and actions on the right, then More Details and Offers.
 *
 * Every write goes through the Marketplace contract. Both the listing and the offer flows
 * are permission-based, so each one is a two-step: grant the approval or allowance, then
 * record the intent. The UI shows which step it is on rather than firing two wallet popups
 * with no explanation.
 */

const usd = (base: string) =>
  `$${(Number(base) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const usdgAmount = (base: string) =>
  (Number(base) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });


const when = (t: number) => {
  const mins = Math.max(1, Math.round((Date.now() - t) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
};

/** USDG has 6 decimals. Parsed by hand so a stray float never reaches a uint96. */
function toBaseUnits(input: string): bigint | null {
  const s = input.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > 6) return null;
  return BigInt(whole || "0") * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
}

/* value takes a node, not just a string, so a row can hold a copyable <Address> rather
   than a dead string of characters. */
function Row({ label, value }: { label: string; value: ReactNode }) {
  if (!value) return null;
  return (
    <div className="cd-row">
      <span className="cd-row-label">{label}</span>
      <span className="cd-row-value">{value}</span>
    </div>
  );
}

function Panel({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="ap-panel" data-open={open}>
      <button className="ap-panel-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span>{title}</span>
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 9.5l6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && <div className="ap-panel-body">{children}</div>}
    </section>
  );
}

/* ------------------------------------------------------------------ trading */

type Step = { kind: "idle" } | { kind: "approving" } | { kind: "sending"; label: string } | { kind: "error"; message: string };

function useTrade(tokenId: string, onDone: () => void) {
  const { address } = useAccount();
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const { writeContractAsync } = useWriteContract();
  const wagmi = useConfig();
  const [hash, setHash] = useState<`0x${string}` | undefined>();
  const receipt = useWaitForTransactionReceipt({ hash });

  /**
   * `isSuccess` means the RECEIPT was fetched, NOT that the transaction succeeded.
   *
   * A reverted transaction still produces a receipt, so this reported success for every
   * failed write on this page — list, buy, cancel, updatePrice, makeOffer, withdrawOffer and
   * acceptOffer alike. It cleared the step, closed the dialog and reloaded, which reads as
   * "done". The dangerous one is acceptOffer: a seller would be told their card had sold
   * while it was still in their wallet and no payment had moved.
   *
   * `receipt.data.status` is the transaction's own outcome, and it is the thing to branch on.
   */
  useEffect(() => {
    if (!receipt.isSuccess || !receipt.data) return;

    if (receipt.data.status === "reverted") {
      setStep({
        kind: "error",
        message:
          "That transaction was rejected on chain, so nothing changed. This usually means the " +
          "card or the offer moved while it was going through. Refresh and try again.",
      });
      setHash(undefined);
      // Reload anyway: whatever raced us is the state the page should now show.
      invalidateBook();
      onDone();
      return;
    }

    setStep({ kind: "idle" });
    setHash(undefined);
    /**
     * Drop the cached book BEFORE reloading, not after.
     *
     * onDone() re-reads the asset, and that read goes through the same 20s book cache this
     * write just invalidated. Without this the page reloaded straight out of stale cache and
     * showed the card as still listed after a successful delist — the transaction had landed,
     * the UI disagreed, and only a hard refresh fixed it.
     */
    invalidateBook();
    onDone();
  }, [receipt.isSuccess, receipt.data, onDone]);

  const id = BigInt(tokenId);
  const market = CONTRACTS.marketplace!;
  const mirror = CONTRACTS.mirror!;
  const usdgAddr = CONTRACTS.usdg;

  // Read once per action rather than subscribing: these only matter at the moment of a
  // write, and a stale subscription would let a revoked approval look current.
  const { refetch: readNftApproval } = useReadContract({
    address: mirror,
    abi: MIRROR_NFT_ABI,
    functionName: "isApprovedForAll",
    args: address ? [address, market] : undefined,
    query: { enabled: false },
  });

  const { refetch: readAllowance } = useReadContract({
    address: usdgAddr,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, market] : undefined,
    query: { enabled: false },
  });

  const run = async (label: string, fn: () => Promise<`0x${string}`>) => {
    try {
      setStep({ kind: "sending", label });
      setHash(await fn());
    } catch (e) {
      // Cancelling is a normal outcome, not an error worth shouting about. Everything else
      // is translated: a raw revert selector tells the user nothing they can act on.
      setStep(isUserRejection(e) ? { kind: "idle" } : { kind: "error", message: humanError(e, "That transaction did not go through.") });
    }
  };

  /** The card must be movable by the contract before a listing or an accepted offer. */
  /**
   * Approve the marketplace to move this card, then WAIT for it to land.
   *
   * This used to fire the approval and throw a `__approval_pending__` sentinel, which `guard`
   * caught and silently returned. The user approved, nothing else happened, and nothing told
   * them to press the button again — so a listing looked like it had worked and no `list`
   * transaction was ever sent. That is exactly what happened on the first real listing attempt.
   *
   * The original concern was real: firing both writes back to back strands the second while
   * the first is still pending. Awaiting the receipt solves that properly, at the cost of a
   * few seconds, instead of abandoning the operation half-done.
   */
  const ensureNftApproval = async () => {
    const { data } = await readNftApproval();
    if (data === true) return;
    setStep({ kind: "approving" });
    const h = await writeContractAsync({
      address: mirror,
      abi: MIRROR_NFT_ABI,
      functionName: "setApprovalForAll",
      args: [market, true],
    });
    /**
     * DELIBERATELY NOT `setHash(h)`.
     *
     * `hash` drives the completion effect above, which means "the operation the user asked
     * for has finished": it clears the step, closes the dialog and calls onDone(). Feeding it
     * an APPROVAL made that fire on the approval — so approving showed success and reloaded
     * the page while the offer, listing or accept had not been sent yet. Two ways that bites:
     * the user reads "done" for something that never happened, and in that idle window the
     * button is live again, so an impatient second click sends a duplicate.
     *
     * The approval is awaited inline right below, which is all this step needs.
     */
    const receipt = await waitForTransactionReceipt(wagmi, { hash: h });
    if (receipt.status === "reverted") throw new Error("The approval was rejected on chain.");
  };

  /** Same shape as ensureNftApproval, and it had the same abandon-half-way bug. */
  const ensureAllowance = async (needed: bigint) => {
    const { data } = await readAllowance();
    if (typeof data === "bigint" && data >= needed) return;
    setStep({ kind: "approving" });
    const h = await writeContractAsync({
      address: usdgAddr,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [market, needed],
    });
    // Not setHash(h) — see ensureNftApproval. An approval is not the operation.
    const receipt = await waitForTransactionReceipt(wagmi, { hash: h });
    if (receipt.status === "reverted") throw new Error("The approval was rejected on chain.");
  };

  /**
   * Kept as a seam, but it no longer swallows anything.
   *
   * It used to catch `__approval_pending__` and return silently, which is how a half-finished
   * listing looked like a finished one. Approvals now complete before the operation continues,
   * so there is nothing to absorb.
   */
  const guard = (fn: () => Promise<void>) => async () => fn();

  return {
    step,
    clearError: () => setStep({ kind: "idle" }),
    pending: step.kind !== "idle" && step.kind !== "error",

    buy: (price: bigint) =>
      guard(async () => {
        await ensureAllowance(price);
        await run("Buying", () =>
          writeContractAsync({ address: market, abi: MARKETPLACE_ABI, functionName: "buy", args: [id, price] }),
        );
      })(),

    list: (price: bigint) =>
      guard(async () => {
        await ensureNftApproval();
        await run("Listing", () =>
          writeContractAsync({ address: market, abi: MARKETPLACE_ABI, functionName: "list", args: [id, price] }),
        );
      })(),

    updatePrice: (price: bigint) =>
      run("Updating price", () =>
        writeContractAsync({ address: market, abi: MARKETPLACE_ABI, functionName: "updatePrice", args: [id, price] }),
      ),

    cancel: () =>
      run("Delisting", () =>
        writeContractAsync({ address: market, abi: MARKETPLACE_ABI, functionName: "cancel", args: [id] }),
      ),

    makeOffer: (amount: bigint, expiry: bigint) =>
      guard(async () => {
        await ensureAllowance(amount);
        await run("Placing offer", () =>
          writeContractAsync({
            address: market,
            abi: MARKETPLACE_ABI,
            functionName: "makeOffer",
            args: [id, amount, expiry],
          }),
        );
      })(),

    withdrawOffer: () =>
      run("Withdrawing offer", () =>
        writeContractAsync({ address: market, abi: MARKETPLACE_ABI, functionName: "withdrawOffer", args: [id] }),
      ),

    acceptOffer: (offeror: `0x${string}`, amount: bigint) =>
      guard(async () => {
        await ensureNftApproval();
        await run("Accepting offer", () =>
          writeContractAsync({
            address: market,
            abi: MARKETPLACE_ABI,
            functionName: "acceptOffer",
            args: [id, offeror, amount],
          }),
        );
      })(),
  };
}

/* ------------------------------------------------------------------ page */

export function AssetPage({
  tokenId,
  onBack,
  intent,
  onIntentConsumed,
}: {
  tokenId: string;
  onBack: () => void;
  /** "offer" opens the offer dialog on arrival — set by "Offer now" on a marketplace tile. */
  intent?: "offer";
  onIntentConsumed?: () => void;
}) {
  const { address, isConnected } = useAccount();

  // Same 6dp USDG read the wallet button uses, so the offer dialog can refuse a bid this
  // wallet could not pay. Enabled only when connected — there is nothing to compare against
  // otherwise, and the guard below treats undefined as "do not block".
  const { data: usdgBalance } = useReadContract({
    address: CONTRACTS.usdg,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && CONTRACTS.usdg) },
  });
  const [data, setData] = useState<{ listing: Listing | null; detail: CardDetail | null; offers: AssetOffer[]; owner: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [face, setFace] = useState(0);
  const [dialog, setDialog] = useState<null | "offer" | "list">(null);

  /**
   * Honour an "Offer now" arrival exactly once.
   *
   * Waits for `data` so ownership is known: without that, opening the dialog before ownerOf
   * resolves would offer the owner of a card the chance to bid on themselves, which the
   * contract rejects with CannotOfferOnOwnCard. The intent is reported consumed either way,
   * so a card the user turns out to own simply opens normally instead of silently re-arming.
   */
  const intentDone = useRef(false);
  useEffect(() => {
    if (intent !== "offer" || intentDone.current || !data) return;
    intentDone.current = true;
    const owns = Boolean(address && data.owner && data.owner.toLowerCase() === address.toLowerCase());
    if (!owns) setDialog("offer");
    onIntentConsumed?.();
  }, [intent, data, address, onIntentConsumed]);
  const [amount, setAmount] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    getAsset(tokenId)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [tokenId]);

  useEffect(load, [load]);

  const trade = useTrade(tokenId, () => {
    setDialog(null);
    setAmount("");
    load();
  });

  if (loading) return <div className="ap-loading">Loading card…</div>;
  if (!data) {
    return (
      <div className="ap-missing">
        <h2>Card not found</h2>
        <p>No card with token id {tokenId} exists in the marketplace.</p>
        <button className="ghost" onClick={onBack}>
          Back to marketplace
        </button>
      </div>
    );
  }

  const { listing, offers } = data;
  // A listing read straight from chain has no Collector Crypt record attached until the
  // metadata pipeline exists. Render what the chain knows rather than an empty page.
  const detail = data.detail;
  const title = detail?.name ?? `Card #${tokenId}`;
  const insured = detail?.insuredValueUsd ?? null;
  /**
   * Ownership comes from the CHAIN, not from the listing.
   *
   * This used to require a listing to exist, so the owner of an unlisted card was treated as a
   * stranger: shown "Make an offer" on a card they already held, with no route to listing it.
   * ownerOf is the authority — a card is owned whether or not it is for sale.
   */
  const isOwner = Boolean(address && data.owner && data.owner.toLowerCase() === address.toLowerCase());
  const myOffer = offers.find((o) => address && o.offeror.toLowerCase() === address.toLowerCase());

  const faces = detail
    ? [
        { url: detail.imageFront, fallback: detail.imageFrontFallback, alt: `${detail.name}, front` },
        { url: detail.imageBack, fallback: detail.imageBackFallback, alt: `${detail.name}, back` },
      ].filter((f) => f.url)
    : [];
  const active = faces[face] ?? faces[0];

  const parsed = toBaseUnits(amount);
  const amountValid = parsed !== null && parsed > 0n;

  /**
   * An offer this wallet could not actually pay is worth blocking here.
   *
   * `makeOffer` moves no funds, so the contract happily records a bid for more USDG than the
   * offeror holds — it only checks solvency at `acceptOffer`, which then reverts with
   * OfferorCannotPay. Left unchecked that produces a bid the seller sees, tries to accept,
   * and watches fail through no fault of their own, while the offeror believes they have a
   * live offer. Both sides lose gas to a trade that was never possible.
   *
   * Undefined balance (still loading, or unreadable) does NOT block: the contract enforces
   * this for real at accept time, so a failed read must not stop a solvent user from bidding.
   */
  const overBalance =
    dialog === "offer" && parsed !== null && usdgBalance !== undefined && parsed > usdgBalance;

  const submitDialog = () => {
    if (!amountValid || overBalance) return;
    if (dialog === "offer") void trade.makeOffer(parsed, 0n);
    else if (listing && isOwner) void trade.updatePrice(parsed);
    else void trade.list(parsed);
  };

  return (
    <div className="ap">
      <button className="ap-back" onClick={onBack}>
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M14 6l-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Marketplace
      </button>

      <div className="ap-top">
        <div className="ap-media">
          <div className="ap-stage">
            {active?.url ? (
              <img
                src={active.url}
                alt={active.alt}
                decoding="async"
                onError={(e) => {
                  const img = e.currentTarget;
                  if (active.fallback && img.src !== active.fallback) img.src = active.fallback;
                  else img.style.visibility = "hidden";
                }}
              />
            ) : (
              <div className="ap-stage-blank">No image</div>
            )}
            {faces.length > 1 && (
              <button
                className="ap-flip"
                onClick={() => setFace((f) => (f + 1) % faces.length)}
                aria-label="Show the other side"
                title="Flip"
              >
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M4 9h11a4 4 0 014 4v1M4 9l3.5-3.5M4 9l3.5 3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M20 15H9a4 4 0 01-4-4v-1M20 15l-3.5 3.5M20 15l-3.5-3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>

          {faces.length > 1 && (
            <div className="ap-thumbs">
              {faces.map((f, i) => (
                <button key={i} className="ap-thumb" data-active={i === face} onClick={() => setFace(i)} aria-label={f.alt}>
                  <img src={f.url!} alt="" decoding="async" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="ap-info">
          <div className="ap-head">
            {detail?.category && <span className="ap-category">{detail.category}</span>}
            <h1 className="ap-title">{title}</h1>
            <div className="ap-meta">
              {listing && (
                <span>
                  Owned by <Address value={listing.seller} short />
                </span>
              )}
              {detail?.year && (
                <span>
                  Year <b>{detail.year}</b>
                </span>
              )}
            </div>
          </div>

          <div className="ap-action">
            {listing ? (
              <div className="ap-price">
                <span className="ap-price-label">Price</span>
                <span className="ap-price-figure">
                  <img className="usdg-mark" src={usdgIcon} alt="USDG" />
                  {usdgAmount(listing.priceUsdg)}
                </span>
              </div>
            ) : (
              <div className="ap-price">
                <span className="ap-price-label">Not listed</span>
                {insured && <span className="ap-price-sub">Insured at {usd(insured)}</span>}
              </div>
            )}

            <div className="ap-buttons">
              {isOwner ? (
                <>
                  <button className="primary" onClick={() => { setAmount(""); setDialog("list"); }} disabled={trade.pending}>
                    {listing ? "Change price" : "List for sale"}
                  </button>
                  {listing && (
                    <button className="ghost" onClick={() => void trade.cancel()} disabled={trade.pending}>
                      Delist
                    </button>
                  )}
                </>
              ) : (
                <>
                  {listing && (
                    <button
                      className="primary"
                      onClick={() => void trade.buy(BigInt(listing.priceUsdg))}
                      disabled={trade.pending || !listing.fillable}
                    >
                      {listing.fillable ? "Buy now" : "Unavailable"}
                    </button>
                  )}
                  {myOffer ? (
                    <button className="ghost" onClick={() => void trade.withdrawOffer()} disabled={trade.pending}>
                      Withdraw offer ({usdgAmount(myOffer.amountUsdg)})
                    </button>
                  ) : (
                    <button className="ghost" onClick={() => { setAmount(""); setDialog("offer"); }} disabled={trade.pending}>
                      Make an offer
                    </button>
                  )}
                </>
              )}
            </div>

            {trade.step.kind === "sending" && <p className="ap-status">{trade.step.label}…</p>}
            {trade.step.kind === "approving" && <p className="ap-status">Waiting for approval…</p>}
            {trade.step.kind === "error" && (
              <p className="ap-status error" onClick={trade.clearError}>
                {trade.step.message}
              </p>
            )}
            {!CAN_TRADE && (
              <p className="ap-status muted">
                Trading goes live when the Marketplace contract is deployed. Everything below is
                real vault data.
              </p>
            )}
          </div>

          <Panel title="More Details" defaultOpen>
            <Row label="Insured Value" value={insured ? usd(insured) : null} />
            <Row label="Grading Company" value={detail?.gradingCompany ?? null} />
            <Row label="Grading ID" value={detail?.gradingId ?? null} />
            <Row label="Grade" value={detail?.grade ?? null} />
            <Row label="Grade Population" value={detail?.gradePopulation != null ? detail.gradePopulation.toLocaleString("en-US") : null} />
            <Row label="Parallel" value={detail?.parallel ?? null} />
            <Row label="Vault" value={detail?.vault ?? null} />
            <Row label="Vault ID" value={detail?.vaultId ?? null} />
            <Row label="Location" value={detail?.location ?? null} />
            <Row label="Token ID" value={tokenId} />
            <Row label="Blockchain" value="Robinhood Chain" />
            <Row label="Backed by" value={detail ? <Address value={detail.mint} short /> : null} />
            {/**
              * The two proof links, side by side: the physical card in the vault, and the
              * chain's own record of the mirror that stands for it. They belong together and
              * in the same style — one claim each, both independently checkable.
              *
              * `token/<collection>/instance/<id>` is the per-instance page, which shows the
              * owner, transfer history and metadata. Verified live for token 1: right owner,
              * right name, right image.
              */}
            {(detail || tokenId) && (
              <div className="cd-externals">
                {detail && (
                  <a className="cd-external" href={detail.ccUrl} target="_blank" rel="noreferrer">
                    View on CollectorCrypt
                    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M8 16L16 8M9.5 8H16v6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </a>
                )}
                {tokenId && CONTRACTS.mirror && (
                  <a
                    className="cd-external"
                    href={explorerUrl(`token/${CONTRACTS.mirror}/instance/${tokenId}`)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View on Robinhood Chain
                    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M8 16L16 8M9.5 8H16v6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </a>
                )}
              </div>
            )}
          </Panel>

          <Panel title={`Offers${offers.length ? ` (${offers.length})` : ""}`} defaultOpen>
            {offers.length === 0 ? (
              <p className="ap-empty">No offers yet.</p>
            ) : (
              <table className="ap-offers">
                <thead>
                  <tr>
                    <th>Price</th>
                    <th>From</th>
                    <th>Date</th>
                    <th aria-label="Action" />
                  </tr>
                </thead>
                <tbody>
                  {offers.map((o) => (
                    <tr key={o.offeror} data-stale={!o.fillable}>
                      <td>
                        <span className="ap-offer-price">
                          <img className="usdg-mark" src={usdgIcon} alt="USDG" />
                          {usdgAmount(o.amountUsdg)}
                        </span>
                      </td>
                      <td><Address value={o.offeror} short /></td>
                      <td>{when(o.at)}</td>
                      <td>
                        {isOwner && o.fillable && (
                          <button
                            className="ap-accept"
                            onClick={() => void trade.acceptOffer(o.offeror as `0x${string}`, BigInt(o.amountUsdg))}
                            disabled={trade.pending}
                          >
                            Accept
                          </button>
                        )}
                        {!o.fillable && <span className="ap-stale">Unfunded</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      </div>

      {dialog && (
        <div className="stage" onClick={() => setDialog(null)}>
          <div onClick={(e) => e.stopPropagation()}>
            {!isConnected ? (
              <ConnectPrompt
                title={dialog === "offer" ? "Connect to make an offer" : "Connect to list"}
                body="Trading is tied to your wallet, so you'll need one connected first."
              />
            ) : (
              <div className="ap-dialog">
                <h3>{dialog === "offer" ? "Make an offer" : listing ? "Change price" : "List for sale"}</h3>
                <p>
                  {dialog === "offer"
                    ? "Your USDG stays in your wallet. The seller can accept any time until you withdraw."
                    : "Your card stays in your wallet. It only moves when someone buys it."}
                </p>
                <div className="ap-input">
                  <img className="usdg-mark" src={usdgIcon} alt="USDG" />
                  <input
                    autoFocus
                    inputMode="decimal"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && submitDialog()}
                  />
                </div>
                {overBalance && (
                  <p className="ap-dialog-warn">
                    That is more USDG than this wallet holds
                    {usdgBalance !== undefined && ` (${usdgAmount(usdgBalance.toString())})`}. An
                    offer you cannot cover would fail when the seller tried to accept it.
                  </p>
                )}
                <div className="ap-dialog-actions">
                  <button className="ghost" onClick={() => setDialog(null)}>
                    Cancel
                  </button>
                  <button
                    className="primary"
                    onClick={submitDialog}
                    disabled={!amountValid || overBalance || trade.pending}
                  >
                    {dialog === "offer" ? "Place offer" : listing ? "Update" : "List"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
