import { displayCardName } from "./cardName.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { getListings, type Listing, type ListingSort } from "./client.ts";
import usdgIcon from "/slabs/usdg.png";

const TIER_COLOR: Record<Listing["card"]["tier"], string> = {
  common: "#7c8598",
  uncommon: "#3fa877",
  rare: "#4a8fd4",
  epic: "#b06fe0",
};

const SORTS: { key: ListingSort; label: string }[] = [
  { key: "newest", label: "List date: newest first" },
  { key: "price-low", label: "Price: low to high" },
  { key: "price-high", label: "Price: high to low" },
  { key: "value-high", label: "Insured value: high to low" },
];

const money = (base: string) =>
  (Number(base) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

const ago = (t: number) => {
  const mins = Math.max(1, Math.round((Date.now() - t) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
};

function ListingCard({
  listing,
  onBuy,
  onOpen,
}: {
  listing: Listing;
  onBuy: (l: Listing) => void;
  /** `intent` lets a tile deep-link straight into the offer dialog on the card's page. */
  onOpen: (tokenId: string, intent?: "offer") => void;
}) {
  const c = listing.card;
  // How the ask compares to the vault's own valuation. The single most useful number when
  // deciding whether a listing is a bargain, so it goes on the card rather than a detail view.
  const vsInsured = Math.round((Number(listing.priceUsdg) / Number(c.insuredValueUsd)) * 100);

  return (
    <article
      className="listing"
      style={{ ["--tier" as string]: TIER_COLOR[c.tier] }}
      onClick={() => onOpen(listing.tokenId)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(listing.tokenId);
        }
      }}
    >
      <div className="listing-art">
        {/**
          * NO `loading="lazy"` HERE — and not in any card image inside a nested scroller.
          *
          * These tiles live in `.market-scroll`, an overflow:auto container. Chrome resolves
          * lazy-loading against the NEAREST SCROLLING ANCESTOR, so a tile on the first screen
          * of an inner scroller that is never scrolled never has its fetch issued at all.
          * Observed live on this exact grid: correct `src`, `complete: false`, `currentSrc: ""`,
          * still blank after scrolling the page — and it loaded instantly (706px) the moment
          * `src` was re-assigned. The URL was never the problem.
          *
          * The same applies to `.pool-scroll`, `.feed`, `.stage`, `.cd-body` and
          * `.market-picker-grid`. Lazy is still correct on the collection and account grids,
          * which scroll with the PAGE. Adding it back here brings back blank cards.
          */}
        {c.image ? (
          <img
            src={c.image}
            alt={c.name}
            decoding="async"
            onError={(e) => {
              const img = e.currentTarget;
              if (c.imageFallback && img.src !== c.imageFallback) img.src = c.imageFallback;
              else img.style.display = "none";
            }}
          />
        ) : (
          <div className="listing-blank">{c.grade}</div>
        )}
        <span className="listing-badge">Listed</span>
        {!listing.fillable && <span className="listing-stale">Unavailable</span>}
      </div>

      <div className="listing-body">
        <div className="listing-name">{displayCardName(c.name)}</div>

        {/* The grade chip and the seller address both lived here and both came out: the grade
            repeats what the card art already shows, and a raw 0x address is noise on a tile
            whose job is name, price and value. Both are still on the card's own page, where
            there is room for them to mean something. */}
        {c.year && (
          <div className="listing-tags">
            <span className="listing-tag">{c.year}</span>
          </div>
        )}

        <div className="listing-price-row">
          <span className="listing-price">
            <img className="usdg-mark" src={usdgIcon} alt="USDG" />
            {money(listing.priceUsdg)}
          </span>
          <span className={`listing-vs${vsInsured <= 100 ? " under" : ""}`}>{vsInsured}% of insured</span>
        </div>

        <div className="listing-foot">
          <span>{ago(listing.listedAt)}</span>
        </div>

        <div className="listing-actions">
          <button
            className="listing-buy"
            disabled={!listing.fillable}
            onClick={(e) => {
              e.stopPropagation();
              onBuy(listing);
            }}
          >
            {listing.fillable ? "Buy now" : "Unavailable"}
          </button>

          {/**
            * Offer opens the card's own page with the offer dialog already up, rather than
            * duplicating the offer form here.
            *
            * That path already handles the USDG allowance, waits for each receipt, checks
            * whether the transaction actually succeeded, and refuses a bid larger than the
            * wallet's balance. A second implementation on this tile would be a second place
            * for all of that to be wrong — which is exactly how the card detail ended up
            * built two different ways, one of them returning null.
            *
            * Still offerable when the listing is stale: an unfillable ASK says nothing about
            * whether the owner would take a bid.
            */}
          <button
            className="listing-offer"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(listing.tokenId, "offer");
            }}
          >
            Offer now
          </button>
        </div>
      </div>
    </article>
  );
}

