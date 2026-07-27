/**
 * API client with two backends, chosen at build time.
 *
 *   VITE_API_URL set   -> talk to the real worker API over HTTP
 *   VITE_API_URL unset -> run a self-contained mock in the browser
 *
 * The second mode exists so a static build can be published to any host — S3, Netlify,
 * Vercel, a plain nginx directory — and the flow is fully clickable with no server behind
 * it. That makes the design shareable long before the worker is deployed.
 *
 * The real worker CANNOT be static: it holds keys, listens for on-chain events and runs a
 * fulfilment queue, so it needs a long-lived process on a server. Set VITE_API_URL to point
 * this frontend at it once it exists.
 */

import { createPublicClient, http as viemHttp, parseAbi } from "viem";
import { CONTRACTS, robinhoodChain } from "./chain.ts";
export { displayCardName } from "./cardName.ts";

const RH_RPC_URL = robinhoodChain.rpcUrls.default.http[0]!;

export type TierRange = { start: number; end: number };

export type Machine = {
  id: string;
  name: string;
  priceUsdg: string;
  available: boolean;
  packsRemaining: number | null;
  odds: Record<string, number>;
  /** Insured-value band per tier, in whole USD. Differs per machine. */
  tierRanges: Record<string, TierRange>;
  instantBuybackPct: number;
  userRatePct: number;
  /**
   * Collector Crypt refuses a normal open once a machine runs short of COMMONS, and suggests
   * turbo instead — a turbo pull auto-sells its common straight back into the vault, so it
   * does not deplete the tier the machine is short of. See docs/turbo-mode-analysis.md.
   */
  lowInventory?: boolean;
  commonsLeft?: number | null;
};

export type Card = {
  solanaMint: string;
  /**
   * Set where the card is created, using the MACHINE's own value bands.
   *
   * It cannot be derived from insured value alone: $500 is epic in the $50 machine and
   * merely uncommon in the $250 one, whose epic band starts at $2000. Recomputing it against
   * a fixed table is exactly the bug that showed $500 pulls as epic on every pack.
   */
  tier: Prize["tier"];
  name: string | null;
  grade: string | null;
  certNumber: string | null;
  insuredValueUsd: string | null;
  sellWindowEndsAt: number;
  /** Slab front (PSA label + card art). CC metadata files[0]. */
  imageFront: string | null;
  /** Slab back. CC metadata files[1] — the reveal flips from this to the front. */
  imageBack: string | null;
  imageFrontFallback: string | null;
  imageBackFallback: string | null;
  year: string | null;
  category: string | null;
};

export type Order = {
  orderId: number;
  /** Who the order belongs to. Checked before a reveal is shown as the user's own. */
  buyer?: string;
  status: string;
  stage: "queued" | "bridging" | "opening" | "revealing" | "done" | "retrying" | "refunded";
  ccMemo: string | null;
  mirrorTokenId: string | null;
  card: Card | null;
  /** True for a simulated pull: no payment, no custody, no mirror token. */
  demo?: boolean;
};

export type OwnedCard = Card & {
  orderId: number;
  tokenId: string;
  state: string;
  sellable: boolean;
  /** Server-decided: this card is above the ceiling. The value itself is never sent. */
  overValueLimit?: boolean;
  ccOpenMemo: string | null;
};

export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "");

export const IS_MOCK = !API_BASE;

const CC_GACHA_API = "https://gacha.collectorcrypt.com/api";

/* ------------------------------------------------------------------ http mode */

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/* ------------------------------------------------------------------ mock mode */

/**
 * Browser-side mock. Mirrors the real API's shapes and the real pipeline's stage sequence,
 * including the asynchronous reveal, so the UI is exercised the same way in both modes.
 *
 * Card values are drawn against Collector Crypt's PUBLISHED odds and tier ranges for the
 * $50 machine, so the distribution you see demoing is roughly the real one — mostly commons.
 */
/**
 * Our spread on a sell-back, in percentage points. Collector Crypt quotes `instantBuyback`
 * and we pass on five points less; that margin is where this product earns, since packs
 * are sold at Collector Crypt's price with no markup.
 *
 * MUST track the worker's SPREAD_BPS (500). It is a second definition of one number in a
 * second codebase, which is the exact shape of bug that has cost real money here — the
 * two sides disagreeing while each looks correct in its own file. Change both together,
 * in the same commit, always.
 */
export const SPREAD_PCT = 5;

/**
 * Service fee added to every pack, in USDG base units (6dp).
 *
 * Covers the bridge: moving a payment to Solana costs a FIXED ~$2.74 in deBridge protocol
 * fees and gas regardless of pack size, which the 5pp sell-back spread alone does not cover
 * on the cheaper tiers. See docs/verification/verification-results.md.
 *
 * The pack tiles show the base price; this is disclosed at the point of purchase, where the
 * total the wallet will actually charge is shown broken down. It must never be silently
 * folded into a headline price.
 */
/**
 * Collector Crypt parity: no service fee on any pack. A $50 pack costs 50 USDG.
 *
 * This is a deliberate loss on the core loop, not an oversight, so the numbers it
 * overrides are kept here rather than deleted. The bridge to Solana costs a FIXED
 * ~$2.74 per pack regardless of size, and the previous build charged $3 on the $50
 * and $100 to cover it. Measured break-even sell-through with no fee was:
 *
 *   $50    impossible  (spread revenue $2.75 barely exceeds the $2.06 return leg)
 *   $100   93%
 *   $250   23%
 *   $1000  5%
 *
 * With parity pricing the pack itself recovers nothing, so the five point sell-back
 * spread and the token's trading fees are what carry the bridge cost. The operator
 * accepts running at a loss on opens by choice.
 *
 * Keep this map EMPTY. Adding an entry silently reintroduces a markup and makes the
 * headline parity promise on the site untrue.
 */
const SERVICE_FEE_BY_MACHINE: Record<string, string> = {};

export const serviceFeeFor = (machineId: string): string => SERVICE_FEE_BY_MACHINE[machineId] ?? "0";

/** What the wallet will actually be asked for. */
export const totalWithFee = (machineId: string, priceUsdg: string) =>
  (BigInt(priceUsdg) + BigInt(serviceFeeFor(machineId))).toString();

/** The machines we offer. Collector Crypt lists 39; these are the Pokemon tiers. */
/* Ordered by price, cheapest first: 50, 100, 250, 1000. The Water pack sat at the end
   because it was added last, which put a $100 machine after a $1000 one. */
const OFFERED = ["pokemon_50", "water_100", "pokemon_250", "pokemon_1000"] as const;

/**
 * Fallback only, used if Collector Crypt's machines endpoint is unreachable. Values copied
 * from that endpoint on 2026-07-19 rather than invented, so a fallback render is still
 * truthful.
 *
 * userRatePct is instantBuybackPct MINUS the five point spread, matching what the live API
 * computes as instantBuybackPct - spreadBps/100. Quoting Collector Crypt's raw rate here
 * would promise an offline visitor five points more than they would actually receive. Note the tiers genuinely have DIFFERENT odds (the 50 runs 80/15/4/1, the larger
 * packs 75/20/4/1): an earlier build assumed they matched and displayed the wrong figures.
 */
const MOCK_MACHINES: Machine[] = [
  { id: "pokemon_50", name: "Elite Pokemon Gacha Pack", priceUsdg: "50000000", available: true, packsRemaining: 7758, odds: { common: 0.8, uncommon: 0.15, rare: 0.04, epic: 0.01 }, tierRanges: { common: { start: 30, end: 60 }, uncommon: { start: 60, end: 110 }, rare: { start: 110, end: 250 }, epic: { start: 250, end: 5001 } }, instantBuybackPct: 85, userRatePct: 80 },
  { id: "pokemon_250", name: "Legendary Pokemon Gacha Pack", priceUsdg: "250000000", available: true, packsRemaining: 3141, odds: { common: 0.75, uncommon: 0.2, rare: 0.04, epic: 0.01 }, tierRanges: { common: { start: 150, end: 250 }, uncommon: { start: 250, end: 400 }, rare: { start: 400, end: 2000 }, epic: { start: 2000, end: 50000 } }, instantBuybackPct: 90, userRatePct: 85 },
  { id: "pokemon_1000", name: "Grail Pokemon Gacha Pack", priceUsdg: "1000000000", available: true, packsRemaining: 828, odds: { common: 0.75, uncommon: 0.2, rare: 0.04, epic: 0.01 }, tierRanges: { common: { start: 600, end: 1000 }, uncommon: { start: 1000, end: 1600 }, rare: { start: 1600, end: 8000 }, epic: { start: 8000, end: 50000 } }, instantBuybackPct: 93, userRatePct: 88 },
  { id: "water_100", name: "Water Pack", priceUsdg: "100000000", available: true, packsRemaining: 479, odds: { common: 0.75, uncommon: 0.2, rare: 0.04, epic: 0.01 }, tierRanges: { common: { start: 50, end: 100 }, uncommon: { start: 100, end: 200 }, rare: { start: 200, end: 500 }, epic: { start: 500, end: 10001 } }, instantBuybackPct: 90, userRatePct: 85 },
];

