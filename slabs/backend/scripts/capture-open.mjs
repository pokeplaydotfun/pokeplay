/**
 * ONE-SHOT PACK OPEN CAPTURE
 *
 * The operator can afford exactly one real pack open. Everything this system has never done
 * happens in that single minute, and most of it is unrepeatable: the reveal payload, the state
 * transitions, the timings, and the CardMeta written IMMUTABLY on chain. This script exists so
 * none of it is lost.
 *
 *   node --experimental-strip-types scripts/capture-open.mjs snapshot
 *       Record the before-state. Run this BEFORE the buy.
 *
 *   node --experimental-strip-types scripts/capture-open.mjs watch
 *       Poll continuously and record EVERY order state transition with timestamps, from
 *       OrderCreated to MINTED. Run this before the buy and leave it running. Ctrl-C when done.
 *
 *   node --experimental-strip-types scripts/capture-open.mjs verify <orderId>
 *       The full post-open checklist. Safe to re-run; spends nothing.
 *
 * Everything is written to captures/<timestamp>-<mode>.json as well as the console, because a
 * scrollback buffer is not a record.
 *
 * WHAT THIS CHECKS THAT NOBODY ASKED FOR, AND WHY
 *
 *  - CardMeta units on chain. `revealAt` and both windows are IMMUTABLE per token. A bug here
 *    was found and fixed on 19 Jul (ms written into a seconds field, which would have applied
 *    the 5% unwrap fee forever). This is the only chance to confirm the fix on a real token.
 *  - tokenURI. Also immutable, and its path shape is frozen once a card exists.
 *  - MPL Core frozen state. CC's cards are Metaplex Core assets and 8 of 12 sampled pool cards
 *    were FROZEN. If ours is frozen in custody, the mirror is a claim we cannot honour, and
 *    that is a design problem to discover now rather than on a customer's withdraw.
 *  - buildBuyback WITHOUT submitting. Proves the sell-back build path on a real owned card
 *    while risking nothing, the same trick dryrun uses for generatePack.
 */
import { loadConfig } from "../src/config.ts";
import { Db } from "../src/db/index.ts";
import { RhChain, MIRROR_ABI, PACK_SALE_ABI } from "../src/chains/rh.ts";
import { SolanaChain } from "../src/chains/solana.ts";
import { CollectorCryptApi, userPayoutUsdg } from "../src/cc/client.ts";
import { checkDestinationFormat } from "../src/chains/solana-destination.ts";
import { createPublicClient, http, parseAbi, parseAbiItem } from "viem";
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const MODE = process.argv[2] ?? "snapshot";
const ARG = process.argv[3];
const cfg = loadConfig();
const rh = new RhChain(cfg);
const solana = new SolanaChain(cfg);
const cc = new CollectorCryptApi({ apiUrl: cfg.cc.apiUrl, apiKey: cfg.cc.apiKey, referralCode: cfg.cc.referralCode });
const pub = createPublicClient({ transport: http(cfg.rh.rpcUrl) });
const API = cfg.api.publicUrl;

const record = { mode: MODE, startedAt: new Date().toISOString(), entries: [] };
let failures = 0;
let warnings = 0;

const log = (line) => console.log(line);
const ok = (m, d = "") => { log(`  ok      ${m}${d ? "  " + d : ""}`); record.entries.push({ level: "ok", m, d }); };
const bad = (m, d = "") => { failures++; log(`  FAIL    ${m}${d ? "  " + d : ""}`); record.entries.push({ level: "fail", m, d }); };
const warn = (m, d = "") => { warnings++; log(`  WARN    ${m}${d ? "  " + d : ""}`); record.entries.push({ level: "warn", m, d }); };
const info = (m, d = "") => { log(`          ${m}${d ? "  " + d : ""}`); record.entries.push({ level: "info", m, d }); };
const head = (t) => { log(`\n${t}`); record.entries.push({ level: "head", m: t }); };
const usd = (v) => `$${(Number(v) / 1e6).toFixed(2)}`;

/**
 * Query the PRODUCTION database, over ssh.
 *
 * Every mode here used to open `cfg.db.path` — the local database — while the worker that
 * actually fulfils orders runs on the VPS against its own. So `verify` reported "order not
 * found" for a perfectly good order, and `watch` sat silent through a real failure. A capture
 * tool that reads the wrong machine is worse than no capture tool: it produces confident,
 * wrong evidence.
 *
 * Read-only by construction — the query is passed to a readOnly handle.
 */
function prodQuery(sql) {
  const script =
    `const {DatabaseSync}=require('node:sqlite');` +
    `const db=new DatabaseSync('${PROD_DB}',{readOnly:true});` +
    `console.log(JSON.stringify(db.prepare(${JSON.stringify(sql)}).all()));`;
  try {
    const out = execFileSync(
      "ssh",
      [PROD_HOST, `cd ${PROD_APP} && node -e ${JSON.stringify(script)} 2>/dev/null`],
      { encoding: "utf8", timeout: 30_000 },
    );
    return JSON.parse(out.trim() || "[]");
  } catch (e) {
    warn("could not read the production database", String(e.message).slice(0, 90));
    return null;
  }
}

