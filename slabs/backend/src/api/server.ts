import { verifyMessage } from "viem";
/**
 * HTTP API (doc 04 §5). Read-only plus quote endpoints; all writes happen on-chain.
 *
 * Uses node:http directly — no framework. The surface is small enough that a dependency
 * would cost more than it saves, and fewer deps is fewer things to audit.
 *
 * DEMO MODE (`demo: true`) additionally exposes POST /demo/rip, which fabricates an order
 * without an on-chain payment so the flow can be driven locally. It is refused unless the
 * flag is set, and the flag is never set in production config.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import type { Db, OrderRow } from "../db/index.ts";
import type { CollectorCryptClient } from "../cc/types.ts";
import type { FulfillmentPipeline } from "../pipeline/fulfill.ts";
import type { Config } from "../config.ts";
import { userPayoutUsdg } from "../cc/client.ts";
import { exceedsValueLimit, valueLimitMessage, VALUE_LIMIT_CODE } from "../policy.ts";
import { isLowInventory } from "../cc/types.ts";
import type { PonsStats } from "../pons.ts";
import { verifySolanaSignature, checkNonce, depositMessage } from "../chains/solana-signature.ts";

/** Public site origin, used to build NFT metadata image/external_url. Defaults to
 *  the pokeplay apex where the Slabs section lives. */
const SITE_URL = process.env.SITE_URL ?? "https://pokeplay.fun";

/** One shared read of the Pons numbers per interval, for every visitor. See /token/stats. */
let tokenStatsCache: { at: number; body: Record<string, unknown> } | null = null;
const TOKEN_STATS_TTL_MS = 30_000;

export type ApiDeps = {
  db: Db;
  cc: CollectorCryptClient;
  pipeline: FulfillmentPipeline;
  cfg: Config;
  /**
   * Where a seller sends their mirror to start a sell-back. Operator custody.
   * Absent in the demo server, which has no chain and so cannot take escrow.
   */
  escrowAddress?: string;
  /**
   * Reads $PWA's fees and market cap from Pons, on chain. Absent before launch and in
   * the demo server, in which case /token/stats reports `live: false` rather than zeroes.
   */
  pons?: { configured: boolean; stats(): Promise<PonsStats | null> };
  /** Current on-chain holders of mirrors, for building a collection from ownership. */
  mirrorOwners?: (tokenIds: bigint[]) => Promise<Map<string, string | null>>;
  /**
   * Deposits: listing a wallet's Collector Crypt cards, and claiming one that has arrived.
   * Absent in the demo server, which has no Solana side at all.
   */
  deposits?: {
    vaultAddress: string;
    cardsOf(owner: string): Promise<{ mint: string; name: string | null; imageUrl: string | null }[]>;
    /** Unsigned transfer for the depositor to sign. Base64. */
    transferTx(mint: string, owner: string): Promise<string>;
    /** Whether the deployed contracts can actually mint a deposit right now. */
    supported(): Promise<boolean>;
    pendingFor(evm: string): { solanaMint: string; status: string; error: string | null }[];
    claim(params: { solanaMint: string; depositorEvm: string; solanaTx: string | null }): Promise<void>;
    status(solanaMint: string): { status: string; mirrorTokenId: string | null; error: string | null } | null;
  };
  /**
   * Which machines are actually enabled on chain.
   *
   * Collector Crypt lists every machine it runs — pokemon, onepiece, basketball, and so on —
   * and reports them all as available, but `buy` reverts with MachineDisabled for any we have
   * not enabled ourselves. Advertising those is worse than useless: several share a price and
   * therefore a label, so "50 Pack" could be any of five, only one of which works.
   *
   * The chain is the authority. Absent (demo), nothing is filtered.
   */
  enabledMachineIds?: () => Promise<Set<string>>;
  /**
   * Whether PackSale is paused on chain. Injected so the API keeps no chain dependency and
   * the demo server can omit it. Absent means "not paused" — see /health.
   */
  isPaused?: () => Promise<boolean>;
  demo?: boolean;
  /** Artificial per-stage pacing so the demo's staged copy is legible. Demo only. */
  demoStageDelayMs?: number;
};

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  url: URL,
) => Promise<void> | void;

