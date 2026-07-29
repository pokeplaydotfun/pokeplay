import { useCallback, useEffect, useRef, useState, type MouseEvent, lazy, Suspense} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount } from "wagmi";

import {
  getMachines,
  getCollection,
  getSellCapability,
  getSellStatus,
  type SellCapability,
  type SellStatus,
  type SellStage,
  getOrder,
  getPool,
  rip as ripApi,
  type Machine,
  type Order,
  type OwnedCard,
  type Prize,
  type CardDetail,
  serviceFeeFor,
  totalWithFee,
  displayCardName,
  ownedToDetail,
  cardValueLimitMessage,
  normalizeTier,
  machineLabel,
  getDepositsEnabled,
  getWithdrawCapability,
} from "./client.ts";
import { WalletButton, NetworkGuard, ConnectPrompt } from "./Wallet.tsx";
import { Marketplace } from "./Marketplace.tsx";
import { HowItWorks } from "./HowItWorks.tsx";
import { CardDetails } from "./CardDetails.tsx";
import { AssetPage } from "./AssetPage.tsx";
import { ProfilePage, SettingsPage, WithdrawPage } from "./Account.tsx";
import { Leaderboard } from "./Leaderboard.tsx";
import { TokenPage } from "./Token.tsx";
import { Messages, unreadCount } from "./Messages.tsx";
const TransferPage = lazy(() => import("./Transfer.tsx").then((m) => ({ default: m.TransferPage })));
const DepositPage = lazy(() => import("./Deposit.tsx").then((m) => ({ default: m.DepositPage })));

import { useBuyPack } from "./useBuyPack.ts";
import { useSellBack } from "./useSellBack.ts";
import { CAN_TRANSACT } from "./chain.ts";
import { humanError } from "./errors.ts";
import usdgIcon from "/slabs/usdg.png";
import { BRAND_NAME, BRAND_FULL } from "./brand.ts";
import { Mark } from "../components/ui";

type Tier = "common" | "uncommon" | "rare" | "epic";

const TIER_COLOR: Record<Tier, string> = {
  common: "#7c8598",
  uncommon: "#3fa877",
  rare: "#4a8fd4",
  epic: "#b06fe0",
};

/**
 * Insured-value band for a tier, read from the machine rather than hardcoded: every machine
 * has its own bands ($30-60 on the 50, $600-1000 on the 1000), so a fixed table silently
 * mislabels three of the four packs.
 */

/**
 * Always en-US, never the browser locale. These are USD amounts, and on a Dutch or German
 * machine the default locale renders $50.00 as "$50,00" — which reads as fifty thousand to
 * plenty of people. Money formatting follows the currency, not the visitor.
 */
const usd = (baseUnits: string | null | undefined) => {
  // Was "0.00" for null — no currency mark, sitting beside every other price on the panel —
  // and "$NaN" for anything non-numeric, since Number(x)/1e6 was unguarded.
  const n = baseUnits == null ? 0 : Number(baseUnits) / 1e6;
  return `$${(Number.isFinite(n) ? n : 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

/**
 * Tier from insured value against CC's published tierRanges. Derived rather than decorative:
 * the burst colour reflects what you actually pulled.
 */
/**
 * A card knows its own tier, set where it was created against that MACHINE's value bands.
 * Never re-derive it from insured value here: $500 is epic in the $50 machine and only
 * uncommon in the $250 one, whose epic band starts at $2000.
 */
function tierFor(card: { tier?: Tier; insuredValueUsd: string | null } | null): Tier {
  // normalizeTier, not a bare pass-through: the API sends "Common" and every lookup keyed on
  // this value — TIER_COLOR, odds, tierRanges — is lowercase. client.ts normalises at the
  // boundary; this is the second line of defence for any card object that skipped it.
  if (card?.tier) return normalizeTier(card.tier);
  const v = Number(card?.insuredValueUsd ?? 0) / 1e6;
  return v >= 250 ? "epic" : v >= 110 ? "rare" : v >= 60 ? "uncommon" : "common";
}

/** Whole-token amount with the USDG mark in place of a currency symbol. */
function Usdg({ base, className }: { base: string | null | undefined; className?: string }) {
  if (base == null) return <>0</>;
  const n = Number(base) / 1e6;
  return (
    <span className={`usdg${className ? ` ${className}` : ""}`}>
      <img className="usdg-mark" src={usdgIcon} alt="USDG" />
      {n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
    </span>
  );
}

/**
 * A machine's display name, from its id.
 *
 * The old version was `id.split("_")[1] + " Pack"`, so every machine was named after its
 * price. Collector Crypt runs several at the same price — pokemon, onepiece, basketball,
 * baseball and football all have a $50 — and they all rendered as "50 Pack", identical and
 * indistinguishable. Same for water_100 and sports_100.
 *
 * The franchise is the part that tells you what you are buying, so it leads.
 */

/**
 * What a seller sees at each stage. Written from their side, not ours: they care where their
 * card and their money are, not which leg of the pipeline is running.
 */
const SELL_STAGE_LABEL: Record<SellStage, string> = {
  selling: "Selling your card…",
  settling: "Card sold, moving your funds…",
  paying: "Sending your USDG…",
  paid: "Sold",
  cancelled: "Cancelled",
};

/* The sell-back, as ordered progress steps for the popup. The inline card indicator was easy
   to miss; a modal makes it unmissable that a sale is in flight and how far along it is. */
const SELL_STEPS: { key: SellStage; label: string }[] = [
  { key: "selling", label: "Selling your card to the vault" },
  { key: "settling", label: "Moving your funds across" },
  { key: "paying", label: "Sending your USDG" },
  { key: "paid", label: "Done" },
];
const SELL_STAGE_INDEX: Record<SellStage, number> = {
  selling: 0,
  settling: 1,
  paying: 2,
  paid: 3,
  cancelled: -1,
};

const DEMO_BUYER = "0xDEM0000000000000000000000000000000000001";

/* ------------------------------------------------------------------ rip stage */

const STAGES = [
  { key: "bridging", label: "Moving USDG" },
  { key: "opening", label: "Opening your pack" },
  { key: "revealing", label: "Displaying card" },
] as const;

/**
 * Reveal, following the beats of a good slab rip:
 *
 *   working  the sealed pack, while the order is actually being fulfilled
 *   back     the real slab BACK, with the card's year in large translucent type
 *   rarity   the tier called out big, with its published odds
 *   flip     the slab turns to its front — the real photo, glow keyed to tier
 *   panel    details slide up over the lower half
 *
 * We can't show the slab back during `working` the way a site that pre-computes the pull
 * can: our reveal genuinely isn't known until the vault answers. So the sealed pack holds
 * the suspense, and the card's own back appears the moment there's a real card to show.
 */
type RevealPhase = "working" | "back" | "grade" | "rarity" | "flip" | "panel";

/**
 * Published odds for the tier that was pulled, taken from the MACHINE.
 *
 * This was a hardcoded 80/15/4/1 table, which is the $50 machine's distribution. Every other
 * machine runs 75/20/4/1, so the reveal quoted the wrong uncommon and common figures on the
 * 250, the 1000 and Water — the exact mistake `client.ts` warns about, still live in the one
 * place a user actually reads an odds number.
 *
 * Falls back to a dash rather than a guess: an invented probability is worse than none.
 */
/**
 * The pull odds for a tier, or null when they genuinely are not known.
 *
 * Returns NULL rather than a dash. This used to hand back "—", which the reveal panel
 * concatenated into "COMMON · —" — and a lone dash beside a rarity reads as a field the card
 * is missing, not as an unknown percentage. The caller now omits the separator entirely, so
 * an unknown value shows nothing at all instead of showing a gap.
 */
function tierOdds(machine: Machine | null, tier: Tier): string | null {
  const p = machine?.odds?.[tier];
  if (typeof p !== "number" || !Number.isFinite(p)) return null;
  // Odds arrive as fractions (0.15). Trim a trailing .0 so 20.0% reads as 20%.
  const pct = p * 100;
  return `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

function SlabImage({
  src,
  fallback,
  alt,
  className,
}: {
  src: string | null;
  fallback: string | null;
  alt: string;
  className?: string;
}) {
  if (!src) return null;
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      onError={(e) => {
        const img = e.currentTarget;
        if (fallback && img.src !== fallback) img.src = fallback;
        else img.style.visibility = "hidden";
      }}
    />
  );
}