// No default host. This repo is public; the production box is named only in your env.
const PROD_HOST = process.env.VPS ?? (() => {
  throw new Error("Set VPS, e.g. export VPS=$VPS");
})();
const PROD_APP = "/root/pwa-api";
const PROD_DB = "/root/pwa-data/gacha.sqlite";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function save() {
  try {
    mkdirSync(new URL("../captures/", import.meta.url), { recursive: true });
  } catch {}
  const stamp = record.startedAt.replace(/[:.]/g, "-");
  const path = new URL(`../captures/${stamp}-${MODE}.json`, import.meta.url);
  record.finishedAt = new Date().toISOString();
  record.failures = failures;
  record.warnings = warnings;
  writeFileSync(path, JSON.stringify(record, null, 2));
  log(`\nSaved: ${path.pathname}`);
}

async function api(path) {
  try {
    const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(20_000) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (e) {
    return { status: 0, body: null, error: String(e.message) };
  }
}

/* ================================================================= SNAPSHOT */

async function snapshot() {
  head("BEFORE STATE — capture this before the buy");
  const [usdc, sol, usdg, eth, block] = await Promise.all([
    solana.usdcBalance(), solana.solBalance(), rh.usdgBalance(),
    rh.workerGasBalance(), pub.getBlockNumber(),
  ]);
  const nextTokenId = await pub.readContract({
    address: cfg.rh.mirrorAddress,
    abi: parseAbi(["function nextTokenId() view returns (uint256)"]),
    functionName: "nextTokenId",
  });

  record.before = {
    solanaUsdc: usdc.toString(), solanaSol: sol, rhUsdg: usdg.toString(),
    workerEthWei: eth.toString(), rhBlock: block.toString(), nextTokenId: nextTokenId.toString(),
  };
  info("Solana USDC", usd(usdc));
  info("Solana SOL", (sol / 1e9).toFixed(6));
  info("RH USDG", usd(usdg));
  info("worker ETH", (Number(eth) / 1e18).toFixed(6));
  info("RH block", block.toString());
  info("nextTokenId", `${nextTokenId}  ${nextTokenId === 1n ? "(nothing minted yet)" : ""}`);

  const db = new Db(cfg.db.path);
  const orders = db.raw.prepare("SELECT COUNT(*) c FROM orders").get();
  const cards = db.raw.prepare("SELECT COUNT(*) c FROM cards").get();
  info("orders in DB", String(orders.c));
  info("cards in DB", String(cards.c));
  record.before.orderCount = orders.c;
  record.before.cardCount = cards.c;

  head("Machine and price, as the buyer will see them");
  const m = await rh.machineIsLive("pokemon_50");
  info("on-chain price", usd(m.priceUsdg));
  const ccm = await cc.machineStatus("pokemon_50");
  info("CC price", usd(ccm.priceUsdc));
  info("CC stock", String(ccm.packsRemaining));
  record.before.onChainPrice = m.priceUsdg.toString();
  record.before.ccPrice = ccm.priceUsdc;
}

/* ==================================================================== WATCH */

/**
 * Watch the LIVE order, from production.
 *
 * The previous version read `cfg.db.path` — the LOCAL database — while the worker that
 * actually fulfils orders runs on the VPS against its own. So on 20 Jul it sat printing
 * nothing through a real buy that was failing on the server, and the blindness is why the
 * failure went unnoticed for ten minutes. Polling the public API means we watch the same
 * state the buyer's browser does, from the machine that owns it.
 *
 * Everything observed is written to the capture file, including the raw payloads, because the
 * turbo work will need to know exactly what a Common pull looks like end to end.
 */
async function watch() {
  head("WATCHING PRODUCTION — leave this running through the open. Ctrl-C when MINTED.");
  info("source", `${API} (the live worker, not a local database)`);
  info("polling", "every 1s; every state change is timestamped and saved");

  const seen = new Map();
  record.transitions = [];
  record.rawOrders = [];
  const t0 = Date.now();
  let lastKnownId = 0;

  for (;;) {
    // Probe forward: we do not know the order id until the buy lands, and after a clean
    // database the next one is 1. Checking a small window catches it without guessing.
    for (let id = Math.max(1, lastKnownId); id <= lastKnownId + 3; id++) {
      const res = await api(`/order/${id}`);
      if (res.status !== 200 || !res.body || res.body.error) continue;
      const o = res.body;
      lastKnownId = Math.max(lastKnownId, id);

      const sig = JSON.stringify({
        status: o.status, stage: o.stage, memo: o.ccMemo,
        token: o.mirrorTokenId, card: o.card ? o.card.name : null,
      });
      if (seen.get(String(id)) === sig) continue;
      seen.set(String(id), sig);

      const at = ((Date.now() - t0) / 1000).toFixed(1);
      record.transitions.push({ atSeconds: Number(at), orderId: id, ...JSON.parse(sig) });
      // The whole payload, not just the fields printed — turbo will need the shape of a
      // Common pull, and this run is the only place it will exist.
      record.rawOrders.push({ atSeconds: Number(at), order: o });

      log(`  +${at.padStart(6)}s  order ${id}  ${String(o.status).padEnd(10)} stage=${o.stage}`);
      if (o.ccMemo) log(`             cc memo ${o.ccMemo}`);
      if (o.mirrorTokenId) log(`             token  #${o.mirrorTokenId}`);
      if (o.card) {
        log(`             card   ${o.card.name ?? "(no name)"}  ${o.card.grade ?? ""}  ${o.card.tier ?? ""}`);
        log(`             value  ${o.card.insuredValueUsd ? usd(o.card.insuredValueUsd) : "(none)"}`);
      }
      save();
    }
    await sleep(1000);
  }
}

/* =================================================================== VERIFY */

async function verify(orderId) {
  if (!orderId) { bad("usage", "capture-open.mjs verify <orderId>"); return; }
  const rows = prodQuery(`SELECT * FROM orders WHERE id = ${Number(orderId)}`);
  const order = rows?.[0];
  if (!order) { bad("order not found in the PRODUCTION database", orderId); return; }
  record.order = order;

  head(`ORDER ${orderId} — database`);
  info("status", order.status);
  info("buyer", order.buyer);
  info("machine", order.machine_id);
  info("price", usd(order.price_usdg));
  order.status === "MINTED" ? ok("reached MINTED") : bad("not MINTED", order.status);
  order.cc_open_tx ? ok("CC memo recorded", order.cc_open_tx) : bad("no CC memo");
  order.solana_mint ? ok("Solana mint recorded", order.solana_mint) : bad("no Solana mint");
  order.mirror_token_id ? ok("mirror token", `#${order.mirror_token_id}`) : bad("no mirror token id");

  const card = order.solana_mint
    ? prodQuery(`SELECT * FROM cards WHERE solana_mint = '${order.solana_mint}'`)?.[0] ?? null
    : null;
  record.card = card;

  head("CARD — what we stored");
  if (!card) bad("no card row"); else {
    info("name", String(card.name));
    info("grade", String(card.grade));
    info("cert", String(card.cert_number));
    info("tier", String(card.tier));
    info("insured", card.insured_value_usd ? usd(card.insured_value_usd) : "(null)");
    card.name ? ok("name present") : bad("name missing — the UI shows a blank card");
    card.image_url ? ok("front image", String(card.image_url).slice(0, 60)) : bad("no front image");
    card.image_back_url ? ok("back image") : warn("no back image", "reveal back beat renders bare");
    card.tier ? ok("tier stored (not re-derived)") : bad("no tier");
    card.insured_value_usd ? ok("insured value") : warn("no insured value", "sell-back cannot quote");
  }

  /* ---------------------------------------------------------- ON CHAIN, IMMUTABLE */
  head("ON-CHAIN CARD META — IMMUTABLE, this is the only chance to check it");
  if (order.mirror_token_id) {
    const tokenId = BigInt(order.mirror_token_id);
    const META = parseAbi([
      "function cardMeta(uint256) view returns ((bytes32 solanaMintHash, bytes32 ccOpenTxHash, uint64 revealAt, uint64 userWindowEndsAt, uint64 ccWindowEndsAt))",
      "function tokenURI(uint256) view returns (string)",
      "function ownerOf(uint256) view returns (address)",
    ]);
    try {
      const owner = await pub.readContract({ address: cfg.rh.mirrorAddress, abi: META, functionName: "ownerOf", args: [tokenId] });
      owner.toLowerCase() === order.buyer.toLowerCase()
        ? ok("mirror owned by the buyer", owner)
        : bad("mirror owner is NOT the buyer", `${owner} vs ${order.buyer}`);

      const uri = await pub.readContract({ address: cfg.rh.mirrorAddress, abi: META, functionName: "tokenURI", args: [tokenId] });
      record.tokenURI = uri;
      info("tokenURI", uri);
      uri.startsWith("https://huntgrails.xyz/api/metadata/")
        ? ok("tokenURI host and path shape correct", "FROZEN from now on")
        : bad("tokenURI unexpected", "this is immutable and now permanent");

      const meta = await pub.readContract({ address: cfg.rh.mirrorAddress, abi: META, functionName: "cardMeta", args: [tokenId] });
      record.cardMetaOnChain = {
        revealAt: meta.revealAt.toString(),
        userWindowEndsAt: meta.userWindowEndsAt.toString(),
        ccWindowEndsAt: meta.ccWindowEndsAt.toString(),
      };
      const revealAt = Number(meta.revealAt);
      const userW = Number(meta.userWindowEndsAt);
      const ccW = Number(meta.ccWindowEndsAt);
      info("revealAt (chain)", `${revealAt}  ->  ${new Date(revealAt * 1000).toISOString()}`);

      // THE units bug. A ms epoch here reads as ~55,000 years in the future and would make
      // the 5% unwrap fee apply forever, immutably.
      const YEAR_2100 = 4_102_444_800;
      revealAt > 1_600_000_000 && revealAt < YEAR_2100
        ? ok("revealAt is a SECONDS epoch", "the units fix held on a real token")
        : bad("revealAt is NOT plausible seconds", `${revealAt} — ms leaked into a uint64 read as seconds`);

      const userHours = (userW - revealAt) / 3600;
      const ccHours = (ccW - revealAt) / 3600;
      Math.abs(userHours - cfg.economics.userWindowHours) < 0.1
        ? ok("user window", `${userHours.toFixed(1)}h`)
        : bad("user window wrong", `${userHours.toFixed(2)}h, expected ${cfg.economics.userWindowHours}`);
      Math.abs(ccHours - cfg.economics.ccWindowHours) < 0.1
        ? ok("CC window", `${ccHours.toFixed(1)}h`)
        : bad("CC window wrong", `${ccHours.toFixed(2)}h, expected ${cfg.economics.ccWindowHours}`);

      const nowSec = Math.floor(Date.now() / 1000);
      ccW > nowSec
        ? info("CC window still open", `${((ccW - nowSec) / 3600).toFixed(1)}h left`)
        : info("CC window closed", "unwrap fee would now be 0");
    } catch (e) {
      bad("could not read CardMeta", String(e.message).slice(0, 120));
    }

    // Escrow released?
    try {
      /**
       * The ORDER id, not the token id.
       *
       * This passed `tokenId`, so for order 2 / token 1 it read order 1 — which happened to be
       * the refunded first attempt — and reported REFUNDED for an order that was FULFILLED.
       * The two ids are equal often enough (first order, first token) that the mistake hides,
       * and a capture tool producing confident wrong evidence is worse than none.
       */
      const o = await pub.readContract({
        address: cfg.rh.packSaleAddress, abi: PACK_SALE_ABI,
        functionName: "getOrder", args: [BigInt(orderId)],
      });
      const ORDER_STATES = ["NONE", "PENDING", "FULFILLED", "REFUNDED"];
      const label = ORDER_STATES[Number(o.status)] ?? String(o.status);
      Number(o.status) === 2
        ? ok("PackSale order FULFILLED", "escrow released to the treasury")
        : bad("PackSale order is not FULFILLED", `${o.status} = ${label}`);
      info("drawn", String(o.drawn));
    } catch {}
  }

  /* ---------------------------------------------------------- THE SOLANA CARD */
  head("THE REAL CARD ON SOLANA — custody, and whether it can ever move");
  if (order.solana_mint) {
    const frozen = await solana.assetFrozen(order.solana_mint);
    record.frozen = frozen;
    if (frozen === true) {
      bad("THE CARD IS FROZEN", "it cannot be transferred by anyone. Withdraw and sell-back CANNOT be honoured for it");
    } else if (frozen === false) {
      ok("card is NOT frozen", "custody is real; it can be moved");
    } else {
      warn("frozen state unreadable", "re-check before enabling withdraw or sell-back");
    }

    // Ownership and standard, read straight from the DAS response.
    try {
      const res = await fetch(cfg.solana.rpcUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAsset", params: { id: order.solana_mint } }),
      });
      const r = (await res.json()).result ?? {};
      record.solanaAsset = { interface: r.interface, owner: r.ownership?.owner, plugins: Object.keys(r.plugins ?? {}) };
      info("asset standard", String(r.interface));
      info("owner", String(r.ownership?.owner));
      info("plugins", Object.keys(r.plugins ?? {}).join(", ") || "none");
      r.ownership?.owner === cfg.solana.operatorAddress
        ? ok("card is in OUR custody", "1:1 with the mirror, as promised")
        : bad("card is NOT in our custody", `owner ${r.ownership?.owner}`);
      if (r.interface === "MplCoreAsset") {
        info("note", "MPL Core, so Flow C needs @metaplex-foundation/mpl-core, not spl-token");
      }
    } catch (e) {
      warn("DAS read failed", String(e.message).slice(0, 90));
    }
  }

  /* ---------------------------------------------------------- CC SELL-BACK PATH */
  head("SELL-BACK PATH on the real card — builds only, sells NOTHING");
  if (order.solana_mint && card) {
    try {
      const q = await cc.getBuybackQuote(order.solana_mint, cfg.solana.operatorAddress);
      record.buybackQuote = q;
      if (q.available) {
        ok("CC WILL buy this card back", usd(q.proceedsUsdc));
        if (card.insured_value_usd) {
          const payout = userPayoutUsdg(q.proceedsUsdc, card.insured_value_usd, cfg.economics.spreadBps);
          info("seller would receive", usd(payout));
          info("our spread", usd(BigInt(q.proceedsUsdc) - BigInt(payout)));
        }
      } else {
        warn("CC will NOT buy it back right now", "expected if the window closed or it is frozen");
      }
    } catch (e) {
      bad("getBuybackQuote threw", String(e.message).slice(0, 120));
    }

    // Build the sell transaction WITHOUT submitting. Proves the path, risks nothing.
    try {
      const built = await cc.buildBuyback(order.solana_mint, cfg.solana.operatorAddress);
      ok("buildBuyback returns a signable transaction", `${built.transactionBase64.length} chars, memo ${built.memo}`);
      info("refundAmount", usd(built.refundAmountUsdc));
      info("NOT SUBMITTED", "the card is untouched");
    } catch (e) {
      warn("buildBuyback failed", String(e.message).slice(0, 120));
    }
  }

  /* ---------------------------------------------------------- THE API */
  head("API — every route the site depends on, against the REAL card");
  const CARD_FIELDS = ["solanaMint", "name", "grade", "certNumber", "imageFront", "imageBack", "imageFrontFallback", "imageBackFallback", "tier", "insuredValueUsd"];

  const o = await api(`/order/${orderId}`);
  o.status === 200 ? ok("GET /order/:id", "200") : bad("GET /order/:id", String(o.status));
  if (o.body?.card) {
    const missing = CARD_FIELDS.filter((f) => o.body.card[f] === undefined || o.body.card[f] === null);
    missing.length === 0 ? ok("order card has every field the UI reads") : bad("order card missing fields", missing.join(", "));
  } else if (o.status === 200) bad("order has no card object");

  const col = await api(`/collection/${order.buyer}`);
  col.status === 200 ? ok("GET /collection/:address", "200") : bad("GET /collection", String(col.status));
  const mine = col.body?.cards?.[0];
  if (mine) {
    ok("card appears in the buyer's collection");
    const missing = CARD_FIELDS.filter((f) => mine[f] === undefined || mine[f] === null);
    missing.length === 0 ? ok("collection card has every field") : bad("collection card missing", missing.join(", "));
    info("sellable", String(mine.sellable));
    info("sellWindowEndsAt", new Date(Number(mine.sellWindowEndsAt)).toISOString());
    Number(mine.sellWindowEndsAt) > Date.now()
      ? ok("sell window is in the FUTURE (milliseconds, as the UI expects)")
      : warn("sell window already past", "check units: the API uses ms, the chain uses seconds");
  } else if (col.status === 200) bad("card NOT in the collection", "the buyer would see nothing");

  if (order.solana_mint) {
    const md = await api(`/metadata/${orderId}/${order.solana_mint}`);
    md.status === 200 ? ok("GET /metadata/:orderId/:mint", "200 — tokenURI resolves") : bad("metadata route", String(md.status));
    if (md.body) {
      md.body.name ? ok("metadata name", String(md.body.name).slice(0, 40)) : bad("metadata has no name");
      md.body.image ? ok("metadata image") : bad("metadata has no image");
    }
  }

  const lb = await api("/leaderboard?sort=value&limit=10");
  lb.status === 200 ? ok("GET /leaderboard", "200") : bad("leaderboard", String(lb.status));
  const row = lb.body?.rows?.find((r) => String(r.address).toLowerCase() === order.buyer.toLowerCase());
  row ? ok("buyer appears on the leaderboard", `${row.packsOpened} pack(s), $${row.totalValueUsd}`)
      : warn("buyer not on the leaderboard", "check the demo filter and the value join");

  const pr = await api(`/proof/${orderId}`);
  pr.status === 200 ? ok("GET /proof/:orderId", "200") : warn("proof route", String(pr.status));

  const rv = await api("/reserves");
  if (rv.status === 200) {
    ok("GET /reserves", `${rv.body?.mirrorsOutstanding} outstanding, ${rv.body?.cards?.length ?? 0} card(s)`);
    Number(rv.body?.mirrorsOutstanding) >= 1 ? ok("reserves reflect the mint") : warn("reserves show no mirrors");
  } else bad("reserves", String(rv.status));

  const sq = await api(`/quote/sell/${order.mirror_token_id}`);
  info("GET /quote/sell/:tokenId", `HTTP ${sq.status} ${sq.body?.code ?? ""}`);
  // 404 means the API does not know this token at all, which is a different problem from the
  // ceiling failing to fire. Conflating them would report a false failure on the one run that
  // matters.
  if (sq.status === 404) {
    bad("GET /quote/sell/:tokenId 404", "the API does not know this mirror — check the card row");
  } else if (card && Number(card.insured_value_usd) > cfg.maxSellBackValueUsd * 1e6) {
    sq.status === 403
      ? ok("value ceiling blocks this card", `insured ${usd(card.insured_value_usd)} > $${cfg.maxSellBackValueUsd}`)
      : bad("value ceiling did NOT block a card over the limit", `HTTP ${sq.status}`);
  } else if (sq.status === 503) {
    ok("sell-back correctly refuses while disabled");
  } else {
    info("sell quote status", String(sq.status));
  }

  /* ---------------------------------------------------------- ECONOMICS */
  head("ECONOMICS — what it actually cost");
  const [usdcNow, usdgNow, ethNow] = await Promise.all([solana.usdcBalance(), rh.usdgBalance(), rh.workerGasBalance()]);
  info("Solana USDC now", usd(usdcNow));
  info("RH USDG now", usd(usdgNow));
  info("worker ETH now", (Number(ethNow) / 1e18).toFixed(6));
  info("compare against", "the snapshot capture taken before the buy");

  head("MARKETPLACE readiness");
  const CAN = parseAbi(["function isApprovedForAll(address,address) view returns (bool)"]);
  if (!cfg.rh.marketplaceAddress) { warn("MARKETPLACE_ADDRESS not set", "skipping marketplace checks"); return; }
  try {
    const approved = await pub.readContract({
      address: cfg.rh.mirrorAddress, abi: CAN, functionName: "isApprovedForAll",
      args: [order.buyer, cfg.rh.marketplaceAddress],
    });
    info("buyer approved marketplace", String(approved), approved ? "" : "(expected false until they list)");
    ok("marketplace approval readable", "listing flow can proceed from the UI");
  } catch (e) {
    warn("marketplace check failed", String(e.message).slice(0, 90));
  }
}