const SET_NAMES = [
  "2008 Diamond & Pearl Great Encounters",
  "1999 Base Set Unlimited",
  "2016 Evolutions",
  "2021 Evolving Skies",
  "2003 EX Ruby & Sapphire",
  "1999 Jungle 1st Edition",
  "2022 Lost Origin",
  "2000 Team Rocket",
];

const REVEAL_POOL_PAGE_SIZE = 40;

async function realCardFromPool(machine: Machine): Promise<Card | null> {
  const machineId = machine.id;

  const fetchPage = async (page: number): Promise<CcNft[]> => {
    const res = await fetch(
      `${CC_GACHA_API}/getNfts?code=${encodeURIComponent(machineId)}&page=${page}&limit=${REVEAL_POOL_PAGE_SIZE}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { nfts?: CcNft[] };
    return body.nfts ?? [];
  };

  try {
    /**
     * Pick a page inside THIS machine's pool.
     *
     * This used to be a flat `random() * 60`, which quietly assumed every pool was deep. It
     * is not: the $50 has 60+ pages, but Water holds ~478 cards, about 12 pages — so four
     * times in five the roll landed past the end, the fetch came back empty, and the reveal
     * fell through to a synthetic card with no artwork at all. The demo looked broken for
     * exactly the machines with the smallest pools.
     */
    const knownPages = machine.packsRemaining
      ? Math.ceil(machine.packsRemaining / REVEAL_POOL_PAGE_SIZE)
      : 60;
    const maxPage = Math.max(1, Math.min(knownPages, 60));

    let nfts = await fetchPage(1 + Math.floor(Math.random() * maxPage));
    // packsRemaining is a stock count, not a pool size, so it can still overshoot. Page 1
    // always exists, and a real card from it beats a synthetic one with no image.
    if (nfts.length === 0) nfts = await fetchPage(1);

    const n = nfts[Math.floor(Math.random() * nfts.length)];
    if (!n) return null;

    const files = n.content?.files ?? [];
    const value = Number(n.insured_value ?? attr(n, "Insured Value") ?? 0);

    return {
      solanaMint: n.nft_address ?? n.id ?? "",
      tier: tierFromRanges(value, machine.tierRanges, n.rarity),
      name: n.name ?? "Graded card",
      grade: gradeOf(n),
      certNumber: attr(n, "Grading ID") ?? null,
      insuredValueUsd: String(Math.round(value * 1e6)),
      sellWindowEndsAt: Date.now() + 66 * 3600_000,
      imageFront: sized(files[0]?.uri, 700) ?? n.image ?? null,
      // Not every machine's metadata carries a `files` array — water_100 cards ship only a
      // top-level `image` — and a null back left the reveal's opening beat rendering an empty
      // slab with the grade floating over nothing. Falling back to the front means the turn
      // shows the same art on both faces, which is a far better failure than a blank card.
      imageBack: sized(files[1]?.uri, 700) ?? n.image ?? null,
      imageFrontFallback: files[0]?.cc_cdn ?? n.image ?? null,
      imageBackFallback: files[1]?.cc_cdn ?? n.image ?? null,
      year: attr(n, "Year") ?? /\b(19|20)\d{2}\b/.exec(n.name ?? "")?.[0] ?? null,
      category: attr(n, "Category") ?? null,
    };
  } catch {
    return null;
  }
}

/** Classify a value against a machine's own bands. CC's `rarity` wins when present. */
export function tierFromRanges(
  valueUsd: number,
  ranges: Record<string, TierRange> | undefined,
  rarity?: string,
): Prize["tier"] {
  const r = (rarity ?? "").toLowerCase();
  if (r === "epic" || r === "rare" || r === "uncommon" || r === "common") return r;
  if (ranges) {
    for (const tier of ["epic", "rare", "uncommon"] as const) {
      const band = ranges[tier];
      if (band && valueUsd >= band.start) return tier;
    }
    return "common";
  }
  return valueUsd >= 250 ? "epic" : valueUsd >= 110 ? "rare" : valueUsd >= 60 ? "uncommon" : "common";
}

function rollCard(machine: Machine) {
  const odds = machine.odds;
  const r = Math.random();
  let acc = 0;
  let tier = "common";
  for (const [name, p] of Object.entries(odds)) {
    acc += p;
    if (r <= acc) {
      tier = name;
      break;
    }
  }

  // Value comes from the machine's OWN band for the rolled tier, so a $250 pack demo shows
  // $250-400 for uncommon rather than the $50 machine's $60-110.
  const band = machine.tierRanges?.[tier] ?? { start: 30, end: 60 };
  const value = band.start + Math.random() * (band.end - band.start);
  const grade = [7, 8, 9, 10][Math.floor(Math.random() * 4)];
  const set = SET_NAMES[Math.floor(Math.random() * SET_NAMES.length)]!;
  const num = Math.floor(Math.random() * 180) + 1;

  return {
    solanaMint: crypto.randomUUID().replace(/-/g, "").slice(0, 44),
    // The tier that was actually rolled, not one re-derived from the value afterwards.
    tier: normalizeTier(tier),
    name: `${set} #${num} PSA ${grade}`,
    grade: `PSA ${grade}`,
    certNumber: String(Math.floor(Math.random() * 9e9) + 1e9),
    insuredValueUsd: String(Math.round(value * 1e6)),
    sellWindowEndsAt: Date.now() + 66 * 3600_000,
    imageFront: null,
    imageBack: null,
    imageFrontFallback: null,
    imageBackFallback: null,
    year: /\b(19|20)\d{2}\b/.exec(set)?.[0] ?? null,
    category: "Pokémon",
  };
}

const mockOrders = new Map<number, Order>();
const mockOwned: OwnedCard[] = [];
/**
 * Demo orders live only in this browser, but real order ids come from the chain and start at
 * 1 — so a shared id space means a demo pull can shadow a real order of the same number.
 * Starting well above any plausible on-chain id keeps the two apart, which is what lets
 * `getOrder` tell a demo apart from a real one without being told.
 */
const DEMO_ORDER_ID_BASE = 900_000_000;

let mockOrderId = DEMO_ORDER_ID_BASE;

/** Stage timings roughly match a real rip: bridge ~1s, open ~2s, reveal ~2s. */
const MOCK_TIMELINE: { at: number; stage: Order["stage"] }[] = [
  { at: 300, stage: "bridging" },
  { at: 1600, stage: "opening" },
  { at: 3400, stage: "revealing" },
  { at: 5200, stage: "done" },
];

function startMockOrder(machineId: string, demo: boolean): number {
  const id = ++mockOrderId;
  const machine = MOCK_MACHINES.find((m) => m.id === machineId) ?? MOCK_MACHINES[1]!;
  let card: Card = rollCard(machine);
  const memo = `cc-${crypto.randomUUID()}`;

  // Swap in a real card from the pool if it arrives before the reveal beat. The synthetic
  // one stays as a fallback so a slow network never stalls the animation.
  void realCardFromPool(machine).then((real) => {
    if (real) card = real;
  });

  mockOrders.set(id, { orderId: id, status: "CREATED", stage: "queued", ccMemo: null, mirrorTokenId: null, card: null, demo });

  for (const step of MOCK_TIMELINE) {
    setTimeout(() => {
      const done = step.stage === "done";
      mockOrders.set(id, {
        orderId: id,
        status: done ? "MINTED" : step.stage.toUpperCase(),
        stage: step.stage,
        ccMemo: step.at >= 1600 ? memo : null,
        // No mirror token id for a demo: nothing was minted.
        mirrorTokenId: done && !demo ? String(id) : null,
        card: done ? card : null,
        demo,
      });
      // A demo pull is a preview of the animation and nothing else. It must not enter the
      // collection: no pack was bought, no card is in custody, and no mirror exists on
      // Robinhood Chain, so showing one in "your cards" would be claiming ownership of
      // something that does not exist.
      if (done && !demo) {
        mockOwned.unshift({
          ...card,
          orderId: id,
          tokenId: String(id),
          state: "CUSTODY",
          sellable: true,
          ccOpenMemo: memo,
        });
      }
    }, step.at);
  }

  return id;
}

/* ------------------------------------------------------------------ public api */

type CcMachine = {
  code?: string;
  name?: string;
  price?: number;
  odds?: Record<string, number>;
  tierRanges?: Record<string, TierRange>;
  stock?: Record<string, number>;
  instantBuyback?: number;
  public?: boolean;
};

/**
 * Machines come from Collector Crypt's own public endpoint, the same way the pool and the
 * live feed do. Odds, prices and insured-value bands differ per machine and CC changes them,
 * so reading them live is the only way the odds table and the pricing panel can be right.
 *
 * The buyback rate is theirs; ours is that minus the spread. Falls back to the last known
 * good values rather than rendering an empty floor.
 */
/**
 * Cheapest first.
 *
 * Applied to BOTH sources, because they order differently and neither is authoritative:
 * the live API returns whatever order the worker built its list in, and the preview path
 * follows the OFFERED array. Sorting the OFFERED array alone therefore fixed the order in
 * preview and changed nothing on the deployed site — which is exactly what happened.
 *
 * Sorting numerically on priceUsdg, not lexically: these are base-unit strings, so "50000000"
 * sorts after "1000000000" as text.
 */
const byPrice = (ms: Machine[]) =>
  [...ms].sort((a, b) => Number(a.priceUsdg) - Number(b.priceUsdg));

export async function getMachines(): Promise<{ machines: Machine[] }> {
  if (!IS_MOCK) {
    const live = await http<{ machines: Machine[] }>("/machines");
    return { ...live, machines: byPrice(live.machines ?? []) };
  }

  try {
    const res = await fetch(`${CC_GACHA_API}/machines`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as CcMachine[] | { machines?: CcMachine[] };
    const all = Array.isArray(body) ? body : (body.machines ?? []);

    const machines = OFFERED.map((id) => {
      const m = all.find((x) => x.code === id);
      const fallback = MOCK_MACHINES.find((x) => x.id === id)!;
      if (!m || !m.odds || !m.tierRanges || m.price == null) return fallback;
      const cc = m.instantBuyback ?? fallback.instantBuybackPct;
      const stock = m.stock ? Object.values(m.stock).reduce((a, b) => a + b, 0) : null;
      return {
        id,
        name: m.name ?? fallback.name,
        priceUsdg: String(Math.round(m.price * 1e6)),
        available: m.public !== false,
        packsRemaining: stock,
        odds: m.odds,
        tierRanges: m.tierRanges,
        instantBuybackPct: cc,
        userRatePct: cc - SPREAD_PCT,
      } satisfies Machine;
    });

    return { machines: byPrice(machines) };
  } catch {
    // Sorted too: three return paths, and any one of them left raw puts the list in a
    // different order than the other two.
    return { machines: byPrice(MOCK_MACHINES) };
  }
}

/**
 * A demo pull never touches money or the chain. It is always simulated, even against a live
 * worker, and its result is deliberately discarded rather than recorded anywhere.
 */
export async function rip(
  buyer: string,
  machineId: string,
  opts: { demo?: boolean } = {},
): Promise<{ orderId: number }> {
  if (IS_MOCK || opts.demo) return { orderId: startMockOrder(machineId, opts.demo ?? false) };
  return http("/order", { method: "POST", body: JSON.stringify({ buyer, machineId }) });
}

/**
 * Canonicalise a tier string from the API.
 *
 * THE API SENDS "Common". Every lookup table in this app is keyed lowercase — `TIER_COLOR`,
 * a machine's `odds`, its `tierRanges` — so the raw value missed all of them. Visible
 * results: the reveal panel read "COMMON · —" because `odds["Common"]` is undefined and the
 * odds formatter falls back to a dash, and every real card lost its tier accent colour
 * because `TIER_COLOR["Common"]` is undefined too.
 *
 * Neither failed loudly. A missing CSS custom property just inherits, and the dash looked
 * like a deliberate placeholder for something the card genuinely lacked — which is exactly
 * how it was read.
 *
 * Normalised HERE, at the boundary where API data enters, rather than at each of the dozen
 * lookups. Anything unrecognised becomes "common": the tier only drives presentation, and a
 * grey card is a better failure than an undefined one.
 */
export function normalizeTier(value: unknown): Prize["tier"] {
  const t = String(value ?? "").toLowerCase();
  return t === "epic" || t === "rare" || t === "uncommon" || t === "common" ? t : "common";
}

export async function getOrder(orderId: number): Promise<Order> {
  // A demo pull is simulated in this browser and the worker has never heard of it, so it must
  // be served locally even when a real API is configured. Without this the demo starts, polls
  // /order/:id for an id that does not exist, 404s forever, and the sealed pack never opens.
  if (IS_MOCK || orderId >= DEMO_ORDER_ID_BASE) {
    const order = mockOrders.get(orderId);
    if (!order) throw new Error("order not found");
    return order;
  }
  const order = await http<Order>(`/order/${orderId}`);
  return order.card ? { ...order, card: { ...order.card, tier: normalizeTier(order.card.tier) } } : order;
}

export async function getCollection(address: string): Promise<{ cards: OwnedCard[] }> {
  if (IS_MOCK) return { cards: mockOwned };
  const body = await http<{ cards: OwnedCard[] }>(`/collection/${address}`);
  return { cards: (body.cards ?? []).map((c) => ({ ...c, tier: normalizeTier(c.tier) })) };
}

/** One pack this wallet opened, in whatever state its card ended up (held / sold back / withdrawn). */
export type HistoryCard = {
  orderId: number;
  name: string | null;
  grade: string | null;
  tier: Prize["tier"];
  insuredValueUsd: string | null;
  /** CUSTODY | SOLD_TO_CC | UNWRAPPED | … — the card's fate. */
  state: string;
  origin: string;
  machineId: string;
  openedAt: number;
};

/** Lifetime pack history — keyed on the buyer, so sold/withdrawn cards still appear. */
export async function getHistory(address: string): Promise<{ cards: HistoryCard[] }> {
  if (IS_MOCK) {
    return { cards: mockOwned.map((c, i) => ({ orderId: i, name: c.name, grade: c.grade, tier: c.tier, insuredValueUsd: c.insuredValueUsd, state: "CUSTODY", origin: "PACK", machineId: "pokemon_50", openedAt: Date.now() - i * 3600_000 })) };
  }
  const body = await http<{ cards: HistoryCard[] }>(`/history/${address}`);
  return { cards: (body.cards ?? []).map((c) => ({ ...c, tier: normalizeTier(c.tier) })) };
}

/* ------------------------------------------------------------------ sell back */

export type SellCapability = {
  enabled: boolean;
  escrowAddress: string | null;
  /**
   * Cards insured above this many dollars cannot be sold back or withdrawn. 0 means no cap.
   *
   * Served by the API rather than hardcoded here. The same number is enforced by the API and
   * by the escrow sweeper, so duplicating it in the bundle would let a stale build promise
   * something the server refuses.
   */
  /**
   * Whether a ceiling is in force. NOT its value — the API stopped sending that, because the
   * threshold at which a sale needs a person is an operational detail and the bundle is public.
   * Whether a given card is over it comes per-card, from the server.
   */
  valueLimitActive: boolean;
};

export type SellQuote = {
  quoteId: number;
  tokenId: string;
  payoutUsdg: string;
  expiresAt: number;
  escrowTo: string;
};

/** Coarse on purpose: a seller cares about their card and their money, not our state names. */
export type SellStage = "selling" | "settling" | "paying" | "paid" | "cancelled";

export type SellStatus = {
  tokenId: string;
  stage: SellStage;
  payoutUsdg: string;
  payoutTx: string | null;
  error: string | null;
  updatedAt: number;
};

/**
 * Whether sell-back is actually available, asked of the server rather than assumed.
 *
 * The backend switch is authoritative: a stale bundle must never offer a path the worker will
 * refuse. Any failure here is treated as "unavailable", because showing the button when we
 * cannot confirm is the worse mistake.
 */
export async function getSellCapability(): Promise<SellCapability> {
  if (IS_MOCK) return { enabled: false, escrowAddress: null, valueLimitActive: false };
  try {
    const h = await http<{
      sellBackEnabled?: boolean;
      escrowAddress?: string | null;
      valueLimitActive?: boolean;
    }>("/health");
    return {
      enabled: Boolean(h.sellBackEnabled),
      escrowAddress: h.escrowAddress ?? null,
      // An older API that does not send this yields 0, meaning no cap, which matches how it
      // behaved before the field existed.
      valueLimitActive: Boolean(h.valueLimitActive),
    };
  } catch {
    return { enabled: false, escrowAddress: null, valueLimitActive: false };
  }
}

export type WithdrawCapability = { enabled: boolean; valueLimitActive: boolean };

/**
 * Is the withdraw relayer accepting requests right now?
 *
 * Fails CLOSED, unlike most reads here. Every other capability check costs a user a wasted
 * click when it is wrong; this one gates a transaction that destroys their mirror before any
 * off-chain protection applies. An unreachable API means we cannot say the relayer is running,
 * and "cannot say" must never read as "yes" for an irreversible burn.
 */
export async function getWithdrawCapability(): Promise<WithdrawCapability> {
  if (IS_MOCK) return { enabled: false, valueLimitActive: false };
  try {
    const h = await http<{ withdrawEnabled?: boolean; valueLimitActive?: boolean }>("/health");
    return {
      enabled: Boolean(h.withdrawEnabled),
      valueLimitActive: Boolean(h.valueLimitActive),
    };
  } catch {
    return { enabled: false, valueLimitActive: false };
  }
}

/**
 * Is this card too valuable to sell back or withdraw?
 *
 * Mirrors backend/src/policy.ts exactly, including treating an unknown value as over the
 * limit. This is a courtesy so nobody clicks into a refusal; it is NOT the enforcement point.
 * The API and the escrow sweeper both check independently, because a sell-back starts with an
 * on-chain transfer that no website can prevent.
 */
export function exceedsCardValueLimit(insuredValueUsd: string | null | undefined, maxUsd: number): boolean {
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) return false;
  if (!insuredValueUsd) return true;
  try {
    return BigInt(insuredValueUsd) > BigInt(Math.round(maxUsd)) * 1_000_000n;
  } catch {
    return true;
  }
}

/**
 * Wording shared by every place that blocks. Mirrors backend/src/policy.ts.
 *
 * Generic on purpose: it names neither the card nor the threshold. The API still returns the
 * specific reason as `code` and `limitUsd` for support.
 */
export function cardValueLimitMessage(): string {
  return "This feature is temporarily unavailable.";
}

/** Accept a quote. Records the price only — the transfer is what commits the sale. */
export async function requestSellQuote(tokenId: string, requester: string): Promise<SellQuote> {
  return http(`/sell/${tokenId}`, {
    method: "POST",
    body: JSON.stringify({ requester }),
  });
}

/** Null while no sell-back exists for this card, which is the normal case. */
export async function getSellStatus(tokenId: string): Promise<SellStatus | null> {
  if (IS_MOCK) return null;
  try {
    return await http<SellStatus>(`/sell/${tokenId}`);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ prize pool + feed */

/**
 * Prize pool and live feed come from Collector Crypt's own public endpoints:
 *
 *   GET /api/getNfts?code=<machine>&page=1&limit=40   the pool
 *   GET /api/getRecentWinners?packType=<machine>      recent pulls
 *
 * Both answer without an API key and send `access-control-allow-origin: *`, so the browser
 * can read them directly. Measured 2026-07-19: `getNfts` returns the pool ALREADY sorted
 * highest-to-lowest by insured value, and page 1 of the $50 machine is entirely epic
 * ($2,550–$4,250) — the showcase is genuinely the top of the pool, not a sample.
 *
 * Card images are photographs of the specific physical slabs we would custody, which doc 00
 * §7 explicitly permits. We prefer the arweave `uri` (the NFT's canonical, permanent source)
 * over `cc_cdn` (Collector Crypt's CloudFront) so the site doesn't lean on their
 * infrastructure — with cc_cdn kept only as a per-image fallback.
 */


/**
 * Image sizing. This matters enormously and is easy to get wrong.
 *
 * The arweave `uri` is the ORIGINAL scan: ~4.3 MB per card. Forty of those is a ~170 MB
 * homepage. Collector Crypt's own CloudFront mirror is ~174 KB, and Helius' CDN — a
 * Cloudflare image-resizing proxy in front of the same arweave source — is ~69 KB at 400px.
 *
 * So we render through Helius with an explicit width: smallest payload, correct source of
 * truth, and no dependency on CC's infrastructure. Raw arweave is the last-resort fallback,
 * never the default.
 *
 * Measured 2026-07-19, single card:
 *   arweave raw      4,332,802 B   ~0.50 s
 *   cc cloudfront      173,810 B   ~0.07 s (warm)
 *   helius w=400        69,165 B   ~0.24 s
 */
export function sized(arweaveUri: string | null | undefined, width: number): string | null {
  if (!arweaveUri) return null;
  if (!arweaveUri.includes("arweave.net")) return arweaveUri;
  return `https://cdn.helius-rpc.com/cdn-cgi/image/width=${width},quality=80,format=auto/${arweaveUri}`;
}

export type Prize = {
  id: string;
  name: string;
  grade: string;
  insuredValueUsd: string;
  tier: "common" | "uncommon" | "rare" | "epic";
  image: string | null;
  imageFallback: string | null;
  badge?: string;
  /** Carried from the same payload so the details view opens instantly. */
  detail: CardDetail;
};

export type FeedEntry = {
  id: string;
  name: string;
  grade: string;
  insuredValueUsd: string;
  tier: Prize["tier"];
  image: string | null;
  imageFallback: string | null;
  who: string;
  at: number;
};

type CcFile = { uri?: string; cc_cdn?: string; cdn_uri?: string; mime?: string };
type CcAttribute = { trait_type?: string; value?: string };
type CcNft = {
  nft_address?: string;
  id?: string;
  name?: string;
  description?: string;
  rarity?: string;
  insured_value?: number;
  image?: string;
  attributes?: CcAttribute[];
  /** Present on the gacha pool feed; absent on some other shapes, so all optional. */
  gradePopulation?: number;
  totalPopulation?: number;
  cardYear?: number;
  parallel?: string;
  gemGrade?: string;
  content?: { files?: CcFile[]; metadata?: { name?: string; attributes?: CcAttribute[] } };
};

/**
 * Everything the card-details view shows. Built from the SAME getNfts payload that renders
 * the grid, so opening a card costs no extra request: Collector Crypt's own modal works the
 * same way (verified 2026-07-19 — opening it fires no network call).
 *
 * Every field is optional because the feed genuinely omits some of them per card. The view
 * skips a row it has no value for rather than printing a placeholder: this panel sits under
 * a "Guaranteed Authenticity" heading, so a made-up number there would be the worst possible
 * thing to render.
 */
export type CardDetail = {
  name: string;
  description: string | null;
  insuredValueUsd: string;
  tier: Prize["tier"];
  /** Solana mint. Also the id in Collector Crypt's asset URL. */
  mint: string;
  ccUrl: string;
  imageFront: string | null;
  imageFrontFallback: string | null;
  imageBack: string | null;
  imageBackFallback: string | null;
  gradingCompany: string | null;
  gradingId: string | null;
  grade: string | null;
  gradePopulation: number | null;
  totalPopulation: number | null;
  parallel: string | null;
  year: string | null;
  category: string | null;
  vault: string | null;
  vaultId: string | null;
  location: string | null;
};

const attr = (n: CcNft, trait: string): string | undefined =>
  (n.attributes ?? n.content?.metadata?.attributes ?? []).find((a) => a.trait_type === trait)?.value;

/** "GEM-MT 10" + "PSA" -> "PSA 10". Falls back to whatever grade text exists. */
function gradeOf(n: CcNft): string {
  const raw = attr(n, "The Grade") ?? "";
  const company = attr(n, "Grading Company") ?? "PSA";
  const num = /(\d+(?:\.\d+)?)/.exec(raw)?.[1];
  return num ? `${company} ${num}` : raw || company;
}

const tierOf = (rarity: string | undefined, value: number): Prize["tier"] => {
  const r = (rarity ?? "").toLowerCase();
  if (r === "epic" || r === "rare" || r === "uncommon" || r === "common") return r;
  // Fall back to CC's own published tierRanges if rarity is absent.
  return value >= 250 ? "epic" : value >= 110 ? "rare" : value >= 60 ? "uncommon" : "common";
};

function imagesOf(n: CcNft, width = 400): { image: string | null; imageFallback: string | null } {
  const file = n.content?.files?.find((f) => !f.mime || f.mime.startsWith("image/")) ?? n.content?.files?.[0];
  return {
    image: sized(file?.uri, width) ?? n.image ?? null,
    // CC's CloudFront is already resized, so it is a sane fallback if Helius is unreachable.
    imageFallback: file?.cc_cdn ?? n.image ?? null,
  };
}

/** Collector Crypt's canonical page for a vaulted card. Verified 2026-07-19. */
/**
 * Turn a card the user owns into the shape the details popup renders.
 *
 * The popup was built for POOL cards, which come from Collector Crypt's full metadata. An
 * owned card comes from our own database, which stores only what fulfilment captured, so the
 * richer rows (population, parallel, vault) are genuinely unknown rather than omitted. They
 * are set to null and the popup skips those rows entirely, which is the honest rendering: we
 * do not have that data and should not invent it.
 */
export function ownedToDetail(c: OwnedCard): CardDetail {
  return {
    name: c.name ?? "Card",
    description: null,
    // The DB column is nullable; a card we could not price shows as zero rather than
    // breaking the popup. The value ceiling already refuses to sell such a card.
    insuredValueUsd: c.insuredValueUsd ?? "0",
    tier: normalizeTier(c.tier),
    mint: c.solanaMint,
    ccUrl: ccAssetUrl(c.solanaMint),
    imageFront: c.imageFront,
    imageFrontFallback: c.imageFrontFallback,
    imageBack: c.imageBack,
    imageBackFallback: c.imageBackFallback,
    gradingCompany: c.grade ? c.grade.split(" ")[0]! : null,
    gradingId: c.certNumber,
    grade: c.grade,
    gradePopulation: null,
    totalPopulation: null,
    parallel: null,
    year: null,
    category: null,
    vault: null,
    vaultId: null,
    location: null,
  };
}

export const ccAssetUrl = (mint: string) => `https://collectorcrypt.com/assets/solana/${mint}`;

/** Trims blanks to null so the details view can skip the row entirely. */
const clean = (v: string | undefined | null): string | null => {
  const s = (v ?? "").trim();
  return s === "" ? null : s;
};

/** files[0] is the slab front and files[1] the back, consistently across the feed. */
function faceOf(n: CcNft, i: number, width: number) {
  const f = n.content?.files?.[i];
  return { url: sized(f?.uri, width), fallback: f?.cc_cdn ?? null };
}

function toDetail(n: CcNft, value: number, tier: Prize["tier"]): CardDetail {
  const mint = n.nft_address ?? n.id ?? "";
  // 1200px: this is the hero image of the details view, and slab scans carry fine print
  // (cert number, grade) that has to stay legible when it fills the panel.
  const front = faceOf(n, 0, 1200);
  const back = faceOf(n, 1, 1200);
  return {
    name: n.name ?? "Graded card",
    description: clean(n.description),
    insuredValueUsd: String(Math.round(value * 1e6)),
    tier,
    mint,
    ccUrl: ccAssetUrl(mint),
    imageFront: front.url,
    imageFrontFallback: front.fallback,
    imageBack: back.url,
    imageBackFallback: back.fallback,
    gradingCompany: clean(attr(n, "Grading Company")),
    gradingId: clean(attr(n, "Grading ID")),
    // "The Grade" is the human-readable one ("GEM-MT 10"). metadata.gradeNum is unreliable:
    // it reads "Ungraded" on cards that are demonstrably graded.
    grade: clean(attr(n, "The Grade")),
    gradePopulation: typeof n.gradePopulation === "number" ? n.gradePopulation : null,
    totalPopulation: typeof n.totalPopulation === "number" ? n.totalPopulation : null,
    parallel: clean(n.parallel),
    year: clean(n.cardYear != null ? String(n.cardYear) : attr(n, "Year")),
    category: clean(attr(n, "Category")),
    vault: clean(attr(n, "Vault")),
    vaultId: clean(attr(n, "Vault ID")),
    location: clean(attr(n, "Location")),
  };
}

function toPrize(n: CcNft, index: number): Prize {
  const value = Number(n.insured_value ?? attr(n, "Insured Value") ?? 0);
  const tier = tierOf(n.rarity, value);
  return {
    id: n.nft_address ?? n.id ?? `prize-${index}`,
    name: n.name ?? "Graded card",
    grade: gradeOf(n),
    insuredValueUsd: String(Math.round(value * 1e6)),
    tier,
    ...imagesOf(n),
    badge: index === 0 ? "Top" : undefined,
    detail: toDetail(n, value, tier),
  };
}

export const POOL_PAGE_SIZE = 12;

/**
 * One page of a machine's pool, highest value first (CC returns it pre-sorted).
 *
 * Paged rather than fetched whole: the pool runs to thousands of cards, and each one is an
 * image. 12 at a time keeps first paint cheap and lets the grid grow as the user scrolls.
 */
export async function getPool(
  machineId: string,
  page = 1,
): Promise<{ prizes: Prize[]; hasMore: boolean }> {
  const res = await fetch(
    `${CC_GACHA_API}/getNfts?code=${encodeURIComponent(machineId)}&page=${page}&limit=${POOL_PAGE_SIZE}`,
    { signal: AbortSignal.timeout(20_000) },
  );
  if (!res.ok) throw new Error(`pool unavailable (HTTP ${res.status})`);

  const body = (await res.json()) as { nfts?: CcNft[]; hasMore?: boolean };
  const nfts = body.nfts ?? [];

  // Sort defensively within the page: the endpoint is already descending, but the
  // showcase's whole promise is "these are the best cards in here", so we don't leave that
  // to an upstream default.
  const prizes = nfts
    .map(toPrize)
    .sort((a, b) => Number(b.insuredValueUsd) - Number(a.insuredValueUsd))
    .map((p, i) => ({
      ...p,
      badge: page === 1 && i === 0 ? "Top" : p.tier === "epic" ? "Epic" : undefined,
    }));

  return { prizes, hasMore: body.hasMore ?? nfts.length === POOL_PAGE_SIZE };
}

type CcWinner = { winner?: string; prize_tier?: number; nft?: CcNft; created_at?: string };

const TIER_BY_PRIZE_TIER: Record<number, Prize["tier"]> = { 1: "epic", 2: "rare", 3: "uncommon", 4: "common" };

const shortWallet = (w: string) => (w.length > 12 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w);

/** Recent pulls on this machine, from CC's own feed. */
export async function getRecentRips(machineId = "pokemon_50"): Promise<FeedEntry[]> {
  const res = await fetch(`${CC_GACHA_API}/getRecentWinners?packType=${encodeURIComponent(machineId)}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return [];

  const body = (await res.json()) as { data?: CcWinner[] };
  return (body.data ?? []).map((w, i) => {
    const nft = w.nft ?? {};
    const value = Number(nft.insured_value ?? attr(nft, "Insured Value") ?? 0);
    return {
      id: nft.id ?? nft.nft_address ?? `winner-${i}`,
      name: nft.name ?? nft.content?.metadata?.name ?? "Graded card",
      grade: gradeOf(nft),
      insuredValueUsd: String(Math.round(value * 1e6)),
      tier: TIER_BY_PRIZE_TIER[w.prize_tier ?? 4] ?? tierOf(nft.rarity, value),
      ...imagesOf(nft, 120),
      who: shortWallet(w.winner ?? "someone"),
      at: w.created_at ? Date.parse(w.created_at) : Date.now() - i * 45_000,
    };
  });
}

/* ------------------------------------------------------------------ marketplace */

export type Listing = {
  tokenId: string;
  seller: string;
  priceUsdg: string;
  listedAt: number;
  /** False when the seller no longer owns the card or revoked approval. */
  fillable: boolean;
  card: {
    name: string;
    grade: string;
    year: string | null;
    category: string | null;
    insuredValueUsd: string;
    image: string | null;
    imageFallback: string | null;
    tier: Prize["tier"];
  };
  /**
   * The Collector Crypt record, when we have one. Null for a listing read straight from
   * chain: resolving it needs the token's metadata URI, which the worker publishes when it
   * mints. Until that pipeline exists, the card page shows what the chain knows.
   */
  detail: CardDetail | null;
};

/** A standing bid, as returned by Marketplace.getOffers. */
export type AssetOffer = {
  offeror: string;
  amountUsdg: string;
  /** Unix seconds, 0 for no expiry. */
  expiry: number;
  fillable: boolean;
  at: number;
};

export type ListingSort = "newest" | "price-low" | "price-high" | "value-high";

/**
 * Marketplace listings.
 *
 * Read from the chain, not synthesised. The Marketplace contract is deployed, so the book is
 * whatever Listed/Sold/Cancelled say it is: a card is listed only if a Listed event has not
 * since been superseded by a Sold or Cancelled for the same token.
 *
 * Today that resolves to nothing, because no mirror cards have been minted yet. An empty
 * marketplace is the correct answer, and a more honest one than a plausible-looking book of
 * cards nobody can actually buy.
 *
 * This scans events directly rather than going through an indexer. That is fine at zero to a
 * few hundred listings and will need the worker to index properly before it stops being fine.
 */
/**
 * The block the live Marketplace was deployed in (tx 0x854d3712…, 20 Jul 2026).
 *
 * Nothing can be listed before the contract exists, so this is a lossless floor for the log
 * scan. Update it if the Marketplace is ever redeployed — too HIGH silently hides listings
 * made before the new value, which looks exactly like an empty marketplace.
 */
const MARKETPLACE_DEPLOY_BLOCK = 14926491n;

/** What GET /cards returns per card. Field names mirror the frontend Card type deliberately. */
type MarketCard = {
  tokenId: string;
  name: string | null;
  grade: string | null;
  insuredValueUsd: string | null;
  imageFront: string | null;
  imageFrontFallback: string | null;
  tier: string | null;
  state: string | null;
  // Also returned by GET /cards. Declared because the asset page builds a CardDetail from
  // this when a card is not listed, and a field the endpoint sends but the type omits is a
  // field nothing can use.
  solanaMint: string | null;
  imageBack: string | null;
  imageBackFallback: string | null;
  certNumber: string | null;
};

/**
 * Reads whether a listing can still be filled: the seller must still own the card and the
 * marketplace must still be approved to move it. Read per listing so a stale row is greyed
 * out in the book rather than discovered through a reverted transaction.
 */
const MARKETPLACE_FILLABLE_ABI = parseAbi([
  "function isFillable(uint256 tokenId) view returns (bool)",
]);

const MARKETPLACE_EVENTS = parseAbi([
  "event Listed(uint256 indexed tokenId, address indexed seller, uint256 priceUsdg)",
  "event Cancelled(uint256 indexed tokenId, address indexed seller)",
  "event Sold(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 priceUsdg, uint256 feeUsdg)",
  /**
   * updatePrice mutates the listing in place — it emits neither Listed nor Cancelled — so
   * without this the book kept the ORIGINAL price forever. AssetPage passes that stale figure
   * straight into buy(tokenId, expectedPriceUsdg), which reverts PriceChanged, and refreshing
   * re-reads the same events and shows the same stale price. The listing became permanently
   * unbuyable through the UI, in either direction, with the "% of insured" badge wrong too.
   */
  "event PriceUpdated(uint256 indexed tokenId, address indexed seller, uint256 priceUsdg)",
]);

let bookCache: { at: number; listings: Listing[] } | null = null;
const BOOK_TTL_MS = 20_000;

/**
 * Drop the cached order book.
 *
 * MUST be called after any marketplace write that lands. The cache is module-level, so
 * reloading the page's data after a delist, list, buy or accepted offer read straight back
 * out of it and showed the old state — the write had succeeded on chain and the UI still said
 * otherwise, for up to 20 seconds. The only way out was a hard refresh, which drops the module
 * and its cache with it. That is what users were doing.
 *
 * A cache that outlives the user's own writes is worse than no cache: it makes the app look
 * broken at exactly the moment the user is watching for confirmation.
 */
export function invalidateBook(): void {
  bookCache = null;
}

async function readBook(): Promise<Listing[]> {
  if (!CONTRACTS.marketplace) return [];
  if (bookCache && Date.now() - bookCache.at < BOOK_TTL_MS) return bookCache.listings;

  const client = createPublicClient({ chain: robinhoodChain, transport: viemHttp(RH_RPC_URL) });

  /**
   * Scanned from the marketplace's own deployment, not from genesis.
   *
   * `fromBlock: 0n` asked this RPC to walk ~14.7 million blocks that could not possibly hold
   * a marketplace event, three times per read. The RPC sits behind Cloudflare and rate-limits,
   * so the cost of that grows with the chain and the failure it produces is an empty book —
   * indistinguishable from "nothing is listed". Nothing was listed before the contract existed,
   * so starting there loses no history and the request stays a fixed size.
   */
  const deployBlock = MARKETPLACE_DEPLOY_BLOCK;

  const [listed, cancelled, sold, repriced] = await Promise.all(
    MARKETPLACE_EVENTS.map((event) =>
      client.getLogs({ address: CONTRACTS.marketplace!, event, fromBlock: deployBlock, toBlock: "latest" }),
    ),
  );

  // Last write wins per token: a Listed only stands if nothing later removed it.
  const removedAt = new Map<string, bigint>();
  for (const log of [...cancelled, ...sold]) {
    const id = String((log.args as { tokenId?: bigint }).tokenId);
    const bn = log.blockNumber ?? 0n;
    if (!removedAt.has(id) || removedAt.get(id)! < bn) removedAt.set(id, bn);
  }

  type Pending = { id: string; seller: string; priceUsdg: string; block: bigint; repricedAt?: bigint };
  const pending = new Map<string, Pending>();
  for (const log of listed) {
    const args = log.args as { tokenId?: bigint; seller?: string; priceUsdg?: bigint };
    if (args.tokenId === undefined) continue;
    const id = String(args.tokenId);
    const bn = log.blockNumber ?? 0n;
    if ((removedAt.get(id) ?? -1n) > bn) continue;

    pending.set(id, {
      id,
      seller: args.seller ?? "",
      priceUsdg: String(args.priceUsdg ?? 0n),
      block: bn,
    });
  }

  if (!pending.size) {
    bookCache = { at: Date.now(), listings: [] };
    return [];
  }

  // Apply reprices last: the newest PriceUpdated at or after the Listed wins.
  for (const log of repriced) {
    const args = log.args as { tokenId?: bigint; priceUsdg?: bigint };
    if (args.tokenId === undefined || args.priceUsdg === undefined) continue;
    const row = pending.get(String(args.tokenId));
    if (!row) continue;
    const bn = log.blockNumber ?? 0n;
    if (bn >= row.block) {
      row.priceUsdg = String(args.priceUsdg);
      row.repricedAt = bn;
    }
  }

  const ids = [...pending.keys()];

  /**
   * The three things a Listed event does not carry, fetched together.
   *
   * Every one of these used to be a placeholder, and each was wrong in a way a user could
   * see: a name of "Card #7", an insured value of 0 that made the "% of insured" badge divide
   * by zero, a listing date of "now" that made the newest-first sort meaningless, and
   * fillable hardcoded true so a stale listing looked buyable right up until it reverted.
   *
   * All three are best effort. A listing with a price and a seller is still a real listing,
   * so a failure here degrades what is shown rather than emptying the book.
   */
  const [cards, fillable, blocks] = await Promise.all([
    // Card metadata, one batched request rather than one per listing.
    fetch(`${API_BASE}/cards?ids=${ids.join(",")}`)
      .then((r) => (r.ok ? r.json() : { cards: [] }))
      .then((b: { cards?: MarketCard[] }) => new Map((b.cards ?? []).map((c) => [String(c.tokenId), c])))
      .catch(() => new Map<string, MarketCard>()),

    // Does the seller still own it and is the marketplace still approved to move it?
    client
      .multicall({
        contracts: ids.map((id) => ({
          address: CONTRACTS.marketplace!,
          abi: MARKETPLACE_FILLABLE_ABI,
          functionName: "isFillable" as const,
          args: [BigInt(id)],
        })),
      })
      .then((rs) => new Map(ids.map((id, i) => [id, rs[i]?.status === "success" ? Boolean(rs[i]!.result) : true])))
      .catch(() => new Map<string, boolean>()),

    // When it was actually listed, from the block the Listed event sits in.
    Promise.all(
      [...new Set([...pending.values()].map((p) => p.block))].map((bn) =>
        client
          .getBlock({ blockNumber: bn })
          .then((b) => [bn, Number(b.timestamp) * 1000] as const)
          .catch(() => [bn, Date.now()] as const),
      ),
    ).then((entries) => new Map(entries)),
  ]);

  const listings: Listing[] = [...pending.values()].map((p) => {
    const c = cards.get(p.id);
    return {
      tokenId: p.id,
      seller: p.seller,
      priceUsdg: p.priceUsdg,
      listedAt: blocks.get(p.block) ?? Date.now(),
      fillable: fillable.get(p.id) ?? true,
      card: {
        name: c?.name ?? `Card #${p.id}`,
        grade: c?.grade ?? "",
        year: null,
        category: null,
        // "0" would be honest for an unknown value but the UI divides by it. Falling back to
        // the asking price makes the "% of insured" badge read 100% — visibly uninformative
        // rather than NaN or Infinity.
        insuredValueUsd: c?.insuredValueUsd ?? p.priceUsdg,
        image: c?.imageFront ?? null,
        imageFallback: c?.imageFrontFallback ?? null,
        tier: normalizeTier(c?.tier),
      },
      // Built here rather than left null: `getAsset` hands this straight to the asset page,
      // and a null detail there means no image and no metadata for every LISTED card. `c` is
      // already in hand, so this costs nothing.
      detail: cardDetailFrom(c, p.id),
    };
  });
  bookCache = { at: Date.now(), listings };
  return listings;
}

