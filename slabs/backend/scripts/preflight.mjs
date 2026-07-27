/**
 * Preflight: prove the environment is real before anything touches money.
 *
 * Checks live values, never assumptions: keys are derived and compared against the
 * addresses they are supposed to control, RPCs are actually called, balances actually read.
 * Secrets are read but never printed, logged or written.
 *
 *   node scripts/preflight.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { privateKeyToAccount } from "viem/accounts";

const EXPECTED_SOL = "CARD7cmGjygGCSkrbXdxBN8Zr9Zd1fN1mjZdvSLqHuaN";
const EXPECTED_CHAIN = 4663n;

const load = (p) =>
  existsSync(p)
    ? Object.fromEntries(
        readFileSync(p, "utf8").split("\n")
          .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
          .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
      )
    : {};

const env = load(".env");
const contractsEnv = load("../contracts/.env");

const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (s) => {
  let n = 0n;
  for (const c of s) { const i = A.indexOf(c); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  let h = n.toString(16); if (h.length % 2) h = "0" + h;
  const b = Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
  return Uint8Array.from([...new Uint8Array(s.length - s.replace(/^1+/, "").length), ...b]);
};

let failed = 0, warned = 0;
const ok = (m, d = "") => console.log(`  ok    ${m}${d ? "  " + d : ""}`);
const bad = (m, d = "") => { failed++; console.log(`  FAIL  ${m}${d ? "  " + d : ""}`); };
const warn = (m, d = "") => { warned++; console.log(`  warn  ${m}${d ? "  " + d : ""}`); };

const rpc = async (url, method, params = []) => {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};

console.log("\nRobinhood Chain");
try {
  const id = BigInt(await rpc(env.RH_RPC_URL, "eth_chainId"));
  id === EXPECTED_CHAIN ? ok("chain id", String(id)) : bad("chain id", `${id}, expected ${EXPECTED_CHAIN}`);
} catch (e) { bad("RH_RPC_URL unreachable", e.message); }

let workerAddr = null;
try {
  const raw = env.WORKER_PRIVATE_KEY;
  if (!raw) throw new Error("empty");
  workerAddr = privateKeyToAccount(raw.startsWith("0x") ? raw : `0x${raw}`).address;
  ok("worker key parses", workerAddr);
  const owner = contractsEnv.OWNER_ADDRESS;
  if (owner) {
    owner.toLowerCase() === workerAddr.toLowerCase()
      ? ok("matches OWNER_ADDRESS in contracts/.env")
      : bad("does NOT match OWNER_ADDRESS", `contracts/.env has ${owner}`);
  }
} catch (e) { bad("WORKER_PRIVATE_KEY", e.message); }

if (workerAddr) {
  try {
    const wei = BigInt(await rpc(env.RH_RPC_URL, "eth_getBalance", [workerAddr, "latest"]));
    const eth = Number(wei) / 1e18;
    eth > 0.001 ? ok("worker ETH balance", `${eth.toFixed(6)} ETH`) : bad("worker ETH too low", `${eth} ETH`);
  } catch (e) { bad("balance read", e.message); }
}

try {
  const call = (data) => rpc(env.RH_RPC_URL, "eth_call", [{ to: env.USDG_ADDRESS, data }, "latest"]);
  const dec = parseInt(await call("0x313ce567"), 16);
  dec === 6 ? ok("USDG decimals", "6") : bad("USDG decimals", String(dec));
} catch (e) { bad("USDG contract read", e.message); }

console.log("\nSolana");
let solPub = null;
try {
  const raw = env.SOLANA_OPERATOR_SECRET_KEY;
  if (!raw) throw new Error("empty");
  const kp = Keypair.fromSecretKey(raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : b58(raw));
  solPub = kp.publicKey.toBase58();
  solPub === EXPECTED_SOL ? ok("operator key controls", solPub) : bad("WRONG WALLET", solPub);
} catch (e) { bad("SOLANA_OPERATOR_SECRET_KEY", e.message); }

if (solPub && env.SOLANA_RPC_URL) {
  try {
    const conn = new Connection(env.SOLANA_RPC_URL, "confirmed");
    const lamports = await conn.getBalance(new PublicKey(solPub));
    const sol = lamports / LAMPORTS_PER_SOL;
    // A pack purchase is a couple of signatures plus possible ATA creation (~0.002 SOL).
    if (sol >= 0.01) ok("SOL balance", `${sol} SOL`);
    else if (sol > 0) warn("SOL balance low", `${sol} SOL, want >= 0.01 for ATA rent + fees`);
    else bad("SOL balance", "0");
    const slot = await conn.getSlot();
    ok("Solana RPC responding", `slot ${slot}`);
  } catch (e) { bad("SOLANA_RPC_URL", e.message); }
} else if (!env.SOLANA_RPC_URL) bad("SOLANA_RPC_URL", "empty");

console.log("\nCollector Crypt");
try {
  const r = await fetch("https://gacha.collectorcrypt.com/api/machines", { signal: AbortSignal.timeout(20_000) });
  const j = await r.json();
  const list = Array.isArray(j) ? j : j.machines ?? [];
  ok("machines endpoint", `${list.length} machines`);
} catch (e) { bad("CC API unreachable", e.message); }
env.CC_REFERRAL_CODE ? ok("referral code set", env.CC_REFERRAL_CODE) : warn("CC_REFERRAL_CODE empty", "no attribution");

console.log("\nContracts");
const addrs = ["PACK_SALE_ADDRESS", "MIRROR_NFT_ADDRESS", "FULFILLER_ADDRESS", "MARKETPLACE_ADDRESS"];
const set = addrs.filter((k) => env[k]);
if (set.length === 0) warn("not deployed yet", "expected before ./deploy.sh --live");
else if (set.length === addrs.length) {
  for (const k of addrs) {
    try {
      const code = await rpc(env.RH_RPC_URL, "eth_getCode", [env[k], "latest"]);
      code && code !== "0x" ? ok(k, env[k]) : bad(k, "no contract at that address");
    } catch (e) { bad(k, e.message); }
  }
} else bad("partially filled", `${set.length}/4 set`);

console.log("\nSafety");
env.USE_MOCKS === "true"
  ? ok("USE_MOCKS=true", "cannot spend real money yet")
  : warn("USE_MOCKS=false", "LIVE - real funds can move");

console.log(`\n${failed ? `${failed} FAILED` : "all checks passed"}${warned ? `, ${warned} warning(s)` : ""}\n`);
process.exit(failed ? 1 : 0);