/* ===================================================================== SELL-BACK
 *
 * Flow B has never executed end to end. This watches one through its states and checks the
 * things that can only be checked WHILE it happens — the payout the seller actually receives,
 * and whether the reprice fired.
 */
async function sellback(tokenId) {
  if (!tokenId) { bad("usage", "capture-open.mjs sellback <mirrorTokenId>"); return; }
  head(`SELL-BACK — watching mirror #${tokenId}. Ctrl-C when PAID.`);
  info("polling", "every 2s; every state change is timestamped and saved");

  let last = null;
  let quotedAtStart = null;
  /**
   * Ignore a run that was already finished before we started watching.
   *
   * The watcher follows the newest buybacks row for the card, and a retry leaves the PREVIOUS
   * attempt sitting there as the newest row until the new one is written. Started after a
   * failed attempt, it therefore latched onto that FAILED row, printed the old result and
   * exited immediately — useless for exactly the case you run it for, watching a retry.
   *
   * So: if the newest row is already terminal at boot, remember its id and refuse to report on
   * it. Anything strictly newer is the run we were started for. A row still in flight is
   * tracked as before, because rejoining a run already under way is legitimate.
   */
  let ignoreUpToId = null;
  let firstPoll = true;
  /**
   * WHICH buyback quotedAtStart belongs to.
   *
   * A card can accumulate several rows — every quote request writes one, and abandoned
   * quotes stay QUOTED forever. Token #1 already carries two before this run starts. The
   * baseline used to be captured from whatever row was newest at boot, so a confirm that
   * created a NEW row would have its payout compared against a DIFFERENT buyback's quote,
   * and the reprice check would report a phantom "paid LESS than quoted" — or hide a real
   * one. Same cross-row confusion that produced the order-id collision.
   *
   * The baseline is therefore pinned to a row id and re-taken when the watcher moves on.
   */
  let quotedForId = null;
  for (;;) {
    const b = prodQuery(
      `SELECT * FROM buybacks WHERE mirror_token_id = '${String(tokenId)}' ORDER BY id DESC LIMIT 1`,
    )?.[0];

    if (!b) { firstPoll = false; await sleep(2000); continue; }

    if (firstPoll) {
      firstPoll = false;
      if (b.status === "PAID" || b.status === "FAILED") {
        ignoreUpToId = b.id;
        info("ignoring", `buyback #${b.id} is already ${b.status} — waiting for a NEW sell-back`);
      }
    }
    if (ignoreUpToId !== null && b.id <= ignoreUpToId) { await sleep(2000); continue; }

    if (quotedForId !== b.id) {
      quotedForId = b.id;
      quotedAtStart = b.quoted_usdg;
      info("tracking buyback", `#${b.id} (${b.status}), quote baseline ${usd(b.quoted_usdg)}`);
    }

    const key = `${b.status}:${b.quoted_usdg}:${b.payout_tx ?? ""}`;
    if (key !== last) {
      last = key;
      info(new Date().toISOString(), `${b.status}  quoted=${usd(b.quoted_usdg)}`);
      record.entries.push({ level: "state", at: Date.now(), buyback: { ...b } });
    }

    if (b.status === "PAID" || b.status === "FAILED") {
      record.buyback = b;
      head("SELL-BACK RESULT");
      info("buyback id", String(b.id));
      info("status", b.status);
      info("seller", b.seller);
      info("quoted at request", usd(quotedAtStart));
      info("paid", usd(b.quoted_usdg));

      // The reprice. A stranger can bind a seller's deposit to a stale quote, so the fill
      // prices upward — if CC moved in the seller's favour, the seller must have received it.
      if (BigInt(b.quoted_usdg) > BigInt(quotedAtStart)) {
        ok("repriced UP before selling", `${usd(quotedAtStart)} -> ${usd(b.quoted_usdg)} went to the seller`);
      } else if (BigInt(b.quoted_usdg) === BigInt(quotedAtStart)) {
        info("no reprice", "CC did not move between quote and fill");
      } else {
        bad("paid LESS than quoted", `${usd(quotedAtStart)} -> ${usd(b.quoted_usdg)}`);
      }

      b.status === "PAID" ? ok("seller was paid", b.payout_tx ?? "") : bad("did not complete", b.last_error ?? "");
      b.cc_sell_tx ? ok("card sold to CC", b.cc_sell_tx) : warn("no CC sale recorded");
      b.bridge_order_id ? ok("proceeds bridged", b.bridge_order_id) : warn("no bridge order");

      // The card must stop counting as ours, or /reserves overstates what backs the mirrors.
      const card = prodQuery(`SELECT state FROM cards WHERE solana_mint = '${b.solana_mint}'`)?.[0];
      card?.state === "SOLD_TO_CC"
        ? ok("card state SOLD_TO_CC", "no longer counted in reserves")
        : bad("card state is " + (card?.state ?? "missing"), "reserves would overstate holdings");

      // And the mirror must be gone, or the same card backs a token that still exists.
      try {
        const ERC = parseAbi(["function ownerOf(uint256) view returns (address)"]);
        await pub.readContract({ address: cfg.rh.mirrorAddress, abi: ERC, functionName: "ownerOf", args: [BigInt(tokenId)] });
        bad("mirror still exists", "burnAfterSell did not run");
      } catch {
        ok("mirror burned", "the token backed by this card is gone");
      }
      return;
    }
    await sleep(2000);
  }
}