export async function getListings(
  opts: { sort?: ListingSort; search?: string; page?: number; pageSize?: number } = {},
): Promise<{ listings: Listing[]; total: number; hasMore: boolean }> {
  const { sort = "newest", search = "", page = 1, pageSize = 12 } = opts;

  // Always read the chain, in both modes. The Marketplace enumerates listings and offers on
  // chain precisely so this needs no indexer, and routing it through the worker instead was
  // pointing at `/market/listings`, which the API has never served — so with VITE_API_URL set
  // the whole marketplace 404'd, and the infinite-scroll observer retried it forever.
  let rows = await readBook();

  if (search.trim()) {
    const q = search.trim().toLowerCase();
    rows = rows.filter((l) => l.card.name.toLowerCase().includes(q) || l.tokenId.includes(q));
  }

  const sorted = [...rows].sort((a, b) => {
    switch (sort) {
      case "price-low":
        return Number(a.priceUsdg) - Number(b.priceUsdg);
      case "price-high":
        return Number(b.priceUsdg) - Number(a.priceUsdg);
      case "value-high":
        return Number(b.card.insuredValueUsd) - Number(a.card.insuredValueUsd);
      default:
        return b.listedAt - a.listedAt;
    }
  });

  const start = (page - 1) * pageSize;
  const slice = sorted.slice(start, start + pageSize);
  return { listings: slice, total: sorted.length, hasMore: start + pageSize < sorted.length };
}