function RipStage({
  order,
  onClose,
  onAgain,
  sellRatePct,
  machine,
  onSell,
}: {
  order: Order;
  onClose: () => void;
  onAgain: () => void;
  sellRatePct: number | null;
  /** The machine this pull came from. Its odds and value bands differ from every other. */
  machine: Machine | null;
  /** Wire this once the buyback pipeline (Flow B) exists; until then the block is inert. */
  onSell?: () => void;
}) {
  const card = order.card;
  const ready = order.stage === "done" && card;
  const tier = tierFor(card ?? null);
  const [phase, setPhase] = useState<RevealPhase>("working");
  /**
   * Whether the reveal can be dismissed right now.
   *
   * True before the animation starts (`working` — a wait that can run minutes, and which the
   * copy already says is safe to close) and once it has finished (`panel`). False for every
   * beat in between, so neither the X, nor Escape, nor a backdrop click can end the reveal
   * half way through. Skip remains, and it jumps to `panel`, which restores all three.
   *
   * `!ready` is the safety valve and it matters more than it looks. Skip is only rendered
   * while `ready` is true, so if the order ever stopped being `done` mid-animation the user
   * would have no X, no Escape, no backdrop and no Skip — sealed into a dialog. Restoring
   * dismissal whenever there is no revealed card means the block can only ever apply while
   * there is genuinely something on screen worth protecting.
   *
   * Declared here, above the Escape listener that reads it, and passed in that listener's
   * dependency array. Left further down it would be captured stale at its first value and
   * Escape would keep working all the way through the animation — the exact accident this
   * is meant to prevent, just moved somewhere harder to see.
   */
  const revealDismissable = !ready || phase === "working" || phase === "panel";
  const [showFront, setShowFront] = useState(false);
  const [flipping, setFlipping] = useState(false);
  /** Why a sell-back cannot proceed, when it cannot. Null while nothing is being explained. */
  const [notice, setNotice] = useState<null | "demo" | "unavailable">(null);

  /**
   * The pending beat timers. Held in a ref rather than effect-local so Skip can cancel them:
   * jumping to the end without clearing these lets a late timer fire afterwards and drag the
   * reveal backwards through a beat the viewer already skipped past.
   */
  const beatTimers = useRef<number[]>([]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const timers: number[] = [];
    beatTimers.current = timers;

    /**
     * Wait for BOTH slab faces to decode before starting the beats.
     *
     * Previously the sequence started the instant the data arrived, so on a cold cache the
     * year and rarity played over an empty rectangle and the card only appeared once the
     * beats had already passed. The reveal is a timed performance — it should not begin
     * until its subject is actually ready.
     *
     * Capped at 5s so a stalled image can never strand someone on the sealed pack.
     */
    const preload = (src: string | null) =>
      new Promise<void>((resolve) => {
        if (!src) return resolve();
        const img = new Image();
        img.onload = () => resolve();
        img.onerror = () => resolve();
        img.src = src;
      });

    void (async () => {
      await Promise.race([
        Promise.all([preload(card?.imageBack ?? null), preload(card?.imageFront ?? null)]),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
      if (cancelled) return;

      // Beat timings. Slower than before — the previous pass rushed through the whole
      // sequence in ~3s, which read as a glitch rather than a reveal.
      // Three overlay beats before the turn — year, grade, rarity — each held ~1.9s, then
      // the flip and the details. Matches the reference recording's cadence.
      setPhase("back");
      timers.push(window.setTimeout(() => setPhase("grade"), 1900));
      timers.push(window.setTimeout(() => setPhase("rarity"), 3800));
      timers.push(window.setTimeout(() => setPhase("flip"), 5700));
      timers.push(window.setTimeout(() => setFlipping(true), 5700));
      // Swap the face at the squash's midpoint, where the slab is edge-on.
      timers.push(window.setTimeout(() => setShowFront(true), 6020));
      timers.push(window.setTimeout(() => setFlipping(false), 6400));
      timers.push(window.setTimeout(() => setPhase("panel"), 6650));
    })();

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [ready, card?.imageBack, card?.imageFront]);

  /**
   * Jump to the fully revealed card.
   *
   * Only offered once the opening has actually started. The sealed-pack stage is not
   * choreography — the card genuinely is not known yet, because the vault has not answered —
   * so there is nothing there to skip past.
   */
  const skipReveal = useCallback(() => {
    beatTimers.current.forEach(clearTimeout);
    beatTimers.current = [];
    setFlipping(false);
    setShowFront(true);
    setPhase("panel");
  }, []);

  // What we would actually pay for it: the vault's rate minus our 5 points, applied to
  // insured value. Shown next to the insured figure so the spread is never a surprise at
  // sell time.
  const sellBackUsd =
    card?.insuredValueUsd && sellRatePct
      ? String(Math.round((Number(card.insuredValueUsd) * sellRatePct) / 100))
      : null;

  useEffect(() => {
    // Escape follows the same rule as the X. Hiding the button while leaving Escape live
    // would just move the accident, not prevent it.
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && revealDismissable && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, revealDismissable]);

  /**
   * Progress through fulfilment, held steady across a variable wait.
   *
   * A real open takes as long as the bridge, Collector Crypt and the mint take, which is not
   * a fixed number and can be minutes. Two things used to break over that:
   *
   *   `queued`   findIndex returned -1, so nothing was highlighted and the first moments
   *              looked dead.
   *   `retrying` also -1, which blanked the whole list at the exact moment a user most needs
   *              to see that something is still happening.
   *
   * The indicator now only ever moves forward: an unrecognised stage holds the furthest point
   * reached rather than resetting.
   */
  const [furthestStage, setFurthestStage] = useState(0);
  const rawStageIndex = STAGES.findIndex((s) => s.key === order.stage);

  useEffect(() => {
    if (rawStageIndex >= 0) setFurthestStage((m) => Math.max(m, rawStageIndex));
  }, [rawStageIndex]);

  const stageIndex =
    order.stage === "queued" ? 0 : rawStageIndex >= 0 ? rawStageIndex : furthestStage;

  /**
   * Seconds spent waiting. Only runs while the card is unknown, so a finished reveal is not
   * paying for a timer, and it is what lets a long wait say so rather than look stuck.
   */
  const [waitedSec, setWaitedSec] = useState(0);
  useEffect(() => {
    if (ready) return;
    const t = window.setInterval(() => setWaitedSec((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [ready]);

  /**
   * How agitated the sealed pack should look.
   *
   * The tremble was a 0.4s loop running for the whole wait. Over the ~8s a demo takes that
   * reads as anticipation; over a two minute bridge it reads as a stuck page. So the pack now
   * breathes slowly while the money moves and only tightens into the tremble once the vault
   * is actually revealing — which ties the animation to real progress instead of guessing.
   */
  const packActivity = order.stage === "revealing" ? "imminent" : "waiting";

  return (
    <div
      /*
       * stage-theater, not a plain .stage: this is the one place the backdrop is
       * a full blackout rather than a dialog scrim. The reveal's tier glows are
       * additive and need darkness under them; every other .stage on the site is
       * an ordinary dialog, where a near-opaque blackout reads as oppressive now
       * that the page behind it is cream.
       */
      className="stage stage-theater"
      style={{ ["--tier" as string]: TIER_COLOR[tier] }}
      /*
       * Backdrop click only dismisses once the card is fully revealed. During the opening
       * beats a stray click would abort the moment the user is waiting for — and the
       * pointer is often already moving toward the card. The X and Escape stay available
       * throughout for anyone who genuinely wants out early.
       */
      onClick={() => phase === "panel" && onClose()}
    >
      {/*
        * The X is hidden for the whole reveal animation, and this is deliberate.
        *
        * Closing mid-reveal throws away the one moment the user paid for, and the pointer is
        * often already travelling toward the card when the beats start. Previously the X sat
        * there through all of it, one stray click from ending the thing they were waiting on.
        *
        * Nobody is trapped by this. During the animation the Skip button is on screen and
        * jumps straight to `panel`, which brings the X back — so "finish it" and "skip it"
        * both lead to an exit, and the only unavailable action is "abandon it half way".
        *
        * It stays available during `working`, which is NOT the animation: that is the wait
        * while the pack is bought and revealed, it can run for minutes on a real order, and
        * the copy in that state already promises the open continues if you close the window.
        * Hiding it there would trap someone for two minutes to solve a problem that only
        * exists once the card starts turning over.
        *
        * Applies to demo pulls too, at the operator's request, so the two behave alike.
        */}
      {revealDismissable && (
        <button className="stage-close" onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
        </button>
      )}

      {/* Shown from the first beat until the details land. Not during "working": the card is
          genuinely unknown then, so there is nothing to skip. */}
      {ready && phase !== "working" && phase !== "panel" && (
        <button
          className="reveal-skip"
          onClick={(e) => {
            e.stopPropagation();
            skipReveal();
          }}
        >
          Skip
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M7 5.5l7 6.5-7 6.5M15.5 5.5v13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}

      <div className="stage-inner" onClick={(e) => e.stopPropagation()}>
        {phase === "working" && (
          <>
            <div className="pack-wrap">
              <div className="pack" data-phase="working" data-activity={packActivity}>
                {/*
                  A light seam down the pack. It glows faintly while the order is moving
                  and brightens as the vault reports it is revealing, so the pack looks
                  like it is charging rather than rattling. Replaces the old tremble as
                  the signal that something is about to happen.
                */}
                <span className="pack-seam" aria-hidden="true" />
                <div className="pack-seal">
                  <span className="pack-logo"><Mark size={44} /></span>
                  <span>Sealed</span>
                </div>
              </div>
            </div>

            <div className="reveal-steps-card">
              <div className="stages">
                {STAGES.map((s, i) => (
                  <div
                    key={s.key}
                    className="stage-row"
                    data-state={i < stageIndex ? "done" : i === stageIndex ? "active" : "idle"}
                  >
                    <span className="dot" />
                    {s.label}
                  </div>
                ))}
              </div>
            </div>

            {/**
              * A refunded order is a FINISHED order, and it used to render as a working one.
              *
              * `refunded` appeared in exactly one place — the poll's stop condition — and
              * nowhere in the UI. So the poll stopped, `ready` stayed false because there is
              * no card, and the sealed pack sat there showing "Still working... this keeps
              * going if you close the window". Every word of that was false by then: nothing
              * was working, nothing was continuing, and the money was already back. The one
              * path designed to be safe was the one that lied.
              */}
            {order.stage === "refunded" && (
              <p className="stage-note">
                This pack could not be opened, so your payment has been returned in full.
                Nothing was charged. You can try again whenever you like.
              </p>
            )}

            {order.stage !== "retrying" && order.stage !== "refunded" && waitedSec >= 45 && (
              <p className="stage-note">
                Still working. Packs usually open in under a minute, but a busy bridge can
                take longer. Your payment is safe, and this keeps going if you close the
                window.
              </p>
            )}

            {order.stage === "retrying" && (
              <p className="muted" style={{ marginTop: 22, fontSize: 13.5 }}>
                Taking longer than usual, retrying now. Your payment is safe; if we can't
                fulfil it, it's refunded automatically.
              </p>
            )}
          </>
        )}

        {phase !== "working" && card && (
          <div className="reveal">
            <div className="slab-glow">
              {/*
                A scaleX squash with the image swapped at the midpoint, rather than a
                rotateY with two backface-hidden faces. The 3D approach is fragile: any
                filter in the ancestor chain flattens the 3D context, and backface-visibility
                then resolves against each face's OWN transform — which silently shows the
                wrong side. This reads identically and cannot break that way.
              */}
              <div className={`slab${flipping ? " flipping" : ""}`}>
                <SlabImage
                  src={showFront ? card.imageFront : card.imageBack}
                  fallback={showFront ? card.imageFrontFallback : card.imageBackFallback}
                  alt={showFront ? (card.name ?? "card") : ""}
                />
                {!(showFront ? card.imageFront : card.imageBack) && (
                  <div className="slab-blank">{showFront ? card.grade : ""}</div>
                )}
              </div>
            </div>

            {/* The first beat shows the card's year in big translucent type. Cards with no
                year in their name (promos like Black Star Promos) would otherwise sit here
                blank for ~1.9s, so the reveal looked like it jumped straight to the grade.
                Fall back to the grade — it still fills the beat, and the grade beat that
                follows just holds it a moment longer. */}
            {phase === "back" &&
              (card.year ? (
                <div className="overlay-year">{card.year}</div>
              ) : card.grade ? (
                <div className="overlay-grade">{card.grade}</div>
              ) : null)}
            {phase === "grade" && card.grade && <div className="overlay-grade">{card.grade}</div>}
            {phase === "rarity" && <div className="overlay-rarity">{tier}</div>}

            {phase === "panel" && (
              <div className="reveal-panel">
                <div className="reveal-tier">
                  {tier}
                  {/* Separator and figure appear together or not at all. */}
                  {tierOdds(machine, tier) && <> · {tierOdds(machine, tier)}</>}
                </div>
                <div className="reveal-name">{displayCardName(card.name)}</div>

                <div className="reveal-pills">
                  {card.grade && <span className="pill-tag grade">{card.grade}</span>}
                  {card.year && <span className="pill-tag">{card.year}</span>}
                  {card.category && <span className="pill-tag">{card.category}</span>}
                </div>

                <div className="reveal-values">
                  <div className="reveal-value-block">
                    <div className="reveal-value-label">Insured value</div>
                    <div className="reveal-value">{usd(card.insuredValueUsd)}</div>
                  </div>
                  {/* Always clickable. A dead button teaches nothing — if a sell cannot happen
                      the reason is worth saying out loud, which is what `notice` does. */}
                  <button
                    className="reveal-value-block sell"
                    onClick={() => {
                      if (order.demo) return setNotice("demo");
                      if (!onSell) return setNotice("unavailable");
                      onSell();
                    }}
                    title="Sell this card back"
                  >
                    <div className="reveal-value-label">Sell back</div>
                    <div className="reveal-value sell">{usd(sellBackUsd)}</div>
                  </button>
                </div>

                {order.demo && (
                  <p className="reveal-demo-note">
                    Demo pull. This card is not yours and nothing was minted.
                  </p>
                )}

                <div className="reveal-actions">
                  {/* Says which kind it opens. The button used to read "Open another" on a
                      demo and then charge for a real pack, so naming it is not decoration —
                      it is the difference between free and $1,000. */}
                  <button className="primary" onClick={onAgain}>
                    {order.demo ? "Open another demo" : "Open another"}
                  </button>
                  <button className="ghost" onClick={onClose}>
                    {order.demo ? "Close" : "Keep it"}
                  </button>
                </div>

                {/* Why the sell could not start. Close dismisses the whole reveal rather than
                    just this panel, so one click returns you to the page instead of leaving
                    you back on a card you have already decided about. */}
                {notice && (
                  <div
                    className="reveal-notice"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="reveal-notice-title"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <h4 id="reveal-notice-title">
                      {notice === "demo" ? "This is a demo pull" : "Sell back is not open yet"}
                    </h4>
                    <p>
                      {notice === "demo"
                        ? "Nothing was bought and no card was minted, so there is nothing to sell back."
                        : "The buyback desk is not taking cards yet. Your card is safe in your collection, and you will be able to sell it back from there once it opens."}
                    </p>
                    <button
                      className="primary"
                      autoFocus
                      onClick={() => {
                        setNotice(null);
                        onClose();
                      }}
                    >
                      Close
                    </button>
                  </div>
                )}

                {/* A demo memo is locally generated and verifies nothing, so the link is
                    hidden rather than pointed at a page that would say "not found". */}
                {order.ccMemo && !order.demo && (
                  <a
                    className="verify-link"
                    href={`https://gacha.collectorcrypt.com/verify-selection/${order.ccMemo}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Verify ↗
                  </a>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ buy steps */

/**
 * Wallet transactions, before the order exists. Approve and buy are named separately on
 * purpose — an unexplained second wallet prompt is what a drain looks like to a careful
 * user, and saying "one time" is the difference between confidence and a cancelled buy.
 */
function BuySteps({ step, onDismiss }: { step: ReturnType<typeof useBuyPack>["step"]; onDismiss: () => void }) {
  if (step.kind === "idle" || step.kind === "done") return null;

  if (step.kind === "error") {
    return (
      <div className="stage">
        <div className="stage-inner stage-card">
          <h2>Purchase didn't go through</h2>
          <p className="muted" style={{ margin: "12px auto 24px", maxWidth: "42ch" }}>
            {step.message}
          </p>
          <button className="ghost" onClick={onDismiss}>
            Close
          </button>
        </div>
      </div>
    );
  }

  const rows = [
    { key: "checking", label: "Checking your balance and allowance" },
    { key: "approving", label: "Approving USDG (one time)" },
    { key: "buying", label: "Confirming your purchase" },
  ];
  const activeIndex = rows.findIndex((r) => r.key === step.kind);

  return (
    <div className="stage">
      <div className="stage-inner stage-card">
        <div className="eyebrow">In your wallet</div>
        <div className="stages">
          {rows.map((r, i) => (
            <div
              key={r.key}
              className="stage-row"
              data-state={i < activeIndex ? "done" : i === activeIndex ? "active" : "idle"}
            >
              <span className="dot" />
              {r.label}
            </div>
          ))}
        </div>
        {"hash" in step && step.hash && (
          <div className="tx-hash">
            {step.hash.slice(0, 10)}…{step.hash.slice(-8)}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ routing */

type Tab = "home" | "floor" | "market" | "collection" | "how" | "profile" | "settings" | "withdraw" | "deposit" | "transfer" | "leaders" | "token" | "messages";

/**
 * Real URLs rather than tab state alone, so every section is linkable, shareable and
 * survives a refresh. Deliberately hand-rolled on the History API: one map and a popstate
 * listener does everything a router would here, without the dependency.
 *
 * The host must serve index.html for these paths (SPA fallback) or a hard refresh 404s.
 */
/**
 * The Cards section is mounted inside pokeplay under this base. Every route
 * below is prefixed with it, so the hand-rolled History-API routing lives
 * entirely under /cards and never collides with pokeplay's own react-router.
 */
export const SLABS_BASE = "/cards";

const TAB_PATH: Record<Tab, string> = {
  /*
   * The gacha moved off the section root and onto its own page: the root is a
   * landing/explainer, not a buy flow, so a visit does not drop straight into
   * asking for money.
   */
  home: `${SLABS_BASE}`,
  floor: `${SLABS_BASE}/gacha`,
  collection: `${SLABS_BASE}/collection`,
  market: `${SLABS_BASE}/marketplace`,
  how: `${SLABS_BASE}/how-it-works`,
  leaders: `${SLABS_BASE}/leaderboards`,
  token: `${SLABS_BASE}/token`,
  messages: `${SLABS_BASE}/messages`,
  profile: `${SLABS_BASE}/profile`,
  settings: `${SLABS_BASE}/settings`,
  withdraw: `${SLABS_BASE}/withdraw`,
  deposit: `${SLABS_BASE}/deposit`,
  transfer: `${SLABS_BASE}/transfer`,
};

const TAB_TITLE: Record<Tab, string> = {
  home: "Home",
  floor: "Gacha",
  collection: "Collection",
  market: "Marketplace",
  how: "How it works",
  leaders: "Leaderboards",
  token: "Token",
  messages: "Messages",
  profile: "Profile",
  settings: "Settings",
  withdraw: "Withdraw",
  transfer: "Transfer cards",
  deposit: "Deposit",
};

/** Tolerates a trailing slash so /marketplace/ is not a dead end. */
const normalizePath = (pathname: string) => pathname.replace(/\/+$/, "") || "/";

function tabForPath(pathname: string): Tab {
  const clean = normalizePath(pathname);
  const hit = (Object.keys(TAB_PATH) as Tab[]).find((t) => TAB_PATH[t] === clean);
  if (hit) return hit;
  // A card page is still the marketplace section as far as the nav is concerned.
  // Anything unrecognised falls back to home rather than the gacha: an unknown URL
  // should land on the page that explains the product, not inside a purchase flow.
  return assetIdForPath(pathname) ? "market" : "home";
}

/** /cards/marketplace/<tokenId> renders one card. Returns null for every other path. */
export function assetIdForPath(pathname: string): string | null {
  const m = /^\/cards\/marketplace\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  return m ? m[1]! : null;
}

export const assetPath = (tokenId: string) => `${SLABS_BASE}/marketplace/${tokenId}`;

/**
 * Does this element actually scroll its overflow?
 *
 * Used to decide whether it can serve as an IntersectionObserver root. A root with
 * `overflow: visible` is not a viewport for intersection purposes — the observer falls back
 * to measuring against its full content box, so anything inside it reads as permanently
 * intersecting. That turns a paging sentinel into an infinite loop.
 */
function isScrollContainer(el: HTMLElement | null): boolean {
  if (!el) return false;
  const oy = getComputedStyle(el).overflowY;
  return oy === "auto" || oy === "scroll";
}

/* ------------------------------------------------------------------ nav */

/* ------------------------------------------------------------------ app */

export default function App() {
  const [tab, setTabState] = useState<Tab>(() => tabForPath(window.location.pathname));
  const [assetId, setAssetId] = useState<string | null>(() => assetIdForPath(window.location.pathname));

  /**
   * What the user meant when they opened a card, for the one case where the page needs to
   * know: "Offer now" on a marketplace tile opens the card with its offer dialog already up.
   *
   * Deliberately NOT in the URL. It is a one-shot intent, not a location — putting it in the
   * path would make a shared link, a refresh or a Back press pop a transaction dialog the
   * visitor never asked for.
   */
  const [assetIntent, setAssetIntent] = useState<"offer" | undefined>();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [pool, setPool] = useState<Prize[]>([]);
  const [poolPage, setPoolPage] = useState(1);
  const [detail, setDetail] = useState<CardDetail | null>(null);
  /**
   * The mirror token id behind `detail`, when there is one.
   *
   * Pool cards have not been minted, so they have no token and no chain link. An owned card
   * does, and that link is half the proof the popup exists to offer.
   */
  const [detailTokenId, setDetailTokenId] = useState<string | null>(null);
  const [poolHasMore, setPoolHasMore] = useState(true);
  const [poolLoading, setPoolLoading] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const poolScrollRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const floorRef = useRef<HTMLDivElement | null>(null);
  const machinesRef = useRef<HTMLDivElement | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [owned, setOwned] = useState<OwnedCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Lets a completed order re-read on-chain values (the header's USDG balance). */
  const queryClient = useQueryClient();
  /**
   * Synchronous re-entry guard for the open button.
   *
   * `busy` alone is not enough. It is React state, so it does not take effect until the next
   * render, and `disabled={ripDisabled}` reads the OLD value until then. A double-click, a
   * held Enter, an impatient second tap on mobile, or a trackpad that sends two events all
   * land inside that window and call rip() twice.
   *
   * On the demo path that is a wasted animation. On the real path it is TWO wallet prompts
   * and, if both are signed, two separate on-chain orders at 53 USDG each. The chain has no
   * idea they were meant to be one purchase, so nothing downstream can merge or refund them.
   *
   * A ref is written synchronously, so the second call is rejected before it can start,
   * whatever the render timing.
   */
  const ripInFlight = useRef(false);
  const [needsWallet, setNeedsWallet] = useState(false);
  const poll = useRef<number | null>(null);

  const { address, isConnected } = useAccount();
  const { buy, step: buyStep, reset: resetBuy } = useBuyPack();

  // Sell-back is advertised by the server, never assumed by the bundle: the worker's switch
  // is what decides, and offering a button it will refuse is worse than not showing one.
  const [sellCap, setSellCap] = useState<SellCapability>({
    enabled: false,
    escrowAddress: null,
    valueLimitActive: false,
  });
  /**
   * The card a user tried to sell or withdraw that is over the value ceiling.
   *
   * Held as state rather than handled with a disabled button because a disabled control with
   * a tooltip explains nothing on touch, and this codebase has already shipped one button
   * that looked live and did nothing. The click is allowed; it opens a dialog that says no.
   */
  const [valueBlocked, setValueBlocked] = useState<OwnedCard | null>(null);
  const [sellingCard, setSellingCard] = useState<OwnedCard | null>(null);

  /**
   * Unread marketplace messages, for the dot on the wallet button.
   *
   * Refreshed alongside the collection rather than on a timer: the things that create a
   * message — an offer, a sale — are the same events that change what you own, so anything
   * that warrants a re-read of one warrants a re-read of the other.
   */
  const [unreadMessages, setUnreadMessages] = useState(0);

  /** Shown when a machine is too low on commons for Collector Crypt to open it. */
  const [lowNotice, setLowNotice] = useState(false);
  /** Deposits are hidden until the chain says they would actually work. See getDepositsEnabled. */
  const [depositsEnabled, setDepositsEnabled] = useState(false);
  /** Whether the withdraw relayer is accepting requests. Off means the button explains, not dies. */
  const [withdrawEnabled, setWithdrawEnabled] = useState(false);
  const [sellStatus, setSellStatus] = useState<Record<string, SellStatus>>({});
  /** Sells whose progress popup the user has dismissed, so it doesn't reappear while polling. */
  const [dismissedSells, setDismissedSells] = useState<Set<string>>(new Set());
  const { step: sellStep, quote: askSellQuote, confirm: confirmSell, reset: resetSell } = useSellBack();

  // On-chain only when contracts are configured AND a wallet is connected. Never a Buy
  // button pointed at an unconfigured address.
  const onChain = CAN_TRANSACT && isConnected;
  const buyerAddress = address ?? DEMO_BUYER;
  const machine = machines.find((m) => m.id === selected) ?? machines[0] ?? null;
  const machineId = machine?.id;

  const loadMachines = useCallback(async () => {
    try {
      const data = await getMachines();
      setMachines(data.machines);
      /*
       * Default to the CHEAPEST machine, chosen by price rather than by position.
       *
       * This was `machines[1]` — the second in the list — which meant the pre-selected
       * pack depended on array order. Reordering the list by price silently moved the
       * default from a $250 pack to a $100 one, which is not a thing list order should
       * be able to decide: it is the pack a first-time visitor is one click from buying.
       *
       * Cheapest is also the right default on its own terms — the lowest commitment to
       * pre-select for someone who has not chosen yet.
       */
      setSelected((cur) => {
        if (cur) return cur;
        const cheapest = [...data.machines].sort(
          (a, b) => Number(a.priceUsdg) - Number(b.priceUsdg),
        )[0];
        return cheapest?.id ?? null;
      });
    } catch (err) {
      setError("Could not load the packs. Check your connection and refresh.");
    }
  }, []);

  const loadCollection = useCallback(async (): Promise<OwnedCard[]> => {
    // Kicked off first so a slow collection read does not delay the badge, and awaited
    // separately so a failure in either one cannot take the other down with it.
    void unreadCount(buyerAddress).then(setUnreadMessages).catch(() => {});
    try {
      const { cards } = await getCollection(buyerAddress);
      setOwned(cards);
      return cards;
    } catch {
      /* non-critical */
      return [];
    }
  }, [buyerAddress]);

  /**
   * Clear the badge on the way OUT of the messages page.
   *
   * `unreadCount` reads the same local seen-ids the page writes when it renders, so recounting
   * while the page is open would race it. Recounting on leave means the dot disappears exactly
   * when the user has actually looked, which is what the dot claims.
   */
  useEffect(() => {
    if (tab === "messages") return;
    void unreadCount(buyerAddress).then(setUnreadMessages).catch(() => {});
  }, [tab, buyerAddress]);

  useEffect(() => {
    void loadMachines();
    void loadCollection();
    void getDepositsEnabled().then(setDepositsEnabled);
    void getWithdrawCapability().then((w) => setWithdrawEnabled(w.enabled));
    void getSellCapability().then(setSellCap);
  }, [loadMachines, loadCollection]);

  /**
   * Follow any sell-back that is still moving.
   *
   * Only cards already known to have one are polled, and polling stops once every one of
   * them is terminal, so an idle collection makes no requests at all.
   */
  useEffect(() => {
    if (!sellCap.enabled) return;
    const watching = owned.filter((c) => {
      const s = sellStatus[c.tokenId];
      return s && s.stage !== "paid" && s.stage !== "cancelled";
    });
    if (watching.length === 0) return;

    const id = window.setInterval(() => {
      for (const card of watching) {
        void getSellStatus(card.tokenId).then((s) => {
          if (!s) return;
          setSellStatus((cur) => ({ ...cur, [card.tokenId]: s }));
          // A finished sell-back changes what the collection should show.
          if (s.stage === "paid" || s.stage === "cancelled") {
            void loadCollection();
            // Same reason as the pack open: a sell-back pays USDG IN and removes the card, so
            // a stale cached balance is even more confusing here — the user is watching for
            // money to arrive.
            void queryClient.invalidateQueries();
          }
        });
      }
    }, 5000);
    return () => window.clearInterval(id);
    // queryClient is a stable reference from the provider, so it never re-runs this effect —
    // listed anyway so the dependency is explicit rather than relying on that guarantee.
  }, [sellCap.enabled, owned, sellStatus, loadCollection, queryClient]);

  /** Pick up sell-backs already in flight, e.g. after a reload mid-sale. */
  useEffect(() => {
    if (!sellCap.enabled || owned.length === 0) return;
    for (const card of owned) {
      if (sellStatus[card.tokenId]) continue;
      void getSellStatus(card.tokenId).then((s) => {
        if (s) setSellStatus((cur) => ({ ...cur, [card.tokenId]: s }));
      });
    }
    // Deliberately keyed on the card list only: adding sellStatus here would re-run on every
    // status write and re-request forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sellCap.enabled, owned]);

  const beginSell = useCallback(
    async (card: OwnedCard) => {
      setSellingCard(card);
      resetSell();
      await askSellQuote(card.tokenId);
    },
    [askSellQuote, resetSell],
  );

  const finishSell = useCallback(async () => {
    if (sellStep.kind !== "quoted" || !sellingCard) return;
    const ok = await confirmSell(sellStep.quote);
    if (ok) {
      // The transfer is the commitment, so from here the worker owns it. Show it as moving
      // immediately rather than waiting for the first poll.
      setSellStatus((cur) => ({
        ...cur,
        [sellingCard.tokenId]: {
          tokenId: sellingCard.tokenId,
          stage: "selling",
          payoutUsdg: sellStep.quote.payoutUsdg,
          payoutTx: null,
          error: null,
          updatedAt: Date.now(),
        },
      }));
      setSellingCard(null);
      void loadCollection();
    }
  }, [sellStep, sellingCard, confirmSell, loadCollection]);

  useEffect(() => {
    if (!machineId) return;
    // Switching machines resets the grid — the pages belong to a different pool.
    setPool([]);
    setPoolPage(1);
    setPoolHasMore(true);
    setPoolLoading(true);

    let stale = false;
    void getPool(machineId, 1)
      .then(({ prizes, hasMore }) => {
        if (stale) return;
        setPool(prizes);
        setPoolHasMore(hasMore);
      })
      .catch(() => !stale && setPool([]))
      .finally(() => !stale && setPoolLoading(false));

    return () => {
      stale = true;
    };
  }, [machineId]);

  /**
   * Keep the card list at least as tall as the machine panel, so the two columns finish on
   * the same line whenever the panel is the taller of the two. The panel's height is not
   * knowable in CSS from the other column, hence the measurement.
   *
   * The floor is a real floor, not just a guard against a mid-measurement zero: the panel
   * lost the recent-pulls feed, and matching it exactly after that cut the card grid from
   * four rows to two. The list keeps its own viewport-proportional height and only grows
   * past it to meet a taller panel.
   */
  useEffect(() => {
    const panel = panelRef.current;
    const floor = floorRef.current;
    if (!panel || !floor || tab !== "floor") return;

    const sync = () => {
      const scroller = poolScrollRef.current;
      if (!scroller) return;
      // Measured from real positions rather than by subtracting heights: the section head
      // above the list carries a bottom margin that its own height does not include, and
      // subtracting heights left the list overshooting the panel by exactly that margin.
      const target = panel.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top;
      // The list's own height, matching the CSS default — the panel can only raise it.
      const own = Math.min(Math.round(window.innerHeight * 0.74), 820);
      floor.style.setProperty("--match-panel", `${Math.max(own, Math.round(target))}px`);
    };

    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(panel);
    window.addEventListener("resize", sync);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [tab, machineId, pool.length]);

  /**
   * Load the next page when the sentinel scrolls into view.
   *
   * rootMargin pulls the trigger 600px early so the next batch is usually in place before
   * the user reaches the end — the grid grows continuously rather than stalling at the
   * bottom and then jumping.
   */
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !machineId || !poolHasMore || poolLoading || tab !== "floor") return;

    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        setPoolLoading(true);
        const next = poolPage + 1;
        void getPool(machineId, next)
          .then(({ prizes, hasMore }) => {
            // Guard against duplicates if a page arrives twice.
            setPool((cur) => {
              const seen = new Set(cur.map((p) => p.id));
              return [...cur, ...prizes.filter((p) => !seen.has(p.id))];
            });
            setPoolPage(next);
            setPoolHasMore(hasMore);
          })
          .catch(() => setPoolHasMore(false))
          .finally(() => setPoolLoading(false));
      },
      /*
       * root is the pool's own scroller on desktop, so paging is driven by scrolling the
       * LIST rather than the page. rootMargin pre-loads the next batch before the user
       * reaches the end.
       *
       * But ONLY when that element is actually a scroll container. Under 940px the
       * stylesheet gives .pool-scroll `overflow: visible` on purpose — a nested scroller on
       * a phone is worse than a long page — and an element with visible overflow does not
       * scroll. An IntersectionObserver rooted at it then measures against its full content
       * box, so the sentinel inside is permanently intersecting: load a page, still
       * intersecting, load again, forever. Measured on a 390px viewport before this fix:
       * 832 cards and climbing, page height 164,000px, never settling.
       *
       * Falling back to the viewport (null) makes paging follow the page scroll, which is
       * what the mobile layout actually does. Read from computed style rather than a width
       * media query so the two can never disagree about where the breakpoint is.
       */
      {
        root: isScrollContainer(poolScrollRef.current) ? poolScrollRef.current : null,
        rootMargin: "500px 0px",
      },
    );

    io.observe(el);
    return () => io.disconnect();
  }, [machineId, poolPage, poolHasMore, poolLoading, tab]);

  const rip = async (id: string, opts: { demo?: boolean } = {}) => {
    // Before the wallet check, so a rapid second click cannot slip past while the first is
    // still deciding what to do.
    if (ripInFlight.current) return;
    if (!isConnected) {
      setNeedsWallet(true);
      return;
    }
    ripInFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const orderId =
        onChain && !opts.demo
          ? await buy(id)
          : (await ripApi(buyerAddress, id, { demo: opts.demo })).orderId;
      if (orderId == null) return; // cancelled or failed; useBuyPack holds the reason

      resetBuy();
      setOrder({
        orderId,
        status: "CREATED",
        stage: "queued",
        ccMemo: null,
        mirrorTokenId: null,
        card: null,
        demo: opts.demo,
      });

      /**
       * Consecutive failures, not total. A blip mid-open must not count against a later one.
       *
       * Every getOrder error used to be swallowed forever with no cap and no error surface, so
       * a buyer whose order the worker never indexed — a 404 — sat watching "Still working" at
       * two requests a second, indefinitely, having already paid. Silence was the worst
       * possible answer there: they had no order id to quote and no reason to stop waiting.
       */
      let consecutiveFailures = 0;
      const startedAt = Date.now();
      // Comfortably past a 180s bridge fill plus a reveal, so this only fires on a real stall.
      const GIVE_UP_AFTER_MS = 8 * 60_000;

      poll.current = window.setInterval(async () => {
        try {
          const next = await getOrder(orderId);
          consecutiveFailures = 0;

          /**
           * Never present another wallet's order as this user's pull.
           *
           * On 20 Jul an order-id collision — the contract's counter restarts at 1 on a
           * redeploy, the database still held order 1 from the previous one — meant a buyer
           * polled /order/1 and was handed a STRANGER'S order: already minted, already
           * revealed, with a Common card attached. Their browser played that reveal as if it
           * were their pull, while their own collection sat empty. The underlying collision
           * is fixed, but nothing in the UI could have caught it, so this is the check that
           * makes the class of mistake unshowable rather than merely unlikely.
           */
          if (next.buyer && address && next.buyer.toLowerCase() !== address.toLowerCase()) {
            if (poll.current) window.clearInterval(poll.current);
            poll.current = null;
            setError(
              `Order #${orderId} belongs to a different wallet, so we will not show it as ` +
                `yours. Your payment is on chain and is refunded automatically if the pack ` +
                `cannot be opened. Please quote order #${orderId} if you need help.`,
            );
            return;
          }

          setOrder(next);

          /**
           * `done` only counts when the card is actually there.
           *
           * The reveal gate is `stage === "done" && card`, but the poll stopped on the stage
           * alone. A `done` that arrived a moment before the card row was written froze the
           * order object in a state the reveal could never fire from — sealed pack and "Still
           * working", permanently, with no recovery even once the backend filled it in.
           */
          if (next.stage === "done" && !next.card) return;

          if (next.stage === "done" || next.stage === "refunded") {
            if (poll.current) window.clearInterval(poll.current);
            poll.current = null;
            if (!opts.demo) {
              void loadCollection();
              void loadMachines();
              /**
               * Refresh the wallet balance too.
               *
               * The collection was already reloaded here, but the USDG figure in the header
               * comes from a wagmi `useReadContract` in Wallet.tsx, which caches and never
               * re-fetches on its own. So after a real open the card appeared but the balance
               * still showed the pre-purchase number until the user reloaded the page, which
               * reads as "did my money actually leave?" at exactly the wrong moment.
               *
               * Invalidating the query is how wagmi v2 expects this to be done — it re-reads
               * from the chain rather than us guessing the new figure by subtracting, which
               * would be wrong the moment a refund or a sell-back lands.
               */
              void queryClient.invalidateQueries();
            }
          }
        } catch {
          consecutiveFailures += 1;
          // A hard stall: either the worker never indexed this order, or it is long dead.
          if (consecutiveFailures >= 20 || Date.now() - startedAt > GIVE_UP_AFTER_MS) {
            if (poll.current) window.clearInterval(poll.current);
            poll.current = null;
            setError(
              `We lost track of order #${orderId} while it was opening. Your payment is on ` +
                `chain and the order will still be fulfilled or refunded automatically — but ` +
                `this page has stopped following it. Quote order #${orderId} if you need help.`,
            );
          }
        }
      }, 500);
    } catch (err) {
      setError(humanError(err, "Could not open the pack."));
    } finally {
      ripInFlight.current = false;
      setBusy(false);
    }
  };

  useEffect(() => {
    if (isConnected) setNeedsWallet(false);
  }, [isConnected]);

  // Tab title follows the section, so open tabs are distinguishable and history entries
  // read sensibly.
  useEffect(() => {
    document.title = assetId ? `${BRAND_NAME} - Card` : `${BRAND_NAME} - ${TAB_TITLE[tab]}`;
  }, [tab, assetId]);

  // An unknown path falls back to the gacha floor, so tidy the address bar to match rather
  // than leaving a URL on screen that does not correspond to what is rendered. replaceState,
  // not push, so back still leaves the site.
  useEffect(() => {
    if (assetIdForPath(window.location.pathname)) return;
    const canonical = TAB_PATH[tabForPath(window.location.pathname)];
    if (normalizePath(window.location.pathname) !== canonical) {
      window.history.replaceState({}, "", canonical);
    }
  }, []);

  // Back and forward move between sections instead of leaving the site.
  useEffect(() => {
    const onPop = () => {
      setTabState(tabForPath(window.location.pathname));
      setAssetIntent(undefined);
      setAssetId(assetIdForPath(window.location.pathname));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(
    () => () => {
      if (poll.current) window.clearInterval(poll.current);
    },
    [],
  );

  /**
   * Switching section pushes a history entry and returns to the top, the way a page load
   * would. Re-selecting the current section is a no-op rather than a duplicate entry that
   * makes the back button feel broken.
   */
  const setTab = useCallback((next: Tab) => {
    // Compare against the URL, not React state, so this stays correct without listing `tab`
    // as a dependency and without a side effect inside a state updater.
    const here = window.location.pathname;
    if (tabForPath(here) === next && !assetIdForPath(here)) return;
    window.history.pushState({}, "", TAB_PATH[next]);
    window.scrollTo({ top: 0, behavior: "auto" });
    setAssetId(null);
    setTabState(next);
  }, []);

  /**
   * Link handler for the nav. Intercepts a plain left click only, so modifier clicks and
   * middle clicks still open a real new tab the way any other link on the web does.
   */
  const navTo = (next: Tab) => (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    setTab(next);
  };

  const closeStage = () => {
    if (poll.current) window.clearInterval(poll.current);
    poll.current = null;
    setOrder(null);
    void loadCollection();
  };

  /**
   * Sell straight from the reveal.
   *
   * The stage closes first and the sale runs through the same flow the collection uses, so
   * there is one sell path rather than two that can drift apart. The collection is re-read
   * rather than trusted from state, because the card was minted seconds ago and `owned` may
   * not have caught up yet.
   */
  const sellFromReveal = useCallback(
    async (tokenId: string) => {
      closeStage();
      setTab("collection");
      const cards = await loadCollection();
      const card = cards.find((c) => c.tokenId === tokenId);
      if (card) await beginSell(card);
    },
    // closeStage is defined below and stable enough for this use; the deps that matter are
    // the two callbacks it composes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loadCollection, beginSell],
  );

  /**
   * Open a card's own page, which is where listing, offers and cancelling live.
   *
   * The Collection had no route here at all: clicking the artwork opens a details popup, and
   * the tile offered only Sell back and Withdraw. So the marketplace listing flow was fully
   * built and completely unreachable for the person who owns the card.
   */
  const openCard = (tokenId: string) => {
    window.history.pushState({}, "", assetPath(tokenId));
    window.scrollTo({ top: 0, behavior: "auto" });
    // Cleared explicitly: a stale intent from an earlier "Offer now" must not pop a dialog
    // on a card opened later by an ordinary click.
    setAssetIntent(undefined);
    setAssetId(tokenId);
    setTabState("market");
  };


  const machineIsLow = machine?.lowInventory === true;

  const ripDisabled = !machine?.available || busy || (CAN_TRANSACT && !isConnected);

  /**
   * The hero CTA scrolls to the machine picker rather than opening a pack outright. Buying
   * should happen where the price, odds and buyback rate are on screen, not from a button
   * that has none of that context next to it.
   *
   * Uses scrollIntoView rather than a computed window.scrollTo. The old version measured a
   * target with window.scrollY and called window.scrollTo, which did nothing at all: the CSS
   * had made BODY the scroll container while window.scrollTo drives document.scrollingElement
   * (html), which had nothing to scroll. The button looked dead because it was.
   *
   * The CSS root cause is fixed too (see styles.css), but scrollIntoView is kept because it
   * asks the browser to scroll whichever ancestor actually scrolls, so this survives any
   * future layout change. The sticky-header offset that motivated the manual maths is handled
   * by `scroll-margin-top` on the target instead.
   *
   * Honours prefers-reduced-motion.
   */

  return (
    <>
      {/* Nav suppressed — pokeplay's own header (with the Cards dropdown + Gacha
          button) replaces this bar now that Slabs lives inside pokeplay. */}
      {false && (
      <div className="nav-bar">
        <div className="nav-inner">
          {/* The wordmark goes home. It pointed at "floor" from when floor WAS "/", and
              kept pointing there after the gacha moved to its own route — so the one link
              every visitor treats as "take me back to the start" dropped them into a
              purchase flow instead. */}
          <a className="brand" href={TAB_PATH.home} onClick={navTo("home")} aria-label={BRAND_FULL}>
            <Mark size={30} />
            <span className="brand-word">{BRAND_NAME}</span>
          </a>
          {/*
            Flat nav, every destination visible.
            
            This was two dropdown groups. Grouping six links into two menus made the bar
            tidier and every destination one click further away, on a site with only six
            places to go — the tidiness was worth less than the directness. Nothing here
            is deep enough to need a submenu.
          */}
          <div className="nav-links">
            {/* Gacha sits first because it is what people come for, but it is styled
                like every other link — a filled button in a row of text links made the
                nav read as one advert and five afterthoughts. */}
            <a href={TAB_PATH.floor} data-active={tab === "floor"} onClick={navTo("floor")}>
              Gacha
            </a>
            <a href={TAB_PATH.collection} data-active={tab === "collection"} onClick={navTo("collection")}>
              Collection
              {owned.length > 0 && <span className="nav-count">{owned.length}</span>}
            </a>
            <a href={TAB_PATH.market} data-active={tab === "market"} onClick={navTo("market")}>
              Marketplace
            </a>
            <a href={TAB_PATH.leaders} data-active={tab === "leaders"} onClick={navTo("leaders")}>
              Leaderboards
            </a>
            <a href={TAB_PATH.token} data-active={tab === "token"} onClick={navTo("token")}>
              Token
            </a>
            <a href={TAB_PATH.how} data-active={tab === "how"} onClick={navTo("how")}>
              How it works
            </a>
          </div>
          <WalletButton
            onProfile={() => setTab("profile")}
            onSettings={() => setTab("settings")}
            onWithdraw={() => setTab("withdraw")}
            onDeposit={depositsEnabled ? () => setTab("deposit") : undefined}
            onTransfer={() => setTab("transfer")}
            onMessages={() => setTab("messages")}
            unread={unreadMessages}
          />
        </div>
      </div>
      )}

      <div className="page">
        <NetworkGuard />


        {error && (
          <div className="guard-banner">
            <div>
              <b>Something went wrong.</b> {error}
            </div>
          </div>
        )}

        {tab === "home" && (
          <>
            {/*
              The landing page. No live data anywhere on it — deliberately.
              
              An earlier version listed vault inventory and recent pulls, which meant the
              first thing a visitor saw depended on whether the API answered and whether
              anyone had opened a pack that day. A landing page that renders empty, or
              renders a $35 pull as its headline evidence, argues against the product. Card
              images are used as ILLUSTRATION here and fail soft to an empty slab, so the
              page reads the same whether or not anything loads.
            */}
            <section className="lp-hero">
              <div className="lp-hero-glow" aria-hidden="true" />

              <div className="lp-hero-copy">
                <h1 className="lp-title">{BRAND_FULL}</h1>
                <p className="lp-lede">
                  Real Pokémon cards, professionally graded and securely stored in a vault.
                  Open a pack and the card becomes yours as an on-chain token that you can
                  hold, trade, sell back, or redeem for the physical collectible.
                </p>
                <div className="hero-actions">
                  <button className="primary lg" onClick={() => setTab("floor")}>
                    Open a pack
                  </button>
                  <button className="ghost lg" onClick={() => setTab("how")}>
                    How it works
                  </button>
                </div>
              </div>

              {/* Three slabs, fanned. Illustration, not inventory — hence aria-hidden. */}
              <div className="lp-fan" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <div className={`lp-slab lp-slab-${i}`} key={i}>
                    {pool[i]?.image ? (
                      <img
                        src={pool[i].image!}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        onError={(e) => {
                          const img = e.currentTarget;
                          const fb = pool[i]?.imageFallback;
                          if (fb && img.src !== fb) img.src = fb;
                          else img.style.display = "none";
                        }}
                      />
                    ) : null}
                  </div>
                ))}
              </div>
            </section>

            {/*
              The concept, as three plain statements. Alternating sides so the eye has
              somewhere to go, and one card per row so each claim has a face.
            */}
            <section className="lp-story">
              {[
                {
                  k: "real",
                  h: "Real packs",
                  p: "Every pack is a genuine Collector Crypt pack, opened at the vault the moment you buy. The odds are theirs, published, and we do not touch them.",
                  i: 3,
                },
                {
                  k: "backed",
                  h: "Backed 1:1",
                  p: "Nothing is minted until the physical card exists. Your token is that specific card graded, vaulted and insured.",
                  i: 4,
                },
                {
                  k: "exit",
                  h: "Your decision",
                  p: "Hold it, sell it back to the vault for an instant payout, list it on the marketplace or withdraw the real card.",
                  i: 5,
                },
              ].map((row, n) => (
                <div className="lp-row" data-flip={n % 2 === 1} key={row.k}>
                  <div className="lp-row-copy">
                    <h2>{row.h}</h2>
                    <p>{row.p}</p>
                  </div>
                  <div className="lp-row-art" aria-hidden="true">
                    <div className="lp-slab lp-slab-solo">
                      {pool[row.i]?.image ? (
                        <img
                          src={pool[row.i].image!}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          onError={(e) => {
                            const img = e.currentTarget;
                            const fb = pool[row.i]?.imageFallback;
                            if (fb && img.src !== fb) img.src = fb;
                            else img.style.display = "none";
                          }}
                        />
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </section>

          </>
        )}

        {tab === "floor" && (
          <>
            {/*
              A masthead rather than a centred title. The heading names the section and
              the rule carries the eye to the machine count on the right, so the row does
              some work instead of floating a lone word over the tiles.
            */}
            <div className="gc-head" ref={machinesRef}>
              <h2>Gacha</h2>
              <span className="gc-rule" aria-hidden="true" />
              <span className="gc-head-meta">{machines.length} Gachas</span>
            </div>

            <div className="pills">
              {machines.map((m) => (
                <button key={m.id} className="pill" data-active={m.id === machineId} onClick={() => setSelected(m.id)}>
                  <span className="pill-mark">
                    <Mark size={15} />
                  </span>
                  <span className="pill-text">
                    <span className="pill-name">{machineLabel(m.id)}</span>
                    <span className="pill-price">
                      <Usdg base={m.priceUsdg} />
                    </span>
                  </span>
                </button>
              ))}
            </div>

            <div className="floor" ref={floorRef} style={{ marginTop: 18 }}>
              <div>
                <div className="gc-label-row">
                  <h2 className="gc-label">Top Hits</h2>
                  <span className="gc-rule" aria-hidden="true" />
                </div>

                <div className="pool-scroll" ref={poolScrollRef}>
                  <div className="pool">
                  {pool.length === 0 &&
                    Array.from({ length: 8 }, (_, i) => <div className="prize skeleton" key={`sk-${i}`} />)}
                  {pool.map((p) => (
                    <article
                      className="prize"
                      key={p.id}
                      style={{ ["--tier" as string]: TIER_COLOR[p.tier] }}
                      onClick={() => { setDetail(p.detail); setDetailTokenId(null); }}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setDetail(p.detail);
                          setDetailTokenId(null);
                        }
                      }}
                    >
                      <div className="prize-art">
                        {p.badge && <span className="prize-badge">{p.badge}</span>}
                        {p.image ? (
                          <img
                            src={p.image}
                            alt={p.name}
                            decoding="async"
                            // Arweave is the canonical source but can be slow; fall back to
                            // CC's CDN per-image rather than showing a hole.
                            onError={(e) => {
                              const img = e.currentTarget;
                              if (p.imageFallback && img.src !== p.imageFallback) img.src = p.imageFallback;
                              else img.style.display = "none";
                            }}
                          />
                        ) : (
                          <div className="prize-grade">{p.grade?.replace(/\D/g, "") ?? "?"}</div>
                        )}
                      </div>
                      <div className="prize-body">
                        <div className="prize-name">{p.name}</div>
                        <div className="prize-meta">
                          <span className="prize-value">{usd(p.insuredValueUsd)}</span>
                          <span className="prize-grade-label">{p.grade}</span>
                        </div>
                      </div>
                    </article>
                  ))}
                    {poolLoading &&
                      Array.from({ length: 4 }, (_, i) => <div className="prize skeleton" key={`more-${i}`} />)}
                  </div>

                  {/* Trigger for the next page; also the end-of-pool marker. */}
                  <div ref={sentinelRef} className="pool-sentinel">
                    {!poolHasMore && pool.length > 0 && <span>That's the whole pool</span>}
                  </div>
                </div>
              </div>

              {machine && (
                <aside className="panel" ref={panelRef}>
                  {/*
                    The stage: the pack at size with the machine's name and price set on the
                    same surface, full-bleed to the panel edge.

                    It used to be three stacked blocks inside one padded card — pack, then a
                    centred name, then a centred price — which is the shape every storefront
                    template ships. Reading them as one framed object instead makes the panel
                    look like a machine rather than a form, and leaves the padded body below
                    for the things you act on.

                    Our own pack art (see the .panel-pack rules), not Collector Crypt's.
                  */}
                  <div className="panel-stage">
                    <div className="panel-pack" aria-hidden="true">
                      <div className="panel-pack-art">
                        <Mark size={40} />
                      </div>
                    </div>

                    {/*
                      Price stays out of the button. It is a fact about the machine; the
                      button is an action, and someone comparing machines should not have to
                      read buttons to do it.
                    */}
                    <div className="panel-plate">
                      <div className="panel-name">{machineLabel(machine.id)}</div>
                      <div className="panel-price">
                        <Usdg base={totalWithFee(machine.id, machine.priceUsdg)} />
                        <span className="panel-price-unit">USDG</span>
                      </div>
                    </div>
                  </div>

                  <div className="panel-cta">
                    {/* Turbo removed at the operator's request. Collector Crypt's own
                        auto-sell-back is untouched on their side; we simply never ask for it,
                        which is the same as the switch being permanently off. */}
                    {machineIsLow && (
                      <p className="turbo-low-hint">
                        Low on commons — this machine may not open right now. Nothing is charged
                        if it cannot.
                      </p>
                    )}

                    {/* The fee is disclosed HERE, at the point of purchase, because this is
                        where the commitment happens. Showing a bare base price on the button
                        and letting the wallet reveal a larger number is drip pricing, and an
                        unfair commercial practice under EU consumer law. The pack tiles above
                        stay at the base price; this is the total the wallet will ask for. */}
                    {machine.available && serviceFeeFor(machine.id) !== "0" && (
                      <div className="fee-breakdown">
                        <div>
                          <span>Pack</span>
                          <span><Usdg base={machine.priceUsdg} /></span>
                        </div>
                        <div>
                          <span>Service fee</span>
                          <span><Usdg base={serviceFeeFor(machine.id)} /></span>
                        </div>
                        <div className="fee-total">
                          <span>Total</span>
                          <span><Usdg base={totalWithFee(machine.id, machine.priceUsdg)} /></span>
                        </div>
                      </div>
                    )}

                    <button
                      className="rip-button"
                      disabled={ripDisabled}
                      onClick={() =>
                        // Ask before taking the money. CC only reports a low machine when the
                        // open fails, which is after the buyer has paid and after we have paid
                        // to bridge it, so the choice belongs here.
                        machineIsLow ? setLowNotice(true) : rip(machine.id)
                      }
                    >
                      {!machine.available
                        ? "Restocking"
                        : CAN_TRANSACT && !isConnected
                          ? "Connect wallet"
                          : busy
                            ? "Opening…"
                            : "Open pack"}
                    </button>

                    {/* Below the real button and styled as a link, not a second button.
                        Free run-through of the whole flow, and the only way to see the
                        reveal without a wallet — useful, but not the choice being offered. */}
                    <button
                      className="demo-link"
                      disabled={busy}
                      onClick={() => rip(machine.id, { demo: true })}
                    >
                      Try a demo pack
                    </button>
                  </div>

                  <div className="panel-section">
                    <div className="odds-head">
                      <span className="eyebrow">Odds</span>
                    </div>

                    <div className="odds-bar" role="img" aria-label="Tier distribution">
                      {(["common", "uncommon", "rare", "epic"] as Tier[]).map((t) => {
                        const pct = (machine.odds[t] ?? 0) * 100;
                        return pct > 0 ? (
                          <span
                            key={t}
                            className="odds-seg"
                            style={{ width: `${pct}%`, background: TIER_COLOR[t] }}
                            title={`${t} ${pct.toFixed(0)}%`}
                          />
                        ) : null;
                      })}
                    </div>

                    {/*
                      Four spec cells, not chips. The percentage leads and the tier name sits
                      under it in caps, each cell capped by its own tier colour — the bar
                      above shows the shape, this row gives the numbers somewhere to line
                      up so two machines can be compared column by column. The value bands
                      live on How it works, where someone actually comparing them will be.
                    */}
                    <div className="odds-legend">
                      {(["common", "uncommon", "rare", "epic"] as Tier[]).map((t) => (
                        <span className="odds-chip" key={t} style={{ ["--tier" as string]: TIER_COLOR[t] }}>
                          <b>{((machine.odds[t] ?? 0) * 100).toFixed(0)}%</b>
                          <em>{t}</em>
                        </span>
                      ))}
                    </div>
                  </div>

                </aside>
              )}
            </div>

          </>
        )}

        {tab === "collection" && (
          <>
            {/* Centred, matching the gacha and leaderboard headings — this one has no
                trailing action, so space-between would park it on the left corner. */}
            <div className="section-head centered">
              <h2>Your collection</h2>
            </div>

            {!isConnected ? (
              <ConnectPrompt
                title="Connect your wallet"
                body="Your collection lives with your wallet. Connect to see the cards you own."
              />
            ) : owned.length === 0 ? (
              <div className="empty">Open a pack to get started.</div>
            ) : (
              <div className="grid">
                {owned.map((c) => {
                  const tier = tierFor(c);
                  const sellState = sellStatus[c.tokenId];
                  // Decided by the server, which knows the ceiling. The bundle never sees it —
                  // publishing the threshold told anyone where manual review begins.
                  const overValueLimit = c.overValueLimit === true;
                  return (
                    <div className="owned" key={c.tokenId} style={{ ["--tier" as string]: TIER_COLOR[tier] }}>
                      {/**
                        * The artwork opens the details popup, NOT the whole card.
                        *
                        * Sell back and Withdraw live in the same tile, and a card-wide handler
                        * would fight them — every attempt to sell would also open a dialog over
                        * the top. Scoping the click to the image keeps both behaviours
                        * unambiguous without needing stopPropagation on every button.
                        */}
                      <div
                        className="owned-art owned-art-clickable"
                        role="button"
                        tabIndex={0}
                        title="View card details"
                        onClick={() => { setDetail(ownedToDetail(c)); setDetailTokenId(c.tokenId); }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setDetail(ownedToDetail(c));
                            setDetailTokenId(c.tokenId);
                          }
                        }}
                      >
                        {c.imageFront ? (
                          <img
                            src={c.imageFront}
                            alt={c.name ?? "card"}
                            loading="lazy"
                            decoding="async"
                            onError={(e) => {
                              const img = e.currentTarget;
                              if (c.imageFrontFallback && img.src !== c.imageFrontFallback) {
                                img.src = c.imageFrontFallback;
                              } else {
                                img.style.display = "none";
                              }
                            }}
                          />
                        ) : (
                          <div className="card-art-mark">{c.grade?.replace(/\D/g, "") ?? "?"}</div>
                        )}
                        {/* Grade rides on the art as a tier-coloured pill rather than sitting in
                            a meta row: it belongs to the slab, and moving it here frees the body
                            to be just name + value. */}
                        {c.grade && <span className="owned-grade">{c.grade}</span>}
                      </div>
                      <div className="card-body">
                        <div className="card-name">{displayCardName(c.name)}</div>
                        <div className="owned-value">
                          <Usdg base={c.insuredValueUsd} />
                        </div>
                      </div>
                      {/* A card with a sell-back in flight shows that instead of the actions:
                          it is no longer in the wallet, so offering to sell it again would be
                          a lie. Withdraw is a live button that opens the unavailable dialog,
                          rather than a greyed-out control whose tooltip never shows on touch. */}
                      {sellState && sellState.stage !== "cancelled" ? (
                        <div className="owned-selling" data-stage={sellState.stage}>
                          <span>{SELL_STAGE_LABEL[sellState.stage]}</span>
                          {sellState.stage === "paid" ? (
                            <strong><Usdg base={sellState.payoutUsdg} /></strong>
                          ) : (
                            <small>You will receive <Usdg base={sellState.payoutUsdg} /></small>
                          )}
                        </div>
                      ) : (
                        <div className="owned-actions">
                          {/* Over the value ceiling, the button stays clickable and opens a
                              dialog that refuses. Disabling it instead would leave a user
                              with no idea why, which is how the dead Sell back / Withdraw
                              buttons got shipped in the first place. */}
                          {/**
                            * Switched OFF stays CLICKABLE, and says so.
                            *
                            * A disabled button with a tooltip explains nothing on touch and
                            * reads as broken on desktop — which is how the dead Sell back and
                            * Withdraw buttons shipped the first time. The feature being off is
                            * a sentence worth showing, not a greyed-out control.
                            *
                            * Still genuinely disabled for a card whose own window has closed:
                            * that is about the card, not the feature, and the tooltip is
                            * accurate for it.
                            */}
                          <button
                            className="primary"
                            disabled={sellCap.enabled && (overValueLimit ? busy : !c.sellable || busy)}
                            title={
                              !sellCap.enabled
                                ? undefined
                                : overValueLimit
                                  ? cardValueLimitMessage()
                                  : !c.sellable
                                    ? "The sell-back window for this card has closed"
                                    : undefined
                            }
                            onClick={() =>
                              !sellCap.enabled || overValueLimit
                                ? setValueBlocked(c)
                                : void beginSell(c)
                            }
                          >
                            Sell back
                          </button>
                          {/* Live button, not a disabled one. Withdrawals are not built yet, so
                              it opens the unavailable dialog rather than sitting greyed out with
                              a tooltip nobody sees on touch. */}
                          {/* Listing lives on the card's own page, alongside cancel, offers
                              and the price breakdown. Sending the user there rather than
                              duplicating the approve-then-list flow in a second place, which
                              is how the two would drift apart. */}
                          <button className="ghost" disabled={busy} onClick={() => openCard(c.tokenId)}>
                            List
                          </button>
                          {/* Withdraw WORKS now. This used to open the "unavailable" dialog,
                              with a comment saying withdrawals were not built — true when it
                              was written, stale since the relayer shipped and was enabled. A
                              card over the value ceiling still refuses out loud rather than
                              sitting greyed out. */}
                          <button
                            className="ghost owned-withdraw"
                            disabled={busy}
                            onClick={() =>
                              !withdrawEnabled || overValueLimit
                                ? setValueBlocked(c)
                                : setTabState("withdraw")
                            }
                          >
                            Withdraw
                          </button>
                        </div>
                      )}
                      {sellState?.stage === "cancelled" && (
                        <p className="owned-sell-error">
                          That sell-back did not go through, so the card is still yours.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* The value ceiling. Says it is not possible and promises nothing about when
                that changes, because nothing is scheduled. */}
            {valueBlocked && (
              <div className="stage" onClick={() => setValueBlocked(null)}>
                <div onClick={(e) => e.stopPropagation()}>
                  <div className="ap-dialog">
                    <h3>Temporarily unavailable</h3>
                    <p>{cardValueLimitMessage()}</p>
                    <p className="muted">
                      Your card stays in your collection and nothing has changed.
                    </p>
                    <div className="ap-dialog-actions">
                      <button className="primary" onClick={() => setValueBlocked(null)}>
                        Close
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {sellingCard && (
              <div className="stage" onClick={() => { setSellingCard(null); resetSell(); }}>
                <div onClick={(e) => e.stopPropagation()}>
                  <div className="ap-dialog">
                    <h3>Sell back {displayCardName(sellingCard.name) || "this card"}</h3>

                    {sellStep.kind === "quoting" && <p>Getting today's price…</p>}

                    {sellStep.kind === "error" && (
                      <>
                        <p className="sell-error">{sellStep.message}</p>
                        <div className="ap-dialog-actions">
                          <button className="ghost" onClick={() => { setSellingCard(null); resetSell(); }}>
                            Close
                          </button>
                        </div>
                      </>
                    )}

                    {sellStep.kind === "quoted" && (
                      <>
                        <p>
                          You will receive <Usdg base={sellStep.quote.payoutUsdg} /> in USDG.
                          {" "}Once it is sold this cannot be undone.
                        </p>
                        <div className="ap-dialog-actions">
                          <button className="ghost" onClick={() => { setSellingCard(null); resetSell(); }}>
                            Cancel
                          </button>
                          <button className="primary" onClick={() => void finishSell()}>
                            Sell back
                          </button>
                        </div>
                      </>
                    )}

                    {/**
                      * The card is listed. Selling back would leave a listing nobody can fill,
                      * so this offers the fix instead of a dead end: Delist opens the card's
                      * own page, where cancel already lives beside the price and the offers.
                      */}
                    {sellStep.kind === "listed" && (
                      <>
                        <p className="sell-error">
                          This card is listed on the marketplace. Selling it back would leave a
                          listing that nobody can buy, so delist it first — then sell back.
                        </p>
                        <p className="muted">
                          Nothing has changed. The card is still yours and still for sale.
                        </p>
                        <div className="ap-dialog-actions">
                          <button className="ghost" onClick={() => { setSellingCard(null); resetSell(); }}>
                            Close
                          </button>
                          <button
                            className="primary"
                            onClick={() => {
                              const id = sellStep.tokenId;
                              setSellingCard(null);
                              resetSell();
                              openCard(id);
                            }}
                          >
                            Delist it
                          </button>
                        </div>
                      </>
                    )}

                    {sellStep.kind === "transferring" && (
                      <p>Confirm in your wallet. Do not close this window.</p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Sell-back progress as a popup, not just the inline card indicator, which was easy
                to miss. Shows the live stage while the sale runs and the payout when done. */}
            {(() => {
              const active = Object.values(sellStatus).find(
                (s) => s.stage !== "cancelled" && !dismissedSells.has(s.tokenId),
              );
              if (!active) return null;
              const idx = SELL_STAGE_INDEX[active.stage];
              const done = active.stage === "paid";
              const dismiss = () =>
                setDismissedSells((cur) => new Set(cur).add(active.tokenId));
              return (
                <div className="stage" onClick={dismiss}>
                  <div className="stage-inner stage-card" onClick={(e) => e.stopPropagation()}>
                    <div className="eyebrow">{done ? "Sold back" : "Selling back"}</div>
                    <div className="stages">
                      {SELL_STEPS.map((st, i) => (
                        <div
                          key={st.key}
                          className="stage-row"
                          data-state={i < idx ? "done" : i === idx ? "active" : "idle"}
                        >
                          <span className="dot" />
                          {st.label}
                        </div>
                      ))}
                    </div>
                    <p className="sell-modal-payout">
                      {done ? (
                        <>
                          You received <strong><Usdg base={active.payoutUsdg} /></strong>
                        </>
                      ) : (
                        <>
                          You will receive <Usdg base={active.payoutUsdg} />
                        </>
                      )}
                    </p>
                    {done ? (
                      <button className="primary" onClick={dismiss}>
                        Done
                      </button>
                    ) : (
                      <p className="muted sell-modal-note">
                        This keeps going even if you close it.
                      </p>
                    )}
                  </div>
                </div>
              );
            })()}
          </>
        )}

        {tab === "market" &&
          (assetId ? (
            <AssetPage
              tokenId={assetId}
              intent={assetIntent}
              onIntentConsumed={() => setAssetIntent(undefined)}
              onBack={() => {
                window.history.pushState({}, "", TAB_PATH.market);
                setAssetIntent(undefined);
                setAssetId(null);
              }}
            />
          ) : (
            <Marketplace
              onOpen={(tokenId, intent) => {
                window.history.pushState({}, "", assetPath(tokenId));
                window.scrollTo({ top: 0, behavior: "auto" });
                setAssetIntent(intent);
                setAssetId(tokenId);
              }}
              owned={owned.map((c) => ({
                tokenId: c.tokenId,
                name: c.name,
                grade: c.grade,
                insuredValueUsd: c.insuredValueUsd,
                imageFront: c.imageFront,
                tier: c.tier,
              }))}
              onList={openCard}
            />
          ))}

        {tab === "how" && <HowItWorks depositsEnabled={depositsEnabled} machines={machines} machine={machine} />}

        {tab === "leaders" && <Leaderboard />}

        {tab === "token" && <TokenPage />}

        {tab === "messages" && (
          <Messages
            onOpenCard={(tokenId) => {
              window.history.pushState({}, "", assetPath(tokenId));
              setAssetIntent(undefined);
              setAssetId(tokenId);
              setTabState("market");
            }}
          />
        )}

        {tab === "profile" && <ProfilePage onWithdraw={() => setTab("withdraw")} />}
        {tab === "settings" && <SettingsPage />}
        {tab === "withdraw" && <WithdrawPage onSettings={() => setTab("settings")} />}
        {/**
          * LAZY, deliberately. The deposit page pulls in @solana/web3.js, which added ~55 KB
          * gzipped to the main bundle — paid by every visitor, for a page most never open.
          * Split out, it is fetched only when someone actually goes to deposit.
          */}
        {/* Transfer is a plain ERC-721 send from the user's own wallet, so it needs no
            capability gate — it works whenever the mirror contract does. */}
        {tab === "transfer" && (
          <Suspense fallback={<p className="dep-note">Loading…</p>}>
            <TransferPage />
          </Suspense>
        )}

        {tab === "deposit" && (
          <Suspense fallback={<p className="dep-note">Loading…</p>}>
            <DepositPage />
          </Suspense>
        )}

        {/* Suppressed: pokeplay's own Footer renders on /cards now (see Shell in
            src/App.tsx), so the section's own footer would double up. */}
        {false && <SiteFooter />}
      </div>

      {needsWallet && (
        <div className="stage" onClick={() => setNeedsWallet(false)}>
          <div onClick={(e) => e.stopPropagation()}>
            <ConnectPrompt
              title="Connect to open a pack"
              body="Packs are tied to your wallet, so you'll need one connected before opening, demo packs included."
            />
          </div>
        </div>
      )}

      {detail && (
        <CardDetails
          card={detail}
          tokenId={detailTokenId}
          onClose={() => { setDetail(null); setDetailTokenId(null); }}
        />
      )}

      {/**
        * A machine too low on commons to open.
        *
        * This used to offer "Continue in Turbo" as the way through, because Collector Crypt
        * keeps a low machine playable by auto-selling commons back into the vault. With turbo
        * removed there is no way through, so it says so plainly rather than implying one.
        */}
      {lowNotice && (
        <div className="stage" onClick={() => setLowNotice(false)}>
          <div onClick={(e) => e.stopPropagation()}>
            <div className="ap-dialog">
              <h3>This machine is low on commons</h3>
              <p>
                {machine?.commonsLeft != null
                  ? `Only ${machine.commonsLeft} common cards are left, so the vault will not open it right now. `
                  : "The vault will not open this machine right now. "}
                Try another machine, or come back after a restock. Nothing has been charged.
              </p>
              <div className="ap-dialog-actions">
                <button className="primary" onClick={() => setLowNotice(false)}>
                  Got it
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <BuySteps step={buyStep} onDismiss={resetBuy} />
      {order && (
        <RipStage
          order={order}
          sellRatePct={machine?.userRatePct ?? null}
          machine={machine ?? null}
          onSell={
            !order.demo && order.mirrorTokenId && sellCap.enabled
              ? () => void sellFromReveal(order.mirrorTokenId!)
              : undefined
          }
          onClose={closeStage}
          /**
           * Open another of THE SAME KIND.
           *
           * This dropped the demo flag, so "Open another" after a free demo pull started a
           * real purchase — one click from a demo to spending $1,000 on the Grail machine.
           * The flag is read off the order being shown, so a demo repeats as a demo and a
           * real pack repeats as a real pack.
           */
          onAgain={() => {
            const id = machineId;
            const wasDemo = order.demo === true;
            closeStage();
            if (id) void rip(id, { demo: wasDemo });
          }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ footer */

/*
 * Social links live here so adding one is a single edit in a single place.
 *
 * An empty string renders the icon greyed and non-navigating rather than as a live link
 * to nowhere: a "#" href looks clickable, does nothing, and is indistinguishable from a
 * broken link. Fill these in and they become real links with no other change.
 */
const SOCIALS: { key: string; label: string; href: string; title: string; path: string }[] = [
  {
    key: "x",
    label: "on X",
    href: "https://x.com/pokeplayrh",
    title: "@pokeplayrh",
    path: "M17.53 3h3.06l-6.69 7.64L21.75 21h-6.16l-4.83-6.3L5.24 21H2.18l7.15-8.17L2.25 3h6.32l4.36 5.77L17.53 3z",
  },
];

function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-top">
        {/* Icon-only links carry their own aria-label: a link whose only content is an svg
            is announced as "link" and nothing else without one. */}
        {SOCIALS.map((sc) =>
          sc.href ? (
            <a
              key={sc.key}
              className="footer-social"
              href={sc.href}
              target="_blank"
              rel="noreferrer"
              aria-label={`${BRAND_NAME} ${sc.label}`}
              title={sc.title}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d={sc.path} />
              </svg>
            </a>
          ) : (
            <span
              key={sc.key}
              className="footer-social"
              data-pending="true"
              aria-label={sc.title}
              title={sc.title}
              role="img"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d={sc.path} />
              </svg>
            </span>
          ),
        )}
      </div>

      <p className="footer-legal">
        <span className="footer-logo"><Mark size={20} /></span>© 2026 {BRAND_NAME}. All rights
        reserved.
      </p>
    </footer>
  );
}
