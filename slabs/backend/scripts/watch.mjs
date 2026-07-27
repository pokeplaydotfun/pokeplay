#!/usr/bin/env node
/**
 * One live view of everything that moves during a pack open or a sell-back.
 *
 * Run this on the server while a pack is opened. It combines three signals that otherwise
 * live in three places, so a stall shows up here instead of being reconstructed afterwards:
 *
 *   [LOG]    meaningful worker log lines, as they happen (journalctl -f, filtered)
 *   [STATE]  order / card / buyback / withdrawal counts by status, printed when they CHANGE
 *   [MONEY]  worker ETH + USDG, operator SOL + USDC, on a slow heartbeat
 *
 * The pipeline it is watching, so you know what "good" looks like:
 *   OPEN:      order seen -> draw payment -> bridge USDG->USDC -> CC open -> mint mirror -> MINTED
 *   SELL-BACK: mirror arrives in escrow -> sell to CC -> bridge USDC->USDG -> pay user -> PAID
 *
 *   node scripts/watch.mjs            follow until Ctrl-C
 *   node scripts/watch.mjs --once     one snapshot of STATE + MONEY, then exit
 *
 * Read-only: opens the DB read-only, only reads chain and logs. Changes nothing.
 */

import { DatabaseSync } from "node:sqlite";
import { spawn, execFile } from "node:child_process";
import { createPublicClient, http, defineChain, getAddress } from "viem";

const DB_PATH = process.env.DB_PATH ?? "/root/pwa-data/pwa.sqlite";
const HEALTH_URL = "http://127.0.0.1:8789/health";
const RH_RPC = process.env.RH_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const SOLANA_RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

const WORKER = "0x71a540E18651EC271B52Bd53d27f3b7EfA860EE4";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const OPERATOR_SOL = "PWAu9rkHHhKEnHZ4AjohV8q4PEbGqRJyGcWwfP5kxCv";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const once = process.argv.includes("--once");

// Log lines worth surfacing. Everything the worker prints for the two flows, plus anything
// that smells like a failure. Kept broad on purpose — a missed line during the first open is
// worse than a little noise.
const KEEP = /order|draw|bridge|cc[ _]|open|mint|mirror|escrow|buyback|sell|withdraw|unwrap|refund|fail|error|revert|too many|tick/i;

const t = () => new Date().toISOString().slice(11, 19);

/* ---------------------------------------------------------------- DB state */

const db = new DatabaseSync(DB_PATH, { readOnly: true });

function counts(table, col) {
  try {
    const rows = db.prepare(`SELECT ${col} AS k, COUNT(*) AS n FROM ${table} GROUP BY ${col}`).all();
    if (rows.length === 0) return null;
    return rows.map((r) => `${r.k}:${r.n}`).join(" ");
  } catch {
    return null; // table absent in this build — skip quietly
  }
}

function stateLine() {
  const parts = [];
  const o = counts("orders", "status");
  const c = counts("cards", "state");
  const b = counts("buybacks", "status");
  const w = counts("withdrawals", "status");
  if (o) parts.push(`orders[${o}]`);
  if (c) parts.push(`cards[${c}]`);
  if (b) parts.push(`buybacks[${b}]`);
  if (w) parts.push(`withdrawals[${w}]`);
  return parts.join("  ") || "(all tables empty)";
}

/* ---------------------------------------------------------------- money */

const rhChain = defineChain({
  id: 4663,
  name: "RH",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RH_RPC] } },
});
const pub = createPublicClient({ chain: rhChain, transport: http(RH_RPC) });

const ERC20_BAL = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];

async function rpc(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

async function moneyLine() {
  const out = [];
  try {
    const eth = await pub.getBalance({ address: getAddress(WORKER) });
    out.push(`worker ETH ${(Number(eth) / 1e18).toFixed(4)}`);
  } catch { out.push("worker ETH ?"); }
  try {
    const usdg = await pub.readContract({ address: getAddress(USDG), abi: ERC20_BAL, functionName: "balanceOf", args: [getAddress(WORKER)] });
    out.push(`worker USDG ${(Number(usdg) / 1e6).toFixed(2)}`);
  } catch { out.push("worker USDG ?"); }
  try {
    const sol = await rpc(SOLANA_RPC, { jsonrpc: "2.0", id: 1, method: "getBalance", params: [OPERATOR_SOL] });
    out.push(`op SOL ${(Number(sol.result?.value ?? 0) / 1e9).toFixed(4)}`);
  } catch { out.push("op SOL ?"); }
  try {
    const usdc = await rpc(SOLANA_RPC, {
      jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner",
      params: [OPERATOR_SOL, { mint: USDC_MINT }, { encoding: "jsonParsed" }],
    });
    const amt = usdc.result?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
    out.push(`op USDC ${Number(amt).toFixed(2)}`);
  } catch { out.push("op USDC ?"); }
  return out.join("  ");
}

/* ---------------------------------------------------------------- run */

if (once) {
  console.log(`[STATE ${t()}] ${stateLine()}`);
  console.log(`[MONEY ${t()}] ${await moneyLine()}`);
  db.close();
  process.exit(0);
}

console.log(`watching ${DB_PATH}\npipeline: order->draw->bridge->CC open->mint->MINTED   |   sellback: escrow->CC sell->bridge->pay->PAID\n`);
console.log(`[STATE ${t()}] ${stateLine()}`);
console.log(`[MONEY ${t()}] ${await moneyLine()}`);

// Print STATE only when it changes, so the stream stays readable and every [STATE] line is a
// real transition worth noticing.
let lastState = stateLine();
setInterval(() => {
  const s = stateLine();
  if (s !== lastState) {
    lastState = s;
    console.log(`[STATE ${t()}] ${s}`);
  }
}, 3000);

// Money on a slow heartbeat — balances move once per bridge leg, not per second.
setInterval(async () => {
  console.log(`[MONEY ${t()}] ${await moneyLine()}`);
}, 30000);

// Live worker log, filtered. -n 0 so we start from now, not history.
const jc = spawn("journalctl", ["-u", "pwa-api", "-f", "-n", "0", "-o", "cat"], { stdio: ["ignore", "pipe", "ignore"] });
let buf = "";
jc.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() && KEEP.test(line)) console.log(`[LOG   ${t()}] ${line.trim()}`);
  }
});

process.on("SIGINT", () => { jc.kill(); db.close(); process.exit(0); });