/* ------------------------------------------------------------------ single asset */

/**
 * Everything the asset page needs for one card: the Collector Crypt record, the listing if
 * there is one, and the standing offers.
 *
 * With contracts live this reads `getListing` and `getOffers` straight from the Marketplace
 * and the CC record from the pool. Until then it serves the same synthesised book the
 * marketplace grid uses, so both views agree with each other rather than inventing separate
 * fictions.
 */
/**
 * Build the asset-page detail for a card from the `/cards` payload.
 *
 * Shared by BOTH paths that can produce a CardDetail — the listed one in `readBook` and the
 * unlisted one in `getAsset` — because they drifted once and the drift was invisible from
 * either side alone: `readBook` hardcoded `detail: null`, so a card rendered fine while
 * unlisted and lost its image and every metadata row the moment it was listed. Same input,
 * same output, one place to change.
 *
 * `card` is optional: a listing whose card the API does not know still renders as a card with
 * a number, rather than disappearing.
 */
function cardDetailFrom(card: MarketCard | undefined, tokenId: string): CardDetail {
  return {
    name: card?.name ?? `Card #${tokenId}`,
    description: null,
    insuredValueUsd: card?.insuredValueUsd ?? "0",
    tier: normalizeTier(card?.tier),
    mint: card?.solanaMint ?? "",
    ccUrl: card?.solanaMint ? ccAssetUrl(card.solanaMint) : "",
    imageFront: card?.imageFront ?? null,
    imageFrontFallback: card?.imageFrontFallback ?? null,
    imageBack: card?.imageBack ?? null,
    imageBackFallback: card?.imageBackFallback ?? null,
    gradingCompany: null,
    gradingId: card?.certNumber ?? null,
    grade: card?.grade ?? null,
    // Null rather than zero: /cards does not carry population or vault data, and a
    // fabricated 0 beside "Population" reads as a real, very wrong figure.
    gradePopulation: null,
    totalPopulation: null,
    parallel: null,
    year: null,
    category: null,
    vault: null,
    vaultId: null,
    location: null,
  };
}