export function Marketplace({
  onOpen,
  owned = [],
  onList,
}: {
  /** `intent` lets a tile deep-link straight into the offer dialog on the card's page. */
  onOpen: (tokenId: string, intent?: "offer") => void;
  /** The connected wallet's cards, so it can list one without leaving this page. */
  owned?: {
    tokenId: string;
    name: string | null;
    grade: string | null;
    insuredValueUsd: string | null;
    imageFront: string | null;
    tier: string | null;
  }[];
  onList?: (tokenId: string) => void;
}) {
  const { isConnected } = useAccount();
  const [listings, setListings] = useState<Listing[]>([]);
  const [, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<ListingSort>("newest");
  const [search, setSearch] = useState("");
  const [picking, setPicking] = useState(false);
  // Only cards not already listed. A listed card is managed from its own page, not re-listed.
  const sellable = owned.filter((c) => !listings.some((l) => l.tokenId === c.tokenId));
  const sentinel = useRef<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

  const load = useCallback(
    async (p: number, replace: boolean) => {
      setLoading(true);
      try {
        const res = await getListings({ sort, search, page: p, pageSize: 12 });
        setListings((cur) => {
          if (replace) return res.listings;
          const seen = new Set(cur.map((l) => l.tokenId));
          return [...cur, ...res.listings.filter((l) => !seen.has(l.tokenId))];
        });
        setTotal(res.total);
        setHasMore(res.hasMore);
        setPage(p);
      } catch {
        // Stop paging on failure. Without this the infinite-scroll observer re-fires the
        // moment loading clears — and on an empty grid the sentinel is always in view, so a
        // failing fetch becomes an unbounded retry loop against the same broken request.
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    },
    [sort, search],
  );

  // Debounce the search so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => void load(1, true), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || loading) return;
    const io = new IntersectionObserver(
      (e) => e[0]?.isIntersecting && void load(page + 1, false),
      // root null = the viewport. The list scrolls with the page now, so rooting this on the
      // old container would mean the sentinel never intersected and infinite scroll would stop.
      { root: null, rootMargin: "500px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [load, page, hasMore, loading]);

  return (
    <>
      {/* Centred, and without the listing count: "0 cards listed" is the first thing a
          visitor read on an empty marketplace, which announces emptiness rather than the
          page. The grid below already says how many there are. */}
      <div className="section-head centered">
        <h2>Marketplace</h2>
      </div>

      {/**
        * One button, opening a picker of the wallet's own cards.
        *
        * Listing was reachable only from a card's own page and nothing linked to it, so the
        * flow existed and no owner could find it. The marketplace is where someone thinks "I
        * want to sell this", so the route starts here as well as in the collection — but as a
        * deliberate action rather than a row of chips competing with the listings grid.
        *
        * Cards already listed are filtered out: they appear in the grid below, with cancel and
        * price controls on their own page.
        */}
      {isConnected && sellable.length > 0 && onList && (
        <button className="market-sell-cta" onClick={() => setPicking(true)}>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
          Sell a card
          <span>{sellable.length}</span>
        </button>
      )}

      {picking && onList && (
        <div className="stage" onClick={() => setPicking(false)}>
          <div className="market-picker" onClick={(e) => e.stopPropagation()}>
            <div className="market-picker-head">
              <h3>Choose a card to list</h3>
              <button className="market-picker-close" onClick={() => setPicking(false)} aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none">
                  <path d="M7 7l10 10M17 7L7 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <div className="market-picker-grid">
              {sellable.map((c) => (
                <button
                  key={c.tokenId}
                  className="market-picker-card"
                  style={{ ["--tier" as string]: TIER_COLOR[(c.tier ?? "common").toLowerCase() as Listing["card"]["tier"]] ?? TIER_COLOR.common }}
                  onClick={() => { setPicking(false); onList(c.tokenId); }}
                >
                  <span className="market-picker-art">
                    {c.imageFront ? (
                      <img src={c.imageFront} alt="" decoding="async" />
                    ) : (
                      <span className="market-picker-blank">{c.grade ?? "?"}</span>
                    )}
                    {c.grade && <span className="market-picker-grade">{c.grade}</span>}
                  </span>
                  <span className="market-picker-body">
                    <span className="market-picker-name">{displayCardName(c.name)}</span>
                    <span className="market-picker-value">
                      <img className="usdg-mark" src={usdgIcon} alt="" />
                      {money(c.insuredValueUsd ?? "0")}
                    </span>
                    <span className="market-picker-go">Choose to list</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="market-controls">
        <div className="market-search">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="6.4" stroke="currentColor" strokeWidth="1.7" />
            <path d="M15.8 15.8L20 20" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by card name"
            aria-label="Search listings"
          />
          {search && (
            <button className="market-clear" onClick={() => setSearch("")} aria-label="Clear search">
              ✕
            </button>
          )}
        </div>

        <select
          className="market-sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as ListingSort)}
          aria-label="Sort listings"
        >
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <div className="market-scroll" ref={scroller}>
        <div className="market-grid">
          {listings.map((l) => (
            <ListingCard key={l.tokenId} listing={l} onBuy={(x) => onOpen(x.tokenId)} onOpen={onOpen} />
          ))}
          {loading && Array.from({ length: 4 }, (_, i) => <div className="listing skeleton" key={`sk-${i}`} />)}
        </div>

        {!loading && listings.length === 0 && (
          <div className="empty">
            {search ? `No listings match "${search}".` : "Nothing listed yet."}
          </div>
        )}

        <div ref={sentinel} className="pool-sentinel">
          {!hasMore && listings.length > 0 && <span>End of listings</span>}
        </div>
      </div>

    </>
  );
}