/* ===================================================================== MARKETPLACE
 *
 * The book has never rendered a real listing. Reads it the way the UI does — from chain logs —
 * and checks the fields that used to be placeholders.
 */
async function market(tokenId) {
  head("MARKETPLACE — the book, read the way the UI reads it");
  if (!cfg.rh.marketplaceAddress) { bad("MARKETPLACE_ADDRESS not set"); return; }

  const EVENTS = [
    parseAbiItem("event Listed(uint256 indexed tokenId, address indexed seller, uint256 priceUsdg)"),
    parseAbiItem("event Cancelled(uint256 indexed tokenId, address indexed seller)"),
    parseAbiItem("event Sold(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 priceUsdg, uint256 feeUsdg)"),
  ];
  const DEPLOY_BLOCK = 14_562_378n; // must match frontend/src/client.ts

  const [listed, cancelled, sold] = await Promise.all(
    EVENTS.map((event) =>
      pub.getLogs({ address: cfg.rh.marketplaceAddress, event, fromBlock: DEPLOY_BLOCK, toBlock: "latest" }),
    ),
  );
  info("Listed events", String(listed.length));
  info("Cancelled events", String(cancelled.length));
  info("Sold events", String(sold.length));

  const removed = new Map();
  for (const l of [...cancelled, ...sold]) {
    const id = String(l.args.tokenId);
    const bn = l.blockNumber ?? 0n;
    if (!removed.has(id) || removed.get(id) < bn) removed.set(id, bn);
  }
  const live = listed.filter((l) => (removed.get(String(l.args.tokenId)) ?? -1n) <= (l.blockNumber ?? 0n));
  info("live listings", String(live.length));

  if (!live.length) {
    warn("nothing listed", "list a card from the UI, then re-run this");
    return;
  }

  const target = tokenId ? live.find((l) => String(l.args.tokenId) === String(tokenId)) : live[0];
  if (!target) { bad("token not listed", String(tokenId)); return; }
  const id = String(target.args.tokenId);

  head(`LISTING #${id} — is the data REAL, or the old placeholders?`);
  info("seller", target.args.seller);
  info("price", usd(target.args.priceUsdg));

  // The listedAt the UI shows comes from the block, not from Date.now(). That was a bug.
  const block = await pub.getBlock({ blockNumber: target.blockNumber });
  const listedAt = Number(block.timestamp) * 1000;
  info("listedAt", new Date(listedAt).toISOString());
  Math.abs(Date.now() - listedAt) > 60_000
    ? ok("listedAt is the block time", "not Date.now() — sorting by newest actually works")
    : info("listedAt is recent", "listed just now, so this cannot distinguish the bug");

  // The card metadata the tile renders, from the endpoint the UI calls.
  const cards = await api(`/cards?ids=${id}`);
  const card = cards.body?.cards?.[0];
  record.listing = { tokenId: id, seller: target.args.seller, priceUsdg: String(target.args.priceUsdg), card };
  if (!card) { bad("GET /cards returned nothing", "the tile would fall back to placeholders"); return; }

  info("name", String(card.name));
  info("tier", String(card.tier));
  info("insured", card.insuredValueUsd ? usd(card.insuredValueUsd) : "(null)");

  card.name && !/^Card #/.test(card.name) ? ok("real card name") : bad("placeholder name", String(card.name));
  card.tier ? ok("real tier") : bad("no tier — every tile renders grey");
  // The tile divides the ask by this for its "% of insured" badge.
  card.insuredValueUsd && card.insuredValueUsd !== "0"
    ? ok("real insured value", "the % of insured badge divides by this")
    : bad("insured value is 0", "the badge would be a division by zero");
  card.imageFront ? ok("artwork") : warn("no artwork", "the tile renders bare");

  // Fillability, read per listing rather than assumed true.
  const FILL = parseAbi(["function isFillable(uint256) view returns (bool)"]);
  const fillable = await pub.readContract({ address: cfg.rh.marketplaceAddress, abi: FILL, functionName: "isFillable", args: [BigInt(id)] });
  info("isFillable", String(fillable));
  ok("fillability read from chain", "not hardcoded true");
}