export async function getAsset(
  tokenId: string,
): Promise<{ listing: Listing | null; detail: CardDetail | null; offers: AssetOffer[]; owner: string | null } | null> {
  // Chain in both modes, same reason as the grid: `/market/asset/:tokenId` was never served.
  // Same source as the grid, so the two can never disagree about what is listed.
  const listing = (await readBook()).find((l) => l.tokenId === tokenId) ?? null;

  /**
   * An UNLISTED card is a valid card, and this used to return null for one.
   *
   * That made the page circular: the asset page is the only place a card can be listed, and
   * it refused to render for anything not already listed. So the owner of a card could reach
   * the listing screen only for cards that no longer needed listing. "Card not found" for a
   * card sitting in their own collection.
   *
   * When there is no listing we still load the card, so the page can render it with a List
   * action. `detail` comes from the same /cards endpoint the marketplace tiles use, so an
   * unlisted card shows exactly what a listed one does, minus the price.
   */
  if (!listing) {
    const card = await fetch(`${API_BASE}/cards?ids=${encodeURIComponent(tokenId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { cards?: MarketCard[] } | null) => b?.cards?.[0] ?? null)
      .catch(() => null);
    if (!card) return null; // genuinely unknown to us

    const detail = cardDetailFrom(card, tokenId);

    return { listing: null, detail, offers: await readOffers(tokenId), owner: await readOwner(tokenId) };
  }

  return {
    listing,
    detail: listing.detail,
    offers: await readOffers(tokenId),
    owner: await readOwner(tokenId),
  };
}

/**
 * Who owns the token, from the chain.
 *
 * The asset page used to infer ownership from `listing.seller`, so an UNLISTED card had no
 * seller and its owner was treated as a stranger — offered "Make an offer" on their own card,
 * with no way to list it. Ownership is a property of the token, not of a listing, so it is
 * read from ownerOf. Null when unreadable, which the caller treats as "not the owner" rather
 * than guessing.
 */
async function readOwner(tokenId: string): Promise<string | null> {
  if (!CONTRACTS.mirror) return null;
  try {
    const client = createPublicClient({ chain: robinhoodChain, transport: viemHttp(RH_RPC_URL) });
    const owner = await client.readContract({
      address: CONTRACTS.mirror,
      abi: parseAbi(["function ownerOf(uint256 tokenId) view returns (address)"]),
      functionName: "ownerOf",
      args: [BigInt(tokenId)],
    });
    return owner as string;
  } catch {
    return null;
  }
}

/**
 * Standing offers on a card, from the contract's own enumeration — which exists precisely so
 * this works without an indexer. Offers can be made on an UNLISTED card, so this is read for
 * both cases. Empty until someone bids.
 */
async function readOffers(tokenId: string): Promise<AssetOffer[]> {
  let offers: AssetOffer[] = [];
  if (CONTRACTS.marketplace) {
    try {
      const client = createPublicClient({ chain: robinhoodChain, transport: viemHttp(RH_RPC_URL) });
      const [offerors, amounts, expiries, fillable] = await client.readContract({
        address: CONTRACTS.marketplace,
        abi: parseAbi([
          "function getOffers(uint256 tokenId) view returns (address[] offerors, uint96[] amounts, uint64[] expiries, bool[] fillable)",
        ]),
        functionName: "getOffers",
        args: [BigInt(tokenId)],
      });
      offers = offerors.map((offeror, i) => ({
        offeror,
        amountUsdg: String(amounts[i] ?? 0n),
        expiry: Number(expiries[i] ?? 0n),
        fillable: fillable[i] ?? false,
        at: Date.now(),
      }));
    } catch {
      offers = [];
    }
  }

  return offers;
}

/* ------------------------------------------------------------------ leaderboard */

export type LeaderRow = {
  address: string;
  packsOpened: number;
  /** Sum of insured value across everything they have pulled, 6dp base units. */
  totalValueUsd: string;
};

export type LeaderSort = "value" | "packs";

/**
 * Leaderboard.
 *
 * Needs the worker: ranking across all players means reading every order, which no browser
 * can do from chain events alone without scanning the whole history on every page load. Until
 * the worker is deployed this returns nothing, which is also the truth right now, since no
 * packs have been opened.
 */
export async function getLeaderboard(
  sort: LeaderSort = "value",
  limit = 50,
): Promise<{ rows: LeaderRow[]; live: boolean }> {
  if (IS_MOCK) return { rows: [], live: false };
  const res = await http<{ rows: LeaderRow[] }>(`/leaderboard?sort=${sort}&limit=${limit}`);
  return { rows: res.rows, live: true };
}

/* ------------------------------------------------------------------ messages */

export type MessageKind =
  | "sold"
  | "bought"
  | "offer-received"
  | "offer-accepted"
  | "offer-withdrawn"
  | "listed"
  | "delisted";

export type Message = {
  /** Stable across reloads: chain data, so the read flag can key off it. */
  id: string;
  kind: MessageKind;
  tokenId: string;
  /** The other party, when there is one. */
  counterparty: string | null;
  amountUsdg: string | null;
  blockNumber: bigint;
  at: number | null;
};

const MARKETPLACE_EVENTS_FULL = parseAbi([
  "event Listed(uint256 indexed tokenId, address indexed seller, uint256 priceUsdg)",
  "event Cancelled(uint256 indexed tokenId, address indexed seller)",
  "event Sold(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 priceUsdg, uint256 feeUsdg)",
  "event OfferMade(uint256 indexed tokenId, address indexed offeror, uint256 amountUsdg, uint64 expiry)",
  "event OfferWithdrawn(uint256 indexed tokenId, address indexed offeror)",
  "event OfferAccepted(uint256 indexed tokenId, address indexed seller, address indexed offeror, uint256 amountUsdg, uint256 feeUsdg)",
]);

/**
 * A wallet's marketplace activity, derived entirely from on-chain events.
 *
 * There is deliberately NO write path anywhere in this feature. Messages are not stored,
 * submitted or accepted from anyone: they are read from the Marketplace contract's own logs
 * and filtered to the connected wallet. That makes forgery impossible rather than merely
 * difficult, because producing a fake message would mean producing a fake event, which means
 * transacting on the contract.
 *
 * It also means nothing here can leak: every event is already public on chain, and the
 * filtering is a convenience, not a permission boundary.
 */
export async function getMessages(address: string): Promise<Message[]> {
  if (!CONTRACTS.marketplace) return [];
  const me = address.toLowerCase();

  /**
   * Which cards this wallet actually holds.
   *
   * Offer events name the OFFEROR, never the card's owner, so "somebody offered on a card"
   * cannot be turned into "somebody offered on YOUR card" without knowing what you own. The
   * code used to push every offer by anyone that was not made by you, under a comment saying
   * the page would filter — the page never did. So every wallet's inbox filled with strangers
   * trading with each other, each entry asserting something had happened to them.
   *
   * Resolved once against the collection rather than per event, which was the original
   * objection: one request, not one read per log.
   */
  const mine = new Set<string>();
  if (API_BASE) {
    try {
      const res = await fetch(`${API_BASE}/collection/${address}`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const body = (await res.json()) as { cards?: { tokenId: string }[] };
        for (const c of body.cards ?? []) mine.add(String(c.tokenId));
      }
    } catch {
      // Unreadable: fall through with an empty set, so offer notices are omitted rather than
      // shown indiscriminately. Silence is the safer failure for a claim about your property.
    }
  }
  const client = createPublicClient({ chain: robinhoodChain, transport: viemHttp(RH_RPC_URL) });

  const logs = await Promise.all(
    MARKETPLACE_EVENTS_FULL.map((event) =>
      client
        .getLogs({ address: CONTRACTS.marketplace!, event, fromBlock: MARKETPLACE_DEPLOY_BLOCK, toBlock: "latest" })
        .catch(() => []),
    ),
  );

  const out: Message[] = [];
  const push = (m: Omit<Message, "id">, suffix: string) =>
    out.push({ ...m, id: `${m.tokenId}-${suffix}-${m.blockNumber}` });

  for (const log of logs.flat()) {
    const a = log.args as Record<string, unknown>;
    const tokenId = String(a.tokenId ?? "");
    const bn = log.blockNumber ?? 0n;
    const name = (log as { eventName?: string }).eventName;
    const seller = String(a.seller ?? "").toLowerCase();
    const buyer = String(a.buyer ?? "").toLowerCase();
    const offeror = String(a.offeror ?? "").toLowerCase();
    const amount = a.priceUsdg ?? a.amountUsdg;
    const amountUsdg = amount === undefined ? null : String(amount);

    switch (name) {
      case "Sold":
        if (seller === me) push({ kind: "sold", tokenId, counterparty: buyer, amountUsdg, blockNumber: bn, at: null }, "sold");
        if (buyer === me) push({ kind: "bought", tokenId, counterparty: seller, amountUsdg, blockNumber: bn, at: null }, "bought");
        break;
      case "OfferMade":
        // Only the CARD OWNER needs telling, so this requires the token to be one of theirs —
        // not merely that somebody else made the offer.
        if (offeror !== me && mine.has(tokenId))
          push({ kind: "offer-received", tokenId, counterparty: offeror, amountUsdg, blockNumber: bn, at: null }, `offer-${offeror}`);
        break;
      case "OfferAccepted":
        if (seller === me) push({ kind: "sold", tokenId, counterparty: offeror, amountUsdg, blockNumber: bn, at: null }, "offer-sold");
        if (offeror === me) push({ kind: "offer-accepted", tokenId, counterparty: seller, amountUsdg, blockNumber: bn, at: null }, "offer-accepted");
        break;
      case "OfferWithdrawn":
        // Same gate: a withdrawn offer only concerns you if it was on your card.
        if (offeror !== me && mine.has(tokenId))
          push({ kind: "offer-withdrawn", tokenId, counterparty: offeror, amountUsdg: null, blockNumber: bn, at: null }, `withdrawn-${offeror}`);
        break;
      case "Listed":
        if (seller === me) push({ kind: "listed", tokenId, counterparty: null, amountUsdg, blockNumber: bn, at: null }, "listed");
        break;
      case "Cancelled":
        if (seller === me) push({ kind: "delisted", tokenId, counterparty: null, amountUsdg: null, blockNumber: bn, at: null }, "delisted");
        break;
    }
  }

  return out.sort((a, b) => Number(b.blockNumber - a.blockNumber));
}


/* ------------------------------------------------------------------ deposits */

export type DepositCard = { mint: string; name: string | null; imageUrl: string | null };

/** Collector Crypt cards a Solana wallet holds. Filtered by collection server-side. */
export async function getDepositCards(owner: string): Promise<{ cards: DepositCard[] }> {
  return http(`/deposit/cards?owner=${encodeURIComponent(owner)}`);
}

/** The unsigned transfer into the vault, for the depositor's wallet to sign. */
export async function getDepositTransfer(
  mint: string,
  owner: string,
): Promise<{ transaction: string }> {
  return http(`/deposit/transfer?mint=${encodeURIComponent(mint)}&owner=${encodeURIComponent(owner)}`);
}

export type DepositStatus = {
  status: "CLAIMED" | "VERIFIED" | "MINTED" | "REJECTED";
  mirrorTokenId: string | null;
  error: string | null;
};

/**
 * Claim a card that has arrived in the vault.
 *
 * The signature proves control of the wallet that sent it. Without that, anyone watching the
 * vault could claim an arriving card first with their own address, and the depositor would
 * have handed over a real card for nothing.
 */
export async function claimDeposit(params: {
  solanaMint: string;
  evmAddress: string;
  signer: string;
  signature: string;
  nonce: number;
  solanaTx: string | null;
}): Promise<DepositStatus> {
  return http(`/deposit/claim`, { method: "POST", body: JSON.stringify(params) });
}

/**
 * Whether deposits can actually run, decided by the server from CHAIN state.
 *
 * The Deposit entry and its explainer are both hidden until this is true. A button shown
 * before the operator role is rotated would take a real card into the vault and then fail at
 * the mint — so this is never assumed, and any failure to confirm reads as "not available".
 */
export async function getDepositsEnabled(): Promise<boolean> {
  if (IS_MOCK) return false;
  try {
    const h = await http<{ depositsEnabled?: boolean }>("/health");
    return Boolean(h.depositsEnabled);
  } catch {
    return false;
  }
}

/** Deposits this wallet started but never finished. Only the recorded depositor sees them. */
export async function getPendingDeposits(
  evmAddress: string,
): Promise<{ solanaMint: string; status: string; error: string | null }[]> {
  try {
    const b = await http<{ pending?: { solanaMint: string; status: string; error: string | null }[] }>(
      `/deposit/pending?evm=${encodeURIComponent(evmAddress)}`,
    );
    return b.pending ?? [];
  } catch {
    return [];
  }
}


/*
 * A machine's display name, derived from its id rather than from Collector Crypt's own
 * product name. Their names are marketing ("Elite Pokémon Gacha Pack", "Grail Pokémon
 * Gacha Pack"); ours say which machine it is and what it costs, which is what someone
 * choosing between four of them needs.
 *
 * Lives here rather than in App.tsx because HowItWorks needs it too, and HowItWorks is
 * imported BY App.tsx — importing back would be a cycle.
 */
const MACHINE_SET_NAMES: Record<string, string> = {
  pokemon: "Pokémon",
  onepiece: "One Piece",
  basketball: "Basketball",
  baseball: "Baseball",
  football: "Football",
  water: "Water",
  sports: "Sports",
  anime: "Anime",
  sealed: "Sealed",
};

export function machineLabel(id: string): string {
  const [set, tier] = id.split("_");
  const name = MACHINE_SET_NAMES[set ?? ""] ?? ((set ?? "").charAt(0).toUpperCase() + (set ?? "").slice(1));
  return name ? `${name} ${tier}` : `${tier} Pack`;
}