export function createApi(deps: ApiDeps): Server {
  const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];

  const route = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(
      "^" +
        path.replace(/:([a-zA-Z]+)/g, (_, k: string) => {
          keys.push(k);
          return "([^/]+)";
        }) +
        "$",
    );
    routes.push({ method, pattern, keys, handler });
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  };

  /**
   * Read a JSON body, with a hard size ceiling.
   *
   * This used to accumulate chunks with no cap at all, and it runs BEFORE any validation. One
   * anonymous POST with a multi-gigabyte body would OOM the process — and `main.ts` runs the
   * fulfilment worker and the API in the SAME process, so that kill lands mid-fulfilment on a
   * process holding both hot keys, with customer money in flight. Verified against the live
   * API during the 19 Jul security review: an 8 MB body was buffered and parsed in full.
   *
   * Content-Length is checked first so an oversized request is refused before a byte is read,
   * and the running total is checked too, because Content-Length can lie or be absent under
   * chunked encoding.
   */
  const MAX_BODY_BYTES = 16 * 1024;
  class BodyTooLarge extends Error {}

  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new BodyTooLarge();

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > MAX_BODY_BYTES) throw new BodyTooLarge();
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return {};
    }
  };

  // ------------------------------------------------------------------ routes

  route("GET", "/health", async (_req, res) => {
    const machines = await deps.cc.listMachines().catch(() => []);
    // Was hardcoded `false`, so a guardian pause left the site selling: every buy then
    // reverted EnforcedPause, after the user had already paid gas for an approve. Falls back
    // to false when the chain cannot be read (or in demo, which has no chain) — an unreadable
    // RPC should not black out a working store.
    const paused = deps.isPaused ? await deps.isPaused().catch(() => false) : false;
    json(res, 200, {
      ok: machines.length > 0 && !paused,
      paused,
      machinesUp: machines.length,
      /**
       * Whether the withdraw relayer is accepting requests.
       *
       * Advertised so the UI never offers a button that burns an irreplaceable card into a
       * queue the user cannot see. Off does not lose a request — the relayer still records
       * and honours it later — but a user should get to decide whether to wait.
       */
      withdrawEnabled: deps.cfg.withdrawEnabled,

      // Advertised so the UI can hide sell-back rather than offer a button that 503s. The
      // switch is authoritative here, not in the client: a stale bundle must not be able to
      // present a path the backend will refuse.
      sellBackEnabled: Boolean(deps.cfg.sellBackEnabled && deps.escrowAddress),
      /**
       * The value ceiling, published so the UI never hardcodes it.
       *
       * The client needs this to block a card before the user acts, but a number duplicated
       * in the bundle would drift the moment the env var changed, and a stale bundle would
       * then promise something the API refuses. Served from the same config the API and the
       * escrow sweeper enforce against, so all three cannot disagree. 0 means no cap.
       */
      /**
       * Whether a ceiling is in force, NOT what it is.
       *
       * The threshold at which a sale stops being automatic and starts needing a person is an
       * operational detail. It used to be published here in full, which told anyone exactly
       * where that line sits — so the UI is given the decision per card instead, and the number
       * stays with the operator.
       */
      valueLimitActive: deps.cfg.maxSellBackValueUsd > 0,
      /**
       * Turbo still cannot run, and the UI must not offer a switch that does nothing.
       *
       * The chain half SHIPPED on 20 Jul: PackSale gained `buyTurbo` and OrderCreated carries
       * the flag, so the reason given here no longer mentions it. What remains is the rest of
       * the path:
       *
       *  1. `OnChainOrder` has no turbo field — the worker decodes the flag and discards it.
       *  2. `useBuyPack` only ever calls `buy()`, so the flag is never set in the first place.
       *  3. The pipeline has no turbo branch. A turbo Common is auto-sold by Collector Crypt
       *     into USDC on Solana and no NFT is minted, so the buyer is owed MONEY rather than a
       *     card — and nothing pays them. That bridge leg is proven (sell-back rides on it) but
       *     it is not wired to a turbo order.
       *
       * (3) is the one that matters: enabling turbo before it exists would take a payment,
       * open a pack, sell the card, and owe the buyer proceeds with no path to deliver them.
       *
       * Advertised by the server so a stale bundle cannot present it either.
       */
      turboAvailable: false,
      turboUnavailableReason:
        "Turbo sells a Common straight back, so it pays out in USDC rather than a card, and that payout path is not built yet.",
      escrowAddress: deps.cfg.sellBackEnabled ? (deps.escrowAddress ?? null) : null,
      /**
       * Deposits are advertised ONLY when the chain says they would work — the Fulfiller must
       * expose mintForDeposit and MirrorNFT must still trust it. A Deposit button shown before
       * that rotation would take a real card and then fail at the mint, so this is read from
       * chain rather than from a flag someone has to remember to flip.
       */
      depositsEnabled: deps.deposits ? await deps.deposits.supported() : false,
    });
  });

  // ---------------------------------------------------------------- user settings

  /**
   * The message a wallet signs to change its own withdraw address.
   *
   * The address and a timestamp are both inside the signed text, so a captured signature
   * cannot be replayed to set a DIFFERENT address, and an old one cannot be replayed to roll
   * a newer setting back (the stored nonce must increase).
   */
  // The signing-message namespace. Fresh deploy, so it is rebranded to "Slabs";
  // the frontend MUST use the same value (VITE_SIGNING_NS) or signatures will not
  // verify. Kept configurable so the two sides can never silently drift.
  const signingNs = process.env.SIGNING_NS ?? "Slabs";
  const settingsMessage = (solana: string, nonce: number) =>
    `${signingNs}: set my withdraw address to ${solana}\nTimestamp: ${nonce}`;

  /**
   * A wallet's own withdraw address, returned ONLY to that wallet.
   *
   * This used to be an open read: no signature, no session. Combined with `/leaderboard`,
   * which publishes every buyer's EVM address, that made a complete EVM-to-Solana linkage
   * table for the whole userbase harvestable by anyone in seconds — one request per address.
   * The write side was carefully authenticated and the read side was wide open, which is the
   * worse half to leave open, because deanonymising every user is not undone by a fix later.
   *
   * Proof reuses the same scheme as the write: the address and a timestamp are inside the
   * signed text, so a captured signature cannot be retargeted at another wallet. The nonce is
   * NOT consumed here — a read must not be able to burn a nonce the write path depends on —
   * so it is only checked for freshness.
   *
   * Unsigned requests get `null` rather than a 401. A caller who cannot prove ownership learns
   * nothing either way, and the client treats "no address on the server" as its normal
   * first-run state.
   */
  const readSettingsMessage = (address: string, nonce: number) =>
    `${signingNs}: read my withdraw address for ${address}\nTimestamp: ${nonce}`;

  route("GET", "/settings/:address", async (_req, res, params, url) => {
    const address = params.address ?? "";
    const nonce = Number(url.searchParams.get("nonce") ?? "");
    const signature = url.searchParams.get("signature") ?? "";

    if (!signature || !Number.isFinite(nonce)) return json(res, 200, { solanaAddress: null });

    // Same 10 minute skew the write path allows, so a slow signature still lands.
    if (Math.abs(Date.now() - nonce) > 10 * 60_000) return json(res, 200, { solanaAddress: null });

    try {
      const ok = await verifyMessage({
        address: address as `0x${string}`,
        message: readSettingsMessage(address, nonce),
        signature: signature as `0x${string}`,
      });
      if (!ok) return json(res, 200, { solanaAddress: null });
    } catch {
      return json(res, 200, { solanaAddress: null });
    }

    const s = deps.db.getUserSettings(address);
    json(res, 200, { solanaAddress: s.solanaAddress });
  });

  /**
   * Save a withdraw address, proven by a signature from the EVM wallet it belongs to.
   *
   * Without this proof anyone could POST an address for anybody. That would not let them
   * steal a card outright, because the withdraw flow binds the destination on chain at burn
   * time, but it WOULD pre-fill somebody else's address into a victim's confirm screen and
   * invite them to sign it. Authenticating the write closes that entirely.
   */
  route("POST", "/settings", async (req, res) => {
    const body = (await readBody(req)) as {
      address?: string;
      solanaAddress?: string | null;
      nonce?: number;
      signature?: `0x${string}`;
    };

    const { address, solanaAddress, nonce, signature } = body;
    if (!address || !signature || typeof nonce !== "number") {
      return json(res, 400, { error: "address, nonce and signature are required" });
    }

    // A far-future timestamp would let one signature stay valid forever, so it is bounded.
    const skew = Math.abs(Date.now() - nonce);
    if (skew > 10 * 60_000) return json(res, 400, { error: "timestamp is too far from now" });

    const current = deps.db.getUserSettings(address);
    if (nonce <= current.lastNonce) return json(res, 409, { error: "stale request" });

    const ok = await verifyMessage({
      address: address as `0x${string}`,
      message: settingsMessage(solanaAddress ?? "", nonce),
      signature,
    }).catch(() => false);
    if (!ok) return json(res, 401, { error: "signature does not match that address" });

    deps.db.setUserSolanaAddress(address, solanaAddress ?? null, nonce);
    json(res, 200, { solanaAddress: solanaAddress ?? null });
  });

  /**
   * Cache of the on-chain enabled set. Short, because enabling a machine should show up
   * quickly, but non-zero so listing machines does not hit the RPC on every page load.
   */
  let enabledCache: { at: number; ids: Set<string> } | null = null;
  const enabledIds = async (): Promise<Set<string> | null> => {
    if (!deps.enabledMachineIds) return null;
    if (enabledCache && Date.now() - enabledCache.at < 30_000) return enabledCache.ids;
    try {
      const ids = await deps.enabledMachineIds();
      enabledCache = { at: Date.now(), ids };
      return ids;
    } catch (err) {
      // Serve the last known-good set rather than a shorter one. A transient RPC error must
      // never quietly take a machine off the shelf — and it must be visible when it happens,
      // because a silently shrinking menu is close to impossible to notice from outside.
      console.warn(
        `[machines] enabled-set read failed, serving ${enabledCache ? "last known-good set" : "nothing"}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      // With no cache yet there is nothing trustworthy to show, and listing everything CC
      // offers would advertise packs whose `buy` reverts.
      return enabledCache?.ids ?? new Set();
    }
  };

  /**
   * $PWA's live numbers, read from Pons on Robinhood Chain.
   *
   * CACHED, and that is not an optimisation. `feesWei` scans WETH Transfer logs from the Pons
   * factory's deployment block to head — 6.2 million blocks. The token page polls every 15
   * seconds, per visitor, so without a cache twenty people on that page would issue a
   * full-range log scan every 15 seconds against an RPC that is already rate-limited. One
   * shared read per interval serves everyone.
   *
   * Reports `live: false` before launch rather than zeroes: a $0 beside "Fees earned" reads as
   * a live token nobody is trading, which is a lie about a token that does not exist yet.
   */
  route("GET", "/token/stats", async (_req, res) => {
    if (!deps.pons?.configured) return json(res, 200, { live: false });

    const now = Date.now();
    if (tokenStatsCache && now - tokenStatsCache.at < TOKEN_STATS_TTL_MS) {
      return json(res, 200, tokenStatsCache.body);
    }

    try {
      const stats = await deps.pons.stats();
      // Configured but no pool yet: the launch transaction has not landed, or is not indexed.
      if (!stats) return json(res, 200, { live: false });

      const body = {
        live: true,
        tokenAddress: stats.tokenAddress,
        poolAddress: stats.poolAddress,
        feesEth: stats.feesEth,
        feesUsd: stats.feesUsd,
        priceUsd: stats.priceUsd,
        marketCapUsd: stats.marketCapUsd,
      };
      tokenStatsCache = { at: now, body };
      return json(res, 200, body);
    } catch (err) {
      /**
       * Serve the last good numbers rather than nothing.
       *
       * These reads cross an RPC that flakes intermittently. A blank page on a transient error
       * is worse than a figure a minute old, and the page already labels its own refresh rate.
       */
      if (tokenStatsCache) return json(res, 200, tokenStatsCache.body);
      return json(res, 503, { live: false, error: "token stats are temporarily unavailable" });
    }
  });

  /**
   * The Collector Crypt cards a Solana wallet holds, for the deposit picker.
   *
   * Public and unauthenticated because it reveals nothing private: it reads a wallet's public
   * holdings from a public chain, filtered to one public collection. Requiring a signature to
   * see your own cards before you have deposited anything would be friction for no gain.
   */
  route("GET", "/deposit/cards", async (_req, res, _params, url) => {
    if (!deps.deposits) return json(res, 503, { error: "deposits are not available" });
    const owner = url.searchParams.get("owner")?.trim();
    if (!owner) return json(res, 400, { error: "owner is required" });
    // Base58 only, and a plausible length. Keeps a malformed value out of the RPC call.
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner)) {
      return json(res, 400, { error: "that is not a Solana address" });
    }
    /**
     * The vault address is no longer returned.
     *
     * The page used to display it so a depositor could compare it against their wallet's
     * confirmation prompt. That prompt still shows the destination — it is the copy worth
     * checking anyway — and the transfer is built server-side, so nothing needs the address
     * client-side. Publishing our custody wallet on an unauthenticated endpoint was a standing
     * signpost to the wallet holding every card at once.
     */
    return json(res, 200, { cards: await deps.deposits.cardsOf(owner) });
  });

  /**
   * Claim a card that has been sent to the vault.
   *
   * SIGNATURE-GATED, and the signature is the point. The claim decides where a mirror is
   * minted, so without proving control of the wallet that SENT the card, anyone watching the
   * vault could claim an arriving card first with their own address — the depositor would have
   * handed over a real card and received nothing. The signed message binds the card and the
   * destination together, so one cannot be replayed for the other.
   *
   * Verification of the card itself happens downstream against the chain, never from this
   * body: the request says what the user believes, the chain says what is true.
   */
  route("POST", "/deposit/claim", async (req, res) => {
    if (!deps.deposits) return json(res, 503, { error: "deposits are not available" });

    const body = (await readBody(req)) as {
      solanaMint?: string;
      evmAddress?: string;
      signer?: string;
      signature?: string;
      nonce?: number;
      solanaTx?: string;
    };

    const { solanaMint, evmAddress, signer, signature, nonce } = body;
    if (!solanaMint || !evmAddress || !signer || !signature || typeof nonce !== "number") {
      return json(res, 400, { error: "solanaMint, evmAddress, signer, signature and nonce are required" });
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(evmAddress)) {
      return json(res, 400, { error: "evmAddress is not an address" });
    }

    const fresh = checkNonce(nonce);
    if (!fresh.ok) return json(res, 400, { error: fresh.reason });

    const sig = verifySolanaSignature(depositMessage(solanaMint, evmAddress, nonce), signature, signer);
    if (!sig.ok) return json(res, 401, { error: sig.reason });

    try {
      await deps.deposits.claim({
        solanaMint,
        depositorEvm: evmAddress,
        solanaTx: typeof body.solanaTx === "string" ? body.solanaTx : null,
      });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : "claim failed" });
    }

    const status = deps.deposits.status(solanaMint);
    // A rejection is a 200 with a reason: the request was well formed and authenticated, and
    // the answer is about the card, which the caller needs to read rather than catch.
    return json(res, 200, status ?? { status: "CLAIMED", mirrorTokenId: null, error: null });
  });

  /**
   * The unsigned transfer that moves a card into the vault.
   *
   * We are not a signer on it and it contains exactly one instruction, so the worst this can
   * hand back is a transaction the depositor's own wallet will preview before they approve.
   * The vault address is returned alongside so the page can show what to compare against.
   */
  route("GET", "/deposit/transfer", async (_req, res, _params, url) => {
    if (!deps.deposits) return json(res, 503, { error: "deposits are not available" });
    const mint = url.searchParams.get("mint")?.trim();
    const owner = url.searchParams.get("owner")?.trim();
    const base58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    if (!mint || !owner || !base58.test(mint) || !base58.test(owner)) {
      return json(res, 400, { error: "mint and owner must both be Solana addresses" });
    }
    try {
      // Same reasoning as /deposit/cards: the transaction names its own destination, and the
      // wallet shows it before signing.
      return json(res, 200, { transaction: await deps.deposits.transferTx(mint, owner) });
    } catch (err) {
      return json(res, 502, { error: err instanceof Error ? err.message : "could not build the transfer" });
    }
  });

  /**
   * Deposits this wallet started but never finished — the card is in the vault, the mirror was
   * never minted. Keyed on the recorded depositor, so only they can resume it.
   */
  route("GET", "/deposit/pending", (_req, res, _params, url) => {
    if (!deps.deposits) return json(res, 503, { error: "deposits are not available" });
    const evm = url.searchParams.get("evm")?.trim();
    if (!evm || !/^0x[0-9a-fA-F]{40}$/.test(evm)) {
      return json(res, 400, { error: "evm must be an address" });
    }
    return json(res, 200, { pending: deps.deposits.pendingFor(evm) });
  });

  route("GET", "/deposit/:mint", (_req, res, params) => {
    if (!deps.deposits) return json(res, 503, { error: "deposits are not available" });
    const s = deps.deposits.status(params.mint!);
    return s ? json(res, 200, s) : json(res, 404, { error: "no such deposit" });
  });

  route("GET", "/machines", async (_req, res) => {
    const machines = await deps.cc.listMachines();
    const enabled = await enabledIds();

    json(res, 200, {
      machines: machines
        .filter((m) => m.isPublic)
        // Only what can actually be bought. Without this the UI offers packs whose `buy`
        // reverts, and several are indistinguishable by label.
        .filter((m) => enabled === null || enabled.has(m.machineId))
        .map((m) => ({
          id: m.machineId,
          name: m.name,
          priceUsdg: m.priceUsdc,
          available: m.available,
          packsRemaining: m.packsRemaining,
          odds: m.odds,
          // Insured-value band per tier. Omitting this was silent: the UI type declares it and
          // the browser mock supplied it, so the value bands beside each tier only vanished
          // once the site pointed at the real worker.
          tierRanges: m.tierRanges,
          /**
           * Whether CC will refuse a normal open. Surfaced BEFORE purchase on purpose: CC only
           * reports it when the open fails, by which point the buyer has paid on chain and we
           * have paid a bridge fee to move their money. Predicting it costs nothing.
           */
          lowInventory: isLowInventory(m),
          commonsLeft: m.commonStock,
          // Shown in the UI so users can see the sell-back rate before they buy.
          instantBuybackPct: m.instantBuybackPct,
          userRatePct: m.instantBuybackPct - deps.cfg.economics.spreadBps / 100,
        })),
    });
  });

  /**
   * Leaderboard, ranked across every buyer.
   *
   * This has to live on the worker: ranking all players means reading every order, which a
   * browser cannot do from chain events without rescanning the whole history on each load.
   *
   * Only MINTED orders count. An order still in flight has no card and no value yet, and
   * counting it would let someone climb the board by starting opens they never complete.
   */
  route("GET", "/leaderboard", (_req, res, _params, url) => {
    const sort = url.searchParams.get("sort") === "packs" ? "packs" : "value";
    const limitRaw = Number(url.searchParams.get("limit") ?? 50);
    // Clamp: an unbounded limit from a query string is a free table scan for anyone.
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 50;

    const orderBy = sort === "packs" ? "packsOpened DESC, totalValue DESC" : "totalValue DESC, packsOpened DESC";

    const rows = deps.db.raw
      .prepare(
        `SELECT lower(o.buyer) AS address,
                COUNT(*) AS packsOpened,
                -- Cards can predate an insured value, so a missing one counts as zero
                -- rather than dropping the whole row from the ranking.
                COALESCE(SUM(CAST(COALESCE(c.insured_value_usd, '0') AS INTEGER)), 0) AS totalValue
           FROM orders o JOIN cards c ON c.order_id = o.id
          WHERE o.status = 'MINTED' AND o.demo = 0
          GROUP BY lower(o.buyer)
          ORDER BY ${orderBy}
          LIMIT ?`,
      )
      .all(limit) as { address: string; packsOpened: number; totalValue: number }[];

    json(res, 200, {
      rows: rows.map((r) => ({
        address: r.address,
        packsOpened: r.packsOpened,
        totalValueUsd: String(r.totalValue),
      })),
      sort,
    });
  });

  route("GET", "/order/:id", (_req, res, params) => {
    const order = deps.db.getOrder(Number(params.id));
    if (!order) return json(res, 404, { error: "order not found" });
    json(res, 200, serializeOrder(deps.db, order));
  });

  /**
   * A wallet's cards, decided by WHO OWNS THE MIRROR ON CHAIN.
   *
   * This used to select on `orders.buyer` — who bought the pack. That is not ownership: a
   * mirror is an ordinary ERC-721 and moves on a transfer or a marketplace sale, so the buyer's
   * order says nothing about where it is now. The result was that a transferred card stayed in
   * the sender's collection and never appeared in the recipient's, and a marketplace purchase
   * would have done the same.
   *
   * So every custodied card is read from chain and matched against the requested address.
   * `mirrorOwners` is absent in the demo server, which has no chain — there it falls back to
   * the old buyer-based answer, which is correct when nothing can move.
   */
  route("GET", "/collection/:address", async (_req, res, params) => {
    const rows = deps.db.raw
      .prepare(
        /**
         * The mirror comes from the CARD, not the order.
         *
         * `orders.mirror_token_id` records what that pack minted, historically. It does not
         * follow the card: withdraw a card and deposit it back and a NEW mirror is minted,
         * leaving the order pointing at a burned token. The collection then offered a card
         * whose token no longer exists — every action on it failed against `ownerOf`, which
         * reverts for a burned id.
         *
         * `cards.owner_mirror_token_id` is the current one. COALESCE because a card row can
         * exist briefly before its mint lands, and the order's id is the right fallback then.
         */
        `SELECT o.id AS order_id,
                COALESCE(c.owner_mirror_token_id, o.mirror_token_id) AS mirror_token_id,
                -- Selected for the demo fallback, which has no chain to ask about ownership.
                o.buyer,
                o.cc_open_tx,
                c.solana_mint, c.name, c.grade, c.cert_number, c.image_url,
                -- Must be selected explicitly, not just mapped: a column absent from the
                -- SELECT arrives undefined and the mapping happily forwards it as null.
                c.image_back_url, c.tier,
                c.insured_value_usd, c.reveal_at, c.user_window_ends_at,
                c.cc_window_ends_at, c.state, c.origin
           FROM orders o JOIN cards c ON c.order_id = o.id
          WHERE o.status = 'MINTED' AND o.demo = 0
            -- Only cards we ACTUALLY still hold belong in a collection. Without this a card
            -- that was sold back to Collector Crypt, withdrawn, or otherwise left custody
            -- keeps showing as owned forever, and the sell-back button keeps offering it.
            AND c.state = 'CUSTODY' 
          ORDER BY c.reveal_at DESC`,
      )
      .all() as Record<string, string | number | null>[];

    const wanted = (params.address ?? "").toLowerCase();

    /**
     * Filtered by on-chain ownership. Without a chain reader (demo), fall back to the buyer,
     * which is the right answer only because nothing can move there.
     */
    let mine = rows;
    if (deps.mirrorOwners) {
      const ids = rows
        .map((r) => r.mirror_token_id)
        .filter((t): t is string | number => t !== null && t !== undefined);
      const owners = await deps.mirrorOwners(ids.map((t) => BigInt(t)));
      mine = rows.filter((r) => {
        const owner = owners.get(String(r.mirror_token_id));
        return owner !== null && owner !== undefined && owner.toLowerCase() === wanted;
      });
    } else {
      mine = rows.filter((r) => String(r.buyer ?? "").toLowerCase() === wanted);
    }

    const now = Date.now();
    json(res, 200, {
      cards: mine.map((r) => ({
        orderId: r.order_id,
        tokenId: r.mirror_token_id,
        solanaMint: r.solana_mint,
        name: r.name,
        grade: r.grade,
        certNumber: r.cert_number,
        // Field names here MUST match the frontend's Card type. They did not: the API sent
        // `imageUrl` while the UI reads `imageFront`, so every real card rendered a grade
        // placeholder instead of artwork. The browser mock supplied the right shape, so this
        // only broke once the site pointed at the worker.
        imageFront: r.image_url,
        imageBack: r.image_back_url,
        imageFrontFallback: r.image_url,
        imageBackFallback: r.image_back_url,
        tier: r.tier,
        insuredValueUsd: r.insured_value_usd,
        state: r.state,
        ccOpenMemo: r.cc_open_tx,
        sellWindowEndsAt: r.user_window_ends_at,
        /**
         * A DEPOSITED card is never sellable, whatever its window says.
         *
         * Deposits carry no sell-back: we did not buy the card, so there are no proceeds of
         * ours to return. The escrow watcher enforces that and hands the mirror back — but
         * showing the button anyway means a user commits an on-chain transfer to be told no,
         * which is a bad way to learn a rule.
         *
         * The window alone was not enough: re-depositing a card that once came from a pack
         * leaves the original window in place, so it read as sellable right up until the
         * transfer bounced.
         */
        sellable:
          r.origin !== "DEPOSIT" && r.state === "CUSTODY" && now < Number(r.user_window_ends_at),
        /**
         * Decided here rather than in the browser, so the ceiling itself never has to be sent.
         * The UI only needs to know that THIS card is over it.
         */
        overValueLimit: exceedsValueLimit(
          r.insured_value_usd as string | null,
          deps.cfg.maxSellBackValueUsd,
        ),
        unwrapFeeApplies: now < Number(r.cc_window_ends_at) && deps.cfg.economics.unwrapFeeDuringWindowBps > 0,
      })),
    });
  });

  /**
   * Lifetime pack history for a wallet — every pack it opened, whatever became of the card.
   *
   * Unlike /collection this does NOT filter to CUSTODY and does NOT read on-chain ownership.
   * A sold-back or withdrawn card has had its mirror burned, so it owns nothing and would
   * vanish from an ownership-based query — but it is still part of this wallet's history.
   * History is therefore keyed on the BUYER, the wallet that opened the pack, which never
   * changes. The card's `state` carries what happened to it (held / sold back / withdrawn).
   */
  route("GET", "/history/:address", (_req, res, params) => {
    const wanted = (params.address ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(wanted)) return json(res, 400, { error: "bad address" });

    const rows = deps.db.raw
      .prepare(
        `SELECT o.id AS order_id, o.machine_id, o.price_usdg, o.created_at,
                c.name, c.grade, c.tier, c.insured_value_usd, c.state, c.origin,
                c.reveal_at, c.solana_mint
           FROM orders o JOIN cards c ON c.order_id = o.id
          WHERE o.status = 'MINTED' AND o.demo = 0 AND lower(o.buyer) = ?
          ORDER BY COALESCE(c.reveal_at, o.created_at) DESC`,
      )
      .all(wanted) as Record<string, string | number | null>[];

    json(res, 200, {
      cards: rows.map((r) => ({
        orderId: r.order_id,
        name: r.name,
        grade: r.grade,
        tier: r.tier,
        insuredValueUsd: r.insured_value_usd,
        state: r.state,
        origin: r.origin,
        machineId: r.machine_id,
        openedAt: Number(r.reveal_at ?? r.created_at),
      })),
    });
  });

  /**
   * Cards by mirror token id, for the marketplace.
   *
   * The marketplace enumerates listings from chain logs, which carry a tokenId, a seller and a
   * price and nothing else — no name, grade, tier, image or insured value. Without this the UI
   * rendered every listing as "Card #7", tier grey, insured value 0, which also made the
   * "% of insured" badge a division by zero.
   *
   * Deliberately NOT filtered on `state = 'CUSTODY'` the way /collection is. A listed card
   * whose state has moved on should still render with its real name while the UI greys it out
   * as unfillable — showing a placeholder instead would be a worse answer than showing the
   * truth. `state` is returned so the caller can make that distinction.
   *
   * Field names must match the frontend's Card type exactly. See the note in /collection:
   * sending `imageUrl` where the UI reads `imageFront` renders a placeholder for every card,
   * and the browser mock hides it because the mock supplies the right shape.
   */
  route("GET", "/cards", (_req, res, _params, url) => {
    const raw = (url.searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

    // Bounded and numeric-only: these are interpolated into an IN list, and an unbounded
    // request would let a caller ask for the whole table in one query.
    const ids = [...new Set(raw)].filter((s) => /^\d+$/.test(s)).slice(0, 100);
    if (!ids.length) return json(res, 200, { cards: [] });

    const rows = deps.db.raw
      .prepare(
        // Same reasoning as /collection: the card's current mirror, not the order's original.
        `SELECT o.id AS order_id,
                COALESCE(c.owner_mirror_token_id, o.mirror_token_id) AS mirror_token_id,
                c.solana_mint, c.name, c.grade, c.cert_number, c.image_url,
                c.image_back_url, c.tier, c.insured_value_usd, c.state
           FROM orders o JOIN cards c ON c.order_id = o.id
          WHERE COALESCE(c.owner_mirror_token_id, o.mirror_token_id) IN (${ids.map(() => "?").join(",")})
            AND o.demo = 0`,
      )
      .all(...ids) as Record<string, string | number | null>[];

    json(res, 200, {
      cards: rows.map((r) => ({
        orderId: r.order_id,
        tokenId: String(r.mirror_token_id),
        solanaMint: r.solana_mint,
        name: r.name,
        grade: r.grade,
        certNumber: r.cert_number,
        imageFront: r.image_url,
        imageBack: r.image_back_url,
        imageFrontFallback: r.image_url,
        imageBackFallback: r.image_back_url,
        tier: r.tier,
        insuredValueUsd: r.insured_value_usd,
        state: r.state,
      })),
    });
  });

  /**
   * ERC-721 metadata, the target of every tokenURI we mint.
   *
   * The URL is baked in at mint time by `worker.ts` as `<publicUrl>/metadata/:orderId/:mint`
   * and is IMMUTABLE per token. This path shape can therefore never change: a card minted
   * today must still resolve here years from now. Adding fields is safe; renaming the route
   * or its parameters orphans every card already minted.
   *
   * The mint is in the path as well as the order id so the URL is self-verifying — a token
   * whose metadata was somehow pointed at the wrong order cannot silently render another
   * card's name and image.
   */
  route("GET", "/metadata/:orderId/:mint", (_req, res, params) => {
    const row = deps.db.raw
      .prepare(
        `SELECT c.solana_mint, c.name, c.grade, c.cert_number, c.image_url,
                c.insured_value_usd, c.state, o.machine_id
           FROM cards c JOIN orders o ON o.id = c.order_id
          WHERE c.order_id = ?`,
      )
      .get(Number(params.orderId)) as Record<string, string | number | null> | undefined;

    if (!row) return json(res, 404, { error: "unknown token" });
    // Mismatch means the URL was hand-made rather than minted by us. Serve nothing.
    if (String(row.solana_mint) !== params.mint) return json(res, 404, { error: "unknown token" });

    const attributes: { trait_type: string; value: string | number }[] = [];
    if (row.grade != null) attributes.push({ trait_type: "Grade", value: String(row.grade) });
    if (row.cert_number != null) attributes.push({ trait_type: "Certificate", value: String(row.cert_number) });
    if (row.machine_id != null) attributes.push({ trait_type: "Pack", value: String(row.machine_id) });
    if (row.state != null) attributes.push({ trait_type: "Status", value: String(row.state) });

    // Short cache: the name and image never change, but Status does when a card is sold back
    // or withdrawn, and a stale marketplace tile is worse than a re-fetch.
    res.setHeader("Cache-Control", "public, max-age=300");
    json(res, 200, {
      name: row.name ? String(row.name) : `Slabs #${params.orderId}`,
      description:
        "A graded collectible held in Slabs custody, mirrored one to one from Collector Crypt. " +
        "The physical card backing this token is redeemable by its holder.",
      image: row.image_url ? String(row.image_url) : `${SITE_URL}/slab-placeholder.png`,
      external_url: `${SITE_URL}/slabs/asset/${params.orderId}`,
      attributes,
    });
  });

  /** Live sell quote. Always computed fresh from CC (doc 00 §2 — never hardcoded). */
  route("GET", "/quote/sell/:tokenId", async (_req, res, params) => {
    const card = deps.db.raw
      .prepare(
        `SELECT c.solana_mint, c.insured_value_usd, c.user_window_ends_at, c.state, c.origin
           FROM cards c WHERE c.owner_mirror_token_id = ?`,
      )
      .get(params.tokenId ?? "") as
      | { solana_mint: string; insured_value_usd: string | null; user_window_ends_at: number; state: string; origin: string }
      | undefined;

    if (!card) return json(res, 404, { error: "card not found" });
    if (card.state !== "CUSTODY") return json(res, 409, { error: `card is ${card.state}` });
    // Refused here as well as at the escrow watcher: a user should be told before they move
    // anything, not after the mirror has already been handed over and sent back.
    if (card.origin === "DEPOSIT") {
      return json(res, 409, {
        error: "Deposited cards cannot be sold back. You can withdraw the card or sell it to another collector.",
      });
    }
    if (Date.now() >= card.user_window_ends_at) {
      return json(res, 409, { error: "sell window has closed", windowEndedAt: card.user_window_ends_at });
    }
    // Checked before CC is asked anything: there is no point spending an upstream call on a
    // card we will refuse, and the user should see the real reason rather than a quote error.
    if (exceedsValueLimit(card.insured_value_usd, deps.cfg.maxSellBackValueUsd)) {
      return json(res, 403, {
        error: valueLimitMessage(deps.cfg.maxSellBackValueUsd),
        code: VALUE_LIMIT_CODE,
      });
    }
    if (!card.insured_value_usd) {
      return json(res, 503, { error: "insured value unavailable — cannot quote" });
    }

    const quote = await deps.cc.getBuybackQuote(card.solana_mint, deps.cfg.solana.operatorAddress);
    if (!quote.available) return json(res, 409, { error: "CC will not buy this card back" });

    const payout = userPayoutUsdg(quote.proceedsUsdc, card.insured_value_usd, deps.cfg.economics.spreadBps);
    const ccRateBps = Number((BigInt(quote.proceedsUsdc) * 10_000n) / BigInt(card.insured_value_usd));

    json(res, 200, {
      tokenId: params.tokenId,
      ccRateBps,
      userRateBps: ccRateBps - deps.cfg.economics.spreadBps,
      spreadBps: deps.cfg.economics.spreadBps,
      insuredValueUsd: card.insured_value_usd,
      payoutUsdg: payout,
      expiresAt: Date.now() + deps.cfg.economics.quoteTtlSec * 1000,
    });
  });

  /**
   * Accept a sell-back quote. Records the price only — it moves nothing and commits nobody.
   *
   * The sell becomes real when the mirror arrives in operator custody, and the escrow watcher
   * pays whoever the on-chain Transfer says gave it up. So this endpoint is deliberately
   * unauthenticated: the worst a forged request can do is write a price that its author
   * cannot collect on, and quoting for a token you do not own achieves nothing because you
   * cannot transfer it.
   */
  route("POST", "/sell/:tokenId", async (req, res, params) => {
    const tokenId = params.tokenId ?? "";

    // Without a custody address there is nowhere to send the mirror. Refuse rather than hand
    // back a quote the UI cannot act on, or worse, an empty destination.
    if (!deps.escrowAddress || !deps.cfg.sellBackEnabled) {
      return json(res, 503, { error: "sell-back is not available yet" });
    }

    const card = deps.db.raw
      .prepare(
        `SELECT c.solana_mint, c.insured_value_usd, c.user_window_ends_at, c.state, c.origin
           FROM cards c WHERE c.owner_mirror_token_id = ?`,
      )
      .get(tokenId) as
      | { solana_mint: string; insured_value_usd: string | null; user_window_ends_at: number; state: string; origin: string }
      | undefined;

    if (!card) return json(res, 404, { error: "card not found" });
    if (card.state !== "CUSTODY") return json(res, 409, { error: `card is ${card.state}` });
    // Refused here as well as at the escrow watcher: a user should be told before they move
    // anything, not after the mirror has already been handed over and sent back.
    if (card.origin === "DEPOSIT") {
      return json(res, 409, {
        error: "Deposited cards cannot be sold back. You can withdraw the card or sell it to another collector.",
      });
    }
    if (Date.now() >= card.user_window_ends_at) {
      return json(res, 409, { error: "sell window has closed", windowEndedAt: card.user_window_ends_at });
    }
    if (exceedsValueLimit(card.insured_value_usd, deps.cfg.maxSellBackValueUsd)) {
      return json(res, 403, {
        error: valueLimitMessage(deps.cfg.maxSellBackValueUsd),
        code: VALUE_LIMIT_CODE,
      });
    }
    if (!card.insured_value_usd) {
      return json(res, 503, { error: "insured value unavailable — cannot quote" });
    }
    if (deps.db.openBuybackFor(tokenId)) {
      return json(res, 409, { error: "a sell-back is already in progress for this card" });
    }

    const quote = await deps.cc.getBuybackQuote(card.solana_mint, deps.cfg.solana.operatorAddress);
    if (!quote.available) return json(res, 409, { error: "CC will not buy this card back" });

    const payout = userPayoutUsdg(quote.proceedsUsdc, card.insured_value_usd, deps.cfg.economics.spreadBps);
    if (payout === "0") return json(res, 409, { error: "quote is below the spread — nothing to pay" });

    const ccRateBps = Number((BigInt(quote.proceedsUsdc) * 10_000n) / BigInt(card.insured_value_usd));
    const expiresAt = Date.now() + deps.cfg.economics.quoteTtlSec * 1000;

    // Recorded for support and debugging only. Never used to decide who gets paid.
    const body = (await readBody(req)) as { requester?: string };

    const id = deps.db.insertQuote({
      mirrorTokenId: tokenId,
      solanaMint: card.solana_mint,
      requester: typeof body.requester === "string" ? body.requester : "unverified",
      ccQuoteBps: ccRateBps,
      quotedUserRateBps: ccRateBps - deps.cfg.economics.spreadBps,
      quotedUsdg: payout,
      insuredValueUsd: card.insured_value_usd,
      expiresAt,
    });

    json(res, 200, {
      quoteId: id,
      tokenId,
      payoutUsdg: payout,
      expiresAt,
      // Where to send the mirror. The transfer IS the confirmation; there is no second step.
      escrowTo: deps.escrowAddress,
    });
  });

  /**
   * Follow a sell-back. Returns the live buyback for a token, or the most recent terminal one
   * so the UI can show how it ended rather than silently forgetting it.
   *
   * The stages deliberately do not leak internal status names: a seller cares whether their
   * card is sold, whether they have been paid, and whether anything is stuck.
   */
  route("GET", "/sell/:tokenId", (_req, res, params) => {
    const tokenId = params.tokenId ?? "";
    const b =
      deps.db.openBuybackFor(tokenId) ??
      (deps.db.raw
        .prepare(
          `SELECT * FROM buybacks WHERE mirror_token_id = ? AND status IN ('PAID','FAILED')
            ORDER BY id DESC LIMIT 1`,
        )
        .get(tokenId) as { status: string; quoted_usdg: string; payout_tx: string | null; last_error: string | null; updated_at: number } | undefined);

    if (!b) return json(res, 404, { error: "no sell-back for this card" });

    const stage =
      b.status === "PAID" ? "paid"
      : b.status === "FAILED" ? "cancelled"
      : b.status === "BRIDGED" ? "paying"
      : b.status === "CC_SOLD" ? "settling"
      : "selling";

    json(res, 200, {
      tokenId,
      stage,
      payoutUsdg: b.quoted_usdg,
      payoutTx: b.payout_tx,
      // Surfaced only once it is terminal; an in-flight retry is not a user-facing error.
      error: b.status === "FAILED" ? b.last_error : null,
      updatedAt: b.updated_at,
    });
  });

  /** Order-binding proof chain (doc 04 §3), including CC's own verifier link. */
  route("GET", "/proof/:orderId", (_req, res, params) => {
    const order = deps.db.getOrder(Number(params.orderId));
    if (!order) return json(res, 404, { error: "order not found" });

    json(res, 200, {
      orderId: order.id,
      buyer: order.buyer,
      rhPaymentTx: order.rh_pay_tx,
      bridgeDepositTx: order.bridge_deposit_tx,
      // CC's memo IS the binding — it is committed before the reveal is knowable.
      ccMemo: order.cc_open_tx,
      solanaMint: order.solana_mint,
      mirrorTokenId: order.mirror_token_id,
      verifyUrl: order.cc_open_tx
        ? `https://gacha.collectorcrypt.com/verify-selection/${order.cc_open_tx}`
        : null,
      explanation:
        "Your pack was opened by Collector Crypt under the memo above, using an on-chain " +
        "VRF whose randomness comes from the signature on the purchase. Neither we nor CC " +
        "could see the result before it was committed. Verify it yourself at the link.",
    });
  });

  /** Proof of reserves (doc 05 §6). */
  route("GET", "/reserves", (_req, res) => {
    const rows = deps.db.raw
      .prepare(
        `SELECT owner_mirror_token_id, solana_mint, cert_number, state, insured_value_usd
           FROM cards WHERE state IN ('CUSTODY','SALVAGE') ORDER BY reveal_at DESC`,
      )
      .all() as Record<string, string | null>[];

    const custody = rows.filter((r) => r.state === "CUSTODY");
    const salvage = rows.filter((r) => r.state === "SALVAGE");

    json(res, 200, {
      mirrorsOutstanding: custody.length,
      // Salvage cards are ours, not backing any mirror — listed separately so the
      // reconciliation reads honestly rather than looking like a surplus.
      salvageHeld: salvage.length,
      cards: rows.map((r) => ({
        tokenId: r.owner_mirror_token_id,
        solanaMint: r.solana_mint,
        certNumber: r.cert_number,
        state: r.state,
        insuredValueUsd: r.insured_value_usd,
      })),
    });
  });

  // ------------------------------------------------------------------ demo only

  route("POST", "/demo/rip", async (req, res) => {
    if (!deps.demo) return json(res, 403, { error: "demo endpoints are disabled" });

    const body = await readBody(req);
    const buyer = String(body.buyer ?? "0xDEMO");
    const machineId = String(body.machineId ?? "pokemon_50");

    const machine = await deps.cc.machineStatus(machineId);
    const id = (deps.db.totalOrderCount() ?? 0) + 1;

    deps.db.insertOrder({
      id,
      buyer,
      machineId,
      demo: true,
      priceUsdg: machine.priceUsdc,
      rhPayTx: `0xdemo${id.toString(16).padStart(8, "0")}`,
      deadlineAt: Date.now() + deps.cfg.limits.orderTimeoutMin * 60_000,
    });

    // Run fulfilment in the background so the client can watch the stages arrive, exactly
    // as it would against a real chain.
    void (async () => {
      const pace = deps.demoStageDelayMs ?? 0;
      if (pace) await new Promise((r) => setTimeout(r, pace));
      await deps.pipeline.processOrder(id).catch(() => {});
    })();

    json(res, 202, { orderId: id });
  });

  // ------------------------------------------------------------------ server

  /**
   * Per-IP rate limit, token bucket.
   *
   * The API and the fulfilment worker share ONE process, one event loop, one SQLite handle
   * and one Collector Crypt client. So anonymous traffic here is not merely a nuisance:
   *
   *  - `/health`, `/machines` and `/quote/sell/:tokenId` each make an UNCACHED upstream call
   *    to Collector Crypt, carrying our API key and referral cookie. An attacker sets our
   *    outbound QPS to a third party we depend on completely, and CC rate-limiting or banning
   *    the account takes pack fulfilment down with it. Measured during the review: 30
   *    concurrent /machines produced 30 upstream calls in 0.65s.
   *  - SQLite is synchronous, so a flood of unbounded reads blocks the event loop and starves
   *    the worker's timers with nothing surfacing as an error.
   *
   * Deliberately simple and in-process: no dependency, no shared store, and it resets on
   * restart. That is the right trade for a single box behind Caddy. It is a blunt instrument
   * against volume, NOT a defence against a distributed attacker, and should not be mistaken
   * for one.
   */
  const RATE_WINDOW_MS = 60_000;
  /**
   * 600/min. NOT a "generous" round number — it is set against what the app actually does.
   *
   * This was 120, chosen as "generous for a browsing user" without checking. The reveal polls
   * GET /order/:id every 500ms while a pack opens, which is 120 requests a minute FROM THAT
   * ALONE. Add the feed refresh, machines and collection and a completely legitimate buyer
   * exceeded the limit mid-open. The API returned 429, `http()` threw, and the poll's
   * `catch {}` swallowed it — so the sealed pack span forever while the order completed fine
   * behind it. Observed on the very first real pack open, 20 Jul 2026.
   *
   * 600 leaves ~5x headroom over the worst legitimate case while still stopping a flood from
   * turning into unbounded upstream calls to Collector Crypt. If the poll interval or the
   * number of pollers ever changes, this number has to be re-derived, not guessed.
   */
  const RATE_MAX = 600;
  const buckets = new Map<string, { count: number; resetAt: number }>();

  const rateLimited = (req: IncomingMessage): boolean => {
    // Caddy is the only thing in front of us, so its forwarded address is trustworthy here.
    const fwd = req.headers["x-forwarded-for"];
    const ip = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim()
      || req.socket.remoteAddress
      || "unknown";

    const now = Date.now();
    const b = buckets.get(ip);
    if (!b || now > b.resetAt) {
      buckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
      // Opportunistic sweep so the map cannot grow without bound under churn.
      if (buckets.size > 5_000) {
        for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
      }
      return false;
    }
    b.count += 1;
    return b.count > RATE_MAX;
  };

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    if (rateLimited(req)) {
      res.setHeader("Retry-After", "60");
      return json(res, 429, { error: "too many requests" });
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = r.pattern.exec(url.pathname);
      if (!match) continue;

      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(match[i + 1] ?? "")));

      try {
        await r.handler(req, res, params, url);
      } catch (err) {
        if (err instanceof BodyTooLarge) return json(res, 413, { error: "request body too large" });
    json(res, 500, { error: err instanceof Error ? err.message : "internal error" });
      }
      return;
    }

    json(res, 404, { error: "not found" });
  });

  return server;
}