/* ===================================================================== WITHDRAW
 *
 * The relayer has never seen a live UnwrapRequested. The decode FAILS OPEN — corrupted bytes
 * are still a valid address about half the time — so the destination is the thing to eyeball.
 */
async function withdraw(tokenId) {
  if (!tokenId) { bad("usage", "capture-open.mjs withdraw <mirrorTokenId>"); return; }
  const w = prodQuery(`SELECT * FROM withdrawals WHERE token_id = '${String(tokenId)}'`)?.[0];
  if (!w) {
    bad("no withdrawal row", "the relayer never saw UnwrapRequested — check the worker log and the cursor");
    return;
  }
  record.withdrawal = w;

  head(`WITHDRAW — mirror #${tokenId}`);
  info("status", w.status);
  info("requester", w.requester);
  info("destination", w.solana_dest);
  info("mint", String(w.solana_mint));
  info("recorded at", new Date(w.seen_at).toISOString());

  head("THE DECODE — check this by eye, it is the step that fails open");
  info("decoded destination", w.solana_dest);
  info("compare against", "the address the user actually entered in the UI");
  const fmt = checkDestinationFormat(w.solana_dest);
  fmt.ok ? ok("destination is structurally valid") : bad("destination REJECTED", fmt.reason);
  warn("a valid address is NOT proof the decode is right", "a corrupted decode is valid ~half the time");

  if (w.status === "SENT") {
    ok("relayed", String(w.transfer_sig));
    const owner = await solana.assetOwner(w.solana_mint);
    info("asset owner now", String(owner));
    owner === w.solana_dest
      ? ok("the card ARRIVED at the destination", "withdraw proven end to end")
      : bad("card is NOT at the destination", `owner=${owner}`);

    const card = prodQuery(`SELECT state FROM cards WHERE solana_mint = '${w.solana_mint}'`)?.[0];
    card?.state === "UNWRAPPED"
      ? ok("card state UNWRAPPED", "no longer counted in reserves")
      : bad("card state is " + (card?.state ?? "missing"), "reserves would overstate holdings");
  } else if (w.status === "HELD") {
    warn("HELD, not sent", String(w.last_error));
  } else if (w.status === "FAILED") {
    bad("FAILED", String(w.last_error));
  } else {
    info("still pending", "re-run once the relayer has ticked");
  }

  // The mirror must be gone either way — burnForUnwrap burns before it emits.
  try {
    const ERC = parseAbi(["function ownerOf(uint256) view returns (address)"]);
    await pub.readContract({ address: cfg.rh.mirrorAddress, abi: ERC, functionName: "ownerOf", args: [BigInt(tokenId)] });
    bad("mirror still exists", "it should have been burned before the event fired");
  } catch {
    ok("mirror burned", "as burnForUnwrap does before emitting");
  }
}


/* ================================================================== HARVEST
 *
 * Everything about a completed open that is worth keeping, in one file.
 *
 * Written for the turbo work specifically: turbo auto-sells a Common back instead of
 * delivering a card, so building it needs to know exactly what a Common pull looks like —
 * CC's own rarity string, the insured value, the buyback quote, and the machine's commons
 * inventory at the time. Most of that is only observable while the card is still in custody.
 */
async function harvest(orderId) {
  if (!orderId) { bad("usage", "capture-open.mjs harvest <orderId>"); return; }

  head(`HARVEST — everything about order ${orderId}`);
  const res = await api(`/order/${orderId}`);
  if (res.status !== 200 || !res.body || res.body.error) {
    bad("order not found on the live API", `HTTP ${res.status}`);
    return;
  }
  const order = res.body;
  record.order = order;

  info("status", `${order.status}  stage=${order.stage}`);
  info("buyer", String(order.buyer));
  info("cc memo", String(order.ccMemo));
  info("mirror token", String(order.mirrorTokenId));

  /* ---------------------------------------------------------------- the card */
  head("THE CARD — as stored, and as Collector Crypt reports it");
  const card = order.card;
  record.card = card;
  if (!card) { bad("no card on the order"); return; }

  info("name", String(card.name));
  info("grade", String(card.grade));
  info("tier", String(card.tier));
  info("insured", card.insuredValueUsd ? usd(card.insuredValueUsd) : "(none)");
  card.name && !/^Card #/.test(card.name) ? ok("real card name") : bad("placeholder name");
  card.grade ? ok("grade parsed") : bad("grade is null — the structured-attribute fix regressed");

  // CC's own view, memo-keyed. This is the authoritative record and the one turbo will read.
  if (order.ccMemo) {
    try {
      const meta = await cc.fetchCardMetaByMemo(order.ccMemo);
      record.ccMetadata = meta;
      info("CC name", String(meta.name));
      info("CC grade", String(meta.grade));
      info("CC insured", meta.insuredValueUsd ? usd(meta.insuredValueUsd) : "(none)");
      ok("CC metadata captured", "stored raw in the capture file");
    } catch (e) {
      warn("could not fetch CC metadata", String(e.message).slice(0, 90));
    }
  }

  /* ------------------------------------------------- what turbo would have done */
  head("TURBO REFERENCE — what this pull would mean for turbo");
  const isCommon = String(card.tier).toLowerCase() === "common";
  info("tier", `${card.tier}  ->  ${isCommon ? "turbo WOULD have auto-sold this" : "turbo would have kept it"}`);

  if (order.solanaMint ?? card.solanaMint) {
    const mint = order.solanaMint ?? card.solanaMint;
    try {
      const quote = await cc.getBuybackQuote(mint, "custody");
      record.buybackQuote = quote;
      quote.available
        ? ok("buyback quote", `CC would pay ${usd(quote.proceedsUsdc)} for this card`)
        : warn("CC will not buy this back right now");
      if (quote.available && card.insuredValueUsd) {
        const payout = userPayoutUsdg(quote.proceedsUsdc, card.insuredValueUsd, cfg.economics.spreadBps);
        info("seller would receive", usd(payout));
        info("our spread", usd(BigInt(quote.proceedsUsdc) - BigInt(payout)));
        // Exactly what a turbo Common would owe the buyer, in USDC on Solana, with no NFT.
        if (isCommon) info("TURBO would owe the buyer", `${usd(payout)} in USDC on Solana, and mint nothing`);
      }
    } catch (e) {
      warn("buyback quote failed", String(e.message).slice(0, 90));
    }
  }

  /* ---------------------------------------------------------- machine inventory */
  try {
    const m = await cc.machineStatus(order.machineId ?? "pokemon_50");
    record.machineAtHarvest = m;
    info("machine stock", `${m.packsRemaining} packs`);
    // commonsLeft is what makes CC refuse a normal open and suggest turbo, so it is the
    // trigger condition turbo has to react to.
    if (m.commonsLeft != null) info("commons left", `${m.commonsLeft}  (low-inventory drives turbo)`);
    ok("machine status captured");
  } catch (e) {
    warn("machine status failed", String(e.message).slice(0, 90));
  }

  head("SAVED");
  info("everything above", "is in the capture file, including raw CC payloads");
}

/* ===================================================================== MAIN */

try {
  if (MODE === "snapshot") await snapshot();
  else if (MODE === "watch") await watch();
  else if (MODE === "verify") await verify(ARG);
  else if (MODE === "sellback") await sellback(ARG);
  else if (MODE === "market") await market(ARG);
  else if (MODE === "withdraw") await withdraw(ARG);
  else if (MODE === "harvest") await harvest(ARG);
  else bad("unknown mode", "use: snapshot | watch | verify <orderId> | harvest <orderId> | sellback <tokenId> | market [tokenId] | withdraw <tokenId>");
} catch (e) {
  bad("capture threw", String(e.stack ?? e.message).slice(0, 400));
}

log(`\n${failures ? `${failures} FAILURE(S)` : "no failures"}${warnings ? `, ${warnings} warning(s)` : ""}`);
save();
process.exit(failures ? 1 : 0);