function serializeOrder(db: Db, order: OrderRow) {
  const card = order.solana_mint
    ? (db.raw.prepare(`SELECT * FROM cards WHERE solana_mint = ?`).get(order.solana_mint) as
        | Record<string, string | number | null>
        | undefined)
    : undefined;

  // Stage names the UI shows while polling. Deliberately honest about what is happening.
  const stage =
    order.status === "CREATED"
      ? "queued"
      : order.status === "BRIDGING"
        ? "bridging"
        : order.status === "OPENING"
          ? "opening"
          : order.status === "REVEALED"
            ? "revealing"
            : order.status === "MINTED"
              ? "done"
              : order.status === "FAILED"
                ? "retrying"
                : "refunded";

  return {
    orderId: order.id,
    /**
     * Who this order actually belongs to.
     *
     * Published so the client can refuse to present somebody else's pull as the user's own.
     * On 20 Jul an order-id collision meant a buyer's browser polled /order/1, received a
     * PREVIOUS deployment's order — already MINTED, with a card attached — and revealed that
     * stranger's Common card to them, while their own collection stayed empty. Order ids are
     * public on chain so this is not secret; what was missing was any way for the UI to tell
     * that the order it was handed was not the one it asked for.
     */
    buyer: order.buyer,
    status: order.status,
    stage,
    machineId: order.machine_id,
    priceUsdg: order.price_usdg,
    ccMemo: order.cc_open_tx,
    mirrorTokenId: order.mirror_token_id,
    card: card
      ? {
          solanaMint: card.solana_mint,
          name: card.name,
          grade: card.grade,
          certNumber: card.cert_number,
          imageFront: card.image_url,
          imageBack: card.image_back_url,
          imageFrontFallback: card.image_url,
          imageBackFallback: card.image_back_url,
          tier: card.tier,
          insuredValueUsd: card.insured_value_usd,
          revealAt: card.reveal_at,
          sellWindowEndsAt: card.user_window_ends_at,
        }
      : null,
  };
}
